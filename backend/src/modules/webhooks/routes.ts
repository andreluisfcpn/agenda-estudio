// ─── Webhook Routes ─────────────────────────────────────
// Receives payment confirmation callbacks from Cora and Stripe
// These endpoints are PUBLIC (no auth) but verify signatures

import { Router, Request, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { stripeVerifyWebhook } from '../../lib/stripeService.js';
import { decryptConfigSafe } from '../../utils/crypto.js';
import crypto from 'node:crypto';
import { createNotification } from '../notifications/notificationService.js';
import { onPaymentConfirmed } from '../../lib/paymentEffects.js';

const router = Router();

// ─── Cora Webhook Signature Verification ────────────────
// Cora sends these headers:
//   user-agent: Cora-Webhook
//   webhook-event-id: evt_xxx
//   webhook-event-type: invoice.paid
//   webhook-resource-id: inv_xxx

// Tri-state HMAC check. Cora's Direct Integration secures webhooks via
// mTLS/allowlist (not an HMAC header the app can configure), so we treat the
// signature as an *optional* fast path:
//   'valid'   → signature present, secret configured and matches (trust event)
//   'invalid' → signature present but does NOT match (tampering → reject)
//   'absent'  → no signature, or no secret configured to verify it. We then fall
//               back to verifying the real invoice state via the Cora API (mTLS).
type CoraSigState = 'valid' | 'invalid' | 'absent';

async function verifyCoraSignature(req: Request): Promise<CoraSigState> {
    const signature = (req.headers['x-cora-signature'] as string) || (req.headers['x-webhook-signature'] as string);
    if (!signature) return 'absent';

    try {
        const integration = await prisma.integrationConfig.findUnique({ where: { provider: 'CORA' } });
        if (!integration) return 'absent';

        const decrypted = decryptConfigSafe(integration.config);
        const parsed = JSON.parse(decrypted);

        // Resolve dual-config: pick webhookSecret from active environment
        const environment = integration.environment === 'production' ? 'production' : 'sandbox';
        let webhookSecret: string | undefined;
        if (parsed.sandbox || parsed.production) {
            webhookSecret = parsed[environment]?.webhookSecret;
        } else {
            webhookSecret = parsed.webhookSecret; // legacy flat format
        }
        if (!webhookSecret) return 'absent'; // can't verify HMAC → rely on Cora-API check

        // VULN-H3 FIX: rawBody MUST be available for correct signature verification
        const rawBody = (req as any).rawBody;
        if (!rawBody) return 'absent';

        const expectedSignature = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
        const sigBuf = Buffer.from(signature);
        const expectedBuf = Buffer.from(expectedSignature);
        if (sigBuf.length !== expectedBuf.length) return 'invalid';
        return crypto.timingSafeEqual(sigBuf, expectedBuf) ? 'valid' : 'invalid';
    } catch (err) {
        console.error('[Webhook:Cora] Signature verification error:', err);
        return 'invalid';
    }
}

// ─── POST /api/webhooks/cora ────────────────────────────
// Cora sends notifications when boleto/PIX payments are confirmed

router.post('/cora', async (req: Request, res: Response) => {
    try {
        // Optional HMAC fast-path. If a signature is present but INVALID, it's
        // tampering → reject. Otherwise (valid or absent) we proceed and re-verify
        // the real invoice state against the Cora API (mTLS) before changing
        // anything — so confirmation never depends on a header Cora may not send.
        const sigState = await verifyCoraSignature(req);
        if (sigState === 'invalid') {
            console.error('[Webhook:Cora] Signature present but invalid — rejecting (tampering)');
            res.status(401).json({ error: 'Invalid webhook signature' });
            return;
        }

        const event = req.body;
        // Cora sends event metadata in HEADERS (primary) and sometimes in body (fallback)
        const eventType = ((req.headers['webhook-event-type'] as string) || event?.event_type || event?.type || event?.event || '').toLowerCase();
        const invoiceId = (req.headers['webhook-resource-id'] as string) || event?.data?.id || event?.invoice_id || event?.id;

        console.log(`[Webhook:Cora] Event: ${eventType || '(none)'}, Invoice: ${invoiceId || '(none)'} (sig: ${sigState})`);

        if (!invoiceId) {
            res.status(200).json({ received: true });
            return;
        }

        // Match by providerRef (Cora invoice ID)
        const payment = await prisma.payment.findFirst({ where: { providerRef: invoiceId } });
        if (!payment) {
            console.log(`[Webhook:Cora] No payment found for providerRef: ${invoiceId}`);
            res.status(200).json({ received: true });
            return;
        }

        const { reconcileCoraPayment, reconcileCoraCancellation } = await import('../../lib/coraReconciliation.js');
        const cancellationEvents = ['invoice.cancelled', 'invoice.canceled', 'invoice.expired'];

        if (cancellationEvents.includes(eventType)) {
            // Verify the invoice is genuinely cancelled/expired via Cora before failing it.
            await reconcileCoraCancellation(payment.id);
        } else {
            // Any other event (incl. invoice.paid or a missing/unknown type) triggers a
            // Cora-API-verified confirmation. reconcileCoraPayment only marks PAID +
            // runs all effects if Cora actually reports the invoice as paid.
            await reconcileCoraPayment(payment.id);
        }

        res.status(200).json({ received: true });
    } catch (err) {
        console.error('[Webhook:Cora] Error processing webhook:', err);
        // Always return 200 to prevent retries
        res.status(200).json({ received: true, error: 'processing_error' });
    }
});

// ─── POST /api/webhooks/stripe ──────────────────────────
// Stripe sends notifications when checkout sessions complete

router.post('/stripe', async (req: Request, res: Response) => {
    try {
        const sig = req.headers['stripe-signature'] as string;

        let event;

        if (sig) {
            // Verify signature — req.body is a Buffer from express.raw()
            try {
                const rawBody = Buffer.isBuffer(req.body) ? req.body : (req as any).rawBody || JSON.stringify(req.body);
                event = await stripeVerifyWebhook(rawBody, sig);
            } catch (err) {
                console.error('[Webhook:Stripe] Signature verification failed:', err);
                res.status(400).json({ error: 'Invalid signature' });
                return;
            }
        } else if (process.env.NODE_ENV === 'production') {
            // In production, NEVER accept unsigned webhooks
            res.status(400).json({ error: 'Missing stripe-signature header' });
            return;
        } else if (process.env.ALLOW_UNVERIFIED_WEBHOOKS === 'true') {
            // Dev-only: accept unsigned webhooks with explicit opt-in (VULN-08 fix)
            const body = Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString()) : req.body;
            event = body;
            console.warn('[Webhook:Stripe] Accepting unverified webhook (dev + ALLOW_UNVERIFIED_WEBHOOKS)');
        } else {
            res.status(400).json({ error: 'Missing stripe-signature header. Set ALLOW_UNVERIFIED_WEBHOOKS=true for dev.' });
            return;
        }

        console.log('[Webhook:Stripe] Received event:', event.type);

        // Handle checkout.session.completed
        if (event.type === 'checkout.session.completed') {
            const session = event.data.object;
            const paymentId = session.metadata?.paymentId;

            if (paymentId) {
                const payment = await prisma.payment.findUnique({ where: { id: paymentId } });

                if (payment && payment.status !== 'PAID') {
                    // Verify the charged amount matches before marking PAID (parity with
                    // payment_intent.succeeded). Guards against tampered/mismatched sessions.
                    if (session.amount_total != null && session.amount_total !== payment.amount) {
                        console.error(`[Webhook:Stripe] checkout.session amount mismatch: session=${session.amount_total}, DB=${payment.amount} — skipping ${paymentId}`);
                    } else {
                        // Atomic update to prevent race conditions with verifyPayment
                        const updated = await prisma.payment.updateMany({
                            where: { id: paymentId, status: 'PENDING' },
                            data: {
                                status: 'PAID',
                                paidAt: new Date(),
                                // session.payment_intent is a string id OR an expanded object (or null) —
                                // normalize to the id string so providerRef never becomes "[object Object]".
                                providerRef: (typeof session.payment_intent === 'string'
                                    ? session.payment_intent
                                    : session.payment_intent?.id) || session.id,
                            },
                        });

                        if (updated.count > 0) {
                            console.log(`[Webhook:Stripe] Payment ${paymentId} marked as PAID`);
                            await onPaymentConfirmed(paymentId);
                        }
                    }
                }
            }
        }

        // Handle payment_intent.payment_failed
        if (event.type === 'payment_intent.payment_failed') {
            const paymentIntent = event.data.object;
            const paymentId = paymentIntent.metadata?.paymentId;

            if (paymentId) {
                const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
                if (payment) {
                    // PAY-05 FIX: Atomic update — only mark as FAILED if still PENDING
                    // Prevents overwriting PAID status if a retry succeeded before this webhook
                    await prisma.payment.updateMany({
                        where: { id: paymentId, status: 'PENDING' },
                        data: { status: 'FAILED' },
                    });
                    console.log(`[Webhook:Stripe] Payment ${paymentId} marked as FAILED`);

                    // Instant push: payment failed
                    createNotification({
                        userId: payment.userId,
                        type: 'PAYMENT_FAILED',
                        severity: 'critical',
                        title: '❌ Pagamento Recusado',
                        message: 'Seu pagamento foi recusado. Tente novamente em Meus Pagamentos.',
                        entityType: 'PAYMENT',
                        entityId: payment.id,
                        actionUrl: '/meus-pagamentos',
                    }).catch(() => {});
                }
            }
        }

        // Handle charge.refunded
        if (event.type === 'charge.refunded') {
            const charge = event.data.object;
            const paymentIntentId = charge.payment_intent;

            if (paymentIntentId) {
                // VULN-C1 FIX: Atomic guard — only refund payments that are currently PAID
                // Prevents marking PENDING/FAILED payments as REFUNDED via forged webhooks
                const updated = await prisma.payment.updateMany({
                    where: { providerRef: String(paymentIntentId), status: 'PAID' },
                    data: { status: 'REFUNDED' },
                });

                if (updated.count > 0) {
                    console.log(`[Webhook:Stripe] ${updated.count} payment(s) marked as REFUNDED for PI ${paymentIntentId}`);
                } else {
                    console.warn(`[Webhook:Stripe] charge.refunded received for PI ${paymentIntentId} but no PAID payment found — skipping`);
                }
            }
        }

        // Handle payment_intent.succeeded (inline card payments via Elements)
        if (event.type === 'payment_intent.succeeded') {
            const pi = event.data.object;
            const paymentId = pi.metadata?.paymentId;

            if (paymentId) {
                const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
                if (payment && payment.status !== 'PAID') {
                    // VULN-H2 FIX: Verify amount matches before marking as PAID
                    if (pi.amount !== payment.amount) {
                        console.error(`[Webhook:Stripe] Amount mismatch on PI succeeded: PI=${pi.amount}, DB=${payment.amount} — skipping payment ${paymentId}`);
                    } else {
                        // Atomic update to prevent race conditions
                        const updated = await prisma.payment.updateMany({
                            where: { id: paymentId, status: 'PENDING' },
                            data: {
                                status: 'PAID',
                                paidAt: new Date(),
                                providerRef: pi.id,
                                paymentType: pi.payment_method_types?.includes('card') ? 'CREDIT' : null,
                            },
                        });

                        if (updated.count > 0) {
                            console.log(`[Webhook:Stripe] Payment ${paymentId} marked as PAID (PaymentIntent)`);
                            await onPaymentConfirmed(paymentId);
                        }
                    }
                }
            }

            // Auto-save card when setup_future_usage was set (user opted to save)
            const pmId = pi.payment_method;
            const custId = pi.customer;
            if (pi.setup_future_usage && pmId && custId) {
                try {
                    const user = await prisma.user.findFirst({
                        where: { stripeCustomerId: String(custId) },
                    });
                    if (user && typeof pmId === 'string') {
                        const existing = await prisma.savedPaymentMethod.findUnique({
                            where: { stripePaymentMethodId: pmId },
                        });
                        if (!existing) {
                            const { stripeListPaymentMethods } = await import('../../lib/stripeService.js');
                            const cards = await stripeListPaymentMethods(String(custId));
                            const card = cards.find(c => c.paymentMethodId === pmId);
                            if (card) {
                                const count = await prisma.savedPaymentMethod.count({ where: { userId: user.id } });
                                await prisma.savedPaymentMethod.create({
                                    data: {
                                        userId: user.id,
                                        stripePaymentMethodId: pmId,
                                        brand: card.brand,
                                        last4: card.last4,
                                        expMonth: card.expMonth,
                                        expYear: card.expYear,
                                        isDefault: count === 0,
                                    },
                                });
                                console.log(`[Webhook:Stripe] Auto-saved card ${card.brand} ****${card.last4} for user ${user.id}`);
                            }
                        }
                    }
                } catch (saveErr) {
                    console.error('[Webhook:Stripe] Error auto-saving card:', saveErr);
                }
            }
        }

        // Handle setup_intent.succeeded (card saved to vault)
        if (event.type === 'setup_intent.succeeded') {
            const si = event.data.object;
            const customerId = si.customer;
            const paymentMethodId = si.payment_method;

            if (customerId && paymentMethodId) {
                // Find user by Stripe Customer ID
                const user = await prisma.user.findFirst({
                    where: { stripeCustomerId: String(customerId) },
                });

                if (user && typeof paymentMethodId === 'string') {
                    // Get card details from Stripe
                    try {
                        const { stripeListPaymentMethods } = await import('../../lib/stripeService.js');
                        const cards = await stripeListPaymentMethods(String(customerId));
                        const card = cards.find(c => c.paymentMethodId === paymentMethodId);

                        if (card) {
                            // Check if already saved
                            const existing = await prisma.savedPaymentMethod.findUnique({
                                where: { stripePaymentMethodId: paymentMethodId },
                            });

                            if (!existing) {
                                // Count existing methods to determine default
                                const count = await prisma.savedPaymentMethod.count({ where: { userId: user.id } });

                                await prisma.savedPaymentMethod.create({
                                    data: {
                                        userId: user.id,
                                        stripePaymentMethodId: paymentMethodId,
                                        brand: card.brand,
                                        last4: card.last4,
                                        expMonth: card.expMonth,
                                        expYear: card.expYear,
                                        isDefault: count === 0, // first card is default
                                    },
                                });
                                console.log(`[Webhook:Stripe] Saved card ${card.brand} ****${card.last4} for user ${user.id}`);
                            }
                        }
                    } catch (cardErr) {
                        console.error('[Webhook:Stripe] Error saving card details:', cardErr);
                    }
                }
            }
        }

        // Handle invoice.payment_succeeded (subscription recurring payment)
        if (event.type === 'invoice.payment_succeeded') {
            const invoice = event.data.object;
            const subscriptionId = invoice.subscription;

            if (subscriptionId) {
                // Find pending payments linked to this subscription
                const payment = await prisma.payment.findFirst({
                    where: {
                        stripeSubscriptionId: String(subscriptionId),
                        status: 'PENDING',
                    },
                    orderBy: { dueDate: 'asc' },
                });

                if (payment) {
                    // VULN-M5 FIX: Verify invoice amount matches expected payment amount
                    const invoiceAmount = invoice.amount_paid || invoice.total;
                    if (invoiceAmount != null && invoiceAmount !== payment.amount) {
                        console.error(`[Webhook:Stripe] Subscription amount mismatch: Invoice=${invoiceAmount}, DB=${payment.amount} — skipping payment ${payment.id}`);
                    } else {
                        const updated = await prisma.payment.updateMany({
                            where: { id: payment.id, status: 'PENDING' },
                            data: {
                                status: 'PAID',
                                paidAt: new Date(),
                                providerRef: invoice.payment_intent ? String(invoice.payment_intent) : invoice.id,
                            },
                        });

                        if (updated.count > 0) {
                            console.log(`[Webhook:Stripe] Subscription payment ${payment.id} marked as PAID`);
                            // Run the full confirmation pipeline (notify client, unlock next cycle, …)
                            // like every other payment path. For an in-cycle subscription invoice the
                            // add-on/booking/fulfillment/renewal steps are all guarded no-ops; the real
                            // gain is the PAYMENT_CONFIRMED notification this branch used to skip.
                            await onPaymentConfirmed(payment.id);
                        }
                    }
                }
            }
        }

        // Handle invoice.payment_failed (subscription payment failed)
        if (event.type === 'invoice.payment_failed') {
            const invoice = event.data.object;
            const subscriptionId = invoice.subscription;

            if (subscriptionId) {
                const payment = await prisma.payment.findFirst({
                    where: {
                        stripeSubscriptionId: String(subscriptionId),
                        status: 'PENDING',
                    },
                    orderBy: { dueDate: 'asc' },
                });

                if (payment) {
                    // PAY-06 FIX: Atomic update — only mark FAILED if still PENDING
                    // Prevents overwriting PAID if a retry succeeded before this webhook
                    await prisma.payment.updateMany({
                        where: { id: payment.id, status: 'PENDING' },
                        data: { status: 'FAILED' },
                    });
                    console.log(`[Webhook:Stripe] Subscription payment ${payment.id} marked as FAILED`);
                }
            }
        }

        // Handle customer.subscription.deleted (subscription cancelled)
        if (event.type === 'customer.subscription.deleted') {
            const subscription = event.data.object;
            console.log(`[Webhook:Stripe] Subscription ${subscription.id} cancelled`);

            // Mark remaining pending payments as FAILED
            await prisma.payment.updateMany({
                where: {
                    stripeSubscriptionId: subscription.id,
                    status: 'PENDING',
                },
                data: { status: 'FAILED' },
            });
        }

        res.status(200).json({ received: true });
    } catch (err) {
        console.error('[Webhook:Stripe] Error processing webhook:', err);
        res.status(200).json({ received: true, error: 'processing_error' });
    }
});

export default router;

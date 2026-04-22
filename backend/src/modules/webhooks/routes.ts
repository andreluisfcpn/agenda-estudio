// ─── Webhook Routes ─────────────────────────────────────
// Receives payment confirmation callbacks from Cora and Stripe
// These endpoints are PUBLIC (no auth) but verify signatures

import { Router, Request, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { stripeVerifyWebhook } from '../../lib/stripeService.js';
import { decryptConfigSafe } from '../../utils/crypto.js';
import crypto from 'node:crypto';

const router = Router();

// ─── Cora Webhook Signature Verification ────────────────
// Cora sends these headers:
//   user-agent: Cora-Webhook
//   webhook-event-id: evt_xxx
//   webhook-event-type: invoice.paid
//   webhook-resource-id: inv_xxx

async function verifyCoraSignature(req: Request): Promise<boolean> {
    // Cora identifies via user-agent and webhook-specific headers
    const userAgent = req.headers['user-agent'] as string;
    const eventId = req.headers['webhook-event-id'] as string;
    const signature = req.headers['x-cora-signature'] as string || req.headers['x-webhook-signature'] as string;

    // Primary: check HMAC signature if webhookSecret is configured
    if (signature) {
        try {
            const integration = await prisma.integrationConfig.findUnique({ where: { provider: 'CORA' } });
            if (!integration) return false;

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

            if (!webhookSecret) {
                console.warn(`[Webhook:Cora] Signature present but no webhookSecret configured for "${environment}"`);
                return process.env.NODE_ENV !== 'production';
            }

            const rawBody = (req as any).rawBody || JSON.stringify(req.body);
            const expectedSignature = crypto
                .createHmac('sha256', webhookSecret)
                .update(rawBody)
                .digest('hex');

            return crypto.timingSafeEqual(
                Buffer.from(signature),
                Buffer.from(expectedSignature)
            );
        } catch {
            return false;
        }
    }

    // Fallback: verify Cora identity via user-agent + event-id headers
    if (userAgent?.includes('Cora-Webhook') && eventId) {
        return true;
    }

    // No signature and no Cora headers — reject in production
    if (process.env.NODE_ENV === 'production') return false;
    console.warn('[Webhook:Cora] No signature/Cora headers — accepting in dev mode');
    return true;
}

// ─── POST /api/webhooks/cora ────────────────────────────
// Cora sends notifications when boleto/PIX payments are confirmed

router.post('/cora', async (req: Request, res: Response) => {
    try {
        // Verify webhook signature
        const isValid = await verifyCoraSignature(req);
        if (!isValid) {
            console.error('[Webhook:Cora] Invalid or missing signature — rejecting');
            res.status(401).json({ error: 'Invalid webhook signature' });
            return;
        }

        const event = req.body;

        console.log('[Webhook:Cora] Received event:', JSON.stringify(event).slice(0, 500));

        // Cora sends event metadata in HEADERS (primary) and sometimes in body (fallback)
        const eventType = (req.headers['webhook-event-type'] as string) || event.event_type || event.type || event.event;
        const invoiceId = (req.headers['webhook-resource-id'] as string) || event.data?.id || event.invoice_id || event.id;

        if (!invoiceId) {
            console.log('[Webhook:Cora] No invoice ID found in event');
            res.status(200).json({ received: true });
            return;
        }

        console.log(`[Webhook:Cora] Event: ${eventType}, Invoice: ${invoiceId}`);

        // Handle payment confirmation events
        // Cora may send event types in different casing — normalize to lowercase
        const normalizedEventType = eventType?.toLowerCase() || '';
        const confirmationEvents = [
            'invoice.paid',
            'invoice.payment_confirmed',
            'payment_received',
            'boleto_paid',
        ];

        if (confirmationEvents.includes(normalizedEventType)) {
            // Find payment by providerRef (Cora invoice ID)
            const payment = await prisma.payment.findFirst({
                where: { providerRef: invoiceId },
            });

            if (payment && payment.status !== 'PAID') {
                // Atomic update: only update if still PENDING to prevent race conditions
                const updated = await prisma.payment.updateMany({
                    where: { id: payment.id, status: 'PENDING' },
                    data: { status: 'PAID', paidAt: new Date() },
                });

                if (updated.count > 0) {
                    console.log(`[Webhook:Cora] Payment ${payment.id} marked as PAID (invoice: ${invoiceId})`);

                    if (payment.contractId) {
                        await unlockNextCycleBookings(payment.contractId);
                    }
                }
            } else if (!payment) {
                console.log(`[Webhook:Cora] No payment found for providerRef: ${invoiceId}`);
            }
        }

        // Handle cancellation events
        const cancellationEvents = ['invoice.cancelled', 'invoice.expired'];
        if (cancellationEvents.includes(normalizedEventType)) {
            const payment = await prisma.payment.findFirst({
                where: { providerRef: invoiceId },
            });

            if (payment && payment.status === 'PENDING') {
                await prisma.payment.updateMany({
                    where: { id: payment.id, status: 'PENDING' },
                    data: { status: 'FAILED' },
                });
                console.log(`[Webhook:Cora] Payment ${payment.id} marked as FAILED (invoice: ${invoiceId})`);
            }
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
        } else {
            // No signature (dev mode only) — accept raw body
            const body = Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString()) : req.body;
            event = body;
            console.log('[Webhook:Stripe] No signature — dev mode');
        }

        console.log('[Webhook:Stripe] Received event:', event.type);

        // Handle checkout.session.completed
        if (event.type === 'checkout.session.completed') {
            const session = event.data.object;
            const paymentId = session.metadata?.paymentId;

            if (paymentId) {
                const payment = await prisma.payment.findUnique({ where: { id: paymentId } });

                if (payment && payment.status !== 'PAID') {
                    // Atomic update to prevent race conditions with verifyPayment
                    const updated = await prisma.payment.updateMany({
                        where: { id: paymentId, status: 'PENDING' },
                        data: {
                            status: 'PAID',
                            paidAt: new Date(),
                            providerRef: session.payment_intent || session.id,
                        },
                    });

                    if (updated.count > 0) {
                        console.log(`[Webhook:Stripe] Payment ${paymentId} marked as PAID`);
                        if (payment.contractId) {
                            await unlockNextCycleBookings(payment.contractId);
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
                await prisma.payment.update({
                    where: { id: paymentId },
                    data: { status: 'FAILED' },
                });
                console.log(`[Webhook:Stripe] Payment ${paymentId} marked as FAILED`);
            }
        }

        // Handle charge.refunded
        if (event.type === 'charge.refunded') {
            const charge = event.data.object;
            const paymentIntentId = charge.payment_intent;

            if (paymentIntentId) {
                const payment = await prisma.payment.findFirst({
                    where: { providerRef: paymentIntentId },
                });

                if (payment) {
                    await prisma.payment.update({
                        where: { id: payment.id },
                        data: { status: 'REFUNDED' },
                    });
                    console.log(`[Webhook:Stripe] Payment ${payment.id} marked as REFUNDED`);
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
                        if (payment.contractId) {
                            await unlockNextCycleBookings(payment.contractId);
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
                        if (payment.contractId) {
                            await unlockNextCycleBookings(payment.contractId);
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
                    await prisma.payment.update({
                        where: { id: payment.id },
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

// ─── Helper: Unlock PROGRESSIVE access bookings ─────────
// When a payment is confirmed for a PROGRESSIVE contract,
// change RESERVED bookings in the next cycle to CONFIRMED

async function unlockNextCycleBookings(contractId: string): Promise<void> {
    try {
        const contract = await prisma.contract.findUnique({
            where: { id: contractId },
            select: { accessMode: true, startDate: true },
        });

        if (!contract || contract.accessMode !== 'PROGRESSIVE') return;

        // Find the earliest RESERVED bookings and confirm them (1 cycle worth)
        const reservedBookings = await prisma.booking.findMany({
            where: {
                contractId,
                status: 'RESERVED',
            },
            orderBy: { date: 'asc' },
            take: 20, // max 1 cycle of bookings
        });

        if (reservedBookings.length === 0) return;

        // Confirm the first cycle of reserved bookings
        // A cycle is ~4 weeks, so confirm bookings within 28 days of the earliest reserved
        const firstDate = reservedBookings[0].date;
        const cycleEnd = new Date(firstDate);
        cycleEnd.setDate(cycleEnd.getDate() + 28);

        const toConfirm = reservedBookings.filter(b => b.date < cycleEnd);

        if (toConfirm.length > 0) {
            await prisma.booking.updateMany({
                where: {
                    id: { in: toConfirm.map(b => b.id) },
                },
                data: { status: 'CONFIRMED' },
            });

            console.log(`[Webhook] Unlocked ${toConfirm.length} bookings for contract ${contractId}`);
        }
    } catch (err) {
        console.error('[Webhook] Error unlocking bookings:', err);
    }
}

export default router;

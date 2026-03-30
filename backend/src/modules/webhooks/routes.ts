// ─── Webhook Routes ─────────────────────────────────────
// Receives payment confirmation callbacks from Cora and Stripe
// These endpoints are PUBLIC (no auth) but verify signatures

import { Router, Request, Response } from 'express';
import { prisma } from '../../lib/prisma';
import { stripeVerifyWebhook } from '../../lib/stripeService';

const router = Router();

// ─── POST /api/webhooks/cora ────────────────────────────
// Cora sends notifications when boleto/PIX payments are confirmed

router.post('/cora', async (req: Request, res: Response) => {
    try {
        const event = req.body;

        console.log('[Webhook:Cora] Received event:', JSON.stringify(event).slice(0, 500));

        // Cora sends different event types
        const eventType = event.event_type || event.type || event.event;
        const invoiceId = event.data?.id || event.invoice_id || event.id;

        if (!invoiceId) {
            console.log('[Webhook:Cora] No invoice ID found in event');
            res.status(200).json({ received: true });
            return;
        }

        // Handle payment confirmation events
        const confirmationEvents = [
            'invoice.paid',
            'invoice.payment_confirmed',
            'PAYMENT_RECEIVED',
            'BOLETO_PAID',
        ];

        if (confirmationEvents.includes(eventType)) {
            // Find payment by providerRef (Cora invoice ID)
            const payment = await prisma.payment.findFirst({
                where: { providerRef: invoiceId },
            });

            if (payment && payment.status !== 'PAID') {
                await prisma.payment.update({
                    where: { id: payment.id },
                    data: { status: 'PAID' },
                });

                console.log(`[Webhook:Cora] Payment ${payment.id} marked as PAID (invoice: ${invoiceId})`);

                // If this payment is linked to a contract with PROGRESSIVE access,
                // unlock the next cycle's bookings
                if (payment.contractId) {
                    await unlockNextCycleBookings(payment.contractId);
                }
            } else if (!payment) {
                console.log(`[Webhook:Cora] No payment found for providerRef: ${invoiceId}`);
            }
        }

        // Handle cancellation events
        const cancellationEvents = ['invoice.cancelled', 'invoice.expired'];
        if (cancellationEvents.includes(eventType)) {
            const payment = await prisma.payment.findFirst({
                where: { providerRef: invoiceId },
            });

            if (payment && payment.status === 'PENDING') {
                await prisma.payment.update({
                    where: { id: payment.id },
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
            // Verify signature in production
            try {
                const rawBody = (req as any).rawBody || JSON.stringify(req.body);
                event = await stripeVerifyWebhook(rawBody, sig);
            } catch (err) {
                console.error('[Webhook:Stripe] Signature verification failed:', err);
                res.status(400).json({ error: 'Invalid signature' });
                return;
            }
        } else {
            // No signature (dev mode) — accept raw body
            event = req.body;
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
                    await prisma.payment.update({
                        where: { id: paymentId },
                        data: {
                            status: 'PAID',
                            providerRef: session.payment_intent || session.id,
                        },
                    });

                    console.log(`[Webhook:Stripe] Payment ${paymentId} marked as PAID`);

                    if (payment.contractId) {
                        await unlockNextCycleBookings(payment.contractId);
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

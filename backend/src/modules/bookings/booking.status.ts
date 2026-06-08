import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { authenticate, authorize } from '../../middleware/auth.js';
import { releaseMultiSlotLock } from '../../lib/redis.js';
import { stripeGetPaymentIntent } from '../../lib/stripeService.js';
import { getPackageSlots } from '../../utils/pricing.js';
import { BookingStatus } from '../../generated/prisma/client.js';
import { restoreCredit } from './booking.service.js';
import { createNotification } from '../notifications/notificationService.js';
import { completeBookingSchema } from './validators.js';
import { deriveStreamAggregates } from '../../lib/streamMetrics.js';

export function registerStatusRoutes(router: Router) {

// ─── POST /api/bookings/:id/complete-payment ─────────────
// Called after successful Stripe payment to confirm a HELD booking

router.post('/:id/complete-payment', authenticate, async (req: Request, res: Response) => {
    try {
        const bookingId = req.params.id as string;
        const userId = req.user!.userId;
        const { paymentIntentId } = req.body;

        const booking = await prisma.booking.findFirst({
            where: { id: bookingId, userId },
            include: { contract: true },
        });

        if (!booking) {
            res.status(404).json({ error: 'Agendamento não encontrado.' });
            return;
        }

        if (booking.status !== 'HELD' && booking.status !== 'RESERVED') {
            res.status(400).json({ error: `Agendamento já está com status ${booking.status}.` });
            return;
        }

        // Check if hold has expired
        if (booking.holdExpiresAt && new Date(booking.holdExpiresAt) < new Date()) {
            res.status(410).json({ error: 'A reserva temporária expirou. O horário foi liberado.' });
            return;
        }

        // PAY-02 FIX: paymentIntentId is REQUIRED — never allow free confirmations
        if (!paymentIntentId) {
            res.status(400).json({ error: 'paymentIntentId é obrigatório para confirmar pagamento.' });
            return;
        }

        // Security: verify the PaymentIntent with Stripe BEFORE updating booking
        try {
            const pi = await stripeGetPaymentIntent(paymentIntentId);
            if (pi.status !== 'succeeded') {
                res.status(400).json({ error: 'Pagamento ainda não confirmado pelo Stripe.' });
                return;
            }

            // PAY-03 FIX: Verify amount matches the booking payment
            const bookingPayment = await prisma.payment.findFirst({
                where: { bookingId, providerRef: paymentIntentId, status: 'PENDING' },
            });
            if (bookingPayment && pi.amount !== bookingPayment.amount) {
                console.error(`[BOOKING] Amount mismatch: PI=${pi.amount}, DB=${bookingPayment.amount}`);
                res.status(400).json({ error: 'Valor do pagamento não confere.' });
                return;
            }
        } catch {
            res.status(400).json({ error: 'Não foi possível verificar o pagamento no Stripe.' });
            return;
        }

        // Update booking to CONFIRMED (AFTER payment verification)
        const updated = await prisma.booking.update({
            where: { id: bookingId },
            data: {
                status: 'CONFIRMED' as BookingStatus,
                holdExpiresAt: null,
            },
        });

        // Update Payment record to PAID (atomic — only if still PENDING)
        const paid = await prisma.payment.updateMany({
            where: {
                bookingId,
                providerRef: paymentIntentId,
                status: 'PENDING',
            },
            data: { status: 'PAID', paidAt: new Date() },
        });

        // If avulso micro-contract, activate it (PAY-07 FIX: atomic guard)
        if (booking.contract?.status === 'AWAITING_PAYMENT') {
            await prisma.contract.updateMany({
                where: { id: booking.contractId!, status: 'AWAITING_PAYMENT' },
                data: { status: 'ACTIVE', paymentDeadline: null },
            });
        }

        // Run the centralized confirmation effects only if THIS call won the PENDING→PAID race.
        // The booking/contract were already confirmed above (idempotent no-ops inside), but this
        // adds the effects this path was missing — notably the "payment confirmed" push.
        if (paid.count > 0) {
            const paidPayment = await prisma.payment.findFirst({
                where: { bookingId, providerRef: paymentIntentId },
                select: { id: true },
            });
            if (paidPayment) {
                const { onPaymentConfirmed } = await import('../../lib/paymentEffects.js');
                await onPaymentConfirmed(paidPayment.id);
            }
        }

        // Release Redis locks (booking is now confirmed in DB)
        const dateStr = booking.date.toISOString().split('T')[0];
        const packageSlots = getPackageSlots(booking.startTime);
        await releaseMultiSlotLock(dateStr, packageSlots, userId);

        res.json({
            booking: {
                id: updated.id,
                date: dateStr,
                startTime: updated.startTime,
                endTime: updated.endTime,
                status: updated.status,
                price: updated.price,
            },
            message: '✅ Pagamento confirmado! Seu horário está reservado.',
        });
    } catch (err) {
        console.error('[BOOKING] complete-payment error:', err);
        res.status(500).json({ error: 'Erro ao confirmar pagamento.' });
    }
});

// ─── PATCH /api/bookings/:id/confirm ────────────────────

router.patch('/:id/confirm', authenticate, async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const userId = req.user!.userId;

    const booking = await prisma.booking.findFirst({
        where: { id, userId, status: BookingStatus.RESERVED },
    });

    if (!booking) {
        res.status(404).json({ error: 'Reserva não encontrada ou já confirmada/cancelada.' });
        return;
    }

    // VULN-C2 FIX: Avulso bookings (with holdExpiresAt) MUST have a PAID payment
    // Contract-based bookings (no hold timer) can confirm directly via credit consumption
    if (booking.holdExpiresAt) {
        const hasPaidPayment = await prisma.payment.findFirst({
            where: { bookingId: id, status: 'PAID' },
        });
        if (!hasPaidPayment) {
            res.status(402).json({ error: 'Pagamento obrigatório para confirmar agendamento avulso.' });
            return;
        }
    }

    // Confirm booking
    const updated = await prisma.booking.update({
        where: { id },
        data: { status: BookingStatus.CONFIRMED, holdExpiresAt: null },
    });

    // Release Redis locks (booking is now persisted in DB)
    const dateStr = booking.date.toISOString().split('T')[0];
    const packageSlots = getPackageSlots(booking.startTime);
    await releaseMultiSlotLock(dateStr, packageSlots, userId);

    res.json({
        booking: {
            id: updated.id,
            date: dateStr,
            startTime: updated.startTime,
            endTime: updated.endTime,
            status: updated.status,
            price: updated.price,
        },
        message: 'Agendamento confirmado com sucesso!',
    });

    // Instant push: notify admin that a booking was confirmed
    const admins = await prisma.user.findMany({ where: { role: 'ADMIN' }, select: { id: true } });
    const bookingDate = booking.date.toISOString().split('T')[0];
    const [dd, mm] = [bookingDate.slice(8, 10), bookingDate.slice(5, 7)];
    for (const admin of admins) {
        createNotification({
            userId: admin.id,
            type: 'BOOKING_CONFIRMED',
            severity: 'info',
            title: '✅ Sessão Confirmada',
            message: `Cliente confirmou sessão de ${dd}/${mm} às ${booking.startTime}`,
            entityType: 'BOOKING',
            entityId: booking.id,
            actionUrl: '/admin/today',
        }).catch(() => {});
    }
});

// ─── PUT /api/bookings/:id/client-cancel ────────────────

router.put('/:id/client-cancel', authenticate, async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const userId = req.user!.userId;

    const booking = await prisma.booking.findFirst({
        where: { id, userId, status: BookingStatus.CONFIRMED },
    });

    if (!booking) {
        res.status(404).json({ error: 'Reserva não encontrada ou já cancelada/concluída.' });
        return;
    }

    const now = new Date();
    // Use proper calculation for 24h before (assume UTC-3 for timezone consistency with fixed slots)
    const bookingDateTime = new Date(`${booking.date.toISOString().split('T')[0]}T${booking.startTime}:00-03:00`);
    const diffMs = bookingDateTime.getTime() - now.getTime();
    const diffHours = diffMs / (1000 * 60 * 60);

    if (diffHours >= 24) {
        // Cancel with refund
        await prisma.booking.update({
            where: { id },
            data: { status: BookingStatus.CANCELLED },
        });

        if (booking.contractId) {
            await restoreCredit(booking.contractId);
        }

        // Instant push: notify admin of cancellation
        const admins = await prisma.user.findMany({ where: { role: 'ADMIN' }, select: { id: true } });
        const cancelDate = booking.date.toISOString().split('T')[0];
        const [cdd, cmm] = [cancelDate.slice(8, 10), cancelDate.slice(5, 7)];
        for (const admin of admins) {
            createNotification({
                userId: admin.id,
                type: 'BOOKING_CANCELLED',
                severity: 'warning',
                title: '🚫 Sessão Cancelada',
                message: `Cliente cancelou sessão de ${cdd}/${cmm} às ${booking.startTime}`,
                entityType: 'BOOKING',
                entityId: booking.id,
                actionUrl: '/admin/today',
            }).catch(() => {});
        }

        res.json({ message: 'Agendamento cancelado com sucesso. O crédito retornou ao seu plano.' });
    } else {
        // Cancel without refund (Late cancellation)
        await prisma.booking.update({
            where: { id },
            data: { status: BookingStatus.FALTA },
        });
        res.json({ message: 'Agendamento desmarcado. Por causa do aviso prévio menor que 24h, o crédito desta sessão foi consumido.' });
    }
});

// ─── PUT /api/bookings/:id/check-in (Admin) ─────────────

router.put('/:id/check-in', authenticate, authorize('ADMIN'), async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const booking = await prisma.booking.findUnique({ where: { id } });
    if (!booking) { res.status(404).json({ error: 'Agendamento não encontrado.' }); return; }
    if (booking.status !== 'RESERVED' && booking.status !== 'CONFIRMED') {
        res.status(400).json({ error: `Não é possível fazer check-in de um agendamento com status ${booking.status}.` }); return;
    }
    const updated = await prisma.booking.update({ where: { id }, data: { status: BookingStatus.CONFIRMED } });
    res.json({ booking: updated, message: '✅ Check-in realizado! Cliente presente.' });
});

// ─── PUT /api/bookings/:id/complete (Admin) ──────────────

router.put('/:id/complete', authenticate, authorize('ADMIN'), async (req: Request, res: Response) => {
    try {
        const id = req.params.id as string;
        const data = completeBookingSchema.parse(req.body || {});
        const booking = await prisma.booking.findUnique({ where: { id } });
        if (!booking) { res.status(404).json({ error: 'Agendamento não encontrado.' }); return; }
        // Allow finalizing an in-progress booking, or re-saving metrics on an already-finalized one.
        if (!['CONFIRMED', 'RESERVED', 'COMPLETED'].includes(booking.status)) {
            res.status(400).json({ error: `Não é possível finalizar um agendamento com status ${booking.status}.` }); return;
        }
        // Legacy aggregates: explicit value wins, else derive from per-network streamMetrics.
        const agg = deriveStreamAggregates(data.streamMetrics);
        const peakViewers = data.peakViewers != null ? data.peakViewers : agg.peakViewers;
        const chatMessages = data.chatMessages != null ? data.chatMessages : agg.chatMessages;
        const updated = await prisma.booking.update({
            where: { id },
            data: {
                status: BookingStatus.COMPLETED,
                ...(data.durationMinutes !== undefined && { durationMinutes: data.durationMinutes }),
                ...(data.isLivestream !== undefined && { isLivestream: data.isLivestream }),
                ...(data.platforms !== undefined && { platforms: data.platforms }),
                ...(data.platformLinks !== undefined && { platformLinks: data.platformLinks }),
                ...(data.streamMetrics !== undefined && { streamMetrics: data.streamMetrics }),
                ...(data.audienceOrigin !== undefined && { audienceOrigin: data.audienceOrigin }),
                ...(data.adminNotes !== undefined && { adminNotes: data.adminNotes }),
                ...(data.clientNotes !== undefined && { clientNotes: data.clientNotes }),
                ...(peakViewers != null && { peakViewers }),
                ...(chatMessages != null && { chatMessages }),
            },
        });
        res.json({ booking: updated, message: '🏁 Sessão finalizada com sucesso!' });
    } catch (err) {
        if (err instanceof z.ZodError) { res.status(400).json({ error: 'Dados inválidos.', details: err.errors }); return; }
        throw err;
    }
});

// ─── PUT /api/bookings/:id/mark-falta (Admin) ───────────

router.put('/:id/mark-falta', authenticate, authorize('ADMIN'), async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const booking = await prisma.booking.findUnique({ where: { id } });
    if (!booking) { res.status(404).json({ error: 'Agendamento não encontrado.' }); return; }
    if (booking.status === 'COMPLETED' || booking.status === 'CANCELLED') {
        res.status(400).json({ error: `Não é possível marcar falta em um agendamento ${booking.status}.` }); return;
    }
    const updated = await prisma.booking.update({ where: { id }, data: { status: BookingStatus.FALTA } });
    res.json({ booking: updated, message: '❌ Sessão marcada como falta (no-show).' });
});

} // end registerStatusRoutes

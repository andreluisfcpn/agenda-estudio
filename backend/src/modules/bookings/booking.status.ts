import { Router, Request, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { authenticate, authorize } from '../../middleware/auth.js';
import { releaseMultiSlotLock } from '../../lib/redis.js';
import { stripeGetPaymentIntent } from '../../lib/stripeService.js';
import { getPackageSlots } from '../../utils/pricing.js';
import { BookingStatus } from '../../generated/prisma/client.js';
import { restoreCredit } from './booking.service.js';

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

        // Security: verify the PaymentIntent with Stripe BEFORE updating booking
        if (paymentIntentId) {
            try {
                const pi = await stripeGetPaymentIntent(paymentIntentId);
                if (pi.status !== 'succeeded') {
                    res.status(400).json({ error: 'Pagamento ainda não confirmado pelo Stripe.' });
                    return;
                }
            } catch {
                res.status(400).json({ error: 'Não foi possível verificar o pagamento no Stripe.' });
                return;
            }
        }

        // Update booking to CONFIRMED (AFTER payment verification)
        const updated = await prisma.booking.update({
            where: { id: bookingId },
            data: {
                status: 'CONFIRMED' as BookingStatus,
                holdExpiresAt: null,
            },
        });

        // Update Payment record to PAID
        if (paymentIntentId) {
            await prisma.payment.updateMany({
                where: {
                    bookingId,
                    providerRef: paymentIntentId,
                    status: 'PENDING',
                },
                data: { status: 'PAID', paidAt: new Date() },
            });
        } else {
            await prisma.payment.updateMany({
                where: {
                    bookingId,
                    status: 'PENDING',
                },
                data: { status: 'PAID', paidAt: new Date() },
            });
        }

        // If avulso micro-contract, activate it
        if (booking.contract?.status === 'AWAITING_PAYMENT') {
            await prisma.contract.update({
                where: { id: booking.contractId },
                data: { status: 'ACTIVE', paymentDeadline: null },
            });
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

    // Confirm booking
    const updated = await prisma.booking.update({
        where: { id },
        data: { status: BookingStatus.CONFIRMED },
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
    const id = req.params.id as string;
    const { durationMinutes, peakViewers, chatMessages } = req.body || {};
    const booking = await prisma.booking.findUnique({ where: { id } });
    if (!booking) { res.status(404).json({ error: 'Agendamento não encontrado.' }); return; }
    if (booking.status !== 'CONFIRMED' && booking.status !== 'RESERVED') {
        res.status(400).json({ error: `Não é possível finalizar um agendamento com status ${booking.status}.` }); return;
    }
    const updated = await prisma.booking.update({
        where: { id },
        data: {
            status: BookingStatus.COMPLETED,
            ...(durationMinutes !== undefined && { durationMinutes }),
            ...(peakViewers !== undefined && { peakViewers }),
            ...(chatMessages !== undefined && { chatMessages }),
        },
    });
    res.json({ booking: updated, message: '🏁 Sessão finalizada com sucesso!' });
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

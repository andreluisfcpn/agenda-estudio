// ─── Payment Confirmation Effects (shared) ──────────────────────────────
// Single source of truth for everything that must happen when a payment
// transitions to PAID. Used by the Stripe webhook, the Cora webhook AND the
// reconciliation paths so the three can never diverge again.
//
// Historical bug this fixes: the Cora/PIX webhook marked the payment PAID but
// (unlike the Stripe webhook) never confirmed the avulso booking nor activated
// the avulso contract, so the cleanup cron deleted the *paid* booking ~10min
// later. Centralizing the effects guarantees parity across providers.

import { prisma } from './prisma.js';
import { createNotification } from '../modules/notifications/notificationService.js';
import { fulfillContractFromPayment } from './contractFulfillment.js';

type PaymentLike = {
    id: string;
    userId: string;
    amount: number;
    bookingId: string | null;
    contractId: string | null;
    paymentUrl?: string | null;
};

/**
 * Activate addon(s) on a booking after the addon payment is confirmed.
 * (Add-on metadata is currently stored as JSON in the legacy `paymentUrl` field.)
 */
export async function activateAddonIfNeeded(paymentId: string): Promise<void> {
    try {
        const payment = await prisma.payment.findUnique({
            where: { id: paymentId },
            select: { bookingId: true, paymentUrl: true },
        });
        if (!payment?.bookingId || !payment.paymentUrl) return;

        const meta = JSON.parse(payment.paymentUrl);
        // Support both single key (legacy) and array of keys
        const keys: string[] = meta.addonKeys || (meta.addonKey ? [meta.addonKey] : []);
        if (keys.length === 0) return;

        const booking = await prisma.booking.findUnique({ where: { id: payment.bookingId } });
        if (!booking) return;

        const toActivate = keys.filter(k => !booking.addOns.includes(k));
        if (toActivate.length > 0) {
            await prisma.booking.update({
                where: { id: payment.bookingId },
                data: { addOns: { push: toActivate } },
            });
            console.log(`[PaymentEffects] Activated addon(s) ${toActivate.join(', ')} on booking ${payment.bookingId}`);
        }
    } catch { /* paymentUrl is not addon metadata, ignore */ }
}

/**
 * Confirm a booking and activate its (awaiting-payment) contract once paid.
 * Idempotent: only flips RESERVED/HELD→CONFIRMED and AWAITING_PAYMENT→ACTIVE.
 * This is the block the Stripe webhook already had and the Cora webhook lacked.
 * Covers avulso micro-contracts AND renewals (both start AWAITING_PAYMENT).
 */
export async function confirmBookingAndActivateContract(payment: PaymentLike): Promise<void> {
    if (payment.bookingId) {
        const bookingUpdated = await prisma.booking.updateMany({
            where: { id: payment.bookingId, status: { in: ['RESERVED', 'HELD'] } },
            data: { status: 'CONFIRMED', holdExpiresAt: null },
        });
        if (bookingUpdated.count > 0) {
            console.log(`[PaymentEffects] Confirmed booking ${payment.bookingId} (cleared hold timer)`);
        }
    }

    if (payment.contractId) {
        // Activate the linked contract (no-op for plan contracts already ACTIVE)
        await prisma.contract.updateMany({
            where: { id: payment.contractId, status: 'AWAITING_PAYMENT' },
            data: { status: 'ACTIVE', paymentDeadline: null },
        });
    }
}

/**
 * Unlock the next cycle of PROGRESSIVE-access bookings when a payment lands.
 */
export async function unlockNextCycleBookings(contractId: string): Promise<void> {
    try {
        const contract = await prisma.contract.findUnique({
            where: { id: contractId },
            select: { accessMode: true, startDate: true },
        });

        if (!contract || contract.accessMode !== 'PROGRESSIVE') return;

        const reservedBookings = await prisma.booking.findMany({
            where: { contractId, status: 'RESERVED' },
            orderBy: { date: 'asc' },
            take: 20, // max 1 cycle of bookings
        });

        if (reservedBookings.length === 0) return;

        // A cycle is ~4 weeks: confirm bookings within 28 days of the earliest reserved
        const firstDate = reservedBookings[0].date;
        const cycleEnd = new Date(firstDate);
        cycleEnd.setDate(cycleEnd.getDate() + 28);

        const toConfirm = reservedBookings.filter(b => b.date < cycleEnd);

        if (toConfirm.length > 0) {
            await prisma.booking.updateMany({
                where: { id: { in: toConfirm.map(b => b.id) } },
                data: { status: 'CONFIRMED' },
            });
            console.log(`[PaymentEffects] Unlocked ${toConfirm.length} bookings for contract ${contractId}`);
        }
    } catch (err) {
        console.error('[PaymentEffects] Error unlocking bookings:', err);
    }
}

/**
 * Generate the bookings for a renewed contract once its renewal payment is
 * confirmed (the contract already exists with status flipping to ACTIVE).
 * Idempotent: skips if the contract already has non-cancelled bookings.
 * Only FIXO contracts pre-generate bookings; FLEX/CUSTOM consume credits.
 */
export async function generateBookingsForRenewedContract(contractId: string): Promise<void> {
    try {
        const contract = await prisma.contract.findUnique({ where: { id: contractId } });
        if (!contract || contract.type !== 'FIXO') return;
        if (!contract.fixedDayOfWeek || !contract.fixedTime) return;

        // Idempotency guard: only generate if there are no bookings yet
        const existing = await prisma.booking.count({
            where: { contractId, status: { not: 'CANCELLED' } },
        });
        if (existing > 0) return;

        const { getBasePriceDynamic, applyDiscount, calculateEndTime } = await import('../utils/pricing.js');
        const { getConfig } = await import('./businessConfig.js');

        const basePrice = await getBasePriceDynamic(contract.tier);
        const discountedPrice = applyDiscount(basePrice, contract.discountPct);
        const sessionsPerMonth = await getConfig('sessions_per_month');
        const totalWeeks = contract.durationMonths * sessionsPerMonth;

        const start = new Date(contract.startDate);
        const current = new Date(start);
        while (current.getDay() !== (contract.fixedDayOfWeek % 7)) {
            current.setDate(current.getDate() + 1);
        }

        const bookings = [];
        for (let week = 0; week < totalWeeks; week++) {
            const bookingDate = new Date(current);
            bookingDate.setDate(current.getDate() + week * 7);
            if (bookingDate > contract.endDate) break;
            bookings.push({
                userId: contract.userId,
                contractId: contract.id,
                date: bookingDate,
                startTime: contract.fixedTime,
                endTime: calculateEndTime(contract.fixedTime),
                status: 'CONFIRMED' as const,
                tierApplied: contract.tier,
                price: discountedPrice,
                addOns: (contract.addOns || []).filter(a => a !== 'GESTAO_SOCIAL'),
            });
        }

        if (bookings.length > 0) {
            await prisma.booking.createMany({ data: bookings });
            console.log(`[PaymentEffects] Generated ${bookings.length} bookings for renewed contract ${contractId}`);
        }
    } catch (err) {
        console.error('[PaymentEffects] Error generating renewal bookings:', err);
    }
}

/**
 * Send the "payment confirmed" notification WITH push (severity 'info' would
 * otherwise never push — this is the single most important event for the user).
 */
export async function notifyPaymentConfirmed(payment: PaymentLike): Promise<void> {
    createNotification({
        userId: payment.userId,
        type: 'PAYMENT_CONFIRMED',
        severity: 'info',
        sendPush: true,
        title: '✅ Pagamento Confirmado',
        message: `Seu pagamento de R$ ${(payment.amount / 100).toFixed(2).replace('.', ',')} foi confirmado!`,
        entityType: 'PAYMENT',
        entityId: payment.id,
        actionUrl: '/meus-pagamentos',
    }).catch(() => {});
}

/**
 * Send the "payment failed" notification (critical → already pushes).
 */
export async function notifyPaymentFailed(payment: PaymentLike, message = 'Seu pagamento foi recusado. Tente novamente em Meus Pagamentos.'): Promise<void> {
    createNotification({
        userId: payment.userId,
        type: 'PAYMENT_FAILED',
        severity: 'critical',
        title: '❌ Pagamento Não Concluído',
        message,
        entityType: 'PAYMENT',
        entityId: payment.id,
        actionUrl: '/meus-pagamentos',
    }).catch(() => {});
}

/**
 * Full orchestration of side-effects after a payment becomes PAID.
 * Caller is responsible for the atomic PENDING→PAID transition first; this
 * function is idempotent so it is safe even if called more than once.
 */
export async function onPaymentConfirmed(paymentId: string): Promise<void> {
    const payment = await prisma.payment.findUnique({
        where: { id: paymentId },
        select: { id: true, userId: true, amount: true, bookingId: true, contractId: true, paymentUrl: true },
    });
    if (!payment) return;

    // 1. Activate purchased add-on(s)
    await activateAddonIfNeeded(payment.id);

    // 2. Confirm booking + activate its contract (fixes the PIX-deleted bug; covers renewals)
    await confirmBookingAndActivateContract(payment);

    // 3. Materialize a self-service contract whose data lives in payment.metadata (no-op otherwise)
    await fulfillContractFromPayment(payment.id);

    // 4. Generate bookings for a renewed contract (no-op unless FIXO renewal w/o bookings)
    if (payment.contractId) {
        await generateBookingsForRenewedContract(payment.contractId);
    }

    // 5. Notify the user (with push)
    await notifyPaymentConfirmed(payment);

    // 6. Unlock next progressive cycle
    if (payment.contractId) {
        await unlockNextCycleBookings(payment.contractId);
    }
}

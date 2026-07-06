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
import { notifyEvent } from '../modules/notifications/notificationService.js';
import { fulfillContractFromPayment } from './contractFulfillment.js';
import { confirmCouponRedemption, releaseCouponForPayments } from './couponService.js';

/** R$ formatter for notification variables. */
const fmtBRL = (cents: number) => `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;

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

        // Bookings carry only per-episode services; monthly services never ride on a recording.
        const { filterPerEpisodeAddons } = await import('./contractPricing.js');
        const perEpisodeAddOns = await filterPerEpisodeAddons(contract.addOns);

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
                addOns: perEpisodeAddOns,
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
    notifyEvent('payment_confirmed', {
        userId: payment.userId,
        vars: { valor: fmtBRL(payment.amount) },
        entityType: 'PAYMENT',
        entityId: payment.id,
    }).catch(() => {});
}

/**
 * Send the "PIX/boleto expired or was cancelled" notification. Distinct from a
 * card decline (payment_failed) — different copy, own eventKey.
 */
export async function notifyPaymentExpired(payment: PaymentLike): Promise<void> {
    notifyEvent('payment_expired', {
        userId: payment.userId,
        entityType: 'PAYMENT',
        entityId: payment.id,
    }).catch(() => {});
}

/**
 * Void every still-PENDING installment of a contract when it is cancelled.
 *
 * Without this, a cancelled contract leaves its future parcelas as PENDING — they
 * keep showing as "faturas abertas", can be auto-charged (Stripe subscription), and
 * a late Cora/Stripe webhook (or the reconciliation cron) could still flip one to
 * PAID. We move them to CANCELLED (a terminal, non-collectible state distinct from a
 * FAILED charge) and cancel any Stripe subscription so it stops billing.
 *
 * Idempotent: only PENDING rows are touched; PAID/FAILED/REFUNDED are left intact.
 * Returns the number of installments voided.
 */
export async function voidContractPendingPayments(contractId: string): Promise<number> {
    // Snapshot the pending rows first so we can cancel any linked Stripe subscription
    // AFTER they are voided (see ordering note below).
    const pending = await prisma.payment.findMany({
        where: { contractId, status: 'PENDING' },
        select: { id: true, stripeSubscriptionId: true },
    });
    if (pending.length === 0) return 0;

    // Void the installments FIRST, then cancel the subscription. Ordering matters:
    // cancelling the Stripe subscription emits a `customer.subscription.deleted` webhook that
    // marks this subscription's still-PENDING payments as FAILED. If we cancelled the sub
    // before voiding, that webhook could win the race and leave the parcelas FAILED ("Falhou")
    // instead of CANCELLED ("Cancelado"). Voiding to CANCELLED first means the webhook's
    // PENDING-only updateMany no longer matches them.
    //
    // Race note: between the snapshot above and this updateMany a concurrent confirmation may
    // flip a row PENDING→PAID. That is safe and correct — the atomic `where status: 'PENDING'`
    // only voids rows still pending, so a legitimately-paid installment is never voided, and a
    // voided installment can never be (re)confirmed (onPaymentConfirmed re-checks status==='PAID').
    const voided = await prisma.payment.updateMany({
        where: { contractId, status: 'PENDING' },
        data: { status: 'CANCELLED' },
    });
    if (voided.count > 0) {
        console.log(`[PaymentEffects] Voided ${voided.count} pending installment(s) for cancelled contract ${contractId}`);
        // Give back any coupon uses still reserved on the voided installments.
        await releaseCouponForPayments(pending.map(p => p.id));
    }

    // Cancel any Stripe subscription tied to these installments so it stops billing. Best-effort:
    // a transient Stripe failure is logged but does not abort the cancellation (the parcelas are
    // already voided locally; the downstream guards reject any late confirmation).
    const subscriptionIds = [...new Set(
        pending.map(p => p.stripeSubscriptionId).filter((s): s is string => !!s)
    )];
    if (subscriptionIds.length > 0) {
        try {
            const { isStripeEnabled, stripeCancelSubscription } = await import('./stripeService.js');
            if (await isStripeEnabled()) {
                for (const subId of subscriptionIds) {
                    try {
                        await stripeCancelSubscription(subId);
                        console.log(`[PaymentEffects] Cancelled Stripe subscription ${subId} for contract ${contractId}`);
                    } catch (subErr) {
                        console.error(`[PaymentEffects] Failed to cancel subscription ${subId} (sub may keep billing — needs manual check):`, subErr instanceof Error ? subErr.message : subErr);
                    }
                }
            }
        } catch (err) {
            console.error('[PaymentEffects] Stripe subscription cancellation skipped:', err instanceof Error ? err.message : err);
        }
    }

    return voided.count;
}

/**
 * Create the remaining monthly installments (months 2..N) once a contract's first payment is
 * confirmed, for the "create-then-pay" contracts that create the contract upfront with only the
 * first installment: RENEWALS and the self-serve/SERVICO hire flows (contract born AWAITING_PAYMENT).
 * Without it such a MONTHLY contract would only ever charge month 1.
 *
 * Idempotent & safe for EVERY flow: skips FULL plans and AVULSO, and bails when the contract already
 * has >= durationMonths non-cancelled payments — which is exactly the case for admin/self/custom
 * contracts that materialize all installments at fulfillment, so this is a no-op for them. Uses the
 * first PAID payment's amount as the per-month figure so every installment matches exactly.
 */
export async function generateRemainingInstallments(contractId: string): Promise<void> {
    try {
        const contract = await prisma.contract.findUnique({ where: { id: contractId } });
        if (!contract) return;
        if (contract.paymentPlan === 'FULL') return;             // FULL = single upfront payment
        if (contract.type === 'AVULSO') return;                  // avulso has no installments

        // Serialize per contract: two concurrent confirmations (e.g. two admin PATCHes marking the
        // same payment PAID, which lacks an atomic guard) must not both pass the count check and
        // double-generate installments. Best-effort Redis lock; if not acquired, another call owns it.
        const { redis } = await import('./redis.js');
        const lockKey = `cron:renewal-installments:${contractId}`;
        if ((await redis.set(lockKey, '1', 'EX', 30, 'NX')) !== 'OK') return;
        try {
            // Materialize months 2..N ONLY at the moment the single first charge is confirmed:
            // exactly one PAID payment and zero PENDING. This makes it a no-op once installments
            // exist (admin/self/custom/legacy-service already create all N at fulfillment; a
            // renewal/create-then-pay contract has just its first PAID). Crucially, it does NOT
            // count "missing" installments — so a deliberately-CANCELLED installment is never
            // resurrected (which a `>= durationMonths` non-cancelled count would wrongly refill on
            // the next sibling confirmation), and a FAILED first attempt (excluded) doesn't block.
            const [paidCount, pendingCount] = await Promise.all([
                prisma.payment.count({ where: { contractId, status: 'PAID' } }),
                prisma.payment.count({ where: { contractId, status: 'PENDING' } }),
            ]);
            if (paidCount !== 1 || pendingCount !== 0) return;

            const firstPaid = await prisma.payment.findFirst({
                where: { contractId, status: 'PAID' },
                orderBy: { createdAt: 'asc' },
                include: { coupon: { select: { scope: true } } },
            });
            if (!firstPaid) return;

            // Coupon parity: a FIRST_PAYMENT coupon discounts ONLY the confirmed first
            // charge — months 2..N must revert to the pre-coupon amount, otherwise the
            // discount would silently leak into every installment. ALL_INSTALLMENTS
            // coupons keep the discounted figure (and stamp the audit fields).
            const couponOnAll = firstPaid.couponId && firstPaid.coupon?.scope === 'ALL_INSTALLMENTS';
            const perMonthAmount = couponOnAll
                ? firstPaid.amount
                : firstPaid.amount + (firstPaid.discountAmount ?? 0);

            const start = new Date(contract.startDate);
            const remaining = [];
            // Installments 2..N are anchored to contract.startDate. FIXO/FLEX/CUSTOM advance
            // on the fixed 28-day billing cadence; standalone monthly SERVICO services advance
            // by calendar month (~30 days). The first payment is due on-demand (today, via /pay).
            const { addBillingCycles, addMonths } = await import('../utils/pricing.js');
            const advance = contract.type === 'SERVICO'
                ? (i: number) => addMonths(start, i)
                : (i: number) => addBillingCycles(start, i);
            // Month 1 is the just-confirmed first charge (index 0); generate months 2..N.
            for (let i = 1; i < contract.durationMonths; i++) {
                const dueDate = advance(i);
                remaining.push({
                    userId: contract.userId,
                    contractId,
                    provider: firstPaid.provider,
                    amount: perMonthAmount,   // parity with the first payment (pre-coupon unless scope=ALL)
                    status: 'PENDING' as const,
                    dueDate,
                    ...(couponOnAll ? {
                        couponId: firstPaid.couponId,
                        couponCode: firstPaid.couponCode,
                        discountAmount: firstPaid.discountAmount,
                    } : {}),
                });
            }
            if (remaining.length > 0) {
                await prisma.payment.createMany({ data: remaining });
                // A 100% ALL_INSTALLMENTS coupon makes later installments R$0 — the gateway
                // can't process a zero charge, so settle them as PAID instead of leaving them
                // stuck PENDING (mirrors the fulfillment path).
                await prisma.payment.updateMany({
                    where: { contractId, status: 'PENDING', amount: 0 },
                    data: { status: 'PAID', paidAt: new Date() },
                }).catch(() => {});
                console.log(`[PaymentEffects] Generated ${remaining.length} remaining installment(s) for contract ${contractId}`);
            }
        } finally {
            await redis.del(lockKey);
        }
    } catch (err) {
        console.error('[PaymentEffects] Error generating renewal installments:', err);
    }
}

/**
 * Apply a change to a contract's recurring services (Contract.addOns), affecting ONLY THE FUTURE:
 *  - recomputes the amount of still-PENDING installments (MONTHLY) / the single PENDING payment (FULL)
 *  - updates the addOns of FUTURE bookings (date >= today, not CANCELLED/COMPLETED) by delta —
 *    drops removed services, adds newly-added per-episode services, and PRESERVES any per-booking
 *    extras the client added individually. booking.price is left untouched (recurring services are
 *    billed in the monthly installment, not per recording).
 *  - persists the new Contract.addOns
 * Scope: FIXO/FLEX ACTIVE only (CUSTOM uses addonConfig; AVULSO has no recurring services).
 * Past/paid installments and past/completed recordings are never touched.
 * Known limitation: a PENDING boleto whose external invoice was already issued (providerRef set) is
 * not re-issued here — PIX/card read payment.amount at charge time, so they pick up the new value.
 */
export async function applyContractServiceChange(contractId: string, newAddOns: string[]): Promise<void> {
    const contract = await prisma.contract.findUnique({ where: { id: contractId } });
    if (!contract) throw new Error('Contrato não encontrado.');
    if (contract.status !== 'ACTIVE') throw new Error('Só é possível editar serviços de um contrato ativo.');
    if (contract.type !== 'FIXO' && contract.type !== 'FLEX') {
        throw new Error('Edição de serviços disponível apenas para contratos Fixo/Flex.');
    }

    const { getBasePriceDynamic, applyDiscount } = await import('../utils/pricing.js');
    const { getConfig } = await import('./businessConfig.js');
    const { computeAddonsCost, computeFullContractTotal } = await import('./contractPricing.js');

    const sessions = await getConfig('sessions_per_month');
    const basePrice = await getBasePriceDynamic(contract.tier);
    const discountedPrice = applyDiscount(basePrice, contract.discountPct);
    const newMonthly = (sessions * discountedPrice) + await computeAddonsCost(newAddOns, contract.discountPct, sessions);
    const newFull = contract.paymentPlan === 'FULL'
        ? await computeFullContractTotal(newMonthly, contract.durationMonths, contract.paymentMethod || undefined)
        : null;

    // Per-episode (monthly:false) services accompany every recording; monthly add-ons never land on bookings.
    const newConfigs = await prisma.addOnConfig.findMany({ where: { key: { in: newAddOns } } });
    const newPerEpisode = newConfigs.filter(c => !c.monthly).map(c => c.key);
    const oldSet = new Set(contract.addOns || []);
    const removed = [...oldSet].filter(k => !newAddOns.includes(k));
    const addedPerEpisode = newPerEpisode.filter(k => !oldSet.has(k));

    const today = new Date(); today.setHours(0, 0, 0, 0);

    await prisma.$transaction(async (tx) => {
        // 1. Recompute still-PENDING installments (PAID/past ones are never matched).
        await tx.payment.updateMany({
            where: { contractId, status: 'PENDING' },
            data: { amount: newFull ?? newMonthly },
        });
        // 2. Future bookings: delta-merge so client-added extras survive (price untouched).
        const futureBookings = await tx.booking.findMany({
            where: { contractId, date: { gte: today }, status: { notIn: ['CANCELLED', 'COMPLETED'] } },
            select: { id: true, addOns: true },
        });
        for (const b of futureBookings) {
            const merged = new Set((b.addOns || []).filter(k => !removed.includes(k)));
            addedPerEpisode.forEach(k => merged.add(k));
            await tx.booking.update({ where: { id: b.id }, data: { addOns: [...merged] } });
        }
        // 3. Persist the contract's new recurring services.
        await tx.contract.update({ where: { id: contractId }, data: { addOns: newAddOns } });
    });

    console.log(`[PaymentEffects] Contract ${contractId} services updated → [${newAddOns.join(', ') || 'none'}]; future installment=${newFull ?? newMonthly}`);
}

/**
 * Full orchestration of side-effects after a payment becomes PAID.
 * Caller is responsible for the atomic PENDING→PAID transition first; this
 * function is idempotent so it is safe even if called more than once.
 */
export async function onPaymentConfirmed(paymentId: string): Promise<void> {
    const payment = await prisma.payment.findUnique({
        where: { id: paymentId },
        select: { id: true, userId: true, amount: true, bookingId: true, contractId: true, paymentUrl: true, status: true },
    });
    if (!payment) return;
    // Defense-in-depth: callers must flip the row to PAID atomically first. Never run
    // confirmation effects (confirm booking, activate contract, notify) for a payment that
    // isn't actually PAID — e.g. a CANCELLED installment of a cancelled contract.
    if (payment.status !== 'PAID') {
        console.warn(`[PaymentEffects] onPaymentConfirmed skipped: payment ${paymentId} status=${payment.status} (expected PAID)`);
        return;
    }

    // 0. Coupon bookkeeping: RESERVED → CONFIRMED (idempotent; no-op without coupon)
    await confirmCouponRedemption(payment.id);

    // 1. Activate purchased add-on(s)
    await activateAddonIfNeeded(payment.id);

    // 2. Confirm booking + activate its contract (fixes the PIX-deleted bug; covers renewals)
    await confirmBookingAndActivateContract(payment);

    // 3. Materialize a self-service contract whose data lives in payment.metadata (no-op otherwise)
    await fulfillContractFromPayment(payment.id);

    // 4. Generate bookings + remaining installments for create-then-pay contracts
    // (renewals + self/SERVICO hire born AWAITING_PAYMENT). No-op when installments already exist.
    if (payment.contractId) {
        await generateBookingsForRenewedContract(payment.contractId);
        await generateRemainingInstallments(payment.contractId);
    }

    // 5. Notify the user (with push)
    await notifyPaymentConfirmed(payment);

    // 6. Unlock next progressive cycle
    if (payment.contractId) {
        await unlockNextCycleBookings(payment.contractId);
    }
}

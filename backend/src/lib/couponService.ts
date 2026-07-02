import { prisma } from './prisma.js';
import { saoPauloParts } from './spTime.js';
import type { Coupon, Prisma } from '../generated/prisma/client.js';

// ─── Coupon service ──────────────────────────────────────────────────────────
// Single source of truth for coupon validation and use accounting (mirrors the
// paymentPolicy.ts pattern). Lifecycle of a use:
//   reserve (same $transaction that creates the Payment, counts toward usedCount)
//     → confirm (onPaymentConfirmed — webhooks Stripe/Cora + admin PATCH)
//     → or release (gateway rollback, webhook FAILED, void, expired-hold cleanup)
// Reserving at creation is what keeps maxUses from over-selling: the discount is
// baked into Payment.amount at creation and the state machine forbids repricing,
// so waiting for confirmation would let N concurrent checkouts all pass validation.

export type CouponErrorCode =
    | 'NOT_FOUND'      // unknown/inactive — generic message so codes can't be probed
    | 'EXPIRED'
    | 'EXHAUSTED'      // global maxUses reached
    | 'USER_LIMIT'     // per-client limit reached
    | 'NOT_ELIGIBLE'   // not in the specific-clients list
    | 'NOT_NEW_CLIENT' // coupon is restricted to first-time clients
    | 'MIN_AMOUNT';    // charge below the coupon's minimum

export class CouponError extends Error {
    constructor(public code: CouponErrorCode, message: string, public httpStatus = 400) {
        super(message);
        this.name = 'CouponError';
    }
}

export interface CouponQuote {
    coupon: Coupon;
    /** Cents taken off baseAmount (never exceeds it). */
    discountAmount: number;
    /** baseAmount - discountAmount (>= 0). */
    finalAmount: number;
}

/** Codes are stored and compared UPPERCASE — case-insensitive for the client. */
export function normalizeCouponCode(code: string): string {
    return code.trim().toUpperCase();
}

/** Discount for a given base amount, in cents. PERCENTUAL uses the same rounding
 *  arithmetic as utils/pricing.ts#applyDiscount so coupon math never diverges. */
export function computeCouponDiscount(coupon: Pick<Coupon, 'discountType' | 'discountValue'>, baseAmount: number): number {
    if (coupon.discountType === 'PERCENTUAL') {
        const discounted = Math.round(baseAmount * (1 - coupon.discountValue / 100));
        return baseAmount - discounted;
    }
    return Math.min(coupon.discountValue, baseAmount); // VALOR — never exceeds the charge
}

/**
 * Validate a coupon for a user + charge WITHOUT consuming a use (advisory: the
 * authoritative check is reserveCouponUse inside the payment-creation transaction).
 *
 * @param userId the CLIENT the eligibility is evaluated for (admin flows pass the
 *               target client, never the admin's own id).
 */
export async function validateCoupon(params: {
    code: string;
    userId: string;
    baseAmount: number;
}): Promise<CouponQuote> {
    const code = normalizeCouponCode(params.code);
    if (!code) throw new CouponError('NOT_FOUND', 'Cupom inválido ou expirado.', 404);

    const coupon = await prisma.coupon.findUnique({
        where: { code },
        include: { eligibleUsers: { select: { userId: true } } },
    });
    // Generic message for unknown AND inactive: don't leak which codes exist.
    if (!coupon || !coupon.active) throw new CouponError('NOT_FOUND', 'Cupom inválido ou expirado.', 404);

    // Expiration on the SÃO PAULO calendar: expiresAt is @db.Date (00:00Z = SP
    // calendar date) and the coupon is valid through the END of that day in SP.
    // Comparing instants directly would expire it 3h early (server runs UTC).
    if (coupon.expiresAt) {
        const todaySp = saoPauloParts(new Date()).dateStr;            // "YYYY-MM-DD"
        const expiresSp = coupon.expiresAt.toISOString().slice(0, 10);
        if (todaySp > expiresSp) throw new CouponError('EXPIRED', 'Este cupom expirou.');
    }

    // Advisory global-cap check (the atomic guard lives in reserveCouponUse).
    if (coupon.maxUses !== null && coupon.usedCount >= coupon.maxUses) {
        throw new CouponError('EXHAUSTED', 'Este cupom atingiu o limite de usos.', 409);
    }

    if (coupon.minAmount !== null && params.baseAmount < coupon.minAmount) {
        const min = `R$ ${(coupon.minAmount / 100).toFixed(2).replace('.', ',')}`;
        throw new CouponError('MIN_AMOUNT', `Este cupom exige um valor mínimo de ${min}.`);
    }

    // Eligibility: specific-clients list (empty list = open to everyone).
    if (coupon.eligibleUsers.length > 0 && !coupon.eligibleUsers.some(e => e.userId === params.userId)) {
        throw new CouponError('NOT_ELIGIBLE', 'Este cupom não está disponível para a sua conta.', 403);
    }

    // Eligibility: new clients only = zero confirmed payments ever (REFUNDED was
    // once paid, so it counts as "already a customer").
    if (coupon.onlyNewClients) {
        const paidCount = await prisma.payment.count({
            where: { userId: params.userId, status: { in: ['PAID', 'REFUNDED'] } },
        });
        if (paidCount > 0) {
            throw new CouponError('NOT_NEW_CLIENT', 'Este cupom é válido apenas para novos clientes.', 403);
        }
    }

    // Per-client limit (RESERVED + CONFIRMED both count; RELEASED gave the use back).
    if (coupon.maxUsesPerUser !== null) {
        const userUses = await prisma.couponRedemption.count({
            where: { couponId: coupon.id, userId: params.userId, status: { not: 'RELEASED' } },
        });
        if (userUses >= coupon.maxUsesPerUser) {
            throw new CouponError('USER_LIMIT', 'Você já utilizou este cupom o número máximo de vezes.', 409);
        }
    }

    const discountAmount = computeCouponDiscount(coupon, params.baseAmount);
    return { coupon, discountAmount, finalAmount: params.baseAmount - discountAmount };
}

/**
 * Reserve one use of the coupon — MUST run inside the same $transaction that
 * creates the Payment. The global cap is enforced by an atomic conditional
 * UPDATE (Postgres serializes row updates, so two concurrent checkouts can
 * never both pass `used_count < max_uses`).
 */
export async function reserveCouponUse(tx: Prisma.TransactionClient, params: {
    couponId: string;
    userId: string;
    paymentId: string;
    originalAmount: number;
    discountAmount: number;
    /** When set, the per-client cap is enforced ATOMICALLY here (not just in the
     *  advisory validateCoupon) so two simultaneous checkouts by the same user
     *  can't both slip past a maxUsesPerUser of N. */
    maxUsesPerUser?: number | null;
}): Promise<void> {
    // Per-client cap: a transaction-scoped advisory lock keyed on (coupon,user)
    // serializes concurrent same-user reservations, so the count below can't race.
    // The lock auto-releases on commit/rollback and never blocks other users.
    if (params.maxUsesPerUser != null) {
        const lockKey = `${params.couponId}:${params.userId}`;
        // Cast the void result to text so Prisma's $queryRaw can deserialize the column.
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))::text`;
        const userUses = await tx.couponRedemption.count({
            where: { couponId: params.couponId, userId: params.userId, status: { not: 'RELEASED' } },
        });
        if (userUses >= params.maxUsesPerUser) {
            throw new CouponError('USER_LIMIT', 'Você já utilizou este cupom o número máximo de vezes.', 409);
        }
    }

    const rows = await tx.$queryRaw<{ id: string }[]>`
        UPDATE coupons SET used_count = used_count + 1
        WHERE id = ${params.couponId} AND active = true
          AND (max_uses IS NULL OR used_count < max_uses)
        RETURNING id`;
    if (rows.length === 0) {
        throw new CouponError('EXHAUSTED', 'Este cupom atingiu o limite de usos.', 409);
    }
    await tx.couponRedemption.create({
        data: {
            couponId: params.couponId,
            userId: params.userId,
            paymentId: params.paymentId,
            status: 'RESERVED',
            originalAmount: params.originalAmount,
            discountAmount: params.discountAmount,
        },
    });
}

/**
 * Mark the redemption of a confirmed payment as CONFIRMED. Idempotent: the
 * RESERVED-only guard makes duplicate webhook deliveries harmless (same pattern
 * as the existing PENDING-only payment guards).
 */
export async function confirmCouponRedemption(paymentId: string): Promise<void> {
    try {
        await prisma.couponRedemption.updateMany({
            where: { paymentId, status: 'RESERVED' },
            data: { status: 'CONFIRMED', confirmedAt: new Date() },
        });
    } catch (err) {
        // Never let coupon bookkeeping break payment confirmation.
        console.error('[Coupon] Error confirming redemption for payment', paymentId, err);
    }
}

/**
 * Give the use back when a payment dies before confirmation (gateway rollback,
 * webhook FAILED, voided installment, expired-hold cleanup). Idempotent
 * (RESERVED-only); CONFIRMED redemptions are never touched (refunds keep the use).
 */
export async function releaseCouponForPayments(paymentIds: string[]): Promise<void> {
    if (paymentIds.length === 0) return;
    try {
        const reserved = await prisma.couponRedemption.findMany({
            where: { paymentId: { in: paymentIds }, status: 'RESERVED' },
            select: { id: true, couponId: true },
        });
        if (reserved.length === 0) return;
        const byCoupon = new Map<string, number>();
        for (const r of reserved) byCoupon.set(r.couponId, (byCoupon.get(r.couponId) ?? 0) + 1);
        await prisma.$transaction(async (tx) => {
            const updated = await tx.couponRedemption.updateMany({
                where: { id: { in: reserved.map(r => r.id) }, status: 'RESERVED' },
                data: { status: 'RELEASED' },
            });
            if (updated.count === 0) return; // lost the race to another release — nothing to decrement
            for (const [couponId, count] of byCoupon) {
                await tx.coupon.update({ where: { id: couponId }, data: { usedCount: { decrement: count } } });
            }
        });
        console.log(`[Coupon] Released ${reserved.length} reserved use(s) for ${paymentIds.length} payment(s)`);
    } catch (err) {
        console.error('[Coupon] Error releasing redemptions:', err);
    }
}

export async function releaseCouponForPayment(paymentId: string): Promise<void> {
    return releaseCouponForPayments([paymentId]);
}

/**
 * For payments about to be HARD-DELETED (abandoned avulso/orphan cleanup, gateway
 * rollbacks): give reserved uses back AND remove the redemption rows — the FK from
 * coupon_redemptions.payment_id is RESTRICT, so leaving them would abort the delete.
 * Only non-PAID payments are ever deleted, so no CONFIRMED redemption is touched
 * by construction (RESERVED is decremented, RELEASED is just removed).
 */
export async function releaseAndPurgeCouponsForPayments(paymentIds: string[]): Promise<void> {
    if (paymentIds.length === 0) return;
    try {
        const rows = await prisma.couponRedemption.findMany({
            where: { paymentId: { in: paymentIds }, status: { not: 'CONFIRMED' } },
            select: { id: true, couponId: true, status: true },
        });
        if (rows.length === 0) return;
        const byCoupon = new Map<string, number>();
        for (const r of rows) {
            if (r.status === 'RESERVED') byCoupon.set(r.couponId, (byCoupon.get(r.couponId) ?? 0) + 1);
        }
        await prisma.$transaction(async (tx) => {
            await tx.couponRedemption.deleteMany({ where: { id: { in: rows.map(r => r.id) } } });
            for (const [couponId, count] of byCoupon) {
                await tx.coupon.update({ where: { id: couponId }, data: { usedCount: { decrement: count } } });
            }
        });
        console.log(`[Coupon] Purged ${rows.length} redemption(s) ahead of payment deletion`);
    } catch (err) {
        console.error('[Coupon] Error purging redemptions:', err);
    }
}

/**
 * Move a RESERVED redemption to a new payment (avulso retry path: the client
 * switches PIX→card and a NEW payment row is created while the old PIX one is
 * left PENDING for the cleanup cron). Must run inside the transaction that
 * creates the new payment. No-op if the old payment carried no reservation.
 */
export async function repointCouponRedemption(tx: Prisma.TransactionClient, fromPaymentId: string, toPaymentId: string): Promise<boolean> {
    const updated = await tx.couponRedemption.updateMany({
        where: { paymentId: fromPaymentId, status: 'RESERVED' },
        data: { paymentId: toPaymentId },
    });
    return updated.count > 0;
}

/**
 * Remove every coupon redemption belonging to a user before the user (and their
 * payments) are hard-deleted. The redemption FKs to both users and payments are
 * RESTRICT, so without this the user/payment deletion aborts. Non-RELEASED rows
 * decrement usedCount so the coupon's cap stays accurate.
 */
export async function purgeCouponRedemptionsForUser(userId: string): Promise<void> {
    const rows = await prisma.couponRedemption.findMany({
        where: { userId },
        select: { id: true, couponId: true, status: true },
    });
    if (rows.length === 0) return;
    const byCoupon = new Map<string, number>();
    for (const r of rows) {
        if (r.status !== 'RELEASED') byCoupon.set(r.couponId, (byCoupon.get(r.couponId) ?? 0) + 1);
    }
    await prisma.$transaction(async (tx) => {
        await tx.couponRedemption.deleteMany({ where: { userId } });
        for (const [couponId, count] of byCoupon) {
            await tx.coupon.update({ where: { id: couponId }, data: { usedCount: { decrement: count } } });
        }
    });
}

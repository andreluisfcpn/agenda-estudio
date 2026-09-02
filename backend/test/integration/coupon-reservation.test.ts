import { describe, it, expect } from 'vitest';
import { prisma } from '../../src/lib/prisma';
import { reserveCouponUse, CouponError } from '../../src/lib/couponService';
import { mkUser, mkCoupon, mkPayment } from './factories';

/** Reserve inside a transaction, as production does (reserveCouponUse must run in a tx). */
async function reserve(couponId: string, userId: string, paymentId: string, maxUsesPerUser?: number | null) {
    return prisma.$transaction(tx =>
        reserveCouponUse(tx, { couponId, userId, paymentId, originalAmount: 10000, discountAmount: 1000, maxUsesPerUser }),
    );
}

describe('reserveCouponUse — atomic global cap (max_uses)', () => {
    it('increments used_count and creates a RESERVED redemption on first use; second use is refused', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const u1 = await mkUser();
        const u2 = await mkUser();
        const coupon = await mkCoupon(admin.id, { maxUses: 1 });
        const p1 = await mkPayment(u1.id, { couponId: coupon.id });
        const p2 = await mkPayment(u2.id, { couponId: coupon.id });

        await reserve(coupon.id, u1.id, p1.id);
        const after1 = await prisma.coupon.findUnique({ where: { id: coupon.id } });
        expect(after1?.usedCount).toBe(1);
        const red = await prisma.couponRedemption.findUnique({ where: { paymentId: p1.id } });
        expect(red?.status).toBe('RESERVED');

        // second reservation exhausts the 1-use cap
        await expect(reserve(coupon.id, u2.id, p2.id)).rejects.toBeInstanceOf(CouponError);
        const after2 = await prisma.coupon.findUnique({ where: { id: coupon.id } });
        expect(after2?.usedCount).toBe(1); // NOT 2 — the failed UPDATE must not bump the counter
    });

    it('concurrent reservations on a 1-use coupon: exactly one succeeds', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const coupon = await mkCoupon(admin.id, { maxUses: 1 });
        const users = await Promise.all(Array.from({ length: 8 }, () => mkUser()));
        const payments = await Promise.all(users.map(u => mkPayment(u.id, { couponId: coupon.id })));

        const outcomes = await Promise.allSettled(
            users.map((u, i) => reserve(coupon.id, u.id, payments[i].id)),
        );
        const ok = outcomes.filter(o => o.status === 'fulfilled').length;
        expect(ok).toBe(1);

        const after = await prisma.coupon.findUnique({ where: { id: coupon.id } });
        expect(after?.usedCount).toBe(1);
        const reservations = await prisma.couponRedemption.count({ where: { couponId: coupon.id } });
        expect(reservations).toBe(1);
    });
});

describe('reserveCouponUse — atomic per-user cap (max_uses_per_user)', () => {
    it('blocks the same user past their cap while allowing a different user', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const u1 = await mkUser();
        const u2 = await mkUser();
        const coupon = await mkCoupon(admin.id, { maxUses: null, maxUsesPerUser: 1 });
        const p1a = await mkPayment(u1.id, { couponId: coupon.id });
        const p1b = await mkPayment(u1.id, { couponId: coupon.id });
        const p2 = await mkPayment(u2.id, { couponId: coupon.id });

        await reserve(coupon.id, u1.id, p1a.id, 1);
        // same user, second attempt → USER_LIMIT
        await expect(reserve(coupon.id, u1.id, p1b.id, 1)).rejects.toMatchObject({ code: 'USER_LIMIT' });
        // a different user is unaffected
        await expect(reserve(coupon.id, u2.id, p2.id, 1)).resolves.toBeUndefined();

        const uses = await prisma.couponRedemption.count({ where: { couponId: coupon.id } });
        expect(uses).toBe(2); // u1 once + u2 once
    });

    it('concurrent same-user reservations respect the per-user cap of 1', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const u1 = await mkUser();
        const coupon = await mkCoupon(admin.id, { maxUses: null, maxUsesPerUser: 1 });
        const payments = await Promise.all(Array.from({ length: 5 }, () => mkPayment(u1.id, { couponId: coupon.id })));

        const outcomes = await Promise.allSettled(payments.map(p => reserve(coupon.id, u1.id, p.id, 1)));
        expect(outcomes.filter(o => o.status === 'fulfilled').length).toBe(1);
        expect(await prisma.couponRedemption.count({ where: { couponId: coupon.id } })).toBe(1);
    });
});

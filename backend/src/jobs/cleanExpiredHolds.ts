import { prisma } from '../lib/prisma.js';
import { getPackageSlots } from '../utils/pricing.js';
import { releaseMultiSlotLock } from '../lib/redis.js';
import { releaseAndPurgeCouponsForPayments, releaseCouponForPayments } from '../lib/couponService.js';

/** Coupon uses must be given back (and redemption rows removed — FK RESTRICT)
 *  before the payments they anchor are hard-deleted. */
async function purgeCouponsForContract(contractId: string): Promise<void> {
    const doomed = await prisma.payment.findMany({
        where: { contractId, status: { not: 'PAID' } },
        select: { id: true },
    });
    await releaseAndPurgeCouponsForPayments(doomed.map(p => p.id));
}

/**
 * Cron job: clean expired HELD/RESERVED bookings and AWAITING_PAYMENT contracts.
 * Runs every 60 seconds.
 *
 * Safety invariants (added to stop deleting just-paid bookings):
 *  - Never cancel/delete anything that has a PAID payment — promote it instead.
 *  - Guard every cancel/delete by current status (atomic updateMany / deleteMany
 *    conditions) so a webhook confirming between the snapshot and the write wins.
 */
export async function cleanExpiredHolds() {
    const now = new Date();

    // 1. Expire HELD or RESERVED bookings past their holdExpiresAt (avulso unpaid)
    const expiredBookings = await prisma.booking.findMany({
        where: {
            status: { in: ['HELD', 'RESERVED'] },
            holdExpiresAt: { not: null, lt: now },
        },
        include: { contract: true },
    });

    for (const booking of expiredBookings) {
        try {
            // ── Guard: did a payment confirm this booking/contract since the snapshot? ──
            const paidExists = await prisma.payment.findFirst({
                where: {
                    status: 'PAID',
                    OR: [
                        { bookingId: booking.id },
                        ...(booking.contractId ? [{ contractId: booking.contractId }] : []),
                    ],
                },
                select: { id: true },
            });

            if (paidExists) {
                // A payment landed — promote rather than delete (repairs a webhook/cron race).
                await prisma.booking.updateMany({
                    where: { id: booking.id, status: { in: ['RESERVED', 'HELD'] } },
                    data: { status: 'CONFIRMED', holdExpiresAt: null },
                });
                if (booking.contractId) {
                    await prisma.contract.updateMany({
                        where: { id: booking.contractId, status: 'AWAITING_PAYMENT' },
                        data: { status: 'ACTIVE', paymentDeadline: null },
                    });
                }
                console.log(`[HOLD-CLEANUP] Booking ${booking.id} has a PAID payment — promoted to CONFIRMED (not cancelled)`);
                continue;
            }

            // Atomic cancel guarded by status: if the webhook confirmed it between the
            // findMany snapshot and now, count===0 and we skip this booking entirely.
            const cancelled = await prisma.booking.updateMany({
                where: { id: booking.id, status: { in: ['HELD', 'RESERVED'] }, holdExpiresAt: { lt: now } },
                data: { status: 'CANCELLED' },
            });
            if (cancelled.count === 0) continue;

            // Release Redis lock
            const dateStr = booking.date.toISOString().split('T')[0];
            const packageSlots = getPackageSlots(booking.startTime);
            await releaseMultiSlotLock(dateStr, packageSlots, booking.userId);

            // Restore contract credits if applicable, or delete abandoned Avulso
            if (booking.contract) {
                const c = booking.contract;

                if (c.type === 'AVULSO') {
                    // Re-verify the contract is still AWAITING_PAYMENT and has NO paid
                    // payment before any destructive delete.
                    const fresh = await prisma.contract.findUnique({ where: { id: c.id }, select: { status: true } });
                    const paid = await prisma.payment.findFirst({ where: { contractId: c.id, status: 'PAID' }, select: { id: true } });

                    if (fresh?.status === 'AWAITING_PAYMENT' && !paid) {
                        await purgeCouponsForContract(c.id);
                        await prisma.payment.deleteMany({ where: { contractId: c.id, status: { not: 'PAID' } } });
                        await prisma.booking.deleteMany({ where: { contractId: c.id } });
                        await prisma.contract.deleteMany({ where: { id: c.id, status: 'AWAITING_PAYMENT' } });
                        console.log(`[HOLD-CLEANUP] Deleted abandoned Avulso contract ${c.id}`);
                    } else {
                        console.log(`[HOLD-CLEANUP] Skipped Avulso ${c.id} cleanup (status=${fresh?.status}, hasPaid=${!!paid})`);
                    }
                } else if ((c.type === 'FLEX') && (c.flexCreditsRemaining ?? 0) >= 0) {
                    await prisma.contract.update({
                        where: { id: c.id },
                        data: { flexCreditsRemaining: (c.flexCreditsRemaining ?? 0) + 1 },
                    });
                } else if (c.type === 'CUSTOM' && (c.customCreditsRemaining ?? 0) >= 0) {
                    await prisma.contract.update({
                        where: { id: c.id },
                        data: { customCreditsRemaining: (c.customCreditsRemaining ?? 0) + 1 },
                    });
                }
            }

            console.log(`[HOLD-CLEANUP] Booking ${booking.id} expired and cancelled/deleted`);
        } catch (err) {
            console.error(`[HOLD-CLEANUP] Failed to clean booking ${booking.id}:`, err);
        }
    }

    const totalCleaned = expiredBookings.length;
    if (totalCleaned > 0) {
        console.log(`[HOLD-CLEANUP] Processed ${totalCleaned} expired bookings.`);
    }

    // 2. Secondary sweep for orphaned AWAITING_PAYMENT contracts
    const orphanedContracts = await prisma.contract.findMany({
        where: {
            status: 'AWAITING_PAYMENT',
            paymentDeadline: { lt: now },
        },
    });

    for (const c of orphanedContracts) {
        try {
            // Re-verify status to prevent race condition with payment webhook
            const fresh = await prisma.contract.findUnique({ where: { id: c.id } });
            if (!fresh || fresh.status !== 'AWAITING_PAYMENT') {
                console.log(`[HOLD-CLEANUP] Contract ${c.id} status changed (now ${fresh?.status}), skipping cleanup`);
                continue;
            }

            // Never delete a contract that has a PAID payment — promote it instead.
            const paid = await prisma.payment.findFirst({ where: { contractId: c.id, status: 'PAID' }, select: { id: true } });
            if (paid) {
                await prisma.contract.updateMany({
                    where: { id: c.id, status: 'AWAITING_PAYMENT' },
                    data: { status: 'ACTIVE', paymentDeadline: null },
                });
                await prisma.booking.updateMany({
                    where: { contractId: c.id, status: { in: ['RESERVED', 'HELD'] } },
                    data: { status: 'CONFIRMED', holdExpiresAt: null },
                });
                console.log(`[HOLD-CLEANUP] Orphan contract ${c.id} has a PAID payment — promoted to ACTIVE (not deleted)`);
                continue;
            }

            await purgeCouponsForContract(c.id);
            await prisma.payment.deleteMany({ where: { contractId: c.id, status: { not: 'PAID' } } });
            await prisma.booking.deleteMany({ where: { contractId: c.id } });
            await prisma.contract.deleteMany({ where: { id: c.id, status: 'AWAITING_PAYMENT' } });
            console.log(`[HOLD-CLEANUP] Swept orphaned expired contract ${c.id}`);
        } catch (err) {
            console.error(`[HOLD-CLEANUP] Failed to sweep orphaned contract ${c.id}:`, err);
        }
    }

    // 3. Abandoned PRE-CONTRACT checkout drafts holding a coupon reservation.
    //    /self and /service create the first payment with the contract only in
    //    metadata (no contractId, no bookingId). If the client never pays, nothing
    //    else ever transitions that payment, so a reserved coupon use would leak
    //    forever. After 24h we fail the draft (atomic PENDING guard) and give the
    //    use back. Contract installments and avulso payments are excluded — their
    //    own lifecycle (webhooks/void/sweeps above) handles their releases.
    const staleDraftCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const staleDrafts = await prisma.payment.findMany({
        where: {
            status: 'PENDING',
            couponId: { not: null },
            contractId: null,
            bookingId: null,
            createdAt: { lt: staleDraftCutoff },
        },
        select: { id: true },
    });
    for (const draft of staleDrafts) {
        try {
            const failed = await prisma.payment.updateMany({
                where: { id: draft.id, status: 'PENDING' },
                data: { status: 'FAILED' },
            });
            if (failed.count > 0) {
                await releaseCouponForPayments([draft.id]);
                console.log(`[HOLD-CLEANUP] Failed stale coupon-reserved draft payment ${draft.id} (>24h) and released the coupon use`);
            }
        } catch (err) {
            console.error(`[HOLD-CLEANUP] Failed to release stale draft ${draft.id}:`, err);
        }
    }
}

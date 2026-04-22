import { prisma } from '../lib/prisma.js';
import { getPackageSlots } from '../utils/pricing.js';
import { releaseMultiSlotLock } from '../lib/redis.js';

/**
 * Cron job: clean expired HELD bookings and AWAITING_PAYMENT contracts.
 * Run every 60 seconds.
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
            // Cancel the booking
            await prisma.booking.update({
                where: { id: booking.id },
                data: { status: 'CANCELLED' },
            });

            // Release Redis lock
            const dateStr = booking.date.toISOString().split('T')[0];
            const packageSlots = getPackageSlots(booking.startTime);
            await releaseMultiSlotLock(dateStr, packageSlots, booking.userId);

            // Restore contract credits if applicable, or delete abandoned Avulso
            if (booking.contract) {
                const c = booking.contract;
                const isAvulso = c.type === 'AVULSO';

                if (isAvulso && c.status === 'AWAITING_PAYMENT') {
                    // Delete the payment(s)
                    await prisma.payment.deleteMany({ where: { contractId: c.id } });
                    // Delete the booking(s)
                    await prisma.booking.deleteMany({ where: { contractId: c.id } });
                    // Delete the contract
                    await prisma.contract.delete({ where: { id: c.id } });
                    console.log(`[HOLD-CLEANUP] Deleted abandoned Avulso contract ${c.id}`);
                } else {
                    if ((c.type === 'FLEX' || c.type === 'AVULSO') && (c.flexCreditsRemaining ?? 0) >= 0) {
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

            // Delete the payment(s)
            await prisma.payment.deleteMany({ where: { contractId: c.id } });
            // Delete the booking(s)
            await prisma.booking.deleteMany({ where: { contractId: c.id } });
            // Delete the contract
            await prisma.contract.delete({ where: { id: c.id } });
            console.log(`[HOLD-CLEANUP] Swept orphaned expired contract ${c.id}`);
        } catch (err) {
            console.error(`[HOLD-CLEANUP] Failed to sweep orphaned contract ${c.id}:`, err);
        }
    }
}

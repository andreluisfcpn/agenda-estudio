// ─── Booking Business Logic Service ─────────────────────
// Extracted from routes.ts — handles credit management,
// conflict detection, and booking lifecycle operations.

import { prisma } from '../../lib/prisma';
import { BookingStatus, Tier } from '../../generated/prisma/client';
import { getPackageSlots } from '../../utils/pricing';

// ─── Credit Management ─────────────────────────────────

/** Restore a single credit to a Flex or Custom contract. */
export async function restoreCredit(contractId: string): Promise<boolean> {
    const contract = await prisma.contract.findUnique({ where: { id: contractId } });
    if (!contract) return false;

    if (contract.type === 'FLEX' || contract.type === 'AVULSO') {
        await prisma.contract.update({
            where: { id: contractId },
            data: { flexCreditsRemaining: (contract.flexCreditsRemaining || 0) + 1 },
        });
        return true;
    }

    if (contract.type === 'CUSTOM' && contract.customCreditsRemaining != null) {
        await prisma.contract.update({
            where: { id: contractId },
            data: { customCreditsRemaining: contract.customCreditsRemaining + 1 },
        });
        return true;
    }

    return false;
}

/** Deduct a single credit from a Flex or Custom contract. */
export async function deductCredit(contractId: string): Promise<boolean> {
    const contract = await prisma.contract.findUnique({ where: { id: contractId } });
    if (!contract) return false;

    if ((contract.type === 'FLEX' || contract.type === 'AVULSO') && (contract.flexCreditsRemaining || 0) > 0) {
        await prisma.contract.update({
            where: { id: contractId },
            data: { flexCreditsRemaining: contract.flexCreditsRemaining! - 1 },
        });
        return true;
    }

    if (contract.type === 'CUSTOM' && (contract.customCreditsRemaining || 0) > 0) {
        await prisma.contract.update({
            where: { id: contractId },
            data: { customCreditsRemaining: contract.customCreditsRemaining! - 1 },
        });
        return true;
    }

    return false;
}

// ─── Conflict Detection ─────────────────────────────────

/** Check if a time slot conflicts with existing bookings on a date. */
export async function hasConflict(
    dateObj: Date,
    startTime: string,
    excludeBookingId?: string
): Promise<boolean> {
    const packageSlots = getPackageSlots(startTime);
    const where: any = {
        date: dateObj,
        status: { not: BookingStatus.CANCELLED },
        OR: packageSlots.map(slot => ({
            startTime: { lte: slot },
            endTime: { gt: slot },
        })),
    };

    if (excludeBookingId) {
        where.id = { not: excludeBookingId };
    }

    const conflicting = await prisma.booking.findFirst({ where });
    return !!conflicting;
}

// ─── Avulso Contract Creation ───────────────────────────

/** Create a micro-contract for a one-off (avulso) booking. */
export async function createAvulsoContract(params: {
    userId: string;
    date: string;
    startTime: string;
    tier: Tier;
    paymentMethod?: string;
    holdExpiresAt: Date;
}): Promise<string> {
    const dateObj = new Date(params.date + 'T00:00:00');
    const parts = params.date.split('-');
    const formattedDate = `${parts[2]}/${parts[1]}/${parts[0]}`;

    const newContract = await prisma.contract.create({
        data: {
            userId: params.userId,
            name: `Avulso ${formattedDate} as ${params.startTime}`,
            type: 'AVULSO',
            tier: params.tier,
            durationMonths: 1,
            discountPct: 0,
            startDate: dateObj,
            endDate: new Date(dateObj.getTime() + 30 * 24 * 60 * 60 * 1000),
            status: 'AWAITING_PAYMENT' as any,
            paymentMethod: params.paymentMethod as any || null,
            flexCreditsTotal: 1,
            flexCreditsRemaining: 0,
            paymentDeadline: params.holdExpiresAt,
        },
    });

    return newContract.id;
}

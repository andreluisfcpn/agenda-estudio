// ─── Availability Service ───────────────────────────────
// Computes slot availability for both public and authenticated endpoints.
// Extracted from bookings/routes.ts for reusability and testability.

import { prisma } from '../../lib/prisma.js';
import { BookingStatus } from '../../generated/prisma/client.js';
import {
    getSlotTier,
    getSlotTierBatch,
    getBasePriceDynamic,
    generateTimeSlots,
    getPackageSlots,
    isOperatingDay,
    getSlotDuration,
} from '../../utils/pricing.js';

// ─── Types ──────────────────────────────────────────────

export interface SlotAvailability {
    time: string;
    available: boolean;
    tier: string | null;
    price?: number | null;
}

export interface DayAvailability {
    date: string;
    dayOfWeek: number;
    closed: boolean;
    slots: SlotAvailability[];
}

// ─── Helpers ────────────────────────────────────────────

/**
 * Build a set of all occupied 30-min slot start times for a given date,
 * considering both bookings and admin-blocked slots.
 */
export async function buildOccupiedSet(
    dateObj: Date,
    options?: { excludeExpiredHolds?: boolean }
): Promise<Set<string>> {
    const [bookings, blockedSlots] = await Promise.all([
        prisma.booking.findMany({
            where: { date: dateObj, status: { not: BookingStatus.CANCELLED } },
            select: { startTime: true, endTime: true, status: true, holdExpiresAt: true },
        }),
        prisma.blockedSlot.findMany({
            where: { date: dateObj },
            select: { startTime: true, endTime: true },
        }),
    ]);

    const occupied = new Set<string>();

    // Expired RESERVED holds no longer occupy the slot. Skipping them is correct for
    // ANY availability reader, so it's the default (opt-out via excludeExpiredHolds:false).
    const skipExpiredHolds = options?.excludeExpiredHolds !== false;

    for (const b of bookings) {
        if (
            skipExpiredHolds &&
            b.status === 'RESERVED' &&
            b.holdExpiresAt &&
            new Date(b.holdExpiresAt).getTime() <= Date.now()
        ) {
            continue;
        }
        // Mark every 30-min slot in the booking's real [startTime, endTime) range —
        // robust to variable package durations (no hardcoded 2h assumption).
        const [sH, sM] = b.startTime.split(':').map(Number);
        const [eH, eM] = b.endTime.split(':').map(Number);
        let m = sH * 60 + sM;
        const end = eH * 60 + eM;
        while (m < end) {
            occupied.add(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
            m += 30;
        }
    }

    for (const b of blockedSlots) {
        const [bStartH, bStartM] = b.startTime.split(':').map(Number);
        const [bEndH, bEndM] = b.endTime.split(':').map(Number);
        let m = bStartH * 60 + bStartM;
        const end = bEndH * 60 + bEndM;
        while (m < end) {
            const h = Math.floor(m / 60);
            const min = m % 60;
            occupied.add(`${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`);
            m += 30;
        }
    }

    return occupied;
}

/**
 * Compute slot availability for a single day (public — no prices).
 */
export async function getPublicDayAvailability(dateStr: string): Promise<DayAvailability> {
    const dateObj = new Date(dateStr + 'T00:00:00');
    const dayOfWeek = dateObj.getUTCDay();

    if (!(await isOperatingDay(dayOfWeek))) {
        return { date: dateStr, dayOfWeek, closed: true, slots: [] };
    }

    const [occupiedSlots, allSlots, slotDuration] = await Promise.all([
        buildOccupiedSet(dateObj),
        generateTimeSlots(),
        getSlotDuration(),
    ]);

    // Pre-load all tier configs once instead of per-slot
    const tierMap = await getSlotTierBatch(dayOfWeek, allSlots);

    const slots = allSlots.map((slot): SlotAvailability => {
        const tier = tierMap.get(slot) ?? null;
        const packageSlots = getPackageSlots(slot, slotDuration);
        const isBlocked = packageSlots.some(s => occupiedSlots.has(s));
        return { time: slot, available: !isBlocked && tier !== null, tier };
    });

    return { date: dateStr, dayOfWeek, closed: false, slots };
}

/**
 * Compute slot availability for a single day (authenticated — includes prices).
 */
export async function getAuthDayAvailability(dateStr: string): Promise<DayAvailability & { myBookings?: any[] }> {
    const dateObj = new Date(dateStr + 'T00:00:00');
    const dayOfWeek = dateObj.getUTCDay();

    if (!(await isOperatingDay(dayOfWeek))) {
        return { date: dateStr, dayOfWeek, closed: true, slots: [] };
    }

    const [occupiedSlots, allSlots, slotDuration] = await Promise.all([
        buildOccupiedSet(dateObj, { excludeExpiredHolds: true }),
        generateTimeSlots(),
        getSlotDuration(),
    ]);

    // Pre-load all tier configs once instead of per-slot
    const tierMap = await getSlotTierBatch(dayOfWeek, allSlots);

    const slots = await Promise.all(
        allSlots.map(async (slot): Promise<SlotAvailability> => {
            const tier = tierMap.get(slot) ?? null;
            const packageSlots = getPackageSlots(slot, slotDuration);
            const isBlocked = packageSlots.some(s => occupiedSlots.has(s));
            const available = !isBlocked && tier !== null;
            return {
                time: slot,
                available,
                tier,
                price: tier ? await getBasePriceDynamic(tier) : null,
            };
        })
    );

    return { date: dateStr, dayOfWeek, closed: false, slots };
}

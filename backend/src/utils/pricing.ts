import { Tier } from '@prisma/client';
import { prisma } from '../lib/prisma';

// ─── Tier Detection ─────────────────────────────────────

/**
 * Determines the pricing tier based on day of week and start time.
 * @param dayOfWeek 0=Sunday, 1=Monday, ..., 6=Saturday (JS Date convention)
 * @param startTime "HH:MM" format
 */
export function getSlotTier(dayOfWeek: number, startTime: string): Tier | null {
    // Sunday = closed
    if (dayOfWeek === 0) return null;

    if (!['10:00', '13:00', '15:30', '18:00', '20:30'].includes(startTime)) {
        return null;
    }

    if (dayOfWeek === 6) return Tier.SABADO;

    if (['10:00', '13:00', '15:30'].includes(startTime)) {
        return Tier.COMERCIAL;
    }

    if (['18:00', '20:30'].includes(startTime)) {
        return Tier.AUDIENCIA;
    }

    return null;
}

// ─── Pricing ────────────────────────────────────────────

const DEFAULT_PRICES: Record<string, number> = {
    COMERCIAL: 30000,
    AUDIENCIA: 40000,
    SABADO: 50000,
};

/** Base price for a 2-hour package (in cents) — hardcoded fallback */
export function getBasePrice(tier: Tier): number {
    return DEFAULT_PRICES[tier] ?? 30000;
}

/** Dynamic base price: reads from DB first, falls back to hardcoded */
export async function getBasePriceDynamic(tier: Tier): Promise<number> {
    try {
        const config = await prisma.pricingConfig.findUnique({
            where: { tier },
        });
        if (config) return config.price;
    } catch {
        // DB not available, fall back
    }
    return getBasePrice(tier);
}

/** Apply contract discount to a base price */
export function applyDiscount(basePrice: number, discountPct: number): number {
    return Math.round(basePrice * (1 - discountPct / 100));
}

/** Format cents to BRL string */
export function formatBRL(cents: number): string {
    return `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;
}

// ─── Tier Hierarchy ─────────────────────────────────────

const TIER_LEVEL: Record<Tier, number> = {
    [Tier.COMERCIAL]: 1,
    [Tier.AUDIENCIA]: 2,
    [Tier.SABADO]: 3,
};

/**
 * Check if a client with a given contract tier can book a slot of a given tier.
 * Downward compatibility: higher tiers can access lower tiers.
 */
export function canAccessTier(contractTier: Tier, slotTier: Tier): boolean {
    return TIER_LEVEL[contractTier] >= TIER_LEVEL[slotTier];
}

// ─── Time Slot Utilities ────────────────────────────────

/**
 * Generate the 5 official start times for the block slots.
 */
export function generateTimeSlots(): string[] {
    return ['10:00', '13:00', '15:30', '18:00', '20:30'];
}

/**
 * Given a start time and package duration (in hours), return the list of
 * 30-minute slot start times covered by the package.
 */
export function getPackageSlots(startTime: string, packageHours: number = 2): string[] {
    const slots: string[] = [];
    const [h, m] = startTime.split(':').map(Number);
    let totalMinutes = h * 60 + m;

    const slotCount = (packageHours * 60) / 30;
    for (let i = 0; i < slotCount; i++) {
        const sh = Math.floor(totalMinutes / 60);
        const sm = totalMinutes % 60;
        slots.push(`${String(sh).padStart(2, '0')}:${String(sm).padStart(2, '0')}`);
        totalMinutes += 30;
    }
    return slots;
}

/**
 * Calculate end time given start time and duration.
 */
export function calculateEndTime(startTime: string, durationHours: number = 2): string {
    const [h, m] = startTime.split(':').map(Number);
    const totalMinutes = h * 60 + m + durationHours * 60;
    const endH = Math.floor(totalMinutes / 60);
    const endM = totalMinutes % 60;
    return `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`;
}

/**
 * Check if a 2h package starting at startTime fits within operating hours.
 */
export function fitsInOperatingHours(
    startTime: string,
    durationHours: number = 2,
    closeTime: string = '23:00'
): boolean {
    const endTime = calculateEndTime(startTime, durationHours);
    const [endH, endM] = endTime.split(':').map(Number);
    const [closeH, closeM] = closeTime.split(':').map(Number);
    return endH * 60 + endM <= closeH * 60 + closeM;
}

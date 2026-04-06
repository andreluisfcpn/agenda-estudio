import { Tier } from '../generated/prisma/client';
import { prisma } from '../lib/prisma';
import { getConfig, getConfigString } from '../lib/businessConfig';

// ─── Tier Detection ─────────────────────────────────────

/**
 * Determines the pricing tier based on day of week and start time.
 * Now reads tier mapping from business config (dynamic).
 * @param dayOfWeek 0=Sunday, 1=Monday, ..., 6=Saturday (JS Date convention)
 * @param startTime "HH:MM" format
 */
export async function getSlotTier(dayOfWeek: number, startTime: string): Promise<Tier | null> {
    const operatingDays = (await getConfigString('operating_days')).split(',').map(Number);
    if (!operatingDays.includes(dayOfWeek)) return null;

    const allSlots = (await getConfigString('time_slots')).split(',').map(s => s.trim());
    if (!allSlots.includes(startTime)) return null;

    if (dayOfWeek === 6) return Tier.SABADO;

    const comercialSlots = (await getConfigString('comercial_slots')).split(',').map(s => s.trim());
    if (comercialSlots.includes(startTime)) return Tier.COMERCIAL;

    const audienciaSlots = (await getConfigString('audiencia_slots')).split(',').map(s => s.trim());
    if (audienciaSlots.includes(startTime)) return Tier.AUDIENCIA;

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
 * Generate the official start times for the block slots (dynamic from config).
 */
export async function generateTimeSlots(): Promise<string[]> {
    const csv = await getConfigString('time_slots');
    return csv.split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * Get the operating days as an array of JS day-of-week numbers.
 */
export async function getOperatingDays(): Promise<number[]> {
    const csv = await getConfigString('operating_days');
    return csv.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
}

/**
 * Check if a given JS dayOfWeek (0=Sun..6=Sat) is an operating day.
 */
export async function isOperatingDay(dayOfWeek: number): Promise<boolean> {
    const days = await getOperatingDays();
    return days.includes(dayOfWeek);
}

/**
 * Get the slot duration in hours (dynamic from config).
 */
export async function getSlotDuration(): Promise<number> {
    return getConfig('slot_duration_hours');
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
 * Check if a package fits within operating hours.
 */
export async function fitsInOperatingHours(
    startTime: string,
    durationHours?: number,
): Promise<boolean> {
    const dur = durationHours ?? await getSlotDuration();
    const closeTime = await getConfigString('close_time');
    const endTime = calculateEndTime(startTime, dur);
    const [endH, endM] = endTime.split(':').map(Number);
    const [closeH, closeM] = closeTime.split(':').map(Number);
    return endH * 60 + endM <= closeH * 60 + closeM;
}

import { prisma } from './prisma.js';

// Default values used if DB has no row for a key
const DEFAULTS: Record<string, string> = {
    // ── plans ──
    discount_3months: '30',
    discount_6months: '40',
    sessions_per_month: '4',
    episodes_3months: '12',
    episodes_6months: '24',
    // ── policies ──
    cancellation_fine_pct: '20',
    first_booking_min_days: '1',
    first_booking_max_days: '15',
    reschedule_max_days: '7',
    reschedule_min_hours: '24',
    booking_min_advance_minutes: '30',
    // ── payments ──
    pix_extra_discount_pct: '10',
    card_fee_3x_pct: '15',
    card_fee_6x_pct: '20',
    service_discount_3months: '30',
    service_discount_6months: '40',
    // ── schedule ──
    time_slots: '10:00,13:00,15:30,18:00,20:30',
    slot_duration_hours: '2',
    comercial_slots: '10:00,13:00,15:30',
    audiencia_slots: '18:00,20:30',
    operating_days: '1,2,3,4,5,6',
    close_time: '23:00',
    // ── gateway ──
    gateway_stripe_fee_pct: '4',
    gateway_cora_fee_cents: '200',
    // ── studio ──
    studio_name: 'Estúdio Búzios Digital',
    studio_logo_url: 'https://buzios.digital/wp-content/uploads/2025/01/logo-site-branca.svg',
    studio_email: 'contato@buzios.digital',
    studio_hero_image: 'https://buzios.digital/wp-content/uploads/elementor/thumbs/bd-estudio-enhanced-sr-r9lm9twze86yo0wxu68fp1e0yf8baho28zrniyf1o0.jpg',
    studio_location: 'Búzios, RJ',
};

// Simple in-memory cache (60s TTL)
let cache: Record<string, string> | null = null;
let cacheAt = 0;
const CACHE_TTL_MS = 60_000;

async function loadAll(): Promise<Record<string, string>> {
    const now = Date.now();
    if (cache && now - cacheAt < CACHE_TTL_MS) return cache;

    try {
        const rows = await prisma.businessConfig.findMany();
        const result: Record<string, string> = { ...DEFAULTS };
        for (const row of rows) {
            result[row.key] = row.value;
        }
        cache = result;
        cacheAt = now;
        return result;
    } catch {
        return { ...DEFAULTS };
    }
}

/** Returns a numeric config value (falls back to default if key not found). */
export async function getConfig(key: string): Promise<number> {
    const all = await loadAll();
    const raw = all[key] ?? DEFAULTS[key] ?? '0';
    return parseFloat(raw);
}

/** Returns a string config value (for text, URLs, CSV lists). */
export async function getConfigString(key: string): Promise<string> {
    const all = await loadAll();
    return all[key] ?? DEFAULTS[key] ?? '';
}

/** Returns all configs as a map of key → string value. */
export async function getAllConfigs(): Promise<Record<string, string>> {
    return loadAll();
}

/** Invalidates the in-memory cache (call after saving configs). */
export function invalidateConfigCache() {
    cache = null;
}

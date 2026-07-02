// ─── São Paulo calendar helpers ──────────────────────────────────────────────
// The server runs in UTC; the studio (and all copy shown to clients) lives in
// America/Sao_Paulo (UTC-3, no DST since 2019). Booking dates are stored as
// @db.Date at 00:00Z representing the SP calendar date. These helpers keep all
// "hoje/amanhã" decisions on the SP calendar instead of the UTC one (which is
// already "tomorrow" between 21:00 and midnight SP).

export interface SpParts { y: number; m: number; day: number; hour: number; dateStr: string; }

/** Calendar parts of an instant in America/Sao_Paulo. */
export function saoPauloParts(d: Date): SpParts {
    const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Sao_Paulo',
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
    });
    const parts: Record<string, string> = {};
    for (const p of fmt.formatToParts(d)) parts[p.type] = p.value;
    // en-CA gives 24h; "24" can appear at midnight on some engines → normalize to "00".
    const hour = parts.hour === '24' ? 0 : Number(parts.hour);
    return {
        y: Number(parts.year), m: Number(parts.month), day: Number(parts.day),
        hour, dateStr: `${parts.year}-${parts.month}-${parts.day}`,
    };
}

/**
 * Whole-day difference between a booking's stored date (@db.Date at 00:00Z, SP
 * calendar) and "now" on the SP calendar. 0 = hoje, 1 = amanhã, -1 = ontem.
 */
export function spDaysFromToday(bookingDate: Date, now: Date = new Date()): number {
    const sp = saoPauloParts(now);
    const todayUtcMidnight = Date.UTC(sp.y, sp.m - 1, sp.day);
    const iso = bookingDate.toISOString().slice(0, 10);
    const [by, bm, bd] = iso.split('-').map(Number);
    return Math.round((Date.UTC(by, bm - 1, bd) - todayUtcMidnight) / 86_400_000);
}

/** "DD/MM" for a booking's stored date (@db.Date at 00:00Z). */
export function spDdMm(bookingDate: Date): string {
    const iso = bookingDate.toISOString().slice(0, 10);
    return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
}

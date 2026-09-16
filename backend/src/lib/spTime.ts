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

const WEEKDAYS_PT = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];

/** Dia da semana (pt-BR) da data-calendário armazenada (@db.Date). Ancorado ao meio-dia UTC para não
 *  escorregar de dia por fuso. */
export function spWeekday(bookingDate: Date): string {
    const [y, m, d] = bookingDate.toISOString().slice(0, 10).split('-').map(Number);
    return WEEKDAYS_PT[new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay()];
}

/**
 * Rótulo do dia para lembretes/notificações, calculado no fuso SP e SEM linguagem relativa que envelheça
 * num push já entregue: "hoje (DD/MM)" quando é o próprio dia; caso contrário a data absoluta com o dia
 * da semana — "quarta-feira (DD/MM)". Um push de 24h fica na bandeja e costuma ser lido no dia seguinte;
 * "amanhã" viraria mentira, enquanto a data absoluta continua correta seja quando for lida. O lembrete
 * que chega no PRÓPRIO dia (2h antes) cai em daysFromToday === 0 e diz "hoje".
 */
export function spDayLabel(bookingDate: Date, now: Date = new Date()): string {
    const ddmm = spDdMm(bookingDate);
    return spDaysFromToday(bookingDate, now) === 0 ? `hoje (${ddmm})` : `${spWeekday(bookingDate)} (${ddmm})`;
}

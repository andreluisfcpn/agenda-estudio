// ─── Studio timezone helpers ────────────────────────────
// The studio operates in America/Sao_Paulo (UTC-3, no DST since 2019). Booking and slot
// times are São Paulo wall-clock. These helpers keep scheduling decisions correct
// regardless of the device's own timezone (mirrors the backend's studioDateTime).

/** Absolute instant of a São Paulo slot — pins the -03:00 offset. */
export function studioSlotDate(dateStr: string, time: string): Date {
    return new Date(`${dateStr}T${time}:00-03:00`);
}

/** Today's calendar date in São Paulo as "YYYY-MM-DD" (en-CA → YYYY-MM-DD). */
export function todayStrSaoPaulo(): string {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
}

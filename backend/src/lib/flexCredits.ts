// ─── FLEX Credits — Weekly-Window Engine ───────────────
// Pure, testable model of the FLEX credit pace (banking/compensation):
//   - The cycle starts at the 1st recording (earliest non-cancelled booking).
//   - Each elapsed 7-day window expects 1 cumulative recording.
//   - Recording ahead "banks" future weeks (a session dated in window k covers week k).
//   - A credit is forfeited (permanently) when a window closes and the client is
//     behind the cumulative pace — `shortfall = max(0, weeksElapsed − recordingsWithinElapsed)`.
// Forfeiture is monotonic and grandfathered (see flexForfeitFloor) so existing
// contracts are never punished retroactively.

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface FlexStateInput {
    /** flexCreditsTotal (12 or 24). */
    total: number;
    /** Stored flexCycleStart (fallback when there are no bookings yet). */
    cycleStart: Date | null;
    /** Dates of all non-cancelled bookings on the contract. */
    bookingDates: Date[];
    now: Date;
}

export interface FlexState {
    started: boolean;
    /** Effective cycle start = 1st recording (earliest booking), or stored fallback. */
    cycleStart: Date | null;
    total: number;
    /** Total non-cancelled recordings (credits used). */
    recordings: number;
    /** Fully-closed 7-day windows so far (0..total). */
    weeksElapsed: number;
    /** Recordings whose date falls within the elapsed windows. */
    recordingsWithinElapsed: number;
    /** How far behind the weekly pace, cumulative. */
    shortfall: number;
    /** 1-based index of the window containing `now` (null if not started / cycle ended). */
    currentWindowIndex: number | null;
    currentWindowStart: Date | null;
    currentWindowEnd: Date | null;
    daysLeftInWindow: number | null;
    /** Whether any booking is dated within the current window. */
    recordedThisWindow: boolean;
}

export function computeFlexState(input: FlexStateInput): FlexState {
    const { total, bookingDates, now } = input;
    const sortedMs = bookingDates.filter(Boolean).map(d => +d).sort((a, b) => a - b);
    const recordings = sortedMs.length;

    // The cycle start is PERSISTED (flexCycleStart) — set to the 1st recording date and
    // never moved — so cancelling/rebooking can't reset the weekly clock. Until it is set
    // the cycle hasn't started → no windows elapse → no forfeiture.
    const cycleStartMs = input.cycleStart ? +input.cycleStart : null;

    if (cycleStartMs == null) {
        return {
            started: false, cycleStart: null, total, recordings,
            weeksElapsed: 0, recordingsWithinElapsed: 0, shortfall: 0,
            currentWindowIndex: null, currentWindowStart: null, currentWindowEnd: null,
            daysLeftInWindow: null, recordedThisWindow: false,
        };
    }

    const nowMs = +now;
    const elapsedRaw = Math.floor((nowMs - cycleStartMs) / WEEK_MS);
    const weeksElapsed = Math.max(0, Math.min(total, elapsedRaw));
    const elapsedBoundaryMs = cycleStartMs + weeksElapsed * WEEK_MS;
    const recordingsWithinElapsed = sortedMs.filter(ms => ms < elapsedBoundaryMs).length;
    const shortfall = Math.max(0, weeksElapsed - recordingsWithinElapsed);

    let currentWindowIndex: number | null = null;
    let currentWindowStart: Date | null = null;
    let currentWindowEnd: Date | null = null;
    let daysLeftInWindow: number | null = null;
    let recordedThisWindow = false;

    if (elapsedRaw >= 0 && elapsedRaw < total) {
        currentWindowIndex = elapsedRaw + 1; // window containing `now`
        const startMs = cycleStartMs + elapsedRaw * WEEK_MS;
        const endMs = startMs + WEEK_MS;
        currentWindowStart = new Date(startMs);
        currentWindowEnd = new Date(endMs);
        daysLeftInWindow = Math.max(0, Math.ceil((endMs - nowMs) / DAY_MS));
        recordedThisWindow = sortedMs.some(ms => ms >= startMs && ms < endMs);
    }

    return {
        started: true, cycleStart: new Date(cycleStartMs), total, recordings,
        weeksElapsed, recordingsWithinElapsed, shortfall,
        currentWindowIndex, currentWindowStart, currentWindowEnd,
        daysLeftInWindow, recordedThisWindow,
    };
}

/**
 * Total forfeitures that should have occurred, given the grandfather floor.
 * Clamped so we never forfeit credits already used (total − recordings).
 */
export function targetForfeit(shortfall: number, floor: number, total: number, recordings: number): number {
    const maxForfeitable = Math.max(0, total - recordings);
    return Math.min(maxForfeitable, Math.max(0, shortfall - floor));
}

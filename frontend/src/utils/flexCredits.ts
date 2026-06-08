// ─── FLEX Credits — Weekly-Window Engine (frontend port) ───────────────
// Faithful port of backend/src/lib/flexCredits.ts (computeFlexState).
// Display-only — mirrors the SAME math the backend uses to drive forfeiture,
// so the client sees exactly the state the server enforces. Do NOT add new
// rules here; this only reflects the backend for the UI.
//
//   - The cycle starts at the 1st recording (stored flexCycleStart) and never moves.
//   - Each elapsed 7-day window expects 1 cumulative recording.
//   - Recording ahead "banks" future weeks (a session dated in window k covers week k).
//   - A credit is forfeited when a window closes and the client is behind the
//     cumulative pace — shortfall = max(0, weeksElapsed − recordingsWithinElapsed).

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface FlexStateInput {
    /** flexCreditsTotal (12 or 24). */
    total: number;
    /** Stored flexCycleStart (null until the 1st recording → cycle not started). */
    cycleStart: Date | null;
    /** Dates of all non-cancelled bookings on the contract. */
    bookingDates: Date[];
    now: Date;
}

export interface FlexState {
    started: boolean;
    /** Effective cycle start = stored flexCycleStart, or null if not started. */
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
    // never moved. Until it is set the cycle hasn't started → no windows elapse.
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

// ─── Per-week status (banking-aware) — visual counterpart of the shortfall ───
// Returns the status of EACH week 1..total, accounting for banking/compensation
// exactly like the backend forfeiture math: a week is "covered" when the
// cumulative recordings up to its boundary already meet the cumulative pace
// (so recording ahead retroactively fills earlier banked weeks).
export type FlexWeekStatus = 'recorded' | 'open' | 'missed' | 'future';

export function flexWeekStatuses(input: FlexStateInput): FlexWeekStatus[] {
    const { total } = input;
    const cycleStartMs = input.cycleStart ? +input.cycleStart : null;

    // Cycle not started → every week is still in the future.
    if (cycleStartMs == null) {
        return Array.from({ length: Math.max(0, total) }, () => 'future' as FlexWeekStatus);
    }

    const sortedMs = input.bookingDates.filter(Boolean).map(d => +d).sort((a, b) => a - b);
    const nowMs = +input.now;
    const elapsedRaw = Math.floor((nowMs - cycleStartMs) / WEEK_MS);
    const weeksElapsed = Math.max(0, Math.min(total, elapsedRaw));
    // 1-based index of the window containing `now`, or null if the cycle ended.
    const currentIdx = elapsedRaw >= 0 && elapsedRaw < total ? elapsedRaw + 1 : null;

    // Cumulative non-cancelled recordings strictly before the end of week k.
    const cumRec = (k: number) => sortedMs.filter(ms => ms < cycleStartMs + k * WEEK_MS).length;

    const out: FlexWeekStatus[] = [];
    for (let k = 1; k <= total; k++) {
        if (currentIdx != null && k === currentIdx) {
            // Current/open window: recorded if any booking lands inside it.
            const startMs = cycleStartMs + (k - 1) * WEEK_MS;
            const endMs = startMs + WEEK_MS;
            out.push(sortedMs.some(ms => ms >= startMs && ms < endMs) ? 'recorded' : 'open');
        } else if (currentIdx != null && k < currentIdx) {
            // Closed window before the current one: covered by cumulative pace?
            out.push(cumRec(k) >= k ? 'recorded' : 'missed');
        } else if (currentIdx == null && k <= weeksElapsed) {
            // Cycle ended; this week is fully closed → covered by cumulative pace?
            out.push(cumRec(k) >= k ? 'recorded' : 'missed');
        } else {
            // Future week (k > currentIdx, or beyond the elapsed range).
            out.push('future');
        }
    }
    return out;
}

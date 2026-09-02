import { describe, it, expect } from 'vitest';
import { computeFlexState } from '../src/lib/flexCredits';

// Constants mirrored from the source.
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// Fixed cycle start; all `now`/booking dates derived from it in exact ms so
// there is no timezone ambiguity.
const CS = Date.UTC(2026, 0, 1, 0, 0, 0); // 2026-01-01T00:00:00Z
const day = (n: number) => new Date(CS + n * DAY_MS);
const cycleStart = new Date(CS);

describe('computeFlexState', () => {
    it('not started when cycleStart is null (no windows, no forfeiture)', () => {
        const s = computeFlexState({
            total: 12,
            cycleStart: null,
            bookingDates: [day(0), day(3)],
            now: day(30),
        });
        expect(s.started).toBe(false);
        expect(s.cycleStart).toBeNull();
        expect(s.total).toBe(12);
        expect(s.recordings).toBe(2); // recordings still counted from bookingDates
        expect(s.weeksElapsed).toBe(0);
        expect(s.recordingsWithinElapsed).toBe(0);
        expect(s.shortfall).toBe(0);
        expect(s.currentWindowIndex).toBeNull();
        expect(s.currentWindowStart).toBeNull();
        expect(s.currentWindowEnd).toBeNull();
        expect(s.daysLeftInWindow).toBeNull();
        expect(s.recordedThisWindow).toBe(false);
    });

    it('fresh cycle: within window 1, nothing elapsed, nothing forfeited', () => {
        // now = CS + 1 day. elapsedRaw = floor(1/7) = 0.
        const s = computeFlexState({
            total: 12,
            cycleStart,
            bookingDates: [day(0)],
            now: day(1),
        });
        expect(s.started).toBe(true);
        expect(s.cycleStart!.getTime()).toBe(CS);
        expect(s.recordings).toBe(1);
        expect(s.weeksElapsed).toBe(0);
        // elapsedBoundary = CS + 0 => no bookings strictly before it.
        expect(s.recordingsWithinElapsed).toBe(0);
        expect(s.shortfall).toBe(0);
        expect(s.currentWindowIndex).toBe(1);
        expect(s.currentWindowStart!.getTime()).toBe(CS);
        expect(s.currentWindowEnd!.getTime()).toBe(CS + WEEK_MS);
        // ceil((7d - 1d)/1d) = 6
        expect(s.daysLeftInWindow).toBe(6);
        // booking at day0 lies in [CS, CS+week)
        expect(s.recordedThisWindow).toBe(true);
    });

    it('window closed behind pace: shortfall accrues', () => {
        // now = CS + 23 days. elapsedRaw = floor(23/7) = 3.
        const s = computeFlexState({
            total: 12,
            cycleStart,
            bookingDates: [day(0)],
            now: day(23),
        });
        expect(s.weeksElapsed).toBe(3);
        // boundary = CS + 21d; only the day0 booking is before it.
        expect(s.recordingsWithinElapsed).toBe(1);
        expect(s.shortfall).toBe(2); // max(0, 3 - 1)
        expect(s.currentWindowIndex).toBe(4); // elapsedRaw + 1
        expect(s.currentWindowStart!.getTime()).toBe(CS + 3 * WEEK_MS);
        expect(s.currentWindowEnd!.getTime()).toBe(CS + 4 * WEEK_MS);
        // ceil((28d - 23d)/1d) = 5
        expect(s.daysLeftInWindow).toBe(5);
        // no booking in [21d, 28d)
        expect(s.recordedThisWindow).toBe(false);
    });

    it('on-pace: one recording per elapsed week, no forfeiture', () => {
        // bookings at day 0, 7, 14; now = CS + 23 days => weeksElapsed = 3.
        const s = computeFlexState({
            total: 12,
            cycleStart,
            bookingDates: [day(0), day(7), day(14)],
            now: day(23),
        });
        expect(s.recordings).toBe(3);
        expect(s.weeksElapsed).toBe(3);
        // boundary = CS + 21d; all three bookings (day 0,7,14) are before it.
        expect(s.recordingsWithinElapsed).toBe(3);
        expect(s.shortfall).toBe(0); // max(0, 3 - 3)
        expect(s.currentWindowIndex).toBe(4);
        expect(s.daysLeftInWindow).toBe(5);
        // none of the bookings fall in the current window [21d, 28d)
        expect(s.recordedThisWindow).toBe(false);
    });

    it('at-risk: current window closing soon and not yet recorded', () => {
        // now = CS + 13.5 days. elapsedRaw = floor(13.5/7) = 1 -> window index 2.
        const s = computeFlexState({
            total: 12,
            cycleStart,
            bookingDates: [day(0)],
            now: new Date(CS + 13.5 * DAY_MS),
        });
        expect(s.weeksElapsed).toBe(1);
        // boundary = CS + 7d; day0 booking is before it.
        expect(s.recordingsWithinElapsed).toBe(1);
        expect(s.shortfall).toBe(0); // max(0, 1 - 1)
        expect(s.currentWindowIndex).toBe(2);
        expect(s.currentWindowStart!.getTime()).toBe(CS + WEEK_MS);
        expect(s.currentWindowEnd!.getTime()).toBe(CS + 2 * WEEK_MS);
        // ceil((14d - 13.5d)/1d) = ceil(0.5) = 1
        expect(s.daysLeftInWindow).toBe(1);
        // no booking in [7d, 14d)
        expect(s.recordedThisWindow).toBe(false);
    });

    it('recordedThisWindow true when a booking lands in the current window', () => {
        // now = CS + 13.5 days -> window [7d,14d); booking at day 8 is inside.
        const s = computeFlexState({
            total: 12,
            cycleStart,
            bookingDates: [day(0), day(8)],
            now: new Date(CS + 13.5 * DAY_MS),
        });
        expect(s.currentWindowIndex).toBe(2);
        expect(s.recordedThisWindow).toBe(true);
    });

    it('clamps weeksElapsed to total and ends the cycle after the last window', () => {
        // now = CS + 20 weeks, total 12 -> elapsedRaw = 20 (>= total).
        const s = computeFlexState({
            total: 12,
            cycleStart,
            bookingDates: [day(0)],
            now: new Date(CS + 20 * WEEK_MS),
        });
        expect(s.weeksElapsed).toBe(12); // min(total, 20)
        // boundary = CS + 12 weeks; day0 booking counts.
        expect(s.recordingsWithinElapsed).toBe(1);
        expect(s.shortfall).toBe(11); // max(0, 12 - 1)
        // cycle ended -> no current window
        expect(s.currentWindowIndex).toBeNull();
        expect(s.currentWindowStart).toBeNull();
        expect(s.currentWindowEnd).toBeNull();
        expect(s.daysLeftInWindow).toBeNull();
        expect(s.recordedThisWindow).toBe(false);
    });

    it('now before the cycle start: no windows elapsed, no current window', () => {
        // now = CS - 1 day. elapsedRaw = floor(-1/7) = -1.
        const s = computeFlexState({
            total: 12,
            cycleStart,
            bookingDates: [day(0)],
            now: day(-1),
        });
        expect(s.started).toBe(true);
        expect(s.weeksElapsed).toBe(0); // max(0, min(12, -1))
        // boundary = CS; day0 booking is not strictly before CS.
        expect(s.recordingsWithinElapsed).toBe(0);
        expect(s.shortfall).toBe(0);
        // elapsedRaw < 0 -> no current window
        expect(s.currentWindowIndex).toBeNull();
        expect(s.daysLeftInWindow).toBeNull();
        expect(s.recordedThisWindow).toBe(false);
    });

    it('exactly at a window boundary: daysLeftInWindow is a full week', () => {
        // now = CS + 7 days exactly. elapsedRaw = floor(7/7) = 1 -> window index 2.
        const s = computeFlexState({
            total: 12,
            cycleStart,
            bookingDates: [day(0), day(7)],
            now: day(7),
        });
        expect(s.weeksElapsed).toBe(1);
        // boundary = CS + 7d; only day0 is strictly before it (day7 is not < boundary).
        expect(s.recordingsWithinElapsed).toBe(1);
        expect(s.shortfall).toBe(0);
        expect(s.currentWindowIndex).toBe(2);
        expect(s.currentWindowStart!.getTime()).toBe(CS + WEEK_MS);
        // ceil((14d - 7d)/1d) = 7
        expect(s.daysLeftInWindow).toBe(7);
        // day7 booking sits at the start of window [7d,14d)
        expect(s.recordedThisWindow).toBe(true);
    });

    it('filters falsy booking dates and still counts real recordings', () => {
        const s = computeFlexState({
            total: 24,
            cycleStart,
            // @ts-expect-error exercising the .filter(Boolean) guard
            bookingDates: [day(0), null, undefined, day(10)],
            now: day(1),
        });
        expect(s.recordings).toBe(2);
        expect(s.total).toBe(24);
    });
});

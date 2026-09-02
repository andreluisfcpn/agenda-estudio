import { describe, it, expect } from 'vitest';
import { acquireMultiSlotLock, releaseMultiSlotLock } from '../../src/lib/redis';
import { hasBlockedConflict } from '../../src/modules/bookings/booking.service';
import { mkUser, mkBlockedSlot } from './factories';

const DATE = '2026-09-15';

describe('acquireMultiSlotLock — double-booking prevention (Redis, B1/B3)', () => {
    it('two different users cannot both hold overlapping slots', async () => {
        const a = 'userA';
        const b = 'userB';
        const okA = await acquireMultiSlotLock(DATE, ['14:00', '14:30'], a);
        expect(okA).toBe(true);

        // B wants ['14:30','15:00'] — 14:30 is held by A → must fail, and must NOT
        // leave 15:00 half-locked (the rollback in acquireMultiSlotLock).
        const okB = await acquireMultiSlotLock(DATE, ['14:30', '15:00'], b);
        expect(okB).toBe(false);

        // Because B rolled back, 15:00 is free: a third acquire on 15:00 succeeds.
        const okC = await acquireMultiSlotLock(DATE, ['15:00'], b);
        expect(okC).toBe(true);

        await releaseMultiSlotLock(DATE, ['14:00', '14:30'], a);
        await releaseMultiSlotLock(DATE, ['15:00'], b);
    });

    it('a slot becomes acquirable again after the holder releases it', async () => {
        const a = 'ownerA';
        const b = 'ownerB';
        expect(await acquireMultiSlotLock(DATE, ['18:00'], a)).toBe(true);
        expect(await acquireMultiSlotLock(DATE, ['18:00'], b)).toBe(false);

        await releaseMultiSlotLock(DATE, ['18:00'], a);
        expect(await acquireMultiSlotLock(DATE, ['18:00'], b)).toBe(true);
        await releaseMultiSlotLock(DATE, ['18:00'], b);
    });

    it('concurrent acquires of the same slot: exactly one wins', async () => {
        const results = await Promise.all(
            Array.from({ length: 8 }, (_, i) => acquireMultiSlotLock(DATE, ['20:30'], `u${i}`)),
        );
        expect(results.filter(Boolean).length).toBe(1);
        // release for whoever won (release is owner-scoped, harmless for the losers)
        await Promise.all(Array.from({ length: 8 }, (_, i) => releaseMultiSlotLock(DATE, ['20:30'], `u${i}`)));
    });
});

describe('hasBlockedConflict — reservations must respect BlockedSlot (B1)', () => {
    it('detects a package that overlaps a blocked range and clears a free one', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        await mkBlockedSlot(admin.id, { startTime: '14:00', endTime: '16:00' });
        const dateObj = new Date(DATE + 'T00:00:00Z');

        // 14:00–16:00 expands to {14:00,14:30,15:00,15:30}
        expect(await hasBlockedConflict(dateObj, ['14:00'])).toBe(true);
        expect(await hasBlockedConflict(dateObj, ['15:30'])).toBe(true);
        expect(await hasBlockedConflict(dateObj, ['13:30', '14:00'])).toBe(true); // any overlap
        // 16:00 is the exclusive end → NOT blocked; 18:00 is unrelated
        expect(await hasBlockedConflict(dateObj, ['16:00'])).toBe(false);
        expect(await hasBlockedConflict(dateObj, ['18:00'])).toBe(false);
    });

    it('returns false when there is no block on that date', async () => {
        const dateObj = new Date('2026-09-16T00:00:00Z');
        expect(await hasBlockedConflict(dateObj, ['14:00'])).toBe(false);
    });
});

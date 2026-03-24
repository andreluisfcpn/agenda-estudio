import Redis from 'ioredis';
import { config } from '../config';

export const redis = new Redis(config.redis.url);

// ─── Distributed Lock for Booking Slots ─────────────────

const LOCK_PREFIX = 'booking:lock';

function makeLockKey(date: string, startTime: string): string {
    return `${LOCK_PREFIX}:${date}:${startTime}`;
}

/**
 * Acquire a distributed lock for a time slot.
 * Uses SET NX EX for atomic lock acquisition.
 * @returns true if lock acquired, false if slot already locked
 */
export async function acquireLock(
    date: string,
    startTime: string,
    userId: string,
    ttl: number = config.studio.lockTtlSeconds
): Promise<boolean> {
    const key = makeLockKey(date, startTime);
    const result = await redis.set(key, userId, 'EX', ttl, 'NX');
    return result === 'OK';
}

/**
 * Release a lock only if the current user holds it.
 * Uses a Lua script for atomic check-and-delete.
 */
export async function releaseLock(
    date: string,
    startTime: string,
    userId: string
): Promise<boolean> {
    const key = makeLockKey(date, startTime);
    const script = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;
    const result = await redis.eval(script, 1, key, userId);
    return result === 1;
}

/**
 * Check who holds the lock on a slot.
 * @returns userId if locked, null otherwise
 */
export async function checkLock(
    date: string,
    startTime: string
): Promise<string | null> {
    const key = makeLockKey(date, startTime);
    return redis.get(key);
}

/**
 * Acquire locks for multiple consecutive slots (2h package = 4 slots).
 * All-or-nothing: if any slot fails, release all acquired locks.
 */
export async function acquireMultiSlotLock(
    date: string,
    slots: string[],
    userId: string,
    ttl: number = config.studio.lockTtlSeconds
): Promise<boolean> {
    const acquiredSlots: string[] = [];

    for (const slot of slots) {
        const acquired = await acquireLock(date, slot, userId, ttl);
        if (!acquired) {
            // Rollback: release all previously acquired locks
            for (const acquiredSlot of acquiredSlots) {
                await releaseLock(date, acquiredSlot, userId);
            }
            return false;
        }
        acquiredSlots.push(slot);
    }
    return true;
}

/**
 * Release locks for multiple slots.
 */
export async function releaseMultiSlotLock(
    date: string,
    slots: string[],
    userId: string
): Promise<void> {
    for (const slot of slots) {
        await releaseLock(date, slot, userId);
    }
}

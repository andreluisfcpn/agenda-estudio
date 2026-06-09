import { customAlphabet } from 'nanoid';
import { redis } from './redis.js';

const OTP_EXPIRY_SECONDS = 5 * 60; // 5 minutes
const OTP_PREFIX = 'otp:';
const OTP_FAIL_PREFIX = 'otp:fail:';
const OTP_COOLDOWN_PREFIX = 'otp:cooldown:';
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_SECONDS = 30 * 60; // 30 minutes lockout after max failures
const SEND_COOLDOWN_SECONDS = 30; // anti-spam: min interval between sends to the same target

/**
 * Persist an OTP security event to the AuditLog so failed-attempt/lockout history survives a
 * Redis flush/restart and is queryable for brute-force detection (Redis still drives the live
 * rate-limit; this is the durable audit trail). Best-effort — never blocks verification.
 */
async function logOtpEvent(target: string, action: string, attempt: number): Promise<void> {
    try {
        const { logAudit } = await import('./audit.js');
        await logAudit('OTP', target, action, 'SYSTEM', { attempt, max: MAX_FAILED_ATTEMPTS });
    } catch { /* audit is best-effort */ }
}

export const otpService = {
    /**
     * Generate a 6-digit code and deliver it by e-mail via the configured provider.
     * Delivers FIRST, then persists the code + cooldown — so a send failure (e.g.
     * provider misconfigured in prod) leaves no orphan code and doesn't block retry.
     */
    async generateAndSend(target: string, name: string): Promise<void> {
        const code = customAlphabet('0123456789', 6)();
        const { deliverOtpEmail } = await import('./email.js');
        await deliverOtpEmail(target, name, code); // throws on misconfiguration (prod)

        await redis.set(`${OTP_PREFIX}${target}`, code, 'EX', OTP_EXPIRY_SECONDS);
        await redis.set(`${OTP_COOLDOWN_PREFIX}${target}`, '1', 'EX', SEND_COOLDOWN_SECONDS);
        // AUTH-M1: do NOT reset the failure counter on new code generation.
    },

    async verify(target: string, code: string): Promise<boolean> {
        // VULN-10 FIX: Check if locked out from too many failed attempts
        const failKey = `${OTP_FAIL_PREFIX}${target}`;
        const failCount = parseInt(await redis.get(failKey) || '0', 10);

        if (failCount >= MAX_FAILED_ATTEMPTS) {
            console.warn(`[OTP] Target ${target} is locked out (${failCount} failed attempts)`);
            void logOtpEvent(target, 'LOCKED_OUT', failCount);
            return false;
        }

        const key = `${OTP_PREFIX}${target}`;
        const stored = await redis.get(key);

        if (!stored) return false;

        if (stored === code) {
            await redis.del(key); // Single use — delete after verification
            await redis.del(failKey); // Reset failure counter on success
            return true;
        }

        // Increment failure counter with lockout TTL
        const newCount = await redis.incr(failKey);
        if (newCount === 1) {
            await redis.expire(failKey, LOCKOUT_SECONDS);
        }

        console.warn(`[OTP] Failed attempt ${newCount}/${MAX_FAILED_ATTEMPTS} for ${target}`);
        void logOtpEvent(target, 'FAILED_ATTEMPT', newCount);
        return false;
    },

    async isLockedOut(target: string): Promise<boolean> {
        const failKey = `${OTP_FAIL_PREFIX}${target}`;
        const failCount = parseInt(await redis.get(failKey) || '0', 10);
        return failCount >= MAX_FAILED_ATTEMPTS;
    },

    /** True if a code was sent to this target within the resend cooldown window. */
    async isOnSendCooldown(target: string): Promise<boolean> {
        return (await redis.get(`${OTP_COOLDOWN_PREFIX}${target}`)) !== null;
    }
};

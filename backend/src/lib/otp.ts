import { customAlphabet } from 'nanoid';
import { redis } from './redis.js';

const OTP_EXPIRY_SECONDS = 5 * 60; // 5 minutes
const OTP_PREFIX = 'otp:';
const OTP_FAIL_PREFIX = 'otp:fail:';
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_SECONDS = 30 * 60; // 30 minutes lockout after max failures

export const otpService = {
    async generateAndSendMock(target: string, name: string): Promise<void> {
        // Generate a 6-digit numeric code
        const generateCode = customAlphabet('0123456789', 6);
        const code = generateCode();

        // Store in Redis with TTL (replaces in-memory Map)
        const key = `${OTP_PREFIX}${target}`;
        await redis.set(key, code, 'EX', OTP_EXPIRY_SECONDS);

        // Reset failure counter when a new code is generated
        await redis.del(`${OTP_FAIL_PREFIX}${target}`);

        const isEmail = target.includes('@');

        // Simulate sending SMS/WhatsApp or Email. Note: In reality we'd hook up an API provider here.
        console.log(`\n\n======================================================`);
        console.log(`📡 MOCK ${isEmail ? 'EMAIL' : 'SMS'} SENT`);
        console.log(`To: ${name} (${target})`);
        console.log(`Message: Seu código de confirmação da Búzios Digital é: ${code}`);
        console.log(`======================================================\n\n`);
    },

    async verify(target: string, code: string): Promise<boolean> {
        // VULN-10 FIX: Check if locked out from too many failed attempts
        const failKey = `${OTP_FAIL_PREFIX}${target}`;
        const failCount = parseInt(await redis.get(failKey) || '0', 10);

        if (failCount >= MAX_FAILED_ATTEMPTS) {
            console.warn(`[OTP] Target ${target} is locked out (${failCount} failed attempts)`);
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
        return false;
    },

    async isLockedOut(target: string): Promise<boolean> {
        const failKey = `${OTP_FAIL_PREFIX}${target}`;
        const failCount = parseInt(await redis.get(failKey) || '0', 10);
        return failCount >= MAX_FAILED_ATTEMPTS;
    }
};

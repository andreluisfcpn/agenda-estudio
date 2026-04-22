import { customAlphabet } from 'nanoid';
import { redis } from './redis.js';

const OTP_EXPIRY_SECONDS = 5 * 60; // 5 minutes
const OTP_PREFIX = 'otp:';

export const otpService = {
    async generateAndSendMock(target: string, name: string): Promise<void> {
        // Generate a 6-digit numeric code
        const generateCode = customAlphabet('0123456789', 6);
        const code = generateCode();

        // Store in Redis with TTL (replaces in-memory Map)
        const key = `${OTP_PREFIX}${target}`;
        await redis.set(key, code, 'EX', OTP_EXPIRY_SECONDS);

        const isEmail = target.includes('@');

        // Simulate sending SMS/WhatsApp or Email. Note: In reality we'd hook up an API provider here.
        console.log(`\n\n======================================================`);
        console.log(`📡 MOCK ${isEmail ? 'EMAIL' : 'SMS'} SENT`);
        console.log(`To: ${name} (${target})`);
        console.log(`Message: Seu código de confirmação da Búzios Digital é: ${code}`);
        console.log(`======================================================\n\n`);
    },

    async verify(target: string, code: string): Promise<boolean> {
        const key = `${OTP_PREFIX}${target}`;
        const stored = await redis.get(key);

        if (!stored) return false;

        if (stored === code) {
            await redis.del(key); // Single use — delete after verification
            return true;
        }

        return false;
    }
};

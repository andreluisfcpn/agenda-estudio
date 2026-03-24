import { customAlphabet } from 'nanoid';

// In-memory mock map. Key: target (email or phone), Value: { code, expiresAt }
// For production, this should be moved to Redis or similar to support multi-instance deployment.
const otpStore = new Map<string, { code: string; expiresAt: number }>();

const OTP_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

export const otpService = {
    async generateAndSendMock(target: string, name: string): Promise<void> {
        // Generate a 6-digit numeric code
        const generateCode = customAlphabet('0123456789', 6);
        const code = generateCode();

        const expiresAt = Date.now() + OTP_EXPIRY_MS;
        otpStore.set(target, { code, expiresAt });

        const isEmail = target.includes('@');

        // Simulate sending SMS/WhatsApp or Email. Note: In reality we'd hook up an API provider here.
        console.log(`\n\n======================================================`);
        console.log(`📡 MOCK ${isEmail ? 'EMAIL' : 'SMS'} SENT`);
        console.log(`To: ${name} (${target})`);
        console.log(`Message: Seu código de confirmação da Búzios Digital é: ${code}`);
        console.log(`======================================================\n\n`);
    },

    async verify(target: string, code: string): Promise<boolean> {
        const stored = otpStore.get(target);

        if (!stored) return false;

        if (Date.now() > stored.expiresAt) {
            otpStore.delete(target); // Cleanup expired
            return false;
        }

        if (stored.code === code) {
            otpStore.delete(target); // Single use
            return true;
        }

        return false;
    }
};


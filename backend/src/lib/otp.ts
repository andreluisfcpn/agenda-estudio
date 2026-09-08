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
        // B21: reivindica o cooldown ATOMICAMENTE (SET NX) ANTES de enviar — evita que sends
        // concorrentes furem o throttle de 30s (get-then-set não-atômico deixava todos passarem).
        // Lança OTP_COOLDOWN quando já há um send recente; o chamador mapeia para 429.
        const cooldownKey = `${OTP_COOLDOWN_PREFIX}${target}`;
        const claimed = await redis.set(cooldownKey, '1', 'EX', SEND_COOLDOWN_SECONDS, 'NX');
        if (claimed !== 'OK') {
            const err = new Error('OTP_COOLDOWN') as Error & { code?: string };
            err.code = 'OTP_COOLDOWN';
            throw err;
        }
        try {
            const code = customAlphabet('0123456789', 6)();
            const { deliverOtpEmail } = await import('./email.js');
            await deliverOtpEmail(target, name, code); // throws on misconfiguration (prod)
            await redis.set(`${OTP_PREFIX}${target}`, code, 'EX', OTP_EXPIRY_SECONDS);
            // AUTH-M1: do NOT reset the failure counter on new code generation.
        } catch (e) {
            // Falha de entrega/persistência: libera o cooldown para não bloquear retry legítimo
            // (mantém a intenção original de "não orfanizar o código nem travar o reenvio").
            await redis.del(cooldownKey).catch(() => {});
            throw e;
        }
    },

    async verify(target: string, code: string): Promise<boolean> {
        // B20: checagem-de-lockout + comparação + incremento ATÔMICOS (Lua). Antes eram statements
        // separados por awaits, então palpites concorrentes liam o contador stale e furavam o teto por
        // alvo (MAX_FAILED_ATTEMPTS). Agora o incremento é a fonte da verdade, num único round-trip.
        const failKey = `${OTP_FAIL_PREFIX}${target}`;
        const key = `${OTP_PREFIX}${target}`;
        const script = `
          local fail = tonumber(redis.call('get', KEYS[2]) or '0')
          if fail >= tonumber(ARGV[2]) then return {-1, fail} end
          local stored = redis.call('get', KEYS[1])
          if not stored then return {0, fail} end
          if stored == ARGV[1] then
            redis.call('del', KEYS[1])
            redis.call('del', KEYS[2])
            return {1, 0}
          end
          local n = redis.call('incr', KEYS[2])
          if n == 1 then redis.call('expire', KEYS[2], tonumber(ARGV[3])) end
          return {2, n}
        `;
        const [status, count] = await redis.eval(
            script, 2, key, failKey, code, String(MAX_FAILED_ATTEMPTS), String(LOCKOUT_SECONDS),
        ) as [number, number];

        if (status === 1) return true;
        if (status === -1) {
            console.warn(`[OTP] Target ${target} is locked out (${count} failed attempts)`);
            void logOtpEvent(target, 'LOCKED_OUT', count);
            return false;
        }
        if (status === 2) {
            console.warn(`[OTP] Failed attempt ${count}/${MAX_FAILED_ATTEMPTS} for ${target}`);
            void logOtpEvent(target, 'FAILED_ATTEMPT', count);
        }
        return false; // status 0 = no active code
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

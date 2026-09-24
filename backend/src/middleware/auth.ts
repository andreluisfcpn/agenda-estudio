import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import { redis } from '../lib/redis.js';
import { Role } from '../generated/prisma/client.js';

// Extend Express Request type to include user info
declare global {
    namespace Express {
        interface Request {
            user?: {
                userId: string;
                email: string;
                role: Role;
            };
        }
    }
}

interface JwtPayload {
    userId: string;
    email: string;
    role: Role;
    /** Emissão (segundos desde epoch) — preenchido pelo jsonwebtoken. */
    iat?: number;
}

// ─── Revogação imediata de sessão (D3: excluir/bloquear cliente) ─────────
// O access token é um JWT sem estado (válido até 1h). Excluir ou bloquear um cliente precisa
// encerrar a sessão JÁ aberta, não só impedir o próximo refresh. Sem consulta ao banco por
// requisição: uma chave Redis por usuário guarda o instante da revogação (segundos) e vive o
// tempo de validade do access token — depois disso todo token anterior já expirou sozinho.
// O authenticate recusa (401) tokens emitidos até esse instante, e o POST /auth/refresh recusa
// refresh tokens emitidos até ele (senão, durante uma exclusão — deletedAt só é gravado no fim — o
// refresh emitiria um token novo que sobreviveria a ela; o LOGIN, pelo mesmo motivo, recusa enquanto a
// exclusão está em andamento — isUserDeletionInProgress). Um LOGIN legítimo posterior (ex.: cliente
// desbloqueado) emite tokens mais novos e passa normalmente; para conta excluída/bloqueada o próprio
// refresh/login já recusa pelo banco, então a sessão termina de vez.

const REVOKED_PREFIX = 'auth:revoked:';
/** Não deixa um Redis lento travar TODAS as requisições autenticadas (fail-open). */
const REVOCATION_CHECK_TIMEOUT_MS = 500;

const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86_400, w: 604_800 };

/** Validade do access token em segundos (config.jwt.accessExpiry: '1h', '15m', '3600'…). Fallback seguro: 24h. */
export function accessTokenTtlSeconds(expiry: string | number = config.jwt.accessExpiry): number {
    if (typeof expiry === 'number' && Number.isFinite(expiry) && expiry > 0) return Math.ceil(expiry);
    const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|w|weeks?)?\s*$/i.exec(String(expiry));
    if (!m) return 24 * 3600;
    const value = Number(m[1]);
    const unit = (m[2] ?? 's').toLowerCase();
    if (unit === 'ms') return Math.max(1, Math.ceil(value / 1000));
    const seconds = value * (UNIT_SECONDS[unit[0]] ?? 1);
    return seconds > 0 ? Math.ceil(seconds) : 24 * 3600;
}

/**
 * Encerra na hora as sessões abertas de `userId`: todo access token E refresh token emitido até
 * agora passa a ser recusado (authenticate → 401; POST /auth/refresh → 401). Best-effort: falha do
 * Redis só é logada (o refresh/login continuam recusando conta excluída ou bloqueada pelo banco).
 *
 * `graceSeconds` (só para conta que deixou de existir — exclusão concluída): estende a revogação
 * para tokens emitidos até N segundos DEPOIS de agora. Fecha a corrida de um login/refresh que leu
 * o usuário ANTES do commit da exclusão e assina o token um instante depois (bcrypt, Google…). Nunca
 * usar em bloqueio (um login legítimo após desbloquear seria recusado).
 */
export async function revokeUserSessions(userId: string, opts: { graceSeconds?: number } = {}): Promise<void> {
    try {
        const grace = Math.max(0, Math.floor(opts.graceSeconds ?? 0));
        const revokedAt = Math.floor(Date.now() / 1000) + grace;
        // Margem de 60s além da validade: cobre relógio/arredondamento do exp.
        await redis.set(`${REVOKED_PREFIX}${userId}`, String(revokedAt), 'EX', accessTokenTtlSeconds() + 60 + grace);
    } catch (err) {
        console.error(`[AUTH] Falha ao revogar as sessões de ${userId}:`, err instanceof Error ? err.message : err);
    }
}

/** Desfaz a revogação (ex.: a exclusão falhou e o cliente continua existindo). Best-effort. */
export async function clearUserSessionRevocation(userId: string): Promise<void> {
    try {
        await redis.del(`${REVOKED_PREFIX}${userId}`);
    } catch (err) {
        console.error(`[AUTH] Falha ao limpar a revogação de ${userId}:`, err instanceof Error ? err.message : err);
    }
}

/** Chave do mutex da exclusão de cliente (userDeletion.deleteUser) — o login também a consulta. */
export const userDeletionLockKey = (userId: string): string => `mutex:user-delete:${userId}`;

/**
 * true enquanto a exclusão de `userId` está em andamento (mutex de deleteUser). O login recusa nesse
 * intervalo: um token emitido no meio da exclusão (deletedAt só é gravado no fim) deixaria o cliente
 * criar reserva/cobrança depois do passo que as cancela. Fail-open (500 ms), como a revogação.
 */
export async function isUserDeletionInProgress(userId: string): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const n = await Promise.race([
            redis.exists(userDeletionLockKey(userId)),
            new Promise<number>((resolve) => { timer = setTimeout(() => resolve(0), REVOCATION_CHECK_TIMEOUT_MS); }),
        ]);
        return n > 0;
    } catch (err) {
        console.error('[AUTH] Checagem de exclusão em andamento indisponível (seguindo sem ela):', err instanceof Error ? err.message : err);
        return false;
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/**
 * true se o token (access OU refresh, emitido em `iat`) foi revogado por revokeUserSessions.
 * Em falha/lentidão do Redis: false (fail-open).
 */
export async function isTokenRevoked(userId: string, iat: number | undefined): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const raw = await Promise.race([
            redis.get(`${REVOKED_PREFIX}${userId}`),
            new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), REVOCATION_CHECK_TIMEOUT_MS); }),
        ]);
        if (!raw) return false;
        const revokedAt = Number(raw);
        if (!Number.isFinite(revokedAt)) return true;
        // Sem iat não há como provar que o token é posterior → recusa.
        return typeof iat !== 'number' || iat <= revokedAt;
    } catch (err) {
        console.error('[AUTH] Checagem de revogação indisponível (seguindo sem ela):', err instanceof Error ? err.message : err);
        return false;
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/**
 * Authenticate middleware: validates JWT from HttpOnly cookie and refuses revoked sessions
 * (cliente excluído/bloqueado — ver revokeUserSessions).
 */
export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
    const token = req.cookies?.accessToken;

    if (!token) {
        res.status(401).json({ error: 'Autenticação necessária. Faça login.' });
        return;
    }

    let decoded: JwtPayload;
    try {
        // Pin the algorithm to prevent algorithm-confusion attacks (e.g. 'none' / RS↔HS).
        decoded = jwt.verify(token, config.jwt.secret, { algorithms: ['HS256'] }) as JwtPayload;
    } catch {
        res.status(401).json({ error: 'Token inválido ou expirado.' });
        return;
    }

    if (await isTokenRevoked(decoded.userId, decoded.iat)) {
        res.status(401).json({ error: 'Sessão encerrada. Faça login novamente.' });
        return;
    }

    req.user = {
        userId: decoded.userId,
        email: decoded.email,
        role: decoded.role,
    };
    next();
}

/**
 * Authorization middleware: checks if user has one of the allowed roles.
 */
export function authorize(...allowedRoles: Role[]) {
    return (req: Request, res: Response, next: NextFunction): void => {
        if (!req.user) {
            res.status(401).json({ error: 'Autenticação necessária.' });
            return;
        }

        if (!allowedRoles.includes(req.user.role)) {
            res.status(403).json({ error: 'Acesso negado. Permissão insuficiente.' });
            return;
        }

        next();
    };
}

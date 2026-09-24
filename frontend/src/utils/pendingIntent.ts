import { studioSlotDate } from './time';

// ─── Intenção pendente da landing (D16) ─────────────────────────────────────
// O visitante escolhe dia/hora na agenda pública da landing e só depois entra/cria a conta.
// A escolha fica em sessionStorage (por aba; não vaza entre abas/usuários do aparelho) com
// versão e TTL de 30 min. Quem decide o destino pós-login é o guard de rota de App.tsx
// (getPostLoginPath — fonte única, sem corrida com navigate do modal); a CalendarPage lê a
// intenção uma vez, retoma o horário e a limpa. Admin nunca retoma; "Área do Cliente" e o
// logout descartam. Todo acesso ao storage é tolerante a falha (modo privado, cota, SSR).

export const PENDING_INTENT_KEY = 'pendingIntent';
/** Chave antiga ({date,time} sem TTL) — só é apagada. */
const LEGACY_KEY = 'pendingBooking';
export const PENDING_INTENT_TTL_MS = 30 * 60 * 1000;
const VERSION = 1;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Horário escolhido na agenda pública. Extensível para 'contract'/'service' (nova `kind`). */
export interface PendingBookingIntent {
    v: typeof VERSION;
    kind: 'booking';
    /** 'YYYY-MM-DD' (data do estúdio, fuso SP). */
    date: string;
    /** 'HH:MM'. */
    time: string;
    /** Faixa do horário (COMERCIAL/AUDIENCIA/SABADO) — informativa; a agenda revalida. */
    tier?: string | null;
    /** epoch ms da escolha. */
    createdAt: number;
}

export type PendingIntent = PendingBookingIntent;

function store(): Storage | null {
    try {
        return typeof window !== 'undefined' ? window.sessionStorage : null;
    } catch {
        return null;
    }
}

/** Guarda a escolha (substitui qualquer intenção anterior e remove a chave legada). */
export function savePendingIntent(intent: { kind: 'booking'; date: string; time: string; tier?: string | null }): void {
    if (!DATE_RE.test(intent.date) || !TIME_RE.test(intent.time)) return;
    const value: PendingBookingIntent = {
        v: VERSION,
        kind: 'booking',
        date: intent.date,
        time: intent.time,
        tier: intent.tier ? String(intent.tier).toUpperCase() : null,
        createdAt: Date.now(),
    };
    const s = store();
    if (!s) return;
    try {
        s.setItem(PENDING_INTENT_KEY, JSON.stringify(value));
        s.removeItem(LEGACY_KEY);
    } catch { /* storage cheio/bloqueado: segue sem retomar */ }
}

/**
 * Lê a intenção SEM efeito colateral (é chamada durante o render do guard de rota).
 * Devolve null se ausente, JSON inválido, versão/formato errado, mais velha que o TTL
 * ou se o horário já passou (fuso SP).
 */
export function peekPendingIntent(now: number = Date.now()): PendingIntent | null {
    const s = store();
    if (!s) return null;
    let raw: string | null = null;
    try {
        raw = s.getItem(PENDING_INTENT_KEY);
    } catch {
        return null;
    }
    if (!raw) return null;
    try {
        const p = JSON.parse(raw) as Partial<PendingBookingIntent> | null;
        if (!p || typeof p !== 'object') return null;
        if (p.v !== VERSION || p.kind !== 'booking') return null;
        if (typeof p.date !== 'string' || !DATE_RE.test(p.date)) return null;
        if (typeof p.time !== 'string' || !TIME_RE.test(p.time)) return null;
        if (typeof p.createdAt !== 'number' || !Number.isFinite(p.createdAt)) return null;
        // TTL (tolerância de 1 min para relógio adiantado na gravação).
        if (now - p.createdAt > PENDING_INTENT_TTL_MS || p.createdAt - now > 60_000) return null;
        const startsAt = studioSlotDate(p.date, p.time).getTime();
        if (!Number.isFinite(startsAt) || startsAt <= now) return null;
        return {
            v: VERSION,
            kind: 'booking',
            date: p.date,
            time: p.time,
            tier: typeof p.tier === 'string' && p.tier ? p.tier : null,
            createdAt: p.createdAt,
        };
    } catch {
        return null;
    }
}

/** Descarta a intenção (e a chave legada). */
export function clearPendingIntent(): void {
    const s = store();
    if (!s) return;
    try {
        s.removeItem(PENDING_INTENT_KEY);
        s.removeItem(LEGACY_KEY);
    } catch { /* ignore */ }
}

/** Destino pós-login: cliente com intenção válida retoma na agenda; o resto vai ao painel. */
export function getPostLoginPath(user: { role?: string | null } | null | undefined): string {
    return user?.role === 'CLIENTE' && peekPendingIntent() ? '/calendar' : '/dashboard';
}

const WEEKDAY_SHORT = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

/** "Qui, 25/09 às 18:00" (dia da semana calculado da data civil, sem depender do fuso do aparelho). */
export function formatIntentSlot(intent: Pick<PendingIntent, 'date' | 'time'>): string {
    const [y, m, d] = intent.date.split('-').map(Number);
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    return `${WEEKDAY_SHORT[dow]}, ${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')} às ${intent.time}`;
}

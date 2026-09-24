// ─── Agenda dos lembretes de sessão (24h / 2h) — lógica PURA ────────────────
// Sem prisma/redis: o job (jobs/bookingReminderJob.ts) busca as sessões e o last-run e delega aqui a
// decisão de "este lembrete vence nesta execução?". Testado em test/booking-reminder-schedule.test.ts.
//
// Regras (decisão do dono D14, set/2026):
//  - 24h: EXATAMENTE 24h antes (mesmo horário, na véspera), rótulo "amanhã (DD/MM)".
//  - 2h:  EXATAMENTE 2h antes, rótulo "hoje (DD/MM)".
//  - Cada execução cobre o intervalo (última execução, agora]; um lembrete é enviado quando o seu
//    instante de vencimento (início − antecedência) cai nesse intervalo. O job roda a cada 1 min.
//  - Catch-up: após uma queda, recupera no máximo MAX_CATCHUP_MS (60 min) de vencimentos; mais antigos
//    são pulados. Sem last-run registrado (primeiro deploy / flush do Redis) só o último minuto — nunca
//    reenvia em massa. O last-run vive dias no Redis (queda de horas ainda tem o catch-up de 60 min).
//  - Pago depois do vencimento: sessão marcada com antecedência cuja contratação só foi paga DEPOIS do
//    vencimento do 24h (ficou de fora porque o contrato estava AWAITING_PAYMENT) recebe o 24h no momento
//    em que o pagamento é visto, se ainda for véspera, faltar mais de 2h e o vencimento tiver ≤ 60 min.
//  - Sessão marcada (createdAt) DEPOIS do vencimento — ou seja, com menos de 24h/2h de antecedência —
//    não recebe aquele lembrete (nunca sai atrasado por isso).
//  - O dia SP da sessão precisa bater com a janela (24h → amanhã, 2h → hoje): um lembrete de 24h nunca
//    diz "hoje" e o de 2h nunca diz "amanhã".

import { studioDateTime } from '../utils/pricing.js';
import { spDayLabel, spDaysFromToday } from './spTime.js';

/** Intervalo nominal entre execuções do job (alinhado ao minuto em index.ts). */
export const TICK_MS = 60_000;
/** Teto de recuperação após queda: vencimentos mais antigos que isso são pulados. */
export const MAX_CATCHUP_MS = 60 * 60_000;

export interface ReminderWindow {
    /** Compõe a dedupKey `reminder:<label>:<bookingId>:<YYYY-MM-DD>` (formato mantido do job antigo). */
    label: '24h' | '2h';
    eventKey: 'booking_reminder_24h' | 'booking_reminder_2h';
    /** Antecedência do lembrete em relação ao início da sessão. */
    offsetMs: number;
    /** Distância em dias no calendário SP entre "agora" e a data da sessão (1 = amanhã, 0 = hoje). */
    spDayDiff: 0 | 1;
}

export const REMINDER_WINDOWS: readonly ReminderWindow[] = [
    { label: '24h', eventKey: 'booking_reminder_24h', offsetMs: 24 * 3_600_000, spDayDiff: 1 },
    { label: '2h', eventKey: 'booking_reminder_2h', offsetMs: 2 * 3_600_000, spDayDiff: 0 },
];

export interface ReminderScanRange {
    /** Exclusivo. */
    fromMs: number;
    /** Inclusivo (= agora). */
    toMs: number;
}

/**
 * Last-run à frente de `now` além desta folga não é relógio divergente entre instâncias — é lixo (ex.: um
 * `runBookingReminderJob(now)` manual com data futura no Redis compartilhado) e é tratado como ausente.
 * Como o last-run tem TTL longo (dias, para o catch-up sobreviver a quedas longas), sem isto ele travaria
 * os lembretes por dias.
 */
export const MAX_LAST_RUN_SKEW_MS = 5 * 60_000;

/** Last-run utilizável: null quando ausente, inválido ou no futuro além de MAX_LAST_RUN_SKEW_MS. */
export function effectiveLastRun(nowMs: number, lastRunMs: number | null): number | null {
    if (lastRunMs == null || !Number.isFinite(lastRunMs)) return null;
    if (lastRunMs > nowMs + MAX_LAST_RUN_SKEW_MS) return null;
    return lastRunMs;
}

/**
 * Intervalo (fromMs, toMs] de vencimentos que esta execução deve cobrir.
 *  - sem last-run (null/inválido/muito no futuro): só o último tick — sem catch-up;
 *  - com last-run: desde ele, limitado a MAX_CATCHUP_MS atrás.
 * Se o last-run estiver um pouco no futuro (relógios divergentes, ≤ MAX_LAST_RUN_SKEW_MS), o intervalo
 * fica vazio (fromMs >= toMs).
 */
export function reminderScanRange(nowMs: number, lastRunMs: number | null): ReminderScanRange {
    const last = effectiveLastRun(nowMs, lastRunMs);
    const fromMs = last != null ? Math.max(last, nowMs - MAX_CATCHUP_MS) : nowMs - TICK_MS;
    return { fromMs, toMs: nowMs };
}

/** Instante (UTC) de início da sessão: booking.date (@db.Date 00:00Z = dia SP) + startTime no fuso SP. */
export function bookingStartMs(date: Date, startTime: string): number {
    return studioDateTime(date.toISOString().slice(0, 10), startTime).getTime();
}

export interface ReminderBooking {
    date: Date;
    startTime: string;
    createdAt: Date;
}

export type ReminderSkipReason =
    | 'fora-da-janela'          // o vencimento não cai em (fromMs, toMs]
    | 'ja-comecou'              // a sessão já começou
    | 'marcada-apos-vencimento' // criada com menos antecedência que a do lembrete
    | 'dia-sp';                 // o dia SP não bate com a janela (24h → amanhã, 2h → hoje)

export type ReminderDecision =
    | { send: true; label: string; dueMs: number }
    | { send: false; reason: ReminderSkipReason };

/** Decide se o lembrete `window` da sessão vence nesta execução e com qual rótulo de dia. */
export function evaluateReminder(
    booking: ReminderBooking,
    window: ReminderWindow,
    range: ReminderScanRange,
    now: Date,
): ReminderDecision {
    const startMs = bookingStartMs(booking.date, booking.startTime);
    const dueMs = startMs - window.offsetMs;
    if (!(dueMs > range.fromMs && dueMs <= range.toMs)) return { send: false, reason: 'fora-da-janela' };
    if (startMs <= now.getTime()) return { send: false, reason: 'ja-comecou' };
    if (booking.createdAt.getTime() > dueMs) return { send: false, reason: 'marcada-apos-vencimento' };
    if (spDaysFromToday(booking.date, now) !== window.spDayDiff) return { send: false, reason: 'dia-sp' };
    return { send: true, label: spDayLabel(booking.date, now), dueMs };
}

/** Folga mínima até a sessão para ainda mandar o 24h de uma contratação paga depois do vencimento. */
export const LATE_PAID_MIN_LEAD_MS = 2 * 3_600_000;

export type LatePaidDecision =
    | { send: true; label: string; dueMs: number }
    | { send: false; reason: ReminderSkipReason | 'pago-antes-do-vencimento' | 'sem-pagamento-apos-vencimento' | 'menos-de-2h' };

/**
 * 24h de uma sessão marcada COM antecedência (createdAt ≤ vencimento) cuja contratação só foi PAGA depois
 * do vencimento — no minuto do vencimento o contrato ainda estava AWAITING_PAYMENT e o job a pulou.
 * `paidAtMs` = instantes dos pagamentos PAID do contrato; `lookbackToMs` = início (exclusivo) do intervalo
 * da execução normal (os vencimentos dali em diante são dela). Envia quando:
 *  - o vencimento caiu em (now − MAX_CATCHUP_MS, lookbackToMs] (teto de catch-up da D14);
 *  - as regras normais valem (marcada antes do vencimento, não começou, véspera no calendário SP);
 *  - nenhum pagamento até o vencimento e algum depois (estava aguardando pagamento no vencimento —
 *    quem já estava pago recebeu no vencimento);
 *  - ainda faltam mais de 2h para a sessão (senão o que vale é o lembrete de 2h).
 */
export function evaluateLatePaidDayBefore(
    booking: ReminderBooking,
    paidAtMs: number[],
    lookbackToMs: number,
    now: Date,
): LatePaidDecision {
    const window = REMINDER_WINDOWS.find(w => w.label === '24h')!;
    const nowMs = now.getTime();
    const base = evaluateReminder(booking, window, { fromMs: nowMs - MAX_CATCHUP_MS, toMs: lookbackToMs }, now);
    if (!base.send) return base;
    if (paidAtMs.some(t => t <= base.dueMs)) return { send: false, reason: 'pago-antes-do-vencimento' };
    if (!paidAtMs.some(t => t > base.dueMs)) return { send: false, reason: 'sem-pagamento-apos-vencimento' };
    if (bookingStartMs(booking.date, booking.startTime) - nowMs <= LATE_PAID_MIN_LEAD_MS) return { send: false, reason: 'menos-de-2h' };
    return base;
}

import { prisma } from '../lib/prisma.js';
import { redis } from '../lib/redis.js';
import { notifyEvent } from '../modules/notifications/notificationService.js';
import { saoPauloParts, spDdMm } from '../lib/spTime.js';
import {
    REMINDER_WINDOWS, MAX_CATCHUP_MS, evaluateReminder, evaluateLatePaidDayBefore, effectiveLastRun, reminderScanRange,
    type ReminderScanRange,
} from '../lib/bookingReminderSchedule.js';

/** Instante (ms) até onde a última execução BEM-SUCEDIDA cobriu os vencimentos. */
export const REMINDER_LAST_RUN_KEY = 'cron:booking-reminder:last-run';
// TTL longo (dias): uma queda de horas ainda recupera os últimos 60 min de vencimentos (o teto é o
// MAX_CATCHUP_MS, não o TTL). Primeiro deploy / flush do Redis continuam sem catch-up (chave ausente) e
// um last-run lixo no futuro é ignorado (effectiveLastRun).
const LAST_RUN_TTL_S = 7 * 24 * 3600;
const DAY_MS = 86_400_000;
/** Pagamentos vistos até esta folga ANTES do intervalo da execução ainda disparam o 24h tardio (corrida
 *  entre gravar o PAID e ativar o contrato). A dedupKey impede duplicidade nas execuções repetidas. */
const LATE_PAID_SLACK_MS = 2 * 60_000;

/** Meia-noite UTC do dia SP de um instante, deslocada `shiftDays` — casa com booking.date (@db.Date 00:00Z). */
function spDayUtc(ms: number, shiftDays: number): Date {
    const sp = saoPauloParts(new Date(ms));
    return new Date(Date.UTC(sp.y, sp.m - 1, sp.day) + shiftDays * DAY_MS);
}

/**
 * Booking Reminder Job — roda a cada 1 min, alinhado ao minuto (index.ts), + 1x no boot.
 *
 * Decisão do dono D14 (set/2026) — reverte o "nunca amanhã" do commit 9ae210f:
 *  - 24h: exatamente 24h antes (mesmo horário, na véspera) com "amanhã (DD/MM)";
 *  - 2h:  exatamente 2h antes com "hoje (DD/MM)";
 *  - sessão marcada com menos antecedência que a do lembrete não o recebe;
 *  - catch-up de no máximo 60 min após queda (a decisão pura mora em lib/bookingReminderSchedule.ts).
 *
 * Cada execução cobre os vencimentos em (last-run, now]. O last-run (REMINDER_LAST_RUN_KEY) só avança
 * quando NENHUMA sessão/consulta falhou — se algo falhar, o próximo tick reprocessa o intervalo (com teto
 * de 60 min) e a dedupKey impede duplicidade.
 *
 * dedupKey `reminder:<24h|2h>:<bookingId>:<YYYY-MM-DD>`: MESMO formato do job antigo (de propósito), para
 * que o deploy não reenvie lembretes que o job antigo já mandou (até 30 min adiantados). Cada janela tem a
 * sua chave — a chave padrão type+entity fazia o 24h (TTL 24h) engolir o 2h.
 *
 * @param now injetável para testes/execução manual.
 */
export async function runBookingReminderJob(now: Date = new Date()): Promise<void> {
    const nowMs = now.getTime();

    let lastRunMs: number | null = null;
    try {
        const raw = await redis.get(REMINDER_LAST_RUN_KEY);
        if (raw != null && Number.isFinite(Number(raw))) lastRunMs = Number(raw);
    } catch (err) {
        console.error('[REMINDER-JOB] Failed to read last-run (scanning only the last tick):', err);
    }

    lastRunMs = effectiveLastRun(nowMs, lastRunMs); // lixo muito no futuro = ausente (e é sobrescrito)
    const range = reminderScanRange(nowMs, lastRunMs);
    if (range.fromMs >= range.toMs) return; // last-run um pouco no futuro (relógio divergente) — nada vence ainda

    let totalSent = 0;
    let failures = 0;

    for (const window of REMINDER_WINDOWS) {
        let bookings: { id: string; userId: string; date: Date; startTime: string; createdAt: Date }[];
        try {
            // Sessões cujo INÍCIO cai em (from + antecedência, to + antecedência]. Pré-filtro por dia SP
            // (booking.date é o dia SP em 00:00Z) alargado ±1 dia (A11) — quem restringe de verdade é
            // evaluateReminder, pelo instante exato.
            bookings = await prisma.booking.findMany({
                where: {
                    status: { in: ['CONFIRMED', 'RESERVED'] },
                    // Contratação ainda não paga (personalizado/serviço do cliente, avulso em espera):
                    // as sessões RESERVED só seguram a agenda por ~10 min e somem se não pagar → sem lembrete.
                    contract: { status: { not: 'AWAITING_PAYMENT' } },
                    date: {
                        gte: spDayUtc(range.fromMs + window.offsetMs, -1),
                        lte: spDayUtc(range.toMs + window.offsetMs, +1),
                    },
                },
                select: { id: true, userId: true, date: true, startTime: true, createdAt: true },
            });
        } catch (err) {
            failures++;
            console.error(`[REMINDER-JOB] Failed to load bookings for the ${window.label} window:`, err);
            continue;
        }

        for (const booking of bookings) {
            const decision = evaluateReminder(booking, window, range, now);
            if (!decision.send) continue;

            try {
                await notifyEvent(window.eventKey, {
                    userId: booking.userId,
                    vars: { diaLabel: decision.label, data: spDdMm(booking.date), hora: booking.startTime },
                    entityType: 'BOOKING',
                    entityId: booking.id,
                    dedupKey: `reminder:${window.label}:${booking.id}:${booking.date.toISOString().slice(0, 10)}`,
                });
                totalSent++;
            } catch (err) {
                failures++;
                console.error(`[REMINDER-JOB] Failed for booking ${booking.id} (${window.label}):`, err);
            }
        }
    }

    // 24h de sessões marcadas com antecedência mas pagas DEPOIS do vencimento (fora do last-run: o
    // próximo minuto reavalia sozinho se algo falhar aqui).
    totalSent += await sendLatePaidDayBeforeReminders(now, range);

    // Avança o last-run só se tudo deu certo e nunca para trás (um `now` injetado no passado não recua).
    if (failures === 0 && (lastRunMs == null || range.toMs > lastRunMs)) {
        try {
            await redis.set(REMINDER_LAST_RUN_KEY, String(range.toMs), 'EX', LAST_RUN_TTL_S);
        } catch (err) {
            console.error('[REMINDER-JOB] Failed to save last-run:', err);
        }
    }

    if (totalSent > 0) {
        console.log(`[REMINDER-JOB] Sent ${totalSent} booking reminders.`);
    }
    if (failures > 0) {
        console.warn(`[REMINDER-JOB] ${failures} failure(s) — last-run kept; the next tick retries (≤60 min catch-up).`);
    }
}

/**
 * jobs-5 / D14: sessão marcada com MAIS de 24h de antecedência cuja contratação (avulso, personalizado do
 * cliente…) só foi paga DEPOIS do vencimento do 24h — no minuto do vencimento o contrato ainda estava
 * AWAITING_PAYMENT e ficou de fora. Quando o pagamento aparece, manda o 24h se ainda for véspera, faltar
 * mais de 2h e o vencimento tiver no máximo 60 min (evaluateLatePaidDayBefore). Mesma dedupKey do envio
 * normal → nunca duplica. Sessão marcada com menos de 24h continua sem o lembrete (D14).
 */
async function sendLatePaidDayBeforeReminders(now: Date, range: ReminderScanRange): Promise<number> {
    const window = REMINDER_WINDOWS.find(w => w.label === '24h')!;
    const nowMs = now.getTime();
    const lookbackFromMs = nowMs - MAX_CATCHUP_MS;
    if (lookbackFromMs >= range.fromMs) return 0; // nada vencido antes do intervalo normal, dentro do teto

    let bookings: {
        id: string; userId: string; date: Date; startTime: string; createdAt: Date;
        contract: { payments: { paidAt: Date | null }[] };
    }[];
    try {
        bookings = await prisma.booking.findMany({
            where: {
                status: { in: ['CONFIRMED', 'RESERVED'] },
                contract: {
                    status: { not: 'AWAITING_PAYMENT' },
                    // Só contratações pagas desde a execução anterior (com folga) — o resto já foi decidido.
                    payments: { some: { status: 'PAID', paidAt: { gt: new Date(range.fromMs - LATE_PAID_SLACK_MS) } } },
                },
                date: {
                    gte: spDayUtc(lookbackFromMs + window.offsetMs, -1),
                    lte: spDayUtc(range.fromMs + window.offsetMs, +1),
                },
            },
            select: {
                id: true, userId: true, date: true, startTime: true, createdAt: true,
                contract: { select: { payments: { where: { status: 'PAID' }, select: { paidAt: true } } } },
            },
        });
    } catch (err) {
        console.error('[REMINDER-JOB] Failed to load late-paid bookings:', err);
        return 0;
    }

    let sent = 0;
    for (const booking of bookings) {
        const paidAtMs = booking.contract.payments
            .map(p => p.paidAt?.getTime())
            .filter((t): t is number => t != null);
        const decision = evaluateLatePaidDayBefore(booking, paidAtMs, range.fromMs, now);
        if (!decision.send) continue;
        try {
            await notifyEvent(window.eventKey, {
                userId: booking.userId,
                vars: { diaLabel: decision.label, data: spDdMm(booking.date), hora: booking.startTime },
                entityType: 'BOOKING',
                entityId: booking.id,
                dedupKey: `reminder:${window.label}:${booking.id}:${booking.date.toISOString().slice(0, 10)}`,
            });
            sent++;
        } catch (err) {
            console.error(`[REMINDER-JOB] Late-paid 24h failed for booking ${booking.id}:`, err);
        }
    }
    return sent;
}

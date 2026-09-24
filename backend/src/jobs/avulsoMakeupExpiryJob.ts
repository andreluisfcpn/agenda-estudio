import { prisma } from '../lib/prisma.js';
import { redis } from '../lib/redis.js';
import { logAudit } from '../lib/audit.js';
import { saoPauloParts } from '../lib/spTime.js';
import { syncContractCompletion } from '../lib/contractCompletion.js';
import {
    ddmmOfYmd, deadlineYmd, makeupDaysLeft, ymdOfDbDate,
    MAKEUP_CONTRACT_STATUSES, MAKEUP_ELIGIBILITY_SELECT, makeupBlockReasonOf,
} from '../lib/avulsoMakeup.js';
import { notifyEvent } from '../modules/notifications/notificationService.js';

/** Avisos da remarcação (lembretes e "prazo encerrado") só saem entre 09:00 e 19:59 de São Paulo. */
export const MAKEUP_NOTICE_START_HOUR = 9;
export const MAKEUP_NOTICE_END_HOUR = 20; // exclusivo
/** Aviso de expiração adiado (fora do horário) ainda é entregue até N dias depois do prazo. */
const EXPIRY_NOTICE_MAX_AGE_MS = 7 * 86_400_000;
/** Auditorias que controlam o aviso de expiração adiado (fila durável no banco, sem duplicar). */
const NOTICE_PENDING = 'MAKEUP_EXPIRY_NOTICE_PENDING';
const NOTICE_SENT = 'MAKEUP_EXPIRY_NOTICE_SENT';

/** Hora de SP em que os avisos da remarcação podem sair (push crítico de madrugada, não). */
export function isMakeupNoticeHour(now: Date): boolean {
    const { hour } = saoPauloParts(now);
    return hour >= MAKEUP_NOTICE_START_HOUR && hour < MAKEUP_NOTICE_END_HOUR;
}

interface ExpiredBooking {
    id: string;
    userId: string;
    contractId: string;
    status: string;
    date: Date;
    missedDate: Date | null;
    makeupDeadline: Date | null;
    user: { name: string } | null;
}

const EXPIRED_BOOKING_SELECT = {
    id: true, userId: true, contractId: true, status: true, date: true, missedDate: true, makeupDeadline: true,
    user: { select: { name: true } },
} as const;

/** Avisos de "prazo de remarcação encerrado": cliente (FALTA: valor perdido / NAO_REALIZADO: valor garantido) + admins (NAO_REALIZADO). */
async function sendExpiryNotices(b: ExpiredBooking, getAdmins: () => Promise<{ id: string }[]>): Promise<void> {
    const vars = {
        data: ddmmOfYmd(ymdOfDbDate(b.missedDate ?? b.date)),
        prazo: b.makeupDeadline ? ddmmOfYmd(deadlineYmd(b.makeupDeadline)) : '',
    };
    const byStudio = b.status === 'NAO_REALIZADO';
    await notifyEvent(byStudio ? 'avulso_makeup_expired_studio' : 'avulso_makeup_expired', {
        userId: b.userId,
        vars,
        entityType: 'BOOKING',
        entityId: b.id,
        dedupKey: `makeup:expired:${b.id}`,
    }).catch(err => console.error(`[MAKEUP-EXPIRY] notify client ${b.id}:`, err));
    if (!byStudio) return;
    for (const admin of await getAdmins()) {
        await notifyEvent('admin_makeup_expired_studio', {
            userId: admin.id,
            vars: { ...vars, cliente: b.user?.name || 'Cliente' },
            entityType: 'BOOKING',
            entityId: b.id,
            actionUrl: `/admin/contracts/${b.contractId}`,
            dedupKey: `makeup:expired-admin:${b.id}:${admin.id}`,
        }).catch(err => console.error(`[MAKEUP-EXPIRY] notify admin ${b.id}:`, err));
    }
}

/**
 * Avulso Makeup Expiry Job — a cada 1h (e uma vez no boot), com trava Redis no index.ts.
 * Janela de remarcação do avulso (D4/D5, lib/avulsoMakeup.ts):
 *   0. Contrato CANCELADO/EXPIRADO ou valor ESTORNADO com janela OPEN → EXPIRED em silêncio (a
 *      remarcação já é barrada por makeupBlockReason; isto só tira o "remarque" das telas). Qualquer hora.
 *   1. EXPIRA as janelas OPEN vencidas (makeupDeadline < now), com updateMany atômico guardado por
 *      OPEN (corre contra uma remarcação no último segundo: só um vence). Qualquer hora — a mudança de
 *      estado (e o contrato avulso da FALTA virar COMPLETED) acontece na 1ª rodada depois do prazo.
 *      - FALTA justificada → EXPIRED, o valor é perdido (sem estorno) e o contrato avulso vira COMPLETED.
 *      - NAO_REALIZADO (culpa do estúdio) → EXPIRED, o contrato continua ACTIVE; o cliente é avisado de
 *        que o estúdio vai entrar em contato e os admins recebem o aviso para resolver.
 *      O AVISO só sai entre 09:00 e 19:59 (SP): fora disso fica pendente (auditoria
 *      MAKEUP_EXPIRY_NOTICE_PENDING) e sai na 1ª rodada dentro do horário (MAKEUP_EXPIRY_NOTICE_SENT
 *      garante uma vez só). Reserva sem direito à remarcação (makeupBlockReason: contrato fora de
 *      ACTIVE/COMPLETED, valor estornado, nunca paga) não recebe aviso.
 *   2. Entrega os avisos de expiração pendentes (só dentro do horário).
 *   3. LEMBRA as janelas OPEN nos 2 últimos dias (calendário SP), no máximo 1 lembrete por dia e só
 *      dentro do horário (a marca do dia só é gasta quando o lembrete sai); nunca de reserva sem direito.
 * `now` é injetável para os testes de "viagem no tempo".
 */
export async function runAvulsoMakeupExpiryJob(
    now: Date = new Date(),
): Promise<{ expired: number; reminded: number; notified: number }> {
    let expired = 0;
    let reminded = 0;
    let notified = 0;
    const noticeHour = isMakeupNoticeHour(now);

    let admins: { id: string }[] | null = null;
    const getAdmins = async () => (admins ??= await prisma.user.findMany({
        where: { role: 'ADMIN', deletedAt: null },
        select: { id: true },
    }));

    // ── 0. Contrato encerrado / valor estornado → janela some (sem aviso) ──
    const orphaned = await prisma.booking.findMany({
        where: {
            makeupStatus: 'OPEN',
            OR: [
                { contract: { status: { in: ['CANCELLED', 'EXPIRED'] } } },
                { payments: { some: { status: 'REFUNDED' } } },
                { contract: { payments: { some: { status: 'REFUNDED' } } } },
            ],
        },
        select: { id: true, contract: { select: { status: true } } },
    });
    for (const b of orphaned) {
        try {
            const r = await prisma.booking.updateMany({
                where: { id: b.id, makeupStatus: 'OPEN' },
                data: { makeupStatus: 'EXPIRED' },
            });
            if (r.count > 0) {
                await logAudit('BOOKING', b.id, 'MAKEUP_EXPIRED', 'SYSTEM', { reason: 'contrato encerrado ou valor estornado', contractStatus: b.contract.status });
            }
        } catch (err) {
            console.error(`[MAKEUP-EXPIRY] Falha ao encerrar a janela do booking ${b.id} (contrato encerrado):`, err);
        }
    }

    // ── 1. Expirar ──
    const due = await prisma.booking.findMany({
        where: { makeupStatus: 'OPEN', makeupDeadline: { lt: now }, status: { in: ['FALTA', 'NAO_REALIZADO'] } },
        select: EXPIRED_BOOKING_SELECT,
    });
    for (const b of due) {
        try {
            const r = await prisma.booking.updateMany({
                where: { id: b.id, makeupStatus: 'OPEN', makeupDeadline: { lt: now } },
                data: { makeupStatus: 'EXPIRED' },
            });
            if (r.count === 0) continue; // remarcado/alterado no meio do caminho
            expired++;
            await logAudit('BOOKING', b.id, 'MAKEUP_EXPIRED', 'SYSTEM', { status: b.status, makeupDeadline: b.makeupDeadline?.toISOString() });
            // FALTA → contrato avulso COMPLETED; NAO_REALIZADO → continua ACTIVE (a regra decide).
            await syncContractCompletion(b.contractId, 'SYSTEM');

            // Contrato cancelado/encerrado ou valor estornado: sem aviso ("valor não reembolsável" seria falso).
            const elig = await prisma.booking.findUnique({ where: { id: b.id }, select: MAKEUP_ELIGIBILITY_SELECT });
            if (!elig || makeupBlockReasonOf(elig)) continue;
            if (noticeHour) {
                await sendExpiryNotices(b, getAdmins);
                await logAudit('BOOKING', b.id, NOTICE_SENT, 'SYSTEM', { deferred: false });
                notified++;
            } else {
                await logAudit('BOOKING', b.id, NOTICE_PENDING, 'SYSTEM', { expiredAt: now.toISOString() });
            }
        } catch (err) {
            console.error(`[MAKEUP-EXPIRY] Falha ao expirar a janela do booking ${b.id}:`, err);
        }
    }

    if (!noticeHour) {
        if (expired > 0) console.log(`[MAKEUP-EXPIRY] ${expired} janela(s) expirada(s); avisos adiados para as ${MAKEUP_NOTICE_START_HOUR}h (SP).`);
        return { expired, reminded, notified };
    }

    // ── 2. Avisos de expiração adiados (fila na auditoria) ──
    const recentlyExpired = await prisma.booking.findMany({
        where: {
            makeupStatus: 'EXPIRED',
            status: { in: ['FALTA', 'NAO_REALIZADO'] },
            makeupDeadline: { gte: new Date(now.getTime() - EXPIRY_NOTICE_MAX_AGE_MS), lt: now },
        },
        select: { ...EXPIRED_BOOKING_SELECT, ...MAKEUP_ELIGIBILITY_SELECT },
    });
    if (recentlyExpired.length > 0) {
        const marks = await prisma.auditLog.findMany({
            where: { entityType: 'BOOKING', entityId: { in: recentlyExpired.map(b => b.id) }, action: { in: [NOTICE_PENDING, NOTICE_SENT] } },
            select: { entityId: true, action: true },
        });
        const pending = new Set(marks.filter(m => m.action === NOTICE_PENDING).map(m => m.entityId));
        for (const m of marks) if (m.action === NOTICE_SENT) pending.delete(m.entityId);
        for (const b of recentlyExpired) {
            if (!pending.has(b.id)) continue;
            try {
                const block = makeupBlockReasonOf(b);
                const deliver = !block;
                if (deliver) {
                    await sendExpiryNotices(b, getAdmins);
                    notified++;
                }
                await logAudit('BOOKING', b.id, NOTICE_SENT, 'SYSTEM', deliver ? { deferred: true } : { skipped: block });
            } catch (err) {
                console.error(`[MAKEUP-EXPIRY] Falha ao entregar o aviso adiado do booking ${b.id}:`, err);
            }
        }
    }

    // ── 3. Lembrar (2 últimos dias, 1 por dia SP, só no horário) ──
    const open = await prisma.booking.findMany({
        where: {
            makeupStatus: 'OPEN', makeupDeadline: { gte: now }, status: { in: ['FALTA', 'NAO_REALIZADO'] },
            contract: { status: { in: [...MAKEUP_CONTRACT_STATUSES] } },
        },
        select: { id: true, userId: true, date: true, missedDate: true, makeupDeadline: true, ...MAKEUP_ELIGIBILITY_SELECT },
    });
    const todaySp = saoPauloParts(now).dateStr;
    for (const b of open) {
        if (!b.makeupDeadline) continue;
        if (makeupBlockReasonOf(b)) continue; // não lembra de uma remarcação que a API recusaria
        const dias = makeupDaysLeft(b.makeupDeadline, now);
        if (dias < 1 || dias > 2) continue;
        try {
            // Marca do dia (TTL > 24h): o job roda de hora em hora e a dedup do notifyEvent (6h para
            // critical) sozinha deixaria sair até 2 lembretes no mesmo dia.
            const first = await redis.set(`makeup:reminded:${b.id}:${todaySp}`, '1', 'EX', 36 * 3600, 'NX');
            if (first !== 'OK') continue;
            await notifyEvent('avulso_makeup_reminder', {
                userId: b.userId,
                vars: {
                    dias,
                    data: ddmmOfYmd(ymdOfDbDate(b.missedDate ?? b.date)),
                    prazo: ddmmOfYmd(deadlineYmd(b.makeupDeadline)),
                },
                entityType: 'BOOKING',
                entityId: b.id,
                dedupKey: `makeup:reminder:${b.id}:${todaySp}`,
            });
            reminded++;
        } catch (err) {
            console.error(`[MAKEUP-EXPIRY] Falha ao lembrar o booking ${b.id}:`, err);
        }
    }

    if (expired > 0 || reminded > 0 || notified > 0) {
        console.log(`[MAKEUP-EXPIRY] ${expired} janela(s) expirada(s), ${notified} aviso(s) de expiração, ${reminded} lembrete(s).`);
    }
    return { expired, reminded, notified };
}

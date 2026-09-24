import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { prisma } from '../../src/lib/prisma';
import { redis } from '../../src/lib/redis';
import {
    applyMakeupOnStatusChange,
    rescheduleAvulsoMakeup,
    validateNoShowJustification,
    MakeupError,
} from '../../src/lib/avulsoMakeup';
import { syncContractCompletion } from '../../src/lib/contractCompletion';
import { restoreCredit } from '../../src/modules/bookings/booking.service';
import { runAvulsoMakeupExpiryJob } from '../../src/jobs/avulsoMakeupExpiryJob';
import { notifyEvent, cleanupOldNotifications } from '../../src/modules/notifications/notificationService';
import { mkUser, mkContract, mkBooking, mkPayment } from './factories';

// ─── Remarcação do avulso (D4/D5) + contrato "Concluído" (D6) — TIME TRAVEL ────
// Exercita as funções REAIS usadas pelas rotas (PATCH /bookings/:id → applyMakeupOnStatusChange;
// PATCH /bookings/:id/makeup → rescheduleAvulsoMakeup) e o JOB real, "andando o relógio" via `now`.

const D = '2026-09-14';                                   // segunda-feira: gravação perdida (10:00 COMERCIAL)
const dbDate = (ymd: string) => new Date(`${ymd}T00:00:00Z`);
const sp = (ymd: string, hhmm: string) => new Date(`${ymd}T${hhmm}:00-03:00`);
const NOW_AFTER_MISS = sp('2026-09-14', '15:00');        // o admin marca a falta no mesmo dia
const DEADLINE_ISO = '2026-09-22T02:59:59.999Z';         // fim de 21/09 (D+7) em SP

async function seedAvulso(opts: { status?: 'CONFIRMED' | 'FALTA' | 'NAO_REALIZADO'; paymentStatus?: 'PAID' | 'PENDING' } = {}) {
    const admin = await mkUser({ role: 'ADMIN', name: 'Admin Teste' });
    const client = await mkUser({ name: 'Cliente Avulso' });
    const contract = await mkContract(client.id, {
        type: 'AVULSO', durationMonths: 1, discountPct: 0,
        startDate: dbDate(D), endDate: dbDate(D), paymentPlan: 'FULL',
        flexCreditsTotal: 1, flexCreditsRemaining: 0, status: 'ACTIVE',
    });
    const booking = await mkBooking(client.id, contract.id, {
        date: dbDate(D), startTime: '10:00', endTime: '12:00', tierApplied: 'COMERCIAL',
        status: opts.status ?? 'CONFIRMED',
    });
    const payment = await mkPayment(client.id, {
        contractId: contract.id, bookingId: booking.id, status: opts.paymentStatus ?? 'PAID', amount: 30000,
        paidAt: (opts.paymentStatus ?? 'PAID') === 'PAID' ? sp(D, '09:00') : null,
    });
    touchedBookingIds.push(booking.id);
    return { admin, client, contract, booking, payment };
}

/** Simula o PATCH admin: transição de status (atômica, como a rota) + regras da janela + sync do contrato. */
async function adminMark(bookingId: string, to: 'FALTA' | 'NAO_REALIZADO' | 'CONFIRMED' | 'CANCELLED', adminId: string,
    opts: { noShowJustified?: boolean; now?: Date } = {}) {
    const b = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId }, include: { contract: { select: { type: true } } } });
    let moved = false;
    if (b.status !== to) {
        moved = (await prisma.booking.updateMany({ where: { id: bookingId, status: b.status }, data: { status: to } })).count > 0;
        if (moved && to === 'NAO_REALIZADO') await restoreCredit(b.contractId);
    }
    const changed = await applyMakeupOnStatusChange({
        booking: { id: b.id, date: b.date, originalDate: b.originalDate, missedDate: b.missedDate, makeupStatus: b.makeupStatus, contractType: b.contract.type },
        from: b.status, to: moved ? to : b.status, statusChanged: moved,
        noShowJustified: opts.noShowJustified, actorId: adminId, now: opts.now ?? NOW_AFTER_MISS,
    });
    if (moved || changed) await syncContractCompletion(b.contractId, adminId);
}

const readBooking = (id: string) => prisma.booking.findUniqueOrThrow({ where: { id } });
const contractStatus = async (id: string) => (await prisma.contract.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;

// A dedup de notificações e as marcas diárias do job vivem no Redis (compartilhado com o dev). As
// chaves levam o id do booking (UUID novo a cada teste), então não há resíduo entre testes; ao final
// removemos só as marcas criadas aqui, sem tocar nas do dev.
const touchedBookingIds: string[] = [];
beforeEach(() => { touchedBookingIds.length = 0; });
afterEach(async () => {
    for (const id of touchedBookingIds) {
        const keys = [...await redis.keys(`makeup:*${id}*`), ...await redis.keys(`notif:dedup:makeup:*${id}*`)];
        if (keys.length) await redis.del(...keys);
    }
});

describe('FALTA justificada abre a janela (D4)', () => {
    it('justificar → OPEN até o fim de D+7 (SP), missedDate = D, contrato continua ACTIVE e o cliente é avisado', async () => {
        const { admin, client, contract, booking } = await seedAvulso();
        await adminMark(booking.id, 'FALTA', admin.id, { noShowJustified: true });

        const b = await readBooking(booking.id);
        expect(b.status).toBe('FALTA');
        expect(b.makeupStatus).toBe('OPEN');
        expect(b.makeupDeadline?.toISOString()).toBe(DEADLINE_ISO);
        expect(b.missedDate?.toISOString().slice(0, 10)).toBe(D);
        expect(await contractStatus(contract.id)).toBe('ACTIVE'); // janela aberta NÃO conclui
        // Aviso de abertura: tipo NÃO efêmero (BOOKING_CANCELLED) e crítico.
        const opened = await prisma.notification.findMany({ where: { userId: client.id } });
        expect(opened).toHaveLength(1);
        expect(opened[0]).toMatchObject({ type: 'BOOKING_CANCELLED', severity: 'critical', title: 'Você pode remarcar sua gravação' });
    });

    it('FALTA sem justificativa → perde na hora: contrato COMPLETED', async () => {
        const { admin, contract, booking } = await seedAvulso();
        await adminMark(booking.id, 'FALTA', admin.id);
        expect((await readBooking(booking.id)).makeupStatus).toBeNull();
        expect(await contractStatus(contract.id)).toBe('COMPLETED');
    });

    it('desfazer a justificativa (noShowJustified=false) retira a janela e conclui o contrato', async () => {
        const { admin, contract, booking } = await seedAvulso();
        await adminMark(booking.id, 'FALTA', admin.id, { noShowJustified: true });
        await adminMark(booking.id, 'FALTA', admin.id, { noShowJustified: false });
        const b = await readBooking(booking.id);
        expect(b.makeupStatus).toBeNull();
        expect(b.makeupDeadline).toBeNull();
        expect(await contractStatus(contract.id)).toBe('COMPLETED');
    });
});

describe('PATCH /bookings/:id/makeup — remarcação sem novo pagamento', () => {
    it('cliente remarca → CONFIRMED + USED na MESMA reserva, com o MESMO Payment; admins avisados', async () => {
        const { admin, client, contract, booking, payment } = await seedAvulso();
        await adminMark(booking.id, 'FALTA', admin.id, { noShowJustified: true });

        const res = await rescheduleAvulsoMakeup({
            bookingId: booking.id, actor: { userId: client.id, isAdmin: false },
            date: '2026-09-17', startTime: '13:00', now: sp('2026-09-15', '12:00'),
        });
        expect(res.booking?.status).toBe('CONFIRMED');

        const b = await readBooking(booking.id);
        expect(b.status).toBe('CONFIRMED');
        expect(b.date.toISOString().slice(0, 10)).toBe('2026-09-17');
        expect(b.startTime).toBe('13:00');
        expect(b.endTime).toBe('15:00');
        expect(b.makeupStatus).toBe('USED');
        expect(b.originalDate?.toISOString().slice(0, 10)).toBe(D); // âncora continua sendo a data original
        expect(b.missedDate?.toISOString().slice(0, 10)).toBe(D);

        const payments = await prisma.payment.findMany({ where: { bookingId: booking.id } });
        expect(payments).toHaveLength(1);                // nenhuma cobrança nova
        expect(payments[0].id).toBe(payment.id);
        expect(payments[0].status).toBe('PAID');
        expect(await contractStatus(contract.id)).toBe('ACTIVE'); // sessão pendente
        expect(await prisma.notification.count({ where: { userId: admin.id, title: 'Gravação remarcada' } })).toBe(1);
        // Quem remarcou foi o próprio cliente: ele NÃO recebe o aviso de "o estúdio remarcou".
        expect(await prisma.notification.count({ where: { userId: client.id, title: 'Gravação remarcada' } })).toBe(0);

        // Remarcação é ÚNICA: uma 2ª tentativa é recusada.
        await expect(rescheduleAvulsoMakeup({
            bookingId: booking.id, actor: { userId: client.id, isAdmin: false },
            date: '2026-09-18', startTime: '13:00', now: sp('2026-09-15', '12:00'),
        })).rejects.toMatchObject({ httpStatus: 400 });
    });

    it('regras: dono, prazo D+7, antecedência mínima do cliente, mesma faixa, sem justificativa', async () => {
        const { admin, client, booking } = await seedAvulso();
        const other = await mkUser();
        const now = sp('2026-09-15', '12:00');
        const call = (actor: { userId: string; isAdmin: boolean }, date: string, startTime: string) =>
            rescheduleAvulsoMakeup({ bookingId: booking.id, actor, date, startTime, now });

        await adminMark(booking.id, 'FALTA', admin.id); // ainda SEM justificativa
        await expect(call({ userId: client.id, isAdmin: false }, '2026-09-17', '10:00')).rejects.toMatchObject({ httpStatus: 400 });

        await adminMark(booking.id, 'FALTA', admin.id, { noShowJustified: true });
        await expect(call({ userId: other.id, isAdmin: false }, '2026-09-17', '10:00')).rejects.toMatchObject({ httpStatus: 404 });
        await expect(call({ userId: client.id, isAdmin: false }, '2026-09-22', '10:00')).rejects.toThrow(/21\/09/); // > D+7
        await expect(call({ userId: client.id, isAdmin: false }, '2026-09-15', '20:30')).rejects.toThrow(/antecedência/); // < 12h
        await expect(call({ userId: client.id, isAdmin: false }, '2026-09-17', '18:00')).rejects.toThrow(/mesma faixa/); // AUDIÊNCIA
        await expect(call({ userId: client.id, isAdmin: false }, '2026-09-20', '10:00')).rejects.toThrow(/não funciona/); // domingo

        // O último dia (D+7) ainda vale.
        const ok = await call({ userId: client.id, isAdmin: false }, '2026-09-21', '10:00');
        expect(ok.booking?.makeupStatus).toBe('USED');
    });

    it('não remarca por cima de outra reserva (409)', async () => {
        const { admin, client, booking } = await seedAvulso();
        await adminMark(booking.id, 'FALTA', admin.id, { noShowJustified: true });
        const someone = await mkUser();
        const c2 = await mkContract(someone.id, { type: 'FLEX' });
        await mkBooking(someone.id, c2.id, { date: dbDate('2026-09-17'), startTime: '13:00', endTime: '15:00', status: 'CONFIRMED' });

        const err = await rescheduleAvulsoMakeup({
            bookingId: booking.id, actor: { userId: client.id, isAdmin: false },
            date: '2026-09-17', startTime: '13:00', now: sp('2026-09-15', '12:00'),
        }).catch(e => e);
        expect(err).toBeInstanceOf(MakeupError);
        expect(err.httpStatus).toBe(409);
        expect((await readBooking(booking.id)).makeupStatus).toBe('OPEN'); // nada mudou
    });

    it('concorrência: dois cliques simultâneos (slots diferentes) → só UM vence, o outro recebe 409', async () => {
        const { admin, client, booking } = await seedAvulso();
        await adminMark(booking.id, 'FALTA', admin.id, { noShowJustified: true });
        const now = sp('2026-09-15', '12:00');
        const results = await Promise.allSettled([
            rescheduleAvulsoMakeup({ bookingId: booking.id, actor: { userId: client.id, isAdmin: false }, date: '2026-09-17', startTime: '10:00', now }),
            rescheduleAvulsoMakeup({ bookingId: booking.id, actor: { userId: client.id, isAdmin: false }, date: '2026-09-18', startTime: '13:00', now }),
        ]);
        expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
        const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
        expect(rejected).toHaveLength(1);
        expect(rejected[0].reason.httpStatus).toBe(409);
        const b = await readBooking(booking.id);
        expect(b.makeupStatus).toBe('USED');
        expect(await prisma.booking.count({ where: { contractId: booking.contractId } })).toBe(1);
    });

    it('concorrência: mesmo slot em paralelo → só UM vence', async () => {
        const { admin, client, booking } = await seedAvulso();
        await adminMark(booking.id, 'FALTA', admin.id, { noShowJustified: true });
        const now = sp('2026-09-15', '12:00');
        const call = () => rescheduleAvulsoMakeup({ bookingId: booking.id, actor: { userId: client.id, isAdmin: false }, date: '2026-09-17', startTime: '10:00', now });
        const results = await Promise.allSettled([call(), call(), call()]);
        expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    });
});

describe('job avulsoMakeupExpiryJob — viagem no tempo', () => {
    it('antes do prazo nada expira; lembrete só nos 2 últimos dias e 1 por dia', async () => {
        const { admin, client, booking } = await seedAvulso();
        await adminMark(booking.id, 'FALTA', admin.id, { noShowJustified: true });
        const reminders = () => prisma.notification.count({ where: { userId: client.id, type: 'BOOKING_CANCELLED', title: { contains: 'restante' } } });

        let r = await runAvulsoMakeupExpiryJob(sp('2026-09-17', '10:00')); // 5 dias restantes
        expect(r).toEqual({ expired: 0, reminded: 0, notified: 0 });

        r = await runAvulsoMakeupExpiryJob(sp('2026-09-20', '09:00'));     // penúltimo dia
        expect(r.reminded).toBe(1);
        r = await runAvulsoMakeupExpiryJob(sp('2026-09-20', '18:00'));     // mesmo dia → não repete
        expect(r.reminded).toBe(0);
        r = await runAvulsoMakeupExpiryJob(sp('2026-09-21', '09:00'));     // último dia
        expect(r.reminded).toBe(1);
        expect(await reminders()).toBe(2);
        expect((await readBooking(booking.id)).makeupStatus).toBe('OPEN');
    });

    it('FALTA: prazo vencido → EXPIRED, valor perdido (Payment intacto) e contrato COMPLETED', async () => {
        const { admin, client, contract, booking, payment } = await seedAvulso();
        await adminMark(booking.id, 'FALTA', admin.id, { noShowJustified: true });
        expect(await contractStatus(contract.id)).toBe('ACTIVE');

        const expiredNotices = () => prisma.notification.count({ where: { userId: client.id, title: 'Prazo de remarcação encerrado' } });

        // Madrugada: o estado muda (EXPIRED + contrato COMPLETED), mas o aviso fica para as 9h (SP).
        let r = await runAvulsoMakeupExpiryJob(sp('2026-09-22', '00:05'));
        expect(r).toEqual({ expired: 1, reminded: 0, notified: 0 });
        expect((await readBooking(booking.id)).makeupStatus).toBe('EXPIRED');
        expect(await contractStatus(contract.id)).toBe('COMPLETED');
        expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe('PAID'); // sem estorno
        expect(await expiredNotices()).toBe(0);

        r = await runAvulsoMakeupExpiryJob(sp('2026-09-22', '08:59'));
        expect(r).toEqual({ expired: 0, reminded: 0, notified: 0 });
        expect(await expiredNotices()).toBe(0);

        // 1ª rodada dentro do horário: o aviso adiado sai UMA vez.
        r = await runAvulsoMakeupExpiryJob(sp('2026-09-22', '09:05'));
        expect(r).toEqual({ expired: 0, reminded: 0, notified: 1 });
        expect(await expiredNotices()).toBe(1);
        const notice = await prisma.notification.findFirstOrThrow({ where: { userId: client.id, title: 'Prazo de remarcação encerrado' } });
        expect(notice).toMatchObject({ type: 'BOOKING_CANCELLED', severity: 'critical' });

        // Idempotente: rodar de novo (mesmo dia ou depois) não duplica nada.
        expect(await runAvulsoMakeupExpiryJob(sp('2026-09-22', '10:05'))).toEqual({ expired: 0, reminded: 0, notified: 0 });
        expect(await runAvulsoMakeupExpiryJob(sp('2026-09-23', '09:05'))).toEqual({ expired: 0, reminded: 0, notified: 0 });
        expect(await expiredNotices()).toBe(1);

        // Cliente não consegue mais remarcar.
        await expect(rescheduleAvulsoMakeup({
            bookingId: booking.id, actor: { userId: client.id, isAdmin: false },
            date: '2026-09-24', startTime: '10:00', now: sp('2026-09-22', '08:00'),
        })).rejects.toThrow(/prazo/);
    });

    it('NAO_REALIZADO: janela abre sozinha; ao expirar o contrato continua ACTIVE, cliente e admins avisados; admin remarca depois do prazo e o crédito fica coerente', async () => {
        const { admin, client, contract, booking } = await seedAvulso();
        await adminMark(booking.id, 'NAO_REALIZADO', admin.id);

        let b = await readBooking(booking.id);
        expect(b.makeupStatus).toBe('OPEN');                       // automático (culpa do estúdio)
        expect(b.makeupDeadline?.toISOString()).toBe(DEADLINE_ISO);
        expect(await contractStatus(contract.id)).toBe('ACTIVE');
        const creditAfterMark = (await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } })).flexCreditsRemaining;
        expect(creditAfterMark).toBe(1);                            // NAO_REALIZADO devolveu o crédito

        let r = await runAvulsoMakeupExpiryJob(sp('2026-09-22', '00:05'));
        expect(r).toMatchObject({ expired: 1, notified: 0 });
        b = await readBooking(booking.id);
        expect(b.makeupStatus).toBe('EXPIRED');
        expect(await contractStatus(contract.id)).toBe('ACTIVE');   // D5: não perde o valor
        expect(await prisma.notification.count({ where: { userId: client.id, title: 'Vamos combinar sua gravação' } })).toBe(0);
        expect(await prisma.notification.count({ where: { userId: admin.id, title: 'Gravação não realizada sem remarcação' } })).toBe(0);

        r = await runAvulsoMakeupExpiryJob(sp('2026-09-22', '09:05')); // horário comercial: os avisos adiados saem
        expect(r).toMatchObject({ expired: 0, notified: 1 });
        expect(await prisma.notification.count({ where: { userId: client.id, title: 'Vamos combinar sua gravação' } })).toBe(1);
        // Alerta D5 ao admin: tipo NÃO efêmero (não some do sino em 48h).
        const alert = await prisma.notification.findMany({ where: { userId: admin.id, title: 'Gravação não realizada sem remarcação' } });
        expect(alert).toHaveLength(1);
        expect(alert[0].type).toBe('BOOKING_CANCELLED');

        // Cliente fora do prazo → recusado; admin pode remarcar mesmo depois do prazo (e além de D+7).
        await expect(rescheduleAvulsoMakeup({
            bookingId: booking.id, actor: { userId: client.id, isAdmin: false },
            date: '2026-09-25', startTime: '10:00', now: sp('2026-09-22', '10:00'),
        })).rejects.toMatchObject({ httpStatus: 400 });
        const res = await rescheduleAvulsoMakeup({
            bookingId: booking.id, actor: { userId: admin.id, isAdmin: true },
            date: '2026-09-25', startTime: '10:00', now: sp('2026-09-22', '10:00'),
        });
        expect(res.booking?.status).toBe('CONFIRMED');
        expect(res.booking?.makeupStatus).toBe('USED');
        expect((await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } })).flexCreditsRemaining).toBe(0); // deduzido de volta
        // Remarcado pelo ESTÚDIO: o cliente recebe a nova data; o admin que remarcou não é notificado.
        const moved = await prisma.notification.findMany({ where: { userId: client.id, title: 'Gravação remarcada' } });
        expect(moved).toHaveLength(1);
        expect(moved[0].message).toContain('25/09 às 10:00');
        expect(await prisma.notification.count({ where: { userId: admin.id, title: 'Gravação remarcada' } })).toBe(0);
    });
});

describe('conclusão automática do contrato (D6)', () => {
    it('avulso: finalizar → COMPLETED; reabrir a gravação → volta a ACTIVE', async () => {
        const { contract, booking } = await seedAvulso();
        await prisma.booking.update({ where: { id: booking.id }, data: { status: 'COMPLETED' } });
        expect(await syncContractCompletion(contract.id)).toBe('COMPLETED');
        expect(await contractStatus(contract.id)).toBe('COMPLETED');
        expect(await syncContractCompletion(contract.id)).toBeNull(); // idempotente

        await prisma.booking.update({ where: { id: booking.id }, data: { status: 'CONFIRMED' } });
        expect(await syncContractCompletion(contract.id)).toBe('REOPENED');
        expect(await contractStatus(contract.id)).toBe('ACTIVE');
        expect(await prisma.auditLog.count({ where: { entityType: 'CONTRACT', entityId: contract.id } })).toBe(2);
    });

    it('avulso cancelado com crédito devolvido continua ACTIVE (pode reagendar)', async () => {
        const { contract, booking } = await seedAvulso();
        await prisma.booking.update({ where: { id: booking.id }, data: { status: 'CANCELLED' } });
        await restoreCredit(contract.id);
        expect(await syncContractCompletion(contract.id)).toBeNull();
        expect(await contractStatus(contract.id)).toBe('ACTIVE');
    });

    it('FLEX: última gravação finalizada sem crédito restante → COMPLETED; com crédito → ACTIVE', async () => {
        const u = await mkUser();
        const c = await mkContract(u.id, { type: 'FLEX', flexCreditsTotal: 2, flexCreditsRemaining: 0 });
        await mkBooking(u.id, c.id, { date: dbDate('2026-09-15'), status: 'COMPLETED' });
        const b2 = await mkBooking(u.id, c.id, { date: dbDate('2026-09-22'), status: 'CONFIRMED' });
        expect(await syncContractCompletion(c.id)).toBeNull();          // ainda há sessão pendente
        await prisma.booking.update({ where: { id: b2.id }, data: { status: 'COMPLETED' } });
        expect(await syncContractCompletion(c.id)).toBe('COMPLETED');

        await prisma.contract.update({ where: { id: c.id }, data: { flexCreditsRemaining: 1 } }); // crédito devolvido
        expect(await syncContractCompletion(c.id)).toBe('REOPENED');
    });

    it('nunca mexe em PAUSED / PENDING_CANCELLATION / AWAITING_PAYMENT / CANCELLED / EXPIRED, nem em SERVICO', async () => {
        const u = await mkUser();
        for (const status of ['PAUSED', 'PENDING_CANCELLATION', 'AWAITING_PAYMENT', 'CANCELLED', 'EXPIRED'] as const) {
            const c = await mkContract(u.id, { type: 'AVULSO', status, flexCreditsRemaining: 0 });
            await mkBooking(u.id, c.id, { date: dbDate('2026-09-15'), status: 'COMPLETED' });
            expect(await syncContractCompletion(c.id)).toBeNull();
            expect(await contractStatus(c.id)).toBe(status);
        }
        const s = await mkContract(u.id, { type: 'SERVICO', status: 'ACTIVE' });
        await mkBooking(u.id, s.id, { date: dbDate('2026-09-15'), status: 'COMPLETED' });
        expect(await syncContractCompletion(s.id)).toBeNull();
        expect(await contractStatus(s.id)).toBe('ACTIVE');
    });

    it('syncs concorrentes no mesmo contrato não quebram (serializados pelo FOR UPDATE)', async () => {
        const { contract, booking } = await seedAvulso();
        await prisma.booking.update({ where: { id: booking.id }, data: { status: 'COMPLETED' } });
        const out = await Promise.all([1, 2, 3, 4].map(() => syncContractCompletion(contract.id)));
        expect(out.filter(x => x === 'COMPLETED')).toHaveLength(1);
        expect(await contractStatus(contract.id)).toBe('COMPLETED');
    });
});

// ─── Correções da revisão (fx-status) ────────────────────────────────────────

describe('remarcação só com contrato de pé e pagamento válido (status-remarcacao-1)', () => {
    it('contrato CANCELADO → 400 para o cliente E para o admin (override D5 não fura); o job encerra a janela sem aviso', async () => {
        const { admin, client, contract, booking } = await seedAvulso();
        await adminMark(booking.id, 'NAO_REALIZADO', admin.id);
        await prisma.contract.update({ where: { id: contract.id }, data: { status: 'CANCELLED' } });
        const now = sp('2026-09-15', '12:00');

        await expect(rescheduleAvulsoMakeup({ bookingId: booking.id, actor: { userId: client.id, isAdmin: false }, date: '2026-09-17', startTime: '10:00', now }))
            .rejects.toMatchObject({ httpStatus: 400, message: expect.stringMatching(/cancelado ou encerrado/) });
        await expect(rescheduleAvulsoMakeup({ bookingId: booking.id, actor: { userId: admin.id, isAdmin: true }, date: '2026-09-17', startTime: '10:00', now }))
            .rejects.toMatchObject({ httpStatus: 400 });
        let b = await readBooking(booking.id);
        expect(b.status).toBe('NAO_REALIZADO');

        // Qualquer hora (aqui, de madrugada e antes do prazo): a janela some, sem aviso a ninguém.
        const before = await prisma.notification.count();
        const r = await runAvulsoMakeupExpiryJob(sp('2026-09-16', '02:00'));
        expect(r).toEqual({ expired: 0, reminded: 0, notified: 0 });
        b = await readBooking(booking.id);
        expect(b.makeupStatus).toBe('EXPIRED');
        expect(await contractStatus(contract.id)).toBe('CANCELLED');
        // Nem lembrete nem "prazo encerrado" depois (inclusive no horário comercial).
        await runAvulsoMakeupExpiryJob(sp('2026-09-20', '10:00'));
        await runAvulsoMakeupExpiryJob(sp('2026-09-22', '10:00'));
        expect(await prisma.notification.count()).toBe(before);
    });

    it('PENDING_CANCELLATION → 400; no prazo a janela expira sem aviso ("valor não reembolsável" não sai)', async () => {
        const { admin, client, contract, booking } = await seedAvulso();
        await adminMark(booking.id, 'FALTA', admin.id, { noShowJustified: true });
        await prisma.contract.update({ where: { id: contract.id }, data: { status: 'PENDING_CANCELLATION' } });
        await expect(rescheduleAvulsoMakeup({
            bookingId: booking.id, actor: { userId: client.id, isAdmin: false },
            date: '2026-09-17', startTime: '10:00', now: sp('2026-09-15', '12:00'),
        })).rejects.toMatchObject({ httpStatus: 400 });

        expect((await runAvulsoMakeupExpiryJob(sp('2026-09-20', '10:00'))).reminded).toBe(0); // sem lembrete
        const r = await runAvulsoMakeupExpiryJob(sp('2026-09-22', '10:00'));
        expect(r).toEqual({ expired: 1, reminded: 0, notified: 0 });
        expect(await prisma.notification.count({ where: { userId: client.id, title: 'Prazo de remarcação encerrado' } })).toBe(0);
    });

    it('pagamento ESTORNADO ou não pago → 400 sem mexer na reserva', async () => {
        const { admin, client, booking, payment } = await seedAvulso();
        await adminMark(booking.id, 'FALTA', admin.id, { noShowJustified: true });
        const call = () => rescheduleAvulsoMakeup({
            bookingId: booking.id, actor: { userId: client.id, isAdmin: false },
            date: '2026-09-17', startTime: '10:00', now: sp('2026-09-15', '12:00'),
        });

        await prisma.payment.update({ where: { id: payment.id }, data: { status: 'REFUNDED' } });
        await expect(call()).rejects.toMatchObject({ httpStatus: 400, message: expect.stringMatching(/estornado/) });

        await prisma.payment.update({ where: { id: payment.id }, data: { status: 'PENDING', paidAt: null } });
        await expect(call()).rejects.toMatchObject({ httpStatus: 400, message: expect.stringMatching(/não está confirmado/) });

        const b = await readBooking(booking.id);
        expect(b).toMatchObject({ status: 'FALTA', makeupStatus: 'OPEN' });

        // Pago de novo: volta a poder remarcar.
        await prisma.payment.update({ where: { id: payment.id }, data: { status: 'PAID', paidAt: sp(D, '09:00') } });
        expect((await call()).booking?.makeupStatus).toBe('USED');
    });

    it('reserva nunca paga: a falta não pode ser justificada e o NAO_REALIZADO não abre janela (nada de prometer remarcação)', async () => {
        const { admin, client, booking } = await seedAvulso({ paymentStatus: 'PENDING' });
        await expect(validateNoShowJustification({
            finalStatus: 'FALTA', contractType: 'AVULSO', makeupStatus: null, bookingDate: booking.date,
            bookingId: booking.id, now: NOW_AFTER_MISS,
        })).resolves.toMatch(/não está confirmado/);

        await adminMark(booking.id, 'NAO_REALIZADO', admin.id);
        const b = await readBooking(booking.id);
        expect(b).toMatchObject({ status: 'NAO_REALIZADO', makeupStatus: null });
        expect(await prisma.notification.count({ where: { userId: client.id } })).toBe(0);
    });

    it('valor estornado com a janela aberta: o job encerra a janela em silêncio e não manda lembrete nem "prazo encerrado"', async () => {
        const { admin, client, booking, payment } = await seedAvulso();
        await adminMark(booking.id, 'FALTA', admin.id, { noShowJustified: true });
        const before = await prisma.notification.count({ where: { userId: client.id } });
        await prisma.payment.update({ where: { id: payment.id }, data: { status: 'REFUNDED' } });

        expect(await runAvulsoMakeupExpiryJob(sp('2026-09-20', '10:00'))).toEqual({ expired: 0, reminded: 0, notified: 0 });
        expect((await readBooking(booking.id)).makeupStatus).toBe('EXPIRED');
        await runAvulsoMakeupExpiryJob(sp('2026-09-22', '10:00'));
        expect(await prisma.notification.count({ where: { userId: client.id } })).toBe(before);
    });
});

describe('desfazer a falta no MESMO dia/horário não gasta a remarcação (status-remarcacao-3)', () => {
    it('FALTA justificada → CONFIRMED no mesmo slot: janela desfeita (null), originalDate intocado; nova justificativa é aceita', async () => {
        const { admin, contract, booking } = await seedAvulso();
        await adminMark(booking.id, 'FALTA', admin.id, { noShowJustified: true });
        await adminMark(booking.id, 'CONFIRMED', admin.id);

        let b = await readBooking(booking.id);
        expect(b).toMatchObject({ status: 'CONFIRMED', makeupStatus: null, makeupDeadline: null, missedDate: null, originalDate: null });
        expect(await contractStatus(contract.id)).toBe('ACTIVE');

        // O cliente falta de verdade depois: a justificativa ainda está disponível (não foi "usada").
        await adminMark(booking.id, 'FALTA', admin.id, { noShowJustified: true });
        b = await readBooking(booking.id);
        expect(b.makeupStatus).toBe('OPEN');
    });

    it('FALTA justificada → COMPLETED (o cliente chegou atrasado e gravou): janela desfeita e contrato COMPLETED', async () => {
        const { admin, contract, booking } = await seedAvulso();
        await adminMark(booking.id, 'FALTA', admin.id, { noShowJustified: true });
        const b0 = await readBooking(booking.id);
        const moved = (await prisma.booking.updateMany({ where: { id: booking.id, status: 'FALTA' }, data: { status: 'COMPLETED' } })).count > 0;
        await applyMakeupOnStatusChange({
            booking: { id: b0.id, date: b0.date, originalDate: b0.originalDate, missedDate: b0.missedDate, makeupStatus: b0.makeupStatus, contractType: 'AVULSO' },
            from: 'FALTA', to: 'COMPLETED', statusChanged: moved, slotChanged: false, actorId: admin.id, now: NOW_AFTER_MISS,
        });
        await syncContractCompletion(contract.id, admin.id);
        expect((await readBooking(booking.id)).makeupStatus).toBeNull();
        expect(await contractStatus(contract.id)).toBe('COMPLETED');
    });

    it('com mudança de data/horário na mesma edição: USED (remarcação "à mão")', async () => {
        const { admin, booking } = await seedAvulso();
        await adminMark(booking.id, 'FALTA', admin.id, { noShowJustified: true });
        const b0 = await readBooking(booking.id);
        await prisma.booking.updateMany({ where: { id: booking.id }, data: { status: 'CONFIRMED', date: dbDate('2026-09-17') } });
        await applyMakeupOnStatusChange({
            booking: { id: b0.id, date: b0.date, originalDate: b0.originalDate, missedDate: b0.missedDate, makeupStatus: b0.makeupStatus, contractType: 'AVULSO' },
            from: 'FALTA', to: 'CONFIRMED', statusChanged: true, slotChanged: true, actorId: admin.id, now: NOW_AFTER_MISS,
        });
        const b = await readBooking(booking.id);
        expect(b.makeupStatus).toBe('USED');
        expect(b.originalDate?.toISOString().slice(0, 10)).toBe(D);
    });

    it('NAO_REALIZADO → CONFIRMED no mesmo slot: sem remarcação anterior desfaz; reaberto sobre remarcação já feita volta a USED', async () => {
        const { admin, client, booking } = await seedAvulso();
        await adminMark(booking.id, 'NAO_REALIZADO', admin.id);
        await adminMark(booking.id, 'CONFIRMED', admin.id);
        expect((await readBooking(booking.id)).makeupStatus).toBeNull();

        // Agora: falta justificada, remarcada (USED), o estúdio falha na nova sessão (NAO_REALIZADO
        // reabre a janela) e o operador corrige para Confirmado no mesmo slot: volta a USED.
        await adminMark(booking.id, 'FALTA', admin.id, { noShowJustified: true });
        await rescheduleAvulsoMakeup({
            bookingId: booking.id, actor: { userId: client.id, isAdmin: false },
            date: '2026-09-17', startTime: '10:00', now: sp('2026-09-15', '12:00'),
        });
        await adminMark(booking.id, 'NAO_REALIZADO', admin.id, { now: sp('2026-09-17', '13:00') });
        expect((await readBooking(booking.id)).makeupStatus).toBe('OPEN');
        await adminMark(booking.id, 'CONFIRMED', admin.id, { now: sp('2026-09-17', '13:05') });
        expect((await readBooking(booking.id)).makeupStatus).toBe('USED');
    });
});

describe('avisos da remarcação só entre 09:00 e 19:59 SP (status-remarcacao-4 / jobs-tempo-migrations-2)', () => {
    it('lembrete de madrugada não sai nem gasta a marca do dia; sai às 9h; depois das 20h não sai', async () => {
        const { admin, client, booking } = await seedAvulso();
        await adminMark(booking.id, 'FALTA', admin.id, { noShowJustified: true });
        const reminders = () => prisma.notification.count({ where: { userId: client.id, title: { contains: 'restante' } } });

        expect(await runAvulsoMakeupExpiryJob(sp('2026-09-20', '00:30'))).toEqual({ expired: 0, reminded: 0, notified: 0 });
        expect(await runAvulsoMakeupExpiryJob(sp('2026-09-20', '08:30'))).toEqual({ expired: 0, reminded: 0, notified: 0 });
        expect(await reminders()).toBe(0);
        expect((await runAvulsoMakeupExpiryJob(sp('2026-09-20', '09:30'))).reminded).toBe(1);
        expect(await reminders()).toBe(1);

        // Último dia: rodadas só depois das 20h não mandam.
        expect((await runAvulsoMakeupExpiryJob(sp('2026-09-21', '20:30'))).reminded).toBe(0);
        expect(await reminders()).toBe(1);
    });

    it('aviso adiado de contrato cancelado entre a expiração e as 9h é descartado (sem aviso)', async () => {
        const { admin, client, contract, booking } = await seedAvulso();
        await adminMark(booking.id, 'FALTA', admin.id, { noShowJustified: true });
        expect((await runAvulsoMakeupExpiryJob(sp('2026-09-22', '00:05'))).expired).toBe(1);
        await prisma.contract.update({ where: { id: contract.id }, data: { status: 'CANCELLED' } });
        expect(await runAvulsoMakeupExpiryJob(sp('2026-09-22', '09:05'))).toEqual({ expired: 0, reminded: 0, notified: 0 });
        expect(await prisma.notification.count({ where: { userId: client.id, title: 'Prazo de remarcação encerrado' } })).toBe(0);
        // E não fica reprocessando: marcado como tratado.
        expect(await prisma.auditLog.count({ where: { entityId: booking.id, action: 'MAKEUP_EXPIRY_NOTICE_SENT' } })).toBe(1);
    });
});

describe('remarcação feita pelo admin avisa o cliente e os outros admins (status-remarcacao-5)', () => {
    it('cliente recebe a nova data; o admin que remarcou não; outro admin sim', async () => {
        const { admin, client, booking } = await seedAvulso();
        const otherAdmin = await mkUser({ role: 'ADMIN', name: 'Outro Admin' });
        await adminMark(booking.id, 'FALTA', admin.id, { noShowJustified: true });

        await rescheduleAvulsoMakeup({
            bookingId: booking.id, actor: { userId: admin.id, isAdmin: true },
            date: '2026-09-18', startTime: '13:00', now: sp('2026-09-15', '12:00'),
        });
        const toClient = await prisma.notification.findMany({ where: { userId: client.id, title: 'Gravação remarcada' } });
        expect(toClient).toHaveLength(1);
        expect(toClient[0].message).toBe('O estúdio remarcou sua gravação de 14/09 para 18/09 às 13:00, sem novo pagamento.');
        expect(toClient[0].type).toBe('SYSTEM'); // não efêmero
        expect(await prisma.notification.count({ where: { userId: admin.id, title: 'Gravação remarcada' } })).toBe(0);
        expect(await prisma.notification.count({ where: { userId: otherAdmin.id, title: 'Gravação remarcada' } })).toBe(1);
    });
});

describe('aviso de remarcação liberada chega a quem usa "só essenciais" (status-remarcacao-9)', () => {
    it('avulso_makeup_opened é crítico', async () => {
        const { admin, client, booking } = await seedAvulso();
        await prisma.user.update({ where: { id: client.id }, data: { essentialNotificationsOnly: true } });
        await adminMark(booking.id, 'NAO_REALIZADO', admin.id);
        const n = await prisma.notification.findMany({ where: { userId: client.id } });
        expect(n).toHaveLength(1);
        expect(n[0]).toMatchObject({ title: 'Você pode remarcar sua gravação', severity: 'critical' });
    });
});

describe('notificações da remarcação não somem do sino em 48h (jobs-tempo-migrations-6)', () => {
    it('a limpeza diária mantém abertura, lembrete, expiração, remarcação e o alerta D5 ao admin com 3 dias', async () => {
        const { admin, client, booking } = await seedAvulso();
        const events: [string, string][] = [
            ['avulso_makeup_opened', client.id], ['avulso_makeup_reminder', client.id],
            ['avulso_makeup_expired', client.id], ['avulso_makeup_expired_studio', client.id],
            ['avulso_makeup_rescheduled', client.id],
            ['admin_makeup_expired_studio', admin.id], ['admin_makeup_rescheduled', admin.id],
        ];
        for (const [eventKey, userId] of events) {
            await notifyEvent(eventKey, {
                userId, vars: { data: '14/09', prazo: '21/09', novaData: '18/09', hora: '13:00', dias: 1, cliente: 'X' },
                entityType: 'BOOKING', entityId: booking.id, dedupKey: `makeup:test-cleanup:${eventKey}:${booking.id}`,
            });
        }
        // Um lembrete de sessão comum (efêmero) serve de contraste.
        const contrastKey = `makeup:test-cleanup:contrast:${booking.id}`;
        await notifyEvent('booking_reminder_2h', {
            userId: client.id, vars: { diaLabel: 'hoje (14/09)', hora: '10:00' },
            entityType: 'BOOKING', entityId: booking.id, dedupKey: contrastKey,
        });
        expect(await prisma.notification.count()).toBe(events.length + 1);

        await prisma.notification.updateMany({ data: { createdAt: new Date(Date.now() - 3 * 86_400_000) } });
        const r = await cleanupOldNotifications();
        expect(r.ephemeralDeleted).toBe(1); // só o lembrete de sessão
        expect(await prisma.notification.count()).toBe(events.length);
    });
});

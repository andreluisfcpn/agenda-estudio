import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { prisma } from '../../src/lib/prisma';
import { redis } from '../../src/lib/redis';
import { config } from '../../src/config/index';
import { saoPauloParts } from '../../src/lib/spTime';
import contractRoutes from '../../src/modules/contracts/routes';
import { issuePixCharge } from '../../src/lib/pixGateway';
import { runFlexCreditExpiryJob } from '../../src/jobs/flexCreditExpiryJob';
import { runBookingReminderJob, REMINDER_LAST_RUN_KEY } from '../../src/jobs/bookingReminderJob';
import { mkUser, mkContract, mkBooking } from './factories';

// Pendências da onda 2 (frente be-fixups):
//  1) POST /contracts/custom (CLIENTE, PIX): o QR da 1ª parcela expira junto com o paymentDeadline (10 min).
//  2) flexCreditExpiryJob: o confisco que zera os créditos conclui o contrato (syncContractCompletion).
//  3) bookingReminderJob: sessão de contrato AWAITING_PAYMENT não recebe lembrete.

const VALID_CPF = '52998224725';

function cookieFor(u: { id: string; email: string | null; role: string }) {
    const token = jwt.sign({ userId: u.id, email: u.email ?? '', role: u.role }, config.jwt.secret, { expiresIn: '1h' });
    return `accessToken=${token}`;
}

/** 'YYYY-MM-DD' de hoje + `n` dias no calendário SP. */
function addDaysSp(n: number): string {
    const sp = saoPauloParts(new Date());
    return new Date(Date.UTC(sp.y, sp.m - 1, sp.day + n)).toISOString().slice(0, 10);
}

describe('POST /api/contracts/custom (CLIENTE, PIX) — validade do QR = paymentDeadline', () => {
    let server: Server;
    let base = '';

    beforeAll(async () => {
        const app = express();
        app.use(express.json());
        app.use(cookieParser());
        app.use('/api/contracts', contractRoutes);
        await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    beforeEach(async () => {
        // Formas de pagamento ativas (sem IntegrationConfig → em test o PIX cai no BR Code sintético válido).
        for (const [i, key] of ['PIX', 'CARTAO', 'BOLETO'].entries()) {
            await prisma.paymentMethodConfig.create({
                data: { key, label: key, shortLabel: key, emoji: '-', description: key, color: '#000000', active: true, sortOrder: i },
            });
        }
    });

    it('pixExpiresAt da 1ª parcela ≈ paymentDeadline; resposta traz qrCodeDataUrl/expiresAt; o checkout reaproveita o mesmo QR', async () => {
        const client = await mkUser({ cpfCnpj: VALID_CPF });
        const res = await fetch(`${base}/api/contracts/custom`, {
            method: 'POST',
            headers: { Cookie: cookieFor(client), 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: 'Personalizado QR', tier: 'COMERCIAL', durationMonths: 3, paymentMethod: 'PIX', paymentPlan: 'MONTHLY',
                // D7: o personalizado do CLIENTE começa amanhã (SP) — nem antes, nem depois.
                schedule: [{ day: 2, time: '10:00' }], startDate: addDaysSp(1),
            }),
        });
        const body = await res.json() as any;
        expect(res.status).toBe(201);
        expect(body.status).toBe('AWAITING_PAYMENT');
        expect(body.firstPixString).toBeTruthy();
        expect(body.qrCodeDataUrl).toMatch(/^data:image\/png;base64,/);

        const deadlineMs = new Date(body.paymentDeadline).getTime();
        // Antes: 1h fixa (3600s) contra um prazo de 10 min. Agora casa com o prazo (tolerância de 5s).
        expect(Math.abs(new Date(body.expiresAt).getTime() - deadlineMs)).toBeLessThan(5_000);

        const contract = await prisma.contract.findUniqueOrThrow({ where: { id: body.contract.id } });
        const pays = await prisma.payment.findMany({ where: { contractId: contract.id }, orderBy: { dueDate: 'asc' } });
        const first = pays[0]!;
        expect(first.id).toBe(body.firstPaymentId);
        expect(first.pixExpiresAt).not.toBeNull();
        expect(Math.abs(first.pixExpiresAt!.getTime() - contract.paymentDeadline!.getTime())).toBeLessThan(5_000);
        expect((first.metadata as any)?.pixCharge?.amount).toBe(first.amount);
        // Parcelas 2..N continuam sem cobrança (QR sob demanda).
        expect(pays.slice(1).every(p => p.pixString === null && p.pixExpiresAt === null)).toBe(true);

        // O checkout (/stripe/create-payment → issuePixCharge) reaproveita o QR vivo, com o mesmo prazo.
        const pix = await issuePixCharge(first.id);
        expect(pix.reused).toBe(true);
        expect(pix.alreadyPaid).toBe(false);
        expect(pix.expiresAt).toBe(first.pixExpiresAt!.toISOString());
    });
});

describe('runFlexCreditExpiryJob — conclui o contrato quando o confisco zera os créditos (D6)', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const WEEK = 7 * DAY;
    const CS = Date.UTC(2026, 0, 1, 0, 0, 0);
    const createdUsers: string[] = [];

    afterEach(async () => {
        // Dedup do flex_credit_lost (chave padrão userId+type+entity) — só as chaves dos usuários deste teste.
        for (const id of createdUsers.splice(0)) {
            const keys = await redis.keys(`notif:dedup:${id}:*`);
            if (keys.length) await redis.del(...keys);
        }
    });

    async function seed(total: number) {
        const u = await mkUser();
        createdUsers.push(u.id);
        const c = await mkContract(u.id, {
            type: 'FLEX', status: 'ACTIVE',
            flexCreditsTotal: total, flexCreditsRemaining: total - 1, flexCreditsForfeited: 0,
            flexForfeitFloor: 0, flexCycleStart: new Date(CS),
        });
        await mkBooking(u.id, c.id, { date: new Date(CS), status: 'COMPLETED' }); // 1 gravação feita no dia 0
        return c;
    }

    it('4 créditos, 1 gravado, 5 semanas depois: confisca 3 → restante 0 → COMPLETED (com auditoria)', async () => {
        const c = await seed(4);
        await runFlexCreditExpiryJob(new Date(CS + 5 * WEEK));

        const after = await prisma.contract.findUniqueOrThrow({ where: { id: c.id } });
        expect(after.flexCreditsForfeited).toBe(3);
        expect(after.flexCreditsRemaining).toBe(0);
        expect(after.status).toBe('COMPLETED');
        const audit = await prisma.auditLog.findFirst({ where: { entityType: 'CONTRACT', entityId: c.id, action: 'COMPLETED' } });
        expect(audit).not.toBeNull();

        // Idempotente: rodar de novo não mexe (o job só varre ACTIVE; o contrato segue COMPLETED).
        await runFlexCreditExpiryJob(new Date(CS + 6 * WEEK));
        expect((await prisma.contract.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('COMPLETED');
    });

    it('confisco que ainda deixa crédito → continua ACTIVE', async () => {
        const c = await seed(12);
        await runFlexCreditExpiryJob(new Date(CS + 5 * WEEK));
        const after = await prisma.contract.findUniqueOrThrow({ where: { id: c.id } });
        expect(after.flexCreditsForfeited).toBe(4);
        expect(after.flexCreditsRemaining).toBe(7);
        expect(after.status).toBe('ACTIVE');
    });

    it('créditos zerados mas com sessão futura pendente → continua ACTIVE', async () => {
        const c = await seed(4);
        // Sessão ainda por acontecer (conta como gravação para o confisco e bloqueia a conclusão).
        await mkBooking(c.userId, c.id, { date: new Date(CS + 5 * WEEK + DAY), status: 'CONFIRMED' });
        await prisma.contract.update({ where: { id: c.id }, data: { flexCreditsRemaining: 2 } });
        await runFlexCreditExpiryJob(new Date(CS + 5 * WEEK));
        const after = await prisma.contract.findUniqueOrThrow({ where: { id: c.id } });
        expect(after.flexCreditsRemaining).toBe(0); // 4 - 2 gravações - 2 confiscados
        expect(after.status).toBe('ACTIVE');
    });
});

describe('runBookingReminderJob — sem lembrete para contrato AWAITING_PAYMENT', () => {
    // Sessão em 20/01/2027 às 10:00 SP (13:00Z). O de 24h vence em 19/01 13:00:00Z; `now` = 1s depois.
    const SESSION_DATE = new Date('2027-01-20T00:00:00Z');
    const NOW = new Date('2027-01-19T13:00:01Z');
    const bookingIds: string[] = [];

    beforeEach(() => {
        // O Redis dos testes é o mesmo do servidor dev: NUNCA ler/gravar o last-run real do job
        // (um last-run em 2027 travaria os lembretes do dev). Sem last-run → cobre só o último minuto.
        const origGet = redis.get.bind(redis) as (...a: unknown[]) => Promise<unknown>;
        const origSet = redis.set.bind(redis) as (...a: unknown[]) => Promise<unknown>;
        vi.spyOn(redis, 'get').mockImplementation(((key: unknown, ...rest: unknown[]) =>
            key === REMINDER_LAST_RUN_KEY ? Promise.resolve(null) : origGet(key, ...rest)) as never);
        vi.spyOn(redis, 'set').mockImplementation(((key: unknown, ...rest: unknown[]) =>
            key === REMINDER_LAST_RUN_KEY ? Promise.resolve('OK') : origSet(key, ...rest)) as never);
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        const keys = bookingIds.splice(0).flatMap(id => ['24h', '2h'].map(w => `notif:dedup:reminder:${w}:${id}:2027-01-20`));
        if (keys.length) await redis.del(...keys);
    });

    const reminders = (userId: string) => prisma.notification.count({ where: { userId, type: 'BOOKING_REMINDER' } });

    it('ACTIVE recebe o de 24h; AWAITING_PAYMENT (personalizado não pago) não; depois de pago, recebe', async () => {
        const paid = await mkUser();
        const unpaid = await mkUser();
        const cPaid = await mkContract(paid.id, { type: 'FIXO', status: 'ACTIVE' });
        const cUnpaid = await mkContract(unpaid.id, {
            type: 'CUSTOM', status: 'AWAITING_PAYMENT', paymentDeadline: new Date(NOW.getTime() + 10 * 60_000),
        });
        const bPaid = await mkBooking(paid.id, cPaid.id, { date: SESSION_DATE, startTime: '10:00', endTime: '12:00', status: 'CONFIRMED' });
        const bUnpaid = await mkBooking(unpaid.id, cUnpaid.id, { date: SESSION_DATE, startTime: '13:00', endTime: '15:00', status: 'RESERVED' });
        const bUnpaid10 = await mkBooking(unpaid.id, cUnpaid.id, { date: SESSION_DATE, startTime: '10:00', endTime: '12:00', status: 'RESERVED' });
        bookingIds.push(bPaid.id, bUnpaid.id, bUnpaid10.id);

        await runBookingReminderJob(NOW);
        expect(await reminders(paid.id)).toBe(1);
        expect(await reminders(unpaid.id)).toBe(0);
        const n = await prisma.notification.findFirstOrThrow({ where: { userId: paid.id, type: 'BOOKING_REMINDER' } });
        expect(n.title).toBe('Sessão amanhã (20/01)');

        // O filtro é só o status do contrato: pago (ACTIVE) no mesmo minuto → a sessão das 10:00 recebe.
        await prisma.contract.update({ where: { id: cUnpaid.id }, data: { status: 'ACTIVE', paymentDeadline: null } });
        await runBookingReminderJob(NOW);
        expect(await reminders(unpaid.id)).toBe(1); // só a das 10:00 vence neste minuto
        expect(await reminders(paid.id)).toBe(1);   // dedupKey inalterada → sem duplicar
    });
});

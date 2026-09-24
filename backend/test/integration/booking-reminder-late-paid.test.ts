import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { prisma } from '../../src/lib/prisma';
import { redis } from '../../src/lib/redis';
import { runBookingReminderJob, REMINDER_LAST_RUN_KEY } from '../../src/jobs/bookingReminderJob';
import { mkUser, mkContract, mkBooking, mkPayment } from './factories';

// ─── Lembrete de 24h: contratação paga DEPOIS do vencimento (jobs-tempo-migrations-5) e last-run
// com TTL longo (jobs-tempo-migrations-4). Job REAL contra o DB de teste, com `now` injetado. ─────

// Sessão em 20/01/2027 às 10:00 SP (13:00Z). O 24h vence em 19/01 13:00:00Z.
const SESSION_DATE = new Date('2027-01-20T00:00:00Z');
const DUE = new Date('2027-01-19T13:00:00Z').getTime();
const at = (offsetMs: number) => new Date(DUE + offsetMs);
const MIN = 60_000;

// O Redis dos testes é o mesmo do servidor dev: NUNCA ler/gravar o last-run real do job. O last-run
// fica num Map local (o teste controla o que o job "vê") e as gravações são registradas para conferir o TTL.
let fakeLastRun: string | null = null;
const lastRunWrites: unknown[][] = [];
const bookingIds: string[] = [];

beforeEach(() => {
    fakeLastRun = null;
    lastRunWrites.length = 0;
    const origGet = redis.get.bind(redis) as (...a: unknown[]) => Promise<unknown>;
    const origSet = redis.set.bind(redis) as (...a: unknown[]) => Promise<unknown>;
    vi.spyOn(redis, 'get').mockImplementation(((key: unknown, ...rest: unknown[]) =>
        key === REMINDER_LAST_RUN_KEY ? Promise.resolve(fakeLastRun) : origGet(key, ...rest)) as never);
    vi.spyOn(redis, 'set').mockImplementation(((key: unknown, ...rest: unknown[]) => {
        if (key !== REMINDER_LAST_RUN_KEY) return origSet(key, ...rest);
        lastRunWrites.push(rest);
        fakeLastRun = String(rest[0]);
        return Promise.resolve('OK');
    }) as never);
});

afterEach(async () => {
    vi.restoreAllMocks();
    const keys = bookingIds.splice(0).flatMap(id => ['24h', '2h'].map(w => `notif:dedup:reminder:${w}:${id}:2027-01-20`));
    if (keys.length) await redis.del(...keys);
});

const dayBefore = (userId: string) => prisma.notification.count({ where: { userId, title: 'Sessão amanhã (20/01)' } });

/** Personalizado do cliente ainda AGUARDANDO PAGAMENTO no vencimento, com a sessão das 10:00 reservada. */
async function seedAwaiting(createdAt: Date) {
    const u = await mkUser();
    const c = await mkContract(u.id, { type: 'CUSTOM', status: 'AWAITING_PAYMENT', paymentDeadline: at(10 * MIN) });
    const b = await mkBooking(u.id, c.id, {
        date: SESSION_DATE, startTime: '10:00', endTime: '12:00', status: 'RESERVED', createdAt,
    });
    const p = await mkPayment(u.id, { contractId: c.id, status: 'PENDING', amount: 50000 });
    bookingIds.push(b.id);
    return { u, c, b, p };
}

async function pay(ids: { c: { id: string }; b: { id: string }; p: { id: string } }, paidAt: Date) {
    await prisma.payment.update({ where: { id: ids.p.id }, data: { status: 'PAID', paidAt } });
    await prisma.contract.update({ where: { id: ids.c.id }, data: { status: 'ACTIVE', paymentDeadline: null } });
    await prisma.booking.update({ where: { id: ids.b.id }, data: { status: 'CONFIRMED' } });
}

describe('runBookingReminderJob — 24h de contratação paga depois do vencimento', () => {
    it('marcada 24h05 antes e paga 3 min depois do vencimento: recebe o 24h ("amanhã") uma vez só', async () => {
        const s = await seedAwaiting(at(-5 * MIN));

        await runBookingReminderJob(at(1000));          // no vencimento: ainda aguardando pagamento
        expect(await dayBefore(s.u.id)).toBe(0);

        await pay(s, at(3 * MIN));
        await runBookingReminderJob(at(3 * MIN + 1000));  // tick seguinte ao pagamento
        expect(await dayBefore(s.u.id)).toBe(1);

        await runBookingReminderJob(at(4 * MIN + 1000));  // ticks seguintes não duplicam
        await runBookingReminderJob(at(5 * MIN + 1000));
        expect(await dayBefore(s.u.id)).toBe(1);
    });

    it('marcada com MENOS de 24h (D14) não recebe, mesmo paga', async () => {
        const s = await seedAwaiting(at(2 * MIN));       // criada depois do vencimento
        await pay(s, at(4 * MIN));
        await runBookingReminderJob(at(4 * MIN + 1000));
        expect(await dayBefore(s.u.id)).toBe(0);
    });

    it('pago mais de 60 min depois do vencimento (teto de catch-up) não recebe', async () => {
        const s = await seedAwaiting(at(-5 * MIN));
        await pay(s, at(65 * MIN));
        await runBookingReminderJob(at(65 * MIN + 1000));
        expect(await dayBefore(s.u.id)).toBe(0);
    });

    it('contrato que já estava pago no vencimento não é reavaliado por uma parcela paga depois', async () => {
        // FIXO pago antes do vencimento (o 24h saiu no vencimento — aqui simulado sem o tick) + parcela
        // nova paga depois: não pode disparar o lembrete "tardio".
        const u = await mkUser();
        const c = await mkContract(u.id, { type: 'FIXO', status: 'ACTIVE' });
        const b = await mkBooking(u.id, c.id, { date: SESSION_DATE, startTime: '10:00', endTime: '12:00', status: 'CONFIRMED', createdAt: at(-3 * 86_400_000) });
        bookingIds.push(b.id);
        await mkPayment(u.id, { contractId: c.id, status: 'PAID', paidAt: at(-10 * 86_400_000) });
        await mkPayment(u.id, { contractId: c.id, status: 'PAID', paidAt: at(2 * MIN) });
        await runBookingReminderJob(at(2 * MIN + 1000));
        expect(await dayBefore(u.id)).toBe(0);
    });
});

describe('runBookingReminderJob — last-run (TTL longo e lixo no futuro)', () => {
    it('grava o last-run com TTL de dias (catch-up sobrevive a queda > 2h)', async () => {
        await runBookingReminderJob(at(0));
        expect(lastRunWrites).toHaveLength(1);
        expect(lastRunWrites[0]).toEqual([String(DUE), 'EX', 7 * 24 * 3600]);
    });

    it('queda de 07:50 a 10:30: com o last-run preservado, o 24h vencido 30 min antes ainda sai (catch-up ≤ 60 min)', async () => {
        const u = await mkUser();
        const c = await mkContract(u.id, { type: 'FIXO', status: 'ACTIVE' });
        const b = await mkBooking(u.id, c.id, { date: SESSION_DATE, startTime: '10:00', endTime: '12:00', status: 'CONFIRMED', createdAt: at(-3 * 86_400_000) });
        bookingIds.push(b.id);
        fakeLastRun = String(DUE - (2 * 60 + 10) * MIN);   // última execução 2h10 antes do vencimento
        await runBookingReminderJob(at(30 * MIN));          // volta 30 min depois do vencimento
        expect(await dayBefore(u.id)).toBe(1);
    });

    it('last-run lixo muito no futuro é ignorado (não trava os lembretes) e é sobrescrito', async () => {
        const u = await mkUser();
        const c = await mkContract(u.id, { type: 'FIXO', status: 'ACTIVE' });
        const b = await mkBooking(u.id, c.id, { date: SESSION_DATE, startTime: '10:00', endTime: '12:00', status: 'CONFIRMED', createdAt: at(-3 * 86_400_000) });
        bookingIds.push(b.id);
        fakeLastRun = String(DUE + 3 * 86_400_000);       // ex.: execução manual com `now` 3 dias à frente
        await runBookingReminderJob(at(1000));
        expect(await dayBefore(u.id)).toBe(1);
        expect(fakeLastRun).toBe(String(DUE + 1000));
    });
});

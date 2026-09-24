import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { prisma } from '../../src/lib/prisma';
import { redis } from '../../src/lib/redis';
import { config } from '../../src/config/index';
import { saoPauloParts } from '../../src/lib/spTime';
import { invalidateConfigCache } from '../../src/lib/businessConfig';
import { addDaysYmd } from '../../src/lib/avulsoMakeup';
import { avulsoContractName } from '../../src/modules/bookings/booking.service';
import bookingRoutes from '../../src/modules/bookings/routes';
import contractRoutes from '../../src/modules/contracts/routes';
import { mkUser, mkContract, mkBooking, mkPayment, mkCoupon } from './factories';

// Onda 3b — fixups2, pelas ROTAS reais:
//  (1) personalizado: régua de desconto por nº de gravações lida da config (episodes_3/6months);
//  (2) /custom/check e POST /custom descartam antes os personalizados AWAITING_PAYMENT VENCIDOS do
//      mesmo cliente (sessões RESERVED antigas não viram conflito; cupom liberado);
//  (3) avulso: data/horário da gravação mudou (PATCH admin, /reschedule, /makeup) → startDate/endDate
//      e o nome gerado do contrato acompanham. Outros tipos não mudam.

let server: Server;
let base = '';

beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/bookings', bookingRoutes);
    app.use('/api/contracts', contractRoutes);
    await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
    invalidateConfigCache();
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
    // A BusinessConfig é truncada entre os casos, mas o getConfig tem cache em memória (60 s).
    invalidateConfigCache();
    for (const [i, key] of ['PIX', 'CARTAO', 'BOLETO'].entries()) {
        await prisma.paymentMethodConfig.create({
            data: { key, label: key, shortLabel: key, emoji: '-', description: key, color: '#000000', active: true, sortOrder: i },
        });
    }
});

// Só as chaves de dedup/marcação das reservas criadas aqui (o Redis é o mesmo do servidor dev).
const touched: string[] = [];
afterEach(async () => {
    invalidateConfigCache();
    for (const id of touched.splice(0)) {
        const keys = [...await redis.keys(`makeup:*${id}*`), ...await redis.keys(`notif:dedup:makeup:*${id}*`)];
        if (keys.length) await redis.del(...keys);
    }
});

const VALID_CPF = '52998224725';
type Who = { id: string; email: string | null; role: string };

function cookie(u: Who) {
    return `accessToken=${jwt.sign({ userId: u.id, email: u.email ?? '', role: u.role }, config.jwt.secret, { expiresIn: '1h' })}`;
}

async function call(method: string, path: string, who?: Who, body?: unknown) {
    const res = await fetch(`${base}${path}`, {
        method,
        headers: {
            ...(who ? { Cookie: cookie(who) } : {}),
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

const todaySp = saoPauloParts(new Date()).dateStr;
const dbDate = (ymd: string) => new Date(`${ymd}T00:00:00Z`);
const dow = (ymd: string) => new Date(`${ymd}T12:00:00Z`).getUTCDay();
/** 1º dia com o dia-da-semana `d` em [from, from+6]. */
const nextDow = (d: number, minDays: number) => {
    let x = addDaysYmd(todaySp, minDays);
    while (dow(x) !== d) x = addDaysYmd(x, 1);
    return x;
};
/** 1º dia útil (seg–sex) em [from, to]. */
function weekdayBetween(from: string, to: string): string {
    for (let d = from; d <= to; d = addDaysYmd(d, 1)) if (dow(d) >= 1 && dow(d) <= 5) return d;
    throw new Error('sem dia útil no intervalo');
}
const ddmmyyyy = (ymd: string) => `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}/${ymd.slice(0, 4)}`;

async function setConfig(key: string, value: string) {
    await prisma.businessConfig.upsert({
        where: { key },
        create: { key, value, type: 'number', label: key, group: 'plans' },
        update: { value },
    });
    invalidateConfigCache();
}

// Início = amanhã (SP): o personalizado do CLIENTE só começa amanhã (D7); o admin aceita qualquer data.
const customBody = (over: Record<string, unknown> = {}) => ({
    name: 'Personalizado fixups2', tier: 'COMERCIAL', durationMonths: 1, paymentMethod: 'CARTAO', paymentPlan: 'MONTHLY',
    schedule: [{ day: 2, time: '10:00' }], startDate: addDaysYmd(todaySp, 1), ...over,
});

// ─── (1) Régua de desconto do personalizado ─────────────────────────────

describe('POST /api/contracts/custom — desconto por nº de gravações vem da config', () => {
    it('padrão (12/24 → 30%/40%) continua igual: 4 gravações = 0%, 12 = 30%, 24 = 40%', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser();
        const r4 = await call('POST', '/api/contracts/custom', admin, customBody({ userId: client.id }));
        expect(r4.status).toBe(201);
        expect(r4.body.summary).toMatchObject({ totalSessions: 4, discountPct: 0 });

        const r12 = await call('POST', '/api/contracts/custom', admin, customBody({ userId: client.id, durationMonths: 3, startDate: nextDow(3, 2), schedule: [{ day: 3, time: '10:00' }] }));
        expect(r12.status).toBe(201);
        expect(r12.body.summary).toMatchObject({ totalSessions: 12, discountPct: 30 });

        const r24 = await call('POST', '/api/contracts/custom', admin, customBody({ userId: client.id, durationMonths: 6, startDate: nextDow(4, 2), schedule: [{ day: 4, time: '10:00' }] }));
        expect(r24.status).toBe(201);
        expect(r24.body.summary).toMatchObject({ totalSessions: 24, discountPct: 40 });
    });

    it('com episodes_3months=4 / episodes_6months=8 na config, o desconto cobrado muda junto', async () => {
        await setConfig('episodes_3months', '4');
        await setConfig('episodes_6months', '8');
        await setConfig('discount_3months', '15');
        await setConfig('discount_6months', '25');
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser();

        const r3 = await call('POST', '/api/contracts/custom', admin, customBody({ userId: client.id }));
        expect(r3.status).toBe(201);
        expect(r3.body.summary).toMatchObject({ totalSessions: 4, discountPct: 15 });
        expect(r3.body.contract.discountPct).toBe(15);

        const r6 = await call('POST', '/api/contracts/custom', admin, customBody({
            userId: client.id, schedule: [{ day: 3, time: '13:00' }, { day: 5, time: '13:00' }], startDate: nextDow(3, 2),
        }));
        expect(r6.status).toBe(201);
        expect(r6.body.summary).toMatchObject({ totalSessions: 8, discountPct: 25 });
        // O preço gravado por sessão usa o desconto da config (25% < preço com 15%).
        const priceOf = async (contractId: string) =>
            (await prisma.booking.findFirstOrThrow({ where: { contractId }, select: { price: true } })).price;
        expect(await priceOf(r6.body.contract.id)).toBeLessThan(await priceOf(r3.body.contract.id));

        // Abaixo da régua: sem desconto.
        await setConfig('episodes_3months', '5');
        const r0 = await call('POST', '/api/contracts/custom', admin, customBody({ userId: client.id, startDate: nextDow(1, 2), schedule: [{ day: 1, time: '15:30' }] }));
        expect(r0.status).toBe(201);
        expect(r0.body.summary).toMatchObject({ totalSessions: 4, discountPct: 0 });
    });
});

// ─── (2) Personalizados vencidos e não pagos saem antes do check/criação ──

async function expireContract(id: string) {
    await prisma.contract.update({ where: { id }, data: { paymentDeadline: new Date(Date.now() - 60_000) } });
}

describe('/custom/check e POST /custom — descarte das tentativas AWAITING_PAYMENT anteriores', () => {
    it('cliente: tentativa anterior (vencida OU ainda no prazo) não vira conflito no check e é apagada (contrato, sessões, parcelas)', async () => {
        const client = await mkUser({ cpfCnpj: VALID_CPF });
        const checkBody = { tier: 'COMERCIAL', durationMonths: 1, startDate: customBody().startDate, schedule: [{ day: 2, time: '10:00' }] };
        for (const expired of [true, false]) {
            const first = await call('POST', '/api/contracts/custom', client, customBody());
            expect(first.status).toBe(201);
            expect(first.body.status).toBe('AWAITING_PAYMENT');
            const oldId = first.body.contract.id;
            if (expired) await expireContract(oldId);
            // O check do cliente vem logo antes da criação: a nova tentativa substitui a anterior (D2/D9).
            const after = await call('POST', '/api/contracts/custom/check', client, checkBody);
            expect(after.status).toBe(200);
            expect(after.body).toMatchObject({ available: true, totalConflicts: 0, totalSessions: 4 });
            expect(await prisma.contract.count({ where: { id: oldId } })).toBe(0);
            expect(await prisma.booking.count({ where: { contractId: oldId } })).toBe(0);
            expect(await prisma.payment.count({ where: { contractId: oldId } })).toBe(0);
        }
    });

    it('cliente: nova criação após o vencimento sai inteira (sem `skipped`) e libera o cupom de uso único', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser({ cpfCnpj: VALID_CPF });
        const coupon = await mkCoupon(admin.id, { maxUsesPerUser: 1 });

        const first = await call('POST', '/api/contracts/custom', client, customBody({ paymentMethod: 'PIX', couponCode: coupon.code }));
        expect(first.status).toBe(201);
        const oldId = first.body.contract.id;
        await expireContract(oldId);

        const second = await call('POST', '/api/contracts/custom', client, customBody({ paymentMethod: 'PIX', couponCode: coupon.code }));
        expect(second.status).toBe(201);
        expect(second.body.skipped).toEqual([]);
        expect(second.body.summary.totalBookingsGenerated).toBe(4);
        expect(await prisma.contract.count({ where: { id: oldId } })).toBe(0);
        const firstPay = await prisma.payment.findUniqueOrThrow({ where: { id: second.body.firstPaymentId } });
        expect(firstPay.couponCode).toBe(coupon.code);
    });

    it('não mexe no que não deve: contrato de OUTRO cliente; tentativa própria PAGA é ativada (409, não apagada)', async () => {
        const client = await mkUser({ cpfCnpj: VALID_CPF });
        const other = await mkUser(); // cartão: sem CPF (cpf_cnpj é único)
        // Outro cliente, vencido: continua (só a varredura o apaga).
        const o = await call('POST', '/api/contracts/custom', other, customBody({ schedule: [{ day: 2, time: '13:00' }] }));
        expect(o.status).toBe(201);
        await expireContract(o.body.contract.id);
        // Do próprio cliente, vencido mas com a 1ª parcela PAGA: é ativado, não apagado.
        const paid = await call('POST', '/api/contracts/custom', client, customBody({ schedule: [{ day: 2, time: '15:30' }] }));
        expect(paid.status).toBe(201);
        await prisma.payment.update({ where: { id: paid.body.firstPaymentId }, data: { status: 'PAID', paidAt: new Date() } });
        await expireContract(paid.body.contract.id);

        const r = await call('POST', '/api/contracts/custom/check', client, { tier: 'COMERCIAL', durationMonths: 1, startDate: customBody().startDate, schedule: [{ day: 2, time: '10:00' }] });
        // A contratação anterior foi paga: o cliente é avisado (o plano já está ativo em Meus Contratos).
        expect(r.status).toBe(409);
        expect(r.body.code).toBe('CUSTOM_PREVIOUS_PAID');
        expect(await prisma.contract.findUniqueOrThrow({ where: { id: o.body.contract.id } })).toMatchObject({ status: 'AWAITING_PAYMENT' });
        expect(await prisma.contract.findUniqueOrThrow({ where: { id: paid.body.contract.id } })).toMatchObject({ status: 'ACTIVE' });
        expect(await prisma.booking.count({ where: { contractId: paid.body.contract.id, status: 'CONFIRMED' } })).toBe(4);
        // Numa nova tentativa (já sem pendência), o check segue normal.
        const again = await call('POST', '/api/contracts/custom/check', client, { tier: 'COMERCIAL', durationMonths: 1, startDate: customBody().startDate, schedule: [{ day: 2, time: '10:00' }] });
        expect(again.status).toBe(200);
    });

    it('admin: o check descarta os vencidos do cliente-alvo quando recebe `userId`; a criação em nome dele também', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser({ cpfCnpj: VALID_CPF });
        const a = await call('POST', '/api/contracts/custom', client, customBody());
        await expireContract(a.body.contract.id);
        // 2ª tentativa vencida do cliente criada direto no banco (uma nova tentativa pela API descartaria a 1ª).
        const b = { body: { contract: await mkContract(client.id, {
            type: 'CUSTOM', status: 'AWAITING_PAYMENT', paymentDeadline: new Date(Date.now() - 60_000),
        }) } };
        const checkBody = { tier: 'COMERCIAL', durationMonths: 1, startDate: customBody().startDate, schedule: [{ day: 2, time: '10:00' }] };

        // Sem userId o admin não descarta nada (não sabe de quem é).
        const noTarget = await call('POST', '/api/contracts/custom/check', admin, checkBody);
        expect(noTarget.body.totalConflicts).toBe(4);
        expect(await prisma.contract.count({ where: { userId: client.id } })).toBe(2);

        const withTarget = await call('POST', '/api/contracts/custom/check', admin, { ...checkBody, userId: client.id });
        expect(withTarget.body).toMatchObject({ available: true, totalConflicts: 0 });
        expect(await prisma.contract.count({ where: { id: a.body.contract.id } })).toBe(0);
        // O segundo (13:00) também era do cliente e estava vencido.
        expect(await prisma.contract.count({ where: { id: b.body.contract.id } })).toBe(0);

        // POST /custom do admin em nome do cliente: descarta antes de gerar as sessões.
        const c = await call('POST', '/api/contracts/custom', client, customBody({ schedule: [{ day: 2, time: '15:30' }] }));
        await expireContract(c.body.contract.id);
        const created = await call('POST', '/api/contracts/custom', admin, customBody({ userId: client.id, schedule: [{ day: 2, time: '15:30' }] }));
        expect(created.status).toBe(201);
        expect(created.body.status).toBe('ACTIVE');
        expect(created.body.skipped).toEqual([]);
        expect(await prisma.contract.count({ where: { id: c.body.contract.id } })).toBe(0);
    });
});

// ─── (3) Avulso: vigência e nome acompanham a gravação ──────────────────

async function seedAvulso(ymd: string, startTime: string, name?: string, status: 'CONFIRMED' | 'FALTA' = 'CONFIRMED') {
    const admin = await mkUser({ role: 'ADMIN' });
    const client = await mkUser();
    const contract = await mkContract(client.id, {
        type: 'AVULSO', durationMonths: 1, discountPct: 0, startDate: dbDate(ymd), endDate: dbDate(ymd),
        paymentPlan: 'FULL', flexCreditsTotal: 1, flexCreditsRemaining: 0,
        name: name ?? `Avulso ${ddmmyyyy(ymd)} as ${startTime}`,
    });
    const [h, m] = startTime.split(':').map(Number);
    const booking = await mkBooking(client.id, contract.id, {
        date: dbDate(ymd), startTime, endTime: `${String(h! + 2).padStart(2, '0')}:${String(m).padStart(2, '0')}`,
        tierApplied: 'COMERCIAL', status,
    });
    await mkPayment(client.id, { contractId: contract.id, bookingId: booking.id, status: 'PAID', amount: 30000, paidAt: new Date() });
    touched.push(booking.id);
    return { admin, client, contract, booking };
}

const contractOf = (id: string) => prisma.contract.findUniqueOrThrow({ where: { id } });

describe('avulso — startDate/endDate e nome acompanham a data/horário da gravação', () => {
    it('avulsoContractName: "Avulso DD/MM/AAAA às HH:MM"', () => {
        expect(avulsoContractName('2026-10-01', '18:00')).toBe('Avulso 01/10/2026 às 18:00');
        expect(avulsoContractName('2026-10-01', '18:00', 'as')).toBe('Avulso 01/10/2026 as 18:00');
    });

    it('PATCH /bookings/:id (admin) com date/startTime: vigência = nova data e nome refeito no formato já usado', async () => {
        const from = weekdayBetween(addDaysYmd(todaySp, 3), addDaysYmd(todaySp, 9));
        const to = weekdayBetween(addDaysYmd(from, 1), addDaysYmd(from, 7));
        const { admin, contract, booking } = await seedAvulso(from, '10:00');

        const r = await call('PATCH', `/api/bookings/${booking.id}`, admin, { date: to, startTime: '13:00' });
        expect(r.status).toBe(200);
        const c = await contractOf(contract.id);
        expect(c.startDate.toISOString()).toBe(dbDate(to).toISOString());
        expect(c.endDate.toISOString()).toBe(dbDate(to).toISOString());
        expect(c.name).toBe(`Avulso ${ddmmyyyy(to)} as 13:00`); // conector do nome existente preservado

        // Só o horário: o nome acompanha, a data fica.
        const r2 = await call('PATCH', `/api/bookings/${booking.id}`, admin, { startTime: '15:30' });
        expect(r2.status).toBe(200);
        expect((await contractOf(contract.id)).name).toBe(`Avulso ${ddmmyyyy(to)} as 15:30`);

        // PATCH sem data/horário (só notas) não mexe no contrato.
        const before = await contractOf(contract.id);
        const r3 = await call('PATCH', `/api/bookings/${booking.id}`, admin, { adminNotes: 'nota' });
        expect(r3.status).toBe(200);
        expect((await contractOf(contract.id)).updatedAt.getTime()).toBe(before.updatedAt.getTime());
    });

    it('nome com "às" continua com "às"; nome fora do padrão é mantido (só a vigência muda)', async () => {
        const from = weekdayBetween(addDaysYmd(todaySp, 3), addDaysYmd(todaySp, 9));
        const to = weekdayBetween(addDaysYmd(from, 1), addDaysYmd(from, 7));
        const a = await seedAvulso(from, '10:00', `Avulso ${ddmmyyyy(from)} às 10:00`);
        expect((await call('PATCH', `/api/bookings/${a.booking.id}`, a.admin, { date: to })).status).toBe(200);
        expect((await contractOf(a.contract.id)).name).toBe(`Avulso ${ddmmyyyy(to)} às 10:00`);

        const b = await seedAvulso(from, '13:00', 'Gravação especial do podcast');
        expect((await call('PATCH', `/api/bookings/${b.booking.id}`, b.admin, { date: to })).status).toBe(200);
        const cb = await contractOf(b.contract.id);
        expect(cb.name).toBe('Gravação especial do podcast');
        expect(cb.startDate.toISOString()).toBe(dbDate(to).toISOString());
    });

    it('outros tipos não mudam: PATCH admin movendo sessão de FLEX deixa o contrato como está', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser();
        const flex = await mkContract(client.id, { type: 'FLEX', durationMonths: 1, flexCreditsTotal: 4, flexCreditsRemaining: 3, name: `Avulso 01/01/2026 as 10:00` });
        const from = weekdayBetween(addDaysYmd(todaySp, 3), addDaysYmd(todaySp, 9));
        const to = weekdayBetween(addDaysYmd(from, 1), addDaysYmd(from, 7));
        const bk = await mkBooking(client.id, flex.id, { date: dbDate(from), startTime: '10:00', endTime: '12:00' });
        expect((await call('PATCH', `/api/bookings/${bk.id}`, admin, { date: to, startTime: '13:00' })).status).toBe(200);
        const c = await contractOf(flex.id);
        expect(c.name).toBe('Avulso 01/01/2026 as 10:00');
        expect(c.startDate.toISOString()).toBe(flex.startDate.toISOString());
        expect(c.endDate.toISOString()).toBe(flex.endDate.toISOString());
    });

    it('PATCH /bookings/:id/reschedule (cliente) sincroniza o avulso', async () => {
        const from = weekdayBetween(addDaysYmd(todaySp, 3), addDaysYmd(todaySp, 9));
        const to = weekdayBetween(addDaysYmd(from, 1), addDaysYmd(from, 7));
        const { client, contract, booking } = await seedAvulso(from, '10:00');
        const r = await call('PATCH', `/api/bookings/${booking.id}/reschedule`, client, { date: to, startTime: '15:30' });
        expect(r.status).toBe(200);
        const c = await contractOf(contract.id);
        expect(c.startDate.toISOString()).toBe(dbDate(to).toISOString());
        expect(c.endDate.toISOString()).toBe(dbDate(to).toISOString());
        expect(c.name).toBe(`Avulso ${ddmmyyyy(to)} as 15:30`);
    });

    it('PATCH /bookings/:id/makeup (falta justificada → remarcação) sincroniza o avulso', async () => {
        const D = addDaysYmd(todaySp, -1); // gravação perdida ontem
        const target = weekdayBetween(addDaysYmd(todaySp, 2), addDaysYmd(D, 7));
        const { admin, client, contract, booking } = await seedAvulso(D, '10:00');
        const falta = await call('PATCH', `/api/bookings/${booking.id}`, admin, { status: 'FALTA', statusReason: 'Doença', noShowJustified: true });
        expect(falta.status).toBe(200);
        expect(falta.body.booking.makeupStatus).toBe('OPEN');

        const m = await call('PATCH', `/api/bookings/${booking.id}/makeup`, client, { date: target, startTime: '13:00' });
        expect(m.status).toBe(200);
        const c = await contractOf(contract.id);
        expect(c.status).toBe('ACTIVE');
        expect(c.startDate.toISOString()).toBe(dbDate(target).toISOString());
        expect(c.endDate.toISOString()).toBe(dbDate(target).toISOString());
        expect(c.name).toBe(`Avulso ${ddmmyyyy(target)} as 13:00`);
    });
});

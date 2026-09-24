import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { prisma } from '../../src/lib/prisma';
import { redis } from '../../src/lib/redis';
import { config } from '../../src/config/index';
import { saoPauloParts } from '../../src/lib/spTime';
import { addDaysYmd, computeMakeupDeadline } from '../../src/lib/avulsoMakeup';
import bookingRoutes from '../../src/modules/bookings/routes';
import contractRoutes from '../../src/modules/contracts/routes';
import { mkUser, mkContract, mkBooking, mkPayment } from './factories';

// D4/D5/D6 pelas ROTAS reais (bookings + contracts) num app Express mínimo, com o relógio REAL.
// A lógica fina (prazo, concorrência, expiração) está em avulso-makeup.test.ts (viagem no tempo).

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
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

const touched: string[] = [];
afterEach(async () => {
    for (const id of touched.splice(0)) {
        const keys = [...await redis.keys(`makeup:*${id}*`), ...await redis.keys(`notif:dedup:makeup:*${id}*`)];
        if (keys.length) await redis.del(...keys);
    }
});

function cookie(u: { id: string; email: string | null; role: string }) {
    return `accessToken=${jwt.sign({ userId: u.id, email: u.email ?? '', role: u.role }, config.jwt.secret, { expiresIn: '1h' })}`;
}

async function call(method: string, path: string, who?: { id: string; email: string | null; role: string }, body?: unknown) {
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

// Datas relativas a HOJE no calendário de São Paulo (as rotas usam o relógio real).
const todaySp = saoPauloParts(new Date()).dateStr;
const dbDate = (ymd: string) => new Date(`${ymd}T00:00:00Z`);
const D = addDaysYmd(todaySp, -1);                          // gravação perdida: ontem
const dow = (ymd: string) => new Date(`${ymd}T12:00:00Z`).getUTCDay();
/** 1º dia útil (seg–sex, faixa COMERCIAL) em [from, to]. */
function weekdayBetween(from: string, to: string): string {
    for (let d = from; d <= to; d = addDaysYmd(d, 1)) if (dow(d) >= 1 && dow(d) <= 5) return d;
    throw new Error('sem dia útil no intervalo');
}
const TARGET = weekdayBetween(addDaysYmd(todaySp, 2), addDaysYmd(D, 7)); // dentro da janela e com ≥ 12h

async function seedAvulso(status: 'CONFIRMED' | 'FALTA' = 'CONFIRMED') {
    const admin = await mkUser({ role: 'ADMIN' });
    const client = await mkUser();
    const contract = await mkContract(client.id, {
        type: 'AVULSO', durationMonths: 1, discountPct: 0, startDate: dbDate(D), endDate: dbDate(D),
        paymentPlan: 'FULL', flexCreditsTotal: 1, flexCreditsRemaining: 0,
    });
    const booking = await mkBooking(client.id, contract.id, {
        date: dbDate(D), startTime: '10:00', endTime: '12:00', tierApplied: 'COMERCIAL', status,
    });
    await mkPayment(client.id, { contractId: contract.id, bookingId: booking.id, status: 'PAID', amount: 30000, paidAt: new Date() });
    touched.push(booking.id);
    return { admin, client, contract, booking };
}

const contractStatus = async (id: string) => (await prisma.contract.findUniqueOrThrow({ where: { id } })).status;

describe('PATCH /api/bookings/:id — noShowJustified e NAO_REALIZADO (admin)', () => {
    it('FALTA + noShowJustified abre a janela; os GETs do cliente trazem os campos novos', async () => {
        const { admin, client, contract, booking } = await seedAvulso();
        const r = await call('PATCH', `/api/bookings/${booking.id}`, admin, { status: 'FALTA', statusReason: 'Cliente avisou doença', noShowJustified: true });
        expect(r.status).toBe(200);
        expect(r.body.booking.makeupStatus).toBe('OPEN');
        expect(r.body.booking.makeupDeadline).toBe(computeMakeupDeadline(dbDate(D), 7).toISOString());
        expect(await contractStatus(contract.id)).toBe('ACTIVE');

        const my = await call('GET', '/api/bookings/my', client);
        const mine = my.body.bookings.find((b: any) => b.id === booking.id);
        expect(mine).toMatchObject({ makeupStatus: 'OPEN', statusReason: 'Cliente avisou doença' });
        expect(mine.missedDate.slice(0, 10)).toBe(D);
        const one = await call('GET', `/api/bookings/${booking.id}`, client);
        expect(one.body.booking).toMatchObject({ makeupStatus: 'OPEN', statusReason: 'Cliente avisou doença' });
        const cmy = await call('GET', '/api/contracts/my', client);
        expect(cmy.body.contracts[0].bookings[0]).toMatchObject({ makeupStatus: 'OPEN', statusReason: 'Cliente avisou doença' });
        const cid = await call('GET', `/api/contracts/${contract.id}`, admin);
        expect(cid.body.contract.bookings[0].makeupStatus).toBe('OPEN');
    });

    it('noShowJustified inválido (contrato FLEX) → 400 SEM trocar o status', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser();
        const flex = await mkContract(client.id, { type: 'FLEX', flexCreditsTotal: 12, flexCreditsRemaining: 11 });
        const b = await mkBooking(client.id, flex.id, { date: dbDate(D), status: 'CONFIRMED' });
        const r = await call('PATCH', `/api/bookings/${b.id}`, admin, { status: 'FALTA', noShowJustified: true });
        expect(r.status).toBe(400);
        expect((await prisma.booking.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('CONFIRMED');
    });

    it('FALTA sem justificativa → contrato avulso COMPLETED na hora', async () => {
        const { admin, contract, booking } = await seedAvulso();
        const r = await call('PATCH', `/api/bookings/${booking.id}`, admin, { status: 'FALTA', statusReason: 'Não compareceu' });
        expect(r.status).toBe(200);
        expect(r.body.booking.makeupStatus).toBeNull();
        expect(await contractStatus(contract.id)).toBe('COMPLETED');
    });

    it('NAO_REALIZADO abre a janela sozinho; admin remarca e o crédito devolvido é consumido de volta', async () => {
        const { admin, contract, booking } = await seedAvulso();
        const r = await call('PATCH', `/api/bookings/${booking.id}`, admin, { status: 'NAO_REALIZADO', statusReason: 'Queda de energia' });
        expect(r.status).toBe(200);
        expect(r.body.booking.makeupStatus).toBe('OPEN');
        expect((await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } })).flexCreditsRemaining).toBe(1);
        expect(await contractStatus(contract.id)).toBe('ACTIVE');

        const m = await call('PATCH', `/api/bookings/${booking.id}/makeup`, admin, { date: TARGET, startTime: '13:00' });
        expect(m.status).toBe(200);
        expect(m.body.booking).toMatchObject({ status: 'CONFIRMED', makeupStatus: 'USED', startTime: '13:00' });
        expect((await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } })).flexCreditsRemaining).toBe(0);
    });
});

describe('PATCH /api/bookings/:id/makeup + conclusão do contrato', () => {
    it('cliente remarca (mesmo Payment) → finaliza → contrato COMPLETED → reabrir volta a ACTIVE', async () => {
        const { admin, client, contract, booking } = await seedAvulso();
        await call('PATCH', `/api/bookings/${booking.id}`, admin, { status: 'FALTA', noShowJustified: true });

        const stranger = await mkUser();
        expect((await call('PATCH', `/api/bookings/${booking.id}/makeup`, stranger, { date: TARGET, startTime: '10:00' })).status).toBe(404);
        expect((await call('PATCH', `/api/bookings/${booking.id}/makeup`, client, { date: TARGET })).status).toBe(400);
        expect((await call('PATCH', `/api/bookings/${booking.id}/makeup`, undefined, { date: TARGET, startTime: '10:00' })).status).toBe(401);

        const m = await call('PATCH', `/api/bookings/${booking.id}/makeup`, client, { date: TARGET, startTime: '10:00' });
        expect(m.status).toBe(200);
        expect(m.body.message).toMatch(/sem novo pagamento/);
        expect(m.body.booking).toMatchObject({ status: 'CONFIRMED', makeupStatus: 'USED', startTime: '10:00' });
        expect(m.body.booking.date.slice(0, 10)).toBe(TARGET);
        expect(await prisma.payment.count({ where: { bookingId: booking.id } })).toBe(1);

        const again = await call('PATCH', `/api/bookings/${booking.id}/makeup`, client, { date: TARGET, startTime: '13:00' });
        expect(again.status).toBe(400);

        expect((await call('PUT', `/api/bookings/${booking.id}/start-recording`, admin)).status).toBe(200);
        expect((await call('PUT', `/api/bookings/${booking.id}/complete`, admin, {})).status).toBe(200);
        expect(await contractStatus(contract.id)).toBe('COMPLETED');

        expect((await call('PATCH', `/api/bookings/${booking.id}`, admin, { status: 'CONFIRMED' })).status).toBe(200);
        expect(await contractStatus(contract.id)).toBe('ACTIVE');
    });

    it('cliente cancela com menos de 24h (DELETE) → FALTA sem justificativa → contrato COMPLETED', async () => {
        const client = await mkUser();
        const contract = await mkContract(client.id, { type: 'AVULSO', durationMonths: 1, discountPct: 0, flexCreditsTotal: 1, flexCreditsRemaining: 0 });
        const soon = saoPauloParts(new Date(Date.now() + 2 * 3600_000));
        const hh = String(soon.hour).padStart(2, '0');
        const b = await mkBooking(client.id, contract.id, { date: dbDate(soon.dateStr), startTime: `${hh}:00`, endTime: `${hh}:59`, status: 'CONFIRMED' });
        const r = await call('DELETE', `/api/bookings/${b.id}`, client);
        expect(r.status).toBe(200);
        expect((await prisma.booking.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('FALTA');
        expect(await contractStatus(contract.id)).toBe('COMPLETED');
    });
});

describe('regressões das rotas tocadas', () => {
    it('PATCH /:id/reschedule (refatorado para o helper compartilhado) move e recusa conflito', async () => {
        const client = await mkUser();
        const flex = await mkContract(client.id, { type: 'FLEX', flexCreditsTotal: 12, flexCreditsRemaining: 10 });
        const from = weekdayBetween(addDaysYmd(todaySp, 3), addDaysYmd(todaySp, 9));
        const to = weekdayBetween(addDaysYmd(from, 1), addDaysYmd(from, 7));
        const b = await mkBooking(client.id, flex.id, { date: dbDate(from), startTime: '10:00', endTime: '12:00', status: 'CONFIRMED' });
        const other = await mkBooking(client.id, flex.id, { date: dbDate(to), startTime: '13:00', endTime: '15:00', status: 'CONFIRMED' });

        const clash = await call('PATCH', `/api/bookings/${b.id}/reschedule`, client, { date: to, startTime: '13:00' });
        expect(clash.status).toBe(409);
        const tier = await call('PATCH', `/api/bookings/${b.id}/reschedule`, client, { date: to, startTime: '18:00' });
        expect(tier.status).toBe(400);
        const ok = await call('PATCH', `/api/bookings/${b.id}/reschedule`, client, { date: to, startTime: '10:00' });
        expect(ok.status).toBe(200);
        expect(ok.body.booking.date.slice(0, 10)).toBe(to);
        expect((await prisma.booking.findUniqueOrThrow({ where: { id: b.id } })).originalDate?.toISOString().slice(0, 10)).toBe(from);
        expect(other.id).toBeTruthy();
    });

    it('POST /api/bookings/admin avulso: vigência = dia da gravação, plano FULL e PIX no provedor resolvido (não CORA fixo)', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser();
        const day = weekdayBetween(addDaysYmd(todaySp, 2), addDaysYmd(todaySp, 8));
        const r = await call('POST', '/api/bookings/admin', admin, { userId: client.id, date: day, startTime: '15:30', paymentMethod: 'PIX' });
        expect(r.status).toBe(201);
        const booking = await prisma.booking.findUniqueOrThrow({ where: { id: r.body.booking.id }, include: { contract: true, payments: true } });
        expect(booking.contract.type).toBe('AVULSO');
        expect(booking.contract.paymentPlan).toBe('FULL');
        expect(booking.contract.endDate.getTime()).toBe(booking.contract.startDate.getTime());
        expect(booking.payments[0].provider).toBe('SICOOB'); // sem integração habilitada no DB de teste → padrão do PROVIDER_MAP
    });
});

// ─── Correções da revisão (fx-status) pelas rotas reais ─────────────────────

describe('fx-status: remarcação × cancelamento, desfazer falta e forma de pagamento do avulso do admin', () => {
    it('status-remarcacao-1: DELETE /contracts/:id (cancelado) → PATCH /bookings/:id/makeup devolve 400 e nada muda', async () => {
        const { admin, client, contract, booking } = await seedAvulso();
        await call('PATCH', `/api/bookings/${booking.id}`, admin, { status: 'FALTA', noShowJustified: true });
        const del = await call('DELETE', `/api/contracts/${contract.id}`, admin);
        expect(del.status).toBe(200);
        expect(await contractStatus(contract.id)).toBe('CANCELLED');

        const m = await call('PATCH', `/api/bookings/${booking.id}/makeup`, client, { date: TARGET, startTime: '10:00' });
        expect(m.status).toBe(400);
        expect(m.body.error).toMatch(/cancelado ou encerrado/);
        const byAdmin = await call('PATCH', `/api/bookings/${booking.id}/makeup`, admin, { date: TARGET, startTime: '10:00' });
        expect(byAdmin.status).toBe(400);
        const b = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
        expect(b.status).toBe('FALTA');
        expect(b.date.toISOString().slice(0, 10)).toBe(D);
    });

    it('status-remarcacao-3: Falta justificada → Confirmado com a MESMA data/horário (como o modal manda) desfaz a justificativa; mudar a data gasta a remarcação', async () => {
        const { admin, booking } = await seedAvulso();
        await call('PATCH', `/api/bookings/${booking.id}`, admin, { status: 'FALTA', noShowJustified: true });
        const undo = await call('PATCH', `/api/bookings/${booking.id}`, admin, { status: 'CONFIRMED', date: D, startTime: '10:00' });
        expect(undo.status).toBe(200);
        expect(undo.body.booking).toMatchObject({ status: 'CONFIRMED', makeupStatus: null, makeupDeadline: null, missedDate: null, originalDate: null });

        // A remarcação única continua disponível: nova falta justificada é aceita.
        const again = await call('PATCH', `/api/bookings/${booking.id}`, admin, { status: 'FALTA', noShowJustified: true });
        expect(again.status).toBe(200);
        expect(again.body.booking.makeupStatus).toBe('OPEN');

        // Agora com data diferente na mesma edição → remarcada "à mão" (USED).
        const moved = await call('PATCH', `/api/bookings/${booking.id}`, admin, { status: 'CONFIRMED', date: TARGET, startTime: '10:00' });
        expect(moved.status).toBe(200);
        expect(moved.body.booking.makeupStatus).toBe('USED');
    });

    it('status-remarcacao-10: POST /api/bookings/admin avulso grava a forma de pagamento no contrato', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser();
        const day = weekdayBetween(addDaysYmd(todaySp, 2), addDaysYmd(todaySp, 8));
        const pix = await call('POST', '/api/bookings/admin', admin, { userId: client.id, date: day, startTime: '10:00', paymentMethod: 'PIX' });
        expect(pix.status).toBe(201);
        const card = await call('POST', '/api/bookings/admin', admin, { userId: client.id, date: day, startTime: '13:00' }); // default CARTAO
        expect(card.status).toBe(201);
        const methods = await Promise.all([pix, card].map(async r =>
            (await prisma.booking.findUniqueOrThrow({ where: { id: r.body.booking.id }, include: { contract: true } })).contract.paymentMethod));
        expect(methods).toEqual(['PIX', 'CARTAO']);
    });
});

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { prisma } from '../../src/lib/prisma';
import { redis } from '../../src/lib/redis';
import { config } from '../../src/config/index';
import { saoPauloParts } from '../../src/lib/spTime';
import * as sicoob from '../../src/lib/sicoobService';
import * as stripe from '../../src/lib/stripeService';
import { deleteUser } from '../../src/lib/userDeletion';
import { openMakeupWindow } from '../../src/lib/avulsoMakeup';
import authRoutes from '../../src/modules/auth/routes';
import userRoutes from '../../src/modules/users/routes';
import contractRoutes from '../../src/modules/contracts/routes';
import bookingRoutes from '../../src/modules/bookings/routes';
import { mkUser, mkContract, mkPayment, mkBooking } from './factories';

// Rodada final (frente final-users-contracts):
//  • contratos-6: /renew e /resume tratam datas SEM hora (meia-noite UTC) pelo ISO — com o servidor em
//    TZ=UTC o saoPauloParts dava o DIA ANTERIOR (1ª sessão antes do início; fim um dia mais curto).
//    Rode este arquivo também com TZ=UTC.
//  • exclusao-auth-1: PIX avulso que continua pagável no provedor ('live') → 409, nada é anulado.
//  • exclusao-auth-2: refresh e login durante a exclusão são recusados; revogação final (com folga)
//    após o commit.
//  • cliente EXCLUÍDO: sem obrigação nova (POST /bookings/admin, PATCH /bookings/:id, remarcação do
//    avulso, reativar/retomar contrato); GET /contracts traz user.deletedAt; GET /users traz endDate.

vi.mock('../../src/lib/sicoobService', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../../src/lib/sicoobService')>();
    return {
        ...orig,
        getSicoobEnvironment: vi.fn(async () => 'production'),
        sicoobGetCob: vi.fn(),
        sicoobRemoveCob: vi.fn(async () => true),
    };
});

vi.mock('../../src/lib/stripeService', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../../src/lib/stripeService')>();
    return {
        ...orig,
        isStripeEnabled: vi.fn(async () => true),
        stripeGetPaymentIntent: vi.fn(),
        stripeCancelPaymentIntent: vi.fn(async () => ({ status: 'canceled', canceled: true })),
        stripeDetachPaymentMethod: vi.fn(async () => {}),
        stripeCancelSubscription: vi.fn(async () => {}),
    };
});

const getCob = vi.mocked(sicoob.sicoobGetCob);
const removeCob = vi.mocked(sicoob.sicoobRemoveCob);
const getPI = vi.mocked(stripe.stripeGetPaymentIntent);

let server: Server;
let base = '';
const touchedUsers: string[] = [];

beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/auth', authRoutes);
    app.use('/api/users', userRoutes);
    app.use('/api/contracts', contractRoutes);
    app.use('/api/bookings', bookingRoutes);
    await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(async () => {
    vi.clearAllMocks();
    removeCob.mockImplementation(async () => true);
    const keys = touchedUsers.splice(0).map(id => `auth:revoked:${id}`);
    if (keys.length) await redis.del(...keys);
});

const nowSec = () => Math.floor(Date.now() / 1000);

function accessCookie(u: { id: string; email: string | null; role: string }, iat?: number) {
    const payload = { userId: u.id, email: u.email ?? '', role: u.role, ...(iat ? { iat } : {}) };
    return `accessToken=${jwt.sign(payload, config.jwt.secret, { expiresIn: '1h' })}`;
}

function refreshCookie(u: { id: string; email: string | null; role: string }, iat?: number) {
    const payload = { userId: u.id, email: u.email ?? '', role: u.role, ...(iat ? { iat } : {}) };
    return `refreshToken=${jwt.sign(payload, config.jwt.refreshSecret, { expiresIn: '1d' })}`;
}

async function call(method: string, path: string, cookie?: string, body?: unknown) {
    const res = await fetch(`${base}${path}`, {
        method,
        headers: {
            ...(cookie ? { Cookie: cookie } : {}),
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) as any, setCookie: res.headers.get('set-cookie') ?? '' };
}

/** 'YYYY-MM-DD' do próximo `dow` (0..6) a pelo menos `minDays` dias de hoje (calendário SP). */
function nextWeekday(dow: number, minDays: number): string {
    const sp = saoPauloParts(new Date());
    const d = new Date(Date.UTC(sp.y, sp.m - 1, sp.day + minDays));
    while (d.getUTCDay() !== dow) d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
}

const addDays = (ymd: string, n: number) => {
    const d = new Date(ymd + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
};
const ymd = (d: Date) => d.toISOString().slice(0, 10);

// ─── contratos-6 ─────────────────────────────────────────────────────────────

describe('renovar/retomar FIXO: datas sem hora (meia-noite UTC) viram o dia certo em qualquer fuso', () => {
    it(`renovar a partir do endDate 00:00Z (terça) → 1ª sessão na segunda SEGUINTE, nunca antes do início (TZ=${process.env.TZ ?? 'host'})`, async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser();
        const tuesday = nextWeekday(2, 14);
        const original = await mkContract(client.id, {
            type: 'FIXO', fixedDayOfWeek: 1, fixedTime: '10:00', status: 'EXPIRED',
            startDate: new Date('2026-06-02T00:00:00Z'), endDate: new Date(tuesday + 'T00:00:00Z'),
        });
        const r = await call('POST', `/api/contracts/${original.id}/renew`, accessCookie(admin), { durationMonths: 3 });
        expect(r.status).toBe(201);
        const renewed = await prisma.contract.findUniqueOrThrow({ where: { id: r.body.contract.id } });
        expect(ymd(renewed.startDate)).toBe(tuesday);
        const mine = await prisma.booking.findMany({ where: { contractId: renewed.id }, orderBy: { date: 'asc' } });
        expect(mine).toHaveLength(12);
        // Antes da correção (TZ=UTC): 1ª sessão = a segunda ANTERIOR ao início (tuesday - 1).
        expect(ymd(mine[0].date)).toBe(addDays(tuesday, 6));
        expect(mine.every(b => ymd(b.date) >= tuesday && b.date.getUTCDay() === 1 && b.startTime === '10:00')).toBe(true);
        expect(mine.every(b => b.date < renewed.endDate)).toBe(true);
    });

    it('renovar com startDate informado (terça) → 1ª sessão na segunda seguinte; startDate inválido → 400', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser();
        const original = await mkContract(client.id, {
            type: 'FIXO', fixedDayOfWeek: 1, fixedTime: '13:00', status: 'ACTIVE',
            startDate: new Date('2026-06-02T00:00:00Z'), endDate: new Date(nextWeekday(2, 7) + 'T00:00:00Z'),
        });
        const bad = await call('POST', `/api/contracts/${original.id}/renew`, accessCookie(admin), { durationMonths: 3, startDate: '12/01/2027' });
        expect(bad.status).toBe(400);
        expect(await prisma.contract.count({ where: { renewedFromId: original.id } })).toBe(0);

        const start = nextWeekday(2, 30);
        const r = await call('POST', `/api/contracts/${original.id}/renew`, accessCookie(admin), { durationMonths: 3, startDate: start });
        expect(r.status).toBe(201);
        const renewed = await prisma.contract.findUniqueOrThrow({ where: { id: r.body.contract.id } });
        expect(ymd(renewed.startDate)).toBe(start);
        const mine = await prisma.booking.findMany({ where: { contractId: renewed.id }, orderBy: { date: 'asc' } });
        expect(ymd(mine[0].date)).toBe(addDays(start, 6));
        expect(mine.every(b => ymd(b.date) >= start)).toBe(true);
    });

    it('retomar: o último dia fixo antes do novo endDate (00:00Z) entra — o fim não perde um dia', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser();
        const now = new Date();
        const thursday = nextWeekday(4, 15);
        const paused = await mkContract(client.id, {
            type: 'FIXO', fixedDayOfWeek: 3, fixedTime: '13:00', status: 'PAUSED', pausedAt: now, durationMonths: 3,
            startDate: new Date(now.getTime() - 7 * 86_400_000), endDate: new Date(thursday + 'T00:00:00Z'),
        });
        const r = await call('PATCH', `/api/contracts/${paused.id}/resume`, accessCookie(admin));
        expect(r.status).toBe(200);
        const updated = await prisma.contract.findUniqueOrThrow({ where: { id: paused.id } });
        expect(ymd(updated.endDate)).toBe(thursday); // pausado 0 dias
        const mine = await prisma.booking.findMany({ where: { contractId: paused.id, status: { not: 'CANCELLED' } }, orderBy: { date: 'asc' } });
        expect(mine.length).toBeGreaterThan(0);
        expect(mine.every(b => b.date.getUTCDay() === 3 && b.startTime === '13:00')).toBe(true);
        // Antes da correção (qualquer fuso): untilStr = quarta (dia anterior ao endDate), exclusivo → a
        // quarta-feira da véspera do fim ficava de fora.
        expect(ymd(mine[mine.length - 1].date)).toBe(addDays(thursday, -1));
    });
});

// ─── exclusao-auth-1 ─────────────────────────────────────────────────────────

const TX_AVULSA_VIVA = 'TXAVULSAVIVAFINAL0000000000001';

describe('exclusão: PIX avulso que continua pagável no provedor', () => {
    it("retirePixCharge 'live' (Sicoob fora do ar, cob não removida) → 409 e NADA é anulado", async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser({ autoChargeEnabled: true });
        touchedUsers.push(client.id);
        const pix = await mkPayment(client.id, { provider: 'SICOOB', providerRef: TX_AVULSA_VIVA, amount: 30000, pixString: '000201…' });
        getCob.mockImplementation(async () => { throw new Error('connect ETIMEDOUT'); });
        removeCob.mockImplementation(async () => false);

        const session = accessCookie(client);
        const del = await call('DELETE', `/api/users/${client.id}`, accessCookie(admin));
        expect(del.status).toBe(409);
        expect(del.body.error).toContain('em processamento no provedor');
        expect(removeCob).toHaveBeenCalledWith(TX_AVULSA_VIVA);

        expect((await prisma.payment.findUniqueOrThrow({ where: { id: pix.id } })).status).toBe('PENDING');
        const u = await prisma.user.findUniqueOrThrow({ where: { id: client.id } });
        expect(u.deletedAt).toBeNull();
        expect(u.autoChargeEnabled).toBe(true);
        // Exclusão não aconteceu → a sessão do cliente volta a valer.
        expect(await redis.get(`auth:revoked:${client.id}`)).toBeNull();
        expect((await call('GET', '/api/auth/me', session)).status).toBe(200);
    });
});

// ─── exclusao-auth-2 ─────────────────────────────────────────────────────────

describe('exclusão × refresh: sessão nenhuma sobrevive', () => {
    it('refresh NO MEIO da exclusão → 401 (sem token novo); depois do commit a revogação final tem folga', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser();
        touchedUsers.push(client.id);
        await mkPayment(client.id, { provider: 'STRIPE', providerRef: 'pi_slow_final', amount: 7000 });
        getPI.mockImplementation(async (id: string) => {
            await new Promise(r => setTimeout(r, 1500));
            return { id, status: 'requires_payment_method', amount: 7000, created: nowSec(), metadata: {} } as any;
        });

        const oldRefresh = refreshCookie(client, nowSec() - 30);
        // Sanidade: o refresh token é válido antes da exclusão.
        const before = await call('POST', '/api/auth/refresh', oldRefresh);
        expect(before.status).toBe(200);

        const deletion = deleteUser(client.id, admin.id);
        await new Promise(r => setTimeout(r, 400)); // a exclusão está conciliando no provedor (deletedAt ainda null)
        expect((await prisma.user.findUniqueOrThrow({ where: { id: client.id } })).deletedAt).toBeNull();
        const mid = await call('POST', '/api/auth/refresh', oldRefresh);
        expect(mid.status).toBe(401);
        expect(mid.body.error).toBe('Sessão encerrada. Faça login novamente.');
        expect(mid.setCookie).not.toMatch(/accessToken=/);

        const res = await deletion;
        expect(res.softDeleted).toBe(true);

        // Revogação final (depois do commit) com folga: um token assinado LOGO DEPOIS por um handler que
        // leu o usuário antes do deletedAt também é recusado já no authenticate.
        const revokedAt = Number(await redis.get(`auth:revoked:${client.id}`));
        expect(revokedAt).toBeGreaterThanOrEqual(nowSec() + 55);
        const lateSigned = accessCookie(client, nowSec() + 5);
        const me = await call('GET', '/api/auth/me', lateSigned);
        expect(me.status).toBe(401);
        expect(me.body.error).toBe('Sessão encerrada. Faça login novamente.');
        expect((await call('POST', '/api/auth/refresh', oldRefresh)).body.error).toBe('Conta não encontrada.');
    });

    it('login (senha) NO MEIO da exclusão → 409 sem sessão; fora dela o login é normal', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const email = `login-mid-${Date.now()}@example.com`;
        const client = await mkUser({ email, passwordHash: await bcrypt.hash('segredo123', 4) });
        touchedUsers.push(client.id);
        // Sanidade: antes da exclusão o login funciona.
        const ok = await call('POST', '/api/auth/login', undefined, { email, password: 'segredo123' });
        expect(ok.status).toBe(200);
        expect(ok.setCookie).toMatch(/accessToken=/);

        await mkPayment(client.id, { provider: 'STRIPE', providerRef: 'pi_slow_login', amount: 7000 });
        getPI.mockImplementation(async (id: string) => {
            await new Promise(r => setTimeout(r, 1500));
            return { id, status: 'requires_payment_method', amount: 7000, created: nowSec(), metadata: {} } as any;
        });
        const deletion = deleteUser(client.id, admin.id);
        await new Promise(r => setTimeout(r, 400)); // conciliando no provedor (deletedAt ainda null)
        expect((await prisma.user.findUniqueOrThrow({ where: { id: client.id } })).deletedAt).toBeNull();
        const mid = await call('POST', '/api/auth/login', undefined, { email, password: 'segredo123' });
        expect(mid.status).toBe(409);
        expect(mid.body.error).toMatch(/sendo atualizada/);
        expect(mid.setCookie).not.toMatch(/accessToken=/);

        expect((await deletion).softDeleted).toBe(true);
        // Depois: conta anonimizada (e-mail liberado) → o login não acha ninguém.
        expect((await call('POST', '/api/auth/login', undefined, { email, password: 'segredo123' })).status).toBe(401);
    });

    it('hard delete também grava a revogação final com folga', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser();
        touchedUsers.push(client.id);
        const del = await call('DELETE', `/api/users/${client.id}`, accessCookie(admin));
        expect(del.status).toBe(200);
        expect(del.body.softDeleted).toBe(false);
        expect(Number(await redis.get(`auth:revoked:${client.id}`))).toBeGreaterThanOrEqual(nowSec() + 55);
    });

    it('bloqueio: refresh token anterior não renova nem depois de desbloquear; login novo (iat posterior) renova', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser();
        touchedUsers.push(client.id);
        const oldRefresh = refreshCookie(client, nowSec() - 30);
        expect((await call('PATCH', `/api/users/${client.id}`, accessCookie(admin), { clientStatus: 'BLOCKED' })).status).toBe(200);
        expect((await call('POST', '/api/auth/refresh', oldRefresh)).status).toBe(403); // bloqueado: mensagem própria
        expect((await call('PATCH', `/api/users/${client.id}`, accessCookie(admin), { clientStatus: 'ACTIVE' })).status).toBe(200);
        const stale = await call('POST', '/api/auth/refresh', oldRefresh);
        expect(stale.status).toBe(401);
        expect(stale.body.error).toBe('Sessão encerrada. Faça login novamente.');
        const fresh = await call('POST', '/api/auth/refresh', refreshCookie(client, nowSec() + 2));
        expect(fresh.status).toBe(200);
        expect(fresh.setCookie).toMatch(/accessToken=/);
    });
});

// ─── cliente EXCLUÍDO: sem obrigação nova ────────────────────────────────────

async function mkDeletedClient() {
    const client = await mkUser();
    return prisma.user.update({ where: { id: client.id }, data: { deletedAt: new Date(), email: null } });
}

describe('cliente EXCLUÍDO: nenhuma obrigação nova', () => {
    it('POST /bookings/admin → 409 "Este cliente foi excluído." e nada é criado', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const gone = await mkDeletedClient();
        const r = await call('POST', '/api/bookings/admin', accessCookie(admin), { userId: gone.id, date: nextWeekday(2, 10), startTime: '10:00' });
        expect(r.status).toBe(409);
        expect(r.body.error).toBe('Este cliente foi excluído.');
        expect(r.body.code).toBe('CLIENT_DELETED');
        expect(await prisma.booking.count({ where: { userId: gone.id } })).toBe(0);
        expect(await prisma.contract.count({ where: { userId: gone.id } })).toBe(0);
    });

    it('PATCH /bookings/:id: reabrir, remarcar gravação ativa e justificar falta → 409; notas continuam editáveis', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const gone = await mkDeletedClient();
        const c = await mkContract(gone.id, { type: 'FIXO', status: 'CANCELLED' });
        const future = nextWeekday(2, 10);
        const cancelled = await mkBooking(gone.id, c.id, { date: new Date(future + 'T00:00:00Z'), startTime: '10:00', endTime: '12:00', status: 'CANCELLED' });
        const startedToday = await mkBooking(gone.id, c.id, { date: new Date(saoPauloParts(new Date()).dateStr + 'T00:00:00Z'), startTime: '10:00', endTime: '12:00', status: 'CONFIRMED' });

        const reopen = await call('PATCH', `/api/bookings/${cancelled.id}`, accessCookie(admin), { status: 'CONFIRMED' });
        expect(reopen.status).toBe(409);
        expect(reopen.body.error).toMatch(/^Este cliente foi excluído\./);
        const move = await call('PATCH', `/api/bookings/${startedToday.id}`, accessCookie(admin), { date: future, startTime: '13:00' });
        expect(move.status).toBe(409);
        const justify = await call('PATCH', `/api/bookings/${startedToday.id}`, accessCookie(admin), { status: 'FALTA', statusReason: 'x', noShowJustified: true });
        expect(justify.status).toBe(409);
        expect((await prisma.booking.findUniqueOrThrow({ where: { id: cancelled.id } })).status).toBe('CANCELLED');
        const today = await prisma.booking.findUniqueOrThrow({ where: { id: startedToday.id } });
        expect(today.status).toBe('CONFIRMED');
        expect(ymd(today.date)).toBe(saoPauloParts(new Date()).dateStr);

        const notes = await call('PATCH', `/api/bookings/${startedToday.id}`, accessCookie(admin), { adminNotes: 'gravou normalmente' });
        expect(notes.status).toBe(200);
    });

    it('remarcação do avulso (inclusive o override do admin no NAO_REALIZADO) → 409; janela não abre', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const gone = await mkDeletedClient();
        const avulso = await mkContract(gone.id, { type: 'AVULSO', status: 'COMPLETED', durationMonths: 1, paymentPlan: 'FULL' });
        const missed = await mkBooking(gone.id, avulso.id, {
            date: new Date(addDays(saoPauloParts(new Date()).dateStr, -1) + 'T00:00:00Z'), startTime: '10:00', endTime: '12:00',
            status: 'NAO_REALIZADO', makeupStatus: 'EXPIRED',
        });
        await mkPayment(gone.id, { contractId: avulso.id, bookingId: missed.id, status: 'PAID', provider: 'STRIPE', amount: 30000 });

        const r = await call('PATCH', `/api/bookings/${missed.id}/makeup`, accessCookie(admin), { date: nextWeekday(2, 3), startTime: '10:00' });
        expect(r.status).toBe(409);
        expect(r.body.error).toMatch(/^Este cliente foi excluído\./);
        expect((await prisma.booking.findUniqueOrThrow({ where: { id: missed.id } })).status).toBe('NAO_REALIZADO');

        await prisma.booking.update({ where: { id: missed.id }, data: { makeupStatus: null } });
        expect(await openMakeupWindow(missed.id, 'NAO_REALIZADO', { actorId: admin.id })).toBeNull();
        expect((await prisma.booking.findUniqueOrThrow({ where: { id: missed.id } })).makeupStatus).toBeNull();
    });

    it('contratos: GET / traz user.deletedAt; PATCH não reativa nem muda créditos; resume → 409; link continua editável', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const gone = await mkDeletedClient();
        const alive = await mkUser();
        const cancelledFlex = await mkContract(gone.id, { type: 'FLEX', status: 'CANCELLED', flexCreditsTotal: 12, flexCreditsRemaining: 5 });
        const pausedFixo = await mkContract(gone.id, { type: 'FIXO', status: 'PAUSED', fixedDayOfWeek: 1, fixedTime: '10:00', pausedAt: new Date() });
        const aliveContract = await mkContract(alive.id);

        const list = await call('GET', '/api/contracts', accessCookie(admin));
        expect(list.status).toBe(200);
        const byId = new Map<string, any>(list.body.contracts.map((c: any) => [c.id, c]));
        expect(byId.get(cancelledFlex.id).user.deletedAt).toBeTruthy();
        expect(byId.get(aliveContract.id).user.deletedAt).toBeNull();
        expect((await call('GET', `/api/contracts/${cancelledFlex.id}`, accessCookie(admin))).body.contract.user.deletedAt).toBeTruthy();

        const reactivate = await call('PATCH', `/api/contracts/${cancelledFlex.id}`, accessCookie(admin), { status: 'ACTIVE' });
        expect(reactivate.status).toBe(409);
        expect(reactivate.body.code).toBe('CLIENT_DELETED');
        const credits = await call('PATCH', `/api/contracts/${cancelledFlex.id}`, accessCookie(admin), { flexCreditsRemaining: 8 });
        expect(credits.status).toBe(409);
        // O "Editar" da lista reenvia os créditos atuais: sem mudança, só o link é salvo.
        const link = await call('PATCH', `/api/contracts/${cancelledFlex.id}`, accessCookie(admin), { contractUrl: 'https://example.com/c.pdf', flexCreditsRemaining: 5 });
        expect(link.status).toBe(200);
        const after = await prisma.contract.findUniqueOrThrow({ where: { id: cancelledFlex.id } });
        expect(after.status).toBe('CANCELLED');
        expect(after.flexCreditsRemaining).toBe(5);
        expect(after.contractUrl).toBe('https://example.com/c.pdf');

        const resume = await call('PATCH', `/api/contracts/${pausedFixo.id}/resume`, accessCookie(admin));
        expect(resume.status).toBe(409);
        expect((await prisma.contract.findUniqueOrThrow({ where: { id: pausedFixo.id } })).status).toBe('PAUSED');
        expect(await prisma.booking.count({ where: { contractId: pausedFixo.id } })).toBe(0);
    });
});

// ─── regressoes-6 ────────────────────────────────────────────────────────────

describe('GET /api/users: contratos com endDate e durationMonths', () => {
    it('a listagem traz o que o isPlanInForce precisa (plano Concluído recente × antigo)', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser();
        await mkContract(client.id, { type: 'FIXO', status: 'COMPLETED', durationMonths: 3, endDate: new Date('2025-01-10T00:00:00Z') });
        const r = await call('GET', '/api/users', accessCookie(admin));
        expect(r.status).toBe(200);
        const u = r.body.users.find((x: any) => x.id === client.id);
        expect(u.contracts).toHaveLength(1);
        expect(u.contracts[0]).toMatchObject({ type: 'FIXO', status: 'COMPLETED', durationMonths: 3 });
        expect(u.contracts[0].endDate.slice(0, 10)).toBe('2025-01-10');
    });
});

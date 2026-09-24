import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { prisma } from '../../src/lib/prisma';
import { config } from '../../src/config/index';
import { saoPauloParts } from '../../src/lib/spTime';
import contractRoutes from '../../src/modules/contracts/routes';
import { mkUser, mkContract, mkBooking } from './factories';

// D8 (grade de horários de contrato) + D7/D9 (personalizado: restrições do cliente, fluxo de
// pagamento admin × cliente, CPF antes de criar, anti-overbooking). Exercita as ROTAS reais.

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
    // Formas de pagamento ativas (sem IntegrationConfig → em dev/test não filtra por provedor; PIX cai no mock).
    for (const [i, key] of ['PIX', 'CARTAO', 'BOLETO'].entries()) {
        await prisma.paymentMethodConfig.create({
            data: { key, label: key, shortLabel: key, emoji: '-', description: key, color: '#000000', active: true, sortOrder: i },
        });
    }
});

const VALID_CPF = '52998224725';

function cookieFor(u: { id: string; email: string | null; role: string }) {
    const token = jwt.sign({ userId: u.id, email: u.email ?? '', role: u.role }, config.jwt.secret, { expiresIn: '1h' });
    return `accessToken=${token}`;
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
    const json = await res.json().catch(() => ({}));
    return { status: res.status, body: json as any };
}

/** 'YYYY-MM-DD' do próximo `dow` (0..6) a pelo menos `minDays` dias de hoje (calendário SP). */
function nextWeekday(dow: number, minDays: number): string {
    const sp = saoPauloParts(new Date());
    const d = new Date(Date.UTC(sp.y, sp.m - 1, sp.day + minDays));
    while (d.getUTCDay() !== dow) d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
}

/** Amanhã no calendário SP — o início FIXO do personalizado do CLIENTE (D7). */
function tomorrowSp(): string {
    const sp = saoPauloParts(new Date());
    return new Date(Date.UTC(sp.y, sp.m - 1, sp.day + 1)).toISOString().slice(0, 10);
}

describe('GET /api/contracts/slot-options', () => {
    it('devolve a grade da faixa na raiz do JSON (hierarquia + sábado só aos sábados)', async () => {
        const u = await mkUser();
        const aud = await call('GET', '/api/contracts/slot-options?tier=AUDIENCIA', cookieFor(u));
        expect(aud.status).toBe(200);
        expect(aud.body.tier).toBe('AUDIENCIA');
        expect(aud.body.slotDurationHours).toBe(2);
        expect(aud.body.days.map((d: any) => d.dayOfWeek)).toEqual([1, 2, 3, 4, 5]);
        expect(aud.body.days[0].slots.map((s: any) => s.time)).toEqual(['10:00', '13:00', '15:30', '18:00', '20:30']);
        expect(aud.body.days[0].slots[0]).toEqual({ time: '10:00', end: '12:00', tier: 'COMERCIAL' });

        const sab = await call('GET', '/api/contracts/slot-options?tier=SABADO', cookieFor(u));
        expect(sab.body.days).toHaveLength(1);
        expect(sab.body.days[0].dayOfWeek).toBe(6);

        const com = await call('GET', '/api/contracts/slot-options?tier=COMERCIAL', cookieFor(u));
        expect(com.body.days[0].slots.map((s: any) => s.time)).toEqual(['10:00', '13:00', '15:30']);
    });

    it('faixa inválida → 400; sem login → 401', async () => {
        const u = await mkUser();
        expect((await call('GET', '/api/contracts/slot-options?tier=FOO', cookieFor(u))).status).toBe(400);
        expect((await call('GET', '/api/contracts/slot-options?tier=COMERCIAL')).status).toBe(401);
    });
});

describe('POST /api/contracts/check-fixo — grade (D8)', () => {
    const base3m = (over: Record<string, unknown>) => ({ tier: 'COMERCIAL', durationMonths: 3, startDate: nextWeekday(1, 2), fixedDayOfWeek: 1, fixedTime: '13:00', ...over });

    it('14:00 → 400 INVALID_SLOT (nunca "conflito"); 13:00 → disponível', async () => {
        const u = await mkUser();
        const bad = await call('POST', '/api/contracts/check-fixo', cookieFor(u), base3m({ fixedTime: '14:00' }));
        expect(bad.status).toBe(400);
        expect(bad.body.code).toBe('INVALID_SLOT');
        expect(bad.body.error).toBe('Horário inválido: 14:00 não é um horário de gravação da faixa Comercial às segundas. Horários válidos: 10:00, 13:00, 15:30.');

        const ok = await call('POST', '/api/contracts/check-fixo', cookieFor(u), base3m({}));
        expect(ok.status).toBe(200);
        expect(ok.body).toEqual({ available: true, conflicts: [] });
    });

    it('AUDIÊNCIA às 10:00 (hierarquia) → disponível; COMERCIAL no sábado → 400', async () => {
        const u = await mkUser();
        const aud = await call('POST', '/api/contracts/check-fixo', cookieFor(u), base3m({ tier: 'AUDIENCIA', fixedTime: '10:00' }));
        expect(aud.status).toBe(200);
        expect(aud.body.available).toBe(true);

        const sat = await call('POST', '/api/contracts/check-fixo', cookieFor(u), base3m({ fixedDayOfWeek: 6, fixedTime: '10:00', startDate: nextWeekday(6, 2) }));
        expect(sat.status).toBe(400);
        expect(sat.body.code).toBe('INVALID_SLOT');
        expect(sat.body.error).toMatch(/não tem gravação aos sábados/);
    });

    it('conflito real sugere só horários da grade da faixa no mesmo dia', async () => {
        const u = await mkUser();
        const c = await mkContract(u.id);
        const first = nextWeekday(1, 2);
        await mkBooking(u.id, c.id, { date: new Date(first + 'T00:00:00Z'), startTime: '13:00', endTime: '15:00' });
        const r = await call('POST', '/api/contracts/check-fixo', cookieFor(u), base3m({ startDate: first }));
        expect(r.status).toBe(200);
        expect(r.body.available).toBe(false);
        expect(r.body.conflicts).toHaveLength(1);
        expect(r.body.conflicts[0].date).toBe(first);
        expect(r.body.conflicts[0].alternatives.map((a: any) => a.time).sort()).toEqual(['10:00', '15:30']);
        // Troca de dia-da-semana inteiro: só seg–sex para COMERCIAL (nunca sábado).
        expect((r.body.alternativeWeekdays ?? []).every((a: any) => a.dayOfWeek >= 1 && a.dayOfWeek <= 5)).toBe(true);
    });
});

describe('POST /api/contracts/custom/check', () => {
    it('item fora da grade → 400 INVALID_SLOT', async () => {
        const u = await mkUser();
        const startDate = nextWeekday(1, 2);
        const r1 = await call('POST', '/api/contracts/custom/check', cookieFor(u), { tier: 'COMERCIAL', durationMonths: 1, startDate, schedule: [{ day: 1, time: '14:00' }] });
        expect(r1.status).toBe(400);
        expect(r1.body.code).toBe('INVALID_SLOT');
        const r2 = await call('POST', '/api/contracts/custom/check', cookieFor(u), { tier: 'COMERCIAL', durationMonths: 1, startDate, schedule: [{ day: 6, time: '10:00' }] });
        expect(r2.status).toBe(400);
    });

    it('detecta sobreposição parcial do pacote e sugere outro horário válido', async () => {
        const u = await mkUser();
        const c = await mkContract(u.id);
        const startDate = nextWeekday(1, 2);
        // Reserva 11:00–13:00 sobrepõe o pacote das 10:00 (10:00–12:00) sem começar antes dele.
        await mkBooking(u.id, c.id, { date: new Date(startDate + 'T00:00:00Z'), startTime: '11:00', endTime: '13:00' });
        // Admin: início livre (o CLIENTE só simula a partir de amanhã — D7).
        const admin = await mkUser({ role: 'ADMIN' });
        const r = await call('POST', '/api/contracts/custom/check', cookieFor(admin), { tier: 'COMERCIAL', durationMonths: 1, startDate, schedule: [{ day: 1, time: '10:00' }] });
        expect(r.status).toBe(200);
        expect(r.body.totalSessions).toBe(4);
        expect(r.body.totalConflicts).toBe(1);
        expect(r.body.conflicts[0]).toMatchObject({ date: startDate, originalTime: '10:00', day: 1, suggestedReplacement: { date: startDate, time: '13:00' } });
    });

    it('Datas Livres (admin) usa as datas informadas', async () => {
        const u = await mkUser({ role: 'ADMIN' });
        const d1 = nextWeekday(2, 2);
        const r = await call('POST', '/api/contracts/custom/check', cookieFor(u), {
            tier: 'COMERCIAL', durationMonths: 1, startDate: d1, frequency: 'CUSTOM', customDates: [{ date: d1, time: '15:30' }],
        });
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ available: true, totalSessions: 1 });
    });
});

describe('POST /api/contracts/custom — D9/D7/D8', () => {
    // Início = amanhã (SP): o CLIENTE só pode começar amanhã (D7); o admin aceita qualquer data.
    const body = (over: Record<string, unknown> = {}) => ({
        name: 'Teste personalizado', tier: 'COMERCIAL', durationMonths: 3, paymentMethod: 'PIX', paymentPlan: 'MONTHLY',
        schedule: [{ day: 2, time: '10:00' }], startDate: tomorrowSp(), ...over,
    });

    it('ADMIN em nome do cliente SEM CPF com PIX → 201 ACTIVE, sem chamar o gateway', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser({ cpfCnpj: null });
        const r = await call('POST', '/api/contracts/custom', cookieFor(admin), body({ userId: client.id }));
        expect(r.status).toBe(201);
        expect(r.body.status).toBe('ACTIVE');
        expect(r.body.paymentDeadline).toBeNull();
        expect(r.body.firstPaymentId).toBeTruthy();
        expect(r.body.firstPixString).toBeUndefined();
        expect(r.body.payments).toHaveLength(3);
        expect(r.body.payments[0].amount).toBeGreaterThan(0);

        const contractId = r.body.contract.id;
        const pays = await prisma.payment.findMany({ where: { contractId } });
        expect(pays.every(p => p.providerRef === null && p.pixString === null && p.status === 'PENDING')).toBe(true);
        const bks = await prisma.booking.findMany({ where: { contractId } });
        expect(bks).toHaveLength(12);
        expect(bks.every(b => b.status === 'CONFIRMED' && b.startTime === '10:00' && b.userId === client.id)).toBe(true);
    });

    it('CLIENTE com PIX e CPF válido → AWAITING_PAYMENT, sessões RESERVED, só a 1ª parcela cobrada', async () => {
        const client = await mkUser({ cpfCnpj: VALID_CPF });
        const before = Date.now();
        const r = await call('POST', '/api/contracts/custom', cookieFor(client), body());
        expect(r.status).toBe(201);
        expect(r.body.status).toBe('AWAITING_PAYMENT');
        const deadline = new Date(r.body.paymentDeadline).getTime();
        expect(deadline).toBeGreaterThanOrEqual(before + config.studio.lockTtlSeconds * 1000 - 5000);
        expect(deadline).toBeLessThanOrEqual(Date.now() + config.studio.lockTtlSeconds * 1000 + 5000);
        expect(r.body.payments).toHaveLength(3);
        expect(r.body.payments.every((p: any) => typeof p.amount === 'number')).toBe(true);

        const contractId = r.body.contract.id;
        const pays = await prisma.payment.findMany({ where: { contractId }, orderBy: { dueDate: 'asc' } });
        expect(pays[0]!.id).toBe(r.body.firstPaymentId);
        expect(pays[0]!.providerRef).toBeTruthy();
        expect(pays.slice(1).every(p => p.providerRef === null && p.pixString === null)).toBe(true);
        const bks = await prisma.booking.findMany({ where: { contractId } });
        expect(bks).toHaveLength(12);
        expect(bks.every(b => b.status === 'RESERVED' && b.holdExpiresAt === null)).toBe(true);
    });

    it('CLIENTE que não paga no prazo: a varredura apaga contrato, sessões e parcelas', async () => {
        const client = await mkUser({ cpfCnpj: VALID_CPF });
        const r = await call('POST', '/api/contracts/custom', cookieFor(client), body({ durationMonths: 1 }));
        expect(r.status).toBe(201);
        const contractId = r.body.contract.id;
        await prisma.contract.update({ where: { id: contractId }, data: { paymentDeadline: new Date(Date.now() - 60_000) } });
        const { cleanExpiredHolds } = await import('../../src/jobs/cleanExpiredHolds');
        await cleanExpiredHolds();
        expect(await prisma.contract.count({ where: { id: contractId } })).toBe(0);
        expect(await prisma.booking.count({ where: { contractId } })).toBe(0);
        expect(await prisma.payment.count({ where: { contractId } })).toBe(0);
    });

    it('CLIENTE com PIX e CPF inválido → 400 ANTES de criar qualquer coisa', async () => {
        const client = await mkUser({ cpfCnpj: '11111111111' });
        const r = await call('POST', '/api/contracts/custom', cookieFor(client), body());
        expect(r.status).toBe(400);
        expect(r.body.code).toBe('CPF_CNPJ_REQUIRED');
        expect(await prisma.contract.count()).toBe(0);
        expect(await prisma.booking.count()).toBe(0);
        expect(await prisma.payment.count()).toBe(0);
    });

    it('CLIENTE com cartão → AWAITING_PAYMENT sem cobrança no gateway (checkout inline)', async () => {
        const client = await mkUser({ cpfCnpj: null });
        const r = await call('POST', '/api/contracts/custom', cookieFor(client), body({ paymentMethod: 'CARTAO', durationMonths: 1 }));
        expect(r.status).toBe(201);
        expect(r.body.status).toBe('AWAITING_PAYMENT');
        const pays = await prisma.payment.findMany({ where: { contractId: r.body.contract.id } });
        expect(pays).toHaveLength(1);
        expect(pays[0]!.providerRef).toBeNull();
    });

    it('restrições do CLIENTE (D7): só semanal, início = amanhã (nem antes, nem depois) e 1/3/6/9/12 ciclos', async () => {
        const client = await mkUser({ cpfCnpj: VALID_CPF });
        const ck = cookieFor(client);
        expect((await call('POST', '/api/contracts/custom', ck, body({ frequency: 'BIWEEKLY' }))).status).toBe(400);
        expect((await call('POST', '/api/contracts/custom', ck, body({ durationMonths: 2 }))).status).toBe(400);
        const today = saoPauloParts(new Date()).dateStr;
        const past = await call('POST', '/api/contracts/custom', ck, body({ startDate: today }));
        expect(past.status).toBe(400);
        expect(past.body.code).toBe('START_DATE_TOMORROW');
        // Data futura arbitrária (ex.: daqui a meses) também é recusada — início livre é só do admin.
        const future = await call('POST', '/api/contracts/custom', ck, body({ startDate: nextWeekday(2, 8) }));
        expect(future.status).toBe(400);
        expect(future.body).toMatchObject({ code: 'START_DATE_TOMORROW', details: { startDate: tomorrowSp() } });
        // O check do cliente aplica a mesma regra (o assistente se atualiza pelo details.startDate).
        const chk = await call('POST', '/api/contracts/custom/check', ck, { tier: 'COMERCIAL', durationMonths: 1, startDate: nextWeekday(2, 8), schedule: [{ day: 2, time: '10:00' }] });
        expect(chk.status).toBe(400);
        expect(chk.body.code).toBe('START_DATE_TOMORROW');
        expect(await prisma.contract.count()).toBe(0);
    });

    it('CLIENTE: troca de conflito só de horário, no mesmo dia e dentro do período (nunca passado/fora da vigência)', async () => {
        const client = await mkUser({ cpfCnpj: VALID_CPF });
        const ck = cookieFor(client);
        const firstTue = nextWeekday(2, 1);
        const lastWeek = saoPauloParts(new Date(Date.now() - 7 * 86_400_000)).dateStr;
        const cases = [
            // outra data (no passado)
            { originalDate: firstTue, originalTime: '10:00', newDate: lastWeek, newTime: '10:00' },
            // outra data (fora da vigência)
            { originalDate: firstTue, originalTime: '10:00', newDate: nextWeekday(2, 200), newTime: '10:00' },
            // mesmo dia, mas fora do período do plano
            { originalDate: nextWeekday(2, 200), originalTime: '10:00', newDate: nextWeekday(2, 200), newTime: '13:00' },
        ];
        for (const rc of cases) {
            const r = await call('POST', '/api/contracts/custom', ck, body({ durationMonths: 1, resolvedConflicts: [rc] }));
            expect(r.status).toBe(400);
            expect(r.body.code).toBe('INVALID_RESOLUTION');
        }
        expect(await prisma.contract.count()).toBe(0);
        // A troca legítima (mesmo dia, outro horário da grade) continua valendo.
        const ok = await call('POST', '/api/contracts/custom', ck, body({
            durationMonths: 1, resolvedConflicts: [{ originalDate: firstTue, originalTime: '10:00', newDate: firstTue, newTime: '13:00' }],
        }));
        expect(ok.status).toBe(201);
        const bks = await prisma.booking.findMany({ where: { contractId: ok.body.contract.id }, orderBy: { date: 'asc' } });
        expect(`${bks[0]!.date.toISOString().slice(0, 10)} ${bks[0]!.startTime}`).toBe(`${firstTue} 13:00`);
    });

    it('horário fora da grade → 400 INVALID_SLOT (cliente e admin, schedule e datas livres)', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser({ cpfCnpj: VALID_CPF });
        const r1 = await call('POST', '/api/contracts/custom', cookieFor(client), body({ schedule: [{ day: 2, time: '14:00' }] }));
        expect(r1.status).toBe(400);
        expect(r1.body.code).toBe('INVALID_SLOT');
        const sat = nextWeekday(6, 2);
        const r2 = await call('POST', '/api/contracts/custom', cookieFor(admin), body({
            userId: client.id, frequency: 'CUSTOM', schedule: [], customDates: [{ date: sat, time: '10:00' }], durationMonths: 1,
        }));
        expect(r2.status).toBe(400);
        expect(r2.body.code).toBe('INVALID_SLOT');
        expect(await prisma.contract.count()).toBe(0);
    });

    it('anti-overbooking: ocorrência ocupada sem troca → 409 SLOTS_TAKEN e NADA é criado (nunca cobra sessão pulada)', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser();
        const other = await mkUser();
        const otherC = await mkContract(other.id);
        const startDate = nextWeekday(2, 2);
        await mkBooking(other.id, otherC.id, { date: new Date(startDate + 'T00:00:00Z'), startTime: '10:00', endTime: '12:00' });
        const r = await call('POST', '/api/contracts/custom', cookieFor(admin), body({ userId: client.id, durationMonths: 1, startDate, paymentMethod: 'CARTAO' }));
        expect(r.status).toBe(409);
        expect(r.body.code).toBe('SLOTS_TAKEN');
        expect(r.body.skipped).toEqual([{ date: startDate, time: '10:00' }]);
        expect(await prisma.contract.count({ where: { userId: client.id } })).toBe(0);
        expect(await prisma.payment.count({ where: { userId: client.id } })).toBe(0);
        expect(await prisma.booking.count({ where: { userId: client.id } })).toBe(0);

        // Com a troca aceita (a sugestão do check), cria inteiro: 4 sessões para 4 cobradas.
        const chk = await call('POST', '/api/contracts/custom/check', cookieFor(admin), { tier: 'COMERCIAL', durationMonths: 1, startDate, schedule: [{ day: 2, time: '10:00' }] });
        expect(chk.body.conflicts).toEqual([{ date: startDate, originalTime: '10:00', day: 2, suggestedReplacement: { date: startDate, time: '13:00' } }]);
        const ok = await call('POST', '/api/contracts/custom', cookieFor(admin), body({
            userId: client.id, durationMonths: 1, startDate, paymentMethod: 'CARTAO',
            resolvedConflicts: [{ originalDate: startDate, originalTime: '10:00', newDate: startDate, newTime: '13:00' }],
        }));
        expect(ok.status).toBe(201);
        expect(ok.body.skipped).toEqual([]);
        expect(ok.body.summary.totalBookingsGenerated).toBe(4);
    });

    it('todas as ocorrências ocupadas → 409 ALL_SLOTS_TAKEN', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser();
        const other = await mkUser();
        const otherC = await mkContract(other.id);
        const d = nextWeekday(2, 2);
        await mkBooking(other.id, otherC.id, { date: new Date(d + 'T00:00:00Z'), startTime: '10:00', endTime: '12:00' });
        const r = await call('POST', '/api/contracts/custom', cookieFor(admin), body({
            userId: client.id, frequency: 'CUSTOM', schedule: [], customDates: [{ date: d, time: '10:00' }], durationMonths: 1, startDate: d, paymentMethod: 'CARTAO',
        }));
        expect(r.status).toBe(409);
        expect(r.body.code).toBe('ALL_SLOTS_TAKEN');
        expect(await prisma.contract.count({ where: { userId: client.id } })).toBe(0);
    });

    it('CLIENTE: a tentativa viva anterior é descartada (sem conflito consigo mesmo nem sessões cobradas a mais)', async () => {
        const client = await mkUser({ cpfCnpj: VALID_CPF });
        const ck = cookieFor(client);
        const a = await call('POST', '/api/contracts/custom', ck, body({ durationMonths: 1 }));
        expect(a.status).toBe(201);
        expect(a.body.status).toBe('AWAITING_PAYMENT');
        // Mesmo horário, 3 ciclos — antes: 9 sessões criadas + 3 "puladas" (conflito consigo mesmo) cobradas.
        const b = await call('POST', '/api/contracts/custom', ck, body({ durationMonths: 3 }));
        expect(b.status).toBe(201);
        expect(b.body.skipped).toEqual([]);
        expect(b.body.summary.totalBookingsGenerated).toBe(12);
        expect(await prisma.contract.count({ where: { id: a.body.contract.id } })).toBe(0);
        expect(await prisma.booking.count({ where: { contractId: a.body.contract.id } })).toBe(0);
        expect(await prisma.payment.count({ where: { contractId: a.body.contract.id } })).toBe(0);
        expect(await prisma.booking.count({ where: { contractId: b.body.contract.id, status: 'RESERVED' } })).toBe(12);
    });

    it('CLIENTE: tentativa anterior já paga → 409 CUSTOM_PREVIOUS_PAID (ativada, nada novo criado)', async () => {
        const client = await mkUser({ cpfCnpj: VALID_CPF });
        const ck = cookieFor(client);
        const a = await call('POST', '/api/contracts/custom', ck, body({ durationMonths: 1 }));
        expect(a.status).toBe(201);
        await prisma.payment.update({ where: { id: a.body.firstPaymentId }, data: { status: 'PAID', paidAt: new Date() } });
        const b = await call('POST', '/api/contracts/custom', ck, body({ durationMonths: 1, schedule: [{ day: 3, time: '13:00' }] }));
        expect(b.status).toBe(409);
        expect(b.body.code).toBe('CUSTOM_PREVIOUS_PAID');
        expect(await prisma.contract.findUniqueOrThrow({ where: { id: a.body.contract.id } })).toMatchObject({ status: 'ACTIVE' });
        expect(await prisma.contract.count({ where: { userId: client.id } })).toBe(1);
    });

    it('ADMIN em nome do cliente NÃO apaga a tentativa viva do cliente', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser({ cpfCnpj: VALID_CPF });
        const a = await call('POST', '/api/contracts/custom', cookieFor(client), body({ durationMonths: 1 }));
        expect(a.status).toBe(201);
        const r = await call('POST', '/api/contracts/custom', cookieFor(admin), body({ userId: client.id, durationMonths: 1, schedule: [{ day: 3, time: '15:30' }] }));
        expect(r.status).toBe(201);
        expect(await prisma.contract.findUniqueOrThrow({ where: { id: a.body.contract.id } })).toMatchObject({ status: 'AWAITING_PAYMENT' });
    });

    it('trava: dois pedidos SIMULTÂNEOS de clientes diferentes no mesmo horário → um cria, o outro 409, zero sessão duplicada', async () => {
        const c1 = await mkUser();
        const c2 = await mkUser();
        const payload = body({ paymentMethod: 'CARTAO', durationMonths: 3, schedule: [{ day: 2, time: '10:00' }, { day: 4, time: '13:00' }] });
        const [r1, r2] = await Promise.all([
            call('POST', '/api/contracts/custom', cookieFor(c1), payload),
            call('POST', '/api/contracts/custom', cookieFor(c2), payload),
        ]);
        expect([r1.status, r2.status].sort()).toEqual([201, 409]);
        const all = await prisma.booking.findMany({ where: { status: { not: 'CANCELLED' } }, select: { date: true, startTime: true } });
        const keys = all.map(b => `${b.date.toISOString().slice(0, 10)} ${b.startTime}`);
        expect(new Set(keys).size).toBe(keys.length);
        expect(all).toHaveLength(24);
        expect(await prisma.contract.count()).toBe(1);
    });

    it('trava por cliente: dois pedidos simultâneos do MESMO cliente nunca deixam duas tentativas vivas', async () => {
        const client = await mkUser();
        const ck = cookieFor(client);
        const payload = body({ paymentMethod: 'CARTAO', durationMonths: 1 });
        const rs = await Promise.all([call('POST', '/api/contracts/custom', ck, payload), call('POST', '/api/contracts/custom', ck, payload)]);
        expect(rs.some(r => r.status === 201)).toBe(true);
        for (const r of rs.filter(x => x.status !== 201)) expect(r.body.code).toBe('CUSTOM_IN_PROGRESS');
        expect(await prisma.contract.count({ where: { userId: client.id, status: 'AWAITING_PAYMENT' } })).toBe(1);
        expect(await prisma.booking.count({ where: { userId: client.id } })).toBe(4);
    });

    it('cliente EXCLUÍDO (soft delete): admin não cria personalizado nem FIXO para ele (409)', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const gone = await mkUser({ deletedAt: new Date(), email: null });
        const r = await call('POST', '/api/contracts/custom', cookieFor(admin), body({ userId: gone.id, paymentMethod: 'CARTAO', durationMonths: 1 }));
        expect(r.status).toBe(409);
        expect(r.body.error).toMatch(/^Este cliente foi excluído\./);
        const f = await call('POST', '/api/contracts', cookieFor(admin), {
            userId: gone.id, name: 'Fixo', type: 'FIXO', tier: 'COMERCIAL', durationMonths: 3, startDate: nextWeekday(1, 2), fixedDayOfWeek: 1, fixedTime: '13:00',
        });
        expect(f.status).toBe(409);
        expect(f.body.error).toMatch(/^Este cliente foi excluído\./);
        expect(await prisma.contract.count()).toBe(0);
        expect(await prisma.booking.count()).toBe(0);
    });
});

describe('POST /api/contracts/custom/check — todos os conflitos e sugestões sem colisão', () => {
    it('devolve TODOS os conflitos (não só os 20 primeiros)', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const other = await mkUser();
        const oc = await mkContract(other.id);
        const startDate = nextWeekday(2, 2);
        // 6 ciclos semanais às terças 10:00 = 24 ocorrências, todas ocupadas.
        for (let i = 0; i < 24; i++) {
            const d = new Date(startDate + 'T00:00:00Z');
            d.setUTCDate(d.getUTCDate() + i * 7);
            await mkBooking(other.id, oc.id, { date: d, startTime: '10:00', endTime: '12:00' });
        }
        const r = await call('POST', '/api/contracts/custom/check', cookieFor(admin), { tier: 'COMERCIAL', durationMonths: 6, startDate, schedule: [{ day: 2, time: '10:00' }] });
        expect(r.status).toBe(200);
        expect(r.body.totalConflicts).toBe(24);
        expect(r.body.conflicts).toHaveLength(24);
    });

    it('duas ocorrências em conflito no mesmo dia nunca recebem o mesmo substituto (nem um horário do próprio plano)', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const other = await mkUser();
        const oc = await mkContract(other.id);
        const startDate = nextWeekday(2, 2);
        const checkBody = { tier: 'COMERCIAL', durationMonths: 1, startDate, schedule: [{ day: 2, time: '10:00' }, { day: 2, time: '13:00' }] };
        await mkBooking(other.id, oc.id, { date: new Date(startDate + 'T00:00:00Z'), startTime: '10:00', endTime: '12:00' });
        const r = await call('POST', '/api/contracts/custom/check', cookieFor(admin), checkBody);
        // 10:00 ocupado: a sugestão NÃO é 13:00 (o próprio plano usa) → 15:30.
        expect(r.body.conflicts).toEqual([{ date: startDate, originalTime: '10:00', day: 2, suggestedReplacement: { date: startDate, time: '15:30' } }]);

        await mkBooking(other.id, oc.id, { date: new Date(startDate + 'T00:00:00Z'), startTime: '13:00', endTime: '15:00' });
        const r2 = await call('POST', '/api/contracts/custom/check', cookieFor(admin), checkBody);
        // 10:00 e 13:00 ocupados: só 15:30 livre → vai para a 1ª; a 2ª fica sem sugestão ("dia lotado").
        expect(r2.body.conflicts).toEqual([
            { date: startDate, originalTime: '10:00', day: 2, suggestedReplacement: { date: startDate, time: '15:30' } },
            { date: startDate, originalTime: '13:00', day: 2 },
        ]);
    });
});

describe('renovação e retomada do FIXO (admin) — anti-overbooking e cliente excluído', () => {
    const lifecycleSetup = async (fixedTime = '10:00') => {
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser();
        const other = await mkUser();
        const oc = await mkContract(other.id);
        const monday = nextWeekday(1, 14);
        const original = await mkContract(client.id, {
            type: 'FIXO', fixedDayOfWeek: 1, fixedTime, status: 'EXPIRED',
            startDate: new Date('2026-06-01T03:00:00Z'), endDate: new Date(monday + 'T03:00:00Z'),
        });
        return { admin, client, other, oc, monday, original };
    };

    it('renovar: segunda já ocupada por outro cliente é pulada (sem double booking) e a mensagem avisa', async () => {
        const { admin, other, oc, monday, original } = await lifecycleSetup();
        const busy = new Date(monday + 'T00:00:00Z');
        busy.setUTCDate(busy.getUTCDate() + 7); // 2ª segunda da renovação
        await mkBooking(other.id, oc.id, { date: busy, startTime: '10:00', endTime: '12:00' });
        const r = await call('POST', `/api/contracts/${original.id}/renew`, cookieFor(admin), { durationMonths: 3 });
        expect(r.status).toBe(201);
        expect(r.body.message).toMatch(/1 data com o horário 10:00 já ocupado foi pulada/);
        const mine = await prisma.booking.findMany({ where: { contractId: r.body.contract.id }, orderBy: { date: 'asc' } });
        expect(mine).toHaveLength(12); // a folga do período (mês ≈ 4,33 semanas) repõe a semana pulada
        expect(mine.map(b => b.date.toISOString().slice(0, 10))).not.toContain(busy.toISOString().slice(0, 10));
        expect(mine.every(b => b.date.getUTCDay() === 1 && b.startTime === '10:00')).toBe(true);
        expect(await prisma.booking.count({ where: { date: busy, startTime: '10:00', status: { not: 'CANCELLED' } } })).toBe(1);
    });

    it('renovar contrato legado fora da grade (14:00) continua permitido', async () => {
        const { admin, original } = await lifecycleSetup('14:00');
        const r = await call('POST', `/api/contracts/${original.id}/renew`, cookieFor(admin), { durationMonths: 3 });
        expect(r.status).toBe(201);
        expect(await prisma.booking.count({ where: { contractId: r.body.contract.id, startTime: '14:00' } })).toBe(12);
    });

    it('renovar para cliente EXCLUÍDO → 409, sem contrato nem gravações', async () => {
        const { admin, client, original } = await lifecycleSetup();
        await prisma.user.update({ where: { id: client.id }, data: { deletedAt: new Date(), email: null } });
        const r = await call('POST', `/api/contracts/${original.id}/renew`, cookieFor(admin), { durationMonths: 3 });
        expect(r.status).toBe(409);
        expect(r.body.error).toMatch(/^Este cliente foi excluído\./);
        expect(await prisma.contract.count({ where: { renewedFromId: original.id } })).toBe(0);
        expect(await prisma.booking.count({ where: { userId: client.id } })).toBe(0);
    });

    it('retomar: o que outro cliente agendou durante a pausa é respeitado (data pulada, dia certo em UTC)', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser();
        const other = await mkUser();
        const oc = await mkContract(other.id);
        const now = new Date();
        const paused = await mkContract(client.id, {
            type: 'FIXO', fixedDayOfWeek: 3, fixedTime: '13:00', status: 'PAUSED', pausedAt: now,
            startDate: new Date(now.getTime() - 7 * 86_400_000), endDate: new Date(now.getTime() + 80 * 86_400_000),
        });
        const wed = nextWeekday(3, 1);
        await mkBooking(other.id, oc.id, { date: new Date(wed + 'T00:00:00Z'), startTime: '13:00', endTime: '15:00' });
        const r = await call('PATCH', `/api/contracts/${paused.id}/resume`, cookieFor(admin));
        expect(r.status).toBe(200);
        expect(r.body.message).toMatch(/já ocupado foi pulada/);
        const mine = await prisma.booking.findMany({ where: { contractId: paused.id, status: { not: 'CANCELLED' } } });
        expect(mine.length).toBeGreaterThan(0);
        expect(mine.every(b => b.date.getUTCDay() === 3 && b.startTime === '13:00')).toBe(true);
        expect(mine.map(b => b.date.toISOString().slice(0, 10))).not.toContain(wed);
        expect(await prisma.booking.count({ where: { date: new Date(wed + 'T00:00:00Z'), startTime: '13:00', status: { not: 'CANCELLED' } } })).toBe(1);
    });
});

describe('POST /api/contracts (admin FIXO) e /self — grade (D8)', () => {
    it('FIXO do admin às 14:00 → 400; troca aceita para horário fora da grade → 400', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser();
        const startDate = nextWeekday(1, 2);
        const payload = { userId: client.id, name: 'Fixo', type: 'FIXO', tier: 'COMERCIAL', durationMonths: 3, startDate, fixedDayOfWeek: 1, fixedTime: '14:00' };
        const r1 = await call('POST', '/api/contracts', cookieFor(admin), payload);
        expect(r1.status).toBe(400);
        expect(r1.body.code).toBe('INVALID_SLOT');
        const r2 = await call('POST', '/api/contracts', cookieFor(admin), {
            ...payload, fixedTime: '13:00',
            resolvedConflicts: [{ originalDate: startDate, originalTime: '13:00', newDate: startDate, newTime: '19:00' }],
        });
        expect(r2.status).toBe(400);
        expect(r2.body.code).toBe('INVALID_SLOT');
        expect(await prisma.contract.count()).toBe(0);
    });

    it('/self: troca de conflito para o passado ou longe da ocorrência → 400 INVALID_RESOLUTION; a alternativa legítima passa', async () => {
        const client = await mkUser();
        const firstBookingDate = nextWeekday(3, 3);
        const base = { name: 'Fixo', type: 'FIXO', tier: 'COMERCIAL', durationMonths: 3, firstBookingDate, firstBookingTime: '13:00', paymentMethod: 'CARTAO' };
        const lastWeek = saoPauloParts(new Date(Date.now() - 7 * 86_400_000)).dateStr;
        const far = nextWeekday(4, 40);
        for (const newDate of [lastWeek, far]) {
            const r = await call('POST', '/api/contracts/self', cookieFor(client), {
                ...base, resolvedConflicts: [{ originalDate: firstBookingDate, originalTime: '13:00', newDate, newTime: '13:00' }],
            });
            expect(r.status).toBe(400);
            expect(r.body.code).toBe('INVALID_RESOLUTION');
        }
        expect(await prisma.payment.count()).toBe(0);
        // Dia seguinte (quinta) no mesmo horário — o tipo de alternativa que o check-fixo oferece.
        const next = new Date(firstBookingDate + 'T00:00:00Z');
        next.setUTCDate(next.getUTCDate() + 1);
        const ok = await call('POST', '/api/contracts/self', cookieFor(client), {
            ...base, resolvedConflicts: [{ originalDate: firstBookingDate, originalTime: '13:00', newDate: next.toISOString().slice(0, 10), newTime: '13:00' }],
        });
        expect(ok.status).toBe(201);
    });

    it('/self: 1ª gravação fora da grade → 400 INVALID_SLOT', async () => {
        const client = await mkUser({ cpfCnpj: VALID_CPF });
        const firstBookingDate = nextWeekday(3, 3);
        const r = await call('POST', '/api/contracts/self', cookieFor(client), {
            name: 'Flex', type: 'FLEX', tier: 'COMERCIAL', durationMonths: 3, firstBookingDate, firstBookingTime: '18:00', paymentMethod: 'PIX',
        });
        expect(r.status).toBe(400);
        expect(r.body.code).toBe('INVALID_SLOT');
        expect(await prisma.payment.count()).toBe(0);
    });
});

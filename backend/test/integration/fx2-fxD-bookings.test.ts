import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { prisma } from '../../src/lib/prisma';
import { config } from '../../src/config/index';
import { saoPauloParts } from '../../src/lib/spTime';
import bookingRoutes from '../../src/modules/bookings/routes';
import { mkUser, mkContract, mkBooking } from './factories';

// Correções da revisão adversarial do lote 2 — frente fxD-bookings (gravações), pelas ROTAS reais:
//  REC-2  PUT /:id/start-recording recusa sessão FUTURA (dia de São Paulo posterior a hoje) com 400
//         RECORDING_START_FUTURE; sessão de hoje ou passada segue permitida.
//  REC-5  PUT /:id/complete é condicional na 1ª finalização (status lido + início ainda registrado):
//         início desfeito no meio → 409 RECORDING_STATE_CHANGED sem gravar nada; já COMPLETED por outro
//         operador → 200 idempotente sem regravar.
//  Extra  a duração derivada automaticamente (Iniciar → Finalizar) é ignorada quando passa de 12 h.

let server: Server;
let base = '';

beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/bookings', bookingRoutes);
    await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
    vi.useRealTimers();
});

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

/** Data-calendário de SP (hoje + n dias) como meia-noite UTC — o formato de Booking.date. */
function spDay(n: number): Date {
    const d = new Date(`${saoPauloParts(new Date()).dateStr}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d;
}

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
const fresh = (id: string) => prisma.booking.findUniqueOrThrow({ where: { id } });
const contractStatus = async (id: string) => (await prisma.contract.findUniqueOrThrow({ where: { id } })).status;

/** Avulso de 1 gravação: finalizar a gravação conclui o contrato (dá para ver se o /complete gravou). */
async function scene(bookingOver: Record<string, unknown> = {}) {
    const admin = await mkUser({ role: 'ADMIN', name: 'Operadora Ana' });
    const client = await mkUser();
    const contract = await mkContract(client.id, {
        type: 'AVULSO', durationMonths: 1, discountPct: 0, paymentPlan: 'FULL', flexCreditsTotal: 1, flexCreditsRemaining: 0,
    });
    const booking = await mkBooking(client.id, contract.id, { date: spDay(0), status: 'CONFIRMED', ...bookingOver });
    return { admin, client, contract, booking };
}

describe('REC-2 — PUT /bookings/:id/start-recording só no dia da sessão (ou depois)', () => {
    it('sessão de AMANHÃ → 400 RECORDING_START_FUTURE, nada é gravado e o cliente não vê "AO VIVO"', async () => {
        const { admin, client, booking } = await scene({ date: spDay(1) });
        const r = await call('PUT', `/api/bookings/${booking.id}/start-recording`, admin);
        expect(r.status).toBe(400);
        expect(r.body).toEqual({ error: 'Só é possível iniciar a gravação no dia da sessão.', code: 'RECORDING_START_FUTURE' });

        const b = await fresh(booking.id);
        expect(b).toMatchObject({ status: 'CONFIRMED', recordingStartedAt: null, recordingStartedById: null, recordingStartedByName: null });
        const view = await call('GET', `/api/bookings/${booking.id}`, client);
        expect(view.status).toBe(200);
        expect(view.body.booking).toMatchObject({ isRecordingNow: false, recordingStartedAt: null });
    });

    it('sessão da semana que vem → 400 (o clique por engano do detalhe do contrato)', async () => {
        const { admin, booking } = await scene({ date: spDay(7) });
        const r = await call('PUT', `/api/bookings/${booking.id}/start-recording`, admin);
        expect(r.status).toBe(400);
        expect(r.body.code).toBe('RECORDING_START_FUTURE');
        expect((await fresh(booking.id)).recordingStartedAt).toBeNull();
    });

    it('sessão de HOJE → 200, registra início e operador; o cliente vê "gravando agora"', async () => {
        const { admin, client, booking } = await scene({ date: spDay(0) });
        const r = await call('PUT', `/api/bookings/${booking.id}/start-recording`, admin);
        expect(r.status).toBe(200);
        expect(r.body.code).toBeUndefined();
        const b = await fresh(booking.id);
        expect(b.recordingStartedAt).toBeInstanceOf(Date);
        expect(b).toMatchObject({ recordingStartedById: admin.id, recordingStartedByName: 'Operadora Ana' });
        expect((await call('GET', `/api/bookings/${booking.id}`, client)).body.booking.isRecordingNow).toBe(true);
    });

    it('sessão de ONTEM → 200 (Iniciar → Finalizar retroativo de quem esqueceu de iniciar)', async () => {
        const { admin, contract, booking } = await scene({ date: spDay(-1) });
        expect((await call('PUT', `/api/bookings/${booking.id}/start-recording`, admin)).status).toBe(200);
        expect((await fresh(booking.id)).recordingStartedAt).toBeInstanceOf(Date);
        const fin = await call('PUT', `/api/bookings/${booking.id}/complete`, admin, {});
        expect(fin.status).toBe(200);
        expect((await fresh(booking.id)).status).toBe('COMPLETED');
        expect(await contractStatus(contract.id)).toBe('COMPLETED');
    });

    it('"hoje" é o dia de SÃO PAULO: às 22:30 de SP (já dia seguinte em UTC) a sessão do dia UTC ainda é futura', async () => {
        // 2026-10-01T01:30Z = 30/09 22:30 em São Paulo.
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-10-01T01:30:00.000Z'));
        const { admin, contract, client, booking: tomorrowSp } = await scene({ date: new Date('2026-10-01T00:00:00.000Z') });
        const todaySp = await mkBooking(client.id, contract.id, { date: new Date('2026-09-30T00:00:00.000Z'), startTime: '20:30', endTime: '22:30', status: 'CONFIRMED' });

        const future = await call('PUT', `/api/bookings/${tomorrowSp.id}/start-recording`, admin);
        expect(future.status).toBe(400);
        expect(future.body.code).toBe('RECORDING_START_FUTURE');
        expect((await fresh(tomorrowSp.id)).recordingStartedAt).toBeNull();

        expect((await call('PUT', `/api/bookings/${todaySp.id}/start-recording`, admin)).status).toBe(200);
        expect((await fresh(todaySp.id)).recordingStartedAt?.toISOString()).toBe('2026-10-01T01:30:00.000Z');
    });

    it('status tem precedência: sessão futura não confirmada responde o erro de status (sem o code)', async () => {
        const { admin, booking } = await scene({ date: spDay(3), status: 'RESERVED' });
        const r = await call('PUT', `/api/bookings/${booking.id}/start-recording`, admin);
        expect(r.status).toBe(400);
        expect(r.body.code).toBeUndefined();
        expect(r.body.error).toMatch(/status atual: RESERVED/);
    });

    it('permissões inalteradas: cliente 403, anônimo 401, inexistente 404', async () => {
        const { admin, client, booking } = await scene();
        expect((await call('PUT', `/api/bookings/${booking.id}/start-recording`, client)).status).toBe(403);
        expect((await call('PUT', `/api/bookings/${booking.id}/start-recording`)).status).toBe(401);
        expect((await call('PUT', '/api/bookings/00000000-0000-4000-8000-000000000000/start-recording', admin)).status).toBe(404);
        expect((await fresh(booking.id)).recordingStartedAt).toBeNull();
    });
});

describe('REC-5 — PUT /bookings/:id/complete condicional (corrida com "Desfazer início")', () => {
    /**
     * Corrida DETERMINÍSTICA e sem mocks: `concurrent` é a escrita do "outro operador", feita numa transação
     * ainda ABERTA. O /complete é disparado nesse meio: a leitura dele enxerga o estado antigo (MVCC), passa
     * nos guards em memória e a escrita fica bloqueada no lock da linha. Só então a transação commita e o
     * Postgres reavalia o WHERE da escrita do /complete contra o estado novo.
     */
    async function completeRacing(
        bookingId: string, admin: Who, body: unknown,
        concurrent: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<unknown>,
    ) {
        let pending!: ReturnType<typeof call>;
        await prisma.$transaction(async (tx) => {
            await concurrent(tx);
            pending = call('PUT', `/api/bookings/${bookingId}/complete`, admin, body);
            // Espera a escrita do /complete ficar bloqueada no lock desta transação. A consulta vai FORA da
            // transação (conexão própria): dentro dela o pg_stat_activity fica congelado no 1º acesso.
            const deadline = Date.now() + 8000;
            for (;;) {
                const [{ n }] = await prisma.$queryRawUnsafe<{ n: number }[]>(
                    `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
                );
                if (n > 0) break;
                if (Date.now() > deadline) throw new Error('o /complete não chegou à escrita bloqueada');
                await new Promise((r) => setTimeout(r, 25));
            }
        }, { timeout: 15000 });
        return pending;
    }

    it('início desfeito entre a leitura e a escrita → 409 RECORDING_STATE_CHANGED, nada é gravado', async () => {
        const { admin, contract, booking } = await scene({
            recordingStartedAt: new Date(Date.now() - 60_000), recordingStartedByName: 'Operadora Ana',
        });
        // O "Desfazer início" do outro operador (a mesma escrita da rota de undo) entra no meio.
        const r = await completeRacing(booking.id, admin, { adminNotes: 'nota', clientNotes: 'feedback', isLivestream: true }, (tx) =>
            tx.booking.updateMany({
                where: { id: booking.id, status: 'CONFIRMED', recordingStartedAt: { not: null } },
                data: { recordingStartedAt: null, recordingStartedById: null, recordingStartedByName: null },
            }));
        expect(r.status).toBe(409);
        expect(r.body).toEqual({
            error: 'A gravação foi alterada em outra tela (o início foi desfeito ou o status mudou). Atualize e tente de novo.',
            code: 'RECORDING_STATE_CHANGED',
        });

        const b = await fresh(booking.id);
        expect(b).toMatchObject({
            status: 'CONFIRMED', recordingStartedAt: null, durationMinutes: null,
            adminNotes: null, clientNotes: null, isLivestream: null,
        });
        // Sem finalização → o contrato avulso NÃO foi concluído.
        expect(await contractStatus(contract.id)).toBe('ACTIVE');
    });

    it('status mudou no meio (ex.: cancelada em outra tela) → 409, a reserva não vira COMPLETED', async () => {
        const { admin, contract, booking } = await scene({ recordingStartedAt: new Date(Date.now() - 60_000) });
        const r = await completeRacing(booking.id, admin, {}, (tx) =>
            tx.booking.update({ where: { id: booking.id }, data: { status: 'CANCELLED' } }));
        expect(r.status).toBe(409);
        expect(r.body.code).toBe('RECORDING_STATE_CHANGED');
        expect(await fresh(booking.id)).toMatchObject({ status: 'CANCELLED', durationMinutes: null });
        expect(await contractStatus(contract.id)).toBe('ACTIVE');
    });

    it('já finalizada por outro operador no meio → 200 idempotente, sem sobrescrever o que ele gravou', async () => {
        const startedAt = new Date(Date.now() - 90 * 60_000);
        const { admin, booking } = await scene({ recordingStartedAt: startedAt, recordingStartedByName: 'Operador Bruno' });
        // O outro operador finaliza (mesma gravação) enquanto este "Finalizar" já tinha lido CONFIRMED.
        const r = await completeRacing(booking.id, admin, { clientNotes: 'sobrescrita', durationMinutes: 5 }, (tx) =>
            tx.booking.update({
                where: { id: booking.id },
                data: { status: 'COMPLETED', durationMinutes: 85, clientNotes: 'feedback do Bruno', adminNotes: 'nota do Bruno' },
            }));
        expect(r.status).toBe(200);
        expect(r.body.code).toBeUndefined();
        expect(r.body.booking).toMatchObject({ id: booking.id, status: 'COMPLETED', durationMinutes: 85, clientNotes: 'feedback do Bruno', adminNotes: 'nota do Bruno' });

        const b = await fresh(booking.id);
        expect(b).toMatchObject({ status: 'COMPLETED', durationMinutes: 85, clientNotes: 'feedback do Bruno', adminNotes: 'nota do Bruno', recordingStartedByName: 'Operador Bruno' });
        expect(b.recordingStartedAt?.getTime()).toBe(startedAt.getTime());
    });

    it('corrida REAL "Finalizar" × "Desfazer início": nunca fica COMPLETED sem início, e o 200 do undo é verdadeiro', async () => {
        const admin = await mkUser({ role: 'ADMIN', name: 'Operadora Ana' });
        const client = await mkUser();
        const contract = await mkContract(client.id, { type: 'FLEX', flexCreditsTotal: 60, flexCreditsRemaining: 40 });
        const seen = new Set<string>();
        for (let i = 0; i < 12; i++) {
            const booking = await mkBooking(client.id, contract.id, {
                date: spDay(0), startTime: '10:00', endTime: '12:00', status: 'CONFIRMED',
                recordingStartedAt: new Date(Date.now() - 60_000), recordingStartedById: admin.id, recordingStartedByName: 'Operadora Ana',
            });
            const [fin, undo] = await Promise.all([
                call('PUT', `/api/bookings/${booking.id}/complete`, admin, {}),
                call('PUT', `/api/bookings/${booking.id}/undo-start-recording`, admin),
            ]);
            const b = await fresh(booking.id);
            seen.add(`${fin.status}/${undo.status}`);

            // Invariante do achado: gravação COMPLETED sempre tem o início registrado.
            if (b.status === 'COMPLETED') {
                expect(b.recordingStartedAt, `iteração ${i}`).toBeInstanceOf(Date);
                expect(b.durationMinutes).toBeGreaterThanOrEqual(1);
                expect(fin.status).toBe(200);
                expect(undo.status).toBe(409);
                expect(undo.body.code).toBe('RECORDING_UNDO_NOT_ALLOWED');
            } else {
                // O undo venceu: segue CONFIRMED, sem início e sem métricas; o /complete foi recusado.
                expect(b).toMatchObject({ status: 'CONFIRMED', recordingStartedAt: null, durationMinutes: null });
                expect(undo.status).toBe(200);
                expect(undo.body.message).toBe('Início da gravação desfeito.');
                expect([400, 409]).toContain(fin.status);
                if (fin.status === 409) expect(fin.body.code).toBe('RECORDING_STATE_CHANGED');
            }
            await prisma.booking.delete({ where: { id: booking.id } });
        }
        expect(seen.size).toBeGreaterThanOrEqual(1);
    });

    it('caminho normal: iniciar → finalizar grava métricas, deriva a duração, devolve a reserva completa e conclui o avulso', async () => {
        const { admin, contract, booking } = await scene({ recordingStartedAt: hoursAgo(1.5), recordingStartedById: null, recordingStartedByName: 'Operadora Ana' });
        const r = await call('PUT', `/api/bookings/${booking.id}/complete`, admin, { adminNotes: 'nota interna', clientNotes: 'feedback', isLivestream: true, peakViewers: 40 });
        expect(r.status).toBe(200);
        expect(r.body.message).toMatch(/Sessão finalizada/);
        expect(r.body.booking).toMatchObject({
            id: booking.id, status: 'COMPLETED', durationMinutes: 90, adminNotes: 'nota interna', clientNotes: 'feedback',
            isLivestream: true, peakViewers: 40, recordingStartedByName: 'Operadora Ana',
        });
        expect(await fresh(booking.id)).toMatchObject({ status: 'COMPLETED', durationMinutes: 90 });
        expect(await contractStatus(contract.id)).toBe('COMPLETED');
    });

    it('sem "Iniciar gravação" continua 400 (guard em memória), sem gravar', async () => {
        const { admin, booking } = await scene({ recordingStartedAt: null });
        const r = await call('PUT', `/api/bookings/${booking.id}/complete`, admin, {});
        expect(r.status).toBe(400);
        expect(r.body.code).toBeUndefined();
        expect((await fresh(booking.id)).status).toBe('CONFIRMED');
    });

    it('regravar métricas de uma gravação já COMPLETED segue incondicional (mesmo legado sem início) e preserva a duração', async () => {
        const { admin, booking } = await scene({ status: 'COMPLETED', recordingStartedAt: null, durationMinutes: 85 });
        const r = await call('PUT', `/api/bookings/${booking.id}/complete`, admin, { clientNotes: 'novo feedback', chatMessages: 12 });
        expect(r.status).toBe(200);
        expect(r.body.booking).toMatchObject({ status: 'COMPLETED', durationMinutes: 85, clientNotes: 'novo feedback', chatMessages: 12 });
        expect(await fresh(booking.id)).toMatchObject({ status: 'COMPLETED', durationMinutes: 85, clientNotes: 'novo feedback', chatMessages: 12, recordingStartedAt: null });
    });

    it('dois "Finalizar" em sequência: o 2º regrava sem erro e não recalcula a duração', async () => {
        const { admin, booking } = await scene({ recordingStartedAt: hoursAgo(1) });
        expect((await call('PUT', `/api/bookings/${booking.id}/complete`, admin, {})).status).toBe(200);
        const first = (await fresh(booking.id)).durationMinutes;
        expect(first).toBe(60);
        await prisma.booking.update({ where: { id: booking.id }, data: { recordingStartedAt: hoursAgo(3) } });
        expect((await call('PUT', `/api/bookings/${booking.id}/complete`, admin, {})).status).toBe(200);
        expect((await fresh(booking.id)).durationMinutes).toBe(60);
    });
});

describe('Extra do REC-2 — duração derivada automática ignorada acima de 12 h', () => {
    it('início de mais de 12 h atrás, sem duração informada → finaliza SEM duração (e sem "Fim" para o cliente)', async () => {
        const { admin, client, contract, booking } = await scene({ date: spDay(-2), recordingStartedAt: hoursAgo(49) });
        const r = await call('PUT', `/api/bookings/${booking.id}/complete`, admin, {});
        expect(r.status).toBe(200);
        expect(r.body.booking).toMatchObject({ status: 'COMPLETED', durationMinutes: null });
        expect(await fresh(booking.id)).toMatchObject({ status: 'COMPLETED', durationMinutes: null });
        expect(await contractStatus(contract.id)).toBe('COMPLETED');
        const view = (await call('GET', `/api/bookings/${booking.id}`, client)).body.booking;
        expect(view).toMatchObject({ status: 'COMPLETED', durationMinutes: null, recordingFinishedAt: null });
    });

    it('início de mais de 12 h atrás COM duração informada pelo operador → grava o valor informado', async () => {
        const { admin, booking } = await scene({ date: spDay(-1), recordingStartedAt: hoursAgo(26) });
        const r = await call('PUT', `/api/bookings/${booking.id}/complete`, admin, { durationMinutes: 95 });
        expect(r.status).toBe(200);
        expect((await fresh(booking.id)).durationMinutes).toBe(95);
    });

    it('limite: 11 h 59 deriva; 12 h 01 não', async () => {
        const a = await scene({ recordingStartedAt: new Date(Date.now() - (12 * 60 - 1) * 60_000) });
        expect((await call('PUT', `/api/bookings/${a.booking.id}/complete`, a.admin, {})).status).toBe(200);
        expect((await fresh(a.booking.id)).durationMinutes).toBe(12 * 60 - 1);

        const b = await scene({ recordingStartedAt: new Date(Date.now() - (12 * 60 + 1) * 60_000) });
        expect((await call('PUT', `/api/bookings/${b.booking.id}/complete`, b.admin, {})).status).toBe(200);
        expect((await fresh(b.booking.id)).durationMinutes).toBeNull();
    });
});

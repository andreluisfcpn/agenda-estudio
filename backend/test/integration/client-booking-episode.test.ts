import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import sharp from 'sharp';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { prisma } from '../../src/lib/prisma';
import { redis } from '../../src/lib/redis';
import { config } from '../../src/config/index';
import { saoPauloParts } from '../../src/lib/spTime';
import { addDaysYmd } from '../../src/lib/avulsoMakeup';
import bookingRoutes from '../../src/modules/bookings/routes';
import { RECORDING_LIVE_MAX_HOURS } from '../../src/modules/bookings/booking.clientView';
import { mkUser, mkContract, mkBooking, mkPayment } from './factories';

// Lote 2 — E11 (selo "AO VIVO" só durante a gravação + métricas/feedback para o cliente, nota interna
// NUNCA) e E12 (cliente edita o episódio só enquanto a gravação não foi finalizada/cancelada).
// Tudo pelas ROTAS reais de /api/bookings num app Express mínimo, com o relógio real.

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

// Capas gravadas em backend/uploads pelos testes de upload — apagadas ao fim de cada caso.
const UPLOADS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../uploads');
const coverFiles: string[] = [];
const touchedBookings: string[] = [];
afterEach(async () => {
    for (const url of coverFiles.splice(0)) {
        await fs.promises.unlink(path.join(UPLOADS_DIR, path.basename(url))).catch(() => {});
    }
    for (const id of touchedBookings.splice(0)) {
        const keys = [...await redis.keys(`makeup:*${id}*`), ...await redis.keys(`notif:dedup:makeup:*${id}*`)];
        if (keys.length) await redis.del(...keys);
    }
});

type Who = { id: string; email: string | null; role: string };

function cookie(u: Who) {
    return `accessToken=${jwt.sign({ userId: u.id, email: u.email ?? '', role: u.role }, config.jwt.secret, { expiresIn: '1h' })}`;
}

async function call(method: string, p: string, who?: Who, body?: unknown) {
    const res = await fetch(`${base}${p}`, {
        method,
        headers: {
            ...(who ? { Cookie: cookie(who) } : {}),
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: any = {};
    try { json = JSON.parse(text); } catch { /* corpo não-JSON */ }
    return { status: res.status, body: json, text };
}

async function uploadCover(bookingId: string, who: Who | undefined, file: { data: Buffer; type: string; name: string } | null) {
    const form = new FormData();
    if (file) form.append('cover', new Blob([new Uint8Array(file.data)], { type: file.type }), file.name);
    const res = await fetch(`${base}/api/bookings/${bookingId}/cover-image`, {
        method: 'POST',
        headers: who ? { Cookie: cookie(who) } : {},
        body: form,
    });
    const text = await res.text();
    let json: any = {};
    try { json = JSON.parse(text); } catch { /* corpo não-JSON */ }
    if (json?.coverImageUrl) coverFiles.push(json.coverImageUrl);
    return { status: res.status, body: json, text };
}

const pngCover = () => sharp({ create: { width: 64, height: 36, channels: 3, background: { r: 200, g: 30, b: 60 } } }).png().toBuffer();

// Datas relativas a HOJE no calendário de São Paulo.
const todaySp = saoPauloParts(new Date()).dateStr;
const dbDate = (ymd: string) => new Date(`${ymd}T00:00:00Z`);
const dow = (ymd: string) => new Date(`${ymd}T12:00:00Z`).getUTCDay();
/** 1º dia útil (seg–sex, faixa COMERCIAL nos horários 10:00/13:00/15:30) a partir de `from`. */
function nextWeekday(from: string): string {
    for (let d = from; ; d = addDaysYmd(d, 1)) if (dow(d) >= 1 && dow(d) <= 5) return d;
}

const SECRET_NOTE = 'NOTA INTERNA PRIVADA — cliente inadimplente, cobrar antes de gravar';
const FEEDBACK = 'Ótima gravação! O corte final sai na sexta.';
const METRICS = {
    YOUTUBE: { views: 1500, peak: 120, subscribers: 9000, likes: 80, comments: 25 },
    INSTAGRAM: { views: 400, peak: 60, subscribers: 3000, likes: 45, comments: 10 },
};
const LINKS = { YOUTUBE: 'https://youtu.be/abc123', INSTAGRAM: 'https://www.instagram.com/reel/xyz/' };

/** A nota interna não pode aparecer nem como chave nem como texto em NENHUM ponto do corpo. */
function expectNoAdminNotes(r: { body: unknown; text: string }) {
    expect(r.text).not.toContain('adminNotes');
    expect(r.text).not.toContain('NOTA INTERNA');
    // Dados do operador também são internos.
    expect(r.text).not.toContain('recordingStartedByName');
    expect(r.text).not.toContain('recordingStartedById');
}

async function seedBase() {
    const admin = await mkUser({ role: 'ADMIN', name: 'Operador Interno' });
    const client = await mkUser();
    const contract = await mkContract(client.id, {
        name: 'Búzios Now Esportes', type: 'FLEX', tier: 'COMERCIAL', discountPct: 30,
        flexCreditsTotal: 12, flexCreditsRemaining: 8,
    });
    return { admin, client, contract };
}

describe('E11 — o cliente nunca recebe a nota interna; recebe feedback e todas as métricas', () => {
    it('GET /my, GET /:id e myBookings do /availability: sem adminNotes, com clientNotes, métricas, episódio e contrato', async () => {
        const { admin, client, contract } = await seedBase();
        const day = nextWeekday(addDaysYmd(todaySp, -10));
        const startedAt = new Date(Date.now() - 9 * 24 * 3600_000);
        const done = await mkBooking(client.id, contract.id, {
            date: dbDate(day), startTime: '10:00', endTime: '12:00', status: 'COMPLETED',
            adminNotes: SECRET_NOTE, clientNotes: FEEDBACK,
            episodeTitle: 'História de Búzios', episodeDescription: 'Episódio piloto', coverImageUrl: '/uploads/cover_demo.jpg',
            platforms: JSON.stringify(['YOUTUBE', 'INSTAGRAM']), platformLinks: JSON.stringify(LINKS),
            streamMetrics: JSON.stringify(METRICS), isLivestream: true,
            durationMinutes: 95, peakViewers: 120, chatMessages: 35, audienceOrigin: 'Instagram Stories',
            recordingStartedAt: startedAt, recordingStartedById: admin.id, recordingStartedByName: admin.name,
        });

        const expected = {
            id: done.id, status: 'COMPLETED', startTime: '10:00', endTime: '12:00',
            tierApplied: 'COMERCIAL', price: 30000, contractId: contract.id,
            clientNotes: FEEDBACK,
            episodeTitle: 'História de Búzios', episodeDescription: 'Episódio piloto', coverImageUrl: '/uploads/cover_demo.jpg',
            platforms: JSON.stringify(['YOUTUBE', 'INSTAGRAM']), platformLinks: JSON.stringify(LINKS),
            streamMetrics: JSON.stringify(METRICS), isLivestream: true,
            durationMinutes: 95, peakViewers: 120, chatMessages: 35, audienceOrigin: 'Instagram Stories',
            recordingStartedAt: startedAt.toISOString(),
            recordingFinishedAt: new Date(startedAt.getTime() + 95 * 60_000).toISOString(),
            // Transmitida ao vivo (isLivestream) NÃO é "gravando agora".
            isRecordingNow: false,
            canEditEpisode: false,
            contract: { id: contract.id, name: 'Búzios Now Esportes', type: 'FLEX', tier: 'COMERCIAL', discountPct: 30, addOns: [] },
        };

        const my = await call('GET', '/api/bookings/my', client);
        expect(my.status).toBe(200);
        expectNoAdminNotes(my);
        expect(my.body.bookings).toHaveLength(1);
        expect(my.body.bookings[0]).toMatchObject(expected);
        expect(my.body.bookings[0].date.slice(0, 10)).toBe(day);
        expect(my.body.bookings[0].editBlockedReason).toMatch(/finalizada/);

        const one = await call('GET', `/api/bookings/${done.id}`, client);
        expect(one.status).toBe(200);
        expectNoAdminNotes(one);
        expect(one.body.booking).toMatchObject(expected);

        // A semana da agenda devolve a MESMA forma do /my (o card não regride para o nome da faixa).
        const av = await call('GET', `/api/bookings/availability?date=${day}`, client);
        expect(av.status).toBe(200);
        expectNoAdminNotes(av);
        expect(av.body.myBookings).toHaveLength(1);
        expect(av.body.myBookings[0]).toMatchObject(expected);
        expect(Object.keys(av.body.myBookings[0]).sort()).toEqual(Object.keys(my.body.bookings[0]).sort());
        expect(Object.keys(one.body.booking).sort()).toEqual(Object.keys(my.body.bookings[0]).sort());

        // Outro cliente não enxerga a gravação.
        const stranger = await mkUser();
        expect((await call('GET', `/api/bookings/${done.id}`, stranger)).status).toBe(404);
        expect((await call('GET', `/api/bookings/availability?date=${day}`, stranger)).body.myBookings).toEqual([]);
        expect((await call('GET', '/api/bookings/my')).status).toBe(401);

        // As rotas do ADMIN continuam vendo a nota interna.
        const adminList = await call('GET', '/api/bookings?status=COMPLETED', admin);
        expect(adminList.status).toBe(200);
        expect(adminList.body.bookings.find((b: any) => b.id === done.id).adminNotes).toBe(SECRET_NOTE);
        const adminPatch = await call('PATCH', `/api/bookings/${done.id}`, admin, { adminNotes: `${SECRET_NOTE} (rev)` });
        expect(adminPatch.status).toBe(200);
        expect(adminPatch.body.booking.adminNotes).toBe(`${SECRET_NOTE} (rev)`);
    });

    it('respostas de client-update, cover-image, reschedule e makeup não trazem adminNotes e vêm na visão do cliente', async () => {
        const { admin, client, contract } = await seedBase();
        const from = nextWeekday(addDaysYmd(todaySp, 3));
        const to = nextWeekday(addDaysYmd(from, 1));
        const b = await mkBooking(client.id, contract.id, {
            date: dbDate(from), startTime: '10:00', endTime: '12:00', status: 'CONFIRMED',
            adminNotes: SECRET_NOTE, clientNotes: 'Chegar 15 min antes.',
        });

        const upd = await call('PATCH', `/api/bookings/${b.id}/client-update`, client, { episodeTitle: 'Ep. 1' });
        expect(upd.status).toBe(200);
        expectNoAdminNotes(upd);
        expect(upd.body.booking).toMatchObject({
            id: b.id, episodeTitle: 'Ep. 1', clientNotes: 'Chegar 15 min antes.', canEditEpisode: true,
            editBlockedReason: null, isRecordingNow: false, contract: { name: 'Búzios Now Esportes', type: 'FLEX' },
        });

        const cover = await uploadCover(b.id, client, { data: await pngCover(), type: 'image/png', name: 'capa.png' });
        expect(cover.status, cover.text).toBe(200);
        expectNoAdminNotes(cover);
        expect(cover.body.booking.coverImageUrl).toBe(cover.body.coverImageUrl);

        const res = await call('PATCH', `/api/bookings/${b.id}/reschedule`, client, { date: to, startTime: '13:00' });
        expect(res.status, res.text).toBe(200);
        expectNoAdminNotes(res);
        expect(res.body.booking).toMatchObject({
            id: b.id, startTime: '13:00', endTime: '15:00', status: 'CONFIRMED', tierApplied: 'COMERCIAL',
            price: 30000, contractId: contract.id, episodeTitle: 'Ep. 1', canEditEpisode: true,
        });
        expect(res.body.booking.date.slice(0, 10)).toBe(to);

        // Makeup (avulso, falta justificada) feito pelo próprio cliente.
        const avulso = await mkContract(client.id, {
            type: 'AVULSO', durationMonths: 1, discountPct: 0, paymentPlan: 'FULL',
            startDate: dbDate(addDaysYmd(todaySp, -1)), endDate: dbDate(addDaysYmd(todaySp, -1)),
            flexCreditsTotal: 1, flexCreditsRemaining: 0,
        });
        const missed = await mkBooking(client.id, avulso.id, {
            date: dbDate(addDaysYmd(todaySp, -1)), startTime: '10:00', endTime: '12:00', status: 'CONFIRMED', adminNotes: SECRET_NOTE,
        });
        touchedBookings.push(missed.id);
        await mkPayment(client.id, { contractId: avulso.id, bookingId: missed.id, status: 'PAID', amount: 30000, paidAt: new Date() });
        const falta = await call('PATCH', `/api/bookings/${missed.id}`, admin, { status: 'FALTA', statusReason: 'Doença', noShowJustified: true });
        expect(falta.status, falta.text).toBe(200);
        // Janela: até D+7 (D = ontem) e com a antecedência mínima de 12h.
        const target = nextWeekday(addDaysYmd(todaySp, 2));
        const mk = await call('PATCH', `/api/bookings/${missed.id}/makeup`, client, { date: target, startTime: '15:30' });
        expect(mk.status, mk.text).toBe(200);
        expectNoAdminNotes(mk);
        expect(mk.body.message).toMatch(/sem novo pagamento/);
        expect(mk.body.booking).toMatchObject({
            id: missed.id, status: 'CONFIRMED', makeupStatus: 'USED', startTime: '15:30',
            canEditEpisode: true, isRecordingNow: false, contract: { type: 'AVULSO' },
        });
    });
});

describe('E11 — "gravando agora" (isRecordingNow) só entre Iniciar e Finalizar gravação', () => {
    it('CONFIRMED → start-recording liga; complete desliga (em /my, /:id e /availability)', async () => {
        const { admin, client, contract } = await seedBase();
        // REC-2: a gravação só pode ser iniciada no dia da sessão (ou depois) — a sessão é de HOJE (SP),
        // não mais do "próximo dia útil" (que caía no futuro em fim de semana).
        const day = todaySp;
        const b = await mkBooking(client.id, contract.id, {
            date: dbDate(day), startTime: '10:00', endTime: '12:00', status: 'CONFIRMED',
            platforms: JSON.stringify(['YOUTUBE']), // o cliente planejou transmitir: isso NÃO é "ao vivo agora"
        });

        const flags = async () => {
            const my = await call('GET', '/api/bookings/my', client);
            const one = await call('GET', `/api/bookings/${b.id}`, client);
            const av = await call('GET', `/api/bookings/availability?date=${day}`, client);
            // Em dia sem funcionamento o /availability responde closed + myBookings: [] — sem essa visão.
            return [my.body.bookings[0], one.body.booking, ...(av.body.closed ? [] : [av.body.myBookings[0]])];
        };

        for (const v of await flags()) {
            expect(v).toMatchObject({ isRecordingNow: false, recordingStartedAt: null, recordingFinishedAt: null, status: 'CONFIRMED' });
        }

        const start = await call('PUT', `/api/bookings/${b.id}/start-recording`, admin);
        expect(start.status).toBe(200);
        for (const v of await flags()) {
            expect(v.isRecordingNow).toBe(true);
            expect(v.status).toBe('CONFIRMED');
            expect(typeof v.recordingStartedAt).toBe('string');
            expect(v.recordingFinishedAt).toBeNull();
            // Durante a gravação o cliente ainda pode ajustar o episódio.
            expect(v.canEditEpisode).toBe(true);
        }

        const fin = await call('PUT', `/api/bookings/${b.id}/complete`, admin, {
            isLivestream: true, platforms: JSON.stringify(['YOUTUBE']), platformLinks: JSON.stringify({ YOUTUBE: LINKS.YOUTUBE }),
            streamMetrics: JSON.stringify({ YOUTUBE: METRICS.YOUTUBE }), audienceOrigin: 'YouTube',
            adminNotes: SECRET_NOTE, clientNotes: FEEDBACK,
        });
        expect(fin.status).toBe(200);
        expect(fin.body.booking.adminNotes).toBe(SECRET_NOTE); // admin vê

        for (const v of await flags()) {
            expect(v).toMatchObject({
                status: 'COMPLETED', isRecordingNow: false, isLivestream: true, canEditEpisode: false,
                clientNotes: FEEDBACK, audienceOrigin: 'YouTube', peakViewers: 120, chatMessages: 25,
                streamMetrics: JSON.stringify({ YOUTUBE: METRICS.YOUTUBE }),
                platformLinks: JSON.stringify({ YOUTUBE: LINKS.YOUTUBE }),
            });
            expect(v.durationMinutes).toBeGreaterThanOrEqual(1);
            expect(typeof v.recordingFinishedAt).toBe('string');
            expect(v).not.toHaveProperty('adminNotes');
        }
    });

    it('outros status e início esquecido (passou do teto) não contam como "gravando agora"', async () => {
        const { client, contract } = await seedBase();
        const day = nextWeekday(todaySp);
        const fresh = new Date(Date.now() - 20 * 60_000);
        const stale = new Date(Date.now() - (RECORDING_LIVE_MAX_HOURS * 3600_000 + 60_000));
        const mk = (status: any, recordingStartedAt: Date | null, startTime: string) =>
            mkBooking(client.id, contract.id, { date: dbDate(day), startTime, endTime: '23:00', status, recordingStartedAt });
        const live = await mk('CONFIRMED', fresh, '10:00');
        const forgotten = await mk('CONFIRMED', stale, '13:00');
        const falta = await mk('FALTA', fresh, '15:30');
        const naoRealizado = await mk('NAO_REALIZADO', fresh, '18:00');
        const completed = await mk('COMPLETED', fresh, '20:30');
        const reserved = await mk('RESERVED', null, '08:00');

        const my = await call('GET', '/api/bookings/my', client);
        const by = (id: string) => my.body.bookings.find((x: any) => x.id === id);
        expect(by(live.id).isRecordingNow).toBe(true);
        expect(by(forgotten.id).isRecordingNow).toBe(false);
        expect(by(falta.id).isRecordingNow).toBe(false);
        expect(by(naoRealizado.id).isRecordingNow).toBe(false);
        expect(by(completed.id).isRecordingNow).toBe(false);
        expect(by(reserved.id).isRecordingNow).toBe(false);
    });

    it('sessão aberta remarcada (admin PATCH ou reschedule do cliente) zera o "Iniciar Gravação" anterior', async () => {
        const { admin, client, contract } = await seedBase();
        const from = nextWeekday(addDaysYmd(todaySp, 3));
        const to = nextWeekday(addDaysYmd(from, 1));
        const started = { recordingStartedAt: new Date(), recordingStartedById: admin.id, recordingStartedByName: admin.name };
        const a = await mkBooking(client.id, contract.id, { date: dbDate(from), startTime: '10:00', endTime: '12:00', status: 'CONFIRMED', ...started });
        const c = await mkBooking(client.id, contract.id, { date: dbDate(from), startTime: '13:00', endTime: '15:00', status: 'CONFIRMED', ...started });
        const done = await mkBooking(client.id, contract.id, { date: dbDate(from), startTime: '15:30', endTime: '17:30', status: 'COMPLETED', ...started });

        // Admin só salva uma nota (mesmo dia/horário): o início fica.
        expect((await call('PATCH', `/api/bookings/${a.id}`, admin, { date: from, startTime: '10:00', adminNotes: 'ok' })).status).toBe(200);
        expect((await prisma.booking.findUniqueOrThrow({ where: { id: a.id } })).recordingStartedAt).not.toBeNull();

        // Admin muda o dia de uma sessão aberta → nova sessão.
        const moved = await call('PATCH', `/api/bookings/${a.id}`, admin, { date: to, startTime: '10:00' });
        expect(moved.status, moved.text).toBe(200);
        const aAfter = await prisma.booking.findUniqueOrThrow({ where: { id: a.id } });
        expect(aAfter.recordingStartedAt).toBeNull();
        expect(aAfter.recordingStartedById).toBeNull();
        expect(aAfter.recordingStartedByName).toBeNull();
        expect((await call('GET', `/api/bookings/${a.id}`, client)).body.booking.isRecordingNow).toBe(false);

        // Admin corrige a data de uma gravação JÁ finalizada: o registro do operador é preservado.
        expect((await call('PATCH', `/api/bookings/${done.id}`, admin, { date: to, startTime: '15:30' })).status).toBe(200);
        expect((await prisma.booking.findUniqueOrThrow({ where: { id: done.id } })).recordingStartedByName).toBe(admin.name);

        // Cliente reagenda.
        const res = await call('PATCH', `/api/bookings/${c.id}/reschedule`, client, { date: to, startTime: '13:00' });
        expect(res.status, res.text).toBe(200);
        expect(res.body.booking).toMatchObject({ isRecordingNow: false, recordingStartedAt: null });
        expect((await prisma.booking.findUniqueOrThrow({ where: { id: c.id } })).recordingStartedByName).toBeNull();
    });
});

describe('E12 — client-update: quem pode, quando pode e o que pode', () => {
    it('dono edita em RESERVED / HELD / CONFIRMED (inclusive durante a gravação); o GET reflete o que foi salvo', async () => {
        const { client, contract } = await seedBase();
        const day = nextWeekday(addDaysYmd(todaySp, 2));
        const cases: [string, Record<string, unknown>][] = [
            ['RESERVED', { holdExpiresAt: new Date(Date.now() + 10 * 60_000) }],
            ['HELD', {}],
            ['CONFIRMED', {}],
            ['CONFIRMED', { recordingStartedAt: new Date() }],
        ];
        const times = ['10:00', '13:00', '15:30', '18:00'];
        for (const [i, [status, extra]] of cases.entries()) {
            const b = await mkBooking(client.id, contract.id, { date: dbDate(day), startTime: times[i], endTime: '23:00', status: status as any, ...extra });
            const r = await call('PATCH', `/api/bookings/${b.id}/client-update`, client, {
                episodeTitle: `  Episódio   ${i}  `, episodeDescription: '  Pauta do dia\ncom duas linhas  ',
                platforms: JSON.stringify(['TIKTOK', 'YOUTUBE', 'TIKTOK']),
            });
            expect(r.status, `${status}: ${r.text}`).toBe(200);
            const saved = {
                episodeTitle: `Episódio ${i}`, episodeDescription: 'Pauta do dia\ncom duas linhas',
                platforms: JSON.stringify(['YOUTUBE', 'TIKTOK']), // sem repetição, na ordem canônica
            };
            expect(r.body.booking).toMatchObject({ ...saved, canEditEpisode: true });
            expect(r.body.message).toBeTruthy();
            expect((await call('GET', `/api/bookings/${b.id}`, client)).body.booking).toMatchObject(saved);
            const db = await prisma.booking.findUniqueOrThrow({ where: { id: b.id } });
            expect(db).toMatchObject(saved);
            expect(db.status).toBe(status);
        }

        // O card da lista (GET /my) reflete o título salvo.
        const titles = (await call('GET', '/api/bookings/my', client)).body.bookings.map((x: any) => x.episodeTitle).sort();
        expect(titles).toEqual(['Episódio 0', 'Episódio 1', 'Episódio 2', 'Episódio 3']);
    });

    it('texto vazio ou null limpa o campo; atualização parcial não mexe no resto', async () => {
        const { client, contract } = await seedBase();
        const b = await mkBooking(client.id, contract.id, {
            date: dbDate(nextWeekday(addDaysYmd(todaySp, 2))), status: 'CONFIRMED',
            episodeTitle: 'Antigo', episodeDescription: 'Descrição antiga', platforms: JSON.stringify(['YOUTUBE']),
            coverImageUrl: '/uploads/cover_keep.jpg',
        });
        const r1 = await call('PATCH', `/api/bookings/${b.id}/client-update`, client, { episodeTitle: 'Novo' });
        expect(r1.status).toBe(200);
        expect(r1.body.booking).toMatchObject({
            episodeTitle: 'Novo', episodeDescription: 'Descrição antiga', platforms: JSON.stringify(['YOUTUBE']), coverImageUrl: '/uploads/cover_keep.jpg',
        });
        const r2 = await call('PATCH', `/api/bookings/${b.id}/client-update`, client, { episodeTitle: '   ', episodeDescription: null, platforms: '[]' });
        expect(r2.status).toBe(200);
        expect(r2.body.booking).toMatchObject({ episodeTitle: null, episodeDescription: null, platforms: '[]', coverImageUrl: '/uploads/cover_keep.jpg' });
        // Corpo sem nenhum campo do episódio: não altera nada.
        const r3 = await call('PATCH', `/api/bookings/${b.id}/client-update`, client, {});
        expect(r3.status).toBe(200);
        expect(r3.body.booking).toMatchObject({ episodeTitle: null, platforms: '[]' });
    });

    it('finalizada, cancelada, falta e não realizada → 409 BOOKING_NOT_EDITABLE sem gravar nada', async () => {
        const { client, contract } = await seedBase();
        const day = nextWeekday(addDaysYmd(todaySp, -5));
        const times = ['10:00', '13:00', '15:30', '18:00'];
        const expectMsg: Record<string, RegExp> = {
            COMPLETED: /finalizada/, CANCELLED: /cancelado/, FALTA: /não foi realizada/, NAO_REALIZADO: /não foi realizada/,
        };
        for (const [i, status] of (['COMPLETED', 'CANCELLED', 'FALTA', 'NAO_REALIZADO'] as const).entries()) {
            const b = await mkBooking(client.id, contract.id, {
                date: dbDate(day), startTime: times[i], endTime: '23:00', status,
                episodeTitle: 'Original', platforms: JSON.stringify(['YOUTUBE']),
            });
            const r = await call('PATCH', `/api/bookings/${b.id}/client-update`, client, {
                episodeTitle: 'Tentativa', episodeDescription: 'x', platforms: JSON.stringify(['TIKTOK']),
            });
            expect(r.status, `${status}: ${r.text}`).toBe(409);
            expect(r.body.code).toBe('BOOKING_NOT_EDITABLE');
            expect(r.body.error).toMatch(expectMsg[status]);
            const db = await prisma.booking.findUniqueOrThrow({ where: { id: b.id } });
            expect(db).toMatchObject({ episodeTitle: 'Original', episodeDescription: null, platforms: JSON.stringify(['YOUTUBE']), status });

            // A mesma regra vale para a capa.
            const cover = await uploadCover(b.id, client, { data: await pngCover(), type: 'image/png', name: 'capa.png' });
            expect(cover.status, `${status}: ${cover.text}`).toBe(409);
            expect(cover.body.code).toBe('BOOKING_NOT_EDITABLE');
            expect((await prisma.booking.findUniqueOrThrow({ where: { id: b.id } })).coverImageUrl).toBeNull();

            // E o GET já avisa a tela (menos a cancelada, que o /:id ainda devolve mas o /my não lista).
            const one = await call('GET', `/api/bookings/${b.id}`, client);
            expect(one.body.booking).toMatchObject({ canEditEpisode: false });
            expect(one.body.booking.editBlockedReason).toBe(r.body.error);
        }
    });

    it('não-dono → 404 (inclusive admin que não é o dono); sem login → 401', async () => {
        const { admin, client, contract } = await seedBase();
        const stranger = await mkUser();
        const b = await mkBooking(client.id, contract.id, { date: dbDate(nextWeekday(addDaysYmd(todaySp, 2))), status: 'CONFIRMED', episodeTitle: 'Do dono' });

        expect((await call('PATCH', `/api/bookings/${b.id}/client-update`, stranger, { episodeTitle: 'Invasão' })).status).toBe(404);
        expect((await call('PATCH', `/api/bookings/${b.id}/client-update`, admin, { episodeTitle: 'Invasão' })).status).toBe(404);
        expect((await call('PATCH', `/api/bookings/${b.id}/client-update`, undefined, { episodeTitle: 'Invasão' })).status).toBe(401);
        expect((await uploadCover(b.id, stranger, { data: await pngCover(), type: 'image/png', name: 'c.png' })).status).toBe(404);
        expect((await uploadCover(b.id, undefined, { data: await pngCover(), type: 'image/png', name: 'c.png' })).status).toBe(401);
        const db = await prisma.booking.findUniqueOrThrow({ where: { id: b.id } });
        expect(db.episodeTitle).toBe('Do dono');
        expect(db.coverImageUrl).toBeNull();
    });

    it('validação dos campos: limites, tipos e redes desconhecidas → 400 com mensagem clara, sem gravar', async () => {
        const { client, contract } = await seedBase();
        const b = await mkBooking(client.id, contract.id, { date: dbDate(nextWeekday(addDaysYmd(todaySp, 2))), status: 'CONFIRMED', episodeTitle: 'Original' });
        const bad: [Record<string, unknown>, RegExp][] = [
            [{ episodeTitle: 'x'.repeat(141) }, /título.*140/i],
            [{ episodeDescription: 'x'.repeat(4001) }, /descrição.*4000/i],
            [{ episodeTitle: 123 }, /Título inválido/],
            [{ episodeDescription: { a: 1 } }, /Descrição inválida/],
            [{ platforms: 'YOUTUBE' }, /Redes de transmissão inválidas/],
            [{ platforms: JSON.stringify({ YOUTUBE: true }) }, /Redes de transmissão inválidas/],
            [{ platforms: JSON.stringify(['YOUTUBE', 'ORKUT']) }, /Redes de transmissão inválidas/],
            [{ platforms: JSON.stringify(['YOUTUBE', 7]) }, /Redes de transmissão inválidas/],
            [{ platforms: ['YOUTUBE'] }, /Redes de transmissão inválidas/],
        ];
        for (const [body, msg] of bad) {
            const r = await call('PATCH', `/api/bookings/${b.id}/client-update`, client, { episodeTitle: 'Não deve gravar', ...body });
            expect(r.status, JSON.stringify(body)).toBe(400);
            expect(r.body.error).toMatch(msg);
        }
        expect((await prisma.booking.findUniqueOrThrow({ where: { id: b.id } })).episodeTitle).toBe('Original');

        // No limite exato passa.
        const ok = await call('PATCH', `/api/bookings/${b.id}/client-update`, client, { episodeTitle: 'y'.repeat(140), episodeDescription: 'z'.repeat(4000) });
        expect(ok.status).toBe(200);
    });

    it('o cliente não escreve o que é do estúdio: clientNotes (feedback), links, métricas, status e nota interna são ignorados', async () => {
        const { client, contract } = await seedBase();
        const b = await mkBooking(client.id, contract.id, {
            date: dbDate(nextWeekday(addDaysYmd(todaySp, 2))), status: 'CONFIRMED',
            adminNotes: SECRET_NOTE, clientNotes: FEEDBACK, price: 30000,
        });
        const r = await call('PATCH', `/api/bookings/${b.id}/client-update`, client, {
            episodeTitle: 'Só o título',
            clientNotes: 'feedback forjado', adminNotes: 'apagada', platformLinks: JSON.stringify({ YOUTUBE: 'https://evil.example' }),
            streamMetrics: JSON.stringify({ YOUTUBE: { views: 999999 } }), isLivestream: true,
            durationMinutes: 600, peakViewers: 999999, chatMessages: 999999, audienceOrigin: 'forjado',
            status: 'COMPLETED', price: 1, coverImageUrl: 'https://evil.example/x.jpg', recordingStartedAt: new Date().toISOString(),
        });
        expect(r.status, r.text).toBe(200);
        expectNoAdminNotes(r);
        const db = await prisma.booking.findUniqueOrThrow({ where: { id: b.id } });
        expect(db).toMatchObject({
            episodeTitle: 'Só o título', clientNotes: FEEDBACK, adminNotes: SECRET_NOTE, platformLinks: null,
            streamMetrics: null, isLivestream: null, durationMinutes: null, peakViewers: null, chatMessages: null,
            audienceOrigin: null, status: 'CONFIRMED', price: 30000, coverImageUrl: null, recordingStartedAt: null,
        });
    });
});

describe('E12 — capa do episódio (POST /:id/cover-image)', () => {
    it('dono envia a capa numa reserva aberta: arquivo otimizado em /uploads e coverImageUrl no GET; trocar apaga a anterior', async () => {
        const { client, contract } = await seedBase();
        const b = await mkBooking(client.id, contract.id, { date: dbDate(nextWeekday(addDaysYmd(todaySp, 2))), status: 'RESERVED' });

        const first = await uploadCover(b.id, client, { data: await pngCover(), type: 'image/png', name: 'capa.png' });
        expect(first.status, first.text).toBe(200);
        expect(first.body.coverImageUrl).toMatch(/^\/uploads\/cover_.+\.jpg$/);
        const firstPath = path.join(UPLOADS_DIR, path.basename(first.body.coverImageUrl));
        expect(fs.existsSync(firstPath)).toBe(true);
        const meta = await sharp(firstPath).metadata();
        expect([meta.format, meta.width, meta.height]).toEqual(['jpeg', 1280, 720]);
        expect((await call('GET', `/api/bookings/${b.id}`, client)).body.booking.coverImageUrl).toBe(first.body.coverImageUrl);
        expect((await call('GET', '/api/bookings/my', client)).body.bookings[0].coverImageUrl).toBe(first.body.coverImageUrl);

        await new Promise(r => setTimeout(r, 5)); // nome do arquivo usa Date.now()
        const second = await uploadCover(b.id, client, { data: await pngCover(), type: 'image/png', name: 'capa2.png' });
        expect(second.status, second.text).toBe(200);
        expect(second.body.coverImageUrl).not.toBe(first.body.coverImageUrl);
        expect(second.body.booking.coverImageUrl).toBe(second.body.coverImageUrl);
        // limpeza best-effort da capa anterior
        for (let i = 0; i < 20 && fs.existsSync(firstPath); i++) await new Promise(r => setTimeout(r, 25));
        expect(fs.existsSync(firstPath)).toBe(false);
    });

    it('sem arquivo, formato não aceito e imagem ilegível → 400 (nunca 500) e nada é gravado', async () => {
        const { client, contract } = await seedBase();
        const b = await mkBooking(client.id, contract.id, { date: dbDate(nextWeekday(addDaysYmd(todaySp, 2))), status: 'CONFIRMED' });

        const none = await uploadCover(b.id, client, null);
        expect(none.status).toBe(400);
        const svg = await uploadCover(b.id, client, { data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), type: 'image/svg+xml', name: 'x.svg' });
        expect(svg.status).toBe(400);
        expect(svg.body.error).toMatch(/Formato inválido/);
        const broken = await uploadCover(b.id, client, { data: Buffer.from('isto não é uma imagem'), type: 'image/png', name: 'x.png' });
        expect(broken.status, broken.text).toBe(400);
        expect(broken.body.error).toMatch(/Não foi possível ler a imagem/);
        expect((await prisma.booking.findUniqueOrThrow({ where: { id: b.id } })).coverImageUrl).toBeNull();
    });
});

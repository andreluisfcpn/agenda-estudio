import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { prisma } from '../../src/lib/prisma';
import { redis } from '../../src/lib/redis';
import { createNotification } from '../../src/modules/notifications/notificationService';
import { runBookingReminderJob, REMINDER_LAST_RUN_KEY } from '../../src/jobs/bookingReminderJob';
import { mkUser, mkContract, mkBooking } from './factories';

// Revisão jobs-tempo-migrations-7: a dedup de notificação era GET → create → SET (não atômica) —
// duas rodadas concorrentes do job de lembrete mandavam o mesmo lembrete duas vezes.
// Agora o createNotification faz claim atômico (SET NX) antes de criar.

const dedupKeys: string[] = [];

afterEach(async () => {
    vi.restoreAllMocks();
    const keys = dedupKeys.splice(0).map(k => `notif:dedup:${k}`);
    if (keys.length) await redis.del(...keys);
});

describe('createNotification — dedup atômica', () => {
    it('duas chamadas simultâneas com a mesma chave criam UMA notificação', async () => {
        const u = await mkUser();
        const key = `itest-dedup:${u.id}`;
        dedupKeys.push(key);
        const input = { userId: u.id, type: 'SYSTEM' as const, severity: 'info' as const, title: 't', message: 'm', dedupKey: key, sendPush: false };
        const results = await Promise.all([createNotification(input), createNotification(input), createNotification(input)]);
        expect(await prisma.notification.count({ where: { userId: u.id } })).toBe(1);
        const created = await prisma.notification.findFirstOrThrow({ where: { userId: u.id } });
        // Quem criou devolve o id; os concorrentes devolvem o mesmo id ou '' (ainda em criação) — nunca outro.
        expect(results.filter(r => r === created.id).length).toBeGreaterThanOrEqual(1);
        for (const r of results) expect([created.id, '']).toContain(r);
        // Depois de criada, a chave guarda o id (não o marcador provisório).
        expect(await redis.get(`notif:dedup:${key}`)).toBe(created.id);
        expect(await createNotification(input)).toBe(created.id);
    });

    it('falha ao criar libera o claim (a próxima tentativa não é engolida pela dedup)', async () => {
        const u = await mkUser();
        const key = `itest-dedup-fail:${u.id}`;
        dedupKeys.push(key);
        const base = { userId: u.id, severity: 'info' as const, title: 't', message: 'm', dedupKey: key, sendPush: false };
        await expect(createNotification({ ...base, type: 'NAO_EXISTE' as never })).rejects.toBeTruthy();
        expect(await redis.get(`notif:dedup:${key}`)).toBeNull();
        const id = await createNotification({ ...base, type: 'SYSTEM' });
        expect(id).toBeTruthy();
        expect(await prisma.notification.count({ where: { userId: u.id } })).toBe(1);
    });
});

describe('runBookingReminderJob — duas rodadas em paralelo não duplicam o lembrete', () => {
    // Sessão em 20/01/2027 às 10:00 SP (13:00Z). O de 24h vence em 19/01 13:00:00Z; `now` = 1s depois.
    const SESSION_DATE = new Date('2027-01-20T00:00:00Z');
    const NOW = new Date('2027-01-19T13:00:01Z');

    beforeEach(() => {
        // Redis compartilhado com o dev: nunca ler/gravar o last-run real do job.
        const origGet = redis.get.bind(redis) as (...a: unknown[]) => Promise<unknown>;
        const origSet = redis.set.bind(redis) as (...a: unknown[]) => Promise<unknown>;
        vi.spyOn(redis, 'get').mockImplementation(((key: unknown, ...rest: unknown[]) =>
            key === REMINDER_LAST_RUN_KEY ? Promise.resolve(null) : origGet(key, ...rest)) as never);
        vi.spyOn(redis, 'set').mockImplementation(((key: unknown, ...rest: unknown[]) =>
            key === REMINDER_LAST_RUN_KEY ? Promise.resolve('OK') : origSet(key, ...rest)) as never);
    });

    it('1 lembrete de 24h por sessão, mesmo com as rodadas sobrepostas', async () => {
        const u = await mkUser();
        const c = await mkContract(u.id, { type: 'FIXO', status: 'ACTIVE' });
        const b = await mkBooking(u.id, c.id, { date: SESSION_DATE, startTime: '10:00', endTime: '12:00', status: 'CONFIRMED', createdAt: new Date('2027-01-01T12:00:00Z') });
        dedupKeys.push(`reminder:24h:${b.id}:2027-01-20`, `reminder:2h:${b.id}:2027-01-20`);

        await Promise.all([runBookingReminderJob(NOW), runBookingReminderJob(NOW)]);
        expect(await prisma.notification.count({ where: { userId: u.id, type: 'BOOKING_REMINDER' } })).toBe(1);
    });
});

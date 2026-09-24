import { describe, it, expect, vi } from 'vitest';

// Unit test puro: sem banco/Redis. Os módulos com conexão são trocados por stubs; a config vem da memória.
vi.mock('../src/lib/prisma.js', () => ({ prisma: {} }));
vi.mock('../src/lib/redis.js', () => ({ redis: {}, acquireMultiSlotLock: vi.fn(), releaseMultiSlotLock: vi.fn() }));
vi.mock('../src/modules/notifications/notificationService.js', () => ({ notifyEvent: vi.fn(async () => '') }));
vi.mock('../src/lib/businessConfig.js', () => ({
    getConfig: async (k: string) => (k === 'avulso_makeup_days' ? 7 : 0),
    getConfigString: async () => '',
    getAllConfigs: async () => ({}),
    invalidateConfigCache: () => {},
}));

import {
    computeMakeupDeadline,
    lastMakeupYmd,
    deadlineYmd,
    makeupDaysLeft,
    isMakeupOpen,
    addDaysYmd,
    ddmmOfYmd,
    validateNoShowJustification,
} from '../src/lib/avulsoMakeup';

// Booking.date é @db.Date: a data-calendário SP à 00:00Z.
const dbDate = (ymd: string) => new Date(`${ymd}T00:00:00Z`);
// Instante de um horário de parede em São Paulo (UTC-3, sem horário de verão).
const sp = (ymd: string, hhmm: string, ss = '00') => new Date(`${ymd}T${hhmm}:${ss}-03:00`);

describe('prazo da remarcação (D+7, fim do dia em São Paulo)', () => {
    it('vai até 23:59:59.999 SP do dia D+7 (02:59:59.999Z do dia seguinte)', () => {
        const d = computeMakeupDeadline(dbDate('2026-09-15'), 7);
        expect(d.toISOString()).toBe('2026-09-23T02:59:59.999Z');
        expect(lastMakeupYmd(dbDate('2026-09-15'), 7)).toBe('2026-09-22');
        expect(deadlineYmd(d)).toBe('2026-09-22'); // o último dia no calendário SP
    });

    it('gravação às 22:00 SP (já é o dia seguinte em UTC) continua contando D = data SP', () => {
        // A sessão perdida é 15/09 às 22:00 SP = 16/09 01:00Z. D é 15/09 (a data do booking), não 16/09.
        const booking = { date: dbDate('2026-09-15'), startTime: '22:00' };
        const deadline = computeMakeupDeadline(booking.date, 7);
        expect(deadlineYmd(deadline)).toBe('2026-09-22');
        // 22/09 às 23:30 SP ainda está dentro (em UTC já é 23/09 02:30).
        expect(isMakeupOpen({ status: 'FALTA', makeupStatus: 'OPEN', makeupDeadline: deadline }, sp('2026-09-22', '23:30'))).toBe(true);
        // 23/09 00:00:30 SP já passou (em UTC ainda seria "22/09 + 3h").
        expect(isMakeupOpen({ status: 'FALTA', makeupStatus: 'OPEN', makeupDeadline: deadline }, sp('2026-09-23', '00:00', '30'))).toBe(false);
    });

    it('virada de mês/ano usa aritmética de calendário', () => {
        expect(lastMakeupYmd(dbDate('2026-12-28'), 7)).toBe('2027-01-04');
        expect(addDaysYmd('2028-02-25', 7)).toBe('2028-03-03'); // 2028 é bissexto
        expect(ddmmOfYmd('2027-01-04')).toBe('04/01');
    });

    it('prazo configurável (avulso_makeup_days)', () => {
        expect(deadlineYmd(computeMakeupDeadline(dbDate('2026-09-15'), 3))).toBe('2026-09-18');
        expect(deadlineYmd(computeMakeupDeadline(dbDate('2026-09-15'), 0))).toBe('2026-09-15');
    });
});

describe('makeupDaysLeft (dias de calendário SP, contando hoje)', () => {
    const deadline = computeMakeupDeadline(dbDate('2026-09-15'), 7); // último dia 22/09
    it('no último dia = 1, na véspera = 2', () => {
        expect(makeupDaysLeft(deadline, sp('2026-09-22', '08:00'))).toBe(1);
        expect(makeupDaysLeft(deadline, sp('2026-09-21', '23:00'))).toBe(2); // 22h+ SP já é 22/09 em UTC
        expect(makeupDaysLeft(deadline, sp('2026-09-16', '10:00'))).toBe(7);
    });
    it('depois do prazo ≤ 0', () => {
        expect(makeupDaysLeft(deadline, sp('2026-09-23', '00:10'))).toBe(0);
    });
});

describe('isMakeupOpen', () => {
    const deadline = new Date('2026-09-23T02:59:59.999Z');
    const now = new Date('2026-09-20T12:00:00Z');
    it('OPEN + prazo futuro + FALTA/NAO_REALIZADO → aberta', () => {
        expect(isMakeupOpen({ status: 'FALTA', makeupStatus: 'OPEN', makeupDeadline: deadline }, now)).toBe(true);
        expect(isMakeupOpen({ status: 'NAO_REALIZADO', makeupStatus: 'OPEN', makeupDeadline: deadline.toISOString() }, now)).toBe(true);
    });
    it('USED/EXPIRED/null, status já remarcado ou sem prazo → fechada', () => {
        expect(isMakeupOpen({ status: 'FALTA', makeupStatus: 'USED', makeupDeadline: deadline }, now)).toBe(false);
        expect(isMakeupOpen({ status: 'FALTA', makeupStatus: 'EXPIRED', makeupDeadline: deadline }, now)).toBe(false);
        expect(isMakeupOpen({ status: 'FALTA', makeupStatus: null, makeupDeadline: null }, now)).toBe(false);
        expect(isMakeupOpen({ status: 'CONFIRMED', makeupStatus: 'OPEN', makeupDeadline: deadline }, now)).toBe(false);
        expect(isMakeupOpen({ status: 'FALTA', makeupStatus: 'OPEN', makeupDeadline: null }, now)).toBe(false);
    });
});

describe('validateNoShowJustification (pré-validação do PATCH admin)', () => {
    const base = { finalStatus: 'FALTA', contractType: 'AVULSO', makeupStatus: null, bookingDate: dbDate('2026-09-15') };
    it('FALTA de avulso dentro do prazo → ok', async () => {
        expect(await validateNoShowJustification({ ...base, now: sp('2026-09-15', '15:00') })).toBeNull();
        expect(await validateNoShowJustification({ ...base, now: sp('2026-09-22', '23:59') })).toBeNull();
    });
    it('prazo vencido, status ≠ FALTA, contrato não avulso ou remarcação já usada → erro', async () => {
        expect(await validateNoShowJustification({ ...base, now: sp('2026-09-23', '00:00', '01') })).toMatch(/prazo/);
        expect(await validateNoShowJustification({ ...base, finalStatus: 'NAO_REALIZADO', now: sp('2026-09-16', '10:00') })).toMatch(/status Falta/);
        expect(await validateNoShowJustification({ ...base, contractType: 'FLEX', now: sp('2026-09-16', '10:00') })).toMatch(/avulsa/);
        expect(await validateNoShowJustification({ ...base, makeupStatus: 'USED', now: sp('2026-09-16', '10:00') })).toMatch(/única/);
        expect(await validateNoShowJustification({ ...base, makeupStatus: 'EXPIRED', now: sp('2026-09-16', '10:00') })).toMatch(/terminou/);
    });
    it('já justificada (OPEN) → idempotente', async () => {
        expect(await validateNoShowJustification({ ...base, makeupStatus: 'OPEN', now: sp('2026-09-16', '10:00') })).toBeNull();
    });
});

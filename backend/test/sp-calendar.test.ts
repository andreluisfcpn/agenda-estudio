import { describe, it, expect } from 'vitest';
import { saoPauloParts, spDaysFromToday, spDdMm, spWeekday, spDayLabel } from '../src/lib/spTime';
import { studioDateTime } from '../src/utils/pricing';

describe('saoPauloParts', () => {
  it('converts a midday UTC instant to SP parts (UTC-3)', () => {
    // 12:00Z → 09:00 SP, same calendar day
    const sp = saoPauloParts(new Date('2026-01-15T12:00:00Z'));
    expect(sp).toEqual({ y: 2026, m: 1, day: 15, hour: 9, dateStr: '2026-01-15' });
  });

  it('keeps the previous SP day for an early next-UTC-day instant (21:00–24:00 SP)', () => {
    // 02:00Z on Jan 16 → 23:00 SP on Jan 15 (SP is still the previous day)
    const sp = saoPauloParts(new Date('2026-01-16T02:00:00Z'));
    expect(sp.day).toBe(15);
    expect(sp.hour).toBe(23);
    expect(sp.dateStr).toBe('2026-01-15');
  });

  it('handles SP midnight (03:00Z) as hour 0 of the same day', () => {
    // 03:00Z → 00:00 SP
    const sp = saoPauloParts(new Date('2026-01-15T03:00:00Z'));
    expect(sp.hour).toBe(0);
    expect(sp.day).toBe(15);
    expect(sp.dateStr).toBe('2026-01-15');
  });

  it('rolls the SP date back across a UTC month boundary', () => {
    // 01:00Z Feb 1 → 22:00 SP Jan 31
    const sp = saoPauloParts(new Date('2026-02-01T01:00:00Z'));
    expect(sp).toEqual({ y: 2026, m: 1, day: 31, hour: 22, dateStr: '2026-01-31' });
  });

  it('zero-pads month and day in dateStr', () => {
    // 12:00Z → 09:00 SP on Mar 5
    const sp = saoPauloParts(new Date('2026-03-05T12:00:00Z'));
    expect(sp.dateStr).toBe('2026-03-05');
    expect(sp.m).toBe(3);
    expect(sp.day).toBe(5);
  });
});

describe('spDaysFromToday', () => {
  const now = new Date('2026-01-15T12:00:00Z'); // SP date = 2026-01-15

  it('returns 0 for a booking on the SP today', () => {
    expect(spDaysFromToday(new Date('2026-01-15T00:00:00Z'), now)).toBe(0);
  });

  it('returns 1 for a booking tomorrow', () => {
    expect(spDaysFromToday(new Date('2026-01-16T00:00:00Z'), now)).toBe(1);
  });

  it('returns -1 for a booking yesterday', () => {
    expect(spDaysFromToday(new Date('2026-01-14T00:00:00Z'), now)).toBe(-1);
  });

  it('uses the SP calendar day of now, not the UTC day', () => {
    // now = 02:00Z Jan 16 is still Jan 15 in SP → a Jan 15 booking is hoje (0)
    const spRollover = new Date('2026-01-16T02:00:00Z');
    expect(spDaysFromToday(new Date('2026-01-15T00:00:00Z'), spRollover)).toBe(0);
    expect(spDaysFromToday(new Date('2026-01-16T00:00:00Z'), spRollover)).toBe(1);
  });

  it('spans multiple days and across month boundaries', () => {
    // now SP = Jan 15; booking Feb 1 → 17 days
    expect(spDaysFromToday(new Date('2026-02-01T00:00:00Z'), now)).toBe(17);
    // booking Dec 31 2025 → -15 days
    expect(spDaysFromToday(new Date('2025-12-31T00:00:00Z'), now)).toBe(-15);
  });
});

describe('spDdMm', () => {
  it('formats a stored date as DD/MM', () => {
    expect(spDdMm(new Date('2026-01-05T00:00:00Z'))).toBe('05/01');
  });

  it('zero-pads and keeps two-digit values', () => {
    expect(spDdMm(new Date('2026-12-25T00:00:00Z'))).toBe('25/12');
    expect(spDdMm(new Date('2026-09-09T00:00:00Z'))).toBe('09/09');
  });
});

describe('spWeekday', () => {
  it('names the weekday of the stored calendar date (pt-BR)', () => {
    expect(spWeekday(new Date('2026-01-15T00:00:00Z'))).toBe('quinta-feira');
    expect(spWeekday(new Date('2026-01-16T00:00:00Z'))).toBe('sexta-feira');
    expect(spWeekday(new Date('2026-09-16T00:00:00Z'))).toBe('quarta-feira');
  });

  it('does not slip a day due to timezone (00:00Z stored date)', () => {
    // 00:00Z would be the previous evening in SP; anchoring at midday UTC keeps the calendar day.
    expect(spWeekday(new Date('2026-09-16T00:00:00Z'))).toBe('quarta-feira');
  });
});

describe('spDayLabel — rótulo de lembrete sem "amanhã" que envelheça no push', () => {
  it('diz "hoje (DD/MM)" quando é o próprio dia (lembrete de 2h)', () => {
    const now = new Date('2026-09-16T12:00:00Z'); // SP = 16/09
    expect(spDayLabel(new Date('2026-09-16T00:00:00Z'), now)).toBe('hoje (16/09)');
  });

  it('usa a data absoluta com dia da semana para a véspera (lembrete de 24h), nunca "amanhã"', () => {
    const now = new Date('2026-09-15T12:00:00Z'); // SP = 15/09
    const label = spDayLabel(new Date('2026-09-16T00:00:00Z'), now);
    expect(label).toBe('quarta-feira (16/09)');
    expect(label).not.toContain('amanhã');
  });

  it('a véspera lida no dia seguinte continua correta (o texto não muda, mas nunca vira "amanhã")', () => {
    // Rótulo gerado na véspera (24h) = "quarta-feira (16/09)"; lido no dia 16 ainda faz sentido.
    const geradoNaVespera = spDayLabel(new Date('2026-09-16T00:00:00Z'), new Date('2026-09-15T12:00:00Z'));
    expect(geradoNaVespera).toBe('quarta-feira (16/09)');
  });

  it('respeita a virada de dia SP (21h–24h ainda é o dia anterior)', () => {
    // 02:00Z de 16/09 = 23:00 SP de 15/09 → uma sessão 16/09 ainda NÃO é "hoje"
    const spAindaDia15 = new Date('2026-09-16T02:00:00Z');
    expect(spDayLabel(new Date('2026-09-16T00:00:00Z'), spAindaDia15)).toBe('quarta-feira (16/09)');
    // e a sessão de 15/09 é "hoje"
    expect(spDayLabel(new Date('2026-09-15T00:00:00Z'), spAindaDia15)).toBe('hoje (15/09)');
  });
});

describe('studioDateTime', () => {
  it('anchors the wall-clock date+time to the -03:00 offset', () => {
    // 14:00 SP == 17:00 UTC
    const d = studioDateTime('2026-01-15', '14:00');
    expect(d.toISOString()).toBe('2026-01-15T17:00:00.000Z');
  });

  it('rolls into the next UTC day for late SP times', () => {
    // 22:00 SP == 01:00 UTC next day
    const d = studioDateTime('2026-01-15', '22:00');
    expect(d.toISOString()).toBe('2026-01-16T01:00:00.000Z');
  });

  it('maps midnight SP to 03:00 UTC same day', () => {
    const d = studioDateTime('2026-01-15', '00:00');
    expect(d.toISOString()).toBe('2026-01-15T03:00:00.000Z');
  });
});

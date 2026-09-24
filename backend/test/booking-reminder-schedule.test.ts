import { describe, it, expect } from 'vitest';
import {
  REMINDER_WINDOWS,
  TICK_MS,
  MAX_CATCHUP_MS,
  reminderScanRange,
  evaluateReminder,
  effectiveLastRun,
  evaluateLatePaidDayBefore,
  MAX_LAST_RUN_SKEW_MS,
  bookingStartMs,
  type ReminderBooking,
  type ReminderWindow,
} from '../src/lib/bookingReminderSchedule';

// Lembretes de sessão (D14): 24h EXATAMENTE antes com "amanhã (DD/MM)", 2h EXATAMENTE antes com
// "hoje (DD/MM)", sem 24h para sessões marcadas com <24h, catch-up ≤60 min.

const W24 = REMINDER_WINDOWS.find(w => w.label === '24h')!;
const W2 = REMINDER_WINDOWS.find(w => w.label === '2h')!;

/** Instante a partir de um horário de parede SP (UTC-3). */
const sp = (isoLocal: string) => new Date(`${isoLocal}-03:00`);

/** Sessão (date @db.Date 00:00Z) marcada bem antes por padrão. */
function booking(date: string, startTime: string, createdAt = sp('2026-09-01T12:00:00')): ReminderBooking {
  return { date: new Date(`${date}T00:00:00Z`), startTime, createdAt };
}

/** Uma execução do job às `nowIso` (SP) com o last-run `lastRunIso` (SP) ou sem last-run. */
function runAt(b: ReminderBooking, w: ReminderWindow, nowIso: string, lastRunIso: string | null = null) {
  const now = sp(nowIso);
  const range = reminderScanRange(now.getTime(), lastRunIso ? sp(lastRunIso).getTime() : null);
  return evaluateReminder(b, w, range, now);
}

describe('REMINDER_WINDOWS', () => {
  it('mantém os rótulos da dedupKey do job antigo (reminder:24h|2h:…) e os eventos do catálogo', () => {
    expect(REMINDER_WINDOWS.map(w => [w.label, w.eventKey, w.offsetMs, w.spDayDiff])).toEqual([
      ['24h', 'booking_reminder_24h', 24 * 3_600_000, 1],
      ['2h', 'booking_reminder_2h', 2 * 3_600_000, 0],
    ]);
  });
});

describe('reminderScanRange', () => {
  const now = sp('2026-09-15T10:00:01').getTime();

  it('sem last-run cobre só o último tick (sem catch-up após flush/primeiro deploy)', () => {
    expect(reminderScanRange(now, null)).toEqual({ fromMs: now - TICK_MS, toMs: now });
  });

  it('last-run inválido (NaN) é tratado como ausente', () => {
    expect(reminderScanRange(now, Number('lixo'))).toEqual({ fromMs: now - TICK_MS, toMs: now });
  });

  it('com last-run recente continua exatamente de onde parou', () => {
    const last = now - 60_000;
    expect(reminderScanRange(now, last)).toEqual({ fromMs: last, toMs: now });
  });

  it('last-run antigo é limitado ao teto de 60 min de catch-up', () => {
    const last = now - 3 * 3_600_000;
    expect(reminderScanRange(now, last)).toEqual({ fromMs: now - MAX_CATCHUP_MS, toMs: now });
    expect(MAX_CATCHUP_MS).toBe(60 * 60_000);
  });

  it('last-run no futuro (relógio divergente) gera intervalo vazio', () => {
    const r = reminderScanRange(now, now + 30_000);
    expect(r.fromMs).toBeGreaterThanOrEqual(r.toMs);
  });
});

describe('bookingStartMs', () => {
  it('ancora data + hora no fuso SP', () => {
    expect(new Date(bookingStartMs(new Date('2026-09-16T00:00:00Z'), '10:00')).toISOString()).toBe('2026-09-16T13:00:00.000Z');
    // 22:30 SP já é o dia UTC seguinte
    expect(new Date(bookingStartMs(new Date('2026-09-16T00:00:00Z'), '22:30')).toISOString()).toBe('2026-09-17T01:30:00.000Z');
  });
});

describe('evaluateReminder — lembrete de 24h', () => {
  const s = booking('2026-09-16', '10:00'); // quarta 16/09 às 10:00 SP

  it('sessão de 16/09 10:00 → lembrete em 15/09 às 10:00 SP com "amanhã (16/09)"', () => {
    // tick alinhado às 10:00:01 SP (13:00:01Z)
    expect(sp('2026-09-15T10:00:01').toISOString()).toBe('2026-09-15T13:00:01.000Z');
    expect(runAt(s, W24, '2026-09-15T10:00:01', '2026-09-15T09:59:01')).toEqual({
      send: true, label: 'amanhã (16/09)', dueMs: sp('2026-09-15T10:00:00').getTime(),
    });
  });

  it('não sai adiantado: às 09:59:01 ainda não venceu', () => {
    expect(runAt(s, W24, '2026-09-15T09:59:01', '2026-09-15T09:58:01')).toEqual({ send: false, reason: 'fora-da-janela' });
  });

  it('não repete no tick seguinte', () => {
    expect(runAt(s, W24, '2026-09-15T10:01:01', '2026-09-15T10:00:01')).toEqual({ send: false, reason: 'fora-da-janela' });
  });

  it('sessão das 20:30 → lembrete às 20:30 da véspera', () => {
    const noite = booking('2026-09-16', '20:30');
    expect(runAt(noite, W24, '2026-09-15T20:29:01', '2026-09-15T20:28:01').send).toBe(false);
    expect(runAt(noite, W24, '2026-09-15T20:30:01', '2026-09-15T20:29:01')).toMatchObject({ send: true, label: 'amanhã (16/09)' });
  });

  it('sessão das 22:30 (instante já no dia UTC seguinte) → véspera 22:30 SP ainda diz "amanhã"', () => {
    const tarde = booking('2026-09-16', '22:30');
    // 15/09 22:30:01 SP = 16/09 01:30:01Z — o dia SP ainda é 15/09
    expect(runAt(tarde, W24, '2026-09-15T22:30:01', '2026-09-15T22:29:01')).toMatchObject({ send: true, label: 'amanhã (16/09)' });
  });

  it('sessão marcada com menos de 24h de antecedência NÃO recebe o de 24h (mas recebe o de 2h)', () => {
    const tardia = booking('2026-09-16', '10:00', sp('2026-09-15T18:00:00'));
    // mesmo que o intervalo cubra o vencimento (ex.: catch-up), a marcação é posterior a ele
    expect(runAt(tardia, W24, '2026-09-15T10:00:01', '2026-09-15T09:59:01')).toEqual({ send: false, reason: 'marcada-apos-vencimento' });
    expect(runAt(tardia, W2, '2026-09-16T08:00:01', '2026-09-16T07:59:01')).toMatchObject({ send: true, label: 'hoje (16/09)' });
  });

  it('marcação feita durante uma queda, depois do vencimento, não recebe o de 24h no catch-up', () => {
    const tardia = booking('2026-09-16', '10:00', sp('2026-09-15T10:20:00'));
    expect(runAt(tardia, W24, '2026-09-15T10:40:01', '2026-09-15T09:49:01')).toEqual({ send: false, reason: 'marcada-apos-vencimento' });
  });

  it('nunca diz "hoje" no lembrete de 24h (dia SP precisa ser amanhã)', () => {
    // sessão hipotética às 23:30 → vencimento 15/09 23:30 SP; num catch-up que já roda em 16/09 00:10 SP
    // o dia SP da sessão é "hoje" → pulado.
    const madrugada = booking('2026-09-16', '23:30');
    expect(runAt(madrugada, W24, '2026-09-16T00:10:01', '2026-09-15T23:20:01')).toEqual({ send: false, reason: 'dia-sp' });
  });
});

describe('evaluateReminder — lembrete de 2h', () => {
  const s = booking('2026-09-16', '10:00');

  it('sai exatamente 2h antes com "hoje (16/09)"', () => {
    expect(runAt(s, W2, '2026-09-16T07:59:01', '2026-09-16T07:58:01').send).toBe(false);
    expect(runAt(s, W2, '2026-09-16T08:00:01', '2026-09-16T07:59:01')).toEqual({
      send: true, label: 'hoje (16/09)', dueMs: sp('2026-09-16T08:00:00').getTime(),
    });
  });

  it('sessão marcada com menos de 2h de antecedência não recebe o de 2h', () => {
    const encima = booking('2026-09-16', '10:00', sp('2026-09-16T08:30:00'));
    expect(runAt(encima, W2, '2026-09-16T08:00:01', '2026-09-16T07:59:01')).toEqual({ send: false, reason: 'marcada-apos-vencimento' });
  });

  it('nunca diz "amanhã" no lembrete de 2h', () => {
    // sessão hipotética às 01:00 de 16/09 → vencimento 15/09 23:00 SP (dia SP = véspera) → pulado
    const cedo = booking('2026-09-16', '01:00');
    expect(runAt(cedo, W2, '2026-09-15T23:00:01', '2026-09-15T22:59:01')).toEqual({ send: false, reason: 'dia-sp' });
  });

  it('não envia se a sessão já começou', () => {
    const now = sp('2026-09-16T10:05:00');
    // intervalo forjado cobrindo o vencimento (08:00) com "agora" depois do início
    const range = { fromMs: sp('2026-09-16T07:59:00').getTime(), toMs: sp('2026-09-16T08:01:00').getTime() };
    expect(evaluateReminder(s, W2, range, now)).toEqual({ send: false, reason: 'ja-comecou' });
  });
});

describe('evaluateReminder — catch-up após queda e limites do intervalo', () => {
  const s = booking('2026-09-16', '10:00');

  it('queda das 09:50 às 10:40: o tick das 10:40 recupera o de 24h (ainda "amanhã")', () => {
    expect(runAt(s, W24, '2026-09-15T10:40:01', '2026-09-15T09:49:01')).toMatchObject({ send: true, label: 'amanhã (16/09)' });
  });

  it('queda maior que 60 min: o lembrete vencido há mais de 1h é pulado', () => {
    expect(runAt(s, W24, '2026-09-15T11:05:01', '2026-09-15T08:30:01')).toEqual({ send: false, reason: 'fora-da-janela' });
  });

  it('sem last-run (flush do Redis) não recupera vencimentos antigos', () => {
    expect(runAt(s, W24, '2026-09-15T10:05:01', null)).toEqual({ send: false, reason: 'fora-da-janela' });
  });

  it('intervalo (from, to]: vencimento == from não envia; vencimento == to envia', () => {
    const due = sp('2026-09-15T10:00:00').getTime();
    const now = sp('2026-09-15T10:00:00');
    expect(evaluateReminder(s, W24, { fromMs: due, toMs: due + 60_000 }, now).send).toBe(false);
    expect(evaluateReminder(s, W24, { fromMs: due - 60_000, toMs: due }, now).send).toBe(true);
  });
});

describe('simulação minuto a minuto (last-run encadeado)', () => {
  /** Roda ticks a cada minuto (hh:mm:01 SP) entre início e fim, pulando os minutos em `down`. */
  function simulate(b: ReminderBooking, startIso: string, endIso: string, down?: [string, string]) {
    const sent: { label: string; at: string; window: string }[] = [];
    let lastRun: number | null = null;
    const downFrom = down ? sp(down[0]).getTime() : Infinity;
    const downTo = down ? sp(down[1]).getTime() : -Infinity;
    for (let t = sp(startIso).getTime(); t <= sp(endIso).getTime(); t += 60_000) {
      if (t >= downFrom && t <= downTo) continue; // servidor fora do ar
      const now = new Date(t);
      const range = reminderScanRange(t, lastRun);
      for (const w of REMINDER_WINDOWS) {
        const d = evaluateReminder(b, w, range, now);
        if (d.send) sent.push({ window: w.label, label: d.label, at: now.toISOString() });
      }
      lastRun = range.toMs;
    }
    return sent;
  }

  it('envia exatamente um 24h e um 2h, cada um no minuto exato', () => {
    const sent = simulate(booking('2026-09-16', '10:00'), '2026-09-15T00:00:01', '2026-09-16T12:00:01');
    expect(sent).toEqual([
      { window: '24h', label: 'amanhã (16/09)', at: sp('2026-09-15T10:00:01').toISOString() },
      { window: '2h', label: 'hoje (16/09)', at: sp('2026-09-16T08:00:01').toISOString() },
    ]);
  });

  it('com queda de 50 min cobrindo o vencimento, o 24h sai uma vez no primeiro tick de volta', () => {
    const sent = simulate(booking('2026-09-16', '10:00'), '2026-09-15T09:00:01', '2026-09-15T12:00:01',
      ['2026-09-15T09:50:01', '2026-09-15T10:39:01']);
    expect(sent).toEqual([{ window: '24h', label: 'amanhã (16/09)', at: sp('2026-09-15T10:40:01').toISOString() }]);
  });

  it('com queda de mais de 60 min após o vencimento, o 24h é pulado', () => {
    const sent = simulate(booking('2026-09-16', '10:00'), '2026-09-15T09:00:01', '2026-09-15T12:00:01',
      ['2026-09-15T09:30:01', '2026-09-15T11:04:01']);
    expect(sent).toEqual([]);
  });
});

describe('effectiveLastRun (last-run com TTL longo)', () => {
  const now = sp('2026-09-15T10:00:01').getTime();

  it('last-run pouco no futuro (relógio divergente, até 5 min) é mantido: intervalo vazio', () => {
    expect(effectiveLastRun(now, now + MAX_LAST_RUN_SKEW_MS)).toBe(now + MAX_LAST_RUN_SKEW_MS);
    const r = reminderScanRange(now, now + MAX_LAST_RUN_SKEW_MS);
    expect(r.fromMs).toBeGreaterThanOrEqual(r.toMs);
  });

  it('last-run muito no futuro (lixo de execução manual) é tratado como ausente: só o último tick', () => {
    expect(effectiveLastRun(now, now + 2 * 86_400_000)).toBeNull();
    expect(reminderScanRange(now, now + 2 * 86_400_000)).toEqual({ fromMs: now - TICK_MS, toMs: now });
  });

  it('last-run de horas atrás (queda longa) continua valendo, limitado a 60 min', () => {
    expect(effectiveLastRun(now, now - 5 * 3_600_000)).toBe(now - 5 * 3_600_000);
    expect(reminderScanRange(now, now - 5 * 3_600_000)).toEqual({ fromMs: now - MAX_CATCHUP_MS, toMs: now });
  });
});

describe('evaluateLatePaidDayBefore (24h de contratação paga depois do vencimento)', () => {
  // Sessão 16/09 10:00 SP → 24h vence 15/09 10:00 SP.
  const due = sp('2026-09-15T10:00:00').getTime();
  const b = booking('2026-09-16', '10:00', sp('2026-09-15T09:55:00')); // marcada 24h05 antes
  const nowAfterPay = sp('2026-09-15T10:04:01');
  const lookbackTo = sp('2026-09-15T10:03:01').getTime();                  // início do intervalo normal

  it('paga depois do vencimento, ainda véspera e com >2h: envia "amanhã"', () => {
    expect(evaluateLatePaidDayBefore(b, [due + 3 * 60_000], lookbackTo, nowAfterPay))
      .toEqual({ send: true, label: 'amanhã (16/09)', dueMs: due });
  });

  it('já estava pago no vencimento: não envia (recebeu no horário)', () => {
    expect(evaluateLatePaidDayBefore(b, [due - 60_000, due + 3 * 60_000], lookbackTo, nowAfterPay))
      .toEqual({ send: false, reason: 'pago-antes-do-vencimento' });
  });

  it('sem pagamento depois do vencimento: não envia', () => {
    expect(evaluateLatePaidDayBefore(b, [], lookbackTo, nowAfterPay))
      .toEqual({ send: false, reason: 'sem-pagamento-apos-vencimento' });
  });

  it('marcada com menos de 24h (D14): não envia', () => {
    const late = booking('2026-09-16', '10:00', sp('2026-09-15T10:01:00'));
    expect(evaluateLatePaidDayBefore(late, [due + 3 * 60_000], lookbackTo, nowAfterPay))
      .toEqual({ send: false, reason: 'marcada-apos-vencimento' });
  });

  it('vencimento há mais de 60 min: não envia (teto de catch-up)', () => {
    const now = sp('2026-09-15T11:05:01');
    expect(evaluateLatePaidDayBefore(b, [due + 64 * 60_000], sp('2026-09-15T11:04:01').getTime(), now))
      .toEqual({ send: false, reason: 'fora-da-janela' });
  });

  it('vencimento dentro do intervalo normal fica com a execução normal', () => {
    expect(evaluateLatePaidDayBefore(b, [due + 30_000], sp('2026-09-15T09:59:01').getTime(), sp('2026-09-15T10:00:01')))
      .toEqual({ send: false, reason: 'fora-da-janela' });
  });
});

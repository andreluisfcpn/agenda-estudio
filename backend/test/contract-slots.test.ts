import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Tier } from '../src/generated/prisma/client';

// Config em memória no lugar da BusinessConfig (sem banco). Os testes ajustam `cfgOverrides`.
const BASE_CFG: Record<string, string> = {
    time_slots: '10:00,13:00,15:30,18:00,20:30',
    comercial_slots: '10:00,13:00,15:30',
    audiencia_slots: '18:00,20:30',
    operating_days: '1,2,3,4,5,6',
    slot_duration_hours: '2',
    close_time: '23:00',
};
let cfgOverrides: Record<string, string> = {};
const currentCfg = () => ({ ...BASE_CFG, ...cfgOverrides });

vi.mock('../src/lib/businessConfig.js', () => ({
    getAllConfigs: async () => currentCfg(),
    getConfigString: async (k: string) => currentCfg()[k] ?? '',
    getConfig: async (k: string) => parseFloat(currentCfg()[k] ?? '0'),
    invalidateConfigCache: () => {},
}));

import {
    buildContractSlotGrid, readScheduleGridConfig, resolveSlotTier, contractAllowedDaysFrom, contractAllowedDays,
    slotAllowedForContract, checkSlotInGrid, checkDateSlotInGrid, checkCustomScheduleInGrid,
    checkResolvedConflictsInGrid, weekdayOfDateStr, getContractSlotGrid, validateContractSlot,
    getSlotTierBatch, computeCustomVolume, planCustomOccurrences,
} from '../src/utils/pricing';

const cfg = (over: Record<string, string> = {}) => readScheduleGridConfig({ ...BASE_CFG, ...over });

beforeEach(() => { cfgOverrides = {}; });

describe('contractAllowedDays — D8', () => {
    it('SABADO grava só aos sábados; COMERCIAL/AUDIENCIA só de segunda a sexta', () => {
        expect(contractAllowedDaysFrom(Tier.SABADO, [1, 2, 3, 4, 5, 6])).toEqual([6]);
        expect(contractAllowedDaysFrom(Tier.COMERCIAL, [1, 2, 3, 4, 5, 6])).toEqual([1, 2, 3, 4, 5]);
        expect(contractAllowedDaysFrom(Tier.AUDIENCIA, [1, 2, 3, 4, 5, 6])).toEqual([1, 2, 3, 4, 5]);
    });

    it('cruza com operating_days (dia fechado some)', () => {
        expect(contractAllowedDaysFrom(Tier.COMERCIAL, [1, 2, 4, 5, 6])).toEqual([1, 2, 4, 5]);
        expect(contractAllowedDaysFrom(Tier.SABADO, [1, 2, 3, 4, 5])).toEqual([]);
    });

    it('versão assíncrona lê a config atual', async () => {
        cfgOverrides = { operating_days: '1,3,5,6' };
        expect(await contractAllowedDays(Tier.AUDIENCIA)).toEqual([1, 3, 5]);
    });
});

describe('slotAllowedForContract — hierarquia de faixas', () => {
    it('faixa superior usa horário da inferior; nunca o contrário', () => {
        expect(slotAllowedForContract(Tier.AUDIENCIA, Tier.COMERCIAL)).toBe(true);
        expect(slotAllowedForContract(Tier.AUDIENCIA, Tier.AUDIENCIA)).toBe(true);
        expect(slotAllowedForContract(Tier.COMERCIAL, Tier.AUDIENCIA)).toBe(false);
        expect(slotAllowedForContract(Tier.COMERCIAL, Tier.SABADO)).toBe(false);
        expect(slotAllowedForContract(Tier.SABADO, Tier.SABADO)).toBe(true);
    });

    it('slot sem faixa (fora da grade) ou desconhecido nunca é permitido', () => {
        expect(slotAllowedForContract(Tier.SABADO, null)).toBe(false);
        expect(slotAllowedForContract(Tier.SABADO, undefined)).toBe(false);
        expect(slotAllowedForContract(Tier.SABADO, 'FOO')).toBe(false);
    });
});

describe('resolveSlotTier — paridade com getSlotTierBatch', () => {
    it('mesma faixa para todo dia × horário (inclui horário fora da grade)', async () => {
        const times = ['09:00', '10:00', '13:00', '14:00', '15:30', '18:00', '20:30'];
        const c = cfg();
        for (let dow = 0; dow <= 6; dow++) {
            const batch = await getSlotTierBatch(dow, times);
            for (const t of times) expect(resolveSlotTier(c, dow, t)).toBe(batch.get(t));
        }
    });
});

describe('buildContractSlotGrid', () => {
    it('COMERCIAL: seg–sex com 10:00, 13:00 e 15:30 (fim = início + duração)', () => {
        const g = buildContractSlotGrid(Tier.COMERCIAL, cfg());
        expect(g.tier).toBe(Tier.COMERCIAL);
        expect(g.slotDurationHours).toBe(2);
        expect(g.days.map(d => d.dayOfWeek)).toEqual([1, 2, 3, 4, 5]);
        for (const d of g.days) {
            expect(d.slots).toEqual([
                { time: '10:00', end: '12:00', tier: Tier.COMERCIAL },
                { time: '13:00', end: '15:00', tier: Tier.COMERCIAL },
                { time: '15:30', end: '17:30', tier: Tier.COMERCIAL },
            ]);
        }
    });

    it('AUDIENCIA: seg–sex com os horários comerciais + os de audiência', () => {
        const g = buildContractSlotGrid(Tier.AUDIENCIA, cfg());
        expect(g.days.map(d => d.dayOfWeek)).toEqual([1, 2, 3, 4, 5]);
        expect(g.days[0]!.slots.map(s => `${s.time}/${s.tier}`)).toEqual([
            '10:00/COMERCIAL', '13:00/COMERCIAL', '15:30/COMERCIAL', '18:00/AUDIENCIA', '20:30/AUDIENCIA',
        ]);
    });

    it('SABADO: só sábado, com os 5 horários da grade', () => {
        const g = buildContractSlotGrid(Tier.SABADO, cfg());
        expect(g.days).toHaveLength(1);
        expect(g.days[0]!.dayOfWeek).toBe(6);
        expect(g.days[0]!.slots.map(s => s.time)).toEqual(['10:00', '13:00', '15:30', '18:00', '20:30']);
        expect(g.days[0]!.slots.every(s => s.tier === Tier.SABADO)).toBe(true);
    });

    it('descarta o pacote que passaria do close_time', () => {
        const g = buildContractSlotGrid(Tier.AUDIENCIA, cfg({ close_time: '22:00' }));
        expect(g.days[0]!.slots.map(s => s.time)).toEqual(['10:00', '13:00', '15:30', '18:00']);
    });

    it('ordena os horários mesmo com a CSV fora de ordem e usa a duração configurada', () => {
        const g = buildContractSlotGrid(Tier.COMERCIAL, cfg({ time_slots: '15:30, 10:00,13:00', slot_duration_hours: '1.5' }));
        expect(g.slotDurationHours).toBe(1.5);
        expect(g.days[0]!.slots).toEqual([
            { time: '10:00', end: '11:30', tier: Tier.COMERCIAL },
            { time: '13:00', end: '14:30', tier: Tier.COMERCIAL },
            { time: '15:30', end: '17:00', tier: Tier.COMERCIAL },
        ]);
    });

    it('getContractSlotGrid usa a BusinessConfig atual', async () => {
        cfgOverrides = { comercial_slots: '10:00,13:00', audiencia_slots: '15:30,18:00,20:30' };
        const g = await getContractSlotGrid(Tier.COMERCIAL);
        expect(g.days[0]!.slots.map(s => s.time)).toEqual(['10:00', '13:00']);
    });
});

describe('checkSlotInGrid / validateContractSlot — mensagens', () => {
    const comercial = buildContractSlotGrid(Tier.COMERCIAL, cfg());
    const audiencia = buildContractSlotGrid(Tier.AUDIENCIA, cfg());
    const sabado = buildContractSlotGrid(Tier.SABADO, cfg());

    it('horário da grade é válido (null)', () => {
        expect(checkSlotInGrid(comercial, 1, '13:00')).toBeNull();
        expect(checkSlotInGrid(audiencia, 1, '10:00')).toBeNull(); // hierarquia (D8)
        expect(checkSlotInGrid(audiencia, 5, '20:30')).toBeNull();
        expect(checkSlotInGrid(sabado, 6, '20:30')).toBeNull();
    });

    it('14:00 numa segunda COMERCIAL → "Horário inválido … Horários válidos …"', () => {
        expect(checkSlotInGrid(comercial, 1, '14:00')).toBe(
            'Horário inválido: 14:00 não é um horário de gravação da faixa Comercial às segundas. Horários válidos: 10:00, 13:00, 15:30.',
        );
    });

    it('COMERCIAL não aceita horário de audiência', () => {
        expect(checkSlotInGrid(comercial, 2, '18:00')).toMatch(/^Horário inválido: 18:00 .* às terças\. Horários válidos: 10:00, 13:00, 15:30\.$/);
    });

    it('dia não permitido para a faixa → lista os dias válidos', () => {
        expect(checkSlotInGrid(comercial, 6, '10:00')).toBe(
            'Horário inválido: a faixa Comercial não tem gravação aos sábados. Dias válidos: segunda, terça, quarta, quinta e sexta.',
        );
        expect(checkSlotInGrid(sabado, 1, '10:00')).toBe(
            'Horário inválido: a faixa Sábado não tem gravação às segundas. Dias válidos: sábado.',
        );
        expect(checkSlotInGrid(audiencia, 0, '10:00')).toMatch(/^Horário inválido: a faixa Audiência não tem gravação aos domingos\./);
        expect(checkSlotInGrid(comercial, 7, '10:00')).toMatch(/aos domingos/); // 7 = domingo
    });

    it('dia inválido (NaN) não quebra', () => {
        expect(checkSlotInGrid(comercial, NaN, '10:00')).toMatch(/^Horário inválido/);
    });

    it('validateContractSlot com a config atual', async () => {
        expect(await validateContractSlot(Tier.COMERCIAL, 1, '13:00')).toBeNull();
        expect(await validateContractSlot(Tier.COMERCIAL, 6, '13:00')).toMatch(/^Horário inválido/);
        expect(await validateContractSlot(Tier.AUDIENCIA, 3, '10:00')).toBeNull();
    });
});

describe('datas (dia da semana sempre em UTC)', () => {
    it('weekdayOfDateStr', () => {
        expect(weekdayOfDateStr('2026-09-28')).toBe(1); // segunda
        expect(weekdayOfDateStr('2026-10-03')).toBe(6); // sábado
        expect(weekdayOfDateStr('2026-10-04')).toBe(0); // domingo
        expect(weekdayOfDateStr('28/09/2026')).toBeNaN();
    });

    it('checkDateSlotInGrid', () => {
        const comercial = buildContractSlotGrid(Tier.COMERCIAL, cfg());
        expect(checkDateSlotInGrid(comercial, '2026-09-29', '15:30')).toBeNull();
        expect(checkDateSlotInGrid(comercial, '2026-10-03', '10:00')).toMatch(/aos sábados/);
        expect(checkDateSlotInGrid(comercial, 'xx', '10:00')).toMatch(/^Horário inválido/);
    });
});

describe('checkCustomScheduleInGrid / checkResolvedConflictsInGrid', () => {
    const comercial = buildContractSlotGrid(Tier.COMERCIAL, cfg());

    it('schedule recorrente: válido, fora da grade e repetido', () => {
        expect(checkCustomScheduleInGrid(comercial, { frequency: 'WEEKLY', schedule: [{ day: 1, time: '10:00' }, { day: 3, time: '15:30' }] })).toBeNull();
        expect(checkCustomScheduleInGrid(comercial, { frequency: 'WEEKLY', schedule: [{ day: 1, time: '14:00' }] })).toMatch(/^Horário inválido: 14:00/);
        expect(checkCustomScheduleInGrid(comercial, { frequency: 'BIWEEKLY', schedule: [{ day: 6, time: '10:00' }] })).toMatch(/aos sábados/);
        expect(checkCustomScheduleInGrid(comercial, { frequency: 'WEEKLY', schedule: [{ day: 1, time: '10:00' }, { day: 1, time: '10:00' }] }))
            .toMatch(/mais de uma vez/);
    });

    it('Datas Livres: valida o dia de cada data e repetição', () => {
        const base = { frequency: 'CUSTOM' as const, schedule: [] };
        expect(checkCustomScheduleInGrid(comercial, { ...base, customDates: [{ date: '2026-09-28', time: '10:00' }, { date: '2026-09-28', time: '13:00' }] })).toBeNull();
        expect(checkCustomScheduleInGrid(comercial, { ...base, customDates: [{ date: '2026-10-03', time: '10:00' }] })).toMatch(/aos sábados.*\(data 03\/10\)$/);
        expect(checkCustomScheduleInGrid(comercial, { ...base, customDates: [{ date: '2026-09-28', time: '10:00' }, { date: '2026-09-28', time: '10:00' }] }))
            .toMatch(/28\/09 às 10:00 foi escolhido mais de uma vez/);
    });

    it('trocas aceitas no modal de conflitos (newDate/newTime)', () => {
        expect(checkResolvedConflictsInGrid(comercial, undefined)).toBeNull();
        expect(checkResolvedConflictsInGrid(comercial, [{ originalDate: '2026-09-28', newDate: '2026-09-29', newTime: '13:00' }])).toBeNull();
        expect(checkResolvedConflictsInGrid(comercial, [{ originalDate: '2026-09-28', newDate: '2026-09-28', newTime: '14:00' }]))
            .toMatch(/^Horário inválido: 14:00 .*\(troca da gravação de 28\/09 para 28\/09\)$/);
    });
});

describe('computeCustomVolume / planCustomOccurrences (mesma geração do POST /custom)', () => {
    it('volume por frequência', () => {
        const schedule = [{ day: 1, time: '10:00' }, { day: 3, time: '13:00' }];
        expect(computeCustomVolume({ frequency: 'WEEKLY', durationMonths: 3, schedule })).toEqual({ totalSessions: 24, sessionsPerWeek: 2, sessionsPerCycle: 8 });
        expect(computeCustomVolume({ frequency: 'BIWEEKLY', durationMonths: 3, schedule })).toEqual({ totalSessions: 12, sessionsPerWeek: 2, sessionsPerCycle: 4 });
        expect(computeCustomVolume({ frequency: 'MONTHLY', durationMonths: 2, schedule, weekPattern: [1, 3, 4] })).toEqual({ totalSessions: 12, sessionsPerWeek: 2, sessionsPerCycle: 6 });
        expect(computeCustomVolume({ frequency: 'CUSTOM', durationMonths: 1, schedule: [], customDates: [{ date: '2026-09-28', time: '10:00' }, { date: '2026-09-30', time: '10:00' }] }))
            .toEqual({ totalSessions: 2, sessionsPerWeek: 1, sessionsPerCycle: 2 });
    });

    it('semanal: alinha ao dia da semana e respeita o teto C8 (totalSessions)', () => {
        const occ = planCustomOccurrences({ frequency: 'WEEKLY', durationMonths: 1, schedule: [{ day: 1, time: '10:00' }], startDate: '2026-09-24' });
        expect(occ.map(o => o.date)).toEqual(['2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19']);
        expect(occ.every(o => o.time === '10:00' && o.day === 1)).toBe(true);
        expect(occ.map(o => o.weekIndex)).toEqual([0, 1, 2, 3]);
    });

    it('vários dias: distribui semana a semana (4 por ciclo em cada dia), sem sessão além de N×4 semanas', () => {
        const occ = planCustomOccurrences({
            frequency: 'WEEKLY', durationMonths: 3, startDate: '2026-10-01',
            schedule: [{ day: 1, time: '10:00' }, { day: 3, time: '13:00' }],
        });
        expect(occ).toHaveLength(24);
        // Antes: 13 segundas (a última na 13ª semana, fora dos 3 ciclos) e só 11 quartas.
        expect(occ.filter(o => o.day === 1)).toHaveLength(12); // 05/10 … 21/12
        expect(occ.filter(o => o.day === 3)).toHaveLength(12); // 07/10 … 23/12
        expect(occ.every(o => o.weekIndex < 12)).toBe(true);
        expect(occ.every(o => weekdayOfDateStr(o.date) === o.day)).toBe(true);
        // Ordem cronológica: início numa quinta (01/10) → seg 05/10, qua 07/10, seg 12/10…
        const dates = occ.map(o => o.date);
        expect(dates).toEqual([...dates].sort());
        expect(occ[0]).toMatchObject({ date: '2026-10-05', day: 1, weekIndex: 0 });
        expect(occ[1]).toMatchObject({ date: '2026-10-07', day: 3, weekIndex: 0 });
        expect(occ.filter(o => o.day === 1).at(-1)!.date).toBe('2026-12-21');
        expect(occ.filter(o => o.day === 3).at(-1)!.date).toBe('2026-12-23');
    });

    it('12 ciclos com 2 dias: 48 + 48, a última na semana 47', () => {
        const occ = planCustomOccurrences({
            frequency: 'WEEKLY', durationMonths: 12, startDate: '2026-10-01',
            schedule: [{ day: 3, time: '13:00' }, { day: 1, time: '10:00' }],
        });
        expect(occ).toHaveLength(96);
        expect(occ.filter(o => o.day === 1)).toHaveLength(48);
        expect(occ.filter(o => o.day === 3)).toHaveLength(48);
        expect(Math.max(...occ.map(o => o.weekIndex))).toBe(47);
    });

    it('mesmo dia com dois horários: ordena por horário dentro do dia', () => {
        const occ = planCustomOccurrences({
            frequency: 'WEEKLY', durationMonths: 1, startDate: '2026-10-05',
            schedule: [{ day: 1, time: '15:30' }, { day: 1, time: '10:00' }],
        });
        expect(occ).toHaveLength(8);
        expect(occ.slice(0, 2).map(o => `${o.date} ${o.time}`)).toEqual(['2026-10-05 10:00', '2026-10-05 15:30']);
    });

    it('quinzenal (padrão 1 e 3) e mensal (semana do mês)', () => {
        const bi = planCustomOccurrences({ frequency: 'BIWEEKLY', durationMonths: 2, startDate: '2026-10-05', schedule: [{ day: 1, time: '10:00' }] });
        expect(bi.map(o => o.date)).toEqual(['2026-10-05', '2026-10-19', '2026-11-02', '2026-11-16']);
        const mo = planCustomOccurrences({ frequency: 'MONTHLY', durationMonths: 2, startDate: '2026-10-01', schedule: [{ day: 2, time: '10:00' }], weekPattern: [2] });
        expect(mo.map(o => o.date)).toEqual(['2026-10-13', '2026-11-10']);
    });

    it('Datas Livres: exatamente as datas informadas', () => {
        const occ = planCustomOccurrences({
            frequency: 'CUSTOM', durationMonths: 1, startDate: '2026-09-24', schedule: [],
            customDates: [{ date: '2026-09-29', time: '13:00' }, { date: '2026-10-02', time: '10:00' }],
        });
        expect(occ).toEqual([
            { date: '2026-09-29', time: '13:00', day: 2, weekIndex: 0 },
            { date: '2026-10-02', time: '10:00', day: 5, weekIndex: 0 },
        ]);
    });
});

import { Tier } from '../generated/prisma/client.js';
import { prisma } from '../lib/prisma.js';
import { getConfig, getConfigString, getAllConfigs } from '../lib/businessConfig.js';

// ─── Tier Detection ─────────────────────────────────────

/**
 * Determines the pricing tier based on day of week and start time.
 * Now reads tier mapping from business config (dynamic).
 * @param dayOfWeek 0=Sunday, 1=Monday, ..., 6=Saturday (JS Date convention)
 * @param startTime "HH:MM" format
 */
export async function getSlotTier(dayOfWeek: number, startTime: string): Promise<Tier | null> {
    const operatingDays = (await getConfigString('operating_days')).split(',').map(Number);
    if (!operatingDays.includes(dayOfWeek)) return null;

    const allSlots = (await getConfigString('time_slots')).split(',').map(s => s.trim());
    if (!allSlots.includes(startTime)) return null;

    if (dayOfWeek === 6) return Tier.SABADO;

    const comercialSlots = (await getConfigString('comercial_slots')).split(',').map(s => s.trim());
    if (comercialSlots.includes(startTime)) return Tier.COMERCIAL;

    const audienciaSlots = (await getConfigString('audiencia_slots')).split(',').map(s => s.trim());
    if (audienciaSlots.includes(startTime)) return Tier.AUDIENCIA;

    return null;
}

/**
 * Batch version: pre-loads all config once, then resolves tiers for multiple slots.
 * Use this in loops to avoid N * 4 async config lookups.
 */
export async function getSlotTierBatch(dayOfWeek: number, slots: string[]): Promise<Map<string, Tier | null>> {
    const configs = await getAllConfigs();
    const operatingDays = (configs['operating_days'] || '').split(',').map(Number);
    const allSlots = (configs['time_slots'] || '').split(',').map(s => s.trim());
    const comercialSlots = (configs['comercial_slots'] || '').split(',').map(s => s.trim());
    const audienciaSlots = (configs['audiencia_slots'] || '').split(',').map(s => s.trim());

    const result = new Map<string, Tier | null>();

    for (const startTime of slots) {
        if (!operatingDays.includes(dayOfWeek) || !allSlots.includes(startTime)) {
            result.set(startTime, null);
            continue;
        }
        if (dayOfWeek === 6) { result.set(startTime, Tier.SABADO); continue; }
        if (comercialSlots.includes(startTime)) { result.set(startTime, Tier.COMERCIAL); continue; }
        if (audienciaSlots.includes(startTime)) { result.set(startTime, Tier.AUDIENCIA); continue; }
        result.set(startTime, null);
    }

    return result;
}

// ─── Pricing ────────────────────────────────────────────

const DEFAULT_PRICES: Record<string, number> = {
    COMERCIAL: 30000,
    AUDIENCIA: 40000,
    SABADO: 50000,
};

/** Base price for a 2-hour package (in cents) — hardcoded fallback */
export function getBasePrice(tier: Tier): number {
    return DEFAULT_PRICES[tier] ?? 30000;
}

/** Dynamic base price: reads from DB first, falls back to hardcoded */
export async function getBasePriceDynamic(tier: Tier): Promise<number> {
    try {
        const config = await prisma.pricingConfig.findUnique({
            where: { tier },
        });
        if (config) return config.price;
    } catch {
        // DB not available, fall back
    }
    return getBasePrice(tier);
}

/** Apply contract discount to a base price */
export function applyDiscount(basePrice: number, discountPct: number): number {
    return Math.round(basePrice * (1 - discountPct / 100));
}

/** Format cents to BRL string */
export function formatBRL(cents: number): string {
    return `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;
}

/**
 * Adds `months` calendar months to `date`, keeping the SAME day-of-month and
 * clamping to the last day of the target month when it would overflow
 * (e.g. 31/Jan + 1 → 28/Feb, never 03/Mar). Use this for monthly installment
 * due-dates so they land on the same day each month and never skip a month —
 * raw Date.setMonth() rolls days 29–31 forward into the following month.
 */
export function addMonths(date: Date, months: number): Date {
    const d = new Date(date);
    const day = d.getDate();
    d.setDate(1);                          // avoid mid-set overflow
    d.setMonth(d.getMonth() + months);
    const lastDayOfTarget = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, lastDayOfTarget));
    return d;
}

/**
 * A billing cycle is a fixed 4-week (28-day) window — NOT a calendar month.
 * The studio's sessions run weekly, so installment due dates advance by exactly
 * 28 days per cycle (no calendar-month drift of 28–31 days). Use this for EVERY
 * monthly-installment due date so all creation paths (self, admin, custom,
 * renewal) stay consistent.
 */
export const BILLING_CYCLE_DAYS = 28;
export function addBillingCycles(date: Date, cycles: number): Date {
    const d = new Date(date);
    d.setDate(d.getDate() + cycles * BILLING_CYCLE_DAYS);
    return d;
}

// ─── Tier Hierarchy ─────────────────────────────────────

const TIER_LEVEL: Record<Tier, number> = {
    [Tier.COMERCIAL]: 1,
    [Tier.AUDIENCIA]: 2,
    [Tier.SABADO]: 3,
};

/**
 * Check if a client with a given contract tier can book a slot of a given tier.
 * Downward compatibility: higher tiers can access lower tiers.
 */
export function canAccessTier(contractTier: Tier, slotTier: Tier): boolean {
    return TIER_LEVEL[contractTier] >= TIER_LEVEL[slotTier];
}

// ─── Time Slot Utilities ────────────────────────────────

/**
 * Generate the official start times for the block slots (dynamic from config).
 */
export async function generateTimeSlots(): Promise<string[]> {
    const csv = await getConfigString('time_slots');
    return csv.split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * Get the operating days as an array of JS day-of-week numbers.
 */
export async function getOperatingDays(): Promise<number[]> {
    const csv = await getConfigString('operating_days');
    return csv.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
}

/**
 * Check if a given JS dayOfWeek (0=Sun..6=Sat) is an operating day.
 */
export async function isOperatingDay(dayOfWeek: number): Promise<boolean> {
    const days = await getOperatingDays();
    return days.includes(dayOfWeek);
}

/**
 * Get the slot duration in hours (dynamic from config).
 */
export async function getSlotDuration(): Promise<number> {
    return getConfig('slot_duration_hours');
}

/**
 * Given a start time and package duration (in hours), return the list of
 * 30-minute slot start times covered by the package.
 */
export function getPackageSlots(startTime: string, packageHours: number = 2): string[] {
    const slots: string[] = [];
    const [h, m] = startTime.split(':').map(Number);
    let totalMinutes = h * 60 + m;

    const slotCount = (packageHours * 60) / 30;
    for (let i = 0; i < slotCount; i++) {
        const sh = Math.floor(totalMinutes / 60);
        const sm = totalMinutes % 60;
        slots.push(`${String(sh).padStart(2, '0')}:${String(sm).padStart(2, '0')}`);
        totalMinutes += 30;
    }
    return slots;
}

/**
 * Convert a studio wall-clock date+time into a UTC instant.
 * The studio operates in America/Sao_Paulo (UTC-3, no DST since 2019). Pinning
 * the offset makes all time-distance checks (min-advance, 24h-cancel, reschedule)
 * consistent regardless of the server's own timezone.
 */
export function studioDateTime(dateStr: string, timeStr: string): Date {
    return new Date(`${dateStr}T${timeStr}:00-03:00`);
}

/**
 * Calculate end time given start time and duration.
 */
export function calculateEndTime(startTime: string, durationHours: number = 2): string {
    const [h, m] = startTime.split(':').map(Number);
    const totalMinutes = h * 60 + m + durationHours * 60;
    const endH = Math.floor(totalMinutes / 60);
    const endM = totalMinutes % 60;
    return `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`;
}

/**
 * Check if a package fits within operating hours.
 */
export async function fitsInOperatingHours(
    startTime: string,
    durationHours?: number,
): Promise<boolean> {
    const dur = durationHours ?? await getSlotDuration();
    const closeTime = await getConfigString('close_time');
    const endTime = calculateEndTime(startTime, dur);
    const [endH, endM] = endTime.split(':').map(Number);
    const [closeH, closeM] = closeTime.split(':').map(Number);
    return endH * 60 + endM <= closeH * 60 + closeM;
}

// ─── Contract slot grid (D8) ────────────────────────────
// Grade ÚNICA de horários válidos para CONTRATOS (FIXO do admin, /self, personalizado e os
// checks). Derivada da BusinessConfig (time_slots, comercial_slots, audiencia_slots,
// operating_days, slot_duration_hours, close_time) — nunca de listas fixas:
//  - SABADO grava só aos sábados; COMERCIAL/AUDIENCIA só de segunda a sexta (∩ operating_days);
//  - hierarquia de faixas (canAccessTier): a faixa superior usa os horários da inferior
//    (AUDIÊNCIA = 10:00/13:00/15:30 + 18:00/20:30);
//  - o pacote precisa terminar até close_time.
// O dia da semana é SEMPRE calculado em UTC a partir de 'YYYY-MM-DD' (weekdayOfDateStr), no
// mesmo padrão do check-fixo e dos bookings @db.Date (meia-noite UTC).

export interface ContractSlotOption { time: string; end: string; tier: Tier; }
export interface ContractSlotDay { dayOfWeek: number; slots: ContractSlotOption[]; }
export interface ContractSlotGrid { tier: Tier; slotDurationHours: number; days: ContractSlotDay[]; }

/** Recorte da BusinessConfig usado pela grade (puro, para testes sem banco). */
export interface ScheduleGridConfig {
    operatingDays: number[];
    timeSlots: string[];
    comercialSlots: string[];
    audienciaSlots: string[];
    slotDurationHours: number;
    closeTime: string;
}

const csvList = (v: string | undefined): string[] => (v || '').split(',').map(s => s.trim()).filter(Boolean);
const hhmmToMinutes = (t: string): number => { const [h, m] = t.split(':').map(Number); return (h ?? 0) * 60 + (m ?? 0); };
const HHMM_RE = /^\d{2}:\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Lê o recorte da grade a partir do mapa de configs (getAllConfigs). */
export function readScheduleGridConfig(configs: Record<string, string>): ScheduleGridConfig {
    const dur = parseFloat(configs['slot_duration_hours'] ?? '');
    return {
        operatingDays: csvList(configs['operating_days']).map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 6),
        timeSlots: csvList(configs['time_slots']),
        comercialSlots: csvList(configs['comercial_slots']),
        audienciaSlots: csvList(configs['audiencia_slots']),
        slotDurationHours: Number.isFinite(dur) && dur > 0 ? dur : 2,
        closeTime: configs['close_time'] || '23:00',
    };
}

/** Faixa de um horário num dia — espelho PURO de getSlotTier/getSlotTierBatch (mesma regra). */
export function resolveSlotTier(cfg: ScheduleGridConfig, dayOfWeek: number, time: string): Tier | null {
    if (!cfg.operatingDays.includes(dayOfWeek) || !cfg.timeSlots.includes(time)) return null;
    if (dayOfWeek === 6) return Tier.SABADO;
    if (cfg.comercialSlots.includes(time)) return Tier.COMERCIAL;
    if (cfg.audienciaSlots.includes(time)) return Tier.AUDIENCIA;
    return null;
}

/** Dias (JS 0=dom..6=sáb) em que um contrato da faixa pode gravar: SABADO → [6]; demais → seg–sex; ∩ operating_days. */
export function contractAllowedDaysFrom(tier: Tier, operatingDays: number[]): number[] {
    const base = tier === Tier.SABADO ? [6] : [1, 2, 3, 4, 5];
    return base.filter(d => operatingDays.includes(d));
}

/** Versão com a config atual (cache de 60s da BusinessConfig). */
export async function contractAllowedDays(tier: Tier): Promise<number[]> {
    return contractAllowedDaysFrom(tier, await getOperatingDays());
}

/** Um contrato da faixa `contractTier` pode usar um horário da faixa `slotTier`? (hierarquia — D8) */
export function slotAllowedForContract(contractTier: Tier, slotTier: Tier | string | null | undefined): boolean {
    if (!slotTier || !Object.prototype.hasOwnProperty.call(TIER_LEVEL, slotTier)) return false;
    return canAccessTier(contractTier, slotTier as Tier);
}

/** Grade de contrato da faixa (pura): só dias permitidos que tenham ao menos um horário válido. */
export function buildContractSlotGrid(tier: Tier, cfg: ScheduleGridConfig): ContractSlotGrid {
    const closeMin = hhmmToMinutes(cfg.closeTime);
    const times = [...new Set(cfg.timeSlots)].sort((a, b) => hhmmToMinutes(a) - hhmmToMinutes(b));
    const days: ContractSlotDay[] = [];
    for (const dayOfWeek of contractAllowedDaysFrom(tier, cfg.operatingDays)) {
        const slots: ContractSlotOption[] = [];
        for (const time of times) {
            const slotTier = resolveSlotTier(cfg, dayOfWeek, time);
            if (!slotTier || !slotAllowedForContract(tier, slotTier)) continue;
            const end = calculateEndTime(time, cfg.slotDurationHours);
            if (hhmmToMinutes(end) > closeMin) continue;
            slots.push({ time, end, tier: slotTier });
        }
        if (slots.length > 0) days.push({ dayOfWeek, slots });
    }
    return { tier, slotDurationHours: cfg.slotDurationHours, days };
}

/** Grade de contrato da faixa com a config atual. */
export async function getContractSlotGrid(tier: Tier): Promise<ContractSlotGrid> {
    return buildContractSlotGrid(tier, readScheduleGridConfig(await getAllConfigs()));
}

const TIER_LABEL_PT: Record<string, string> = { COMERCIAL: 'Comercial', AUDIENCIA: 'Audiência', SABADO: 'Sábado' };
const WEEKDAY_NAME_PT = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const WEEKDAY_PLURAL_PT = ['aos domingos', 'às segundas', 'às terças', 'às quartas', 'às quintas', 'às sextas', 'aos sábados'];

function joinPt(items: string[]): string {
    if (items.length <= 1) return items.join('');
    return `${items.slice(0, -1).join(', ')} e ${items[items.length - 1]}`;
}

/**
 * Confere dia/horário contra uma grade já carregada. null = válido; senão a mensagem
 * 'Horário inválido: … Horários válidos: …' (ou 'Dias válidos: …' quando o dia não é permitido).
 * `dayOfWeek` na convenção JS (0=dom..6=sáb); 7 é tratado como domingo.
 */
export function checkSlotInGrid(grid: ContractSlotGrid, dayOfWeek: number, time: string): string | null {
    const label = TIER_LABEL_PT[grid.tier] ?? grid.tier;
    if (!Number.isInteger(dayOfWeek)) return 'Horário inválido: data ou dia da semana inválido.';
    const dow = ((dayOfWeek % 7) + 7) % 7;
    const day = grid.days.find(d => d.dayOfWeek === dow);
    if (!day) {
        const validDays = grid.days.map(d => WEEKDAY_NAME_PT[d.dayOfWeek]!);
        return `Horário inválido: a faixa ${label} não tem gravação ${WEEKDAY_PLURAL_PT[dow]}. Dias válidos: ${validDays.length ? joinPt(validDays) : 'nenhum'}.`;
    }
    if (HHMM_RE.test(time) && day.slots.some(s => s.time === time)) return null;
    return `Horário inválido: ${time} não é um horário de gravação da faixa ${label} ${WEEKDAY_PLURAL_PT[dow]}. Horários válidos: ${day.slots.map(s => s.time).join(', ')}.`;
}

/** Valida um dia/horário de contrato com a config atual (null = válido). */
export async function validateContractSlot(tier: Tier, dayOfWeek: number, time: string): Promise<string | null> {
    return checkSlotInGrid(await getContractSlotGrid(tier), dayOfWeek, time);
}

/** Dia da semana (0=dom..6=sáb) de 'YYYY-MM-DD', sempre em UTC. NaN se a string não for uma data. */
export function weekdayOfDateStr(ds: string): number {
    if (!DATE_RE.test(ds)) return NaN;
    return new Date(ds + 'T00:00:00Z').getUTCDay();
}

/** Confere uma DATA ('YYYY-MM-DD') + horário contra a grade (null = válido). */
export function checkDateSlotInGrid(grid: ContractSlotGrid, dateStr: string, time: string): string | null {
    return checkSlotInGrid(grid, weekdayOfDateStr(dateStr), time);
}

/** 'YYYY-MM-DD' → 'DD/MM' (texto de erro). */
const ddmmOf = (ds: string): string => (DATE_RE.test(ds) ? `${ds.slice(8, 10)}/${ds.slice(5, 7)}` : ds);

/**
 * Valida os itens de um personalizado contra a grade: o `schedule` (frequências recorrentes) ou as
 * `customDates` (frequency CUSTOM — "Datas Livres"), recusando item repetido. null = tudo válido.
 */
export function checkCustomScheduleInGrid(
    grid: ContractSlotGrid,
    input: { frequency: CustomFrequency; schedule: { day: number; time: string }[]; customDates?: { date: string; time: string }[] },
): string | null {
    const seen = new Set<string>();
    if (input.frequency === 'CUSTOM') {
        for (const cd of input.customDates ?? []) {
            const err = checkDateSlotInGrid(grid, cd.date, cd.time);
            if (err) return `${err} (data ${ddmmOf(cd.date)})`;
            const key = `${cd.date} ${cd.time}`;
            if (seen.has(key)) return `Horário inválido: ${ddmmOf(cd.date)} às ${cd.time} foi escolhido mais de uma vez.`;
            seen.add(key);
        }
        return null;
    }
    for (const s of input.schedule) {
        const err = checkSlotInGrid(grid, s.day, s.time);
        if (err) return err;
        const dow = ((s.day % 7) + 7) % 7;
        const key = `${dow} ${s.time}`;
        if (seen.has(key)) return `Horário inválido: ${s.time} ${WEEKDAY_PLURAL_PT[dow]} foi escolhido mais de uma vez.`;
        seen.add(key);
    }
    return null;
}

/** Valida o novo dia/horário de cada troca aceita no modal de conflitos (resolvedConflicts). */
export function checkResolvedConflictsInGrid(
    grid: ContractSlotGrid,
    resolved: { originalDate: string; newDate: string; newTime: string }[] | undefined,
): string | null {
    for (const rc of resolved ?? []) {
        const err = checkDateSlotInGrid(grid, rc.newDate, rc.newTime);
        if (err) return `${err} (troca da gravação de ${ddmmOf(rc.originalDate)} para ${ddmmOf(rc.newDate)})`;
    }
    return null;
}

// ─── Custom contract occurrences (shared by POST /custom and /custom/check) ──

export type CustomFrequency = 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY' | 'CUSTOM';

export interface CustomScheduleInput {
    frequency: CustomFrequency;
    durationMonths: number;
    schedule: { day: number; time: string }[];
    weekPattern?: number[];
    customDates?: { date: string; time: string }[];
}

/** Volume do personalizado (mesma conta que o POST /custom sempre fez; o desconto sai daqui). */
export function computeCustomVolume(input: CustomScheduleInput): { totalSessions: number; sessionsPerWeek: number; sessionsPerCycle: number } {
    const { frequency, durationMonths, schedule, weekPattern, customDates } = input;
    if (frequency === 'CUSTOM' && customDates && customDates.length > 0) {
        const totalSessions = customDates.length;
        return {
            totalSessions,
            sessionsPerWeek: Math.round(totalSessions / (durationMonths * 4)),
            sessionsPerCycle: Math.round(totalSessions / durationMonths),
        };
    }
    const sessionsPerWeek = schedule.length;
    let sessionsPerCycle: number;
    if (frequency === 'BIWEEKLY') sessionsPerCycle = sessionsPerWeek * 2; // 2 de 4 semanas
    else if (frequency === 'MONTHLY') sessionsPerCycle = sessionsPerWeek * (weekPattern || [1]).length;
    else sessionsPerCycle = sessionsPerWeek * 4;
    return { totalSessions: sessionsPerCycle * durationMonths, sessionsPerWeek, sessionsPerCycle };
}

export interface PlannedOccurrence {
    /** 'YYYY-MM-DD' (calendário do estúdio). */
    date: string;
    time: string;
    /** Dia da semana (0..6) do item de schedule que gerou a ocorrência (ou da data livre). */
    day: number;
    /** Semanas desde o início (0-based) — ciclo = floor(weekIndex / 4). 0 nas datas livres. */
    weekIndex: number;
}

/**
 * Ocorrências de um personalizado, na MESMA ordem e com o MESMO teto (C8: totalSessions) que o
 * POST /custom usa para gerar as sessões — o /custom/check usa esta função para não divergir.
 * WEEKLY/BIWEEKLY/MONTHLY a partir do schedule (fim = início + durationMonths meses-calendário);
 * CUSTOM ("Datas Livres") = as datas explícitas.
 *
 * Geração SEMANA A SEMANA (round-robin): em cada janela de 7 dias a partir do início, todos os itens
 * do schedule em ordem cronológica (data, depois horário), até o teto. Antes o 1º item esgotava o
 * período inteiro antes do 2º — com 2 dias/semana o 1º dia ganhava sessões depois das N×4 semanas e
 * o 2º perdia as últimas. Agora, no semanal, cada item recebe exatamente 4·N sessões (semanas 0..4N-1).
 */
export function planCustomOccurrences(input: CustomScheduleInput & { startDate: string }): PlannedOccurrence[] {
    const { frequency, schedule, weekPattern, customDates, startDate, durationMonths } = input;
    if (frequency === 'CUSTOM' && customDates && customDates.length > 0) {
        return customDates.map(cd => ({ date: cd.date, time: cd.time, day: weekdayOfDateStr(cd.date), weekIndex: 0 }));
    }
    const { totalSessions } = computeCustomVolume(input);
    const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
    const start = new Date(startDate + 'T00:00:00Z');
    const end = new Date(start);
    end.setUTCMonth(end.getUTCMonth() + durationMonths);
    // 1ª ocorrência de cada item (dentro dos 7 primeiros dias), em ordem cronológica.
    const slots = schedule.map(s => {
        const dow = ((s.day % 7) + 7) % 7;
        const first = new Date(start);
        while (first.getUTCDay() !== dow) first.setUTCDate(first.getUTCDate() + 1);
        return { ...s, first };
    }).sort((a, b) => a.first.getTime() - b.first.getTime() || hhmmToMinutes(a.time) - hhmmToMinutes(b.time));
    const out: PlannedOccurrence[] = [];
    let generated = 0;
    if (totalSessions <= 0 || slots.length === 0) return out;
    outer: for (let w = 0; ; w++) {
        let inRange = false;
        for (const slot of slots) {
            const current = new Date(slot.first.getTime() + w * WEEK_MS);
            if (current >= end) continue;
            inRange = true;
            const weekIndex = Math.floor((current.getTime() - start.getTime()) / WEEK_MS);
            let shouldGenerate = true;
            if (frequency === 'BIWEEKLY') {
                shouldGenerate = (weekPattern || [1, 3]).includes((weekIndex % 4) + 1);
            } else if (frequency === 'MONTHLY') {
                shouldGenerate = (weekPattern || [1]).includes(Math.ceil(current.getUTCDate() / 7));
            }
            if (!shouldGenerate) continue;
            out.push({ date: current.toISOString().slice(0, 10), time: slot.time, day: slot.day, weekIndex });
            if (++generated >= totalSessions) break outer;
        }
        if (!inRange) break;
    }
    return out;
}

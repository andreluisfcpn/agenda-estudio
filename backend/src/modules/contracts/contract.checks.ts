import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middleware/auth.js';
import { BookingStatus } from '../../generated/prisma/client.js';
import { generateTimeSlots } from '../../utils/pricing.js';
import { getConfig, getConfigString } from '../../lib/businessConfig.js';
import { getPublicDayAvailability } from '../bookings/availability.service.js';
import { checkFixoSchema, customCheckSchema } from './validators.js';

export function registerCheckRoutes(router: Router) {

// ─── POST /api/contracts/check-fixo (Dry-Run Validation) ──

router.post('/check-fixo', authenticate, async (req: Request, res: Response) => {
    try {
        const data = checkFixoSchema.parse(req.body);

        // Datas em UTC (determinístico; casa com bookings @db.Date = meia-noite UTC).
        const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
        const addDays = (ds: string, n: number) => {
            const d = new Date(ds + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
            return d.toISOString().split('T')[0];
        };
        const weekdayOf = (ds: string) => new Date(ds + 'T00:00:00Z').getUTCDay();

        // Alinha a 1ª ocorrência ao dia-da-semana escolhido.
        let startStr = data.startDate;
        while (weekdayOf(startStr) !== (data.fixedDayOfWeek % 7)) startStr = addDays(startStr, 1);

        const sessionsPerMonth = await getConfig('sessions_per_month');
        const totalWeeks = data.durationMonths * sessionsPerMonth;

        const expected: string[] = [];
        for (let i = 0, ds = startStr; i < totalWeeks; i++, ds = addDays(ds, 7)) expected.push(ds);

        // Disponibilidade por dia (memoizada) reusando o serviço canônico (respeita dia de
        // operação, tier por horário e ocupação — bookings não-cancelados + blocked slots).
        const availCache = new Map<string, Awaited<ReturnType<typeof getPublicDayAvailability>>>();
        const dayAvail = async (ds: string) => {
            let av = availCache.get(ds);
            if (!av) { av = await getPublicDayAvailability(ds); availCache.set(ds, av); }
            return av;
        };
        // Horários livres do TIER do contrato num dia (ordenados por proximidade ao horário fixo).
        const freeTierSlots = async (ds: string): Promise<string[]> => {
            const av = await dayAvail(ds);
            if (av.closed) return [];
            return av.slots.filter(s => s.available && s.tier === data.tier).map(s => s.time)
                .sort((a, b) => Math.abs(toMin(a) - toMin(data.fixedTime)) - Math.abs(toMin(b) - toMin(data.fixedTime)));
        };
        // Dia livre mais próximo ANTES (-1) ou DEPOIS (+1) de uma data, mesmo tier (até ±7 dias).
        const nearestFreeDay = async (aroundStr: string, dir: -1 | 1): Promise<{ date: string; time: string } | null> => {
            for (let off = 1; off <= 7; off++) {
                const ds = addDays(aroundStr, dir * off);
                // Nunca sugerir data ANTERIOR ao início do contrato (nem no passado — startDate >= hoje).
                if (dir === -1 && ds < data.startDate) break;
                const free = await freeTierSlots(ds);
                if (free.length) return { date: ds, time: free.includes(data.fixedTime) ? data.fixedTime : free[0] };
            }
            return null;
        };

        type Alt = { date: string; time: string; kind: 'SAME_DAY' | 'OTHER_DAY' };
        const conflicts: { date: string; originalTime: string; dayFull: boolean; alternatives: Alt[]; suggestedReplacement?: { date: string; time: string } }[] = [];
        let occurrencesWithFreeDay = 0;

        for (const ds of expected) {
            const free = await freeTierSlots(ds);
            if (free.length > 0) occurrencesWithFreeDay++;
            if (free.includes(data.fixedTime)) continue; // horário fixo livre → sem conflito

            if (free.length > 0) {
                // Só o horário fixo está ocupado → troca de HORÁRIO no mesmo dia.
                const alternatives: Alt[] = free.map(t => ({ date: ds, time: t, kind: 'SAME_DAY' }));
                conflicts.push({ date: ds, originalTime: data.fixedTime, dayFull: false, alternatives, suggestedReplacement: alternatives[0] });
            } else {
                // Dia inteiro cheio → oferece OUTRO DIA (antes/depois).
                const [before, after] = await Promise.all([nearestFreeDay(ds, -1), nearestFreeDay(ds, 1)]);
                const alternatives: Alt[] = [
                    ...(before ? [{ ...before, kind: 'OTHER_DAY' as const }] : []),
                    ...(after ? [{ ...after, kind: 'OTHER_DAY' as const }] : []),
                ];
                conflicts.push({ date: ds, originalTime: data.fixedTime, dayFull: true, alternatives, ...(alternatives[0] && { suggestedReplacement: alternatives[0] }) });
            }
        }

        // ── Alternativa de DIA-DA-SEMANA inteiro (ex.: trocar todas as segundas por terças) ──
        // Quando o dia escolhido dá conflito, oferece os OUTROS dias-da-semana (válidos p/ o tier)
        // que tenham o MESMO horário livre ao longo do período — o cliente troca o plano de dia.
        let alternativeWeekdays: { dayOfWeek: number; conflictCount: number; conflictFree: boolean }[] | undefined;
        if (conflicts.length > 0 || (expected.length > 0 && occurrencesWithFreeDay === 0)) {
            const chosenConflicts = conflicts.length || totalWeeks;
            const alts: { dayOfWeek: number; conflictCount: number; conflictFree: boolean }[] = [];
            for (let dow = 1; dow <= 6; dow++) {
                if (dow === (data.fixedDayOfWeek % 7)) continue;
                // Alinha ao dia-da-semana candidato.
                let s = data.startDate;
                while (weekdayOf(s) !== (dow % 7)) s = addDays(s, 1);
                // O horário fixo precisa EXISTIR como slot do tier nesse dia-da-semana (senão não serve).
                const probe = await dayAvail(s);
                if (probe.closed || !probe.slots.some(sl => sl.tier === data.tier && sl.time === data.fixedTime)) continue;
                let cc = 0;
                for (let i = 0, ds = s; i < totalWeeks; i++, ds = addDays(ds, 7)) {
                    if (!(await freeTierSlots(ds)).includes(data.fixedTime)) cc++;
                }
                if (cc < chosenConflicts) alts.push({ dayOfWeek: dow, conflictCount: cc, conflictFree: cc === 0 });
            }
            alts.sort((a, b) => a.conflictCount - b.conflictCount);
            if (alts.length > 0) alternativeWeekdays = alts;
        }

        // TODAS as ocorrências com o dia cheio → o dia-da-semana em si não tem vaga.
        if (expected.length > 0 && occurrencesWithFreeDay === 0) {
            // Previsão: 1ª data futura NESSE dia-da-semana com horário do tier livre (até 26 semanas).
            let forecast: string | null = null;
            for (let i = 0, ds = startStr; i < 26; i++, ds = addDays(ds, 7)) {
                if ((await freeTierSlots(ds)).length) { forecast = ds; break; }
            }
            res.json({ available: false, weekdayUnavailable: true, forecast, conflicts: [], ...(alternativeWeekdays && { alternativeWeekdays }) });
            return;
        }

        if (conflicts.length > 0) {
            res.json({ available: false, conflicts, ...(alternativeWeekdays && { alternativeWeekdays }) });
            return;
        }

        res.json({ available: true, conflicts: [] });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Parâmetros inválidos', details: err.errors });
            return;
        }
        console.error('[check-fixo]', err);
        res.status(500).json({ error: 'Erro interno ao validar agenda' });
    }
});

// ─── POST /api/contracts/custom/check (Dry-Run multi-day) ──

router.post('/custom/check', authenticate, async (req: Request, res: Response) => {
    try {
        const data = customCheckSchema.parse(req.body);
        const POSSIBLE_SLOTS = await generateTimeSlots();
        const comercialSlotsCSV2 = await getConfigString('comercial_slots');
        const comercialSlotsList2 = comercialSlotsCSV2.split(',').map(s => s.trim());
        const startDate = new Date(data.startDate + 'T00:00:00');
        const endDate = new Date(startDate);
        endDate.setMonth(endDate.getMonth() + data.durationMonths);

        const expectedDates: { date: Date; time: string; day: number }[] = [];

        for (const slot of data.schedule) {
            const current = new Date(startDate);
            // Align to first occurrence of this day
            while (current.getUTCDay() !== (slot.day % 7)) {
                current.setDate(current.getDate() + 1);
            }
            // Generate weekly occurrences
            while (current < endDate) {
                expectedDates.push({ date: new Date(current), time: slot.time, day: slot.day });
                current.setDate(current.getDate() + 7);
            }
        }

        const conflicts: { date: string; originalTime: string; day: number; suggestedReplacement?: { date: string; time: string } }[] = [];

        for (const expected of expectedDates) {
            const dateStr = expected.date.toISOString().split('T')[0];
            const dayOfWeek = expected.date.getUTCDay();

            const existingBooking = await prisma.booking.findFirst({
                where: {
                    date: expected.date,
                    status: { not: BookingStatus.CANCELLED },
                    startTime: { lte: expected.time },
                    endTime: { gt: expected.time },
                },
            });

            const existingBlock = await prisma.blockedSlot.findFirst({
                where: {
                    date: expected.date,
                    startTime: { lte: expected.time },
                    endTime: { gt: expected.time },
                },
            });

            if (existingBooking || existingBlock) {
                let suggestion: { date: string; time: string } | undefined;

                for (const altSlot of POSSIBLE_SLOTS) {
                    if (altSlot === expected.time) continue;
                    // Tier constraints
                    if (dayOfWeek === 6 && data.tier !== 'SABADO') continue;
                    if (dayOfWeek >= 1 && dayOfWeek <= 5 && data.tier === 'COMERCIAL' && !comercialSlotsList2.includes(altSlot)) continue;

                    const overlapBooking = await prisma.booking.findFirst({
                        where: { date: expected.date, status: { not: BookingStatus.CANCELLED }, startTime: { lte: altSlot }, endTime: { gt: altSlot } },
                    });
                    const overlapBlock = await prisma.blockedSlot.findFirst({
                        where: { date: expected.date, startTime: { lte: altSlot }, endTime: { gt: altSlot } },
                    });

                    if (!overlapBooking && !overlapBlock) {
                        suggestion = { date: dateStr, time: altSlot };
                        break;
                    }
                }

                conflicts.push({
                    date: dateStr,
                    originalTime: expected.time,
                    day: expected.day,
                    ...(suggestion && { suggestedReplacement: suggestion }),
                });
            }
        }

        // Limit to first 20 conflicts to avoid huge payloads
        const limitedConflicts = conflicts.slice(0, 20);

        res.json({
            available: conflicts.length === 0,
            conflicts: limitedConflicts,
            totalConflicts: conflicts.length,
            totalSessions: expectedDates.length,
        });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Parâmetros inválidos', details: err.errors });
            return;
        }
        console.error('Erro ao validar agenda custom:', err);
        res.status(500).json({ error: 'Erro interno ao validar agenda' });
    }
});

} // end registerCheckRoutes

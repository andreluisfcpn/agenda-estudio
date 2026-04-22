import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middleware/auth.js';
import { BookingStatus } from '../../generated/prisma/client.js';
import { generateTimeSlots } from '../../utils/pricing.js';
import { getConfig, getConfigString } from '../../lib/businessConfig.js';
import { checkFixoSchema, customCheckSchema } from './validators.js';

export function registerCheckRoutes(router: Router) {

// ─── POST /api/contracts/check-fixo (Dry-Run Validation) ──

router.post('/check-fixo', authenticate, async (req: Request, res: Response) => {
    try {
        const data = checkFixoSchema.parse(req.body);

        let start = new Date(data.startDate + 'T00:00:00');
        // Align to the first correct dayOfWeek
        while (start.getUTCDay() !== (data.fixedDayOfWeek % 7)) {
            start.setDate(start.getDate() + 1);
        }

        const sessionsPerMonth = await getConfig('sessions_per_month');
        const totalWeeks = data.durationMonths * sessionsPerMonth;
        const expectedDates: { date: Date, time: string }[] = [];

        let current = new Date(start);
        for (let i = 0; i < totalWeeks; i++) {
            expectedDates.push({ date: new Date(current), time: data.fixedTime });
            current.setDate(current.getDate() + 7);
        }

        const conflicts: { date: string, originalTime: string, suggestedReplacement?: { date: string, time: string } }[] = [];
        const POSSIBLE_SLOTS = await generateTimeSlots();
        const comercialSlotsCSV = await getConfigString('comercial_slots');
        const comercialSlotsList = comercialSlotsCSV.split(',').map(s => s.trim());

        // Check DB for overlapping bookings or blocked slots
        for (const expected of expectedDates) {
            const dateStr = expected.date.toISOString().split('T')[0];
            const dayOfWeek = expected.date.getUTCDay();

            const existingBooking = await prisma.booking.findFirst({
                where: {
                    date: expected.date,
                    status: { not: BookingStatus.CANCELLED },
                    startTime: { lte: data.fixedTime },
                    endTime: { gt: data.fixedTime }
                }
            });

            const existingBlock = await prisma.blockedSlot.findFirst({
                where: {
                    date: expected.date,
                    startTime: { lte: data.fixedTime },
                    endTime: { gt: data.fixedTime }
                }
            });

            if (existingBooking || existingBlock) {
                let suggestion: { date: string, time: string } | undefined = undefined;

                for (const slot of POSSIBLE_SLOTS) {
                    if (slot === data.fixedTime) continue;

                    // Tier constraints
                    if (dayOfWeek === 6 && data.tier !== 'SABADO') continue;
                    if (dayOfWeek >= 1 && dayOfWeek <= 5 && data.tier === 'COMERCIAL' && !comercialSlotsList.includes(slot)) continue;
                    if (dayOfWeek >= 1 && dayOfWeek <= 5 && data.tier === 'SABADO') continue;

                    const overlapBooking = await prisma.booking.findFirst({
                        where: {
                            date: expected.date,
                            status: { not: BookingStatus.CANCELLED },
                            startTime: { lte: slot },
                            endTime: { gt: slot }
                        }
                    });
                    const overlapBlock = await prisma.blockedSlot.findFirst({
                        where: {
                            date: expected.date,
                            startTime: { lte: slot },
                            endTime: { gt: slot }
                        }
                    });

                    if (!overlapBooking && !overlapBlock) {
                        suggestion = { date: dateStr, time: slot };
                        break;
                    }
                }

                conflicts.push({
                    date: dateStr,
                    originalTime: data.fixedTime,
                    ...(suggestion && { suggestedReplacement: suggestion })
                });
            }
        }

        if (conflicts.length > 0) {
            res.json({ available: false, conflicts });
            return;
        }

        res.json({ available: true, conflicts: [] });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Parâmetros inválidos', details: err.errors });
            return;
        }
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

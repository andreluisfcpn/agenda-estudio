import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { authenticate, authorize } from '../../middleware/auth';
import { ContractType, Tier, ContractStatus, BookingStatus, PaymentMethod } from '@prisma/client';
import { getBasePrice, getBasePriceDynamic, applyDiscount, calculateEndTime, generateTimeSlots } from '../../utils/pricing';
import { getConfig, getConfigString } from '../../lib/businessConfig';
import { createPayment as gatewayCreatePayment, updatePaymentWithGatewayResult } from '../../lib/paymentGateway';

const router = Router();

// ─── Validation Schemas ─────────────────────────────────

const createContractSchema = z.object({
    userId: z.string().uuid('ID de usuário inválido'),
    name: z.string().min(1, 'Nome do projeto é obrigatório'),
    type: z.nativeEnum(ContractType),
    tier: z.nativeEnum(Tier),
    durationMonths: z.number().refine(v => v === 3 || v === 6, 'Duração deve ser 3 ou 6 meses'),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato de data inválido'),
    // Fixo-specific
    fixedDayOfWeek: z.number().min(1).max(6).optional(), // 1=Mon, 6=Sat
    fixedTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    contractUrl: z.string().url().optional().or(z.literal('')),
    addOns: z.array(z.string()).optional(),
    resolvedConflicts: z.array(z.object({
        originalDate: z.string(),
        originalTime: z.string(),
        newDate: z.string(),
        newTime: z.string(),
    })).optional(),
});

const checkFixoSchema = z.object({
    tier: z.nativeEnum(Tier),
    durationMonths: z.number().refine(v => v === 3 || v === 6, 'Duração deve ser 3 ou 6 meses'),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato de data inválido'),
    fixedDayOfWeek: z.number().min(1).max(6),
    fixedTime: z.string().regex(/^\d{2}:\d{2}$/, 'Formato de hora inválido (HH:MM)'),
});

// ─── POST /api/contracts (ADMIN) ────────────────────────

router.post('/', authenticate, authorize('ADMIN'), async (req: Request, res: Response) => {
    try {
        const data = createContractSchema.parse(req.body);

        // Validate Fixo requires day and time
        if (data.type === 'FIXO' && (!data.fixedDayOfWeek || !data.fixedTime)) {
            res.status(400).json({ error: 'Plano Fixo requer dia da semana e horário.' });
            return;
        }

        // Calculate discount (dynamic from BusinessConfig)
        const discount3 = await getConfig('discount_3months');
        const discount6 = await getConfig('discount_6months');
        const discountPct = data.durationMonths === 3 ? discount3 : discount6;

        // Calculate dates
        const startDate = new Date(data.startDate + 'T00:00:00');
        const endDate = new Date(startDate);
        endDate.setMonth(endDate.getMonth() + data.durationMonths);

        // Episode-based credits (dynamic from BusinessConfig)
        const ep3 = await getConfig('episodes_3months');
        const ep6 = await getConfig('episodes_6months');
        const totalEpisodes = data.durationMonths === 3 ? ep3 : ep6;

        // Create contract
        const contract = await prisma.contract.create({
            data: {
                userId: data.userId,
                name: data.name,
                type: data.type,
                tier: data.tier,
                durationMonths: data.durationMonths,
                discountPct,
                startDate,
                endDate,
                status: ContractStatus.ACTIVE,
                contractUrl: data.contractUrl || null,
                fixedDayOfWeek: data.type === 'FIXO' ? data.fixedDayOfWeek : null,
                fixedTime: data.type === 'FIXO' ? data.fixedTime : null,
                flexCreditsTotal: data.type === 'FLEX' ? totalEpisodes : null,
                flexCreditsRemaining: data.type === 'FLEX' ? totalEpisodes : null,
                flexCycleStart: data.type === 'FLEX' ? startDate : null,
                flexWeeksCompensated: data.type === 'FLEX' ? 0 : null,
                addOns: data.addOns || [],
            },
        });

        // For FIXO contracts: auto-generate bookings for every occurrence
        if (data.type === 'FIXO' && data.fixedDayOfWeek && data.fixedTime) {
            const bookings = [];
            const current = new Date(startDate);

            // Find the first occurrence of the fixed day
            while (current.getUTCDay() !== data.fixedDayOfWeek) {
                current.setDate(current.getDate() + 1);
            }

            // Generate weekly bookings until end date
            // Contract is based on 4-week periods, not calendar months
            const sessionsPerMonth = await getConfig('sessions_per_month');
            const totalWeeks = data.durationMonths * sessionsPerMonth;
            const endTime = calculateEndTime(data.fixedTime);
            const basePrice = await getBasePriceDynamic(data.tier);
            const discountedPrice = applyDiscount(basePrice, discountPct);

            for (let week = 0; week < totalWeeks; week++) {
                const bookingDate = new Date(current);
                bookingDate.setDate(current.getDate() + week * 7);

                if (bookingDate > endDate) break;

                const bookingDateStr = bookingDate.toISOString().split('T')[0];
                const fixedTime = data.fixedTime!;
                let finalDate = bookingDate;
                let finalTime = fixedTime;

                // Check override resolutions from validation checks
                const resolution = data.resolvedConflicts?.find(c =>
                    c.originalDate === bookingDateStr && c.originalTime === fixedTime
                );

                if (resolution) {
                    finalDate = new Date(resolution.newDate + 'T00:00:00');
                    finalTime = resolution.newTime;
                }

                bookings.push({
                    userId: data.userId,
                    contractId: contract.id,
                    date: finalDate,
                    startTime: finalTime,
                    endTime: calculateEndTime(finalTime),
                    status: BookingStatus.CONFIRMED,
                    tierApplied: data.tier,
                    price: discountedPrice,
                    addOns: data.addOns ? data.addOns.filter(a => a !== 'GESTAO_SOCIAL') : [],
                });
            }

            if (bookings.length > 0) {
                await prisma.booking.createMany({ data: bookings });
            }
        }

        // Generate payment installments
        const basePrice = await getBasePriceDynamic(data.tier);
        const discountedPrice = applyDiscount(basePrice, discountPct);
        // Each month = sessions_per_month sessions → Payment per month = sessions * discountedPrice
        const sessionsPerMonthAdmin = await getConfig('sessions_per_month');
        const monthlyAmount = sessionsPerMonthAdmin * discountedPrice;
        const payments = [];

        for (let i = 0; i < data.durationMonths; i++) {
            const dueDate = new Date(startDate);
            dueDate.setMonth(dueDate.getMonth() + i);

            payments.push({
                userId: data.userId,
                contractId: contract.id,
                provider: 'CORA' as const,
                amount: monthlyAmount,
                status: 'PENDING' as const,
                dueDate,
                paymentUrl: `https://cora.br/pay/mock-${contract.id.slice(0, 8)}-${i}`,
                pixString: '00020126580014br.gov.bcb.pix0136123e4567-e89b-12d3-a456-426614174000520400005303986540510.005802BR5913Buzios Studio6008BuziosRJ62070503***63041A2B',
                boletoUrl: `https://cora.br/boleto/mock-${contract.id.slice(0, 8)}-${i}.pdf`,
            });
        }

        if (payments.length > 0) {
            await prisma.payment.createMany({ data: payments });
        }

        const createdPayments = await prisma.payment.findMany({
            where: { contractId: contract.id },
            orderBy: { dueDate: 'asc' },
        });

        res.status(201).json({
            contract: {
                id: contract.id,
                name: contract.name,
                type: contract.type,
                tier: contract.tier,
                durationMonths: contract.durationMonths,
                discountPct: contract.discountPct,
                startDate: data.startDate,
                endDate: endDate.toISOString().split('T')[0],
                status: contract.status,
            },
            payments: createdPayments.map(p => ({
                id: p.id,
                amount: p.amount,
                dueDate: p.dueDate?.toISOString().split('T')[0],
                status: p.status,
            })),
            message: `Contrato ${data.type} criado com sucesso! ${createdPayments.length} parcelas geradas.`,
        });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        console.error('Erro ao criar contrato (Admin):', err);
        const errMsg = err instanceof Error ? err.message : 'Erro interno ao processar criação do contrato';
        res.status(500).json({ error: errMsg });
    }
});

// ─── POST /api/contracts/self (CLIENT) ──────────────────

const selfContractSchema = z.object({
    name: z.string().min(1, 'Nome do projeto é obrigatório'),
    type: z.nativeEnum(ContractType),
    tier: z.nativeEnum(Tier),
    durationMonths: z.number().refine(v => v === 3 || v === 6, 'Duração deve ser 3 ou 6 meses'),
    firstBookingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato de data inválido'),
    firstBookingTime: z.string().regex(/^\d{2}:\d{2}$/, 'Formato de horário inválido'),
    fixedDayOfWeek: z.number().min(1).max(6).optional(),
    fixedTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    paymentMethod: z.nativeEnum(PaymentMethod),
    addOns: z.array(z.string()).optional(),
    resolvedConflicts: z.array(z.object({
        originalDate: z.string(),
        originalTime: z.string(),
        newDate: z.string(),
        newTime: z.string()
    })).optional(),
});

router.post('/self', authenticate, async (req: Request, res: Response) => {
    try {
        const data = selfContractSchema.parse(req.body);
        const userId = req.user!.userId;

        // Validate first booking date is within configured window
        const firstBookingMinDays = await getConfig('first_booking_min_days');
        const firstBookingMaxDays = await getConfig('first_booking_max_days');
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const firstDate = new Date(data.firstBookingDate + 'T00:00:00');
        const diffDays = Math.ceil((firstDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
        if (diffDays < firstBookingMinDays || diffDays > firstBookingMaxDays) {
            res.status(400).json({ error: `A primeira gravação deve ser agendada para os próximos ${firstBookingMinDays} a ${firstBookingMaxDays} dias.` });
            return;
        }

        // Validate Fixo requires day and time
        if (data.type === 'FIXO' && (!data.fixedDayOfWeek || !data.fixedTime)) {
            // Infer from first booking
            const dayOfWeek = firstDate.getDay() === 0 ? 7 : firstDate.getDay(); // 1=Mon..6=Sat
            data.fixedDayOfWeek = dayOfWeek;
            data.fixedTime = data.firstBookingTime;
        }

        const discountPct = data.durationMonths === 3 ? await getConfig('discount_3months') : await getConfig('discount_6months');

        // Contract starts on the first booking date
        const startDate = firstDate;
        const endDate = new Date(startDate);
        endDate.setMonth(endDate.getMonth() + data.durationMonths);

        const totalEpisodes = data.durationMonths === 3 ? await getConfig('episodes_3months') : await getConfig('episodes_6months');

        const contract = await prisma.contract.create({
            data: {
                userId,
                name: data.name,
                type: data.type,
                tier: data.tier,
                durationMonths: data.durationMonths,
                discountPct,
                startDate,
                endDate,
                status: ContractStatus.ACTIVE,
                fixedDayOfWeek: data.type === 'FIXO' ? data.fixedDayOfWeek : null,
                fixedTime: data.type === 'FIXO' ? data.fixedTime : null,
                flexCreditsTotal: data.type === 'FLEX' ? totalEpisodes : null,
                flexCreditsRemaining: data.type === 'FLEX' ? totalEpisodes : null,
                flexCycleStart: data.type === 'FLEX' ? startDate : null,
                flexWeeksCompensated: data.type === 'FLEX' ? 0 : null,
                paymentMethod: data.paymentMethod,
                addOns: data.addOns || [],
            },
        });

        // For FIXO: auto-generate bookings
        if (data.type === 'FIXO' && data.fixedDayOfWeek && data.fixedTime) {
            const bookings = [];
            const current = new Date(startDate);

            while (current.getDay() !== (data.fixedDayOfWeek % 7)) {
                current.setDate(current.getDate() + 1);
            }

            const totalWeeks = data.durationMonths * (await getConfig('sessions_per_month'));
            const endTime = calculateEndTime(data.fixedTime);
            const basePrice = await getBasePriceDynamic(data.tier);
            const discountedPrice = applyDiscount(basePrice, discountPct);

            for (let week = 0; week < totalWeeks; week++) {
                const bookingDate = new Date(current);
                bookingDate.setDate(current.getDate() + week * 7);
                if (bookingDate > endDate) break;

                const bookingDateStr = bookingDate.toISOString().split('T')[0];
                const fixedTime = data.fixedTime!;
                let finalDate = bookingDate;
                let finalTime = fixedTime;

                // Check override resolutions from validation checks
                const resolution = data.resolvedConflicts?.find(c =>
                    c.originalDate === bookingDateStr && c.originalTime === fixedTime
                );

                if (resolution) {
                    finalDate = new Date(resolution.newDate + 'T00:00:00');
                    finalTime = resolution.newTime;
                }

                bookings.push({
                    userId,
                    contractId: contract.id,
                    date: finalDate,
                    startTime: finalTime,
                    endTime: calculateEndTime(finalTime),
                    status: BookingStatus.CONFIRMED,
                    tierApplied: data.tier,
                    price: discountedPrice,
                });
            }

            if (bookings.length > 0) {
                await prisma.booking.createMany({ data: bookings });
            }
        }

        // For FLEX: just create the first booking
        if (data.type === 'FLEX') {
            const endTime = calculateEndTime(data.firstBookingTime);
            const basePrice = await getBasePriceDynamic(data.tier);
            const discountedPrice = applyDiscount(basePrice, discountPct);

            await prisma.booking.create({
                data: {
                    userId,
                    contractId: contract.id,
                    date: firstDate,
                    startTime: data.firstBookingTime,
                    endTime,
                    status: BookingStatus.CONFIRMED,
                    tierApplied: data.tier,
                    price: discountedPrice,
                    addOns: data.addOns ? data.addOns.filter(a => a !== 'GESTAO_SOCIAL') : [],
                },
            });
        }

        // Calculate Add-ons cost
        let addonsCost = 0;
        if (data.addOns && data.addOns.length > 0) {
            const addonConfigs = await prisma.addOnConfig.findMany({
                where: { key: { in: data.addOns } }
            });
            const baseAddonsCost = addonConfigs.reduce((acc, curr) => acc + curr.price, 0);
            addonsCost = applyDiscount(baseAddonsCost, discountPct);
        }

        // Generate payment installments
        const basePrice = await getBasePriceDynamic(data.tier);
        const discountedPrice = applyDiscount(basePrice, discountPct);
        const monthlyAmount = ((await getConfig('sessions_per_month')) * discountedPrice) + addonsCost;
        const payments = [];

        for (let i = 0; i < data.durationMonths; i++) {
            const dueDate = new Date(startDate);
            dueDate.setMonth(dueDate.getMonth() + i);

            payments.push({
                userId,
                contractId: contract.id,
                provider: 'CORA' as const,
                amount: monthlyAmount,
                status: 'PENDING' as const,
                dueDate,
            });
        }

        if (payments.length > 0) {
            await prisma.payment.createMany({ data: payments });
        }

        // Enrich payments with gateway (Cora/Stripe) data
        const createdPayments = await prisma.payment.findMany({
            where: { contractId: contract.id },
            include: { user: { select: { name: true, email: true } } },
            orderBy: { dueDate: 'asc' },
        });

        for (const p of createdPayments) {
            try {
                const result = await gatewayCreatePayment({
                    paymentMethod: data.paymentMethod as 'PIX' | 'BOLETO' | 'CARTAO',
                    amount: p.amount,
                    description: `${data.name} - Parcela`,
                    customer: { name: p.user.name, email: p.user.email || '' },
                    dueDate: p.dueDate || new Date(),
                    paymentId: p.id,
                });
                await updatePaymentWithGatewayResult(p.id, result);
            } catch (err) {
                console.error(`[Gateway] Failed to create payment for ${p.id}:`, err);
            }
        }

        res.status(201).json({
            contract,
            message: `Contrato ${data.type} criado com sucesso!`,
        });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        console.error('Erro ao criar contrato (Cliente):', err);
        const errMsg = err instanceof Error ? err.message : 'Erro interno ao processar criação do contrato';
        res.status(500).json({ error: errMsg });
    }
});

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

const customCheckSchema = z.object({
    tier: z.nativeEnum(Tier),
    durationMonths: z.number().min(1).max(12),
    schedule: z.array(z.object({
        day: z.number().min(1).max(6), // 1=Mon..6=Sat
        time: z.string().regex(/^\d{2}:\d{2}$/),
    })).min(1, 'Selecione pelo menos um dia'),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

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

// ─── POST /api/contracts/custom (CLIENT + ADMIN) ────────
// "Monte Seu Plano" — multi-day custom contract
// Admin can pass userId to create on behalf of a client

const customContractSchema = z.object({
    name: z.string().min(1, 'Nome do projeto é obrigatório'),
    tier: z.nativeEnum(Tier),
    durationMonths: z.number().min(1).max(12),
    schedule: z.array(z.object({
        day: z.number().min(0).max(6),
        time: z.string().regex(/^\d{2}:\d{2}$/),
    })).optional().default([]),
    paymentMethod: z.nativeEnum(PaymentMethod),
    addOns: z.array(z.string()).optional(),
    addonConfig: z.record(z.string(), z.object({
        mode: z.enum(['all', 'credits']),
        perCycle: z.number().optional(),
    })).optional(),
    resolvedConflicts: z.array(z.object({
        originalDate: z.string(),
        originalTime: z.string(),
        newDate: z.string(),
        newTime: z.string(),
    })).optional(),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    userId: z.string().uuid().optional(),
    // Enhanced scheduling
    frequency: z.enum(['WEEKLY', 'BIWEEKLY', 'MONTHLY', 'CUSTOM']).default('WEEKLY'),
    weekPattern: z.array(z.number().min(1).max(5)).optional(), // e.g. [1,3] = weeks 1 & 3
    customDates: z.array(z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        time: z.string().regex(/^\d{2}:\d{2}$/),
    })).optional(),
});

router.post('/custom', authenticate, async (req: Request, res: Response) => {
    try {
        const data = customContractSchema.parse(req.body);
        // Admin can create on behalf of a client
        const userId = (req.user!.role === 'ADMIN' && data.userId) ? data.userId : req.user!.userId;

        // ─── Volume calculations (mode-aware) ────────────────
        const frequency = data.frequency || 'WEEKLY';
        let totalSessions: number;
        let sessionsPerWeek: number;
        let sessionsPerCycle: number;

        if (frequency === 'CUSTOM' && data.customDates && data.customDates.length > 0) {
            totalSessions = data.customDates.length;
            sessionsPerWeek = Math.round(totalSessions / (data.durationMonths * 4));
            sessionsPerCycle = Math.round(totalSessions / data.durationMonths);
        } else {
            sessionsPerWeek = data.schedule.length;
            if (frequency === 'BIWEEKLY') {
                sessionsPerCycle = sessionsPerWeek * 2; // 2 out of 4 weeks
            } else if (frequency === 'MONTHLY') {
                const weeksActive = (data.weekPattern || [1]).length;
                sessionsPerCycle = sessionsPerWeek * weeksActive;
            } else {
                sessionsPerCycle = sessionsPerWeek * 4;
            }
            totalSessions = sessionsPerCycle * data.durationMonths;
        }

        // ─── Discount logic (volume-based) ──────────────────
        let discountPct = 0;
        if (totalSessions >= 24) discountPct = 40;
        else if (totalSessions >= 12) discountPct = 30;

        // ─── Dates ──────────────────────────────────────────
        const startDate = data.startDate
            ? new Date(data.startDate + 'T00:00:00')
            : (() => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); return d; })();
        const endDate = new Date(startDate);
        endDate.setMonth(endDate.getMonth() + data.durationMonths);

        // ─── Access mode (from admin config) ─────────────────
        const pmConfig = await prisma.paymentMethodConfig.findUnique({ where: { key: data.paymentMethod } });
        const accessMode = pmConfig?.accessMode === 'PROGRESSIVE' ? 'PROGRESSIVE' : 'FULL';

        // ─── Create contract ────────────────────────────────
        const contract = await prisma.contract.create({
            data: {
                userId,
                name: data.name,
                type: ContractType.CUSTOM,
                tier: data.tier,
                durationMonths: data.durationMonths,
                discountPct,
                startDate,
                endDate,
                status: ContractStatus.ACTIVE,
                paymentMethod: data.paymentMethod,
                addOns: data.addOns || [],
                customSchedule: JSON.stringify({
                    frequency,
                    schedule: data.schedule,
                    weekPattern: data.weekPattern,
                    customDates: data.customDates,
                }),
                sessionsPerWeek,
                sessionsPerCycle,
                totalSessions,
                addonCredits: data.addonConfig ? JSON.stringify(data.addonConfig) : null,
                accessMode,
            },
        });

        // ─── Generate bookings (mode-aware) ─────────────────
        const basePrice = await getBasePriceDynamic(data.tier);
        const discountedPrice = applyDiscount(basePrice, discountPct);
        const bookings: any[] = [];

        if (frequency === 'CUSTOM' && data.customDates && data.customDates.length > 0) {
            // CUSTOM: use explicit dates
            for (const cd of data.customDates) {
                const bDate = new Date(cd.date + 'T00:00:00');
                bookings.push({
                    userId,
                    contractId: contract.id,
                    date: bDate,
                    startTime: cd.time,
                    endTime: calculateEndTime(cd.time),
                    status: BookingStatus.CONFIRMED,
                    tierApplied: data.tier,
                    price: discountedPrice,
                    addOns: data.addOns ? data.addOns.filter(a => a !== 'GESTAO_SOCIAL') : [],
                });
            }
        } else {
            // WEEKLY / BIWEEKLY / MONTHLY: generate from schedule
            for (const slot of data.schedule) {
                const current = new Date(startDate);
                // Align to first occurrence of this day of week
                while (current.getUTCDay() !== (slot.day % 7)) {
                    current.setDate(current.getDate() + 1);
                }

                while (current < endDate) {
                    let shouldGenerate = true;

                    if (frequency === 'BIWEEKLY') {
                        // Calculate week index from contract start (1-indexed, cycling 1-4)
                        const weekIndex = Math.floor((current.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24 * 7));
                        const weekInCycle = (weekIndex % 4) + 1; // 1-4
                        const pattern = data.weekPattern || [1, 3];
                        shouldGenerate = pattern.includes(weekInCycle);
                    } else if (frequency === 'MONTHLY') {
                        // Week-of-month: 1st Monday = week 1, 2nd = week 2, etc.
                        const dayOfMonth = current.getUTCDate();
                        const weekOfMonth = Math.ceil(dayOfMonth / 7);
                        const pattern = data.weekPattern || [1];
                        shouldGenerate = pattern.includes(weekOfMonth);
                    }

                    if (shouldGenerate) {
                        const bookingDateStr = current.toISOString().split('T')[0];
                        let finalDate = new Date(current);
                        let finalTime = slot.time;

                        const resolution = data.resolvedConflicts?.find(c =>
                            c.originalDate === bookingDateStr && c.originalTime === slot.time
                        );
                        if (resolution) {
                            finalDate = new Date(resolution.newDate + 'T00:00:00');
                            finalTime = resolution.newTime;
                        }

                        const weekIndex = Math.floor((current.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24 * 7));
                        const cycleIndex = Math.floor(weekIndex / 4);
                        const status = accessMode === 'PROGRESSIVE' && cycleIndex > 0
                            ? BookingStatus.RESERVED
                            : BookingStatus.CONFIRMED;

                        bookings.push({
                            userId,
                            contractId: contract.id,
                            date: finalDate,
                            startTime: finalTime,
                            endTime: calculateEndTime(finalTime),
                            status,
                            tierApplied: data.tier,
                            price: discountedPrice,
                            addOns: data.addOns ? data.addOns.filter(a => a !== 'GESTAO_SOCIAL') : [],
                        });
                    }

                    current.setDate(current.getDate() + 7);
                }
            }
        }

        if (bookings.length > 0) {
            await prisma.booking.createMany({ data: bookings });
        }

        // ─── Generate payments per cycle (4 weeks) ──────────
        // Calculate addons cost per cycle
        let addonsCostPerCycle = 0;
        if (data.addOns && data.addOns.length > 0) {
            const addonConfigs = await prisma.addOnConfig.findMany({
                where: { key: { in: data.addOns } },
            });

            for (const addon of addonConfigs) {
                const config = data.addonConfig?.[addon.key];
                if (config?.mode === 'credits' && config.perCycle) {
                    // Credits: charge per-credit price × credits per cycle
                    addonsCostPerCycle += applyDiscount(addon.price * config.perCycle, discountPct);
                } else {
                    // All: charge per-session price × sessions per cycle
                    addonsCostPerCycle += applyDiscount(addon.price * sessionsPerCycle, discountPct);
                }
            }
        }

        const cycleBaseAmount = sessionsPerCycle * discountedPrice;
        const cycleAmount = cycleBaseAmount + addonsCostPerCycle;

        const payments: any[] = [];
        for (let i = 0; i < data.durationMonths; i++) {
            const dueDate = new Date(startDate);
            dueDate.setDate(dueDate.getDate() + i * 28); // 4-week cycles

            payments.push({
                userId,
                contractId: contract.id,
                provider: 'CORA' as const,
                amount: cycleAmount,
                status: 'PENDING' as const,
                dueDate,
            });
        }

        if (payments.length > 0) {
            await prisma.payment.createMany({ data: payments });
        }

        // Enrich payments with gateway (Cora/Stripe) data
        const userInfo = await prisma.user.findUnique({ where: { id: userId }, select: { name: true, email: true } });
        const allPayments = await prisma.payment.findMany({
            where: { contractId: contract.id },
            orderBy: { dueDate: 'asc' },
        });

        for (const p of allPayments) {
            try {
                const result = await gatewayCreatePayment({
                    paymentMethod: data.paymentMethod as 'PIX' | 'BOLETO' | 'CARTAO',
                    amount: p.amount,
                    description: `${data.name} - Parcela`,
                    customer: { name: userInfo?.name || 'Cliente', email: userInfo?.email || '' },
                    dueDate: p.dueDate || new Date(),
                    paymentId: p.id,
                });
                await updatePaymentWithGatewayResult(p.id, result);
            } catch (err) {
                console.error(`[Gateway] Failed to create payment for ${p.id}:`, err);
            }
        }

        const createdPayments = await prisma.payment.findMany({
            where: { contractId: contract.id },
            orderBy: { dueDate: 'asc' },
        });

        res.status(201).json({
            contract: {
                ...contract,
                customSchedule: data.schedule,
            },
            payments: createdPayments.map(p => ({
                id: p.id,
                amount: p.amount,
                dueDate: p.dueDate?.toISOString().split('T')[0],
                status: p.status,
            })),
            summary: {
                sessionsPerWeek,
                sessionsPerCycle,
                totalSessions,
                discountPct,
                accessMode,
                cycleAmount,
                totalBookingsGenerated: bookings.length,
            },
            message: `Plano Personalizado criado! ${bookings.length} sessões reservadas com ${discountPct}% de desconto.`,
        });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        console.error('Erro ao criar contrato custom:', err);
        const errMsg = err instanceof Error ? err.message : 'Erro interno';
        res.status(500).json({ error: errMsg });
    }
});

// ─── GET /api/contracts (ADMIN) ─────────────────────────

router.get('/', authenticate, authorize('ADMIN'), async (_req: Request, res: Response) => {
    const contracts = await prisma.contract.findMany({
        orderBy: { createdAt: 'desc' },
        include: {
            user: { select: { id: true, name: true, email: true } },
            _count: { select: { bookings: true, payments: true } },
        },
    });

    res.json({ contracts });
});

// ─── GET /api/contracts/my ──────────────────────────────

router.get('/my', authenticate, async (req: Request, res: Response) => {
    const contracts = await prisma.contract.findMany({
        where: { userId: req.user!.userId },
        orderBy: { createdAt: 'desc' },
        include: {
            _count: { select: { bookings: true } },
            bookings: {
                select: {
                    id: true, status: true, date: true,
                    startTime: true, endTime: true, tierApplied: true, price: true,
                    clientNotes: true, adminNotes: true, platforms: true, platformLinks: true, addOns: true,
                },
                orderBy: { date: 'asc' },
                where: { status: { not: 'CANCELLED' } },
            },
            payments: {
                select: { id: true, amount: true, status: true, dueDate: true, pixString: true, boletoUrl: true, paymentUrl: true },
                orderBy: { dueDate: 'asc' },
            },
        },
    });

    // Enrich with completed bookings count and addon usage
    const sessionsPerMonthMy = await getConfig('sessions_per_month');
    const enriched = contracts.map(c => {
        const completedBookings = c.bookings.filter(b =>
            b.status === 'COMPLETED' || b.status === 'CONFIRMED' || b.status === 'FALTA'
        ).length;
        const totalBookings = c.type === 'FIXO'
            ? c.durationMonths * sessionsPerMonthMy
            : (c.flexCreditsTotal || 0);

        let addonUsage: Record<string, { limit: number, used: number }> | undefined = undefined;

        if (c.type === 'CUSTOM' && c.addonCredits) {
            try {
                const config = JSON.parse(c.addonCredits) as Record<string, { mode: string, perCycle?: number }>;
                addonUsage = {};
                
                // Determine current cycle
                const now = new Date();
                const msPerCycle = 1000 * 60 * 60 * 24 * 28; // 4 weeks
                let diffMs = now.getTime() - c.startDate.getTime();
                let cycleIndex = Math.floor(diffMs / msPerCycle);
                if (cycleIndex < 0) cycleIndex = 0;
                
                const cycleStart = new Date(c.startDate.getTime() + cycleIndex * msPerCycle);
                const cycleEnd = new Date(cycleStart.getTime() + msPerCycle);

                // Initialize limits
                for (const [key, val] of Object.entries(config)) {
                    if (val.mode === 'credits' && val.perCycle) {
                        addonUsage[key] = { limit: val.perCycle, used: 0 };
                    }
                }

                // Count usage in current cycle
                for (const b of c.bookings) {
                    if (b.date >= cycleStart && b.date < cycleEnd && (b.status === 'CONFIRMED' || b.status === 'COMPLETED' || b.status === 'FALTA')) {
                        if (b.addOns && Array.isArray(b.addOns)) {
                            for (const addOn of b.addOns) {
                                if (addonUsage[addOn]) {
                                    addonUsage[addOn].used += 1;
                                }
                            }
                        }
                    }
                }
            } catch (e) {
                console.error("Error parsing addonCredits for contract", c.id, e);
            }
        }

        const result = {
            ...c,
            completedBookings,
            totalBookings,
            ...(addonUsage ? { addonUsage } : {})
        };
        console.log("CONTRACT", c.id, "duration:", c.durationMonths, "totalBookings:", totalBookings);
        return result;
    });

    res.json({ contracts: enriched });
});

// ─── GET /api/contracts/:id ─────────────────────────────

router.get('/:id', authenticate, async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const isAdmin = req.user!.role === 'ADMIN';

    const contract = await prisma.contract.findFirst({
        where: {
            id,
            ...(isAdmin ? {} : { userId: req.user!.userId }),
        },
        include: {
            user: { select: { id: true, name: true, email: true } },
            bookings: {
                orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
                select: {
                    id: true,
                    date: true,
                    startTime: true,
                    endTime: true,
                    status: true,
                    price: true,
                },
            },
            payments: {
                orderBy: { dueDate: 'asc' },
            },
        },
    });

    if (!contract) {
        res.status(404).json({ error: 'Contrato não encontrado.' });
        return;
    }

    res.json({ contract });
});

// ─── PATCH /api/contracts/:id (ADMIN update) ────────────

const updateContractSchema = z.object({
    status: z.enum(['ACTIVE', 'EXPIRED', 'CANCELLED']).optional(),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    flexCreditsRemaining: z.number().int().min(0).optional(),
    contractUrl: z.string().url().optional().or(z.literal('')),
    paymentMethod: z.nativeEnum(PaymentMethod).optional(),
});

router.patch('/:id', authenticate, authorize('ADMIN'), async (req: Request, res: Response) => {
    try {
        const id = req.params.id as string;
        const data = updateContractSchema.parse(req.body);

        const contract = await prisma.contract.findUnique({ where: { id } });
        if (!contract) {
            res.status(404).json({ error: 'Contrato não encontrado.' });
            return;
        }

        const updateData: any = {};
        if (data.status) updateData.status = data.status;
        if (data.endDate) updateData.endDate = new Date(data.endDate + 'T00:00:00');
        if (data.flexCreditsRemaining !== undefined) updateData.flexCreditsRemaining = data.flexCreditsRemaining;
        if (data.contractUrl !== undefined) updateData.contractUrl = data.contractUrl || null;
        if (data.paymentMethod) updateData.paymentMethod = data.paymentMethod;

        const updated = await prisma.contract.update({
            where: { id },
            data: updateData,
            include: {
                user: { select: { id: true, name: true, email: true } },
            },
        });

        res.json({ contract: updated, message: 'Contrato atualizado com sucesso.' });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        throw err;
    }
});

// ─── DELETE /api/contracts/:id (ADMIN cancel) ───────────

router.delete('/:id', authenticate, authorize('ADMIN'), async (req: Request, res: Response) => {
    const id = req.params.id as string;

    const contract = await prisma.contract.findUnique({ where: { id } });
    if (!contract) {
        res.status(404).json({ error: 'Contrato não encontrado.' });
        return;
    }

    if (contract.status === 'CANCELLED') {
        res.status(400).json({ error: 'Contrato já está cancelado.' });
        return;
    }

    // Cancel contract
    await prisma.contract.update({
        where: { id },
        data: { status: 'CANCELLED' },
    });

    // Cancel future bookings tied to this contract
    await prisma.booking.updateMany({
        where: {
            contractId: id,
            status: { not: 'CANCELLED' },
            date: { gte: new Date() },
        },
        data: { status: 'CANCELLED' },
    });

    res.json({ message: 'Contrato cancelado. Agendamentos futuros foram cancelados.' });
});

// ─── POST /api/contracts/:id/request-cancellation (CLIENT)
router.post('/:id/request-cancellation', authenticate, async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const userId = req.user!.userId;

    const contract = await prisma.contract.findFirst({
        where: { id, userId },
    });

    if (!contract) {
        res.status(404).json({ error: 'Contrato não encontrado.' });
        return;
    }

    if (contract.status !== 'ACTIVE') {
        res.status(400).json({ error: 'Apenas contratos ativos podem solicitar cancelamento.' });
        return;
    }

    const updated = await prisma.contract.update({
        where: { id },
        data: { status: 'PENDING_CANCELLATION' },
    });

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const cancelledBookings = await prisma.booking.updateMany({
        where: {
            contractId: id,
            status: { not: 'CANCELLED' },
            date: { gte: today },
        },
        data: { status: 'CANCELLED' },
    });

    res.json({
        contract: updated,
        message: `Solicitação de cancelamento enviada. ${cancelledBookings.count} agendamentos futuros foram liberados.`
    });
});

// ─── POST /api/contracts/:id/resolve-cancellation (ADMIN)
const resolveCancellationSchema = z.object({
    action: z.enum(['CHARGE_FEE', 'WAIVE_FEE']),
});

router.post('/:id/resolve-cancellation', authenticate, authorize('ADMIN'), async (req: Request, res: Response) => {
    try {
        const id = req.params.id as string;
        const data = resolveCancellationSchema.parse(req.body);

        const contract = await prisma.contract.findUnique({
            where: { id },
            include: { bookings: true }
        });

        if (!contract) {
            res.status(404).json({ error: 'Contrato não encontrado.' });
            return;
        }

        if (contract.status !== 'PENDING_CANCELLATION') {
            res.status(400).json({ error: 'O contrato não está aguardando cancelamento.' });
            return;
        }

        let message = 'Contrato cancelado com sucesso.';

        if (data.action === 'CHARGE_FEE') {
            message = 'Quebra de contrato aplicada. Multa de 20% processada com sucesso. Contrato cancelado.';
        } else if (data.action === 'WAIVE_FEE') {
            message = 'Cancelamento isento efetuado pelo estúdio. Contrato cancelado.';
        }

        const updated = await prisma.contract.update({
            where: { id },
            data: { status: 'CANCELLED' },
        });

        res.json({ contract: updated, message });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        throw err;
    }
});

// ─── POST /api/contracts/service (Standalone Services) ──

const serviceContractSchema = z.object({
    serviceKey: z.string(),
    paymentMethod: z.nativeEnum(PaymentMethod),
    durationMonths: z.number().int().optional(),
});

router.post('/service', authenticate, async (req: Request, res: Response) => {
    try {
        const data = serviceContractSchema.parse(req.body);
        const userId = req.user!.userId;

        const addon = await prisma.addOnConfig.findUnique({ where: { key: data.serviceKey } });
        if (!addon) {
            res.status(404).json({ error: 'Serviço não encontrado.' });
            return;
        }

        const duration = data.durationMonths || 1;
        const d6 = await getConfig('service_discount_6months');
        const d3 = await getConfig('service_discount_3months');
        const discountPct = duration === 6 ? d6 : (duration === 3 ? d3 : 0);

        const startDate = new Date();
        const endDate = new Date(startDate);
        endDate.setMonth(endDate.getMonth() + duration);

        const contract = await prisma.contract.create({
            data: {
                userId,
                name: addon.name,
                type: ContractType.SERVICO,
                tier: Tier.COMERCIAL,
                durationMonths: duration,
                discountPct,
                startDate,
                endDate,
                status: ContractStatus.ACTIVE,
                paymentMethod: data.paymentMethod,
                addOns: [data.serviceKey],
                flexCreditsTotal: 0,
                flexCreditsRemaining: 0,
            },
        });

        const monthlyBase = addon.price; 
        const monthlyDiscounted = Math.round(monthlyBase * (1 - discountPct / 100));
        let paymentAmount = monthlyDiscounted * duration;
        
        if (data.paymentMethod === 'PIX') {
            const pixDiscount = await getConfig('pix_extra_discount_pct');
            paymentAmount = Math.round(paymentAmount * (1 - pixDiscount / 100));
        } else if (data.paymentMethod === 'CARTAO') {
            const fee3x = await getConfig('card_fee_3x_pct');
            const fee6x = await getConfig('card_fee_6x_pct');
            if (duration === 3) paymentAmount = Math.round(paymentAmount * (1 + fee3x / 100));
            else if (duration === 6) paymentAmount = Math.round(paymentAmount * (1 + fee6x / 100));
        }

        const payment = await prisma.payment.create({
            data: {
                userId,
                contractId: contract.id,
                provider: 'CORA',
                amount: paymentAmount,
                status: 'PENDING',
                dueDate: startDate,
            }
        });

        // Dispatch to gateway (Cora/Stripe)
        const userInfo = await prisma.user.findUnique({ where: { id: userId }, select: { name: true, email: true } });
        let checkoutUrl = `/checkout/payment-method?paymentId=${payment.id}`;
        try {
            const result = await gatewayCreatePayment({
                paymentMethod: data.paymentMethod as 'PIX' | 'BOLETO' | 'CARTAO',
                amount: paymentAmount,
                description: `Serviço ${addon.name}`,
                customer: { name: userInfo?.name || 'Cliente', email: userInfo?.email || '' },
                dueDate: startDate,
                paymentId: payment.id,
            });
            await updatePaymentWithGatewayResult(payment.id, result);
            if (result.paymentUrl) checkoutUrl = result.paymentUrl;
        } catch (err) {
            console.error(`[Gateway] Service payment fallback:`, err);
        }

        res.status(201).json({
            contract,
            checkoutUrl,
            message: `Serviço ${addon.name} contratado com sucesso!`,
        });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        res.status(500).json({ error: 'Erro interno ao processar serviço.' });
    }
});

// ─── POST /api/contracts/:id/renew (ADMIN) ──────────────
router.post('/:id/renew', authenticate, authorize('ADMIN'), async (req: Request, res: Response) => {
    try {
        const id = req.params.id as string;
        const { durationMonths = 3, tier, type, startDate: startStr } = req.body;

        const original = await prisma.contract.findUnique({ where: { id } });
        if (!original) { res.status(404).json({ error: 'Contrato não encontrado.' }); return; }
        if (!['ACTIVE', 'EXPIRED'].includes(original.status)) { res.status(400).json({ error: 'Só é possível renovar contratos ativos ou expirados.' }); return; }

        const newTier = tier || original.tier;
        const newType = type || original.type;
        const discount3 = await getConfig('discount_3months');
        const discount6 = await getConfig('discount_6months');
        const discountPct = durationMonths === 6 ? discount6 : discount3;

        const start = startStr ? new Date(startStr + 'T00:00:00') : new Date(original.endDate);
        if (start <= new Date(original.startDate)) start.setTime(new Date(original.endDate).getTime());
        const end = new Date(start);
        end.setMonth(end.getMonth() + durationMonths);

        const flexCreditsTotal = newType === 'FLEX' ? durationMonths * 4 : undefined;

        const renewed = await prisma.contract.create({
            data: {
                name: original.name,
                userId: original.userId,
                type: newType,
                tier: newTier,
                durationMonths,
                discountPct,
                startDate: start,
                endDate: end,
                fixedDayOfWeek: newType === 'FIXO' ? original.fixedDayOfWeek : null,
                fixedTime: newType === 'FIXO' ? original.fixedTime : null,
                contractUrl: original.contractUrl,
                addOns: original.addOns,
                paymentMethod: original.paymentMethod,
                flexCreditsTotal: flexCreditsTotal ?? null,
                flexCreditsRemaining: flexCreditsTotal ?? null,
                flexCycleStart: newType === 'FLEX' ? start : null,
                renewedFromId: original.id,
            },
        });

        // Generate bookings for FIXO
        if (newType === 'FIXO' && original.fixedDayOfWeek && original.fixedTime) {
            const bookings: any[] = [];
            const cursor = new Date(start);
            while (cursor.getDay() !== (original.fixedDayOfWeek % 7)) cursor.setDate(cursor.getDate() + 1);
            while (cursor < end) {
                const basePrice = await getBasePriceDynamic(newTier as any);
                const price = applyDiscount(basePrice, discountPct);
                const endTime = calculateEndTime(original.fixedTime!);
                bookings.push({
                    userId: original.userId,
                    contractId: renewed.id,
                    date: new Date(cursor.toISOString().split('T')[0]),
                    startTime: original.fixedTime!,
                    endTime,
                    tierApplied: newTier,
                    price,
                    status: 'RESERVED' as BookingStatus,
                });
                cursor.setDate(cursor.getDate() + 7);
            }
            if (bookings.length) await prisma.booking.createMany({ data: bookings });
        }

        // Audit
        const { logAudit } = await import('../../lib/audit');
        await logAudit('CONTRACT', renewed.id, 'RENEWED', (req as any).user.id, { fromContractId: original.id, durationMonths, tier: newTier, type: newType });

        res.status(201).json({ contract: renewed, message: 'Contrato renovado com sucesso!' });
    } catch (err: any) {
        console.error('[renew]', err);
        res.status(500).json({ error: err.message || 'Erro ao renovar contrato.' });
    }
});

// ─── PATCH /api/contracts/:id/pause (ADMIN) ─────────────
router.patch('/:id/pause', authenticate, authorize('ADMIN'), async (req: Request, res: Response) => {
    try {
        const id = req.params.id as string;
        const { reason, resumeDate } = req.body;

        const contract = await prisma.contract.findUnique({ where: { id } });
        if (!contract) { res.status(404).json({ error: 'Contrato não encontrado.' }); return; }
        if (contract.status !== 'ACTIVE') { res.status(400).json({ error: 'Só é possível pausar contratos ativos.' }); return; }

        const now = new Date();
        let resume: Date | null = null;
        if (resumeDate) {
            resume = new Date(resumeDate + 'T00:00:00');
            const diffDays = Math.floor((resume.getTime() - now.getTime()) / 86400000);
            if (diffDays > 30) { res.status(400).json({ error: 'Pausa máxima de 30 dias.' }); return; }
        }

        // Cancel future bookings
        await prisma.booking.updateMany({
            where: { contractId: id, status: { in: ['RESERVED', 'CONFIRMED'] }, date: { gte: now } },
            data: { status: 'CANCELLED' },
        });

        const updated = await prisma.contract.update({
            where: { id },
            data: { status: 'PAUSED', pausedAt: now, pauseReason: reason || null, resumeDate: resume },
        });

        const { logAudit } = await import('../../lib/audit');
        await logAudit('CONTRACT', id, 'PAUSED', (req as any).user.id, { reason, resumeDate });

        res.json({ contract: updated, message: 'Contrato pausado.' });
    } catch (err: any) {
        console.error('[pause]', err);
        res.status(500).json({ error: err.message || 'Erro ao pausar contrato.' });
    }
});

// ─── PATCH /api/contracts/:id/resume (ADMIN) ────────────
router.patch('/:id/resume', authenticate, authorize('ADMIN'), async (req: Request, res: Response) => {
    try {
        const id = req.params.id as string;

        const contract = await prisma.contract.findUnique({ where: { id } });
        if (!contract) { res.status(404).json({ error: 'Contrato não encontrado.' }); return; }
        if (contract.status !== 'PAUSED') { res.status(400).json({ error: 'Contrato não está pausado.' }); return; }

        const now = new Date();
        const pausedAt = contract.pausedAt || now;
        const daysPaused = Math.floor((now.getTime() - new Date(pausedAt).getTime()) / 86400000);

        // Extend endDate by days paused
        const newEndDate = new Date(contract.endDate);
        newEndDate.setDate(newEndDate.getDate() + daysPaused);

        const updated = await prisma.contract.update({
            where: { id },
            data: { status: 'ACTIVE', endDate: newEndDate, pausedAt: null, pauseReason: null, resumeDate: null },
        });

        // Re-generate future bookings for FIXO
        if (contract.type === 'FIXO' && contract.fixedDayOfWeek && contract.fixedTime) {
            const bookings: any[] = [];
            const cursor = new Date(now);
            while (cursor.getDay() !== (contract.fixedDayOfWeek % 7)) cursor.setDate(cursor.getDate() + 1);
            while (cursor < newEndDate) {
                const basePrice = await getBasePriceDynamic(contract.tier as any);
                const discountPct = contract.discountPct;
                const price = applyDiscount(basePrice, discountPct);
                const endTime = calculateEndTime(contract.fixedTime!);
                bookings.push({
                    userId: contract.userId,
                    contractId: id,
                    date: new Date(cursor.toISOString().split('T')[0]),
                    startTime: contract.fixedTime!,
                    endTime,
                    tierApplied: contract.tier,
                    price,
                    status: 'RESERVED' as BookingStatus,
                });
                cursor.setDate(cursor.getDate() + 7);
            }
            if (bookings.length) await prisma.booking.createMany({ data: bookings });
        }

        const { logAudit } = await import('../../lib/audit');
        await logAudit('CONTRACT', id, 'RESUMED', (req as any).user.id, { daysPaused, newEndDate: newEndDate.toISOString() });

        res.json({ contract: updated, message: `Contrato retomado. Vigência estendida em ${daysPaused} dias.` });
    } catch (err: any) {
        console.error('[resume]', err);
        res.status(500).json({ error: err.message || 'Erro ao retomar contrato.' });
    }
});

export default router;



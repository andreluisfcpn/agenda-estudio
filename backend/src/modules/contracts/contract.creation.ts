import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { authenticate, authorize } from '../../middleware/auth';
import { ContractStatus, BookingStatus } from '../../generated/prisma/client';
import { getBasePriceDynamic, applyDiscount, calculateEndTime } from '../../utils/pricing';
import { getConfig } from '../../lib/businessConfig';
import { createPayment as gatewayCreatePayment, updatePaymentWithGatewayResult, validatePaymentMethod, getProviderForMethod, PaymentMethodDisabledError } from '../../lib/paymentGateway';
import { createContractSchema, selfContractSchema, customContractSchema } from './validators';

export function registerCreationRoutes(router: Router) {

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
                provider: getProviderForMethod(contract.paymentMethod || 'CARTAO'),
                amount: monthlyAmount,
                status: 'PENDING' as const,
                dueDate,
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

router.post('/self', authenticate, async (req: Request, res: Response) => {
    try {
        const data = selfContractSchema.parse(req.body);
        const userId = req.user!.userId;

        // Global guard: reject disabled payment methods
        try {
            await validatePaymentMethod(data.paymentMethod);
        } catch (err) {
            if (err instanceof PaymentMethodDisabledError) {
                res.status(400).json({ error: err.message });
                return;
            }
            throw err;
        }

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
                provider: getProviderForMethod(data.paymentMethod),
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

        let firstClientSecret: string | null = null;

        for (const p of createdPayments) {
            try {
                const result = await gatewayCreatePayment({
                    paymentMethod: data.paymentMethod as 'PIX' | 'BOLETO' | 'CARTAO',
                    amount: p.amount,
                    description: `${data.name} - Parcela`,
                    customer: { name: p.user.name, email: p.user.email || '' },
                    dueDate: p.dueDate || new Date(),
                    paymentId: p.id,
                    contractId: contract.id,
                    userId,
                });
                await updatePaymentWithGatewayResult(p.id, result);

                // Capture the first payment's clientSecret for inline card flow
                if (!firstClientSecret && result.clientSecret) {
                    firstClientSecret = result.clientSecret;
                }
            } catch (err) {
                console.error(`[Gateway] Failed to create payment for ${p.id}:`, err);
            }
        }

        res.status(201).json({
            contract,
            message: `Contrato ${data.type} criado com sucesso!`,
            ...(firstClientSecret && { clientSecret: firstClientSecret }),
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

// ─── POST /api/contracts/custom (CLIENT + ADMIN) ────────
// "Monte Seu Plano" — multi-day custom contract
// Admin can pass userId to create on behalf of a client

router.post('/custom', authenticate, async (req: Request, res: Response) => {
    try {
        const data = customContractSchema.parse(req.body);
        // Admin can create on behalf of a client
        const userId = (req.user!.role === 'ADMIN' && data.userId) ? data.userId : req.user!.userId;

        // Global guard: reject disabled payment methods
        try {
            await validatePaymentMethod(data.paymentMethod);
        } catch (err) {
            if (err instanceof PaymentMethodDisabledError) {
                res.status(400).json({ error: err.message });
                return;
            }
            throw err;
        }

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

        // ─── Discount logic (volume-based from BusinessConfig) ──────
        const d6 = await getConfig('discount_6months');
        const d3 = await getConfig('discount_3months');
        let discountPct = 0;
        if (totalSessions >= 24) discountPct = d6;
        else if (totalSessions >= 12) discountPct = d3;

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
                type: 'CUSTOM' as any,
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
                provider: getProviderForMethod(data.paymentMethod),
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

        let firstClientSecret: string | null = null;

        for (const p of allPayments) {
            try {
                const result = await gatewayCreatePayment({
                    paymentMethod: data.paymentMethod as 'PIX' | 'BOLETO' | 'CARTAO',
                    amount: p.amount,
                    description: `${data.name} - Parcela`,
                    customer: { name: userInfo?.name || 'Cliente', email: userInfo?.email || '' },
                    dueDate: p.dueDate || new Date(),
                    paymentId: p.id,
                    contractId: contract.id,
                    userId,
                });
                await updatePaymentWithGatewayResult(p.id, result);

                if (!firstClientSecret && result.clientSecret) {
                    firstClientSecret = result.clientSecret;
                }
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
            ...(firstClientSecret && { clientSecret: firstClientSecret }),
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

} // end registerCreationRoutes

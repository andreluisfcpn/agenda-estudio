import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { authenticate, authorize } from '../../middleware/auth.js';
import { ContractStatus, BookingStatus } from '../../generated/prisma/client.js';
import { getBasePriceDynamic, applyDiscount, calculateEndTime } from '../../utils/pricing.js';
import { getConfig } from '../../lib/businessConfig.js';
import { createPayment as gatewayCreatePayment, updatePaymentWithGatewayResult, validatePaymentMethod, getProviderForMethod, PaymentMethodDisabledError } from '../../lib/paymentGateway.js';
import { createContractSchema, selfContractSchema, customContractSchema } from './validators.js';
import { computeAddonsCost } from '../../lib/contractPricing.js';
import { resolvePlanAmounts } from '../../lib/paymentPolicy.js';

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
                // FLEX clock starts on the 1st recording (set when the 1st booking is made).
                flexCycleStart: null,
                flexWeeksCompensated: data.type === 'FLEX' ? 0 : null,
                flexForfeitFloor: data.type === 'FLEX' ? 0 : null,
                addOns: data.addOns || [],
                boletoAllowed: data.boletoAllowed ?? false,
                paymentMethod: data.paymentMethod ?? null,
                paymentPlan: data.paymentPlan ?? 'MONTHLY',
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

        // Generate payment installments — centralized pricing (add-ons + card surcharge +
        // PIX à-vista discount), identical to the client /self path so the creation endpoint
        // can never under-charge relative to it.
        const basePrice = await getBasePriceDynamic(data.tier);
        const discountedPrice = applyDiscount(basePrice, discountPct);
        const sessionsPerMonthAdmin = await getConfig('sessions_per_month');
        const adminAddonsCost = await computeAddonsCost(data.addOns, discountPct, sessionsPerMonthAdmin);
        const baseMonthly = (sessionsPerMonthAdmin * discountedPrice) + adminAddonsCost;
        const adminProvider = getProviderForMethod(data.paymentMethod || contract.paymentMethod || 'CARTAO');
        const adminIsFull = data.paymentPlan === 'FULL';
        // Centralized: FULL → single à-vista invoice; MONTHLY → durationMonths charges of the
        // plain base (no surcharge) on a 28-day cadence. Same rule as self/custom.
        const adminPlan = await resolvePlanAmounts({
            baseMonthly,
            durationMonths: data.durationMonths,
            plan: (data.paymentPlan || 'MONTHLY') as 'MONTHLY' | 'FULL',
            paymentMethod: data.paymentMethod,
            startDate,
        });
        const payments = adminPlan.scheduleDueDates.map((dueDate) => ({
            userId: data.userId,
            contractId: contract.id,
            provider: adminProvider,
            amount: adminIsFull ? adminPlan.fullAmount : adminPlan.monthlyAmount,
            status: 'PENDING' as const,
            dueDate,
        }));

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
            // First (earliest) payment so the admin can optionally charge it inline on the spot.
            firstPaymentId: createdPayments[0]?.id ?? null,
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
// Phase 1: Creates ONLY the first payment with contract data in metadata.
// Contract + bookings are created AFTER payment is confirmed (via webhook/verify).

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

        // Infer fixedDayOfWeek for FIXO
        if (data.type === 'FIXO' && (!data.fixedDayOfWeek || !data.fixedTime)) {
            const dayOfWeek = firstDate.getDay() === 0 ? 7 : firstDate.getDay();
            data.fixedDayOfWeek = dayOfWeek;
            data.fixedTime = data.firstBookingTime;
        }

        // Calculate first month's amount
        const discountPct = data.durationMonths === 3 ? await getConfig('discount_3months') : await getConfig('discount_6months');
        const basePrice = await getBasePriceDynamic(data.tier);
        const discountedPrice = applyDiscount(basePrice, discountPct);
        const sessionsPerMonth = await getConfig('sessions_per_month');

        const addonsCost = await computeAddonsCost(data.addOns, discountPct, sessionsPerMonth);
        const baseMonthly = (sessionsPerMonth * discountedPrice) + addonsCost;
        // Centralized plan rules (single source of truth): monthly = base (no card
        // surcharge); FULL = à-vista total with PIX discount. Schedule = 28-day cadence.
        const planAmounts = await resolvePlanAmounts({
            baseMonthly,
            durationMonths: data.durationMonths,
            plan: (data.paymentPlan || 'MONTHLY') as 'MONTHLY' | 'FULL',
            paymentMethod: data.paymentMethod,
            startDate: firstDate,
        });
        const monthlyAmount = planAmounts.monthlyAmount;
        const firstAmount = planAmounts.firstAmount;

        // Store contract creation data in payment metadata
        const contractData = {
            name: data.name,
            type: data.type,
            tier: data.tier,
            durationMonths: data.durationMonths,
            firstBookingDate: data.firstBookingDate,
            firstBookingTime: data.firstBookingTime,
            paymentMethod: data.paymentMethod,
            addOns: data.addOns || [],
            fixedDayOfWeek: data.fixedDayOfWeek,
            fixedTime: data.fixedTime,
            paymentPlan: data.paymentPlan,
            resolvedConflicts: data.resolvedConflicts,
            // Persist the resolved per-month amount so fulfillment of months 2..N uses the
            // SAME figure even if the surcharge config changes before the payment confirms.
            monthlyAmountResolved: monthlyAmount,
        };

        // Create ONLY the first payment (no contract yet)
        const firstPayment = await prisma.payment.create({
            data: {
                userId,
                provider: getProviderForMethod(data.paymentMethod),
                amount: firstAmount,
                status: 'PENDING',
                dueDate: firstDate,
                metadata: { contractData },
            },
        });

        // Enrich with gateway data. PIX/BOLETO generate the QR/boleto up-front so the client
        // can pay immediately. CARTÃO does NOT pre-create the PaymentIntent here — the inline
        // checkout creates it with the chosen installments (matching idempotency key + juros
        // policy); pre-creating it would collide with that second call.
        const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true, email: true, cpfCnpj: true } });
        let clientSecret: string | null = null;
        let pixString: string | null = null;

        if (data.paymentMethod !== 'CARTAO') {
            try {
                const result = await gatewayCreatePayment({
                    paymentMethod: data.paymentMethod as 'PIX' | 'BOLETO' | 'CARTAO',
                    amount: firstAmount,
                    description: `${data.name} - 1ª Parcela`,
                    customer: { name: user?.name || 'Cliente', email: user?.email || '', cpf: user?.cpfCnpj?.replace(/\D/g, '') || undefined },
                    dueDate: firstDate,
                    paymentId: firstPayment.id,
                    userId,
                });
                await updatePaymentWithGatewayResult(firstPayment.id, result);

                if (result.clientSecret) clientSecret = result.clientSecret;
                if (result.pixString) pixString = result.pixString;
            } catch (err) {
                // Gateway failed (e.g. invalid CPF, Cora down). Do NOT return a misleading
                // 201 — the payment would linger as PENDING with no QR/secret to pay it.
                // Delete the orphan pre-contract payment and surface a clear error.
                console.error(`[Contract:Self] Failed to create gateway payment:`, err);
                await prisma.payment.delete({ where: { id: firstPayment.id } }).catch(() => {});
                const msg = err instanceof Error ? err.message : 'Erro ao gerar o pagamento. Tente novamente ou use outro método.';
                res.status(502).json({ error: msg });
                return;
            }
        }

        const duration = data.durationMonths;
        console.log(`CONTRACT PAYMENT ${firstPayment.id} created for user ${userId}, amount: ${firstAmount}, plan: ${data.paymentPlan}, method: ${data.paymentMethod}`);

        res.status(201).json({
            message: data.paymentPlan === 'FULL'
                ? `Pagamento integral gerado. Efetue o pagamento para ativar seu contrato.`
                : `Pagamento da 1ª parcela gerado. Efetue o pagamento para ativar seu contrato.`,
            firstPaymentId: firstPayment.id,
            amount: firstAmount,
            duration,
            ...(clientSecret && { clientSecret }),
            ...(pixString && { firstPixString: pixString }),
        });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        console.error('Erro ao criar pagamento do contrato (Cliente):', err);
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
                paymentPlan: data.paymentPlan ?? 'MONTHLY',
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

        // Centralized: same plan rules as FIXO/FLEX — FULL → single à-vista invoice (PIX
        // discounted); MONTHLY → durationMonths charges of the plain cycle amount (no card
        // surcharge) on a 28-day cadence.
        const customIsFull = data.paymentPlan === 'FULL';
        const customPlan = await resolvePlanAmounts({
            baseMonthly: cycleAmount,
            durationMonths: data.durationMonths,
            plan: (data.paymentPlan || 'MONTHLY') as 'MONTHLY' | 'FULL',
            paymentMethod: data.paymentMethod,
            startDate,
        });
        const customProvider = getProviderForMethod(data.paymentMethod);
        const payments: any[] = customPlan.scheduleDueDates.map((dueDate) => ({
            userId,
            contractId: contract.id,
            provider: customProvider,
            amount: customIsFull ? customPlan.fullAmount : customPlan.monthlyAmount,
            status: 'PENDING' as const,
            dueDate,
        }));

        if (payments.length > 0) {
            await prisma.payment.createMany({ data: payments });
        }

        // Enrich payments with gateway (Cora/Stripe) data
        const userInfo = await prisma.user.findUnique({ where: { id: userId }, select: { name: true, email: true, cpfCnpj: true } });
        const userCpf = userInfo?.cpfCnpj?.replace(/\D/g, '') || undefined;
        const allPayments = await prisma.payment.findMany({
            where: { contractId: contract.id },
            orderBy: { dueDate: 'asc' },
        });

        let firstClientSecret: string | null = null;
        let firstPaymentId: string | null = allPayments.length > 0 ? (allPayments[0]?.id ?? null) : null;
        let firstPixString: string | null = null;

        // CARTÃO: do NOT pre-create PaymentIntents here — the inline checkout creates the first
        // one with the chosen installments (matching idempotency key + juros policy), and the
        // remaining installments are charged later (Meus Pagamentos / auto-charge). Pre-creating
        // would collide with that call. PIX/BOLETO still generate their QR/boleto up-front.
        let isFirst = true;
        for (const p of (data.paymentMethod === 'CARTAO' ? [] : allPayments)) {
            try {
                const result = await gatewayCreatePayment({
                    paymentMethod: data.paymentMethod as 'PIX' | 'BOLETO' | 'CARTAO',
                    amount: p.amount,
                    description: `${data.name} - Parcela`,
                    customer: { name: userInfo?.name || 'Cliente', email: userInfo?.email || '', cpf: userCpf },
                    dueDate: p.dueDate || new Date(),
                    paymentId: p.id,
                    contractId: contract.id,
                    userId,
                });
                await updatePaymentWithGatewayResult(p.id, result);

                if (isFirst) {
                    firstPaymentId = p.id;
                    if (result.pixString) firstPixString = result.pixString;
                }
                if (!firstClientSecret && result.clientSecret) {
                    firstClientSecret = result.clientSecret;
                }
            } catch (err) {
                console.error(`[Gateway] Failed to create payment for ${p.id}:`, err);
                if (isFirst) {
                    // The first installment is what the client pays NOW. If its gateway
                    // dispatch fails we must NOT leave a phantom ACTIVE contract with
                    // reserved slots and an unpayable payment while reporting success.
                    // Roll back contract + bookings + payments (FK-safe) and return 502.
                    await prisma.payment.deleteMany({ where: { contractId: contract.id } }).catch(() => {});
                    await prisma.booking.deleteMany({ where: { contractId: contract.id } }).catch(() => {});
                    await prisma.contract.delete({ where: { id: contract.id } }).catch(() => {});
                    const msg = err instanceof Error ? err.message : 'Erro ao gerar o pagamento. Tente novamente ou use outro método.';
                    res.status(502).json({ error: msg });
                    return;
                }
                // months 2..N: best-effort — they are regenerated when paid via Meus Pagamentos.
            }
            isFirst = false;
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
            ...(firstPaymentId && { firstPaymentId }),
            ...(firstPixString && { firstPixString }),
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

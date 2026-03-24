import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { authenticate, authorize } from '../../middleware/auth';
import { ContractType, Tier, ContractStatus, BookingStatus, PaymentMethod } from '@prisma/client';
import { getBasePrice, getBasePriceDynamic, applyDiscount, calculateEndTime } from '../../utils/pricing';

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

        // Calculate discount
        const discountPct = data.durationMonths === 3 ? 30 : 40;

        // Calculate dates
        const startDate = new Date(data.startDate + 'T00:00:00');
        const endDate = new Date(startDate);
        endDate.setMonth(endDate.getMonth() + data.durationMonths);

        // Episode-based credits: 3 months = 12 episodes, 6 months = 24 episodes
        const totalEpisodes = data.durationMonths === 3 ? 12 : 24;

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
            const totalWeeks = data.durationMonths * 4;
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
        // Each month = 4 sessions → total sessions = durationMonths * 4
        // Payment per month = 4 sessions * discountedPrice
        const monthlyAmount = 4 * discountedPrice;
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

        // Validate first booking date is within 15 days
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const firstDate = new Date(data.firstBookingDate + 'T00:00:00');
        const diffDays = Math.ceil((firstDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
        if (diffDays < 1 || diffDays > 15) {
            res.status(400).json({ error: 'A primeira gravação deve ser agendada para os próximos 1 a 15 dias.' });
            return;
        }

        // Validate Fixo requires day and time
        if (data.type === 'FIXO' && (!data.fixedDayOfWeek || !data.fixedTime)) {
            // Infer from first booking
            const dayOfWeek = firstDate.getDay() === 0 ? 7 : firstDate.getDay(); // 1=Mon..6=Sat
            data.fixedDayOfWeek = dayOfWeek;
            data.fixedTime = data.firstBookingTime;
        }

        const discountPct = data.durationMonths === 3 ? 30 : 40;

        // Contract starts on the first booking date
        const startDate = firstDate;
        const endDate = new Date(startDate);
        endDate.setMonth(endDate.getMonth() + data.durationMonths);

        const totalEpisodes = data.durationMonths === 3 ? 12 : 24;

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

            const totalWeeks = data.durationMonths * 4;
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
        const monthlyAmount = (4 * discountedPrice) + addonsCost;
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

        const totalWeeks = data.durationMonths * 4;
        const expectedDates: { date: Date, time: string }[] = [];

        let current = new Date(start);
        for (let i = 0; i < totalWeeks; i++) {
            expectedDates.push({ date: new Date(current), time: data.fixedTime });
            current.setDate(current.getDate() + 7);
        }

        const conflicts: { date: string, originalTime: string, suggestedReplacement?: { date: string, time: string } }[] = [];
        const POSSIBLE_SLOTS = ['10:00', '13:00', '15:30', '18:00', '20:30'];

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
                    if (dayOfWeek >= 1 && dayOfWeek <= 5 && data.tier === 'COMERCIAL' && !['10:00', '13:00', '15:30'].includes(slot)) continue;
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
                    clientNotes: true, adminNotes: true, platforms: true, platformLinks: true,
                },
                orderBy: { date: 'asc' },
                where: { status: { not: 'CANCELLED' } },
            },
            payments: {
                select: { id: true, amount: true, status: true, dueDate: true },
                orderBy: { dueDate: 'asc' },
            },
        },
    });

    // Enrich with completed bookings count
    const enriched = contracts.map(c => {
        const completedBookings = c.bookings.filter(b =>
            b.status === 'COMPLETED' || b.status === 'CONFIRMED' || b.status === 'FALTA'
        ).length;
        const totalBookings = c.type === 'FIXO'
            ? c.durationMonths * 4
            : (c.flexCreditsTotal || 0);
        const result = {
            ...c,
            completedBookings,
            totalBookings,
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
        const discountPct = duration === 6 ? 40 : (duration === 3 ? 30 : 0);

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
            paymentAmount = Math.round(paymentAmount * 0.9);
        } else if (data.paymentMethod === 'CARTAO') {
            if (duration === 3) paymentAmount = Math.round(paymentAmount * 1.15);
            else if (duration === 6) paymentAmount = Math.round(paymentAmount * 1.20);
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

        // Normally we'd integrate Cora/Stripe here.
        // Returning a generic checkout flow reference for now.
        const checkoutUrl = `/checkout/payment-method?paymentId=${payment.id}`;

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

export default router;



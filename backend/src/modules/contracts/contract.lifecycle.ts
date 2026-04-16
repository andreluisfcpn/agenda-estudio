import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { authenticate, authorize } from '../../middleware/auth';
import { BookingStatus } from '../../generated/prisma/client';
import { getBasePriceDynamic, applyDiscount, calculateEndTime } from '../../utils/pricing';
import { getConfig } from '../../lib/businessConfig';
import { getProviderForMethod } from '../../lib/paymentGateway';
import { updateContractSchema, resolveCancellationSchema } from './validators';

export function registerLifecycleRoutes(router: Router) {

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
            // Calculate and create actual payment record for the cancellation fine
            const finePct = await getConfig('cancellation_fine_pct');
            const totalPaid = await prisma.payment.aggregate({
                where: { contractId: id, status: 'PAID' },
                _sum: { amount: true },
            });
            const fineAmount = Math.round((totalPaid._sum.amount || 0) * finePct / 100);

            if (fineAmount > 0) {
                const finePayment = await prisma.payment.create({
                    data: {
                        userId: contract.userId,
                        contractId: id,
                        provider: getProviderForMethod(contract.paymentMethod || 'CARTAO'),
                        amount: fineAmount,
                        status: 'PENDING',
                        dueDate: new Date(),
                    },
                });
                message = `Quebra de contrato aplicada. Multa de ${finePct}% (R$ ${(fineAmount / 100).toFixed(2).replace('.', ',')}) gerada com sucesso. ID do pagamento: ${finePayment.id}. Contrato cancelado.`;
            } else {
                message = 'Contrato cancelado. Nenhuma multa aplicada (sem pagamentos anteriores).';
            }
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
                    status: 'CONFIRMED' as BookingStatus,
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

} // end registerLifecycleRoutes

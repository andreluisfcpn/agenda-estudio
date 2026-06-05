import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { authenticate, authorize } from '../../middleware/auth.js';
import { releaseMultiSlotLock } from '../../lib/redis.js';
import { getProviderForMethod } from '../../lib/paymentGateway.js';
import {
    getSlotTier,
    getBasePriceDynamic,
    applyDiscount,
    getPackageSlots,
    calculateEndTime,
    isOperatingDay,
    studioDateTime,
} from '../../utils/pricing.js';
import { BookingStatus, Prisma } from '../../generated/prisma/client.js';
import { getConfig } from '../../lib/businessConfig.js';
import {
    adminUpdateBookingSchema,
    clientUpdateBookingSchema,
    rescheduleSchema,
    addOnPurchaseSchema,
} from './validators.js';
import { restoreCredit, deductCredit } from './booking.service.js';

export function registerManagementRoutes(router: Router) {

// ─── DELETE /api/bookings/:id ───────────────────────────

router.delete('/:id', authenticate, async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const userId = req.user!.userId;
    const isAdmin = req.user!.role === 'ADMIN';

    const booking = await prisma.booking.findFirst({
        where: {
            id,
            ...(isAdmin ? {} : { userId }),
            status: { not: BookingStatus.CANCELLED },
        },
    });

    if (!booking) {
        res.status(404).json({ error: 'Reserva não encontrada.' });
        return;
    }

    await prisma.booking.update({
        where: { id },
        data: { status: BookingStatus.CANCELLED },
    });

    // Release Redis locks if the booking was RESERVED
    if (booking.status === BookingStatus.RESERVED) {
        const dateStr = booking.date.toISOString().split('T')[0];
        const packageSlots = getPackageSlots(booking.startTime);
        await releaseMultiSlotLock(dateStr, packageSlots, booking.userId);
    }

    // If Flex/Custom contract, restore credit
    if (booking.contractId) {
        await restoreCredit(booking.contractId);
    }

    res.json({ message: 'Reserva cancelada com sucesso.' });
});

// ─── DELETE /api/bookings/:id/hard-delete (ADMIN - permanent removal) ─────

router.delete('/:id/hard-delete', authenticate, authorize('ADMIN'), async (req: Request, res: Response) => {
    try {
        const id = req.params.id as string;

        const booking = await prisma.booking.findUnique({
            where: { id },
            include: { contract: true },
        });

        if (!booking) {
            res.status(404).json({ error: 'Agendamento não encontrado.' });
            return;
        }

        // Release Redis locks if applicable
        if (booking.status === BookingStatus.RESERVED) {
            const dateStr = booking.date.toISOString().split('T')[0];
            const packageSlots = getPackageSlots(booking.startTime);
            await releaseMultiSlotLock(dateStr, packageSlots, booking.userId);
        }

        // Restore credits if from FLEX or CUSTOM contract (and booking was NOT already cancelled)
        let creditRestored = false;
        if (booking.contractId && booking.status !== BookingStatus.CANCELLED) {
            creditRestored = await restoreCredit(booking.contractId);
        }

        // Hard delete from database
        await prisma.booking.delete({ where: { id } });

        res.json({
            message: creditRestored
                ? 'Agendamento removido permanentemente. Crédito devolvido ao contrato.'
                : 'Agendamento removido permanentemente.',
            creditRestored,
        });
    } catch (err) {
        console.error('Hard delete booking error:', err);
        res.status(500).json({ error: 'Erro ao remover agendamento.' });
    }
});

// ─── GET /api/bookings/my ───────────────────────────────

router.get('/my', authenticate, async (req: Request, res: Response) => {
    // Auto-complete removed: only admin can change booking status to COMPLETED

    const bookings = await prisma.booking.findMany({
        where: {
            userId: req.user!.userId,
            status: { not: BookingStatus.CANCELLED },
        },
        orderBy: [{ date: 'desc' }, { startTime: 'asc' }],
        select: {
            id: true,
            date: true,
            startTime: true,
            endTime: true,
            status: true,
            tierApplied: true,
            price: true,
            contractId: true,
            adminNotes: true,
            clientNotes: true,
            platforms: true,
            platformLinks: true,
            durationMinutes: true,
            peakViewers: true,
            chatMessages: true,
            audienceOrigin: true,
            addOns: true,
            contract: {
                select: {
                    id: true,
                    name: true,
                    type: true,
                    tier: true
                }
            }
        },
    });

    res.json({ bookings });
});

// ─── GET /api/bookings (ADMIN) ──────────────────────────

router.get('/', authenticate, authorize('ADMIN'), async (req: Request, res: Response) => {
    const { date, status } = req.query;

    const where: Prisma.BookingWhereInput = {};

    if (status && typeof status === 'string') {
        where.status = status as BookingStatus;
    } else {
        where.status = { not: BookingStatus.CANCELLED };
    }

    if (date && typeof date === 'string') {
        where.date = new Date(date + 'T00:00:00');
    }

    const bookings = await prisma.booking.findMany({
        where,
        orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
        include: {
            user: {
                select: { id: true, name: true, email: true, role: true },
            },
            contract: {
                select: { id: true, name: true, type: true, tier: true },
            },
        },
    });

    res.json({ bookings });
});

// ─── PATCH /api/bookings/:id (ADMIN update) ─────────────

router.patch('/:id', authenticate, authorize('ADMIN'), async (req: Request, res: Response) => {
    try {
        const id = req.params.id as string;
        const data = adminUpdateBookingSchema.parse(req.body);

        const booking = await prisma.booking.findUnique({ where: { id } });
        if (!booking) {
            res.status(404).json({ error: 'Agendamento não encontrado.' });
            return;
        }

        const updateData: Prisma.BookingUncheckedUpdateInput = {};

        if (data.status) {
            updateData.status = data.status;

            // NAO_REALIZADO: restore credit to contract (handles FLEX, CUSTOM, AVULSO)
            if (data.status === 'NAO_REALIZADO' && booking.contractId && booking.status !== 'NAO_REALIZADO') {
                await restoreCredit(booking.contractId);
            }

            // If changing FROM NAO_REALIZADO back to something that consumes credit, re-deduct
            // Re-deduct credit when reverting from NAO_REALIZADO (handles FLEX, CUSTOM, AVULSO)
            if (booking.status === 'NAO_REALIZADO' && data.status !== 'NAO_REALIZADO' && data.status !== 'CANCELLED' && booking.contractId) {
                await deductCredit(booking.contractId);
            }
        }

        if (data.adminNotes !== undefined) updateData.adminNotes = data.adminNotes;
        if (data.clientNotes !== undefined) updateData.clientNotes = data.clientNotes;
        if (data.platforms !== undefined) updateData.platforms = data.platforms;
        if (data.platformLinks !== undefined) updateData.platformLinks = data.platformLinks;

        // Phase 2 Metrics Logic
        const hasMetricsPayload = data.durationMinutes !== undefined || data.peakViewers !== undefined || data.chatMessages !== undefined || data.audienceOrigin !== undefined;
        const targetStatus = data.status || booking.status;

        if (hasMetricsPayload) {
            if (targetStatus !== 'COMPLETED') {
                res.status(400).json({ error: 'Métricas de evento só podem ser editadas quando a gravação estiver como REALIZADA (COMPLETED).' });
                return;
            }
            if (data.durationMinutes !== undefined) updateData.durationMinutes = data.durationMinutes;
            if (data.peakViewers !== undefined) updateData.peakViewers = data.peakViewers;
            if (data.chatMessages !== undefined) updateData.chatMessages = data.chatMessages;
            if (data.audienceOrigin !== undefined) updateData.audienceOrigin = data.audienceOrigin;
        }

        if (data.date) {
            updateData.date = new Date(data.date + 'T00:00:00');
        }

        if (data.startTime) {
            const newDate = data.date ? new Date(data.date + 'T00:00:00') : booking.date;
            const dayOfWeek = newDate.getUTCDay();
            const slotTier = await getSlotTier(dayOfWeek, data.startTime);
            if (!slotTier) {
                res.status(400).json({ error: 'Horário fora da grade de operação.' });
                return;
            }
            updateData.startTime = data.startTime;
            updateData.endTime = calculateEndTime(data.startTime);
            updateData.tierApplied = slotTier;
            updateData.price = await getBasePriceDynamic(slotTier);
        }

        const updated = await prisma.booking.update({
            where: { id },
            data: updateData,
            include: {
                user: { select: { id: true, name: true, email: true, role: true } },
            },
        });

        res.json({
            booking: updated,
            message: 'Agendamento atualizado com sucesso.',
        });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        throw err;
    }
});

// ─── PATCH /api/bookings/:id/client-update (Client) ─────

router.patch('/:id/client-update', authenticate, async (req: Request, res: Response) => {
    try {
        const id = req.params.id as string;
        const data = clientUpdateBookingSchema.parse(req.body);

        const booking = await prisma.booking.findFirst({
            where: { id, userId: req.user!.userId },
        });

        if (!booking) {
            res.status(404).json({ error: 'Agendamento não encontrado.' });
            return;
        }

        const updateData: Prisma.BookingUncheckedUpdateInput = {};
        if (data.clientNotes !== undefined) updateData.clientNotes = data.clientNotes;
        if (data.platforms !== undefined) updateData.platforms = data.platforms;
        if (data.platformLinks !== undefined) updateData.platformLinks = data.platformLinks;

        // Phase 2 Metrics Logic
        const hasMetricsPayload = data.durationMinutes !== undefined || data.peakViewers !== undefined || data.chatMessages !== undefined || data.audienceOrigin !== undefined;

        if (hasMetricsPayload) {
            if (booking.status !== 'COMPLETED') {
                res.status(400).json({ error: 'Métricas de evento só podem ser editadas quando a gravação estiver como REALIZADA.' });
                return;
            }
            if (data.durationMinutes !== undefined) updateData.durationMinutes = data.durationMinutes;
            if (data.peakViewers !== undefined) updateData.peakViewers = data.peakViewers;
            if (data.chatMessages !== undefined) updateData.chatMessages = data.chatMessages;
            if (data.audienceOrigin !== undefined) updateData.audienceOrigin = data.audienceOrigin;
        }

        const updated = await prisma.booking.update({
            where: { id },
            data: updateData,
            select: {
                id: true, date: true, startTime: true, endTime: true,
                status: true, tierApplied: true, price: true, contractId: true,
                adminNotes: true, clientNotes: true, platforms: true, platformLinks: true,
                durationMinutes: true, peakViewers: true, chatMessages: true, audienceOrigin: true,
            },
        });

        res.json({ booking: updated, message: 'Gravação atualizada com sucesso.' });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        throw err;
    }
});

// ─── PATCH /api/bookings/:id/reschedule (Client) ────────

router.patch('/:id/reschedule', authenticate, async (req: Request, res: Response) => {
    try {
        const id = req.params.id as string;
        const data = rescheduleSchema.parse(req.body);

        const booking = await prisma.booking.findFirst({
            where: { id, userId: req.user!.userId, status: { in: [BookingStatus.RESERVED, BookingStatus.CONFIRMED] } },
        });

        if (!booking) {
            res.status(404).json({ error: 'Agendamento não encontrado ou não pode ser reagendado.' });
            return;
        }

        // Rule 1: Must be at least configured hours before the original booking
        // (studio timezone, consistent with the 24h cancellation check)
        const originalDateTime = studioDateTime(booking.date.toISOString().split('T')[0], booking.startTime);
        const now = new Date();
        const rescheduleMinHours = await getConfig('reschedule_min_hours');
        const hoursUntilOriginal = (originalDateTime.getTime() - now.getTime()) / (1000 * 60 * 60);

        if (hoursUntilOriginal < rescheduleMinHours) {
            res.status(400).json({ error: `O reagendamento deve ser feito com pelo menos ${rescheduleMinHours} horas de antecedência.` });
            return;
        }

        // Rule 2: New date must be within configured days from the ORIGINAL booking date (anchor)
        const rescheduleMaxDays = await getConfig('reschedule_max_days');
        const anchorDate = booking.originalDate || booking.date;
        const anchorMs = new Date(anchorDate).setUTCHours(0, 0, 0, 0);
        const newDate = new Date(data.date + 'T00:00:00');
        const newDateMs = newDate.setUTCHours(0, 0, 0, 0);
        const daysFromAnchor = (newDateMs - anchorMs) / (1000 * 60 * 60 * 24);

        if (daysFromAnchor > rescheduleMaxDays || daysFromAnchor < 0) {
            const anchorStr = new Date(anchorDate).toLocaleDateString('pt-BR', { timeZone: 'UTC' });
            res.status(400).json({ error: `A nova data deve estar dentro de ${rescheduleMaxDays} dias da data original (${anchorStr}).` });
            return;
        }

        // Rule 3: Operating day check
        const dayOfWeek = newDate.getUTCDay();
        if (!(await isOperatingDay(dayOfWeek))) {
            res.status(400).json({ error: 'O estúdio não funciona neste dia da semana.' });
            return;
        }

        // Rule 4: Tier must match original
        const newTier = await getSlotTier(dayOfWeek, data.startTime);
        if (!newTier) {
            res.status(400).json({ error: 'Horário fora da grade de operação.' });
            return;
        }

        if (newTier !== booking.tierApplied) {
            res.status(400).json({ error: `O reagendamento deve manter a mesma faixa (${booking.tierApplied}). O horário selecionado é ${newTier}.` });
            return;
        }

        // Rule 5: Check availability
        const packageSlots = getPackageSlots(data.startTime);
        const conflicting = await prisma.booking.findFirst({
            where: {
                id: { not: id },
                date: newDate,
                status: { not: BookingStatus.CANCELLED },
                OR: packageSlots.map(slot => ({
                    startTime: { lte: slot },
                    endTime: { gt: slot },
                })),
            },
        });

        if (conflicting) {
            res.status(409).json({ error: 'O horário selecionado já está ocupado.' });
            return;
        }

        const endTime = calculateEndTime(data.startTime);

        // Set originalDate if not already set (anchor for future reschedules)
        const updateData: Prisma.BookingUncheckedUpdateInput = {
            date: new Date(data.date + 'T00:00:00'),
            startTime: data.startTime,
            endTime,
        };
        if (!booking.originalDate) {
            updateData.originalDate = booking.date; // store the initial date as anchor
        }

        const updated = await prisma.booking.update({
            where: { id },
            data: updateData,
            select: {
                id: true, date: true, startTime: true, endTime: true,
                status: true, tierApplied: true, price: true, contractId: true,
            },
        });

        res.json({ booking: updated, message: 'Agendamento reagendado com sucesso!' });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        throw err;
    }
});

// ─── POST /api/bookings/cleanup-orphan-addons (Admin) ────
// Remove addons from bookings that were added before payment was confirmed (legacy bug)
router.post('/cleanup-orphan-addons', authenticate, authorize('ADMIN'), async (_req: Request, res: Response) => {
    try {
        // Find all bookings with addons
        const bookingsWithAddons = await prisma.booking.findMany({
            where: { addOns: { isEmpty: false } },
            include: { contract: true },
        });

        let cleaned = 0;
        let paymentsDeleted = 0;

        for (const booking of bookingsWithAddons) {
            const contractAddons = booking.contract?.addOns || [];

            // Avulso addons = addons on booking that are NOT in the contract
            const avulsoAddons = booking.addOns.filter(a => !contractAddons.includes(a));
            if (avulsoAddons.length === 0) continue;

            // Check which avulso addons have a PAID payment
            const paidPayments = await prisma.payment.findMany({
                where: { bookingId: booking.id, status: 'PAID', paymentUrl: { not: null } },
            });

            const paidAddonKeys = new Set<string>();
            for (const p of paidPayments) {
                try {
                    const meta = JSON.parse(p.paymentUrl!);
                    const keys: string[] = meta.addonKeys || (meta.addonKey ? [meta.addonKey] : []);
                    keys.forEach(k => paidAddonKeys.add(k));
                } catch {}
            }

            // Remove unpaid avulso addons from booking
            const unpaidAddons = avulsoAddons.filter(a => !paidAddonKeys.has(a));
            if (unpaidAddons.length > 0) {
                const cleanedAddons = booking.addOns.filter(a => !unpaidAddons.includes(a));
                await prisma.booking.update({
                    where: { id: booking.id },
                    data: { addOns: cleanedAddons },
                });
                cleaned++;
                console.log(`[Cleanup] Removed orphan addons ${unpaidAddons.join(', ')} from booking ${booking.id}`);
            }
        }

        // Also delete orphan PENDING addon payments — but only ones older than 1h so we
        // never remove an in-flight payment the user is still completing.
        const orphanCutoff = new Date(Date.now() - 60 * 60 * 1000);
        const orphanPayments = await prisma.payment.findMany({
            where: { status: 'PENDING', paymentUrl: { not: null }, createdAt: { lt: orphanCutoff } },
        });

        for (const p of orphanPayments) {
            try {
                const meta = JSON.parse(p.paymentUrl!);
                if (meta.addonKey || meta.addonKeys) {
                    await prisma.payment.delete({ where: { id: p.id } });
                    paymentsDeleted++;
                }
            } catch {}
        }

        res.json({
            message: `Limpeza concluída: ${cleaned} booking(s) corrigido(s), ${paymentsDeleted} pagamento(s) órfão(s) removido(s).`,
            bookingsCleaned: cleaned,
            paymentsDeleted,
        });
    } catch (err) {
        console.error('[Cleanup] Error:', err);
        res.status(500).json({ error: 'Erro na limpeza.' });
    }
});

// ─── POST /api/bookings/:id/addons (Purchase Addon) ─────

router.post('/:id/addons', authenticate, async (req: Request, res: Response) => {
    try {
        const id = req.params.id as string;
        const data = addOnPurchaseSchema.parse(req.body);
        const userId = req.user!.userId;

        // Normalize: accept single addonKey or array of addonKeys
        const keys: string[] = data.addonKeys || (data.addonKey ? [data.addonKey] : []);

        const booking = await prisma.booking.findFirst({
            where: { id, userId, status: { in: ['RESERVED', 'CONFIRMED'] } },
            include: { contract: true }
        });

        if (!booking) {
            res.status(404).json({ error: 'Agendamento não encontrado ou não disponível para edição.' });
            return;
        }

        // Filter out already-active addons
        const newKeys = keys.filter(k => !booking.addOns.includes(k));
        if (newKeys.length === 0) {
            res.status(400).json({ error: 'Todos os serviços selecionados já estão ativos neste episódio.' });
            return;
        }

        // Validate all addon keys exist
        const addonConfigs = await prisma.addOnConfig.findMany({
            where: { key: { in: newKeys } }
        });
        if (addonConfigs.length !== newKeys.length) {
            const found = addonConfigs.map(a => a.key);
            const missing = newKeys.filter(k => !found.includes(k));
            res.status(404).json({ error: `Serviço(s) não encontrado(s): ${missing.join(', ')}` });
            return;
        }

        // Split: contract addons (free) vs paid addons
        const contractKeys = newKeys.filter(k => booking.contract?.addOns?.includes(k));
        const paidKeys = newKeys.filter(k => !booking.contract?.addOns?.includes(k));

        // Activate contract addons immediately (no payment needed)
        if (contractKeys.length > 0) {
            await prisma.booking.update({
                where: { id },
                data: { addOns: { push: contractKeys } }
            });
        }

        // For paid addons: create ONE combined payment
        if (paidKeys.length > 0) {
            let totalPrice = 0;
            for (const key of paidKeys) {
                const config = addonConfigs.find(a => a.key === key)!;
                let price = config.price;
                if (booking.contract) {
                    price = applyDiscount(price, booking.contract.discountPct);
                }
                totalPrice += price;
            }

            const payment = await prisma.payment.create({
                data: {
                    userId,
                    contractId: booking.contract?.id || null,
                    bookingId: id,
                    provider: getProviderForMethod('CARTAO'),
                    amount: totalPrice,
                    status: 'PENDING',
                    dueDate: new Date(),
                    // Store ALL addon keys in metadata for post-payment activation
                    paymentUrl: JSON.stringify({ addonKeys: paidKeys }),
                }
            });

            res.status(200).json({
                message: contractKeys.length > 0
                    ? `${contractKeys.length} serviço(s) do plano ativado(s). Cobrança gerada para ${paidKeys.length} serviço(s) avulso(s).`
                    : 'Cobrança gerada. O serviço será ativado após a confirmação do pagamento.',
                paymentId: payment.id,
                amount: totalPrice,
                activatedKeys: contractKeys,
                pendingKeys: paidKeys,
            });
            return;
        }

        // All were contract addons (no payment needed)
        res.status(200).json({
            message: 'Serviço(s) incluso(s) no plano ativado(s) com sucesso.',
            paymentId: '',
            amount: 0,
            activatedKeys: contractKeys,
            pendingKeys: [],
        });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        res.status(500).json({ error: 'Erro interno ao processar compra do serviço.' });
    }
});

} // end registerManagementRoutes

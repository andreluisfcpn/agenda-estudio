import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { authenticate, authorize } from '../../middleware/auth';
import { acquireMultiSlotLock, releaseMultiSlotLock } from '../../lib/redis';
import {
    getSlotTier,
    getBasePrice,
    getBasePriceDynamic,
    applyDiscount,
    canAccessTier,
    generateTimeSlots,
    getPackageSlots,
    calculateEndTime,
    fitsInOperatingHours,
} from '../../utils/pricing';
import { BookingStatus, Tier } from '@prisma/client';

const router = Router();

// ─── Validation Schemas ─────────────────────────────────

const availabilitySchema = z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato de data inválido (YYYY-MM-DD)'),
});

const createBookingSchema = z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato de data inválido'),
    startTime: z.string().regex(/^\d{2}:\d{2}$/, 'Formato de hora inválido (HH:MM)').refine(val => generateTimeSlots().includes(val), 'Horário deve ser um dos blocos oficiais (10:00, 13:00, 15:30, 18:00, 20:30).'),
    contractId: z.string().uuid().optional(),
    addOns: z.array(z.string()).optional(),
});

const bulkBookingSchema = z.object({
    contractId: z.string().uuid(),
    slots: z.array(z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato de data inválido'),
        startTime: z.string().regex(/^\d{2}:\d{2}$/, 'Formato de hora inválido (HH:MM)').refine(val => generateTimeSlots().includes(val), 'Horário deve ser um dos blocos oficiais.'),
    })).min(1, 'Pelo menos um horário deve ser selecionado').max(24, 'Máximo de 24 marcações por vez'),
});

// ─── GET /api/bookings/public-availability ───────────────
// Public endpoint (no auth) — returns week of slot availability for the landing page

const publicAvailabilitySchema = z.object({
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato de data inválido (YYYY-MM-DD)'),
    days: z.coerce.number().int().min(1).max(14).default(7),
});

router.get('/public-availability', async (req: Request, res: Response) => {
    try {
        const { startDate, days } = publicAvailabilitySchema.parse(req.query);
        const result: { date: string; dayOfWeek: number; closed: boolean; slots: { time: string; available: boolean; tier: string | null }[] }[] = [];

        for (let i = 0; i < days; i++) {
            const dateObj = new Date(startDate + 'T00:00:00');
            dateObj.setUTCDate(dateObj.getUTCDate() + i);
            const dateStr = dateObj.toISOString().split('T')[0];
            const dayOfWeek = dateObj.getUTCDay();

            if (dayOfWeek === 0) {
                result.push({ date: dateStr, dayOfWeek, closed: true, slots: [] });
                continue;
            }

            const bookings = await prisma.booking.findMany({
                where: { date: dateObj, status: { not: BookingStatus.CANCELLED } },
                select: { startTime: true, endTime: true },
            });

            const blockedSlots = await prisma.blockedSlot.findMany({
                where: { date: dateObj },
                select: { startTime: true, endTime: true },
            });

            const occupiedSlots = new Set<string>();
            for (const b of bookings) {
                const slots = getPackageSlots(b.startTime, 2);
                slots.forEach(s => occupiedSlots.add(s));
            }
            for (const b of blockedSlots) {
                const [bStartH, bStartM] = b.startTime.split(':').map(Number);
                const [bEndH, bEndM] = b.endTime.split(':').map(Number);
                let m = bStartH * 60 + bStartM;
                const end = bEndH * 60 + bEndM;
                while (m < end) {
                    const h = Math.floor(m / 60);
                    const min = m % 60;
                    occupiedSlots.add(`${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`);
                    m += 30;
                }
            }

            const allSlots = generateTimeSlots();
            const availability = allSlots.map(slot => {
                const tier = getSlotTier(dayOfWeek, slot);
                const packageSlots = getPackageSlots(slot, 2);
                const isBlocked = packageSlots.some(s => occupiedSlots.has(s));
                return { time: slot, available: !isBlocked && tier !== null, tier };
            });

            result.push({ date: dateStr, dayOfWeek, closed: false, slots: availability });
        }

        res.json({ days: result });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Parâmetros inválidos.', details: err.errors });
            return;
        }
        throw err;
    }
});

// ─── GET /api/bookings/availability?date=YYYY-MM-DD ─────

router.get('/availability', authenticate, async (req: Request, res: Response) => {
    try {
        const { date } = availabilitySchema.parse(req.query);
        const dateObj = new Date(date + 'T00:00:00');
        const dayOfWeek = dateObj.getUTCDay(); // 0=Sun, 6=Sat

        // Sunday = closed
        if (dayOfWeek === 0) {
            res.json({ date, closed: true, slots: [] });
            return;
        }

        // Get all bookings for this date
        const bookings = await prisma.booking.findMany({
            where: {
                date: dateObj,
                status: { not: BookingStatus.CANCELLED },
            },
            select: {
                startTime: true,
                endTime: true,
                status: true,
                userId: true,
            },
        });

        // Get blocked slots for this date
        const blockedSlots = await prisma.blockedSlot.findMany({
            where: { date: dateObj },
            select: { startTime: true, endTime: true },
        });

        // Build occupied set
        const occupiedSlots = new Set<string>();
        for (const b of bookings) {
            const slots = getPackageSlots(b.startTime, 2);
            slots.forEach(s => occupiedSlots.add(s));
        }
        for (const b of blockedSlots) {
            const [bStartH, bStartM] = b.startTime.split(':').map(Number);
            const [bEndH, bEndM] = b.endTime.split(':').map(Number);
            let m = bStartH * 60 + bStartM;
            const end = bEndH * 60 + bEndM;
            while (m < end) {
                const h = Math.floor(m / 60);
                const min = m % 60;
                occupiedSlots.add(`${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`);
                m += 30;
            }
        }

        // Generate all slots for the day
        const allSlots = generateTimeSlots();
        const availability = await Promise.all(allSlots.map(async slot => {
            const tier = getSlotTier(dayOfWeek, slot);
            const packageSlots = getPackageSlots(slot, 2);
            const isBlocked = packageSlots.some(s => occupiedSlots.has(s));
            const available = !isBlocked && tier !== null;
            return {
                time: slot,
                available,
                tier,
                price: tier ? await getBasePriceDynamic(tier) : null,
            };
        }));

        // Get client's own bookings for this date
        const myBookings = req.user ? await prisma.booking.findMany({
            where: {
                date: dateObj,
                userId: req.user.userId,
                status: { notIn: [BookingStatus.CANCELLED] },
            },
            select: {
                id: true, startTime: true, endTime: true, status: true,
                tierApplied: true, price: true, contractId: true,
                adminNotes: true, clientNotes: true, platforms: true, platformLinks: true,
            },
        }) : [];

        res.json({ date, dayOfWeek, closed: false, slots: availability, myBookings });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Parâmetros inválidos.', details: err.errors });
            return;
        }
        throw err;
    }
});

// ─── POST /api/bookings ─────────────────────────────────

router.post('/', authenticate, async (req: Request, res: Response) => {
    try {
        const data = createBookingSchema.parse(req.body);
        const userId = req.user!.userId;

        const dateObj = new Date(data.date + 'T00:00:00');
        const dayOfWeek = dateObj.getUTCDay();

        // Validate: Past Time Booking Check
        const slotDateTime = new Date(`${data.date}T${data.startTime}:00`);
        const diffMinutes = (slotDateTime.getTime() - Date.now()) / (1000 * 60);
        if (diffMinutes < 30) {
            res.status(400).json({ error: 'Não é possível agendar um horário no passado ou com menos de 30 minutos de antecedência.' });
            return;
        }

        // Validate: not Sunday
        if (dayOfWeek === 0) {
            res.status(400).json({ error: 'O estúdio não funciona aos domingos.' });
            return;
        }

        // Validate: fits in operating hours (2h package)
        if (!fitsInOperatingHours(data.startTime)) {
            res.status(400).json({ error: 'O pacote de 2h não cabe dentro do horário de funcionamento.' });
            return;
        }

        // Determine tier of the entry slot
        const slotTier = getSlotTier(dayOfWeek, data.startTime);
        if (!slotTier) {
            res.status(400).json({ error: 'Horário fora da grade de operação.' });
            return;
        }

        // Calculate price
        let price = await getBasePriceDynamic(slotTier);
        let contractId: string | undefined = data.contractId;

        // If user has a contract, validate tier hierarchy and apply discount
        let contract: any = null;
        if (contractId) {
            contract = await prisma.contract.findFirst({
                where: {
                    id: contractId,
                    userId,
                    status: 'ACTIVE',
                },
                include: { bookings: true }
            });

            if (!contract) {
                res.status(404).json({ error: 'Contrato não encontrado ou inativo.' });
                return;
            }

            // Tier hierarchy check
            if (!canAccessTier(contract.tier, slotTier)) {
                res.status(403).json({
                    error: `Seu plano ${contract.tier} não permite agendar horários ${slotTier}.`,
                });
                return;
            }

            // For Flex: check remaining credits
            if (contract.type === 'FLEX') {
                if (!contract.flexCreditsRemaining || contract.flexCreditsRemaining <= 0) {
                    res.status(400).json({ error: 'Créditos Flex esgotados neste ciclo.' });
                    return;
                }
            } else if (contract.type === 'FIXO') {
                const usedBookings = contract.bookings.filter((b: any) =>
                    b.status === 'COMPLETED' || b.status === 'CONFIRMED' || b.status === 'FALTA' || b.status === 'RESERVED'
                ).length;
                if (usedBookings >= (contract.durationMonths * 4)) {
                    res.status(400).json({ error: 'Limite de agendamentos do plano fixo atingido.' });
                    return;
                }
            }

            price = applyDiscount(price, contract.discountPct);
        }

        // Add-ons Calculation
        let extraDiscountPct = contractId && contract ? contract.discountPct : 0;
        let addonsTotal = 0;
        
        if (data.addOns && data.addOns.length > 0) {
            const allAddons = await prisma.addOnConfig.findMany({
                where: { key: { in: data.addOns } }
            });
            for (const add of allAddons) {
                addonsTotal += add.price;
            }
            if (addonsTotal > 0) {
                const discountedAddons = applyDiscount(addonsTotal, extraDiscountPct);
                price += discountedAddons;
            }
        }

        // Get all slots covered by the 2h package
        const packageSlots = getPackageSlots(data.startTime);
        const endTime = calculateEndTime(data.startTime);

        // Acquire Redis locks for all slots
        const locked = await acquireMultiSlotLock(data.date, packageSlots, userId);
        if (!locked) {
            res.status(409).json({
                error: 'Um ou mais horários já estão sendo reservados por outro cliente. Tente novamente.',
            });
            return;
        }

        try {
            // Check for existing bookings (double-booking at DB level)
            const conflicting = await prisma.booking.findFirst({
                where: {
                    date: dateObj,
                    status: { not: BookingStatus.CANCELLED },
                    OR: packageSlots.map(slot => ({
                        startTime: { lte: slot },
                        endTime: { gt: slot },
                    })),
                },
            });

            if (conflicting) {
                await releaseMultiSlotLock(data.date, packageSlots, userId);
                res.status(409).json({ error: 'Horário já reservado. Escolha outro.' });
                return;
            }

            // Create Avulso Contract if needed
            let isAvulsoCreated = false;
            let finalContractId = contractId;
            if (!finalContractId) {
                const parts = data.date.split('-');
                const formattedDate = `${parts[2]}/${parts[1]}/${parts[0]}`;
                const newContract = await prisma.contract.create({
                    data: {
                        userId,
                        name: `Avulso ${formattedDate} as ${data.startTime}`,
                        type: 'FLEX',
                        tier: slotTier,
                        durationMonths: 1,
                        discountPct: 0,
                        startDate: dateObj,
                        endDate: new Date(dateObj.getTime() + 30 * 24 * 60 * 60 * 1000),
                        status: 'ACTIVE',
                        flexCreditsTotal: 1,
                        flexCreditsRemaining: 0, // Consumed immediately
                    }
                });
                finalContractId = newContract.id;
                isAvulsoCreated = true;
            } else {
                // If Flex contract, decrement credits
                const contract = await prisma.contract.findUnique({ where: { id: finalContractId } });
                if (contract?.type === 'FLEX' && (contract.flexCreditsRemaining || 0) > 0) {
                    await prisma.contract.update({
                        where: { id: finalContractId },
                        data: { flexCreditsRemaining: contract.flexCreditsRemaining! - 1 },
                    });
                }
            }

            // Create booking
            const booking = await prisma.booking.create({
                data: {
                    userId,
                    contractId: finalContractId,
                    date: dateObj,
                    startTime: data.startTime,
                    endTime,
                    status: BookingStatus.RESERVED,
                    tierApplied: slotTier,
                    price,
                    addOns: data.addOns || [],
                },
            });

            res.status(201).json({
                booking: {
                    id: booking.id,
                    date: data.date,
                    startTime: booking.startTime,
                    endTime: booking.endTime,
                    tier: booking.tierApplied,
                    price: booking.price,
                    status: booking.status,
                    contractId: booking.contractId,
                },
                creditWarning: isAvulsoCreated,
                lockExpiresIn: 600, // 10 minutes
                message: !contractId
                    ? 'Horário reservado como agendamento avulso (sem plano). Confirme em até 10 minutos.'
                    : 'Horário reservado! Confirme o pagamento em até 10 minutos.',
            });
        } catch (err) {
            // Release locks on error
            await releaseMultiSlotLock(data.date, packageSlots, userId);
            throw err;
        }
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        res.status(500).json({ error: 'Erro interno ao criar agendamento' });
    }
});

// ─── POST /api/bookings/bulk ─────────────────────────────

router.post('/bulk', authenticate, async (req: Request, res: Response) => {
    try {
        const data = bulkBookingSchema.parse(req.body);
        const userId = req.user!.userId;

        const contract = await prisma.contract.findFirst({
            where: { id: data.contractId, userId, status: 'ACTIVE' }
        });

        if (!contract) {
            res.status(404).json({ error: 'Contrato não encontrado ou inativo.' });
            return;
        }
        if (contract.type !== 'FLEX') {
            res.status(400).json({ error: 'Apenas contratos Flex suportam marcação em lote.' });
            return;
        }
        if ((contract.flexCreditsRemaining || 0) < data.slots.length) {
            res.status(400).json({ error: `Saldo insuficiente. Selecionados: ${data.slots.length}, Disponíveis: ${contract.flexCreditsRemaining}` });
            return;
        }

        const validBookings = [];
        const locksAcquired: { date: string; slots: string[] }[] = [];

        try {
            for (const slot of data.slots) {
                const dateObj = new Date(slot.date + 'T00:00:00');
                const dayOfWeek = dateObj.getUTCDay();

                // Validate: Past Time Booking Check
                const slotDateTime = new Date(`${slot.date}T${slot.startTime}:00`);
                const diffMinutes = (slotDateTime.getTime() - Date.now()) / (1000 * 60);
                if (diffMinutes < 30) {
                    throw new Error(`Não é possível agendar o horário ${slot.startTime} no dia ${slot.date} (antecedência mínima de 30 minutos não respeitada).`);
                }

                const slotTier = getSlotTier(dayOfWeek, slot.startTime);
                if (!slotTier) throw new Error(`Horário inválido: ${slot.startTime} em ${slot.date}`);

                if (!canAccessTier(contract.tier, slotTier)) {
                    throw new Error(`Seu plano ${contract.tier} não engloba o horário ${slot.startTime} (${slotTier}).`);
                }

                const packageSlots = getPackageSlots(slot.startTime);
                const endTime = calculateEndTime(slot.startTime);

                const locked = await acquireMultiSlotLock(slot.date, packageSlots, userId);
                if (!locked) throw new Error(`Horário ${slot.startTime} no dia ${slot.date} já está sendo reservado. Tente novamente.`);
                locksAcquired.push({ date: slot.date, slots: packageSlots });

                const conflicting = await prisma.booking.findFirst({
                    where: {
                        date: dateObj, status: { not: BookingStatus.CANCELLED },
                        OR: packageSlots.map(s => ({ startTime: { lte: s }, endTime: { gt: s } }))
                    }
                });
                if (conflicting) throw new Error(`Conflito na grade para o dia ${slot.date} às ${slot.startTime}.`);

                let price = applyDiscount(await getBasePriceDynamic(slotTier), contract.discountPct);

                validBookings.push({
                    userId, contractId: contract.id, date: dateObj, startTime: slot.startTime, endTime,
                    status: BookingStatus.CONFIRMED, tierApplied: slotTier, price,
                    addOns: contract.addOns ? contract.addOns.filter(a => a !== 'GESTAO_SOCIAL') : []
                });
            }

            await prisma.$transaction([
                prisma.booking.createMany({ data: validBookings }),
                prisma.contract.update({
                    where: { id: contract.id },
                    data: { flexCreditsRemaining: contract.flexCreditsRemaining! - validBookings.length }
                })
            ]);

            res.status(201).json({ message: `${validBookings.length} gravações agendadas com sucesso!` });
        } catch (err: any) {
            for (const l of locksAcquired) {
                await releaseMultiSlotLock(l.date, l.slots, userId);
            }
            res.status(400).json({ error: err.message });
            return;
        } finally {
            for (const l of locksAcquired) {
                await releaseMultiSlotLock(l.date, l.slots, userId);
            }
        }
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        res.status(500).json({ error: 'Erro interno ao salvar lote.' });
    }
});

// ─── PATCH /api/bookings/:id/confirm ────────────────────

router.patch('/:id/confirm', authenticate, async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const userId = req.user!.userId;

    const booking = await prisma.booking.findFirst({
        where: { id, userId, status: BookingStatus.RESERVED },
    });

    if (!booking) {
        res.status(404).json({ error: 'Reserva não encontrada ou já confirmada/cancelada.' });
        return;
    }

    // Confirm booking
    const updated = await prisma.booking.update({
        where: { id },
        data: { status: BookingStatus.CONFIRMED },
    });

    // Release Redis locks (booking is now persisted in DB)
    const dateStr = booking.date.toISOString().split('T')[0];
    const packageSlots = getPackageSlots(booking.startTime);
    await releaseMultiSlotLock(dateStr, packageSlots, userId);

    res.json({
        booking: {
            id: updated.id,
            date: dateStr,
            startTime: updated.startTime,
            endTime: updated.endTime,
            status: updated.status,
            price: updated.price,
        },
        message: 'Agendamento confirmado com sucesso!',
    });
});

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

    // If Flex contract, restore credit
    if (booking.contractId) {
        const contract = await prisma.contract.findUnique({ where: { id: booking.contractId } });
        if (contract?.type === 'FLEX') {
            await prisma.contract.update({
                where: { id: booking.contractId },
                data: { flexCreditsRemaining: (contract.flexCreditsRemaining || 0) + 1 },
            });
        }
    }

    res.json({ message: 'Reserva cancelada com sucesso.' });
});

// ─── GET /api/bookings/my ───────────────────────────────

router.get('/my', authenticate, async (req: Request, res: Response) => {
    // Auto-complete: mark past CONFIRMED bookings as COMPLETED
    const now = new Date();
    await prisma.booking.updateMany({
        where: {
            userId: req.user!.userId,
            status: BookingStatus.CONFIRMED,
            date: { lt: new Date(now.toISOString().split('T')[0] + 'T00:00:00') },
        },
        data: { status: BookingStatus.COMPLETED },
    });

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

    const where: any = {};

    if (status && typeof status === 'string') {
        where.status = status;
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

// ─── POST /api/bookings/admin (ADMIN direct create) ─────

const adminCreateBookingSchema = z.object({
    userId: z.string().uuid(),
    contractId: z.string().uuid().optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato de data inválido'),
    startTime: z.string().regex(/^\d{2}:\d{2}$/, 'Formato de hora inválido (HH:MM)'),
    status: z.enum(['RESERVED', 'CONFIRMED']).optional().default('CONFIRMED'),
    addOns: z.array(z.string()).optional(),
});

router.post('/admin', authenticate, authorize('ADMIN'), async (req: Request, res: Response) => {
    try {
        const data = adminCreateBookingSchema.parse(req.body);
        const dateObj = new Date(data.date + 'T00:00:00');
        const dayOfWeek = dateObj.getUTCDay();

        if (dayOfWeek === 0) {
            res.status(400).json({ error: 'O estúdio não funciona aos domingos.' });
            return;
        }

        if (!fitsInOperatingHours(data.startTime)) {
            res.status(400).json({ error: 'O pacote de 2h não cabe dentro do horário de funcionamento.' });
            return;
        }

        const slotTier = getSlotTier(dayOfWeek, data.startTime);
        if (!slotTier) {
            res.status(400).json({ error: 'Horário fora da grade de operação.' });
            return;
        }

        const endTime = calculateEndTime(data.startTime);
        let price = await getBasePriceDynamic(slotTier);
        
        let addonsTotal = 0;
        if (data.addOns && data.addOns.length > 0) {
            const allAddons = await prisma.addOnConfig.findMany({
                where: { key: { in: data.addOns } }
            });
            for (const add of allAddons) {
                addonsTotal += add.price;
            }
            price += addonsTotal; // Base admins usually apply discounts manually or we just pass base price here
        }

        // Check for conflicts
        const packageSlots = getPackageSlots(data.startTime);
        const conflicting = await prisma.booking.findFirst({
            where: {
                date: dateObj,
                status: { not: BookingStatus.CANCELLED },
                OR: packageSlots.map(slot => ({
                    startTime: { lte: slot },
                    endTime: { gt: slot },
                })),
            },
        });

        if (conflicting) {
            res.status(409).json({ error: 'Horário já reservado.' });
            return;
        }

        let finalContractId = data.contractId;
        let contract = null;
        if (finalContractId) {
            contract = await prisma.contract.findUnique({ where: { id: finalContractId }});
        }
        
        if (!finalContractId) {
            const parts = data.date.split('-');
            const formattedDate = `${parts[2]}/${parts[1]}/${parts[0]}`;
            const newContract = await prisma.contract.create({
                data: {
                    userId: data.userId,
                    name: `Avulso ${formattedDate} as ${data.startTime}`,
                    type: 'FLEX',
                    tier: slotTier,
                    durationMonths: 1,
                    discountPct: 0,
                    startDate: dateObj,
                    endDate: new Date(dateObj.getTime() + 30 * 24 * 60 * 60 * 1000),
                    status: 'ACTIVE',
                    flexCreditsTotal: 1,
                    flexCreditsRemaining: 0,
                }
            });
            finalContractId = newContract.id;
        }

        const booking = await prisma.booking.create({
            data: {
                userId: data.userId,
                contractId: finalContractId,
                date: dateObj,
                startTime: data.startTime,
                endTime,
                status: data.status === 'CONFIRMED' ? BookingStatus.CONFIRMED : BookingStatus.RESERVED,
                tierApplied: slotTier,
                price,
                addOns: contract ? Array.from(new Set([...(contract.addOns || []).filter(a => a !== 'GESTAO_SOCIAL'), ...(data.addOns || [])])) : (data.addOns || []),
            },
        });

        res.status(201).json({
            booking: {
                id: booking.id,
                date: data.date,
                startTime: booking.startTime,
                endTime: booking.endTime,
                tier: booking.tierApplied,
                price: booking.price,
                status: booking.status,
            },
            message: 'Agendamento criado pelo administrador.',
        });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        throw err;
    }
});

// ─── PATCH /api/bookings/:id (ADMIN update) ─────────────

const adminUpdateBookingSchema = z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    startTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    status: z.enum(['RESERVED', 'CONFIRMED', 'COMPLETED', 'FALTA', 'NAO_REALIZADO', 'CANCELLED']).optional(),
    adminNotes: z.string().optional(),
    clientNotes: z.string().optional(),
    platforms: z.string().optional(),
    platformLinks: z.string().optional(),
    durationMinutes: z.number().optional().nullable(),
    peakViewers: z.number().optional().nullable(),
    chatMessages: z.number().optional().nullable(),
    audienceOrigin: z.string().optional().nullable(),
});

router.patch('/:id', authenticate, authorize('ADMIN'), async (req: Request, res: Response) => {
    try {
        const id = req.params.id as string;
        const data = adminUpdateBookingSchema.parse(req.body);

        const booking = await prisma.booking.findUnique({ where: { id } });
        if (!booking) {
            res.status(404).json({ error: 'Agendamento não encontrado.' });
            return;
        }

        const updateData: any = {};

        if (data.status) {
            updateData.status = data.status;

            // NAO_REALIZADO: restore credit to contract
            if (data.status === 'NAO_REALIZADO' && booking.contractId && booking.status !== 'NAO_REALIZADO') {
                const contract = await prisma.contract.findUnique({ where: { id: booking.contractId } });
                if (contract?.type === 'FLEX' && contract.flexCreditsRemaining !== null) {
                    await prisma.contract.update({
                        where: { id: booking.contractId },
                        data: { flexCreditsRemaining: contract.flexCreditsRemaining + 1 },
                    });
                }
            }

            // If changing FROM NAO_REALIZADO back to something that consumes credit, re-deduct
            if (booking.status === 'NAO_REALIZADO' && data.status !== 'NAO_REALIZADO' && data.status !== 'CANCELLED' && booking.contractId) {
                const contract = await prisma.contract.findUnique({ where: { id: booking.contractId } });
                if (contract?.type === 'FLEX' && contract.flexCreditsRemaining !== null && contract.flexCreditsRemaining > 0) {
                    await prisma.contract.update({
                        where: { id: booking.contractId },
                        data: { flexCreditsRemaining: contract.flexCreditsRemaining - 1 },
                    });
                }
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
            const slotTier = getSlotTier(dayOfWeek, data.startTime);
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

const clientUpdateBookingSchema = z.object({
    clientNotes: z.string().optional(),
    platforms: z.string().optional(),
    platformLinks: z.string().optional(),
    durationMinutes: z.number().optional().nullable(),
    peakViewers: z.number().optional().nullable(),
    chatMessages: z.number().optional().nullable(),
    audienceOrigin: z.string().optional().nullable(),
});

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

        const updateData: any = {};
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

const rescheduleSchema = z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato de data inválido'),
    startTime: z.string().regex(/^\d{2}:\d{2}$/, 'Formato de hora inválido').refine(val => generateTimeSlots().includes(val), 'Horário deve ser um dos blocos oficiais.'),
});

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

        // Rule 1: Must be at least 24h before the original booking
        const originalDateTime = new Date(booking.date);
        const [origH, origM] = booking.startTime.split(':').map(Number);
        originalDateTime.setUTCHours(origH, origM, 0, 0);
        const now = new Date();
        const hoursUntilOriginal = (originalDateTime.getTime() - now.getTime()) / (1000 * 60 * 60);

        if (hoursUntilOriginal < 24) {
            res.status(400).json({ error: 'O reagendamento deve ser feito com pelo menos 24 horas de antecedência.' });
            return;
        }

        // Rule 2: New date must be within 7 days from the ORIGINAL booking date (anchor)
        const anchorDate = booking.originalDate || booking.date;
        const anchorMs = new Date(anchorDate).setUTCHours(0, 0, 0, 0);
        const newDate = new Date(data.date + 'T00:00:00');
        const newDateMs = newDate.setUTCHours(0, 0, 0, 0);
        const daysFromAnchor = (newDateMs - anchorMs) / (1000 * 60 * 60 * 24);

        if (daysFromAnchor > 7 || daysFromAnchor < 0) {
            const anchorStr = new Date(anchorDate).toLocaleDateString('pt-BR', { timeZone: 'UTC' });
            res.status(400).json({ error: `A nova data deve estar dentro de 7 dias da data original (${anchorStr}).` });
            return;
        }

        // Rule 3: Sunday check
        const dayOfWeek = newDate.getUTCDay();
        if (dayOfWeek === 0) {
            res.status(400).json({ error: 'O estúdio não funciona aos domingos.' });
            return;
        }

        // Rule 4: Tier must match original
        const newTier = getSlotTier(dayOfWeek, data.startTime);
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
        const updateData: any = {
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

// ─── POST /api/bookings/:id/addons (Purchase Addon) ─────

const addOnPurchaseSchema = z.object({
    addonKey: z.string().min(1, 'ID do serviço é obrigatório'),
});

router.post('/:id/addons', authenticate, async (req: Request, res: Response) => {
    try {
        const id = req.params.id as string;
        const data = addOnPurchaseSchema.parse(req.body);
        const userId = req.user!.userId;

        const booking = await prisma.booking.findFirst({
            where: { id, userId, status: { in: ['RESERVED', 'CONFIRMED'] } },
            include: { contract: true }
        });

        if (!booking) {
            res.status(404).json({ error: 'Agendamento não encontrado ou não disponível para edição.' });
            return;
        }

        if (booking.addOns.includes(data.addonKey)) {
            res.status(400).json({ error: 'Este serviço já está ativo neste episódio.' });
            return;
        }

        const addonConfig = await prisma.addOnConfig.findUnique({
            where: { key: data.addonKey }
        });

        if (!addonConfig) {
            res.status(404).json({ error: 'Serviço não encontrado no catálogo.' });
            return;
        }

        let price = addonConfig.price;
        if (booking.contract) {
            price = applyDiscount(price, booking.contract.discountPct);
        }

        // Generate Payment entry
        const payment = await prisma.payment.create({
            data: {
                userId,
                contractId: booking.contract?.id || null, // Associates with contract if applicable
                provider: 'CORA',
                amount: price,
                status: 'PENDING',
                dueDate: new Date(),
            }
        });

        // Add to booking
        const updatedBooking = await prisma.booking.update({
            where: { id },
            data: {
                addOns: { push: data.addonKey }
            }
        });

        res.status(200).json({
            message: 'Serviço adicionado com sucesso e cobrança gerada.',
            booking: updatedBooking,
            checkoutUrl: `/payment/${payment.id}`, // Mock URL for payment processing
            amount: price,
        });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        res.status(500).json({ error: 'Erro interno ao processar compra do serviço.' });
    }
});

export default router;

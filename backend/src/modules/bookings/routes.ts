import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { authenticate, authorize } from '../../middleware/auth';
import { acquireMultiSlotLock, releaseMultiSlotLock } from '../../lib/redis';
import { stripeCreatePaymentIntent, stripeGetOrCreateCustomer, stripeGetPaymentIntent, isStripeEnabled } from '../../lib/stripeService';
import { getProviderForMethod } from '../../lib/paymentGateway';
import {
    getSlotTier,
    getBasePriceDynamic,
    applyDiscount,
    canAccessTier,
    generateTimeSlots,
    getPackageSlots,
    calculateEndTime,
    fitsInOperatingHours,
    isOperatingDay,
} from '../../utils/pricing';
import { BookingStatus, Tier, Prisma } from '../../generated/prisma/client';
import { getConfig } from '../../lib/businessConfig';
import { getErrorMessage } from '../../utils/errors';

// Extracted modules
import {
    availabilitySchema,
    publicAvailabilitySchema,
    createBookingSchema,
    bulkBookingSchema,
    adminCreateBookingSchema,
    adminUpdateBookingSchema,
    clientUpdateBookingSchema,
    rescheduleSchema,
    addOnPurchaseSchema,
} from './validators';
import { getPublicDayAvailability, getAuthDayAvailability } from './availability.service';
import { restoreCredit, deductCredit, hasConflict, createAvulsoContract } from './booking.service';

const router = Router();

// ─── GET /api/bookings/public-availability ───────────────
// Public endpoint (no auth) — returns week of slot availability for the landing page

router.get('/public-availability', async (req: Request, res: Response) => {
    try {
        const { startDate, days } = publicAvailabilitySchema.parse(req.query);
        const result = [];

        for (let i = 0; i < days; i++) {
            const dateObj = new Date(startDate + 'T00:00:00');
            dateObj.setUTCDate(dateObj.getUTCDate() + i);
            const dateStr = dateObj.toISOString().split('T')[0];
            result.push(await getPublicDayAvailability(dateStr));
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
        const dayAvailability = await getAuthDayAvailability(date);

        if (dayAvailability.closed) {
            res.json({ date, closed: true, slots: [] });
            return;
        }

        // Get client's own bookings for this date
        const dateObj = new Date(date + 'T00:00:00');
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
                addOns: true, holdExpiresAt: true,
            },
        }) : [];

        res.json({
            date,
            dayOfWeek: dayAvailability.dayOfWeek,
            closed: false,
            slots: dayAvailability.slots,
            myBookings,
        });
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
        const minAdvanceMinutes = await getConfig('booking_min_advance_minutes');
        const diffMinutes = (slotDateTime.getTime() - Date.now()) / (1000 * 60);
        if (diffMinutes < minAdvanceMinutes) {
            res.status(400).json({ error: `Não é possível agendar um horário no passado ou com menos de ${minAdvanceMinutes} minutos de antecedência.` });
            return;
        }

        // Validate: operating day
        if (!(await isOperatingDay(dayOfWeek))) {
            res.status(400).json({ error: 'O estúdio não funciona neste dia da semana.' });
            return;
        }

        // Validate: valid slot
        const validSlots = await generateTimeSlots();
        if (!validSlots.includes(data.startTime)) {
            res.status(400).json({ error: `Horário deve ser um dos blocos oficiais: ${validSlots.join(', ')}.` });
            return;
        }

        // Validate: fits in operating hours
        if (!(await fitsInOperatingHours(data.startTime))) {
            res.status(400).json({ error: 'O pacote não cabe dentro do horário de funcionamento.' });
            return;
        }

        // Determine tier of the entry slot
        const slotTier = await getSlotTier(dayOfWeek, data.startTime);
        if (!slotTier) {
            res.status(400).json({ error: 'Horário fora da grade de operação.' });
            return;
        }

        // Calculate price
        let price = await getBasePriceDynamic(slotTier);
        let contractId: string | undefined = data.contractId;

        // If user has a contract, validate tier hierarchy and apply discount
        let contract: Prisma.ContractGetPayload<{ include: { bookings: true } }> | null = null;
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
            if (contract.type === 'FLEX' || contract.type === 'AVULSO') {
                if (!contract.flexCreditsRemaining || contract.flexCreditsRemaining <= 0) {
                    res.status(400).json({ error: 'Créditos esgotados neste ciclo.' });
                    return;
                }
            } else if (contract.type === 'FIXO') {
                const activeStatuses: BookingStatus[] = [BookingStatus.COMPLETED, BookingStatus.CONFIRMED, BookingStatus.FALTA, BookingStatus.RESERVED];
                const usedBookings = contract.bookings.filter(b =>
                    activeStatuses.includes(b.status)
                ).length;
                const sessionsPerMonthBooking = await getConfig('sessions_per_month');
                if (usedBookings >= (contract.durationMonths * sessionsPerMonthBooking)) {
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
            // Exclude user's own RESERVED bookings — they are allowed to retry payment
            const conflicting = await prisma.booking.findFirst({
                where: {
                    date: dateObj,
                    status: { not: BookingStatus.CANCELLED },
                    NOT: { userId, status: BookingStatus.RESERVED },
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

            // Check if user already has a RESERVED booking for this exact slot (PIX→Card switch)
            const existingHold = await prisma.booking.findFirst({
                where: {
                    date: dateObj,
                    userId,
                    startTime: data.startTime,
                    status: BookingStatus.RESERVED,
                },
                include: { contract: true },
            });

            // If user already holds this slot, reuse it instead of creating a new booking
            if (existingHold) {
                await releaseMultiSlotLock(data.date, packageSlots, userId);

                // Find existing pending payment
                const existingPayment = await prisma.payment.findFirst({
                    where: { bookingId: existingHold.id, status: 'PENDING' },
                });

                let clientSecret: string | null = null;
                let paymentId = existingPayment?.id || null;

                // If switching to CARTAO and no Stripe intent exists, create one
                if (data.paymentMethod === 'CARTAO' && (await isStripeEnabled())) {
                    if (!paymentId) {
                        const payment = await prisma.payment.create({
                            data: {
                                userId,
                                contractId: existingHold.contractId,
                                bookingId: existingHold.id,
                                provider: 'STRIPE',
                                amount: existingHold.price,
                                status: 'PENDING',
                                dueDate: dateObj,
                                installments: data.installments || 1,
                                paymentType: data.paymentType || 'CREDIT',
                            },
                        });
                        paymentId = payment.id;
                    } else if (existingPayment && existingPayment.provider !== 'STRIPE') {
                        // Previous payment was PIX/CORA, create a new Stripe payment
                        const payment = await prisma.payment.create({
                            data: {
                                userId,
                                contractId: existingHold.contractId,
                                bookingId: existingHold.id,
                                provider: 'STRIPE',
                                amount: existingHold.price,
                                status: 'PENDING',
                                dueDate: dateObj,
                                installments: data.installments || 1,
                                paymentType: data.paymentType || 'CREDIT',
                            },
                        });
                        paymentId = payment.id;
                    }

                    const customerId = await stripeGetOrCreateCustomer(userId);
                    const piResult = await stripeCreatePaymentIntent({
                        amount: existingHold.price,
                        customerId,
                        description: `Avulso ${data.date} ${data.startTime} (retry)`,
                        paymentId: paymentId!,
                        userId,
                        contractId: existingHold.contractId!,
                        installmentsEnabled: (data.installments || 1) > 1,
                    });
                    clientSecret = piResult.clientSecret;

                    await prisma.payment.update({
                        where: { id: paymentId! },
                        data: { providerRef: piResult.paymentIntentId, provider: 'STRIPE' },
                    });
                }

                // Refresh hold timer
                await prisma.booking.update({
                    where: { id: existingHold.id },
                    data: { holdExpiresAt: new Date(Date.now() + 10 * 60 * 1000) },
                });

                res.status(200).json({
                    booking: {
                        id: existingHold.id,
                        date: data.date,
                        startTime: existingHold.startTime,
                        endTime: existingHold.endTime,
                        tier: existingHold.tierApplied,
                        price: existingHold.price,
                        status: existingHold.status,
                        contractId: existingHold.contractId,
                        holdExpiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
                    },
                    paymentId,
                    clientSecret,
                    creditWarning: false,
                    lockExpiresIn: 600,
                    message: 'Reserva existente reutilizada. Complete o pagamento.',
                });
                return;
            }

            // Determine booking status and payment flow
            const isAvulso = !contractId;
            const holdExpiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

            // Create Avulso Contract if needed
            let isAvulsoCreated = false;
            let finalContractId = contractId;
            if (!finalContractId) {
                const parts = data.date.split('-');
                const formattedDate = `${parts[2]}/${parts[1]}/${parts[0]}`;
                const avulsoStatus = 'AWAITING_PAYMENT';
                const newContract = await prisma.contract.create({
                    data: {
                        userId,
                        name: `Avulso ${formattedDate} as ${data.startTime}`,
                        type: 'AVULSO',
                        tier: slotTier,
                        durationMonths: 1,
                        discountPct: 0,
                        startDate: dateObj,
                        endDate: new Date(dateObj.getTime() + 30 * 24 * 60 * 60 * 1000),
                        status: avulsoStatus as any,
                        paymentMethod: data.paymentMethod as any || null,
                        flexCreditsTotal: 1,
                        flexCreditsRemaining: 0, // Consumed immediately
                        paymentDeadline: holdExpiresAt,
                    }
                });
                finalContractId = newContract.id;
                isAvulsoCreated = true;
            } else {
                // Decrement credits based on contract type
                const contract = await prisma.contract.findUnique({ where: { id: finalContractId } });
                if ((contract?.type === 'FLEX' || contract?.type === 'AVULSO') && (contract.flexCreditsRemaining || 0) > 0) {
                    await prisma.contract.update({
                        where: { id: finalContractId },
                        data: { flexCreditsRemaining: contract.flexCreditsRemaining! - 1 },
                    });
                } else if (contract?.type === 'CUSTOM' && (contract.customCreditsRemaining || 0) > 0) {
                    await prisma.contract.update({
                        where: { id: finalContractId },
                        data: { customCreditsRemaining: contract.customCreditsRemaining! - 1 },
                    });
                }
            }

            // Avulso: RESERVED with 10-min hold timer (payment required). Plan-based: RESERVED (no timer).
            const bookingStatus = BookingStatus.RESERVED;

            // Create booking
            const booking = await prisma.booking.create({
                data: {
                    userId,
                    contractId: finalContractId,
                    date: dateObj,
                    startTime: data.startTime,
                    endTime,
                    status: bookingStatus,
                    tierApplied: slotTier,
                    price,
                    addOns: data.addOns || [],
                    holdExpiresAt: isAvulso ? holdExpiresAt : null,
                },
            });

            // Create payment record for ALL avulso bookings
            let clientSecret: string | null = null;
            let createdPaymentId: string | null = null;
            if (isAvulso) {
                try {
                    // Create pending Payment record
                    const payment = await prisma.payment.create({
                        data: {
                            userId,
                            contractId: finalContractId,
                            bookingId: booking.id,
                            provider: data.paymentMethod === 'CARTAO' ? 'STRIPE' : 'CORA',
                            amount: price,
                            status: 'PENDING',
                            dueDate: dateObj,
                            installments: data.installments || 1,
                            paymentType: data.paymentType || (data.paymentMethod === 'CARTAO' ? 'CREDIT' : null),
                        },
                    });
                    createdPaymentId = payment.id;

                    // For Card: also create Stripe PaymentIntent
                    if (data.paymentMethod === 'CARTAO' && (await isStripeEnabled())) {
                        const customerId = await stripeGetOrCreateCustomer(userId);
                        const addOnDesc = data.addOns && data.addOns.length > 0 ? ` + ${data.addOns.length} extras` : '';
                        const piResult = await stripeCreatePaymentIntent({
                            amount: price,
                            customerId,
                            description: `Avulso ${data.date} ${data.startTime}${addOnDesc}`,
                            paymentId: payment.id,
                            userId,
                            contractId: finalContractId!,
                            installmentsEnabled: (data.installments || 1) > 1,
                        });
                        clientSecret = piResult.clientSecret;

                        // Update payment with Stripe reference
                        await prisma.payment.update({
                            where: { id: payment.id },
                            data: { providerRef: piResult.paymentIntentId },
                        });
                    }
                } catch (payErr: unknown) {
                    console.error('[BOOKING] Payment creation failed:', getErrorMessage(payErr));
                    // Still return the booking — client can retry payment
                }
            }

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
                    holdExpiresAt: booking.holdExpiresAt?.toISOString() || null,
                },
                paymentId: createdPaymentId,
                clientSecret,
                creditWarning: isAvulsoCreated,
                lockExpiresIn: 600, // 10 minutes
                message: isAvulso
                    ? 'Horário reservado por 10 minutos. Complete o pagamento para confirmar.'
                    : 'Horário reservado com sucesso!',
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

// ─── POST /api/bookings/:id/complete-payment ─────────────
// Called after successful Stripe payment to confirm a HELD booking

router.post('/:id/complete-payment', authenticate, async (req: Request, res: Response) => {
    try {
        const bookingId = req.params.id as string;
        const userId = req.user!.userId;
        const { paymentIntentId } = req.body;

        const booking = await prisma.booking.findFirst({
            where: { id: bookingId, userId },
            include: { contract: true },
        });

        if (!booking) {
            res.status(404).json({ error: 'Agendamento não encontrado.' });
            return;
        }

        if (booking.status !== 'HELD' && booking.status !== 'RESERVED') {
            res.status(400).json({ error: `Agendamento já está com status ${booking.status}.` });
            return;
        }

        // Check if hold has expired
        if (booking.holdExpiresAt && new Date(booking.holdExpiresAt) < new Date()) {
            res.status(410).json({ error: 'A reserva temporária expirou. O horário foi liberado.' });
            return;
        }

        // Update booking to CONFIRMED
        const updated = await prisma.booking.update({
            where: { id: bookingId },
            data: {
                status: 'CONFIRMED' as BookingStatus,
                holdExpiresAt: null,
            },
        });

        // Update Payment record to PAID (verify with Stripe first)
        if (paymentIntentId) {
            // Security: verify the PaymentIntent status with Stripe before marking PAID
            try {
                const pi = await stripeGetPaymentIntent(paymentIntentId);
                if (pi.status !== 'succeeded') {
                    res.status(400).json({ error: 'Pagamento ainda não confirmado pelo Stripe.' });
                    return;
                }
            } catch {
                res.status(400).json({ error: 'Não foi possível verificar o pagamento no Stripe.' });
                return;
            }

            await prisma.payment.updateMany({
                where: {
                    bookingId,
                    providerRef: paymentIntentId,
                    status: 'PENDING',
                },
                data: { status: 'PAID', paidAt: new Date() },
            });
        } else {
            // Fallback: mark any pending payment for this booking as PAID
            await prisma.payment.updateMany({
                where: {
                    bookingId,
                    status: 'PENDING',
                },
                data: { status: 'PAID', paidAt: new Date() },
            });
        }

        // If avulso micro-contract, activate it
        if (booking.contract?.status === 'AWAITING_PAYMENT') {
            await prisma.contract.update({
                where: { id: booking.contractId },
                data: { status: 'ACTIVE', paymentDeadline: null },
            });
        }

        // Release Redis locks (booking is now confirmed in DB)
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
            message: '✅ Pagamento confirmado! Seu horário está reservado.',
        });
    } catch (err) {
        console.error('[BOOKING] complete-payment error:', err);
        res.status(500).json({ error: 'Erro ao confirmar pagamento.' });
    }
});

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
        const bulkMinAdvance = await getConfig('booking_min_advance_minutes');

        try {
            for (const slot of data.slots) {
                const dateObj = new Date(slot.date + 'T00:00:00');
                const dayOfWeek = dateObj.getUTCDay();

                // Validate: Past Time Booking Check
                const slotDateTime = new Date(`${slot.date}T${slot.startTime}:00`);
                const diffMinutes = (slotDateTime.getTime() - Date.now()) / (1000 * 60);
                if (diffMinutes < bulkMinAdvance) {
                    throw new Error(`Não é possível agendar o horário ${slot.startTime} no dia ${slot.date} (antecedência mínima de ${bulkMinAdvance} minutos não respeitada).`);
                }

                const slotTier = await getSlotTier(dayOfWeek, slot.startTime);
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
        } catch (err: unknown) {
            res.status(400).json({ error: getErrorMessage(err) });
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

// ─── PUT /api/bookings/:id/client-cancel ────────────────

router.put('/:id/client-cancel', authenticate, async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const userId = req.user!.userId;

    const booking = await prisma.booking.findFirst({
        where: { id, userId, status: BookingStatus.CONFIRMED },
    });

    if (!booking) {
        res.status(404).json({ error: 'Reserva não encontrada ou já cancelada/concluída.' });
        return;
    }

    const now = new Date();
    // Use proper calculation for 24h before (assume UTC-3 for timezone consistency with fixed slots)
    const bookingDateTime = new Date(`${booking.date.toISOString().split('T')[0]}T${booking.startTime}:00-03:00`);
    const diffMs = bookingDateTime.getTime() - now.getTime();
    const diffHours = diffMs / (1000 * 60 * 60);

    if (diffHours >= 24) {
        // Cancel with refund
        await prisma.booking.update({
            where: { id },
            data: { status: BookingStatus.CANCELLED },
        });

        if (booking.contractId) {
            await restoreCredit(booking.contractId);
        }
        res.json({ message: 'Agendamento cancelado com sucesso. O crédito retornou ao seu plano.' });
    } else {
        // Cancel without refund (Late cancellation)
        await prisma.booking.update({
            where: { id },
            data: { status: BookingStatus.FALTA },
        });
        res.json({ message: 'Agendamento desmarcado. Por causa do aviso prévio menor que 24h, o crédito desta sessão foi consumido.' });
    }
});

// ─── PUT /api/bookings/:id/check-in (Admin) ─────────────

router.put('/:id/check-in', authenticate, authorize('ADMIN'), async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const booking = await prisma.booking.findUnique({ where: { id } });
    if (!booking) { res.status(404).json({ error: 'Agendamento não encontrado.' }); return; }
    if (booking.status !== 'RESERVED' && booking.status !== 'CONFIRMED') {
        res.status(400).json({ error: `Não é possível fazer check-in de um agendamento com status ${booking.status}.` }); return;
    }
    const updated = await prisma.booking.update({ where: { id }, data: { status: BookingStatus.CONFIRMED } });
    res.json({ booking: updated, message: '✅ Check-in realizado! Cliente presente.' });
});

// ─── PUT /api/bookings/:id/complete (Admin) ──────────────

router.put('/:id/complete', authenticate, authorize('ADMIN'), async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const { durationMinutes, peakViewers, chatMessages } = req.body || {};
    const booking = await prisma.booking.findUnique({ where: { id } });
    if (!booking) { res.status(404).json({ error: 'Agendamento não encontrado.' }); return; }
    if (booking.status !== 'CONFIRMED' && booking.status !== 'RESERVED') {
        res.status(400).json({ error: `Não é possível finalizar um agendamento com status ${booking.status}.` }); return;
    }
    const updated = await prisma.booking.update({
        where: { id },
        data: {
            status: BookingStatus.COMPLETED,
            ...(durationMinutes !== undefined && { durationMinutes }),
            ...(peakViewers !== undefined && { peakViewers }),
            ...(chatMessages !== undefined && { chatMessages }),
        },
    });
    res.json({ booking: updated, message: '🏁 Sessão finalizada com sucesso!' });
});

// ─── PUT /api/bookings/:id/mark-falta (Admin) ───────────

router.put('/:id/mark-falta', authenticate, authorize('ADMIN'), async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const booking = await prisma.booking.findUnique({ where: { id } });
    if (!booking) { res.status(404).json({ error: 'Agendamento não encontrado.' }); return; }
    if (booking.status === 'COMPLETED' || booking.status === 'CANCELLED') {
        res.status(400).json({ error: `Não é possível marcar falta em um agendamento ${booking.status}.` }); return;
    }
    const updated = await prisma.booking.update({ where: { id }, data: { status: BookingStatus.FALTA } });
    res.json({ booking: updated, message: '❌ Sessão marcada como falta (no-show).' });
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

// ─── POST /api/bookings/admin (ADMIN direct create) ─────

router.post('/admin', authenticate, authorize('ADMIN'), async (req: Request, res: Response) => {
    try {
        const data = adminCreateBookingSchema.parse(req.body);
        const dateObj = new Date(data.date + 'T00:00:00');
        const dayOfWeek = dateObj.getUTCDay();

        if (!(await isOperatingDay(dayOfWeek))) {
            res.status(400).json({ error: 'O estúdio não funciona neste dia da semana.' });
            return;
        }

        if (!(await fitsInOperatingHours(data.startTime))) {
            res.status(400).json({ error: 'O pacote não cabe dentro do horário de funcionamento.' });
            return;
        }

        const slotTier = await getSlotTier(dayOfWeek, data.startTime);
        if (!slotTier) {
            res.status(400).json({ error: 'Horário fora da grade de operação.' });
            return;
        }

        const endTime = calculateEndTime(data.startTime);
        const basePrice = await getBasePriceDynamic(slotTier);
        let price: number;

        if (data.customPrice != null) {
            // Admin explicitly set a custom price
            price = data.customPrice;
        } else if (data.contractId) {
            // Contract-based: per-episode price = basePrice * (100 - discount%) / 100
            const linkedContract = await prisma.contract.findUnique({ where: { id: data.contractId } });
            if (linkedContract) {
                price = Math.round(basePrice * (100 - (linkedContract.discountPct || 0)) / 100);
            } else {
                price = basePrice;
            }
        } else {
            // Avulso: full tier price
            price = basePrice;
        }
        
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
                ...(data.adminNotes ? { adminNotes: data.adminNotes } : {}),
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
        const originalDateTime = new Date(booking.date);
        const [origH, origM] = booking.startTime.split(':').map(Number);
        originalDateTime.setUTCHours(origH, origM, 0, 0);
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

// ─── POST /api/bookings/:id/addons (Purchase Addon) ─────

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
                provider: getProviderForMethod('CARTAO'),
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


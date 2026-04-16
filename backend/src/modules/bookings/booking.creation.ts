import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { authenticate, authorize } from '../../middleware/auth';
import { acquireMultiSlotLock, releaseMultiSlotLock } from '../../lib/redis';
import { stripeCreatePaymentIntent, stripeGetOrCreateCustomer, isStripeEnabled } from '../../lib/stripeService';
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
import { BookingStatus, Prisma } from '../../generated/prisma/client';
import { getConfig } from '../../lib/businessConfig';
import { getErrorMessage } from '../../utils/errors';
import { createBookingSchema, bulkBookingSchema, adminCreateBookingSchema } from './validators';

export function registerCreationRoutes(router: Router) {

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
            let pixString: string | null = null;
            let qrCodeBase64: string | null = null;
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

                    // For Card: create Stripe PaymentIntent
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

                        await prisma.payment.update({
                            where: { id: payment.id },
                            data: { providerRef: piResult.paymentIntentId },
                        });
                    }

                    // For PIX: create Cora Invoice with QR code
                    if (data.paymentMethod === 'PIX') {
                        try {
                            const { coraCreateBoleto, isCoraEnabled } = await import('../../lib/coraService');
                            if (await isCoraEnabled()) {
                                const user = await prisma.user.findUnique({ where: { id: userId } });
                                const docStr = user?.cpfCnpj?.replace(/\D/g, '') || '';
                                if (docStr.length !== 11 && docStr.length !== 14) {
                                    console.warn('[BOOKING-PIX] User has no valid CPF/CNPJ, PIX may fail');
                                }
                                const docType: 'CPF' | 'CNPJ' = docStr.length === 14 ? 'CNPJ' : 'CPF';
                                const pixDueDate = new Date();
                                pixDueDate.setDate(pixDueDate.getDate() + 1);

                                let addressData: any = undefined;
                                if (user?.address) {
                                    try {
                                        const addr = JSON.parse(user.address);
                                        addressData = {
                                            street: addr.street || 'N/A',
                                            number: addr.number || 'S/N',
                                            district: addr.district || 'Centro',
                                            city: addr.city || user.city || 'Cidade',
                                            state: addr.state || user.state || 'RJ',
                                            zipCode: (addr.zipCode || addr.cep || '00000000').replace(/\D/g, ''),
                                        };
                                    } catch { /* use undefined */ }
                                }

                                const coraResult = await coraCreateBoleto({
                                    amount: price,
                                    dueDate: pixDueDate.toISOString().split('T')[0],
                                    description: `Avulso ${data.date} ${data.startTime}`,
                                    withPixQrCode: true,
                                    customer: {
                                        name: user?.name || 'Cliente',
                                        email: user?.email || 'cliente@estudio.com',
                                        document: { type: docType, identity: docStr || '00000000000' },
                                        ...(addressData ? { address: addressData } : {}),
                                    },
                                });

                                pixString = coraResult.pixString || null;
                                qrCodeBase64 = coraResult.qrCodeBase64 || null;

                                await prisma.payment.update({
                                    where: { id: payment.id },
                                    data: {
                                        providerRef: coraResult.id,
                                        provider: 'CORA',
                                        pixString: coraResult.pixString,
                                    },
                                });
                            }
                        } catch (pixErr: unknown) {
                            console.error('[BOOKING-PIX] Cora PIX creation failed:', getErrorMessage(pixErr));
                        }
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
                pixString,
                qrCodeBase64,
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

// ─── POST /api/bookings/bulk ────────────────────────────

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
                    type: 'AVULSO',
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

} // end registerCreationRoutes

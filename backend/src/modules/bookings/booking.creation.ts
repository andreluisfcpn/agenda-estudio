import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { authenticate, authorize } from '../../middleware/auth.js';
import { acquireMultiSlotLock, releaseMultiSlotLock } from '../../lib/redis.js';
import { stripeCreatePaymentIntent, stripeGetOrCreateCustomer, isStripeEnabled } from '../../lib/stripeService.js';
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
    studioDateTime,
} from '../../utils/pricing.js';
import { BookingStatus, Prisma } from '../../generated/prisma/client.js';
import { getConfig } from '../../lib/businessConfig.js';
import { getErrorMessage } from '../../utils/errors.js';
import { createBookingSchema, bulkBookingSchema, adminCreateBookingSchema } from './validators.js';

export function registerCreationRoutes(router: Router) {

// ─── POST /api/bookings ─────────────────────────────────

router.post('/', authenticate, async (req: Request, res: Response) => {
    try {
        const data = createBookingSchema.parse(req.body);
        const userId = req.user!.userId;

        const dateObj = new Date(data.date + 'T00:00:00');
        const dayOfWeek = dateObj.getUTCDay();

        // Validate: Past Time Booking Check (studio timezone, consistent across server TZs)
        const slotDateTime = studioDateTime(data.date, data.startTime);
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

        // Add-ons Calculation.
        // SEMANTICS (intentional, do not "fix" to × sessions): a service added to ONE booking is
        // charged once (×1, with the contract loyalty discount if linked). This differs from a
        // CONTRACT recurring service (lib/contractPricing.computeAddonsCost), which is × sessions/mês
        // because it accompanies every recording of the month. Here it's a single episode = 1 unit.
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
            // Check for existing bookings (double-booking at DB level).
            // Exclude: (a) the user's own RESERVED holds (they may retry payment) and
            // (b) ANY expired RESERVED hold (no longer occupies the slot — the cron just
            // hasn't swept it yet). The Redis lock above already guards real races.
            const nowConflict = new Date();
            const conflicting = await prisma.booking.findFirst({
                where: {
                    date: dateObj,
                    status: { not: BookingStatus.CANCELLED },
                    NOT: {
                        OR: [
                            { userId, status: BookingStatus.RESERVED },
                            { status: BookingStatus.RESERVED, holdExpiresAt: { lt: nowConflict } },
                        ],
                    },
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
                        tierApplied: existingHold.tierApplied,
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
                // Decrement credits based on contract type — VULN-M2 FIX: atomic operation
                const contract = await prisma.contract.findUnique({ where: { id: finalContractId } });
                if ((contract?.type === 'FLEX' || contract?.type === 'AVULSO') && (contract.flexCreditsRemaining || 0) > 0) {
                    const decremented = await prisma.contract.updateMany({
                        where: { id: finalContractId, flexCreditsRemaining: { gt: 0 } },
                        data: { flexCreditsRemaining: { decrement: 1 } },
                    });
                    if (decremented.count === 0) {
                        await releaseMultiSlotLock(data.date, packageSlots, userId);
                        res.status(400).json({ error: 'Créditos esgotados (concorrência). Tente novamente.' });
                        return;
                    }
                    // Anchor the FLEX weekly clock to the EARLIEST recording — persisted and
                    // only ever lowered on create (never moved forward on cancel), so the
                    // weekly pace can't be reset by cancelling/rebooking.
                    if (contract.type === 'FLEX') {
                        const bDate = new Date(data.date + 'T00:00:00');
                        if (contract.flexCycleStart == null || bDate < contract.flexCycleStart) {
                            await prisma.contract.update({
                                where: { id: finalContractId },
                                data: { flexCycleStart: bDate },
                            });
                        }
                    }
                } else if (contract?.type === 'CUSTOM' && (contract.customCreditsRemaining || 0) > 0) {
                    const decremented = await prisma.contract.updateMany({
                        where: { id: finalContractId, customCreditsRemaining: { gt: 0 } },
                        data: { customCreditsRemaining: { decrement: 1 } },
                    });
                    if (decremented.count === 0) {
                        await releaseMultiSlotLock(data.date, packageSlots, userId);
                        res.status(400).json({ error: 'Créditos esgotados (concorrência). Tente novamente.' });
                        return;
                    }
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
            // pixString/qrCodeBase64 are intentionally always null here: for avulso PIX the
            // client immediately calls POST /stripe/create-payment, which is the single source
            // of truth for PIX generation (and surfaces Cora errors as a 400). See the PIX note
            // below for why we no longer generate the invoice inline.
            const pixString: string | null = null;
            const qrCodeBase64: string | null = null;
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

                    // For PIX we deliberately do NOT generate the Cora invoice here. The client
                    // always calls POST /stripe/create-payment next, which is the single source of
                    // truth for PIX generation and surfaces Cora errors to the user as a 400.
                    // Generating it here as well created a second, orphaned Cora invoice AND (worse)
                    // swallowed transient failures silently — the response returned 201 with a null
                    // pixString that no caller reads. The payment row is left as CORA/PENDING and is
                    // enriched with providerRef + pixString by that call.
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
                    tierApplied: booking.tierApplied,
                    price: booking.price,
                    status: booking.status,
                    contractId: booking.contractId,
                    holdExpiresAt: booking.holdExpiresAt?.toISOString() || null,
                },
                paymentId: createdPaymentId,
                clientSecret,
                // PIX QR is generated by POST /stripe/create-payment, not here — so no
                // pixString/qrCodeBase64 in this response (nothing reads them from create).
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

        // Resolve the linked contract once — used for the base discount AND the add-on
        // discount inheritance below (avulso ⇒ no contract ⇒ 0%).
        const linkedContract = data.contractId
            ? await prisma.contract.findUnique({ where: { id: data.contractId } })
            : null;
        const contractDiscountPct = linkedContract?.discountPct || 0;

        let price: number;
        if (data.customPrice != null) {
            // Admin explicitly set a custom price (base only — services are added below)
            price = data.customPrice;
        } else if (linkedContract) {
            // Contract-based: per-episode price = basePrice with the loyalty discount applied
            price = applyDiscount(basePrice, contractDiscountPct);
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
            // Services inherit the contract loyalty discount (avulso = 0%), matching the client path.
            price += applyDiscount(addonsTotal, contractDiscountPct);
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
        let contract = linkedContract; // reuse the fetch from the pricing block above

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

        // Create Payment record for admin bookings (visible in financial reports)
        let createdPaymentId: string | null = null;
        let boletoUrl: string | null = null;
        let barcode: string | null = null;
        let boletoError: string | null = null;
        try {
            const paymentProvider = data.paymentMethod === 'BOLETO' ? 'CORA' : (data.paymentMethod === 'PIX' ? 'CORA' : 'STRIPE');
            const paymentRecord = await prisma.payment.create({
                data: {
                    userId: data.userId,
                    contractId: finalContractId,
                    bookingId: booking.id,
                    provider: paymentProvider as any,
                    amount: price,
                    status: data.status === 'CONFIRMED' ? 'PAID' : 'PENDING',
                    dueDate: dateObj,
                    installments: 1,
                    ...(data.status === 'CONFIRMED' ? { paidAt: new Date() } : {}),
                },
            });
            createdPaymentId = paymentRecord.id;

            // Admin-only: generate BOLETO via Cora
            if (data.paymentMethod === 'BOLETO' && data.status !== 'CONFIRMED') {
                try {
                    const { createCoraPayment } = await import('../../lib/coraPaymentHelper.js');
                    const coraRes = await createCoraPayment({
                        userId: data.userId,
                        amount: price,
                        description: `Boleto - ${data.startTime} ${data.date}`,
                        withPixQrCode: false,
                        dueDays: 3,
                        idempotencyKey: paymentRecord.id,
                    });
                    boletoUrl = coraRes.boletoUrl;
                    barcode = coraRes.barcode;
                    await prisma.payment.update({
                        where: { id: paymentRecord.id },
                        data: {
                            providerRef: coraRes.result.id,
                            provider: 'CORA',
                            boletoUrl: coraRes.boletoUrl,
                        },
                    });
                } catch (bErr: unknown) {
                    // Surface the failure to the admin instead of silently returning a
                    // 201 with no boleto — the booking still exists, but the admin must
                    // know the boleto was NOT generated (e.g. client CPF inválido).
                    console.error('[ADMIN-BOOKING] Boleto generation failed:', bErr);
                    boletoError = bErr instanceof Error ? bErr.message : 'Falha ao gerar o boleto.';
                }
            }
        } catch (payErr: unknown) {
            console.error('[ADMIN-BOOKING] Payment creation failed:', payErr);
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
            },
            paymentId: createdPaymentId,
            boletoUrl,
            barcode,
            ...(boletoError && { boletoError }),
            message: boletoError
                ? 'Agendamento criado, mas o boleto NÃO foi gerado. Verifique o CPF do cliente e gere o boleto novamente.'
                : 'Agendamento criado pelo administrador.',
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

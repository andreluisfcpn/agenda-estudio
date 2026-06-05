// ─── Contract Fulfillment ──────────────────────────────
// Creates contract + bookings + remaining payments after first payment is confirmed
// Used by: Cora webhook, Stripe webhook, Stripe verify-payment

import { prisma } from './prisma.js';
import { ContractStatus, BookingStatus, Prisma, Tier } from '../generated/prisma/client.js';
import { getBasePriceDynamic, applyDiscount, calculateEndTime } from '../utils/pricing.js';
import { getConfig } from './businessConfig.js';
import { createPayment as gatewayCreatePayment, updatePaymentWithGatewayResult, getProviderForMethod } from './paymentGateway.js';
import { createNotification } from '../modules/notifications/notificationService.js';

interface ContractData {
    name: string;
    type: 'FIXO' | 'FLEX';
    tier: string;
    durationMonths: 3 | 6;
    firstBookingDate: string;
    firstBookingTime: string;
    paymentMethod: string;
    addOns?: string[];
    fixedDayOfWeek?: number;
    fixedTime?: string;
    resolvedConflicts?: { originalDate: string; originalTime: string; newDate: string; newTime: string }[];
}

/**
 * After the first payment is confirmed, create the full contract:
 * 1. Contract record
 * 2. All bookings (FIXO or first FLEX)
 * 3. Remaining payment installments (months 2..N)
 */
export async function fulfillContractFromPayment(paymentId: string): Promise<void> {
    const payment = await prisma.payment.findUnique({
        where: { id: paymentId },
        include: { user: { select: { name: true, email: true } } },
    });

    if (!payment || !payment.metadata) return;

    const meta = payment.metadata as Record<string, unknown>;
    const contractData = meta.contractData as ContractData | undefined;
    if (!contractData) return;

    // Guard: don't create twice
    if (payment.contractId) {
        console.log(`[Fulfill] Payment ${paymentId} already has contractId ${payment.contractId}, skipping`);
        return;
    }

    const userId = payment.userId;
    // Clone so we never mutate the object read from payment.metadata (avoids side
    // effects if this is ever reprocessed before metadata is cleared).
    const data: ContractData = { ...contractData };

    console.log(`[Fulfill] Creating contract from payment ${paymentId} for user ${userId}`);

    const discountPct = data.durationMonths === 3
        ? await getConfig('discount_3months')
        : await getConfig('discount_6months');

    const firstDate = new Date(data.firstBookingDate + 'T00:00:00');
    const startDate = firstDate;
    const endDate = new Date(startDate);
    endDate.setMonth(endDate.getMonth() + data.durationMonths);

    const totalEpisodes = data.durationMonths === 3
        ? await getConfig('episodes_3months')
        : await getConfig('episodes_6months');

    // Infer fixedDayOfWeek if FIXO and missing
    if (data.type === 'FIXO' && !data.fixedDayOfWeek) {
        const dayOfWeek = firstDate.getDay() === 0 ? 7 : firstDate.getDay();
        data.fixedDayOfWeek = dayOfWeek;
        data.fixedTime = data.firstBookingTime;
    }

    // ── Create Contract ──
    const contract = await prisma.contract.create({
        data: {
            userId,
            name: data.name,
            type: data.type,
            tier: data.tier as Tier,
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
            paymentMethod: data.paymentMethod as any,
            addOns: data.addOns || [],
        },
    });

    // ── Generate Bookings ──
    const basePrice = await getBasePriceDynamic(data.tier as Tier);
    const discountedPrice = applyDiscount(basePrice, discountPct);

    if (data.type === 'FIXO' && data.fixedDayOfWeek && data.fixedTime) {
        const bookings = [];
        const current = new Date(startDate);

        while (current.getDay() !== (data.fixedDayOfWeek % 7)) {
            current.setDate(current.getDate() + 1);
        }

        const totalWeeks = data.durationMonths * (await getConfig('sessions_per_month'));

        for (let week = 0; week < totalWeeks; week++) {
            const bookingDate = new Date(current);
            bookingDate.setDate(current.getDate() + week * 7);
            if (bookingDate > endDate) break;

            const bookingDateStr = bookingDate.toISOString().split('T')[0];
            let finalDate = bookingDate;
            let finalTime = data.fixedTime!;

            const resolution = data.resolvedConflicts?.find(c =>
                c.originalDate === bookingDateStr && c.originalTime === data.fixedTime
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
                tierApplied: data.tier as Tier,
                price: discountedPrice,
                addOns: data.addOns ? data.addOns.filter(a => a !== 'GESTAO_SOCIAL') : [],
            });
        }

        if (bookings.length > 0) {
            await prisma.booking.createMany({ data: bookings });
        }
    }

    if (data.type === 'FLEX') {
        await prisma.booking.create({
            data: {
                userId,
                contractId: contract.id,
                date: firstDate,
                startTime: data.firstBookingTime,
                endTime: calculateEndTime(data.firstBookingTime),
                status: BookingStatus.CONFIRMED,
                tierApplied: data.tier as Tier,
                price: discountedPrice,
                addOns: data.addOns ? data.addOns.filter(a => a !== 'GESTAO_SOCIAL') : [],
            },
        });
    }

    // ── Link first payment to contract ──
    await prisma.payment.update({
        where: { id: paymentId },
        data: {
            contractId: contract.id,
            metadata: Prisma.JsonNull, // Clear metadata — contract is created
        },
    });

    // ── Generate remaining installments (months 2..N) ──
    let addonsCost = 0;
    if (data.addOns && data.addOns.length > 0) {
        const addonConfigs = await prisma.addOnConfig.findMany({
            where: { key: { in: data.addOns } },
        });
        const baseAddonsCost = addonConfigs.reduce((acc: number, curr: { price: number }) => acc + curr.price, 0);
        addonsCost = applyDiscount(baseAddonsCost, discountPct);
    }

    const sessionsPerMonth = await getConfig('sessions_per_month');
    let monthlyAmount = (sessionsPerMonth * discountedPrice) + addonsCost;

    // Apply card installment surcharge from admin config
    if (data.paymentMethod === 'CARTAO') {
        const surchargeConfig = await prisma.businessConfig.findUnique({ where: { key: 'card_installment_surcharges' } });
        if (surchargeConfig) {
            try {
                const surcharges = JSON.parse(surchargeConfig.value) as Record<string, number>;
                const pct = surcharges[String(data.durationMonths)] ?? 0;
                monthlyAmount = Math.round(monthlyAmount * (1 + pct / 100));
            } catch { /* use base amount */ }
        }
    }

    const remainingPayments = [];
    for (let i = 1; i < data.durationMonths; i++) {
        const dueDate = new Date(startDate);
        dueDate.setMonth(dueDate.getMonth() + i);

        remainingPayments.push({
            userId,
            contractId: contract.id,
            provider: getProviderForMethod(data.paymentMethod),
            amount: monthlyAmount,
            status: 'PENDING' as const,
            dueDate,
        });
    }

    if (remainingPayments.length > 0) {
        await prisma.payment.createMany({ data: remainingPayments });

        // Enrich remaining payments with gateway data
        const createdRemaining = await prisma.payment.findMany({
            where: { contractId: contract.id, status: 'PENDING' },
            orderBy: { dueDate: 'asc' },
        });

        for (const p of createdRemaining) {
            try {
                const result = await gatewayCreatePayment({
                    paymentMethod: data.paymentMethod as 'PIX' | 'BOLETO' | 'CARTAO',
                    amount: p.amount,
                    description: `${data.name} - Parcela`,
                    customer: { name: payment.user.name, email: payment.user.email || '' },
                    dueDate: p.dueDate || new Date(),
                    paymentId: p.id,
                    contractId: contract.id,
                    userId,
                });
                await updatePaymentWithGatewayResult(p.id, result);
            } catch (err) {
                console.error(`[Fulfill] Failed to enrich payment ${p.id}:`, err);
            }
        }
    }

    // ── Notification ──
    createNotification({
        userId,
        type: 'CONTRACT_ACTIVATED',
        severity: 'info',
        title: '🎉 Contrato Ativado!',
        message: `Seu contrato "${data.name}" foi ativado com sucesso! Seus agendamentos já estão confirmados.`,
        entityType: 'CONTRACT',
        entityId: contract.id,
        actionUrl: '/meus-contratos',
    }).catch(() => {});

    console.log(`[Fulfill] Contract ${contract.id} created with bookings for user ${userId}`);
}

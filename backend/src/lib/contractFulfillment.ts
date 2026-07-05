// ─── Contract Fulfillment ──────────────────────────────
// Creates contract + bookings + remaining payments after first payment is confirmed
// Used by: Cora webhook, Stripe webhook, Stripe verify-payment

import { prisma } from './prisma.js';
import { ContractStatus, ContractType, BookingStatus, Prisma, Tier } from '../generated/prisma/client.js';
import { getBasePriceDynamic, applyDiscount, calculateEndTime, addMonths, addBillingCycles } from '../utils/pricing.js';
import { getConfig } from './businessConfig.js';
import { createPayment as gatewayCreatePayment, updatePaymentWithGatewayResult, getProviderForMethod } from './paymentGateway.js';
import { computeAddonsCost, filterPerEpisodeAddons } from './contractPricing.js';
import { notifyEvent } from '../modules/notifications/notificationService.js';
import { computeCouponDiscount } from './couponService.js';

/** Coupon info persisted in the contract draft when the coupon's scope is
 *  ALL_INSTALLMENTS — months 2..N apply this discount at materialization. */
interface CouponForInstallments {
    couponId: string;
    couponCode: string;
    discountType: 'VALOR' | 'PERCENTUAL';
    discountValue: number;
}

/** Per-installment discount for months 2..N (base amount in cents). */
function installmentWithCoupon(base: number, coupon: CouponForInstallments | undefined) {
    if (!coupon) return { amount: base, couponFields: {} };
    const d = computeCouponDiscount(coupon, base);
    return {
        amount: base - d,
        couponFields: { couponId: coupon.couponId, couponCode: coupon.couponCode, discountAmount: d },
    };
}

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
    paymentPlan?: 'MONTHLY' | 'FULL';
    resolvedConflicts?: { originalDate: string; originalTime: string; newDate: string; newTime: string }[];
    // Per-month amount resolved at creation (incl. add-ons + card surcharge). When present,
    // months 2..N reuse it verbatim so they can't drift if the surcharge config changes.
    monthlyAmountResolved?: number;
    couponForInstallments?: CouponForInstallments;
}

/**
 * Metadata for a standalone monthly SERVICO contract (e.g. Gestão de Redes Sociais).
 * Stored in the first payment's metadata.contractData with kind:'SERVICE'; materialized
 * by fulfillServiceFromPayment once that payment is confirmed (pay-then-fulfill parity).
 */
interface ServiceContractData {
    kind: 'SERVICE';
    type: 'SERVICO';
    serviceKey: string;
    name: string;
    durationMonths: number;
    paymentMethod: string;
    paymentPlan: 'MONTHLY' | 'FULL';
    discountPct: number;
    billingCadence: 'BILLING_CYCLE_28' | 'CALENDAR_MONTH';
    /** Per-month base resolved at creation — months 2..N reuse it verbatim. */
    monthlyAmountResolved: number;
    couponForInstallments?: CouponForInstallments;
}

type FulfillablePayment = {
    id: string;
    userId: string;
    contractId: string | null;
    user: { name: string; email: string | null; cpfCnpj: string | null };
};

/**
 * Materialize a standalone monthly SERVICO contract after its first payment confirms.
 * No bookings/recordings — just the active contract plus (for MONTHLY) the remaining
 * installments on the configured cadence (calendar-month for services).
 */
async function fulfillServiceFromPayment(payment: FulfillablePayment, data: ServiceContractData): Promise<void> {
    const userId = payment.userId;
    const startDate = new Date();
    const endDate = addMonths(startDate, data.durationMonths);

    const contract = await prisma.contract.create({
        data: {
            userId,
            name: data.name,
            type: ContractType.SERVICO,
            tier: Tier.COMERCIAL,
            durationMonths: data.durationMonths,
            discountPct: data.discountPct,
            startDate,
            endDate,
            status: ContractStatus.ACTIVE,
            paymentMethod: data.paymentMethod as any,
            paymentPlan: data.paymentPlan,
            addOns: [data.serviceKey],
            flexCreditsTotal: 0,
            flexCreditsRemaining: 0,
        },
    });

    // Link first payment to the contract + clear its metadata (contract now exists).
    await prisma.payment.update({
        where: { id: payment.id },
        data: { contractId: contract.id, metadata: Prisma.JsonNull },
    });

    // Remaining installments (months 2..N) — skipped when paid in FULL.
    if (data.paymentPlan !== 'FULL') {
        const advance = data.billingCadence === 'CALENDAR_MONTH'
            ? (i: number) => addMonths(startDate, i)
            : (i: number) => addBillingCycles(startDate, i);

        const remaining = [];
        for (let i = 1; i < data.durationMonths; i++) {
            // ALL_INSTALLMENTS coupon: each later installment gets the same discount rule.
            const { amount, couponFields } = installmentWithCoupon(data.monthlyAmountResolved, data.couponForInstallments);
            remaining.push({
                userId,
                contractId: contract.id,
                provider: getProviderForMethod(data.paymentMethod),
                amount,
                status: 'PENDING' as const,
                dueDate: advance(i),
                ...couponFields,
            });
        }

        if (remaining.length > 0) {
            await prisma.payment.createMany({ data: remaining });
            const createdRemaining = await prisma.payment.findMany({
                where: { contractId: contract.id, status: 'PENDING' },
                orderBy: { dueDate: 'asc' },
            });
            for (const p of createdRemaining) {
                // Free installment (100% ALL-scope coupon): the gateway can't process R$0,
                // so settle it as PAID instead of leaving it stuck PENDING.
                if (p.amount === 0) {
                    await prisma.payment.updateMany({ where: { id: p.id, status: 'PENDING' }, data: { status: 'PAID', paidAt: new Date() } }).catch(() => {});
                    continue;
                }
                try {
                    const result = await gatewayCreatePayment({
                        paymentMethod: data.paymentMethod as 'PIX' | 'BOLETO' | 'CARTAO',
                        amount: p.amount,
                        description: `${data.name} - Parcela`,
                        customer: { name: payment.user.name, email: payment.user.email || '', cpf: payment.user.cpfCnpj?.replace(/\D/g, '') || undefined },
                        dueDate: p.dueDate || new Date(),
                        paymentId: p.id,
                        contractId: contract.id,
                        userId,
                    });
                    await updatePaymentWithGatewayResult(p.id, result);
                } catch (err) {
                    console.error(`[Fulfill:Service] Failed to enrich payment ${p.id}:`, err);
                }
            }
        }
    }

    notifyEvent('service_activated', {
        userId,
        vars: { servico: data.name },
        entityType: 'CONTRACT',
        entityId: contract.id,
    }).catch(() => {});

    console.log(`[Fulfill] Service contract ${contract.id} activated for user ${userId}`);
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
        include: { user: { select: { name: true, email: true, cpfCnpj: true } } },
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

    // Standalone monthly service (e.g. Gestão de Redes Sociais): no bookings — just
    // activate the SERVICO contract and generate installments 2..N (for MONTHLY).
    if ((contractData as unknown as { kind?: string }).kind === 'SERVICE') {
        await fulfillServiceFromPayment(payment, contractData as unknown as ServiceContractData);
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
    const endDate = addMonths(startDate, data.durationMonths);

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
            // The first recording is booked immediately below (it anchors the cycle),
            // so it already consumes one credit. Persist total-1 to match the canonical
            // engine (remaining = total − recordings − forfeited); otherwise the stored
            // value over-grants by 1 until the daily reconcile cron heals it.
            flexCreditsRemaining: data.type === 'FLEX' ? Math.max(0, totalEpisodes - 1) : null,
            flexCycleStart: data.type === 'FLEX' ? startDate : null,
            flexWeeksCompensated: data.type === 'FLEX' ? 0 : null,
            // New FLEX contracts are NOT grandfathered (forfeiture applies from the start).
            flexForfeitFloor: data.type === 'FLEX' ? 0 : null,
            paymentMethod: data.paymentMethod as any,
            paymentPlan: data.paymentPlan || 'MONTHLY',
            addOns: data.addOns || [],
        },
    });

    // ── Generate Bookings ──
    const basePrice = await getBasePriceDynamic(data.tier as Tier);
    const discountedPrice = applyDiscount(basePrice, discountPct);
    // Bookings carry only per-episode services; monthly services (e.g. GESTAO_SOCIAL) never ride on a recording.
    const perEpisodeAddOns = await filterPerEpisodeAddons(data.addOns);

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
                addOns: perEpisodeAddOns,
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
                addOns: perEpisodeAddOns,
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

    // ── Generate remaining installments (months 2..N) — skipped when paid in full ──
    if (data.paymentPlan !== 'FULL') {
    // Prefer the per-month amount resolved at contract creation (stored in metadata) so months
    // 2..N never diverge from month 1. Fall back to the plain base for legacy payments without it.
    // Monthly installments carry NO card surcharge (single 1x charge) — see paymentPolicy.
    let monthlyAmount: number;
    if (typeof data.monthlyAmountResolved === 'number' && data.monthlyAmountResolved > 0) {
        monthlyAmount = data.monthlyAmountResolved;
    } else {
        const sessionsPerMonth = await getConfig('sessions_per_month');
        const addonsCost = await computeAddonsCost(data.addOns, discountPct, sessionsPerMonth);
        monthlyAmount = (sessionsPerMonth * discountedPrice) + addonsCost;
    }

    const remainingPayments = [];
    for (let i = 1; i < data.durationMonths; i++) {
        // Each installment is one 28-day billing cycle after the previous, anchored
        // to the contract start (fixed cadence, no calendar-month drift).
        const dueDate = addBillingCycles(startDate, i);

        // ALL_INSTALLMENTS coupon: each later installment gets the same discount rule.
        const { amount, couponFields } = installmentWithCoupon(monthlyAmount, data.couponForInstallments);
        remainingPayments.push({
            userId,
            contractId: contract.id,
            provider: getProviderForMethod(data.paymentMethod),
            amount,
            status: 'PENDING' as const,
            dueDate,
            ...couponFields,
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
            // Free installment (100% ALL-scope coupon): the gateway can't process R$0,
            // so settle it as PAID instead of leaving it stuck PENDING.
            if (p.amount === 0) {
                await prisma.payment.updateMany({ where: { id: p.id, status: 'PENDING' }, data: { status: 'PAID', paidAt: new Date() } }).catch(() => {});
                continue;
            }
            try {
                const result = await gatewayCreatePayment({
                    paymentMethod: data.paymentMethod as 'PIX' | 'BOLETO' | 'CARTAO',
                    amount: p.amount,
                    description: `${data.name} - Parcela`,
                    customer: { name: payment.user.name, email: payment.user.email || '', cpf: payment.user.cpfCnpj?.replace(/\D/g, '') || undefined },
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
    } // end: skip remaining installments when contract is paid in FULL

    // ── Notification ──
    notifyEvent('contract_activated', {
        userId,
        vars: { contrato: data.name },
        entityType: 'CONTRACT',
        entityId: contract.id,
    }).catch(() => {});

    console.log(`[Fulfill] Contract ${contract.id} created with bookings for user ${userId}`);
}

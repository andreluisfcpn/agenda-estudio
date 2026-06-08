// ─── Payment Policy (single source of truth for plan + installment rules) ──────
// Every contract-creation/payment path (avulso, self FIXO/FLEX, custom, service,
// admin, /pay, fulfillment, renewal) MUST derive its plan amounts, schedule and
// installment options from here so the rules can never diverge again.
//
// Business rules (confirmed with the studio):
//  • MONTHLY plan  → durationMonths charges on a 28-day cadence; each charge is the
//    plain per-period base with NO card surcharge (paid 1x by PIX or card).
//  • FULL / à vista → one charge = base × durationMonths; PIX gets the à-vista
//    discount; card may split 1–12x, interest-free up to durationMonths and with the
//    card_installment_surcharges juros above that.
//  • AVULSO ("paid now") → one charge; card may split 1–12x, free in 1x, juros 2–12x.

import { addBillingCycles, addMonths } from '../utils/pricing.js';
import { computeFullContractTotal } from './contractPricing.js';

export type PaymentPlan = 'MONTHLY' | 'FULL';
export type CheckoutContractType = 'FIXO' | 'FLEX' | 'CUSTOM' | 'SERVICO' | 'AVULSO';
/**
 * Cadence between monthly installment due-dates.
 *  • BILLING_CYCLE_28 → fixed 28-day window (studio recordings run weekly) — the default
 *    for FIXO/FLEX/CUSTOM so nothing regresses.
 *  • CALENDAR_MONTH   → same day each calendar month (~30 days) — used by standalone
 *    monthly SERVICO services (e.g. Gestão de Redes Sociais).
 */
export type BillingCadence = 'BILLING_CYCLE_28' | 'CALENDAR_MONTH';

export interface PlanAmountsInput {
    /** Per-period base in cents (tier×sessions×discount + add-ons) — WITHOUT any surcharge. */
    baseMonthly: number;
    /** Number of monthly periods / custom cycles. */
    durationMonths: number;
    plan: PaymentPlan;
    paymentMethod?: string | null;
    /** Anchor for the installment schedule (contract start / first booking date). */
    startDate: Date;
    /** Due-date cadence for MONTHLY plans. Defaults to the 28-day billing cycle. */
    billingCadence?: BillingCadence;
}

export interface PlanAmounts {
    /** Per-period charge — ALWAYS the base (monthly carries NO card surcharge). */
    monthlyAmount: number;
    /** Whole-contract upfront total (PIX à-vista discount applied when method = PIX). */
    fullAmount: number;
    /** Amount of the first charge: FULL → fullAmount, MONTHLY → monthlyAmount. */
    firstAmount: number;
    /** Number of scheduled charges: FULL → 1, MONTHLY → durationMonths. */
    installmentCount: number;
    /** Due dates: FULL → [start]; MONTHLY → [start, +28d, +56d, …] (one per period). */
    scheduleDueDates: Date[];
}

/**
 * Resolve every plan-level money figure + the installment schedule from a single rule set.
 * Reuses computeFullContractTotal (PIX discount) and addBillingCycles (28-day cadence).
 */
export async function resolvePlanAmounts(input: PlanAmountsInput): Promise<PlanAmounts> {
    const { baseMonthly, durationMonths, plan, paymentMethod, startDate } = input;
    const cadence: BillingCadence = input.billingCadence ?? 'BILLING_CYCLE_28';

    // Monthly carries NO card surcharge — each monthly charge is a single 1x payment
    // (PIX or card). The card-installment juros lives ONLY on the FULL plan and is
    // computed at checkout via stripeGetInstallmentPlans, never baked into the monthly.
    const monthlyAmount = baseMonthly;
    const fullAmount = await computeFullContractTotal(baseMonthly, durationMonths, paymentMethod ?? undefined);
    const firstAmount = plan === 'FULL' ? fullAmount : monthlyAmount;

    const scheduleDueDates: Date[] = [];
    if (plan === 'FULL') {
        scheduleDueDates.push(new Date(startDate));
    } else {
        const advance = cadence === 'CALENDAR_MONTH'
            ? (i: number) => addMonths(startDate, i)
            : (i: number) => addBillingCycles(startDate, i);
        for (let i = 0; i < durationMonths; i++) scheduleDueDates.push(advance(i));
    }

    return {
        monthlyAmount,
        fullAmount,
        firstAmount,
        installmentCount: plan === 'FULL' ? 1 : durationMonths,
        scheduleDueDates,
    };
}

export interface InstallmentPolicy {
    /** Maximum card installments allowed for this charge. */
    maxInstallments: number;
    /** Installments up to (and including) this count are interest-free; juros applies above. */
    freeUpTo: number;
}

/**
 * The single card-installment rule for ALL payment kinds:
 *  - AVULSO (paid now): 1–12x, free in 1x, juros 2–12x.
 *  - FULL / à vista on a contract: 1–12x, free up to durationMonths, juros above.
 *  - A monthly installment: a single 1x charge (no splitting).
 */
export function getInstallmentPolicy(args: {
    plan?: PaymentPlan | null;
    contractType?: CheckoutContractType | string | null;
    durationMonths?: number | null;
}): InstallmentPolicy {
    const { plan, contractType, durationMonths } = args;
    if (contractType === 'AVULSO') return { maxInstallments: 12, freeUpTo: 1 };
    if (plan === 'FULL') return { maxInstallments: 12, freeUpTo: Math.max(1, durationMonths || 1) };
    return { maxInstallments: 1, freeUpTo: 1 }; // monthly installment = single 1x charge
}

/**
 * Resolve the installment-policy inputs for a Payment. Reads the linked contract when it
 * exists; for a self/SELF first payment created BEFORE its contract materializes, falls
 * back to the draft stashed in `metadata.contractData` so a FULL contract still gets 1–12x.
 */
export function policyInputsFromPayment(payment: {
    contract?: { paymentPlan?: string | null; type?: string | null; durationMonths?: number | null } | null;
    metadata?: unknown;
}): { plan?: PaymentPlan; contractType?: string; durationMonths?: number } {
    if (payment.contract) {
        return {
            plan: (payment.contract.paymentPlan as PaymentPlan) || undefined,
            contractType: payment.contract.type || undefined,
            durationMonths: payment.contract.durationMonths || undefined,
        };
    }
    const cd = (payment.metadata as { contractData?: { paymentPlan?: string; type?: string; durationMonths?: number } } | null)?.contractData;
    if (cd) return { plan: cd.paymentPlan as PaymentPlan, contractType: cd.type, durationMonths: cd.durationMonths };
    return {};
}

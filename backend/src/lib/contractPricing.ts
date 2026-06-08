// ─── Contract Pricing (single source of truth) ─────────
// Shared helpers used by EVERY contract-creation/renewal path (admin, self,
// custom, fulfillment) so pricing can never diverge between endpoints again:
//  - computeFullContractTotal: FULL upfront total (+ PIX à-vista discount)
//  - getCardInstallmentSurchargePct / applyCardInstallmentSurcharge: MONTHLY card fee
//  - computeAddonsCost: add-ons cost (after loyalty discount)

import { getConfig } from './businessConfig.js';
import { prisma } from './prisma.js';
import { applyDiscount } from '../utils/pricing.js';

/**
 * Total amount (in cents) for a FULL upfront contract payment.
 * @param basePerPeriod per-period amount WITHOUT any card surcharge (monthly or per-cycle)
 * @param periodCount number of periods (durationMonths / cycles)
 * @param paymentMethod PIX gets the à-vista discount; other methods pay the plain total
 */
export async function computeFullContractTotal(
    basePerPeriod: number,
    periodCount: number,
    paymentMethod?: string,
): Promise<number> {
    let total = basePerPeriod * periodCount;
    if (paymentMethod === 'PIX') {
        const pixDisc = await getConfig('pix_extra_discount_pct');
        total = Math.round(total * (1 - (pixDisc || 0) / 100));
    }
    return total;
}

/**
 * Card installment surcharge percentage for a given installment count.
 * Reads the central `card_installment_surcharges` JSON config (keyed by installment
 * count). Returns 0 when the config is absent, unparseable, or has no entry.
 */
export async function getCardInstallmentSurchargePct(installments: number): Promise<number> {
    const cfg = await prisma.businessConfig.findUnique({ where: { key: 'card_installment_surcharges' } });
    if (!cfg) return 0;
    try {
        const surcharges = JSON.parse(cfg.value) as Record<string, number>;
        return surcharges[String(installments)] ?? 0;
    } catch {
        return 0;
    }
}

/**
 * Apply the card installment surcharge to a per-period amount — ONLY for CARTAO.
 * Other methods (PIX/BOLETO) and a missing/zero surcharge return the amount unchanged.
 */
export async function applyCardInstallmentSurcharge(
    amount: number,
    installments: number,
    paymentMethod?: string | null,
): Promise<number> {
    if (paymentMethod !== 'CARTAO') return amount;
    const pct = await getCardInstallmentSurchargePct(installments);
    return pct > 0 ? Math.round(amount * (1 + pct / 100)) : amount;
}

/**
 * Monthly add-ons cost (in cents) after the loyalty discount.
 * A **per-episode** add-on (`monthly:false`, "Preço Por Episódio") accompanies every
 * recording, so it is charged `price × sessionsPerPeriod`. A **monthly** add-on
 * (`monthly:true`) is a flat monthly fee charged once. This keeps the charged amount
 * equal to what the wizards display (per-recording × sessions). Returns 0 for none.
 */
export async function computeAddonsCost(
    addOns: string[] | null | undefined,
    discountPct: number,
    sessionsPerPeriod = 1,
): Promise<number> {
    if (!addOns || addOns.length === 0) return 0;
    const configs = await prisma.addOnConfig.findMany({ where: { key: { in: addOns } } });
    const base = configs.reduce(
        (acc: number, c: { price: number; monthly: boolean }) => acc + (c.monthly ? c.price : c.price * sessionsPerPeriod),
        0,
    );
    return applyDiscount(base, discountPct);
}

/**
 * Per-service breakdown (in cents, after discount) for DISPLAY — the "valor por gravação"
 * the wizards/modals show. For a per-episode add-on: `perRecording` = discounted unit and
 * `perMonth` = perRecording × sessionsPerPeriod. For a monthly add-on: `perRecording` = 0
 * (N/A) and `perMonth` = the discounted flat fee. `total` = perMonth × durationMonths.
 */
export async function computeAddonsBreakdown(
    addOns: string[] | null | undefined,
    discountPct: number,
    sessionsPerPeriod: number,
    durationMonths: number,
): Promise<{ key: string; name: string; monthly: boolean; perRecordingCents: number; perMonthCents: number; totalCents: number }[]> {
    if (!addOns || addOns.length === 0) return [];
    const configs = await prisma.addOnConfig.findMany({ where: { key: { in: addOns } } });
    return configs.map(c => {
        const perRecordingCents = c.monthly ? 0 : applyDiscount(c.price, discountPct);
        const perMonthCents = c.monthly ? applyDiscount(c.price, discountPct) : perRecordingCents * sessionsPerPeriod;
        return {
            key: c.key,
            name: c.name,
            monthly: c.monthly,
            perRecordingCents,
            perMonthCents,
            totalCents: perMonthCents * durationMonths,
        };
    });
}

/**
 * Keep only the per-episode (monthly:false) add-ons among `addOns`. Monthly services
 * (e.g. GESTAO_SOCIAL, GESTAO_TRAFEGO) never ride on individual bookings, so booking
 * generation uses this to drop them by FAMILY — replacing the old hardcoded
 * `.filter(a => a !== 'GESTAO_SOCIAL')` so ANY monthly service is excluded.
 */
export async function filterPerEpisodeAddons(addOns: string[] | null | undefined): Promise<string[]> {
    if (!addOns || addOns.length === 0) return [];
    const configs = await prisma.addOnConfig.findMany({ where: { key: { in: addOns } } });
    const monthlyKeys = new Set(configs.filter(c => c.monthly).map(c => c.key));
    return addOns.filter(k => !monthlyKeys.has(k));
}

/**
 * Per-month base (in cents, after the loyalty discount) for a standalone monthly SERVICO
 * contract: the price of its monthly service add-on — NOT sessions×tier. Used by /pay and
 * renewal so service installments price correctly (a service has no recordings).
 */
export async function serviceMonthlyBase(contract: { addOns: string[]; discountPct: number }): Promise<number> {
    const serviceKey = (contract.addOns || [])[0];
    if (!serviceKey) return 0;
    const addon = await prisma.addOnConfig.findUnique({ where: { key: serviceKey } });
    if (!addon) return 0;
    return applyDiscount(addon.price, contract.discountPct);
}

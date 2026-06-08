import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/auth.js';
import { getBasePriceDynamic, applyDiscount } from '../../utils/pricing.js';
import { getConfig } from '../../lib/businessConfig.js';
import { computeAddonsCost, computeAddonsBreakdown, computeFullContractTotal } from '../../lib/contractPricing.js';
import { getInstallmentPolicy } from '../../lib/paymentPolicy.js';
import { stripeGetInstallmentPlans } from '../../lib/stripeService.js';
import { Tier } from '../../generated/prisma/client.js';

// ─── POST /api/pricing/checkout-quote ───────────────────
// Authoritative checkout numbers for the wizards/payment UI so the frontend never
// re-implements (and never diverges from) the backend payment rules. Given a contract
// draft it returns the monthly amount (no surcharge), the à-vista totals (PIX-discounted
// and card), and the card installment plans capped by the unified installment policy.
//
// The per-period base may be supplied directly (`baseMonthlyCents` — used by the custom
// wizard, whose cycle/add-on math is intrinsic) or computed here from tier×sessions×
// discount + add-ons (FIXO/FLEX/SERVICO).
const quoteSchema = z.object({
    durationMonths: z.number().int().min(1).max(12),
    contractType: z.enum(['FIXO', 'FLEX', 'CUSTOM', 'SERVICO', 'AVULSO']).optional(),
    baseMonthlyCents: z.number().int().min(0).optional(),
    tier: z.enum(['COMERCIAL', 'AUDIENCIA', 'SABADO']).optional(),
    addOns: z.array(z.string()).optional(),
    sessionsPerPeriod: z.number().int().min(1).optional(),
    discountPct: z.number().min(0).max(100).optional(),
});

export function registerQuoteRoutes(router: Router) {
    router.post('/checkout-quote', authenticate, async (req: Request, res: Response) => {
        try {
            const data = quoteSchema.parse(req.body);

            // Resolved once so the service breakdown below is consistent in both branches
            // (custom wizard passes baseMonthlyCents; FIXO/FLEX/SERVICO compute from tier).
            const resolvedDiscountPct = data.discountPct ?? (data.durationMonths >= 6
                ? await getConfig('discount_6months')
                : data.durationMonths >= 3 ? await getConfig('discount_3months') : 0);
            const resolvedSessions = data.sessionsPerPeriod ?? await getConfig('sessions_per_month');

            let baseMonthly = data.baseMonthlyCents ?? 0;
            if (data.baseMonthlyCents == null) {
                if (!data.tier) {
                    res.status(400).json({ error: 'Informe baseMonthlyCents ou tier.' });
                    return;
                }
                const basePrice = await getBasePriceDynamic(data.tier as Tier);
                const discountedPrice = applyDiscount(basePrice, resolvedDiscountPct);
                // Per-episode add-ons accompany every recording → × sessions (monthly add-ons stay flat).
                const addonsCost = await computeAddonsCost(data.addOns, resolvedDiscountPct, resolvedSessions);
                baseMonthly = (resolvedSessions * discountedPrice) + addonsCost;
            }

            // Monthly carries NO card surcharge (single 1x charge, PIX or card).
            const monthlyAmount = baseMonthly;
            const monthlyTotal = baseMonthly * data.durationMonths;
            // À-vista totals (both methods, for side-by-side display).
            const fullPix = await computeFullContractTotal(baseMonthly, data.durationMonths, 'PIX');
            const fullCard = await computeFullContractTotal(baseMonthly, data.durationMonths, 'CARTAO');

            // Card installment plans for the à-vista (FULL) option, capped by the unified policy
            // (free up to durationMonths, juros above, max 12).
            const policy = getInstallmentPolicy({
                plan: 'FULL',
                contractType: data.contractType,
                durationMonths: data.durationMonths,
            });
            const installmentPlans = (await stripeGetInstallmentPlans(fullCard, policy.freeUpTo))
                .filter(p => p.count <= policy.maxInstallments);

            // Per-service breakdown for display: "valor por gravação" + monthly/total aggregate.
            const services = await computeAddonsBreakdown(data.addOns, resolvedDiscountPct, resolvedSessions, data.durationMonths);
            const servicesPerRecordingCents = services.reduce((s, x) => s + x.perRecordingCents, 0);

            res.json({
                durationMonths: data.durationMonths,
                monthlyAmount,
                monthlyTotal,
                fullPix,
                fullCard,
                maxInstallments: policy.maxInstallments,
                freeUpTo: policy.freeUpTo,
                installmentPlans,
                services,
                servicesPerRecordingCents,
            });
        } catch (err) {
            if (err instanceof z.ZodError) {
                res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
                return;
            }
            console.error('[checkout-quote] failed:', err);
            res.status(500).json({ error: 'Erro ao calcular a cotação.' });
        }
    });
}

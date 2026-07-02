import { z } from 'zod';

// Code: 3–32 chars, letters/digits/_/- (normalized to UPPERCASE before matching).
const codeSchema = z.string().trim().min(3).max(32)
    .transform(s => s.toUpperCase())
    .refine(s => /^[A-Z0-9_-]+$/.test(s), 'Código deve conter apenas letras, números, hífen e underline.');

const baseCouponFields = {
    description: z.string().trim().max(500).optional().nullable(),
    discountType: z.enum(['VALOR', 'PERCENTUAL']),
    discountValue: z.number().int().positive(),
    scope: z.enum(['FIRST_PAYMENT', 'ALL_INSTALLMENTS']).default('FIRST_PAYMENT'),
    expiresAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
    maxUses: z.number().int().positive().optional().nullable(),
    maxUsesPerUser: z.number().int().positive().optional().nullable(),
    minAmount: z.number().int().positive().optional().nullable(),
    onlyNewClients: z.boolean().default(false),
    eligibleUserIds: z.array(z.string().uuid()).max(500).default([]),
    active: z.boolean().default(true),
};

const percentGuard = (data: { discountType: string; discountValue: number }) =>
    data.discountType !== 'PERCENTUAL' || (data.discountValue >= 1 && data.discountValue <= 100);

const eligibilityGuard = (data: { onlyNewClients: boolean; eligibleUserIds: string[] }) =>
    !(data.onlyNewClients && data.eligibleUserIds.length > 0);

export const createCouponSchema = z.object({ code: codeSchema, ...baseCouponFields })
    .refine(percentGuard, { message: 'Desconto percentual deve estar entre 1 e 100.', path: ['discountValue'] })
    .refine(eligibilityGuard, { message: 'Escolha OU clientes específicos OU apenas novos clientes — não ambos.', path: ['eligibleUserIds'] });

export const updateCouponSchema = z.object({
    description: baseCouponFields.description,
    discountType: baseCouponFields.discountType.optional(),
    discountValue: z.number().int().positive().optional(),
    scope: z.enum(['FIRST_PAYMENT', 'ALL_INSTALLMENTS']).optional(),
    expiresAt: baseCouponFields.expiresAt,
    maxUses: baseCouponFields.maxUses,
    maxUsesPerUser: baseCouponFields.maxUsesPerUser,
    minAmount: baseCouponFields.minAmount,
    onlyNewClients: z.boolean().optional(),
    eligibleUserIds: z.array(z.string().uuid()).max(500).optional(),
    active: z.boolean().optional(),
});

export const validateCouponSchema = z.object({
    code: z.string().trim().min(1).max(64),
    amount: z.number().int().positive(),
    // Admin flows evaluate eligibility for the TARGET client, not the admin.
    userId: z.string().uuid().optional(),
});

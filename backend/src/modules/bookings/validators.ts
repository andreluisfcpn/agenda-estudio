// ─── Booking Validation Schemas ─────────────────────────
// All Zod schemas for booking-related endpoints,
// extracted from routes.ts for single-responsibility.

import { z } from 'zod';

export const availabilitySchema = z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato de data inválido (YYYY-MM-DD)'),
});

export const publicAvailabilitySchema = z.object({
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato de data inválido (YYYY-MM-DD)'),
    days: z.coerce.number().int().min(1).max(14).default(7),
});

export const createBookingSchema = z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato de data inválido'),
    startTime: z.string().regex(/^\d{2}:\d{2}$/, 'Formato de hora inválido (HH:MM)'),
    contractId: z.string().uuid().optional(),
    addOns: z.array(z.string()).optional(),
    paymentMethod: z.enum(['CARTAO', 'PIX']).optional(),
    // Avulso ("paid now") may split the card into up to 12x (juros above 1x) — unified policy.
    installments: z.number().int().min(1).max(12).optional(),
    paymentType: z.enum(['CREDIT', 'DEBIT']).optional(),
    couponCode: z.string().trim().min(1).max(64).optional(),
});

export const bulkBookingSchema = z.object({
    contractId: z.string().uuid(),
    slots: z.array(z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato de data inválido'),
        startTime: z.string().regex(/^\d{2}:\d{2}$/, 'Formato de hora inválido (HH:MM)'),
    })).min(1, 'Pelo menos um horário deve ser selecionado').max(24, 'Máximo de 24 marcações por vez'),
});

export const adminCreateBookingSchema = z.object({
    userId: z.string().uuid(),
    contractId: z.string().uuid().optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato de data inválido'),
    startTime: z.string().regex(/^\d{2}:\d{2}$/, 'Formato de hora inválido (HH:MM)'),
    status: z.enum(['RESERVED', 'CONFIRMED']).optional().default('CONFIRMED'),
    addOns: z.array(z.string()).optional(),
    adminNotes: z.string().optional(),
    customPrice: z.number().int().min(0).optional(),
    paymentMethod: z.enum(['CARTAO', 'PIX', 'BOLETO']).optional().default('CARTAO'),
    couponCode: z.string().trim().min(1).max(64).optional(),
});

export const adminUpdateBookingSchema = z.object({
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
    isLivestream: z.boolean().optional().nullable(),
    streamMetrics: z.string().optional().nullable(),
});

// Finalize a recording (mark COMPLETED) capturing all session/livestream data in one call.
export const completeBookingSchema = z.object({
    durationMinutes: z.number().int().min(0).optional().nullable(),
    isLivestream: z.boolean().optional().nullable(),
    platforms: z.string().optional().nullable(),
    platformLinks: z.string().optional().nullable(),
    streamMetrics: z.string().optional().nullable(),
    audienceOrigin: z.string().optional().nullable(),
    adminNotes: z.string().optional().nullable(),
    clientNotes: z.string().optional().nullable(),
    // Optional explicit aggregates; otherwise derived from streamMetrics.
    peakViewers: z.number().int().min(0).optional().nullable(),
    chatMessages: z.number().int().min(0).optional().nullable(),
});

export const clientUpdateBookingSchema = z.object({
    clientNotes: z.string().optional(),
    episodeTitle: z.string().max(140).optional(),
    episodeDescription: z.string().max(4000).optional(),
    // Planned broadcast networks (client picks where it will air). The actual broadcast
    // LINKS are admin-only (set in the finalize/complete flow), so platformLinks is not here.
    platforms: z.string().optional(),
    durationMinutes: z.number().optional().nullable(),
    peakViewers: z.number().optional().nullable(),
    chatMessages: z.number().optional().nullable(),
    audienceOrigin: z.string().optional().nullable(),
});

export const rescheduleSchema = z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato de data inválido'),
    startTime: z.string().regex(/^\d{2}:\d{2}$/, 'Formato de hora inválido'),
});

export const addOnPurchaseSchema = z.object({
    addonKey: z.string().min(1, 'ID do serviço é obrigatório').optional(),
    addonKeys: z.array(z.string().min(1)).min(1).optional(),
}).refine(
    data => data.addonKey || (data.addonKeys && data.addonKeys.length > 0),
    { message: 'addonKey ou addonKeys é obrigatório' },
);

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
    installments: z.number().int().min(1).max(3).optional(),
    paymentType: z.enum(['CREDIT', 'DEBIT']).optional(),
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
});

export const clientUpdateBookingSchema = z.object({
    clientNotes: z.string().optional(),
    platforms: z.string().optional(),
    platformLinks: z.string().optional(),
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
    addonKey: z.string().min(1, 'ID do serviço é obrigatório'),
});

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
    statusReason: z.string().max(2000).optional().nullable(), // motivo informado em FALTA / NÃO REALIZADO
    // D4: FALTA justificada (só avulso) → abre a janela de remarcação sem novo pagamento; false desfaz.
    noShowJustified: z.boolean().optional(),
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

/** Redes em que uma gravação pode ser transmitida (mesmas chaves de `platform_<rede>_enabled` e do frontend). */
export const BOOKING_PLATFORM_KEYS = ['YOUTUBE', 'INSTAGRAM', 'FACEBOOK', 'TIKTOK'] as const;

export const EPISODE_TITLE_MAX = 140;
export const EPISODE_DESCRIPTION_MAX = 4000;

// Redes planejadas pelo cliente: string JSON com um array de chaves conhecidas (é assim que a coluna
// Booking.platforms guarda). Normaliza (sem repetição, ordem fixa) e recusa qualquer outra coisa —
// antes a rota aceitava qualquer texto.
const clientPlatformsSchema = z
    .string({ invalid_type_error: 'Redes de transmissão inválidas.' })
    .max(400, 'Redes de transmissão inválidas.')
    .transform((raw, ctx) => {
        let parsed: unknown;
        try { parsed = JSON.parse(raw); } catch { parsed = undefined; }
        const known = BOOKING_PLATFORM_KEYS as readonly string[];
        if (!Array.isArray(parsed) || !parsed.every(k => typeof k === 'string' && known.includes(k))) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Redes de transmissão inválidas.' });
            return z.NEVER;
        }
        return JSON.stringify(known.filter(k => (parsed as string[]).includes(k)));
    });

// O que o CLIENTE edita na própria gravação (E12): título, descrição e redes planejadas (a capa vai
// pelo upload). Texto vazio (ou null) limpa o campo. Campos fora desta lista são ignorados:
//   - clientNotes é o feedback do ESTÚDIO ao cliente (escrito na finalização) — só leitura aqui;
//   - métricas e links da transmissão são registrados pelo estúdio (PUT /:id/complete, PATCH /:id).
export const clientUpdateBookingSchema = z.object({
    episodeTitle: z
        .string({ invalid_type_error: 'Título inválido.' })
        .transform(v => v.replace(/\s+/g, ' ').trim()) // título é uma linha só
        .pipe(z.string().max(EPISODE_TITLE_MAX, `O título pode ter no máximo ${EPISODE_TITLE_MAX} caracteres.`))
        .nullable()
        .optional()
        .transform(v => (v === undefined ? undefined : v || null)),
    episodeDescription: z
        .string({ invalid_type_error: 'Descrição inválida.' })
        .transform(v => v.trim())
        .pipe(z.string().max(EPISODE_DESCRIPTION_MAX, `A descrição pode ter no máximo ${EPISODE_DESCRIPTION_MAX} caracteres.`))
        .nullable()
        .optional()
        .transform(v => (v === undefined ? undefined : v || null)),
    platforms: clientPlatformsSchema.optional(),
});

export const rescheduleSchema = z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato de data inválido'),
    startTime: z.string().regex(/^\d{2}:\d{2}$/, 'Formato de hora inválido'),
});

// Remarcação da gravação perdida do avulso (FALTA justificada / NÃO REALIZADO) — mesmo formato.
export const makeupSchema = rescheduleSchema;

export const addOnPurchaseSchema = z.object({
    addonKey: z.string().min(1, 'ID do serviço é obrigatório').optional(),
    addonKeys: z.array(z.string().min(1)).min(1).optional(),
}).refine(
    data => data.addonKey || (data.addonKeys && data.addonKeys.length > 0),
    { message: 'addonKey ou addonKeys é obrigatório' },
);

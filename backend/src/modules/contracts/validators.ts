import { z } from 'zod';
import { ContractType, Tier, PaymentMethod } from '../../generated/prisma/client';

// ─── CREATE (Admin) ─────────────────────────────────────

export const createContractSchema = z.object({
    userId: z.string().uuid('ID de usuário inválido'),
    name: z.string().min(1, 'Nome do projeto é obrigatório'),
    type: z.nativeEnum(ContractType),
    tier: z.nativeEnum(Tier),
    durationMonths: z.number().refine(v => v === 3 || v === 6, 'Duração deve ser 3 ou 6 meses'),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato de data inválido'),
    // Fixo-specific
    fixedDayOfWeek: z.number().min(1).max(6).optional(), // 1=Mon, 6=Sat
    fixedTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    contractUrl: z.string().url().optional().or(z.literal('')),
    addOns: z.array(z.string()).optional(),
    resolvedConflicts: z.array(z.object({
        originalDate: z.string(),
        originalTime: z.string(),
        newDate: z.string(),
        newTime: z.string(),
    })).optional(),
});

// ─── CHECK FIXO ─────────────────────────────────────────

export const checkFixoSchema = z.object({
    tier: z.nativeEnum(Tier),
    durationMonths: z.number().refine(v => v === 3 || v === 6, 'Duração deve ser 3 ou 6 meses'),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato de data inválido'),
    fixedDayOfWeek: z.number().min(1).max(6),
    fixedTime: z.string().regex(/^\d{2}:\d{2}$/, 'Formato de hora inválido (HH:MM)'),
});

// ─── SELF (Client) ──────────────────────────────────────

export const selfContractSchema = z.object({
    name: z.string().min(1, 'Nome do projeto é obrigatório'),
    type: z.nativeEnum(ContractType),
    tier: z.nativeEnum(Tier),
    durationMonths: z.number().refine(v => v === 3 || v === 6, 'Duração deve ser 3 ou 6 meses'),
    firstBookingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato de data inválido'),
    firstBookingTime: z.string().regex(/^\d{2}:\d{2}$/, 'Formato de horário inválido'),
    fixedDayOfWeek: z.number().min(1).max(6).optional(),
    fixedTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    paymentMethod: z.nativeEnum(PaymentMethod),
    addOns: z.array(z.string()).optional(),
    resolvedConflicts: z.array(z.object({
        originalDate: z.string(),
        originalTime: z.string(),
        newDate: z.string(),
        newTime: z.string()
    })).optional(),
});

// ─── CUSTOM CHECK ───────────────────────────────────────

export const customCheckSchema = z.object({
    tier: z.nativeEnum(Tier),
    durationMonths: z.number().min(1).max(12),
    schedule: z.array(z.object({
        day: z.number().min(1).max(6), // 1=Mon..6=Sat
        time: z.string().regex(/^\d{2}:\d{2}$/),
    })).min(1, 'Selecione pelo menos um dia'),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

// ─── CUSTOM CONTRACT ────────────────────────────────────

export const customContractSchema = z.object({
    name: z.string().min(1, 'Nome do projeto é obrigatório'),
    tier: z.nativeEnum(Tier),
    durationMonths: z.number().min(1).max(12),
    schedule: z.array(z.object({
        day: z.number().min(0).max(6),
        time: z.string().regex(/^\d{2}:\d{2}$/),
    })).optional().default([]),
    paymentMethod: z.nativeEnum(PaymentMethod),
    addOns: z.array(z.string()).optional(),
    addonConfig: z.record(z.string(), z.object({
        mode: z.enum(['all', 'credits']),
        perCycle: z.number().optional(),
    })).optional(),
    resolvedConflicts: z.array(z.object({
        originalDate: z.string(),
        originalTime: z.string(),
        newDate: z.string(),
        newTime: z.string(),
    })).optional(),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    userId: z.string().uuid().optional(),
    // Enhanced scheduling
    frequency: z.enum(['WEEKLY', 'BIWEEKLY', 'MONTHLY', 'CUSTOM']).default('WEEKLY'),
    weekPattern: z.array(z.number().min(1).max(5)).optional(), // e.g. [1,3] = weeks 1 & 3
    customDates: z.array(z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        time: z.string().regex(/^\d{2}:\d{2}$/),
    })).optional(),
});

// ─── UPDATE (Admin) ─────────────────────────────────────

export const updateContractSchema = z.object({
    status: z.enum(['ACTIVE', 'EXPIRED', 'CANCELLED']).optional(),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    flexCreditsRemaining: z.number().int().min(0).optional(),
    contractUrl: z.string().url().optional().or(z.literal('')),
    paymentMethod: z.nativeEnum(PaymentMethod).optional(),
});

// ─── RESOLVE CANCELLATION ───────────────────────────────

export const resolveCancellationSchema = z.object({
    action: z.enum(['CHARGE_FEE', 'WAIVE_FEE']),
});

// ─── SERVICE ────────────────────────────────────────────

export const serviceContractSchema = z.object({
    serviceKey: z.string(),
    paymentMethod: z.nativeEnum(PaymentMethod),
    durationMonths: z.number().int().optional(),
});

// ─── PAY ────────────────────────────────────────────────

export const contractPaySchema = z.object({
    paymentType: z.enum(['CREDIT', 'DEBIT']).optional(),
    installments: z.number().int().min(1).max(12).optional(),
});

// ─── SUBSCRIBE ──────────────────────────────────────────

export const subscribeSchema = z.object({
    paymentMethodId: z.string().min(1, 'Payment Method ID obrigatório'),
    durationMonths: z.number().int().min(1).max(12).optional(),
});

// ─── CLIENT RENEW ───────────────────────────────────────

export const clientRenewSchema = z.object({
    durationMonths: z.number().int().min(1).max(12),
    paymentMethod: z.enum(['PIX', 'CARTAO', 'BOLETO']).optional(),
    installments: z.number().int().min(1).max(12).optional(),
});

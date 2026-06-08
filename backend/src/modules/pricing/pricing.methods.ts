import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { authenticate, authorize } from '../../middleware/auth.js';

export function registerMethodsRoutes(router: Router) {
    // ─── GET /api/pricing/addons (public — active only) ─────

    router.get('/addons', async (_req: Request, res: Response) => {
        const addons = await prisma.addOnConfig.findMany({
            where: { active: true },
            orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }],
        });
        res.json({ addons });
    });

    // ─── GET /api/pricing/addons/all (ADMIN — includes inactive) ───

    router.get('/addons/all', authenticate, authorize('ADMIN'), async (_req: Request, res: Response) => {
        const addons = await prisma.addOnConfig.findMany({
            orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }],
        });
        res.json({ addons });
    });

    // ─── PUT /api/pricing/addons (ADMIN) — batch upsert (create + edit) ──

    const addonItemSchema = z.object({
        key: z.string().min(1).regex(/^[A-Z0-9_]+$/, 'Use apenas MAIÚSCULAS, números e _'),
        name: z.string().min(1),
        price: z.number().int().min(0),
        // These columns are nullable in the DB and come back as `null` from GET /addons/all
        // (e.g. per-episode services have benefits=null). Accept null so a round-trip save
        // doesn't 400 — that was the "salvar não funciona" bug.
        description: z.string().nullable().optional(),
        monthly: z.boolean().optional().default(false),
        active: z.boolean().optional().default(true),
        sortOrder: z.number().int().min(0).optional().default(0),
        icon: z.string().nullable().optional(),
        showOnLanding: z.boolean().optional().default(true),
        benefits: z.string().nullable().optional(), // JSON string[]
        durationsOffered: z.string().optional().default('3,6'),
        plansAllowed: z.string().optional().default('FULL'),
        billingCadence: z.enum(['BILLING_CYCLE_28', 'CALENDAR_MONTH']).optional().default('BILLING_CYCLE_28'),
    });
    const updateAddonsSchema = z.object({ addons: z.array(addonItemSchema) });

    router.put('/addons', authenticate, authorize('ADMIN'), async (req: Request, res: Response) => {
        try {
            const { addons } = updateAddonsSchema.parse(req.body);

            // All-or-nothing: a mid-batch failure must not leave the catalog half-applied.
            const results = await prisma.$transaction(
                addons.map(({ key, ...data }) =>
                    prisma.addOnConfig.upsert({ where: { key }, create: { key, ...data }, update: data })
                )
            );

            res.json({
                addons: results,
                message: 'Serviços atualizados com sucesso!',
            });
        } catch (err) {
            if (err instanceof z.ZodError) {
                res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
                return;
            }
            throw err;
        }
    });

    // ─── DELETE /api/pricing/addons/:key (ADMIN) — soft-delete if referenced ──
    // Contract.addOns / Booking.addOns store keys by reference (no FK). Hard-deleting a
    // referenced service would orphan pricing/display lookups, so we soft-delete
    // (active=false) when anything points at it and only hard-delete when truly unused.

    router.delete('/addons/:key', authenticate, authorize('ADMIN'), async (req: Request, res: Response) => {
        const key = req.params.key as string;
        const existing = await prisma.addOnConfig.findUnique({ where: { key } });
        if (!existing) {
            res.status(404).json({ error: 'Serviço não encontrado.' });
            return;
        }

        const [contractRefs, bookingRefs] = await Promise.all([
            prisma.contract.count({ where: { addOns: { has: key } } }),
            prisma.booking.count({ where: { addOns: { has: key } } }),
        ]);

        if (contractRefs > 0 || bookingRefs > 0) {
            const config = await prisma.addOnConfig.update({ where: { key }, data: { active: false } });
            res.json({
                addon: config,
                softDeleted: true,
                message: 'Serviço desativado — há contratos/agendamentos vinculados, então ele não foi removido permanentemente.',
            });
            return;
        }

        await prisma.addOnConfig.delete({ where: { key } });
        res.json({ softDeleted: false, message: 'Serviço removido com sucesso.' });
    });

    // ─── GET /api/pricing/payment-methods (public) ──────────
    // Returns ONLY methods that are active AND whose provider (Stripe/Cora) is enabled.

    router.get('/payment-methods', async (_req: Request, res: Response) => {
        try {
            const { getAvailablePaymentMethods } = await import('../../lib/paymentGateway.js');
            const methods = await getAvailablePaymentMethods();

            // If no configs exist yet, return hardcoded defaults
            if (methods.length === 0) {
                res.json({
                    methods: [
                        { key: 'PIX', label: 'PIX', shortLabel: 'PIX', emoji: '⚡', description: 'Pagamento instantâneo', color: '#22c55e', active: true, sortOrder: 0, accessMode: 'FULL' },
                        { key: 'CARTAO', label: 'Cartão de Crédito', shortLabel: 'Cartão', emoji: '💳', description: 'Crédito ou débito', color: '#8b5cf6', active: true, sortOrder: 1, accessMode: 'FULL' },
                        { key: 'BOLETO', label: 'Boleto Bancário', shortLabel: 'Boleto', emoji: '📄', description: 'Compensação em até 3 dias úteis', color: '#f59e0b', active: true, sortOrder: 2, accessMode: 'PROGRESSIVE' },
                    ],
                });
                return;
            }

            res.json({ methods });
        } catch (err) {
            res.status(500).json({ error: 'Erro ao carregar métodos de pagamento.' });
        }
    });

    // ─── GET /api/pricing/payment-methods/all (ADMIN — includes inactive) ───

    router.get('/payment-methods/all', authenticate, authorize('ADMIN'), async (_req: Request, res: Response) => {
        try {
            const methods = await prisma.paymentMethodConfig.findMany({
                orderBy: { sortOrder: 'asc' },
            });

            // If no configs exist, seed defaults and return them
            if (methods.length === 0) {
                const defaults = [
                    { key: 'PIX', label: 'PIX', shortLabel: 'PIX', emoji: '⚡', description: 'Pagamento instantâneo', color: '#22c55e', active: true, sortOrder: 0, accessMode: 'FULL' },
                    { key: 'CARTAO', label: 'Cartão de Crédito', shortLabel: 'Cartão', emoji: '💳', description: 'Crédito ou débito', color: '#8b5cf6', active: true, sortOrder: 1, accessMode: 'FULL' },
                    { key: 'BOLETO', label: 'Boleto Bancário', shortLabel: 'Boleto', emoji: '📄', description: 'Compensação em até 3 dias úteis', color: '#f59e0b', active: true, sortOrder: 2, accessMode: 'PROGRESSIVE' },
                ];
                for (const d of defaults) {
                    await prisma.paymentMethodConfig.create({ data: d });
                }
                res.json({ methods: defaults });
                return;
            }

            res.json({ methods });
        } catch (err) {
            res.status(500).json({ error: 'Erro ao carregar métodos de pagamento.' });
        }
    });

    // ─── PUT /api/pricing/payment-methods (ADMIN) ───────────

    const updatePaymentMethodsSchema = z.object({
        methods: z.array(z.object({
            key: z.string().min(1),
            label: z.string().min(1).max(100),
            shortLabel: z.string().min(1).max(50),
            emoji: z.string().min(1).max(10),
            description: z.string().max(300).optional().default(''),
            color: z.string().min(1).max(30),
            active: z.boolean(),
            sortOrder: z.number().int().min(0),
            accessMode: z.enum(['FULL', 'PROGRESSIVE']),
            contexts: z.string().optional().default('avulso,contract,invoice'),
        })),
    });

    router.put('/payment-methods', authenticate, authorize('ADMIN'), async (req: Request, res: Response) => {
        try {
            const { methods } = updatePaymentMethodsSchema.parse(req.body);

            const results = [];
            for (const item of methods) {
                const config = await prisma.paymentMethodConfig.upsert({
                    where: { key: item.key },
                    create: item,
                    update: {
                        label: item.label,
                        shortLabel: item.shortLabel,
                        emoji: item.emoji,
                        description: item.description,
                        color: item.color,
                        active: item.active,
                        sortOrder: item.sortOrder,
                        accessMode: item.accessMode,
                        contexts: item.contexts,
                    },
                });
                results.push(config);
            }

            res.json({
                methods: results,
                message: 'Métodos de pagamento atualizados com sucesso!',
            });
        } catch (err) {
            if (err instanceof z.ZodError) {
                res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
                return;
            }
            res.status(500).json({ error: 'Erro ao salvar métodos de pagamento.' });
        }
    });
}

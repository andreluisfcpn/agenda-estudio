import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { authenticate, authorize } from '../../middleware/auth';
import { getAllConfigs, invalidateConfigCache } from '../../lib/businessConfig';

const router = Router();

// ─── GET /api/pricing ───────────────────────────────────

router.get('/', async (_req: Request, res: Response) => {
    const configs = await prisma.pricingConfig.findMany({
        orderBy: { tier: 'asc' },
    });

    // If no configs exist, return defaults
    if (configs.length === 0) {
        res.json({
            pricing: [
                { tier: 'COMERCIAL', price: 30000, label: 'Comercial', description: '' },
                { tier: 'AUDIENCIA', price: 40000, label: 'Audiência', description: '' },
                { tier: 'SABADO', price: 50000, label: 'Sábado', description: '' },
            ],
        });
        return;
    }

    res.json({ pricing: configs });
});

// ─── PUT /api/pricing (ADMIN) ───────────────────────────

const updatePricingSchema = z.object({
    pricing: z.array(
        z.object({
            tier: z.enum(['COMERCIAL', 'AUDIENCIA', 'SABADO']),
            price: z.number().int().min(0),
            label: z.string().min(1).max(50),
            description: z.string().max(500).optional().default(''),
        })
    ),
});

router.put('/', authenticate, authorize('ADMIN'), async (req: Request, res: Response) => {
    try {
        const { pricing } = updatePricingSchema.parse(req.body);

        const results = [];
        for (const item of pricing) {
            const config = await prisma.pricingConfig.upsert({
                where: { tier: item.tier },
                create: { tier: item.tier, price: item.price, label: item.label, description: item.description },
                update: { price: item.price, label: item.label, description: item.description },
            });
            results.push(config);
        }

        res.json({
            pricing: results,
            message: 'Preços atualizados com sucesso!',
        });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        throw err;
    }
});

// ─── GET /api/pricing/addons ────────────────────────────

router.get('/addons', async (_req: Request, res: Response) => {
    const addons = await prisma.addOnConfig.findMany({
        orderBy: { key: 'asc' },
    });
    res.json({ addons });
});

// ─── PUT /api/pricing/addons (ADMIN) ────────────────────

const updateAddonsSchema = z.object({
    addons: z.array(
        z.object({
            key: z.string().min(1),
            name: z.string().min(1),
            price: z.number().int().min(0),
            description: z.string().optional().default(''),
        })
    ),
});

router.put('/addons', authenticate, authorize('ADMIN'), async (req: Request, res: Response) => {
    try {
        const { addons } = updateAddonsSchema.parse(req.body);

        const results = [];
        for (const item of addons) {
            const config = await prisma.addOnConfig.update({
                where: { key: item.key },
                data: { name: item.name, price: item.price, description: item.description },
            });
            results.push(config);
        }

        res.json({
            addons: results,
            message: 'Add-ons atualizados com sucesso!',
        });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        throw err;
    }
});

// ─── GET /api/pricing/business-config/public (no auth, client-facing) ──────

router.get('/business-config/public', async (_req: Request, res: Response) => {
    try {
        const rows = await prisma.businessConfig.findMany({ orderBy: { key: 'asc' } });
        // Return as a simple key→value map (string values preserved, numbers parsed)
        const config: Record<string, string | number> = {};
        for (const row of rows) {
            config[row.key] = row.type === 'string' ? row.value : parseFloat(row.value);
        }
        res.json({ config });
    } catch (err) {
        res.status(500).json({ error: 'Erro ao carregar configurações.' });
    }
});

// ─── GET /api/pricing/business-config (ADMIN) ───────────

router.get('/business-config', authenticate, authorize('ADMIN'), async (_req: Request, res: Response) => {
    try {
        const rows = await prisma.businessConfig.findMany({ orderBy: { group: 'asc' } });
        const grouped: Record<string, typeof rows> = {};
        for (const row of rows) {
            if (!grouped[row.group]) grouped[row.group] = [];
            grouped[row.group].push(row);
        }
        res.json({ configs: rows, grouped });
    } catch (err) {
        res.status(500).json({ error: 'Erro ao carregar configurações.' });
    }
});

// ─── PUT /api/pricing/business-config (ADMIN) ───────────

const updateBusinessConfigSchema = z.object({
    configs: z.array(z.object({
        key: z.string().min(1),
        value: z.string().min(1),
    })),
});

router.put('/business-config', authenticate, authorize('ADMIN'), async (req: Request, res: Response) => {
    try {
        const { configs } = updateBusinessConfigSchema.parse(req.body);

        for (const { key, value } of configs) {
            await prisma.businessConfig.update({
                where: { key },
                data: { value },
            });
        }

        // Bust the in-memory cache so next requests pick up new values
        invalidateConfigCache();

        res.json({ message: 'Configurações atualizadas com sucesso!' });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        res.status(500).json({ error: 'Erro ao salvar configurações.' });
    }
});

// ─── GET /api/pricing/payment-methods (public) ──────────

router.get('/payment-methods', async (_req: Request, res: Response) => {
    try {
        const methods = await prisma.paymentMethodConfig.findMany({
            where: { active: true },
            orderBy: { sortOrder: 'asc' },
        });

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

export default router;

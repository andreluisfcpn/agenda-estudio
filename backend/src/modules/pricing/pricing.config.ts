import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { authenticate, authorize } from '../../middleware/auth.js';
import { invalidateConfigCache } from '../../lib/businessConfig.js';

export function registerConfigRoutes(router: Router) {
    // ─── GET /api/pricing/business-config/public (no auth, client-facing) ──────

    router.get('/business-config/public', async (_req: Request, res: Response) => {
        try {
            const rows = await prisma.businessConfig.findMany({ orderBy: { key: 'asc' } });
            // Return as a simple key→value map (string values preserved, numbers parsed, JSON parsed)
            const config: Record<string, string | number | Record<string, number>> = {};
            for (const row of rows) {
                if (row.type === 'json') {
                    try { config[row.key] = JSON.parse(row.value); } catch { config[row.key] = row.value; }
                } else {
                    config[row.key] = row.type === 'string' ? row.value : parseFloat(row.value);
                }
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
}

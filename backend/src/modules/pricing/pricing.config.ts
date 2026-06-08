import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { authenticate, authorize } from '../../middleware/auth.js';
import { invalidateConfigCache } from '../../lib/businessConfig.js';
import { BUSINESS_CONFIG_CATALOG, CONFIG_CATALOG_BY_KEY, DEPRECATED_CONFIG_KEYS } from '../../config/businessConfigCatalog.js';

export function registerConfigRoutes(router: Router) {
    // ─── GET /api/pricing/business-config/public (no auth, client-facing) ──────

    router.get('/business-config/public', async (_req: Request, res: Response) => {
        try {
            const rows = await prisma.businessConfig.findMany({ orderBy: { key: 'asc' } });
            // Return as a simple key→value map (string values preserved, numbers parsed, JSON parsed)
            const config: Record<string, string | number | Record<string, number>> = {};
            for (const row of rows) {
                if (DEPRECATED_CONFIG_KEYS.has(row.key)) continue; // retired keys never ship to clients
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
            const byKey = new Map(rows.map(r => [r.key, r]));

            // Merge the catalog so the admin SEES & can EDIT every known key, even
            // ones not yet persisted (they show with their default value).
            const merged = [
                ...BUSINESS_CONFIG_CATALOG.map(c => {
                    const row = byKey.get(c.key);
                    return {
                        key: c.key,
                        value: row?.value ?? c.value, // DB value wins (admin edits persist)
                        // Catalog is the single source for metadata — fixes keys whose
                        // persisted rows were seeded with a stale group/label/type.
                        type: c.type,
                        label: c.label,
                        group: c.group,
                    };
                }),
                // Any DB rows not described by the catalog (legacy keys), excluding
                // retired ones so they disappear from the admin UI even if still in the DB.
                ...rows.filter(r => !CONFIG_CATALOG_BY_KEY[r.key] && !DEPRECATED_CONFIG_KEYS.has(r.key)).map(r => ({
                    key: r.key, value: r.value, type: r.type, label: r.label, group: r.group,
                })),
            ];

            const grouped: Record<string, typeof merged> = {};
            for (const row of merged) {
                if (!grouped[row.group]) grouped[row.group] = [];
                grouped[row.group].push(row);
            }
            res.json({ configs: merged, grouped });
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
                if (DEPRECATED_CONFIG_KEYS.has(key)) continue; // ignore retired keys
                // Upsert so editing a catalog key that isn't persisted yet creates it
                // (with its catalog metadata) instead of failing.
                const meta = CONFIG_CATALOG_BY_KEY[key];
                await prisma.businessConfig.upsert({
                    where: { key },
                    update: { value },
                    create: {
                        key,
                        value,
                        type: meta?.type ?? 'string',
                        label: meta?.label ?? key,
                        group: meta?.group ?? 'outros',
                    },
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

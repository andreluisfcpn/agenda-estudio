// ─── Integration Management Routes (ADMIN) ─────────────
// CRUD for payment provider configurations (Cora, Stripe)
// Stores credentials in IntegrationConfig table

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { authenticate, authorize } from '../../middleware/auth.js';
import { coraTestConnection } from '../../lib/coraService.js';
import { stripeTestConnection } from '../../lib/stripeService.js';
import { encryptCredentials, decryptConfigSafe } from '../../utils/crypto.js';
import { maskConfig } from './integrations.masking.js';

// ─── Schemas ─────────────────────────────────────────────

const VALID_PROVIDERS = ['CORA', 'STRIPE'] as const;

const saveIntegrationSchema = z.object({
    environment: z.enum(['sandbox', 'production']).default('sandbox'),
    enabled: z.boolean().optional(),
    config: z.record(z.string(), z.any()),
});

export function registerIntegrationRoutes(router: Router) {

// ─── GET /api/integrations ──────────────────────────────
// List all integrations (masked credentials)

router.get('/', authenticate, authorize('ADMIN'), async (_req: Request, res: Response) => {
    try {
        const integrations = await prisma.integrationConfig.findMany({
            orderBy: { provider: 'asc' },
        });

        // Build response with defaults for unconfigured providers
        const result = VALID_PROVIDERS.map(provider => {
            const existing = integrations.find((i: any) => i.provider === provider);

            if (existing) {
                let parsedConfig: Record<string, any> = {};
                try {
                    const decrypted = decryptConfigSafe(existing.config);
                    parsedConfig = JSON.parse(decrypted);
                } catch { /* empty */ }

                return {
                    provider: existing.provider,
                    enabled: existing.enabled,
                    environment: existing.environment,
                    config: maskConfig(existing.provider, parsedConfig),
                    configured: true,
                    webhookUrl: existing.webhookUrl,
                    lastTestedAt: existing.lastTestedAt?.toISOString() || null,
                    testStatus: existing.testStatus,
                    testMessage: existing.testMessage,
                };
            }

            return {
                provider,
                enabled: false,
                environment: 'sandbox',
                config: {},
                configured: false,
                webhookUrl: null,
                lastTestedAt: null,
                testStatus: null,
                testMessage: null,
            };
        });

        res.json({ integrations: result });
    } catch (err) {
        console.error('Error listing integrations:', err);
        res.status(500).json({ error: 'Erro ao listar integrações.' });
    }
});

// ─── GET /api/integrations/:provider ────────────────────

router.get('/:provider', authenticate, authorize('ADMIN'), async (req: Request, res: Response) => {
    const provider = (req.params.provider as string)?.toUpperCase();
    if (!VALID_PROVIDERS.includes(provider as any)) {
        res.status(400).json({ error: 'Provider inválido. Use CORA ou STRIPE.' });
        return;
    }

    const integration = await prisma.integrationConfig.findUnique({
        where: { provider },
    });

    if (!integration) {
        res.json({
            integration: {
                provider,
                enabled: false,
                environment: 'sandbox',
                config: {},
                configured: false,
                webhookUrl: null,
                lastTestedAt: null,
                testStatus: null,
                testMessage: null,
            },
        });
        return;
    }

    let parsedConfig: Record<string, any> = {};
    try {
        const decrypted = decryptConfigSafe(integration.config);
        parsedConfig = JSON.parse(decrypted);
    } catch { /* empty */ }

    res.json({
        integration: {
            provider: integration.provider,
            enabled: integration.enabled,
            environment: integration.environment,
            config: maskConfig(integration.provider, parsedConfig),
            configured: true,
            webhookUrl: integration.webhookUrl,
            lastTestedAt: integration.lastTestedAt?.toISOString() || null,
            testStatus: integration.testStatus,
            testMessage: integration.testMessage,
        },
    });
});

// ─── PUT /api/integrations/:provider ────────────────────
// Save/update integration credentials

router.put('/:provider', authenticate, authorize('ADMIN'), async (req: Request, res: Response) => {
    try {
        const provider = (req.params.provider as string)?.toUpperCase();
        if (!VALID_PROVIDERS.includes(provider as any)) {
            res.status(400).json({ error: 'Provider inválido.' });
            return;
        }

        const data = saveIntegrationSchema.parse(req.body);

        // Stripe key sanity: reject swapped/empty keys early with a clear message
        // so the client checkout never ends up with a broken publishable key.
        if (provider === 'STRIPE') {
            const isReal = (v: any) => typeof v === 'string' && v && !v.includes('...') && !v.startsWith('***');
            const checkSub = (sub: any, envLabel: string): string | null => {
                if (!sub) return null;
                if (isReal(sub.secretKey) && !/^(sk|rk)_/.test(sub.secretKey)) {
                    return `A Secret Key (${envLabel}) deve começar com "sk_" (ou "rk_" para chave restrita). Verifique se você não inverteu os campos.`;
                }
                if (isReal(sub.publishableKey) && !sub.publishableKey.startsWith('pk_')) {
                    return `A Publishable Key (${envLabel}) deve começar com "pk_" (não a sk_). Verifique se você não inverteu os campos.`;
                }
                return null;
            };
            let keyErr: string | null = null;
            if ((data.config as any).sandbox || (data.config as any).production) {
                keyErr = checkSub((data.config as any).sandbox, 'sandbox') || checkSub((data.config as any).production, 'produção');
            } else {
                keyErr = checkSub(data.config, 'atual');
            }
            if (keyErr) {
                res.status(400).json({ error: keyErr });
                return;
            }
        }

        // Generate webhook URL
        const baseUrl = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 3001}`;
        const webhookUrl = `${baseUrl}/api/webhooks/${provider.toLowerCase()}`;

        // Merge with existing config to preserve omitted sensitive fields
        const existing = await prisma.integrationConfig.findUnique({ where: { provider } });
        let mergedConfig = data.config;
        if (existing) {
            try {
                const decryptedExisting = decryptConfigSafe(existing.config);
                const existingConfig = JSON.parse(decryptedExisting);

                const hasDualFormat = data.config.sandbox || data.config.production;
                if (hasDualFormat) {
                    // Dual format (Cora or Stripe): merge each environment sub-object individually
                    mergedConfig = { ...existingConfig };
                    for (const env of ['sandbox', 'production'] as const) {
                        const incoming = data.config[env] as Record<string, any> | undefined;
                        if (!incoming) continue;
                        const existingSub = (existingConfig[env] || {}) as Record<string, any>;
                        const merged: Record<string, any> = { ...existingSub };
                        for (const [key, value] of Object.entries(incoming)) {
                            // Skip empty, null, undefined values
                            if (value === undefined || value === null || value === '') continue;
                            // Skip masked values sent back from the frontend (e.g. 'int-1bk...bsHJ', '***CERTIFICATE_CONFIGURED***')
                            if (typeof value === 'string' && (value.includes('...') || value.startsWith('***'))) continue;
                            merged[key] = value;
                        }
                        mergedConfig[env] = merged;
                    }
                } else {
                    // Flat format (legacy)
                    mergedConfig = { ...existingConfig };
                    for (const [key, value] of Object.entries(data.config)) {
                        if (value === undefined || value === null || value === '') continue;
                        if (typeof value === 'string' && (value.includes('...') || value.startsWith('***'))) continue;
                        mergedConfig[key] = value;
                    }
                }
            } catch { /* existing config parse failed, use new config */ }
        }

        const encryptedConfig = encryptCredentials(JSON.stringify(mergedConfig));

        const result = await prisma.integrationConfig.upsert({
            where: { provider },
            create: {
                provider,
                enabled: data.enabled ?? false,
                environment: data.environment,
                config: encryptedConfig,
                webhookUrl,
            },
            update: {
                enabled: data.enabled ?? undefined,
                environment: data.environment,
                config: encryptedConfig,
                webhookUrl,
                // Reset test status when config changes
                testStatus: null,
                testMessage: null,
                lastTestedAt: null,
            },
        });

        let parsedConfig: Record<string, any> = {};
        try {
            const decrypted = decryptConfigSafe(result.config);
            parsedConfig = JSON.parse(decrypted);
        } catch { /* empty */ }

        res.json({
            integration: {
                provider: result.provider,
                enabled: result.enabled,
                environment: result.environment,
                config: maskConfig(result.provider, parsedConfig),
                configured: true,
                webhookUrl: result.webhookUrl,
                lastTestedAt: result.lastTestedAt?.toISOString() || null,
                testStatus: result.testStatus,
                testMessage: result.testMessage,
            },
            message: `Integração ${provider} salva com sucesso!`,
        });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        console.error('Error saving integration:', err);
        res.status(500).json({ error: 'Erro ao salvar integração.' });
    }
});

// ─── POST /api/integrations/:provider/test ──────────────
// Test connectivity for a provider

router.post('/:provider/test', authenticate, authorize('ADMIN'), async (req: Request, res: Response) => {
    const provider = (req.params.provider as string)?.toUpperCase();
    if (!VALID_PROVIDERS.includes(provider as any)) {
        res.status(400).json({ error: 'Provider inválido.' });
        return;
    }

    const integration = await prisma.integrationConfig.findUnique({ where: { provider } });
    if (!integration) {
        res.status(400).json({ error: `Integração ${provider} não configurada. Salve as credenciais primeiro.` });
        return;
    }

    let result: { success: boolean; message: string };

    if (provider === 'CORA') {
        result = await coraTestConnection();
    } else if (provider === 'STRIPE') {
        result = await stripeTestConnection();
    } else {
        result = { success: false, message: 'Provider desconhecido' };
    }

    // Update test status in DB
    await prisma.integrationConfig.update({
        where: { provider },
        data: {
            lastTestedAt: new Date(),
            testStatus: result.success ? 'success' : 'error',
            testMessage: result.message,
        },
    });

    res.json(result);
});

// ─── POST /api/integrations/:provider/toggle ────────────
// Enable/disable a provider

router.post('/:provider/toggle', authenticate, authorize('ADMIN'), async (req: Request, res: Response) => {
    const provider = (req.params.provider as string)?.toUpperCase();
    if (!VALID_PROVIDERS.includes(provider as any)) {
        res.status(400).json({ error: 'Provider inválido.' });
        return;
    }

    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
        res.status(400).json({ error: 'Campo "enabled" (boolean) é obrigatório.' });
        return;
    }

    const integration = await prisma.integrationConfig.findUnique({ where: { provider } });
    if (!integration) {
        res.status(400).json({ error: `Integração ${provider} não configurada.` });
        return;
    }

    await prisma.integrationConfig.update({
        where: { provider },
        data: { enabled },
    });

    res.json({ message: `Integração ${provider} ${enabled ? 'ativada' : 'desativada'}.` });
});

}

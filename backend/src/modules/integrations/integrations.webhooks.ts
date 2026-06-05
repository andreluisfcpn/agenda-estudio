// ─── Cora Webhook Management Routes (ADMIN) ─────────────
// Register/list/delete Cora webhook endpoints

import { Router, Request, Response } from 'express';
import { authenticate, authorize } from '../../middleware/auth.js';
import { coraListWebhookEndpoints, coraRegisterWebhookEndpoint, coraDeleteWebhookEndpoint } from '../../lib/coraService.js';

export function registerIntegrationWebhookRoutes(router: Router) {

/** GET /api/integrations/cora/webhooks — list registered webhooks */
router.get('/cora/webhooks', authenticate, authorize('ADMIN'), async (_req: Request, res: Response) => {
    try {
        const endpoints = await coraListWebhookEndpoints();
        res.json({ endpoints });
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Erro desconhecido';
        res.status(500).json({ error: `Falha ao listar webhooks Cora: ${msg}` });
    }
});

/** POST /api/integrations/cora/webhooks — register a webhook */
router.post('/cora/webhooks', authenticate, authorize('ADMIN'), async (req: Request, res: Response) => {
    try {
        const { url } = req.body;
        if (!url || typeof url !== 'string') {
            res.status(400).json({ error: 'Campo "url" é obrigatório.' });
            return;
        }
        const endpoint = await coraRegisterWebhookEndpoint(url);
        res.json({ message: 'Webhook registrado com sucesso na Cora!', endpoint });
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Erro desconhecido';
        res.status(500).json({ error: `Falha ao registrar webhook Cora: ${msg}` });
    }
});

/** DELETE /api/integrations/cora/webhooks/:id — delete a webhook */
router.delete('/cora/webhooks/:id', authenticate, authorize('ADMIN'), async (req: Request, res: Response) => {
    try {
        await coraDeleteWebhookEndpoint(req.params.id as string);
        res.json({ message: 'Webhook removido da Cora.' });
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Erro desconhecido';
        res.status(500).json({ error: `Falha ao remover webhook Cora: ${msg}` });
    }
});

}

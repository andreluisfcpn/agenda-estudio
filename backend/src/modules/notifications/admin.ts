import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { authenticate, authorize } from '../../middleware/auth.js';
import { logAudit } from '../../lib/audit.js';
import { createNotification } from './notificationService.js';
import { getAllEffectiveEvents, invalidateTemplateCache, renderTemplate } from './templateStore.js';
import { NOTIFICATION_EVENT_BY_KEY, extractPlaceholders } from '../../config/notificationEventCatalog.js';
import { templateUpdateSchema } from './validators.js';

const router = Router();
router.use(authenticate, authorize('ADMIN'));

// ─── GET /api/notifications/admin/events ────────────────
// Full catalog merged with DB overrides — the admin UI's source.
router.get('/events', async (_req: Request, res: Response) => {
    try {
        const effective = await getAllEffectiveEvents();
        const events = Array.from(effective.values()).map(e => ({
            eventKey: e.def.eventKey,
            label: e.def.label,
            description: e.def.description,
            group: e.def.group,
            audience: e.def.audience,
            kind: e.def.kind,
            type: e.def.type,
            variables: e.def.variables,
            defaults: {
                title: e.def.defaultTitle,
                message: e.def.defaultMessage,
                severity: e.def.severity,
                pushDefault: e.def.pushDefault,
                actionUrl: e.def.actionUrl,
            },
            effective: {
                enabled: e.enabled,
                title: e.title,
                message: e.message,
                severity: e.severity,
                pushEnabled: e.pushEnabled,
            },
            overrides: e.overrides,
            isCustomized: e.isCustomized,
        }));
        res.json({ events });
    } catch (err) {
        console.error('[NOTIF-ADMIN] list events failed:', err);
        res.status(500).json({ error: 'Erro ao carregar eventos de notificação.' });
    }
});

/** Reject {placeholders} not declared for the event so a typo never ships literally. */
function validatePlaceholders(eventKey: string, ...texts: (string | null | undefined)[]): string | null {
    const allowed = new Set(NOTIFICATION_EVENT_BY_KEY[eventKey]!.variables.map(v => v.name));
    for (const t of texts) {
        if (!t) continue;
        for (const ph of extractPlaceholders(t)) {
            if (!allowed.has(ph)) return ph;
        }
    }
    return null;
}

// ─── PUT /api/notifications/admin/templates/:eventKey ───
router.put('/templates/:eventKey', async (req: Request, res: Response) => {
    try {
        const eventKey = req.params.eventKey as string;
        if (!NOTIFICATION_EVENT_BY_KEY[eventKey]) {
            res.status(404).json({ error: 'Evento desconhecido.' });
            return;
        }
        const data = templateUpdateSchema.parse(req.body);

        const badPh = validatePlaceholders(eventKey, data.title, data.message);
        if (badPh) {
            res.status(400).json({ error: `Variável {${badPh}} não existe para este evento.` });
            return;
        }

        const saved = await prisma.notificationTemplate.upsert({
            where: { eventKey },
            create: { eventKey, ...data },
            update: data,
        });
        invalidateTemplateCache();
        await logAudit('NOTIFICATION_TEMPLATE', eventKey, 'UPDATED', req.user!.userId, data as Record<string, unknown>);
        res.json({ template: saved, message: 'Template atualizado.' });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        console.error('[NOTIF-ADMIN] update template failed:', err);
        res.status(500).json({ error: 'Erro ao salvar o template.' });
    }
});

// ─── DELETE /api/notifications/admin/templates/:eventKey ─
// Restore the catalog default (drop the override row).
router.delete('/templates/:eventKey', async (req: Request, res: Response) => {
    try {
        const eventKey = req.params.eventKey as string;
        await prisma.notificationTemplate.deleteMany({ where: { eventKey } });
        invalidateTemplateCache();
        await logAudit('NOTIFICATION_TEMPLATE', eventKey, 'RESET', req.user!.userId);
        res.json({ message: 'Template restaurado para o padrão.' });
    } catch (err) {
        console.error('[NOTIF-ADMIN] reset template failed:', err);
        res.status(500).json({ error: 'Erro ao restaurar o template.' });
    }
});

// ─── POST /api/notifications/admin/templates/:eventKey/test ─
// Send the notification to the admin itself, rendered with example variables.
router.post('/templates/:eventKey/test', async (req: Request, res: Response) => {
    try {
        const eventKey = req.params.eventKey as string;
        const def = NOTIFICATION_EVENT_BY_KEY[eventKey];
        if (!def) { res.status(404).json({ error: 'Evento desconhecido.' }); return; }

        const eff = (await getAllEffectiveEvents()).get(eventKey)!;
        const vars = Object.fromEntries(def.variables.map(v => [v.name, v.example]));
        const severity = eff.severity === 'dynamic' ? 'warning' : eff.severity;

        await createNotification({
            userId: req.user!.userId,
            type: def.type,
            severity,
            title: renderTemplate(eff.title, vars),
            message: renderTemplate(eff.message, vars),
            entityType: 'TEST',
            entityId: `test-${eventKey}`,
            actionUrl: def.actionUrl,
            sendPush: eff.pushEnabled,
            // Unique key so repeated tests always go through (never deduped).
            dedupKey: `test:${eventKey}:${req.user!.userId}:${req.body?.nonce ?? Math.random().toString(36).slice(2)}`,
        });
        res.json({ message: 'Notificação de teste enviada para você.' });
    } catch (err) {
        console.error('[NOTIF-ADMIN] test template failed:', err);
        res.status(500).json({ error: 'Erro ao enviar o teste.' });
    }
});

export default router;

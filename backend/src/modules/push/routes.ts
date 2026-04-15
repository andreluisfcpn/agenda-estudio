import { Router, Request, Response } from 'express';
import { prisma } from '../../lib/prisma';
import { config } from '../../config';
import { authenticate } from '../../middleware/auth';
import { sendPushToUser } from './pushService';

const router = Router();

// GET /api/push/vapid-key — Public endpoint to get VAPID public key
router.get('/vapid-key', (_req: Request, res: Response) => {
    res.json({ publicKey: config.push.vapidPublicKey });
});

// POST /api/push/subscribe — Save push subscription (auth required)
router.post('/subscribe', authenticate, async (req: Request, res: Response) => {
    try {
        const userId = req.user!.userId;
        const { endpoint, keys } = req.body;

        if (!endpoint || !keys?.p256dh || !keys?.auth) {
            return res.status(400).json({ error: 'Missing subscription data.' });
        }

        // Upsert: update if endpoint already exists, create otherwise
        await prisma.pushSubscription.upsert({
            where: { endpoint },
            update: {
                userId,
                p256dh: keys.p256dh,
                auth: keys.auth,
                userAgent: req.headers['user-agent'] || null,
            },
            create: {
                userId,
                endpoint,
                p256dh: keys.p256dh,
                auth: keys.auth,
                userAgent: req.headers['user-agent'] || null,
            },
        });

        res.json({ success: true });
    } catch (err) {
        console.error('[PUSH] Subscribe error:', err);
        res.status(500).json({ error: 'Erro ao salvar subscription.' });
    }
});

// DELETE /api/push/unsubscribe — Remove push subscription (auth required)
router.delete('/unsubscribe', authenticate, async (req: Request, res: Response) => {
    try {
        const { endpoint } = req.body;
        if (!endpoint) {
            return res.status(400).json({ error: 'Missing endpoint.' });
        }

        await prisma.pushSubscription.deleteMany({
            where: { endpoint, userId: req.user!.userId },
        });

        res.json({ success: true });
    } catch (err) {
        console.error('[PUSH] Unsubscribe error:', err);
        res.status(500).json({ error: 'Erro ao remover subscription.' });
    }
});

// POST /api/push/test — Send a test push notification (auth required)
router.post('/test', authenticate, async (req: Request, res: Response) => {
    try {
        const sent = await sendPushToUser(req.user!.userId, {
            title: '🔔 Teste de Notificação',
            message: 'As notificações estão funcionando! Você receberá alertas importantes aqui.',
            tag: 'test',
            actionUrl: '/',
        });

        res.json({ success: true, devicesSent: sent });
    } catch (err) {
        console.error('[PUSH] Test error:', err);
        res.status(500).json({ error: 'Erro ao enviar notificação de teste.' });
    }
});

export default router;

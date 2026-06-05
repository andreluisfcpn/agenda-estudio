import { Router, Request, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middleware/auth.js';

// ─── GET /api/payments/:id/status (CLIENT) ──────────────
// Lightweight polling endpoint for PIX/Boleto status checks.
// For pending Cora payments it actively reconciles against the Cora API
// (throttled) so confirmation never depends solely on the webhook.

const _coraCheckTimes = new Map<string, number>();
const CORA_CHECK_THROTTLE_MS = 8000;

export function registerPaymentClientRoutes(router: Router) {
    // ─── GET /api/payments/sandbox-mode (PUBLIC) ────────────
    // Tells the checkout UI whether PIX/card are running in sandbox, so it can show
    // a "simulate payment" affordance for testing (never shown in production).
    router.get('/sandbox-mode', async (_req: Request, res: Response) => {
        try {
            const [cora, stripe] = await Promise.all([
                prisma.integrationConfig.findUnique({ where: { provider: 'CORA' } }),
                prisma.integrationConfig.findUnique({ where: { provider: 'STRIPE' } }),
            ]);
            res.json({
                pix: !!cora?.enabled && cora.environment === 'sandbox',
                card: !!stripe?.enabled && stripe.environment === 'sandbox',
            });
        } catch {
            res.json({ pix: false, card: false });
        }
    });

    router.get('/:id/status', authenticate, async (req: Request, res: Response) => {
        try {
            const id = req.params.id as string;
            const userId = req.user!.userId;
            const isAdmin = req.user!.role === 'ADMIN';

            const payment = await prisma.payment.findFirst({
                where: isAdmin ? { id } : { id, userId },
                select: { id: true, status: true, provider: true, providerRef: true, pixString: true, boletoUrl: true },
            });

            if (!payment) {
                res.status(404).json({ status: 'NOT_FOUND' });
                return;
            }

            let status: string = payment.status;

            // Active reconciliation for pending Cora payments (webhook-independent fallback)
            if (status === 'PENDING' && payment.provider === 'CORA' && payment.providerRef) {
                const last = _coraCheckTimes.get(payment.id) || 0;
                if (Date.now() - last > CORA_CHECK_THROTTLE_MS) {
                    _coraCheckTimes.set(payment.id, Date.now());
                    try {
                        const { reconcileCoraPayment } = await import('../../lib/coraReconciliation.js');
                        if (await reconcileCoraPayment(payment.id)) status = 'PAID';
                    } catch (e) {
                        console.error('[Payment-Status] Cora reconciliation failed:', e instanceof Error ? e.message : e);
                    }
                }
            }

            res.json({
                status,
                provider: payment.provider,
                pixString: payment.pixString,
                boletoUrl: payment.boletoUrl,
            });
        } catch (err) {
            console.error('Erro ao consultar status do pagamento:', err);
            res.status(500).json({ error: 'Erro ao consultar status.' });
        }
    });

    // ─── POST /api/payments/:id/simulate (SANDBOX ONLY) ─────
    // Simulates a confirmed payment for end-to-end testing. STRICTLY refuses unless
    // the payment's provider integration is in 'sandbox' — it can never confirm a
    // real production payment. Runs the exact same effects as a real confirmation.
    router.post('/:id/simulate', authenticate, async (req: Request, res: Response) => {
        try {
            const id = req.params.id as string;
            const userId = req.user!.userId;
            const isAdmin = req.user!.role === 'ADMIN';

            const payment = await prisma.payment.findFirst({
                where: isAdmin ? { id } : { id, userId },
            });
            if (!payment) {
                res.status(404).json({ error: 'Pagamento não encontrado.' });
                return;
            }

            // Hard gate: only ever allowed when the provider is in sandbox.
            const integration = await prisma.integrationConfig.findUnique({ where: { provider: payment.provider } });
            if (!integration || integration.environment !== 'sandbox') {
                res.status(403).json({ error: 'Simulação disponível apenas em ambiente de teste (sandbox).' });
                return;
            }

            if (payment.status === 'PAID') {
                res.json({ status: 'PAID', message: 'Pagamento já estava confirmado.' });
                return;
            }

            const updated = await prisma.payment.updateMany({
                where: { id, status: 'PENDING' },
                data: { status: 'PAID', paidAt: new Date() },
            });
            if (updated.count === 0) {
                res.json({ status: payment.status, message: 'Pagamento não estava pendente.' });
                return;
            }

            const { onPaymentConfirmed } = await import('../../lib/paymentEffects.js');
            await onPaymentConfirmed(id);

            console.log(`[Payment-Simulate] Payment ${id} confirmed via sandbox simulation by user ${userId}`);
            res.json({ status: 'PAID', message: '🧪 Pagamento simulado e confirmado (sandbox).' });
        } catch (err) {
            console.error('[Payment-Simulate]', err);
            res.status(500).json({ error: 'Erro ao simular pagamento.' });
        }
    });
}

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { authenticate, authorize } from '../../middleware/auth.js';
import { PaymentStatus, PaymentMethod } from '../../generated/prisma/client.js';

const router = Router();

// ─── GET /api/payments (ADMIN) ──────────────────────────
// Lists all payments with filters and includes user + contract

router.get('/', authenticate, authorize('ADMIN'), async (req: Request, res: Response) => {
    try {
        const { status, userId, contractId, from, to, search } = req.query;

        const where: any = {};

        if (status) where.status = status as string;
        if (userId) where.userId = userId as string;
        if (contractId) where.contractId = contractId as string;

        // Date range filter on dueDate
        if (from || to) {
            where.dueDate = {};
            if (from) where.dueDate.gte = new Date(from as string);
            if (to) {
                const toDate = new Date(to as string);
                toDate.setDate(toDate.getDate() + 1); // inclusive
                where.dueDate.lt = toDate;
            }
        }

        // Search by user name or email
        if (search) {
            where.user = {
                OR: [
                    { name: { contains: search as string, mode: 'insensitive' } },
                    { email: { contains: search as string, mode: 'insensitive' } },
                ],
            };
        }

        const payments = await prisma.payment.findMany({
            where,
            include: {
                user: { select: { id: true, name: true, email: true } },
                contract: { select: { id: true, name: true, type: true, tier: true, durationMonths: true } },
                booking: { select: { id: true, date: true, startTime: true } },
            },
            orderBy: { dueDate: 'asc' },
        });

        res.json({ payments });
    } catch (err) {
        console.error('Erro ao listar pagamentos:', err);
        res.status(500).json({ error: 'Erro ao listar pagamentos.' });
    }
});

// ─── GET /api/payments/summary (ADMIN) ──────────────────
// Financial KPIs for the current period

router.get('/summary', authenticate, authorize('ADMIN'), async (req: Request, res: Response) => {
    try {
        const { from, to } = req.query;

        // Default: current month
        const now = new Date();
        const monthStart = from ? new Date(from as string) : new Date(now.getFullYear(), now.getMonth(), 1);
        const monthEnd = to ? new Date(to as string) : new Date(now.getFullYear(), now.getMonth() + 1, 0);
        monthEnd.setDate(monthEnd.getDate() + 1); // inclusive

        const payments = await prisma.payment.findMany({
            where: {
                dueDate: { gte: monthStart, lt: monthEnd },
            },
        });

        const totalRevenue = payments.reduce((s, p) => s + p.amount, 0);
        const paidRevenue = payments.filter(p => p.status === 'PAID').reduce((s, p) => s + p.amount, 0);
        const pendingRevenue = payments.filter(p => p.status === 'PENDING').reduce((s, p) => s + p.amount, 0);
        const failedCount = payments.filter(p => p.status === 'FAILED').length;
        const refundedAmount = payments.filter(p => p.status === 'REFUNDED').reduce((s, p) => s + p.amount, 0);

        // Overdue: PENDING with dueDate < today
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const overduePayments = payments.filter(p => p.status === 'PENDING' && p.dueDate && new Date(p.dueDate) < today);
        const overdueCount = overduePayments.length;
        const overdueAmount = overduePayments.reduce((s, p) => s + p.amount, 0);

        // Monthly breakdown for chart (last 6 months)
        const monthlyBreakdown = [];
        for (let i = 5; i >= 0; i--) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            const dEnd = new Date(d.getFullYear(), d.getMonth() + 1, 0);
            dEnd.setDate(dEnd.getDate() + 1);

            const monthPayments = await prisma.payment.findMany({
                where: { dueDate: { gte: d, lt: dEnd } },
            });

            monthlyBreakdown.push({
                month: d.toISOString().slice(0, 7), // YYYY-MM
                label: d.toLocaleDateString('pt-BR', { month: 'short', year: '2-digit' }),
                total: monthPayments.reduce((s, p) => s + p.amount, 0),
                paid: monthPayments.filter(p => p.status === 'PAID').reduce((s, p) => s + p.amount, 0),
                pending: monthPayments.filter(p => p.status === 'PENDING').reduce((s, p) => s + p.amount, 0),
            });
        }

        res.json({
            summary: {
                totalRevenue,
                paidRevenue,
                pendingRevenue,
                overdueCount,
                overdueAmount,
                failedCount,
                refundedAmount,
                totalCount: payments.length,
                paidCount: payments.filter(p => p.status === 'PAID').length,
                pendingCount: payments.filter(p => p.status === 'PENDING').length,
            },
            monthlyBreakdown,
        });
    } catch (err) {
        console.error('Erro ao gerar resumo financeiro:', err);
        res.status(500).json({ error: 'Erro ao gerar resumo financeiro.' });
    }
});

// ─── PATCH /api/payments/:id (ADMIN) ────────────────────
// Update payment status (mark as paid, refunded, etc.)

const updatePaymentSchema = z.object({
    status: z.nativeEnum(PaymentStatus).optional(),
    paymentMethod: z.nativeEnum(PaymentMethod).optional(),
    providerRef: z.string().optional(),
    notes: z.string().optional(),
});

// VULN-M3 FIX: Payment state machine — prevents arbitrary status transitions
const VALID_STATUS_TRANSITIONS: Record<string, string[]> = {
    PENDING:  ['PAID', 'FAILED', 'CANCELLED', 'REFUNDED'],
    FAILED:   ['PENDING', 'PAID'],
    PAID:     ['REFUNDED'],
    CANCELLED: ['PENDING'],
    REFUNDED: [], // terminal state
};

router.patch('/:id', authenticate, authorize('ADMIN'), async (req: Request<{ id: string }>, res: Response) => {
    try {
        const { id } = req.params;
        const data = updatePaymentSchema.parse(req.body);

        const existing = await prisma.payment.findUnique({ where: { id } });
        if (!existing) {
            res.status(404).json({ error: 'Pagamento não encontrado.' });
            return;
        }

        // Validate status transition if changing status
        if (data.status && data.status !== existing.status) {
            const allowed = VALID_STATUS_TRANSITIONS[existing.status] || [];
            if (!allowed.includes(data.status)) {
                res.status(400).json({
                    error: `Transição inválida: ${existing.status} → ${data.status}. Transições permitidas: ${allowed.join(', ') || 'nenhuma (estado terminal)'}.`
                });
                return;
            }
        }

        const updated = await prisma.payment.update({
            where: { id },
            data: {
                ...(data.status && { status: data.status }),
                ...(data.status === 'PAID' && !existing.paidAt && { paidAt: new Date() }),
                ...(data.providerRef !== undefined && { providerRef: data.providerRef }),
            },
            include: {
                user: { select: { id: true, name: true, email: true } },
                contract: { select: { id: true, name: true, type: true, tier: true } },
            },
        });

        // Audit log for financial state changes
        if (data.status && data.status !== existing.status) {
            console.log(`[PAYMENT-ADMIN] ${req.user!.userId} changed payment ${id}: ${existing.status} → ${data.status}`);
        }

        res.json({ payment: updated, message: 'Pagamento atualizado com sucesso.' });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        console.error('Erro ao atualizar pagamento:', err);
        res.status(500).json({ error: 'Erro ao atualizar pagamento.' });
    }
});

// ─── GET /api/payments/:id/status (CLIENT) ──────────────
// Lightweight polling endpoint for PIX/Boleto status checks.
// For pending Cora payments it actively reconciles against the Cora API
// (throttled) so confirmation never depends solely on the webhook.

const _coraCheckTimes = new Map<string, number>();
const CORA_CHECK_THROTTLE_MS = 8000;

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
export default router;


import { Router } from 'express';
import { prisma } from '../../lib/prisma.js';
import { authenticate, authorize } from '../../middleware/auth.js';
import { getConfig } from '../../lib/businessConfig.js';

const router = Router();


// GET /api/finance/closing/:year/:month
router.get('/closing/:year/:month', authenticate, authorize('ADMIN'), async (req, res) => {
    try {
        const year = parseInt(String(req.params.year), 10);
        const month = parseInt(String(req.params.month), 10);

        if (isNaN(year) || isNaN(month) || month < 1 || month > 12) {
            return res.status(400).json({ message: 'Ano ou Mês inválido' });
        }

        const startDate = new Date(year, month - 1, 1);
        const endDate = new Date(year, month, 0, 23, 59, 59, 999);

        // Fetch all payments mapped to this period
        // Either the dueDate falls in this month, or (if no dueDate) the createdAt falls in this month
        const payments = await prisma.payment.findMany({
            where: {
                OR: [
                    { dueDate: { gte: startDate, lte: endDate } },
                    { dueDate: null, createdAt: { gte: startDate, lte: endDate } }
                ]
            },
            include: {
                user: {
                    select: { id: true, name: true, email: true }
                },
                contract: {
                    select: { id: true, name: true, type: true, tier: true, paymentMethod: true }
                },
                booking: {
                    select: { id: true, date: true, startTime: true, tierApplied: true }
                }
            },
            orderBy: {
                dueDate: 'asc'
            }
        });

        let grossRevenue = 0;
        let pendingRevenue = 0;
        let totalFees = 0;

        let stripeCount = 0;
        let coraCount = 0;

        const stripeFeeRate = (await getConfig('gateway_stripe_fee_pct')) / 100;
        const coraFeeCents = await getConfig('gateway_cora_fee_cents');

        // Load admin-configured payment method labels
        const paymentMethodConfigs = await prisma.paymentMethodConfig.findMany({ orderBy: { sortOrder: 'asc' } });

        const enrichedPayments = payments.map(p => {
            let fee = 0;
            // Look up label from admin-configured PaymentMethodConfig
            const pmKey = p.contract?.paymentMethod;
            let methodLabel = 'PIX / Boleto';
            if (pmKey) {
                const pmConfig = paymentMethodConfigs.find((c: any) => c.key === pmKey);
                methodLabel = pmConfig?.label || pmKey;
            } else if (p.provider === 'STRIPE') {
                const cartaoConfig = paymentMethodConfigs.find((c: any) => c.key === 'CARTAO');
                methodLabel = cartaoConfig?.label || 'Cartão de Crédito';
            }

            if (p.status === 'PAID') {
                grossRevenue += p.amount;
                
                // Deduct fees based on provider (dynamic from config)
                if (p.provider === 'STRIPE') {
                    fee = Math.round(p.amount * stripeFeeRate);
                    stripeCount++;
                } else if (p.provider === 'CORA') {
                    fee = coraFeeCents;
                    coraCount++;
                }
                totalFees += fee;
            } else if (p.status === 'PENDING' || p.status === 'FAILED') {
                pendingRevenue += p.amount;
            }

            // Resolve emoji from config
            const resolvedConfig = pmKey
                ? paymentMethodConfigs.find((c: any) => c.key === pmKey)
                : (p.provider === 'STRIPE' ? paymentMethodConfigs.find((c: any) => c.key === 'CARTAO') : null);

            return {
                ...p,
                methodLabel,
                methodEmoji: resolvedConfig?.emoji || '💰',
                feeDeduced: fee,
                netAmount: p.amount - fee
            };
        });

        const netRevenue = grossRevenue - totalFees;

        res.json({
            period: { year, month },
            metrics: {
                grossRevenue, // Centavos recebidos
                netRevenue,   // Centavos pós taxas -> Repasse Estúdio
                totalFees,    // Centavos gastos do Gateway
                pendingRevenue, // Inadimplência ou a vencer no mês
                paidCount: stripeCount + coraCount,
                unpaidCount: payments.length - (stripeCount + coraCount),
                breakdown: {
                    stripe: stripeCount,
                    cora: coraCount
                }
            },
            payments: enrichedPayments
        });

    } catch (error: any) {
        console.error('Error fetching closing info:', error);
        res.status(500).json({ message: error.message });
    }
});

export const financeRouter = router;

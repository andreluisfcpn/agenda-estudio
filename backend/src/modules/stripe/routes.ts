// ─── Stripe Payment Routes ──────────────────────────────
// Client-facing routes for card management, payment intents, and subscriptions
// All routes require authentication

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middleware/auth.js';
import {
    stripeGetPublishableKey,
    stripeGetOrCreateCustomer,
    stripeCreateSetupIntent,
    stripeListPaymentMethods,
    stripeDetachPaymentMethod,
    stripeSetDefaultPaymentMethod,
    stripeCreatePaymentIntent,
    stripeGetInstallmentPlans,
    stripeGetPaymentIntent,
} from '../../lib/stripeService.js';
import { onPaymentConfirmed } from '../../lib/paymentEffects.js';
import { getInstallmentPolicy, policyInputsFromPayment } from '../../lib/paymentPolicy.js';

const router = Router();

// ─── GET /api/stripe/publishable-key ────────────────────
// Returns the Stripe publishable key for frontend initialization
router.get('/publishable-key', authenticate, async (_req: Request, res: Response) => {
    try {
        const key = await stripeGetPublishableKey();
        // Only ever return a real publishable key — never leak a secret (sk_)
        // to the browser if it was mistakenly entered in the publishable field.
        if (!key || !key.startsWith('pk_')) {
            res.status(503).json({ error: 'Chave publicável do Stripe ausente ou inválida. No painel Admin → Integrações, cole a Publishable Key (pk_test_… ou pk_live_…).' });
            return;
        }
        res.json({ publishableKey: key });
    } catch (err: any) {
        console.error('[Stripe] Error getting publishable key:', err);
        res.status(500).json({ error: 'Erro ao obter configuração Stripe.' });
    }
});

// ─── POST /api/stripe/setup-intent ──────────────────────
// Creates a SetupIntent for saving a card without charging
router.post('/setup-intent', authenticate, async (req: Request, res: Response) => {
    try {
        const userId = req.user!.userId;
        const customerId = await stripeGetOrCreateCustomer(userId);
        const result = await stripeCreateSetupIntent(customerId);

        res.json({
            clientSecret: result.clientSecret,
            setupIntentId: result.setupIntentId,
        });
    } catch (err: any) {
        console.error('[Stripe] Error creating SetupIntent:', err);
        res.status(500).json({ error: err.message || 'Erro ao criar SetupIntent.' });
    }
});

// ─── GET /api/stripe/payment-methods ────────────────────
// Lists saved cards for the authenticated user
router.get('/payment-methods', authenticate, async (req: Request, res: Response) => {
    try {
        const userId = req.user!.userId;
        const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

        if (!user.stripeCustomerId) {
            res.json({ paymentMethods: [], autoChargeEnabled: user.autoChargeEnabled });
            return;
        }

        // Use stripeGetOrCreateCustomer to verify the customer and recreate if it was deleted
        const verifiedCustomerId = await stripeGetOrCreateCustomer(userId);

        // Get cards from Stripe
        const stripeCards = await stripeListPaymentMethods(verifiedCustomerId);

        // Get saved methods from our DB for default status
        const savedMethods = await prisma.savedPaymentMethod.findMany({
            where: { userId },
            orderBy: { createdAt: 'desc' },
        });

        // Merge: enrich with isDefault from our DB
        const paymentMethods = stripeCards.map(card => {
            const saved = savedMethods.find(s => s.stripePaymentMethodId === card.paymentMethodId);
            return {
                id: saved?.id || card.paymentMethodId,
                stripePaymentMethodId: card.paymentMethodId,
                brand: card.brand,
                last4: card.last4,
                expMonth: card.expMonth,
                expYear: card.expYear,
                funding: card.funding,
                isDefault: saved?.isDefault || false,
            };
        });

        res.json({ paymentMethods, autoChargeEnabled: user.autoChargeEnabled });
    } catch (err: any) {
        console.error('[Stripe] Error listing payment methods:', err);
        res.status(500).json({ error: err.message || 'Erro ao listar cartões.' });
    }
});

// ─── DELETE /api/stripe/payment-methods/:pmId ───────────
// Detaches a card from the customer
router.delete('/payment-methods/:pmId', authenticate, async (req: Request, res: Response) => {
    try {
        const userId = req.user!.userId;
        const pmId = req.params.pmId as string;

        // Find the saved method to get the Stripe PM ID
        const saved = await prisma.savedPaymentMethod.findFirst({
            where: { userId, OR: [{ id: pmId }, { stripePaymentMethodId: pmId }] },
        });

        // STRIPE-M2 FIX: Block detach if card not found in our DB (prevents IDOR)
        if (!saved) {
            res.status(404).json({ error: 'Cartão não encontrado.' });
            return;
        }

        const stripePmId = saved.stripePaymentMethodId;

        // Detach from Stripe
        await stripeDetachPaymentMethod(stripePmId);

        // Remove from our DB
        if (saved) {
            await prisma.savedPaymentMethod.delete({ where: { id: saved.id } });
        }

        res.json({ message: 'Cartão removido com sucesso.' });
    } catch (err: any) {
        console.error('[Stripe] Error removing payment method:', err);
        res.status(500).json({ error: err.message || 'Erro ao remover cartão.' });
    }
});

// ─── PUT /api/stripe/payment-methods/:pmId/default ──────
// Sets a card as the default payment method
router.put('/payment-methods/:pmId/default', authenticate, async (req: Request, res: Response) => {
    try {
        const userId = req.user!.userId;
        const pmId = req.params.pmId as string;

        const customerId = await stripeGetOrCreateCustomer(userId);

        // Find the Stripe PM ID
        let saved = await prisma.savedPaymentMethod.findFirst({
            where: { userId, OR: [{ id: pmId }, { stripePaymentMethodId: pmId }] },
        });
        const stripePmId = saved?.stripePaymentMethodId || pmId;

        // Set as default in Stripe
        await stripeSetDefaultPaymentMethod(customerId, stripePmId);

        // Update our DB: unset all defaults, then set this one
        await prisma.savedPaymentMethod.updateMany({
            where: { userId },
            data: { isDefault: false },
        });

        if (saved) {
            await prisma.savedPaymentMethod.update({
                where: { id: saved.id },
                data: { isDefault: true },
            });
        } else {
            // Card exists in Stripe but not in our DB — sync it now
            const cards = await stripeListPaymentMethods(customerId);
            const card = cards.find(c => c.paymentMethodId === stripePmId);
            if (card) {
                saved = await prisma.savedPaymentMethod.create({
                    data: {
                        userId,
                        stripePaymentMethodId: stripePmId,
                        brand: card.brand,
                        last4: card.last4,
                        expMonth: card.expMonth,
                        expYear: card.expYear,
                        isDefault: true,
                    },
                });
                console.log(`[Stripe] Synced + set default: ${card.brand} ****${card.last4}`);
            }
        }

        // Also sync any other Stripe cards that are missing from our DB
        const allStripeCards = await stripeListPaymentMethods(customerId);
        const existingPmIds = (await prisma.savedPaymentMethod.findMany({
            where: { userId },
            select: { stripePaymentMethodId: true },
        })).map(s => s.stripePaymentMethodId);

        for (const sc of allStripeCards) {
            if (!existingPmIds.includes(sc.paymentMethodId)) {
                await prisma.savedPaymentMethod.create({
                    data: {
                        userId,
                        stripePaymentMethodId: sc.paymentMethodId,
                        brand: sc.brand,
                        last4: sc.last4,
                        expMonth: sc.expMonth,
                        expYear: sc.expYear,
                        isDefault: false,
                    },
                });
                console.log(`[Stripe] Synced missing card: ${sc.brand} ****${sc.last4}`);
            }
        }

        res.json({ message: 'Cartão padrão definido.' });
    } catch (err: any) {
        console.error('[Stripe] Error setting default:', err);
        res.status(500).json({ error: err.message || 'Erro ao definir cartão padrão.' });
    }
});

// ─── POST /api/stripe/create-payment ────────────────────
// Creates a PaymentIntent for paying a specific internal Payment
const createPaymentSchema = z.object({
    paymentId: z.string().uuid(),
    installments: z.number().min(1).max(12).optional(),
    savedPaymentMethodId: z.string().optional(),
    savePaymentMethod: z.boolean().optional(),
    paymentMethod: z.enum(['cartao', 'pix', 'boleto']).optional().default('cartao'),
});

router.post('/create-payment', authenticate, async (req: Request, res: Response) => {
    try {
        const data = createPaymentSchema.parse(req.body);
        const userId = req.user!.userId;
        const isAdmin = req.user!.role === 'ADMIN';

        // Global guard: reject if the payment method is disabled by admin.
        // Boleto is exempt here — it is released per-contract (boletoAllowed),
        // not globally, so it is authorized below after we load the payment.
        if (data.paymentMethod !== 'boleto') {
            const { validatePaymentMethod, PaymentMethodDisabledError } = await import('../../lib/paymentGateway.js');
            try {
                await validatePaymentMethod(data.paymentMethod);
            } catch (err) {
                if (err instanceof PaymentMethodDisabledError) {
                    res.status(400).json({ error: err.message });
                    return;
                }
                throw err;
            }
        }

        // Get our internal payment. Admins may act on ANY payment (charge on behalf of the
        // client, e.g. card-present); clients only on their own.
        const payment = await prisma.payment.findFirst({
            where: { id: data.paymentId, ...(isAdmin ? {} : { userId }) },
            include: { contract: true },
        });

        if (!payment) {
            res.status(404).json({ error: 'Pagamento não encontrado.' });
            return;
        }

        // The PAYER is the payment's owner (the client). Resolve the Stripe customer / Cora
        // CPF from payment.userId so an admin charges with the CLIENT's card/CPF, not their own.
        const payerUserId = payment.userId;

        if (payment.status === 'PAID') {
            res.status(400).json({ error: 'Este pagamento já foi realizado.' });
            return;
        }

        if (payment.status === 'CANCELLED') {
            res.status(400).json({ error: 'Este pagamento foi cancelado (contrato encerrado) e não pode mais ser pago.' });
            return;
        }

        // Get or create Stripe Customer for the PAYER (client), not the requester.
        const customerId = await stripeGetOrCreateCustomer(payerUserId);

        if (data.paymentMethod === 'pix') {
            // Use centralized Cora helper for PIX
            const { createCoraPayment } = await import('../../lib/coraPaymentHelper.js');

            try {
                const coraRes = await createCoraPayment({
                    userId: payerUserId,
                    amount: payment.amount,
                    description: `Pagamento PIX - ${payment.contract?.name || 'Avulso'}`,
                    withPixQrCode: true,
                    idempotencyKey: payment.id,
                });

                await prisma.payment.update({
                    where: { id: payment.id },
                    data: {
                        providerRef: coraRes.result.id,
                        provider: 'CORA',
                        installments: 1,
                        pixString: coraRes.pixString,
                    },
                });

                res.json({
                    provider: 'CORA',
                    pixString: coraRes.pixString,
                    qrCodeBase64: coraRes.qrCodeBase64,
                    paymentId: payment.id,
                });
            } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : 'Erro ao gerar PIX.';
                res.status(400).json({ error: msg });
            }
            return;
        }

        if (data.paymentMethod === 'boleto') {
            // Boleto is released per contract only — never globally available to clients.
            if (!payment.contract?.boletoAllowed) {
                res.status(400).json({ error: 'Boleto não está liberado para este contrato.' });
                return;
            }
            const { createCoraPayment } = await import('../../lib/coraPaymentHelper.js');
            try {
                const coraRes = await createCoraPayment({
                    userId: payerUserId,
                    amount: payment.amount,
                    description: `Boleto - ${payment.contract?.name || 'Contrato'}`,
                    withPixQrCode: false,
                    idempotencyKey: payment.id,
                });

                await prisma.payment.update({
                    where: { id: payment.id },
                    data: {
                        providerRef: coraRes.result.id,
                        provider: 'CORA',
                        installments: 1,
                        boletoUrl: coraRes.boletoUrl,
                    },
                });

                res.json({
                    provider: 'CORA',
                    boletoUrl: coraRes.boletoUrl,
                    barcode: coraRes.barcode,
                    paymentId: payment.id,
                });
            } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : 'Erro ao gerar boleto.';
                res.status(400).json({ error: msg });
            }
            return;
        }

        // Determine amount + installments via the SINGLE installment policy.
        //  - Monthly installment  → 1x only (no surcharge).
        //  - À-vista (FULL) on a contract → 1–12x, free up to durationMonths, juros above.
        //  - Avulso ("paid now")  → 1–12x, free in 1x, juros 2–12x.
        // Amounts here are pre-surcharge bases (the surcharge is no longer baked at creation),
        // so applying the juros once is correct and parity (persisted==charged) is preserved.
        let amount = payment.amount;
        const policy = getInstallmentPolicy(policyInputsFromPayment(payment));
        let installments = Math.min(data.installments || 1, policy.maxInstallments);

        if (data.paymentMethod === 'cartao' && installments > policy.freeUpTo) {
            const plans = await stripeGetInstallmentPlans(amount, policy.freeUpTo);
            const plan = plans.find(p => p.count === installments);
            if (plan) amount = plan.total;
        }

        // Create PaymentIntent (CARDS ONLY now)
        const result = await stripeCreatePaymentIntent({
            amount,
            customerId,
            description: `Pagamento - ${payment.contract?.name || 'Avulso'}`,
            paymentId: payment.id,
            userId: payerUserId,
            contractId: payment.contractId || undefined,
            installmentsEnabled: true,
            savedPaymentMethodId: data.savedPaymentMethodId,
            savePaymentMethod: data.savePaymentMethod,
        });

        // Update our payment with the Stripe reference AND the fee-adjusted amount actually
        // charged. Without persisting `amount`, the webhook/verify amount-parity check
        // (pi.amount !== payment.amount) would reject confirmation when installment fees applied —
        // charging the customer but leaving the payment stuck PENDING.
        await prisma.payment.update({
            where: { id: payment.id },
            data: {
                providerRef: result.paymentIntentId,
                provider: 'STRIPE',
                amount,
                installments,
            },
        });

        res.json({
            provider: 'STRIPE',
            clientSecret: result.clientSecret,
            paymentIntentId: result.paymentIntentId,
        });
    } catch (err: any) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        console.error('[Stripe] Error creating payment:', err);
        res.status(500).json({ error: err.message || 'Erro ao criar pagamento.' });
    }
});

// ─── POST /api/stripe/installment-plans ─────────────────
// Returns available installment plans for a given payment
const installmentSchema = z.object({
    paymentId: z.string().uuid().optional(),
    amount: z.number().min(100).optional(),
    contractDurationMonths: z.number().min(1).max(12).optional(),
});

router.post('/installment-plans', authenticate, async (req: Request, res: Response) => {
    try {
        const data = installmentSchema.parse(req.body);
        let amount = data.amount || 0;
        let policy: { maxInstallments: number; freeUpTo: number };

        // Derive the installment policy: from the payment's contract (plan/type/duration)
        // when a paymentId is given; otherwise treat it as an à-vista (FULL) preview over the
        // given duration (used by the wizards before a payment exists).
        if (data.paymentId) {
            const payment = await prisma.payment.findFirst({
                where: { id: data.paymentId, ...(req.user!.role === 'ADMIN' ? {} : { userId: req.user!.userId }) },
                include: { contract: true },
            });
            if (!payment) {
                res.status(404).json({ error: 'Pagamento não encontrado.' });
                return;
            }
            amount = payment.amount;
            policy = getInstallmentPolicy(policyInputsFromPayment(payment));
        } else {
            policy = getInstallmentPolicy({ plan: 'FULL', durationMonths: data.contractDurationMonths || 1 });
        }

        if (amount <= 0) {
            res.status(400).json({ error: 'Valor inválido.' });
            return;
        }

        const plans = (await stripeGetInstallmentPlans(amount, policy.freeUpTo))
            .filter(p => p.count <= policy.maxInstallments);
        res.json({ plans });
    } catch (err: any) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        res.status(500).json({ error: 'Erro ao calcular parcelas.' });
    }
});

// ─── PUT /api/stripe/auto-charge ────────────────────────
// Toggle automatic off-session charging (opt-in by client)
const autoChargeSchema = z.object({
    enabled: z.boolean(),
});

router.put('/auto-charge', authenticate, async (req: Request, res: Response) => {
    try {
        const { enabled } = autoChargeSchema.parse(req.body);
        const userId = req.user!.userId;

        // Verify user has at least one saved card if enabling
        if (enabled) {
            const savedCards = await prisma.savedPaymentMethod.count({
                where: { userId },
            });
            if (savedCards === 0) {
                res.status(400).json({ error: 'Adicione pelo menos um cartão antes de ativar a cobrança automática.' });
                return;
            }
        }

        await prisma.user.update({
            where: { id: userId },
            data: { autoChargeEnabled: enabled },
        });

        res.json({
            message: enabled
                ? 'Cobrança automática ativada. Seu cartão padrão será cobrado no vencimento.'
                : 'Cobrança automática desativada.',
        });
    } catch (err: any) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.' });
            return;
        }
        res.status(500).json({ error: 'Erro ao atualizar preferência.' });
    }
});

// ─── POST /api/stripe/verify-payment ────────────────────
// Manually verifies a payment intent with Stripe and forces DB update
// if the webhook hasn't arrived yet.
const verifyPaymentSchema = z.object({
    paymentId: z.string().uuid(),
    paymentIntentId: z.string(),
});

router.post('/verify-payment', authenticate, async (req: Request, res: Response) => {
    try {
        const data = verifyPaymentSchema.parse(req.body);
        const userId = req.user!.userId;

        // Admins may verify any payment (charged on behalf of a client); clients only their own.
        const payment = await prisma.payment.findFirst({
            where: { id: data.paymentId, ...(req.user!.role === 'ADMIN' ? {} : { userId }) },
        });
        if (!payment) {
            res.status(404).json({ error: 'Pagamento não encontrado.' });
            return;
        }

        if (payment.status === 'PAID') {
            res.json({ status: 'PAID', message: 'Já pago.' });
            return;
        }

        if (payment.status === 'CANCELLED') {
            res.status(400).json({ error: 'Este pagamento foi cancelado (contrato encerrado) e não pode ser confirmado.' });
            return;
        }

        const pi = await stripeGetPaymentIntent(data.paymentIntentId);
        
        if (pi.status === 'succeeded') {
            // STRIPE-M1 FIX: Verify the PaymentIntent belongs to this payment
            if (pi.metadata?.paymentId && pi.metadata.paymentId !== data.paymentId) {
                console.error(`[Stripe:Verify] PI ownership mismatch: PI.meta=${pi.metadata.paymentId}, requested=${data.paymentId}`);
                res.status(400).json({ error: 'PaymentIntent não pertence a este pagamento.' });
                return;
            }

            // VULN-07 FIX: Verify amount matches before accepting
            if (pi.amount !== payment.amount) {
                console.error(`[Stripe:Verify] Amount mismatch: PI=${pi.amount}, DB=${payment.amount} for payment ${payment.id}`);
                res.status(400).json({ error: 'Valor do PaymentIntent não confere com o pagamento.' });
                return;
            }

            // Atomic update: only update if still PENDING to prevent race with webhooks
            const updated = await prisma.payment.updateMany({
                where: { id: payment.id, status: 'PENDING' },
                data: {
                    status: 'PAID',
                    paidAt: new Date(),
                    providerRef: pi.id,
                    paymentType: pi.payment_method_types?.includes('card') ? 'CREDIT' : null,
                },
            });

            // Run the SINGLE source of confirmation effects (addon activation, booking confirm,
            // contract activate/fulfill, renewal-booking generation, push notification, progressive
            // unlock) — only if THIS call won the atomic PENDING→PAID race (otherwise the webhook
            // already ran them). Centralizing here keeps verify/webhook/reconcile in lockstep and
            // restores the two effects the old inline copy was missing (push + renewal bookings).
            if (updated.count > 0) {
                await onPaymentConfirmed(payment.id);
            }

            console.log(`[Stripe:Verify] Manually verified payment ${payment.id} as PAID`);
            res.json({ status: 'PAID', message: 'Pagamento sincronizado.' });
            return;
        }
        
        res.json({ status: payment.status, message: 'Ainda não confirmado no Stripe.' });
    } catch (err: any) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.' });
            return;
        }
        console.error('[Stripe] Verify Error:', err);
        res.status(500).json({ error: 'Erro ao verificar sincronicidade do Stripe.' });
    }
});

export default router;
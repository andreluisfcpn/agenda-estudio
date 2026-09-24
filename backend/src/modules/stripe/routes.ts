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
    stripeCardInstallmentsSupported,
    cardInstallmentsBlockReason,
} from '../../lib/stripeService.js';
import { onPaymentConfirmed } from '../../lib/paymentEffects.js';
import { getInstallmentPolicy, policyInputsFromPayment } from '../../lib/paymentPolicy.js';
import { issuePixCharge, retirePixCharge, isPixProvider, pixMetadataAfterDiscard, cardChargeBaseAmount, cancelStalePixCharge, PIX_LIVE_CHARGE_MESSAGE, settleExistingCardIntent, cardIntentInFlightMessage } from '../../lib/pixGateway.js';

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

        // pagamentos-1 / cobertura-1 (D1): cartão em N× (N > 1) só quando o SERVIDOR fixa o plano (cartão salvo,
        // conta com parcelamento). Recusa ANTES de qualquer efeito (reabrir FAILED, aposentar PIX, criar PI):
        // numa conta sem parcelamento (Stripe BR) o total sairia em 1× com os juros do app; com cartão novo, o
        // seletor do Payment Element escolheria qualquer plano do emissor, fora do teto da política.
        if (data.paymentMethod === 'cartao') {
            const requested = Math.min(data.installments || 1, getInstallmentPolicy(policyInputsFromPayment(payment)).maxInstallments);
            if (requested > 1) {
                const blocked = cardInstallmentsBlockReason({
                    installments: requested,
                    savedCard: !!data.savedPaymentMethodId,
                    gatewaySupported: await stripeCardInstallmentsSupported(),
                });
                if (blocked) {
                    res.status(400).json({ error: blocked, code: 'INSTALLMENTS_UNAVAILABLE' });
                    return;
                }
            }
        }

        // Re-pay of a FAILED/expired charge (e.g. an expired PIX the reconciliation marked
        // FAILED, shown as payable in "Meus Pagamentos"). Reset to PENDING and DROP the dead
        // gateway artifacts so we mint a FRESH charge — never reuse the stale, unpayable QR/PI
        // (the P2 reuse guard below keys off pixString) — and so the webhook/reconciliation,
        // which only act on PENDING, can confirm the new charge.
        // PaymentIntent de cartão já emitido para esta cobrança (a reabertura de FAILED abaixo zera o
        // providerRef): o ramo cartão o resolve antes de criar outro (settleExistingCardIntent).
        const previousCardIntent = payment.providerRef?.startsWith('pi_') ? payment.providerRef : null;

        if (payment.status === 'FAILED') {
            // pagamentos-6: uma linha FAILED com cobrança PIX pode ter o QR ainda VIVO (ex.: falhada por um
            // evento de cartão atrasado). Zerar o providerRef aqui descartava o txid sem cancelar a cob —
            // um pagamento nela nunca casaria. Por isso a linha PIX é reaberta COM a cobrança: a emissão
            // (issuePixCharge) reaproveita a viva de mesmo valor ou a concilia/cancela antes de emitir
            // outra; o ramo cartão a aposenta antes do PaymentIntent. Demais provedores: descarta como antes.
            const keepPix = isPixProvider(payment.provider) && !!payment.providerRef;
            const discardMeta = keepPix ? undefined : pixMetadataAfterDiscard(payment);
            const reopened = await prisma.payment.updateMany({
                where: { id: payment.id, status: 'FAILED' },
                data: {
                    status: 'PENDING', boletoUrl: keepPix ? payment.boletoUrl : null, chargedAmount: null,
                    ...(keepPix ? {} : { providerRef: null, pixString: null, pixExpiresAt: null }),
                    ...(discardMeta !== undefined ? { metadata: discardMeta } : {}),
                },
            });
            if (reopened.count === 0) {
                res.status(409).json({ error: 'Esta cobrança mudou de situação. Atualize a página e tente novamente.' });
                return;
            }
            payment.status = 'PENDING';
            payment.chargedAmount = null;
            if (!keepPix) {
                payment.providerRef = null;
                payment.pixString = null;
                payment.pixExpiresAt = null;
                payment.boletoUrl = null;
            }
            if (discardMeta !== undefined) payment.metadata = discardMeta as typeof payment.metadata;
        }

        // NOTA: o Stripe customer é criado apenas no fluxo de CARTÃO (abaixo). PIX/boleto não
        // precisam dele — criá-lo aqui quebrava o PIX quando o Stripe não está configurado.

        if (data.paymentMethod === 'pix') {
            // D15: fonte única (issuePixCharge). Reusa a cobrança SÓ se viva (pixExpiresAt), com BR Code
            // válido e o MESMO valor; senão concilia a anterior (paga → alreadyPaid), cancela-a e emite
            // nova com txid de tentativa. A validade acompanha a reserva/prazo (avulso = 10 min).
            try {
                const pix = await issuePixCharge(payment.id, {
                    description: `Pagamento PIX - ${payment.contract?.name || 'Avulso'}`,
                });
                if (pix.alreadyPaid) {
                    res.json({
                        provider: pix.provider,
                        status: 'PAID',
                        alreadyPaid: true,
                        amount: pix.amount,
                        paymentId: payment.id,
                    });
                    return;
                }
                res.json({
                    provider: pix.provider,
                    pixString: pix.pixString,
                    qrCodeDataUrl: pix.qrCodeDataUrl,
                    // Compat: o base64 cru (sem o prefixo data:) para quem ainda lê qrCodeBase64.
                    qrCodeBase64: pix.qrCodeDataUrl ? pix.qrCodeDataUrl.replace(/^data:image\/png;base64,/, '') : null,
                    expiresAt: pix.expiresAt,
                    amount: pix.amount,
                    reused: pix.reused,
                    alreadyPaid: false,
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
            // Troca PIX → boleto: a cobrança PIX viva é aposentada ANTES de sobrescrever o providerRef
            // (senão o QR continua pagável e o webhook não acha mais o Payment pelo txid).
            if (isPixProvider(payment.provider) && payment.providerRef && payment.pixString) {
                const retired = await retirePixCharge(payment.id);
                if (retired === 'paid') {
                    res.status(400).json({ error: 'Este pagamento já foi confirmado via PIX.', status: 'PAID', alreadyPaid: true });
                    return;
                }
                if (retired === 'live') {
                    res.status(409).json({ error: PIX_LIVE_CHARGE_MESSAGE });
                    return;
                }
                const boletoDiscardMeta = pixMetadataAfterDiscard(payment);
                await prisma.payment.updateMany({
                    where: { id: payment.id, status: 'PENDING' },
                    data: { pixString: null, pixExpiresAt: null, ...(boletoDiscardMeta !== undefined ? { metadata: boletoDiscardMeta } : {}) },
                });
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
        // D1 (pagamentos-3): o desconto PIX do "à vista" nunca vale no cartão — um Payment criado com
        // PIX é cobrado aqui pelo valor SEM o desconto PIX (a base marcada em metadata.pixDiscount na
        // criação; sem marca, o próprio amount — nunca recalculado pelo % atual).
        let amount = await cardChargeBaseAmount(payment);
        // Valor zero (cupom 100%) nunca vai ao gateway (o Stripe recusa abaixo do mínimo).
        if (amount <= 0) {
            res.status(400).json({ error: 'Valor do pagamento inválido.' });
            return;
        }
        // D1: a política lê também metadata.installmentCap (serviço parcelado / à vista = 1x).
        const policy = getInstallmentPolicy(policyInputsFromPayment(payment));
        let installments = Math.min(data.installments || 1, policy.maxInstallments);

        if (data.paymentMethod === 'cartao' && installments > policy.freeUpTo) {
            const plans = await stripeGetInstallmentPlans(amount, policy.freeUpTo);
            const plan = plans.find(p => p.count === installments);
            if (plan) amount = plan.total;
        }

        // PI anterior desta cobrança: aprovado/processando → não cria outro; pagável com OUTRO valor →
        // cancelado antes (senão, pago numa aba aberta, vira dinheiro sem registro — o webhook recusa o
        // valor divergente); não deu para conferir → não cria agora (fail-closed).
        const previousPi = await settleExistingCardIntent(previousCardIntent, amount);
        if (previousPi.state === 'in_flight') {
            if (previousPi.status === 'succeeded') {
                console.error(`[Stripe] create-payment: PI ${previousCardIntent} já aprovado para o payment ${payment.id} — nenhum PI novo (aguardando webhook/verify).`);
            }
            res.status(409).json({ error: cardIntentInFlightMessage(previousPi.status), code: 'CARD_PAYMENT_IN_FLIGHT' });
            return;
        }
        if (previousPi.state === 'unknown') {
            res.status(503).json({ error: 'Não foi possível conferir a tentativa anterior no cartão agora. Tente novamente em instantes.' });
            return;
        }

        // Troca PIX → cartão: aposenta a cobrança PIX viva ANTES de sobrescrever o providerRef (senão
        // o QR antigo continua pagável e o webhook do Sicoob não acha mais o Payment pelo txid).
        // Se a conciliação mostrar que o PIX já foi pago, não cobra o cartão.
        const pixDiscardMeta = pixMetadataAfterDiscard(payment);
        if (isPixProvider(payment.provider) && payment.providerRef) {
            const retired = await retirePixCharge(payment.id);
            if (retired === 'paid') {
                res.status(400).json({ error: 'Este pagamento já foi confirmado via PIX.', status: 'PAID', alreadyPaid: true });
                return;
            }
            if (retired === 'live') {
                // pagamentos-4: o QR anterior continua pagável e não pôde ser cancelado — cobrar o cartão
                // agora arriscaria cobrança dupla (e o PIX pago ficaria sem registro).
                res.status(409).json({ error: 'Há um QR PIX desta cobrança que ainda pode ser pago e não pôde ser cancelado agora. Pague pelo PIX ou tente o cartão novamente em instantes.' });
                return;
            }
            // Aposentado: a linha deixa de ser PIX JÁ (se o PaymentIntent falhar abaixo, o QR cancelado
            // não pode ser reaproveitado como vivo; a recusa do cartão casa com provider STRIPE sem ref).
            await prisma.payment.updateMany({
                where: { id: payment.id, status: 'PENDING' },
                data: {
                    provider: 'STRIPE', providerRef: null, pixString: null, pixExpiresAt: null,
                    ...(pixDiscardMeta !== undefined ? { metadata: pixDiscardMeta } : {}),
                },
            });
        }

        // Get or create Stripe Customer for the PAYER (client), not the requester. Só no cartão.
        const customerId = await stripeGetOrCreateCustomer(payerUserId);

        // Create PaymentIntent (CARDS ONLY now).
        // N > 1 aqui só chega com cartão SALVO numa conta com parcelamento (recusado acima nos demais casos):
        // o nº escolhido vai ao Stripe na confirmação (installmentPlanCount), conferido em available_plans.
        // Cartão novo sai sempre em 1× e sem parcelamento no PI (o Payment Element não mostra seletor).
        const result = await stripeCreatePaymentIntent({
            amount,
            customerId,
            description: `Pagamento - ${payment.contract?.name || 'Avulso'}`,
            paymentId: payment.id,
            userId: payerUserId,
            contractId: payment.contractId || undefined,
            installmentsEnabled: installments > 1,
            installmentPlanCount: data.savedPaymentMethodId ? installments : undefined,
            savedPaymentMethodId: data.savedPaymentMethodId,
            savePaymentMethod: data.savePaymentMethod,
        });

        // Update our payment with the Stripe reference AND the fee-adjusted total in
        // `chargedAmount` — NOT in `amount`. Keeping `amount` as the immutable base means a
        // retry recomputes the surcharge from the base (never compounding) and PIX/boleto keep
        // charging the base. The card amount-parity check (verify/webhook) compares pi.amount
        // against COALESCE(chargedAmount, amount), so it still accepts the fee-adjusted charge.
        await prisma.payment.update({
            where: { id: payment.id },
            data: {
                providerRef: result.paymentIntentId,
                provider: 'STRIPE',
                chargedAmount: amount,
                installments,
                // Cartão não tem QR: limpa o PIX anterior (o reuso do PIX exige cobrança viva).
                pixString: null,
                pixExpiresAt: null,
                ...(pixDiscardMeta !== undefined ? { metadata: pixDiscardMeta } : {}),
            },
        });

        res.json({
            provider: 'STRIPE',
            clientSecret: result.clientSecret,
            paymentIntentId: result.paymentIntentId,
            // Valor EFETIVAMENTE cobrado no cartão (= chargedAmount: sem o desconto PIX do à vista, com os
            // juros do parcelamento quando houver) — o checkout exibe este valor no formulário do cartão.
            amount,
            installments,
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
    // Prévia sem Payment (wizard de serviço, D1): teto de parcelas SEM juros (1 = só à vista).
    installmentCap: z.number().int().min(1).max(12).optional(),
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
            // Parcelas do CARTÃO: sobre o valor cobrado no cartão (sem o desconto PIX do à vista — D1).
            amount = await cardChargeBaseAmount(payment);
            policy = getInstallmentPolicy(policyInputsFromPayment(payment));
        } else if (data.installmentCap) {
            policy = getInstallmentPolicy({ plan: 'FULL', contractType: 'SERVICO', durationMonths: data.contractDurationMonths || 1, installmentCap: data.installmentCap });
        } else {
            policy = getInstallmentPolicy({ plan: 'FULL', durationMonths: data.contractDurationMonths || 1 });
        }

        if (amount <= 0) {
            res.status(400).json({ error: 'Valor inválido.' });
            return;
        }

        // pagamentos-1 / cobertura-1: sem parcelamento no gateway (conta Stripe BR), só 1x — nunca oferecer
        // N× que seria cobrado em 1× (o create-payment recusa N > 1 nesse caso).
        const maxCount = (await stripeCardInstallmentsSupported()) ? policy.maxInstallments : 1;
        const plans = (await stripeGetInstallmentPlans(amount, policy.freeUpTo))
            .filter(p => p.count <= maxCount);
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
            // SEC FIX (S2): posse ESTRITA — rejeitar também quando metadata.paymentId está AUSENTE.
            // Todo PI de cartão criado para um Payment grava metadata.paymentId incondicionalmente
            // (stripeService.stripeCreatePaymentIntent). PIs sem esse metadata são PIs de FATURA de
            // assinatura (metadata fica na subscription) — que NÃO devem ser confirmados por aqui
            // (a assinatura confirma via webhook). Antes, metadata ausente pulava a checagem e um PI
            // de assinatura de mesmo valor podia quitar um Payment PENDING sem cobrança correspondente.
            if (pi.metadata?.paymentId !== data.paymentId) {
                console.error(`[Stripe:Verify] PI ownership mismatch: PI.meta=${pi.metadata?.paymentId}, requested=${data.paymentId}`);
                res.status(400).json({ error: 'PaymentIntent não pertence a este pagamento.' });
                return;
            }

            // VULN-07 FIX: Verify amount matches before accepting. Card charges may carry an
            // installment surcharge stored in chargedAmount; PIX/boleto have none (→ amount).
            const expectedAmount = payment.chargedAmount ?? payment.amount;
            if (pi.amount !== expectedAmount) {
                console.error(`[Stripe:Verify] Amount mismatch: PI=${pi.amount}, DB=${expectedAmount} for payment ${payment.id}`);
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
                // A linha tinha um QR PIX (cartão aprovado depois da troca para PIX): cancela o QR.
                if (payment.provider !== 'STRIPE' && payment.providerRef) {
                    await cancelStalePixCharge(payment.provider, payment.providerRef, payment.pixString);
                }
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
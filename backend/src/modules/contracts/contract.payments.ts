import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middleware/auth.js';
import { getBasePriceDynamic, applyDiscount } from '../../utils/pricing.js';
import { getConfig } from '../../lib/businessConfig.js';
import { computeAddonsCost, serviceMonthlyBase, computeMonthlyAmount } from '../../lib/contractPricing.js';
import { validatePaymentMethod, PaymentMethodDisabledError } from '../../lib/paymentGateway.js';
import { contractPaySchema, subscribeSchema, clientRenewSchema } from './validators.js';
import { CouponError, validateCoupon, reserveCouponUse, releaseAndPurgeCouponsForPayments, type CouponQuote } from '../../lib/couponService.js';

export function registerPaymentRoutes(router: Router) {

// ─── POST /api/contracts/:id/pay ─────────────────────────
// Client pays a contract that is AWAITING_PAYMENT

router.post('/:id/pay', authenticate, async (req: Request, res: Response) => {
    try {
        const contractId = req.params.id as string;
        const userId = req.user!.userId;
        const data = contractPaySchema.parse(req.body);

        const contract = await prisma.contract.findFirst({
            where: { id: contractId, userId, status: 'AWAITING_PAYMENT' },
        });

        if (!contract) {
            res.status(404).json({ error: 'Contrato não encontrado ou não está aguardando pagamento.' });
            return;
        }

        // AVULSO micro-contracts are paid by their BOOKING payment (single avulso amount), never by
        // the monthly-contract pay flow — which would compute sessions×tier (a full month) and create
        // a spurious extra charge. Reject here; the avulso checkout pays the booking directly.
        if (contract.type === 'AVULSO') {
            res.status(400).json({ error: 'Este agendamento avulso é pago pelo próprio agendamento, não por aqui.' });
            return;
        }

        // Calculate the monthly installment amount — centralized via paymentPolicy.
        // A monthly installment is a single 1x charge with NO card surcharge (PIX or card),
        // identical across every creation path.
        // SERVICO (standalone monthly service) has NO recordings: its per-month base is the
        // service add-on's price after discount, not sessions×tier (which would over-charge).
        let monthlyAmount: number;
        // D1: valor da mesma cobrança no CARTÃO quando `monthlyAmount` embute o desconto PIX do à vista.
        let cardFullAmount: number | null = null;
        let pixDiscountPct = 0;
        if (contract.type === 'SERVICO') {
            const svcMonthly = await serviceMonthlyBase(contract);
            // FULL-plan service is paid à-vista (all N months at once); MONTHLY charges one month.
            // Without this, paying a FULL service via /pay would collect only 1/N and no
            // installments 2..N are ever generated (the generator skips FULL).
            if (contract.paymentPlan === 'FULL') {
                const { computeFullContractTotal } = await import('../../lib/contractPricing.js');
                monthlyAmount = await computeFullContractTotal(svcMonthly, contract.durationMonths, contract.paymentMethod || undefined);
                if (contract.paymentMethod === 'PIX') {
                    cardFullAmount = await computeFullContractTotal(svcMonthly, contract.durationMonths, 'CARTAO');
                    pixDiscountPct = Number(await getConfig('pix_extra_discount_pct')) || 0;
                }
            } else {
                monthlyAmount = svcMonthly;
            }
        } else if (contract.type === 'CUSTOM') {
            // B22: CUSTOM é precificado por sessionsPerCycle (fonte única computeMonthlyAmount). O
            // cálculo inline por sessions_per_month global (4) subfaturava CUSTOM — sobretudo na
            // RENOVAÇÃO, cuja 1ª parcela é precificada aqui (sem installments pré-gerados).
            monthlyAmount = await computeMonthlyAmount(contract);
        } else {
            const tierPrice = await getBasePriceDynamic(contract.tier);
            const discountedPrice = applyDiscount(tierPrice, contract.discountPct);
            const sessionsPerMonth = await getConfig('sessions_per_month');
            const payAddonsCost = await computeAddonsCost(contract.addOns, contract.discountPct, sessionsPerMonth);
            monthlyAmount = (sessionsPerMonth * discountedPrice) + payAddonsCost;
        }

        // PAY-M1 FIX: Reuse existing pending payment for the same contract instead of creating orphans.
        // contratos-2: a parcela reaproveitada é a PRIMEIRA a vencer (menor dueDate; desempate estável) —
        // o personalizado do cliente nasce com TODAS as parcelas PENDING (createMany, mesmo createdAt;
        // com cupom a 1ª é criada antes) e "a mais recente por createdAt" cobrava uma parcela futura.
        const existingPending = await prisma.payment.findFirst({
            where: { contractId, userId, status: 'PENDING' },
            orderBy: [{ dueDate: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }, { id: 'asc' }],
            include: { contract: { select: { type: true, paymentPlan: true, paymentMethod: true } } },
        });

        // Coupon: only when a NEW pending payment is being created. ANY existing pending row
        // is reused (C9: a pre-created installment 2..N, or one started under the other method) —
        // its amount was locked when it was generated and is never repriced through /pay.
        let payCoupon: CouponQuote | null = null;
        if (data.couponCode) {
            if (!existingPending) {
                payCoupon = await validateCoupon({ code: data.couponCode, userId, baseAmount: monthlyAmount });
            }
        }
        const payChargeAmount = payCoupon ? payCoupon.finalAmount : monthlyAmount;
        const payCouponFields = payCoupon ? {
            couponId: payCoupon.coupon.id,
            couponCode: payCoupon.coupon.code,
            discountAmount: payCoupon.discountAmount,
        } : {};
        // D1 (pagamentos-3): linha NOVA com desconto PIX embutido → grava o valor do cartão (sem o
        // desconto PIX; o mesmo cupom em R$) para o checkout nunca cobrar o desconto PIX no cartão.
        const { buildPixDiscountMeta } = await import('../../lib/pixGateway.js');
        const newRowPixDiscount = cardFullAmount !== null
            ? buildPixDiscountMeta({
                pixAmount: payChargeAmount,
                cardAmount: Math.max(0, cardFullAmount - (payCoupon?.discountAmount ?? 0)),
                pct: pixDiscountPct,
            })
            : undefined;
        const newRowMetadata = newRowPixDiscount ? { metadata: { pixDiscount: newRowPixDiscount } } : {};

        // 100% coupon → zero charge: no gateway; confirm immediately (activates the contract).
        if (payCoupon && payChargeAmount === 0) {
            const payment = await prisma.$transaction(async (tx) => {
                const p = await tx.payment.create({
                    data: {
                        userId, contractId, provider: 'CORA', amount: 0,
                        status: 'PENDING', dueDate: new Date(), installments: 1, ...payCouponFields,
                    },
                });
                await reserveCouponUse(tx, {
                    couponId: payCoupon!.coupon.id, userId, paymentId: p.id,
                    originalAmount: monthlyAmount, discountAmount: payCoupon!.discountAmount,
                    maxUsesPerUser: payCoupon!.coupon.maxUsesPerUser,
                });
                return p;
            });
            await prisma.payment.updateMany({ where: { id: payment.id, status: 'PENDING' }, data: { status: 'PAID', paidAt: new Date() } });
            const { onPaymentConfirmed } = await import('../../lib/paymentEffects.js');
            await onPaymentConfirmed(payment.id);
            res.json({
                provider: 'CORA', paymentId: payment.id, amount: 0, alreadyPaid: true,
                couponDiscount: payCoupon.discountAmount,
                message: 'Cupom aplicado — contrato ativado sem cobrança!',
            });
            return;
        }

        // ─── PIX (Sicoob/Cora via issuePixCharge) ────────────
        if (data.paymentMethod === 'PIX') {
            const { issuePixCharge } = await import('../../lib/pixGateway.js');

            // C9: reuse the single pending row (a pre-created installment 2..N, or a pending
            // started under the other method) instead of minting a duplicate charge. Its amount
            // is the one locked at generation; only a brand-new row prices the coupon. A fresh
            // Payment (+ atomic coupon reservation) is created ONLY when no pending exists.
            // D15: o QR sai do issuePixCharge — reusa só a cobrança viva e com o mesmo valor; senão
            // concilia/cancela a antiga e emite nova (antes reusava qualquer pixString, até expirado).
            const payment = existingPending ?? await prisma.$transaction(async (tx) => {
                const p = await tx.payment.create({
                    data: {
                        userId,
                        contractId,
                        provider: 'CORA',
                        amount: payChargeAmount,
                        status: 'PENDING',
                        dueDate: new Date(),
                        installments: 1,
                        ...payCouponFields,
                        ...newRowMetadata,
                    },
                });
                if (payCoupon) {
                    await reserveCouponUse(tx, {
                        couponId: payCoupon.coupon.id, userId, paymentId: p.id,
                        originalAmount: monthlyAmount, discountAmount: payCoupon.discountAmount,
                        maxUsesPerUser: payCoupon.coupon.maxUsesPerUser,
                    });
                }
                return p;
            });

            try {
                const pix = await issuePixCharge(payment.id, {
                    description: `PIX - Contrato "${contract.name}" - ${contract.tier}`,
                });
                if (pix.alreadyPaid) {
                    res.json({
                        provider: pix.provider,
                        paymentId: payment.id,
                        amount: pix.amount,
                        alreadyPaid: true,
                        message: 'Pagamento já confirmado.',
                    });
                    return;
                }

                res.json({
                    provider: pix.provider,
                    paymentId: payment.id,
                    pixString: pix.pixString,
                    qrCodeDataUrl: pix.qrCodeDataUrl,
                    qrCodeBase64: pix.qrCodeDataUrl ? pix.qrCodeDataUrl.replace(/^data:image\/png;base64,/, '') : null,
                    expiresAt: pix.expiresAt,
                    amount: pix.amount,
                    reused: pix.reused,
                    ...(payCoupon && { couponDiscount: payCoupon.discountAmount }),
                    message: pix.reused
                        ? 'QR Code PIX já gerado. Escaneie para ativar o contrato.'
                        : 'QR Code PIX gerado. Escaneie para ativar o contrato.',
                });
            } catch (e: unknown) {
                // Provider failed. Only purge a row WE just created — never delete a pre-existing
                // installment we merely reused (that would erase a real debt).
                if (!existingPending) {
                    await releaseAndPurgeCouponsForPayments([payment.id]);
                    await prisma.payment.delete({ where: { id: payment.id } }).catch(() => {});
                }
                const msg = e instanceof Error ? e.message : 'Erro ao gerar PIX.';
                res.status(400).json({ error: msg });
            }
            return;
        }

        // ─── CARTÃO: Stripe ──────────────────────────────────
        // A monthly installment is a SINGLE 1x charge (no surcharge, no card splitting),
        // per the unified payment policy. Card-installment juros only exists on the FULL
        // (à-vista) plan, which is paid at contract creation — never through /pay.
        const installments = 1;
        const maxInstallments = 1;

        const { stripeCreatePaymentIntent, stripeGetOrCreateCustomer, isStripeEnabled } = await import('../../lib/stripeService.js');

        if (!(await isStripeEnabled())) {
            res.status(503).json({ error: 'Stripe não está habilitado.' });
            return;
        }

        const customerId = await stripeGetOrCreateCustomer(userId);

        const { retirePixCharge, isPixProvider, pixMetadataAfterDiscard, cardChargeBaseAmount, settleExistingCardIntent, cardIntentInFlightMessage } = await import('../../lib/pixGateway.js');

        // C9: reuse the single pending row (a pre-created installment 2..N whose PI was never
        // issued, a row whose PI expired, or one started under PIX) instead of minting a
        // duplicate charge. Its recorded amount wins; only a brand-new row prices the coupon.
        // D1 (pagamentos-3): o desconto PIX do à vista nunca vale no cartão — cobra a base marcada na
        // criação (metadata.pixDiscount) ou, sem marca, o próprio amount. Calculado ANTES de qualquer
        // regravação do metadata (o pixMetadataAfterDiscard abaixo preserva a marca).
        const newRowAmount = payChargeAmount;
        const chargeAmount = existingPending
            ? await cardChargeBaseAmount(existingPending)
            : (newRowPixDiscount?.cardAmount ?? newRowAmount);

        // PAY-M1: PI já emitido para a linha reaproveitada — reaproveita SÓ se ainda pagável e com o valor do
        // cartão desta cobrança; pagável com OUTRO valor → cancelado e um novo é emitido; aprovado/processando →
        // nenhum PI novo (409); não deu para conferir → 503 (nunca um 2º PI às cegas).
        if (existingPending?.providerRef?.startsWith('pi_')) {
            const previousPi = await settleExistingCardIntent(existingPending.providerRef, chargeAmount);
            if (previousPi.state === 'reusable' && existingPending.provider === 'STRIPE') {
                res.json({
                    provider: 'STRIPE',
                    clientSecret: previousPi.clientSecret,
                    paymentId: existingPending.id,
                    amount: chargeAmount,
                    maxInstallments,
                    message: 'PaymentIntent existente reutilizado.',
                });
                return;
            }
            if (previousPi.state === 'in_flight') {
                res.status(409).json({ error: cardIntentInFlightMessage(previousPi.status), code: 'CARD_PAYMENT_IN_FLIGHT' });
                return;
            }
            if (previousPi.state === 'unknown') {
                res.status(503).json({ error: 'Não foi possível conferir a tentativa anterior no cartão agora. Tente novamente em instantes.' });
                return;
            }
        }

        // Troca PIX → cartão numa linha reaproveitada: aposenta a cobrança PIX viva antes de
        // sobrescrever o providerRef (se já foi paga, não cobra o cartão).
        const pixDiscardMeta = existingPending ? pixMetadataAfterDiscard(existingPending) : undefined;
        if (existingPending && isPixProvider(existingPending.provider) && existingPending.providerRef) {
            const retired = await retirePixCharge(existingPending.id);
            if (retired === 'paid') {
                res.json({
                    provider: existingPending.provider,
                    paymentId: existingPending.id,
                    amount: existingPending.amount,
                    alreadyPaid: true,
                    message: 'Pagamento já confirmado via PIX.',
                });
                return;
            }
            if (retired === 'live') {
                // pagamentos-4: QR anterior ainda pagável e não cancelável agora → não cobra o cartão por cima.
                res.status(409).json({ error: 'Há um QR PIX desta cobrança que ainda pode ser pago e não pôde ser cancelado agora. Pague pelo PIX ou tente o cartão novamente em instantes.' });
                return;
            }
            // Aposentado: a linha deixa de ser PIX já (se o PaymentIntent falhar abaixo, o QR cancelado
            // não pode ser reaproveitado como vivo).
            await prisma.payment.updateMany({
                where: { id: existingPending.id, status: 'PENDING' },
                data: {
                    provider: 'STRIPE', providerRef: null, pixString: null, pixExpiresAt: null,
                    ...(pixDiscardMeta !== undefined ? { metadata: pixDiscardMeta } : {}),
                },
            });
        }

        const payment = existingPending ?? await prisma.$transaction(async (tx) => {
            const p = await tx.payment.create({
                data: {
                    userId,
                    contractId,
                    provider: 'STRIPE',
                    amount: newRowAmount,
                    status: 'PENDING',
                    dueDate: new Date(),
                    installments,
                    paymentType: data.paymentType || 'CREDIT',
                    ...payCouponFields,
                    ...newRowMetadata,
                },
            });
            if (payCoupon) {
                await reserveCouponUse(tx, {
                    couponId: payCoupon.coupon.id, userId, paymentId: p.id,
                    originalAmount: monthlyAmount, discountAmount: payCoupon.discountAmount,
                    maxUsesPerUser: payCoupon.coupon.maxUsesPerUser,
                });
            }
            return p;
        });

        let piResult;
        try {
            piResult = await stripeCreatePaymentIntent({
                amount: chargeAmount,
                customerId,
                description: `Contrato "${contract.name}" - ${contract.tier} ${contract.durationMonths}m`,
                paymentId: payment.id,
                userId,
                contractId,
                installmentsEnabled: false,
            });
        } catch (err) {
            // Stripe failed. Only purge a row WE just created; never delete a reused
            // installment (that would erase a real debt). Retries stay idempotent.
            if (!existingPending) {
                await releaseAndPurgeCouponsForPayments([payment.id]);
                await prisma.payment.delete({ where: { id: payment.id } }).catch(() => {});
            }
            const msg = err instanceof Error ? err.message : 'Erro ao iniciar o pagamento com cartão. Tente novamente.';
            res.status(502).json({ error: msg });
            return;
        }

        // Realign the (possibly reused) row to this fresh card PaymentIntent: STRIPE provider,
        // the new PI ref, and drop any stale PIX QR carried over from an earlier method switch.
        await prisma.payment.update({
            where: { id: payment.id },
            data: {
                providerRef: piResult.paymentIntentId, provider: 'STRIPE', pixString: null, pixExpiresAt: null,
                // Valor do PI (paridade do webhook/verify: chargedAmount ?? amount).
                chargedAmount: chargeAmount,
                ...(pixDiscardMeta !== undefined ? { metadata: pixDiscardMeta } : {}),
            },
        });

        res.json({
            provider: 'STRIPE',
            clientSecret: piResult.clientSecret,
            paymentId: payment.id,
            amount: chargeAmount,
            ...(payCoupon && { couponDiscount: payCoupon.discountAmount }),
            maxInstallments,
            message: 'PaymentIntent criado. Complete o pagamento para ativar o contrato.',
        });
    } catch (err: any) {
        console.error('[CONTRACT-PAY]', err);
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        if (err instanceof CouponError) {
            res.status(err.httpStatus).json({ error: err.message, code: err.code });
            return;
        }
        res.status(500).json({ error: 'Erro ao processar pagamento.' });
    }
});

// ─── POST /api/contracts/:id/confirm-payment ────────────
// Called after successful Stripe payment to activate an AWAITING_PAYMENT contract

router.post('/:id/confirm-payment', authenticate, async (req: Request, res: Response) => {
    try {
        const contractId = req.params.id as string;
        const userId = req.user!.userId;
        const { paymentIntentId } = req.body;

        const contract = await prisma.contract.findFirst({
            where: { id: contractId, userId, status: 'AWAITING_PAYMENT' },
        });

        if (!contract) {
            res.status(404).json({ error: 'Contrato não encontrado ou já está ativo.' });
            return;
        }

        // VULN-02 FIX: Verify payment with Stripe before activating
        if (paymentIntentId) {
            const { stripeGetPaymentIntent } = await import('../../lib/stripeService.js');
            const pi = await stripeGetPaymentIntent(paymentIntentId);

            if (pi.status !== 'succeeded') {
                res.status(402).json({ error: 'Pagamento ainda não confirmado pelo Stripe.' });
                return;
            }

            // Verify the payment belongs to this contract
            const payment = await prisma.payment.findFirst({
                where: { contractId, providerRef: paymentIntentId, status: 'PENDING' },
            });

            if (!payment) {
                res.status(400).json({ error: 'Nenhum pagamento pendente encontrado para este contrato com este PaymentIntent.' });
                return;
            }

            // VULN-07 FIX: Verify amount matches. B11: cartão parcelado guarda o total com juros em
            // chargedAmount (fix A1) — comparar contra (chargedAmount ?? amount), como verify/webhook.
            const expectedAmount = payment.chargedAmount ?? payment.amount;
            if (pi.amount !== expectedAmount) {
                console.error(`[CONTRACT-CONFIRM] Amount mismatch: PI=${pi.amount}, DB=${expectedAmount}`);
                res.status(400).json({ error: 'Valor do pagamento não confere.' });
                return;
            }

            // Mark payment as PAID atomically (VULN-09 fix)
            await prisma.payment.updateMany({
                where: { contractId, providerRef: paymentIntentId, status: 'PENDING' },
                data: { status: 'PAID', paidAt: new Date() },
            });
        } else {
            // No paymentIntentId provided — cannot confirm without proof
            res.status(400).json({ error: 'paymentIntentId é obrigatório para confirmar pagamento.' });
            return;
        }

        // Activate contract atomically (VULN-09 fix)
        const activated = await prisma.contract.updateMany({
            where: { id: contractId, status: 'AWAITING_PAYMENT' },
            data: { status: 'ACTIVE', paymentDeadline: null },
        });

        if (activated.count === 0) {
            // Contract was already activated (race condition with webhook)
            res.json({ contract: { id: contractId, status: 'ACTIVE' }, message: 'Contrato já ativado.' });
            return;
        }

        // VULN-H4 FIX: Trigger contract fulfillment (bookings + remaining installments)
        // The fulfillContractFromPayment function is idempotent (guards against double-creation)
        const paidPayment = await prisma.payment.findFirst({
            where: { contractId, status: 'PAID' },
            orderBy: { paidAt: 'desc' },
        });
        if (paidPayment) {
            try {
                // FIX (C10): usar a fonte ÚNICA de efeitos de confirmação (idempotente) — inclui
                // fulfillment, bookings de renovação E generateRemainingInstallments (meses 2..N).
                // Antes, confirmar por aqui não gerava as parcelas futuras (dependia do webhook).
                const { onPaymentConfirmed } = await import('../../lib/paymentEffects.js');
                await onPaymentConfirmed(paidPayment.id);
            } catch (fulfillErr) {
                console.error('[CONTRACT-CONFIRM-PAYMENT] Confirmation effects error (non-blocking):', fulfillErr);
            }
        }

        res.json({
            contract: { id: contractId, status: 'ACTIVE' },
            message: '✅ Contrato ativado! Agora você pode agendar seus horários.',
        });
    } catch (err) {
        console.error('[CONTRACT-CONFIRM-PAYMENT]', err);
        res.status(500).json({ error: 'Erro ao confirmar pagamento do contrato.' });
    }
});

// ─── POST /api/contracts/:id/subscribe ──────────────────
// Setup recurring Stripe subscription for an existing contract (Client-side)

router.post('/:id/subscribe', authenticate, async (req: Request, res: Response) => {
    try {
        const contractId = req.params.id as string;
        const userId = req.user!.userId;
        const data = subscribeSchema.parse(req.body);

        const contract = await prisma.contract.findFirst({
            where: { id: contractId, userId },
        });

        if (!contract) {
            res.status(404).json({ error: 'Contrato não encontrado.' });
            return;
        }

        if (contract.status !== 'ACTIVE' && contract.status !== 'AWAITING_PAYMENT') {
            res.status(400).json({ error: 'Só é possível assinar contratos ativos ou aguardando pagamento.' });
            return;
        }

        const user = await prisma.user.findUnique({ where: { id: userId } });
        if (!user || !user.stripeCustomerId) {
            res.status(400).json({ error: 'Customer não configurado no Stripe.' });
            return;
        }

        const duration = data.durationMonths || contract.durationMonths;

        // FIX (C3): mesma base mensal do /pay — sessions_per_month × tier-com-desconto + add-ons
        // (e serviceMonthlyBase para SERVICO). Antes usava basePrice*4 fixo, sem add-ons e sem
        // tratar SERVICO, subfaturando a assinatura recorrente todo mês.
        const monthlyAmount = await computeMonthlyAmount(contract);

        const { stripeCreateSubscription } = await import('../../lib/stripeService.js');

        // Create initial payment record
        const payment = await prisma.payment.create({
            data: {
                userId,
                contractId: contract.id,
                amount: monthlyAmount,
                provider: 'STRIPE',
                status: 'PENDING',
                dueDate: new Date(),
                paymentType: 'CREDIT',
            }
        });

        const subResult = await stripeCreateSubscription({
            customerId: user.stripeCustomerId,
            paymentMethodId: data.paymentMethodId,
            amount: monthlyAmount,
            contractId: contract.id,
            userId: user.id,
            paymentId: payment.id,
            description: `Assinatura ${contract.name} (${contract.tier})`,
            durationMonths: duration,
        });

        // PAY-M1 FIX: Persist BOTH providerRef and stripeSubscriptionId
        // The webhook handler (invoice.payment_succeeded) searches by stripeSubscriptionId
        if (subResult.subscriptionId) {
            await prisma.payment.update({
                where: { id: payment.id },
                data: {
                    providerRef: subResult.subscriptionId,
                    stripeSubscriptionId: subResult.subscriptionId,
                },
            });
        }

        // PAY-01 FIX: Only activate if subscription is fully active (first payment confirmed)
        if (contract.status === 'AWAITING_PAYMENT') {
            if (subResult.status === 'active') {
                await prisma.contract.updateMany({
                    where: { id: contract.id, status: 'AWAITING_PAYMENT' },
                    data: { status: 'ACTIVE', paymentDeadline: null, durationMonths: duration },
                });
            } else {
                // Subscription is 'incomplete' (3DS pending, insufficient funds, etc.)
                // Keep contract as AWAITING_PAYMENT — webhook will activate when paid
                console.log(`[SUBSCRIBE] Subscription ${subResult.subscriptionId} status=${subResult.status} — contract stays AWAITING_PAYMENT`);
            }
        } else if (data.durationMonths && data.durationMonths !== contract.durationMonths) {
            await prisma.contract.update({
                where: { id: contract.id },
                data: { durationMonths: duration },
            });
        }

        res.json({
            success: true,
            subscriptionId: subResult.subscriptionId,
            status: subResult.status,
            message: 'Assinatura configurada com sucesso.',
        });

    } catch (err: any) {
        console.error('[SUBSCRIBE]', err);
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        res.status(500).json({ error: 'Erro ao configurar assinatura.' });
    }
});

// ─── POST /api/contracts/:id/client-renew ───────────────
// Allows client to renew their active or expired contract manually

router.post('/:id/client-renew', authenticate, async (req: Request, res: Response) => {
    try {
        const id = req.params.id as string;
        const userId = req.user!.userId;
        const data = clientRenewSchema.parse(req.body);

        const original = await prisma.contract.findFirst({ where: { id, userId } });
        if (!original) { res.status(404).json({ error: 'Contrato não encontrado.' }); return; }
        // D6: um plano CONCLUÍDO (todas as gravações feitas antes do fim da vigência) continua
        // renovável e é tratado como ATIVO (janela de 7 dias e início no fim do atual). Avulso não
        // se renova — é uma gravação única.
        const isCompletedPlan = original.status === 'COMPLETED' && original.type !== 'AVULSO';
        if (!['ACTIVE', 'EXPIRED'].includes(original.status) && !isCompletedPlan) {
            res.status(400).json({ error: 'Só é possível renovar contratos ativos, concluídos ou expirados.' });
            return;
        }
        const treatAsActive = original.status === 'ACTIVE' || isCompletedPlan;

        // Regra do dono: a renovação só pode acontecer UMA ÚNICA VEZ por contrato. Bloqueia se já
        // existir uma renovação não-cancelada (pendente OU já concluída) — só uma renovação
        // CANCELLED permite tentar de novo. (PAY-M2 cobria só a pendente; agora cobre "1x".)
        const existingRenewal = await prisma.contract.findFirst({
            where: { renewedFromId: id, status: { notIn: ['CANCELLED'] } },
            select: { status: true },
        });
        if (existingRenewal) {
            res.status(400).json({
                error: existingRenewal.status === 'AWAITING_PAYMENT'
                    ? 'Já existe uma renovação pendente para este contrato. Realize o pagamento ou aguarde a expiração.'
                    : 'Este contrato já foi renovado. A renovação só pode acontecer uma única vez.',
            });
            return;
        }

        // Regra do dono: janela de renovação = só nos 7 dias antes de expirar (ou já expirado).
        if (treatAsActive) {
            const DAY_MS = 24 * 60 * 60 * 1000;
            const daysToEnd = Math.ceil((new Date(original.endDate).getTime() - Date.now()) / DAY_MS);
            if (daysToEnd > 7) {
                res.status(400).json({ error: `A renovação fica disponível nos últimos 7 dias do contrato (ainda faltam ${daysToEnd} dias).` });
                return;
            }
        }

        // Resolve + validate the payment method (renewal must carry a usable method, else the
        // gateway would later crash on undefined.toUpperCase()). Falls back to the original's.
        const renewMethod = data.paymentMethod || original.paymentMethod;
        if (!renewMethod) {
            res.status(400).json({ error: 'Método de pagamento é obrigatório para renovação. Informe PIX, CARTÃO ou BOLETO.' });
            return;
        }
        try {
            await validatePaymentMethod(renewMethod);
        } catch (err) {
            if (err instanceof PaymentMethodDisabledError) {
                res.status(400).json({ error: err.message });
                return;
            }
            throw err;
        }

        // Calculate discount based on duration. SERVICO uses the distinct service_discount_*
        // config keys (same as the self-serve hire flow), not the recording-plan discounts.
        const isServiceRenew = original.type === 'SERVICO';
        const d6 = await getConfig(isServiceRenew ? 'service_discount_6months' : 'discount_6months');
        const d3 = await getConfig(isServiceRenew ? 'service_discount_3months' : 'discount_3months');
        const discountPct = data.durationMonths === 6 ? d6 : (data.durationMonths === 3 ? d3 : 0);

        // Start date: immediately if expired, or end of current contract if active
        let start = new Date();
        if (treatAsActive && new Date(original.endDate) > start) {
            start = new Date(original.endDate);
        }
        
        const end = new Date(start);
        end.setMonth(end.getMonth() + data.durationMonths);

        // FIX (C7): créditos FLEX vêm da config episodes_Nmonths (igual à criação/fulfillment),
        // não durationMonths*4 — senão a renovação entrega menos episódios do que foi vendido.
        const flexCreditsTotal = original.type === 'FLEX'
            ? await getConfig(data.durationMonths === 6 ? 'episodes_6months' : 'episodes_3months')
            : undefined;

        // Create the new contract as AWAITING_PAYMENT
        const pDeadline = new Date();
        pDeadline.setDate(pDeadline.getDate() + 3); // 3 days to pay

        const renewed = await prisma.contract.create({
            data: {
                name: original.name,
                userId: original.userId,
                type: original.type,
                tier: original.tier,
                durationMonths: data.durationMonths,
                discountPct,
                startDate: start,
                endDate: end,
                status: 'AWAITING_PAYMENT',
                paymentDeadline: pDeadline,
                fixedDayOfWeek: original.type === 'FIXO' ? original.fixedDayOfWeek : null,
                fixedTime: original.type === 'FIXO' ? original.fixedTime : null,
                contractUrl: original.contractUrl,
                addOns: original.addOns,
                paymentMethod: renewMethod,
                flexCreditsTotal: flexCreditsTotal ?? null,
                flexCreditsRemaining: flexCreditsTotal ?? null,
                flexCycleStart: null, // FLEX clock starts on the 1st recording
                flexForfeitFloor: original.type === 'FLEX' ? 0 : null, // not grandfathered
                // B22: CUSTOM precisa dos campos de ciclo copiados — senão computeMonthlyAmount cai no
                // fallback de 4 sessões/mês (subfatura ~50%) e a geração de bookings não sabe o schedule.
                ...(original.type === 'CUSTOM' ? {
                    sessionsPerWeek: original.sessionsPerWeek,
                    sessionsPerCycle: original.sessionsPerCycle,
                    totalSessions: original.totalSessions,
                    customSchedule: original.customSchedule,
                    addonCredits: original.addonCredits,
                    accessMode: original.accessMode,
                    customCreditsRemaining: original.customCreditsRemaining,
                } : {}),
                renewedFromId: original.id,
            },
        });

        // Audit log
        const { logAudit } = await import('../../lib/audit.js');
        await logAudit('CONTRACT', renewed.id, 'RENEWAL_REQUESTED', userId, { fromContractId: original.id, durationMonths: data.durationMonths });

        res.status(201).json({ contract: renewed, message: 'Renovação iniciada com sucesso. Realize o pagamento.' });
    } catch (err: any) {
        console.error('[CLIENT-RENEW]', err);
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        res.status(500).json({ error: 'Erro ao processar renovação.' });
    }
});

} // end registerPaymentRoutes

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
import { cancellationPendingBody } from '../../lib/cancellationPending.js';

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
            // E13: contrato com cancelamento em análise → resposta própria (409), em vez do 404 genérico:
            // o cliente não paga parcelas do plano até o estúdio decidir.
            const pendingCancellation = await prisma.contract.findFirst({
                where: { id: contractId, userId, status: 'PENDING_CANCELLATION' },
                select: { id: true },
            });
            if (pendingCancellation) {
                res.status(409).json(cancellationPendingBody());
                return;
            }
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
        // E2: à vista (FULL) → os DOIS preços da mesma cobrança (cartão e PIX) para a marca `pixDiscount`.
        let fullTotals: { cardTotal: number; pixTotal: number; pixPct: number } | null = null;
        if (contract.type === 'SERVICO') {
            const svcMonthly = await serviceMonthlyBase(contract);
            // FULL-plan service is paid à-vista (all N months at once); MONTHLY charges one month.
            // Without this, paying a FULL service via /pay would collect only 1/N and no
            // installments 2..N are ever generated (the generator skips FULL).
            if (contract.paymentPlan === 'FULL') {
                const { computeFullContractTotals } = await import('../../lib/contractPricing.js');
                const totals = await computeFullContractTotals(svcMonthly, contract.durationMonths, contract.paymentMethod || undefined);
                monthlyAmount = totals.total;
                fullTotals = totals;
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
        // Z1-d (fecha o CLI-2): só cobrança do PLANO (bookingId null) é reaproveitada. Um extra de gravação
        // (contractId + bookingId — de gravação viva ou cancelada) nunca é "a parcela do contrato": era pego
        // quando vencia antes e o /pay o cobrava no lugar da parcela (o contrato não ativava). Extras são
        // pagos pelo próprio Payment (POST /stripe/create-payment), que recusa os de gravação cancelada.
        const existingPending = await prisma.payment.findFirst({
            where: { contractId, userId, status: 'PENDING', bookingId: null },
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
        // E2: linha NOVA à vista → marca `pixDiscount` com os dois preços (cartão e PIX; o mesmo cupom em
        // R$), seja qual for a forma do contrato: o PIX cobra o preço PIX (issuePixCharge baixa o amount na
        // emissão) e o cartão nunca cobra o desconto PIX nem mais que o preço de cartão.
        const { pixDiscountMetaForFullCharge } = await import('../../lib/pixGateway.js');
        const newRowPixDiscount = fullTotals
            ? pixDiscountMetaForFullCharge({
                cardTotal: fullTotals.cardTotal,
                pixTotal: fullTotals.pixTotal,
                couponDiscount: payCoupon?.discountAmount,
                pct: fullTotals.pixPct,
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
            : await cardChargeBaseAmount({ amount: newRowAmount, metadata: newRowPixDiscount ? { pixDiscount: newRowPixDiscount } : null });

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
// E9 — "Ativar cobrança automática". NÃO cria mais assinatura Stripe nem Payment (a assinatura paralela
// cobrava em dobro: as parcelas do contrato já existem e são cobradas pelo autoChargeJob). Agora liga a
// cobrança automática DO CLIENTE (User.autoChargeEnabled — vale para todos os contratos dele) e torna o
// cartão informado o padrão. `paymentMethodId` = id do SavedPaymentMethod OU pm_… do Stripe (ex.: o cartão
// recém-cadastrado por SetupIntent); precisa ser do próprio cliente e de CRÉDITO. Idempotente.

router.post('/:id/subscribe', authenticate, async (req: Request, res: Response) => {
    try {
        const contractId = req.params.id as string;
        const userId = req.user!.userId;
        const data = subscribeSchema.parse(req.body);

        const contract = await prisma.contract.findFirst({
            where: { id: contractId, userId },
            select: { id: true, status: true, paymentPlan: true },
        });

        if (!contract) {
            res.status(404).json({ error: 'Contrato não encontrado.' });
            return;
        }

        if (contract.status === 'CANCELLED') {
            res.status(400).json({ error: 'Este contrato foi cancelado — não há parcelas para cobrar automaticamente.', code: 'CONTRACT_CANCELLED' });
            return;
        }

        // À vista já quitado: não há o que cobrar automaticamente neste contrato.
        // AC-1: só parcelas do PLANO contam (bookingId null) — o autoChargeJob não cobra extras de gravação,
        // então um à vista quitado com apenas um extra pendente também não tem o que cobrar.
        if (contract.paymentPlan === 'FULL') {
            const pending = await prisma.payment.count({ where: { contractId, bookingId: null, status: { in: ['PENDING', 'FAILED'] } } });
            if (pending === 0) {
                res.status(400).json({ error: 'Este contrato foi pago à vista e está quitado — não há parcelas para cobrar automaticamente.', code: 'NOTHING_TO_CHARGE' });
                return;
            }
        }

        const user = await prisma.user.findUnique({ where: { id: userId }, select: { autoChargeEnabled: true, stripeCustomerId: true } });
        if (!user) {
            res.status(404).json({ error: 'Usuário não encontrado.' });
            return;
        }

        const { checkAutoChargeCard, setDefaultSavedCard } = await import('../../lib/savedCards.js');
        const { stripeSetDefaultPaymentMethod } = await import('../../lib/stripeService.js');

        // O cartão tem de ser DESTE cliente (linha dele no banco ou anexado ao Customer dele no Stripe) —
        // conferido no Stripe (posse + crédito/débito); o que só existe no Stripe é gravado agora.
        // Conferência única (lib/savedCards.checkAutoChargeCard): 503 Stripe desligado · 502 não conferido ·
        // 404 CARD_NOT_FOUND · 400 CARD_NOT_CREDIT — a mesma do PUT /stripe/auto-charge e do admin.
        const check = await checkAutoChargeCard(userId, { cardRef: data.paymentMethodId, sync: true, logTag: '[AUTO-CHARGE-ACTIVATE]' });
        if (!check.ok) {
            res.status(check.status).json(check.body);
            return;
        }
        const card = check.card;
        if (!card.id || !user.stripeCustomerId) {
            res.status(404).json({ error: 'Cartão não encontrado. Cadastre o cartão e tente novamente.', code: 'CARD_NOT_FOUND' });
            return;
        }

        const alreadyEnabled = user.autoChargeEnabled && card.isDefault;
        if (!alreadyEnabled) {
            if (!card.isDefault) {
                try {
                    await stripeSetDefaultPaymentMethod(user.stripeCustomerId, card.stripePaymentMethodId);
                } catch (err) {
                    console.error('[AUTO-CHARGE-ACTIVATE] Falha ao definir o cartão padrão no Stripe:', err instanceof Error ? err.message : err);
                    res.status(502).json({ error: 'Não foi possível definir este cartão como padrão agora. Tente novamente em instantes.' });
                    return;
                }
                await setDefaultSavedCard(userId, card.id);
            }
            await prisma.user.update({ where: { id: userId }, data: { autoChargeEnabled: true } });
            const { logAudit } = await import('../../lib/audit.js');
            await logAudit('USER', userId, 'AUTO_CHARGE_ENABLED', userId, { contractId, savedPaymentMethodId: card.id, last4: card.last4 });
        }

        res.json({
            success: true,
            autoChargeEnabled: true,
            alreadyEnabled,
            // A cobrança automática é por CLIENTE: vale para todos os contratos dele.
            scope: 'USER',
            defaultCard: {
                id: card.id,
                stripePaymentMethodId: card.stripePaymentMethodId,
                brand: card.brand,
                last4: card.last4,
                expMonth: card.expMonth,
                expYear: card.expYear,
                funding: card.funding ?? 'unknown',
                isDefault: true,
            },
            message: alreadyEnabled
                ? 'A cobrança automática já está ativa neste cartão.'
                : `Cobrança automática ativada. As próximas parcelas de todos os seus contratos serão cobradas no cartão final ${card.last4} no vencimento.`,
        });
    } catch (err: any) {
        console.error('[AUTO-CHARGE-ACTIVATE]', err);
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        res.status(500).json({ error: 'Erro ao ativar a cobrança automática.' });
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
            res.status(400).json({ error: 'Método de pagamento é obrigatório para renovação. Informe PIX ou CARTÃO.' });
            return;
        }
        // E3: a renovação nasce aguardando pagamento (prazo de 3 dias) e o boleto compensa em dias —
        // o cliente renova por PIX ou cartão (o /pay só aceita os dois).
        if (renewMethod === 'BOLETO') {
            res.status(400).json({ error: 'A renovação é paga por PIX ou cartão. Escolha uma das duas formas.', code: 'BOLETO_NOT_ALLOWED_HERE' });
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

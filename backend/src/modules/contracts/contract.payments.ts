import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middleware/auth.js';
import { getBasePriceDynamic, applyDiscount } from '../../utils/pricing.js';
import { getConfig } from '../../lib/businessConfig.js';
import { computeAddonsCost, serviceMonthlyBase } from '../../lib/contractPricing.js';
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
        if (contract.type === 'SERVICO') {
            const svcMonthly = await serviceMonthlyBase(contract);
            // FULL-plan service is paid à-vista (all N months at once); MONTHLY charges one month.
            // Without this, paying a FULL service via /pay would collect only 1/N and no
            // installments 2..N are ever generated (the generator skips FULL).
            if (contract.paymentPlan === 'FULL') {
                const { computeFullContractTotal } = await import('../../lib/contractPricing.js');
                monthlyAmount = await computeFullContractTotal(svcMonthly, contract.durationMonths, contract.paymentMethod || undefined);
            } else {
                monthlyAmount = svcMonthly;
            }
        } else {
            const tierPrice = await getBasePriceDynamic(contract.tier);
            const discountedPrice = applyDiscount(tierPrice, contract.discountPct);
            const sessionsPerMonth = await getConfig('sessions_per_month');
            const payAddonsCost = await computeAddonsCost(contract.addOns, contract.discountPct, sessionsPerMonth);
            monthlyAmount = (sessionsPerMonth * discountedPrice) + payAddonsCost;
        }

        // PAY-M1 FIX: Reuse existing pending payment for the same contract instead of creating orphans
        const existingPending = await prisma.payment.findFirst({
            where: { contractId, userId, status: 'PENDING' },
            orderBy: { createdAt: 'desc' },
        });

        // Coupon: only when a NEW pending payment is being created — an existing pending
        // (possibly with a Cora/Stripe artifact already issued) is never repriced.
        let payCoupon: CouponQuote | null = null;
        if (data.couponCode) {
            const willReuse = existingPending && (
                (data.paymentMethod === 'PIX' && existingPending.provider === 'CORA' && existingPending.pixString) ||
                (data.paymentMethod === 'CARTAO' && existingPending.provider === 'STRIPE' && existingPending.providerRef)
            );
            if (!willReuse) {
                payCoupon = await validateCoupon({ code: data.couponCode, userId, baseAmount: monthlyAmount });
            }
        }
        const payChargeAmount = payCoupon ? payCoupon.finalAmount : monthlyAmount;
        const payCouponFields = payCoupon ? {
            couponId: payCoupon.coupon.id,
            couponCode: payCoupon.coupon.code,
            discountAmount: payCoupon.discountAmount,
        } : {};

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

        // ─── PIX: Cora ───────────────────────────────────────
        if (data.paymentMethod === 'PIX') {
            // If we already have a pending PIX payment with a pixString, return it
            if (existingPending && existingPending.provider === 'CORA' && existingPending.pixString) {
                res.json({
                    provider: 'CORA',
                    paymentId: existingPending.id,
                    pixString: existingPending.pixString,
                    amount: existingPending.amount,
                    message: 'QR Code PIX já gerado. Escaneie para ativar o contrato.',
                });
                return;
            }

            const { createCoraPayment } = await import('../../lib/coraPaymentHelper.js');

            // Create Payment record (+ atomic coupon reservation when present)
            const payment = await prisma.$transaction(async (tx) => {
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
                const coraRes = await createCoraPayment({
                    userId,
                    amount: payChargeAmount,
                    description: `PIX - Contrato "${contract.name}" - ${contract.tier}`,
                    withPixQrCode: true,
                    idempotencyKey: payment.id,
                });

                await prisma.payment.update({
                    where: { id: payment.id },
                    data: {
                        providerRef: coraRes.result.id,
                        pixString: coraRes.pixString,
                    },
                });

                res.json({
                    provider: 'CORA',
                    paymentId: payment.id,
                    pixString: coraRes.pixString,
                    qrCodeBase64: coraRes.qrCodeBase64,
                    amount: payChargeAmount,
                    ...(payCoupon && { couponDiscount: payCoupon.discountAmount }),
                    message: 'QR Code PIX gerado. Escaneie para ativar o contrato.',
                });
            } catch (e: unknown) {
                // Cora failed — give the coupon use back and drop the unpayable row.
                await releaseAndPurgeCouponsForPayments([payment.id]);
                await prisma.payment.delete({ where: { id: payment.id } }).catch(() => {});
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
        const chargeAmount = payChargeAmount;

        const { stripeCreatePaymentIntent, stripeGetOrCreateCustomer, isStripeEnabled } = await import('../../lib/stripeService.js');

        if (!(await isStripeEnabled())) {
            res.status(503).json({ error: 'Stripe não está habilitado.' });
            return;
        }

        const customerId = await stripeGetOrCreateCustomer(userId);

        // PAY-M1: Reuse existing pending Stripe payment if available
        if (existingPending && existingPending.provider === 'STRIPE' && existingPending.providerRef) {
            const { stripeGetPaymentIntent } = await import('../../lib/stripeService.js');
            try {
                const pi = await stripeGetPaymentIntent(existingPending.providerRef);
                if (pi.status === 'requires_payment_method' || pi.status === 'requires_confirmation' || pi.status === 'requires_action') {
                    res.json({
                        provider: 'STRIPE',
                        clientSecret: pi.client_secret,
                        paymentId: existingPending.id,
                        amount: existingPending.amount,
                        maxInstallments,
                        message: 'PaymentIntent existente reutilizado.',
                    });
                    return;
                }
            } catch { /* PI expired or invalid — create new one below */ }
        }

        // Create Payment record (+ atomic coupon reservation when present)
        const payment = await prisma.$transaction(async (tx) => {
            const p = await tx.payment.create({
                data: {
                    userId,
                    contractId,
                    provider: 'STRIPE',
                    amount: chargeAmount,
                    status: 'PENDING',
                    dueDate: new Date(),
                    installments,
                    paymentType: data.paymentType || 'CREDIT',
                    ...payCouponFields,
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
            // Stripe failed — release the coupon use, then delete the just-created PENDING
            // row so retries don't accrue orphan payments.
            await releaseAndPurgeCouponsForPayments([payment.id]);
            await prisma.payment.delete({ where: { id: payment.id } }).catch(() => {});
            const msg = err instanceof Error ? err.message : 'Erro ao iniciar o pagamento com cartão. Tente novamente.';
            res.status(502).json({ error: msg });
            return;
        }

        await prisma.payment.update({
            where: { id: payment.id },
            data: { providerRef: piResult.paymentIntentId },
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

            // VULN-07 FIX: Verify amount matches
            if (pi.amount !== payment.amount) {
                console.error(`[CONTRACT-CONFIRM] Amount mismatch: PI=${pi.amount}, DB=${payment.amount}`);
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
                const { fulfillContractFromPayment } = await import('../../lib/contractFulfillment.js');
                await fulfillContractFromPayment(paidPayment.id);
                // Renewals: the contract already exists (fulfillment is a no-op for it), so
                // generate the FIXO bookings here. Idempotent — no-op if bookings exist or
                // the contract isn't FIXO. Fixes client-renew producing a paid contract
                // with zero scheduled sessions.
                const { generateBookingsForRenewedContract } = await import('../../lib/paymentEffects.js');
                await generateBookingsForRenewedContract(contractId);
            } catch (fulfillErr) {
                console.error('[CONTRACT-CONFIRM-PAYMENT] Fulfillment error (non-blocking):', fulfillErr);
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

        // Calculate amount based on pricing
        const basePrice = await getBasePriceDynamic(contract.tier as any);
        const amountBRL = applyDiscount(basePrice * 4, contract.discountPct); // monthly amount
        
        // Ensure discount is applied if duration is 3 or 6 months
        let finalAmount = amountBRL;
        if (duration === 3) {
            const d3 = await getConfig('discount_3months');
            finalAmount = applyDiscount(basePrice * 4, d3);
        } else if (duration === 6) {
            const d6 = await getConfig('discount_6months');
            finalAmount = applyDiscount(basePrice * 4, d6);
        }
        
        // Convert to cents — applyDiscount already returns cents, no extra multiplication
        const amountCents = finalAmount;

        const { stripeCreateSubscription } = await import('../../lib/stripeService.js');
        
        // Create initial payment record
        const payment = await prisma.payment.create({
            data: {
                userId,
                contractId: contract.id,
                amount: finalAmount,
                provider: 'STRIPE',
                status: 'PENDING',
                dueDate: new Date(),
                paymentType: 'CREDIT',
            }
        });

        const subResult = await stripeCreateSubscription({
            customerId: user.stripeCustomerId,
            paymentMethodId: data.paymentMethodId,
            amount: amountCents,
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
        if (!['ACTIVE', 'EXPIRED'].includes(original.status)) { 
            res.status(400).json({ error: 'Só é possível renovar contratos ativos ou expirados.' }); 
            return; 
        }

        // PAY-M2 FIX: Block duplicate pending renewals
        const pendingRenewal = await prisma.contract.findFirst({
            where: { renewedFromId: id, status: 'AWAITING_PAYMENT' },
        });
        if (pendingRenewal) {
            res.status(400).json({ error: 'Já existe uma renovação pendente para este contrato. Realize o pagamento ou aguarde a expiração.' });
            return;
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
        if (original.status === 'ACTIVE' && new Date(original.endDate) > start) {
            start = new Date(original.endDate);
        }
        
        const end = new Date(start);
        end.setMonth(end.getMonth() + data.durationMonths);

        const flexCreditsTotal = original.type === 'FLEX' ? data.durationMonths * 4 : undefined;

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

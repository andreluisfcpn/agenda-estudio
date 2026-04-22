import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middleware/auth.js';
import { getBasePriceDynamic, applyDiscount } from '../../utils/pricing.js';
import { getConfig } from '../../lib/businessConfig.js';
import { contractPaySchema, subscribeSchema, clientRenewSchema } from './validators.js';

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

        // Calculate amount (first monthly payment)
        const tierPrice = await getBasePriceDynamic(contract.tier);
        const discountedPrice = applyDiscount(tierPrice, contract.discountPct);
        const sessionsPerMonth = await getConfig('sessions_per_month');
        const monthlyAmount = sessionsPerMonth * discountedPrice;

        // ─── PIX: Cora ───────────────────────────────────────
        if (data.paymentMethod === 'PIX') {
            const { createCoraPayment } = await import('../../lib/coraPaymentHelper.js');

            // Create Payment record
            const payment = await prisma.payment.create({
                data: {
                    userId,
                    contractId,
                    provider: 'CORA',
                    amount: monthlyAmount,
                    status: 'PENDING',
                    dueDate: new Date(),
                    installments: 1,
                },
            });

            try {
                const coraRes = await createCoraPayment({
                    userId,
                    amount: monthlyAmount,
                    description: `PIX - Contrato "${contract.name}" - ${contract.tier}`,
                    withPixQrCode: true,
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
                    amount: monthlyAmount,
                    message: 'QR Code PIX gerado. Escaneie para ativar o contrato.',
                });
            } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : 'Erro ao gerar PIX.';
                res.status(400).json({ error: msg });
            }
            return;
        }

        // ─── CARTÃO: Stripe ──────────────────────────────────
        // Max installments = durationMonths (exception: avulso = 3x)
        const isAvulso = contract.durationMonths === 1;
        const maxInstallments = isAvulso ? 3 : contract.durationMonths;
        const installments = Math.min(data.installments || 1, maxInstallments);

        const { stripeCreatePaymentIntent, stripeGetOrCreateCustomer, isStripeEnabled } = await import('../../lib/stripeService.js');

        if (!(await isStripeEnabled())) {
            res.status(503).json({ error: 'Stripe não está habilitado.' });
            return;
        }

        const customerId = await stripeGetOrCreateCustomer(userId);

        // Create Payment record
        const payment = await prisma.payment.create({
            data: {
                userId,
                contractId,
                provider: 'STRIPE',
                amount: monthlyAmount,
                status: 'PENDING',
                dueDate: new Date(),
                installments,
                paymentType: data.paymentType || 'CREDIT',
            },
        });

        const piResult = await stripeCreatePaymentIntent({
            amount: monthlyAmount,
            customerId,
            description: `Contrato "${contract.name}" - ${contract.tier} ${contract.durationMonths}m`,
            paymentId: payment.id,
            userId,
            contractId,
            installmentsEnabled: installments > 1,
        });

        await prisma.payment.update({
            where: { id: payment.id },
            data: { providerRef: piResult.paymentIntentId },
        });

        res.json({
            provider: 'STRIPE',
            clientSecret: piResult.clientSecret,
            paymentId: payment.id,
            amount: monthlyAmount,
            maxInstallments,
            message: 'PaymentIntent criado. Complete o pagamento para ativar o contrato.',
        });
    } catch (err: any) {
        console.error('[CONTRACT-PAY]', err);
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
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

        // Update payment providerRef if subscription created successfully
        if (subResult.subscriptionId) {
            await prisma.payment.update({
                where: { id: payment.id },
                data: { providerRef: subResult.subscriptionId }
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
        res.status(500).json({ error: err.message || 'Erro ao configurar assinatura.' });
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

        // Calculate discount based on duration
        const d6 = await getConfig('discount_6months');
        const d3 = await getConfig('discount_3months');
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
                paymentMethod: data.paymentMethod || original.paymentMethod,
                flexCreditsTotal: flexCreditsTotal ?? null,
                flexCreditsRemaining: flexCreditsTotal ?? null,
                flexCycleStart: original.type === 'FLEX' ? start : null,
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
        res.status(500).json({ error: err.message || 'Erro ao processar renovação.' });
    }
});

} // end registerPaymentRoutes

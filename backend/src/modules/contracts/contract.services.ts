import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { authenticate } from '../../middleware/auth';
import { ContractType, Tier, ContractStatus } from '../../generated/prisma/client';
import { getConfig } from '../../lib/businessConfig';
import { createPayment as gatewayCreatePayment, updatePaymentWithGatewayResult, validatePaymentMethod, getProviderForMethod, PaymentMethodDisabledError } from '../../lib/paymentGateway';
import { serviceContractSchema } from './validators';

export function registerServiceRoutes(router: Router) {

// ─── POST /api/contracts/service (Standalone Services) ──

router.post('/service', authenticate, async (req: Request, res: Response) => {
    try {
        const data = serviceContractSchema.parse(req.body);
        const userId = req.user!.userId;

        // Global guard: reject disabled payment methods
        try {
            await validatePaymentMethod(data.paymentMethod);
        } catch (err) {
            if (err instanceof PaymentMethodDisabledError) {
                res.status(400).json({ error: err.message });
                return;
            }
            throw err;
        }

        const addon = await prisma.addOnConfig.findUnique({ where: { key: data.serviceKey } });
        if (!addon) {
            res.status(404).json({ error: 'Serviço não encontrado.' });
            return;
        }

        const duration = data.durationMonths || 1;
        const d6 = await getConfig('service_discount_6months');
        const d3 = await getConfig('service_discount_3months');
        const discountPct = duration === 6 ? d6 : (duration === 3 ? d3 : 0);

        const startDate = new Date();
        const endDate = new Date(startDate);
        endDate.setMonth(endDate.getMonth() + duration);

        const contract = await prisma.contract.create({
            data: {
                userId,
                name: addon.name,
                type: ContractType.SERVICO,
                tier: Tier.COMERCIAL,
                durationMonths: duration,
                discountPct,
                startDate,
                endDate,
                status: ContractStatus.ACTIVE,
                paymentMethod: data.paymentMethod,
                addOns: [data.serviceKey],
                flexCreditsTotal: 0,
                flexCreditsRemaining: 0,
            },
        });

        const monthlyBase = addon.price; 
        const monthlyDiscounted = Math.round(monthlyBase * (1 - discountPct / 100));
        let paymentAmount = monthlyDiscounted * duration;
        
        if (data.paymentMethod === 'PIX') {
            const pixDiscount = await getConfig('pix_extra_discount_pct');
            paymentAmount = Math.round(paymentAmount * (1 - pixDiscount / 100));
        } else if (data.paymentMethod === 'CARTAO') {
            const fee3x = await getConfig('card_fee_3x_pct');
            const fee6x = await getConfig('card_fee_6x_pct');
            if (duration === 3) paymentAmount = Math.round(paymentAmount * (1 + fee3x / 100));
            else if (duration === 6) paymentAmount = Math.round(paymentAmount * (1 + fee6x / 100));
        }

        const payment = await prisma.payment.create({
            data: {
                userId,
                contractId: contract.id,
                provider: getProviderForMethod(data.paymentMethod),
                amount: paymentAmount,
                status: 'PENDING',
                dueDate: startDate,
            }
        });

        // Dispatch to gateway (Cora/Stripe) — fetch full user for CPF/address
        const userInfo = await prisma.user.findUnique({
            where: { id: userId },
            select: { name: true, email: true, cpfCnpj: true, address: true, city: true, state: true },
        });
        const cpfStr = userInfo?.cpfCnpj?.replace(/\D/g, '') || '';
        let checkoutUrl: string | undefined = undefined;
        let clientSecret: string | undefined = undefined;
        try {
            const result = await gatewayCreatePayment({
                paymentMethod: data.paymentMethod as 'PIX' | 'BOLETO' | 'CARTAO',
                amount: paymentAmount,
                description: `Serviço ${addon.name}`,
                customer: {
                    name: userInfo?.name || 'Cliente',
                    email: userInfo?.email || '',
                    cpf: cpfStr || undefined,
                },
                dueDate: startDate,
                paymentId: payment.id,
                contractId: contract.id,
                userId,
            });
            await updatePaymentWithGatewayResult(payment.id, result);
            if (result.paymentUrl) checkoutUrl = result.paymentUrl;
            if (result.clientSecret) clientSecret = result.clientSecret;
        } catch (err) {
            console.error(`[Gateway] Service payment fallback:`, err);
        }

        res.status(201).json({
            contract,
            ...(checkoutUrl && { checkoutUrl }),
            ...(clientSecret && { clientSecret }),
            message: `Serviço ${addon.name} contratado com sucesso!`,
        });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        res.status(500).json({ error: 'Erro interno ao processar serviço.' });
    }
});

} // end registerServiceRoutes

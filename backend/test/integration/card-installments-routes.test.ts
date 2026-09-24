import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// pagamentos-1 / cobertura-1 (D1): o teto de parcelas vale no SERVIDOR. N× (N > 1) só com cartão salvo numa
// conta que parcela (plano fixado na confirmação); conta Stripe BR não parcela → só 1x, e N > 1 é recusado
// ANTES de qualquer efeito. Stripe mocado — nenhuma chamada de rede.
vi.mock('../../src/lib/stripeService', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../../src/lib/stripeService')>();
    return {
        ...orig,
        isStripeEnabled: vi.fn(async () => true),
        stripeCardInstallmentsSupported: vi.fn(async () => false),
        stripeCreatePaymentIntent: vi.fn(async (o: { paymentId: string }) => ({ clientSecret: `cs_${o.paymentId}`, paymentIntentId: `pi_new_${o.paymentId.slice(0, 8)}`, status: 'requires_payment_method' })),
        stripeGetOrCreateCustomer: vi.fn(async () => 'cus_test'),
    };
});

import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { prisma } from '../../src/lib/prisma';
import { config } from '../../src/config/index';
import * as stripe from '../../src/lib/stripeService';
import stripeRoutes from '../../src/modules/stripe/routes';
import { mkUser, mkContract, mkPayment } from './factories';

const m = <T extends (...a: any[]) => any>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>;

let server: Server;
let base = '';

beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/stripe', stripeRoutes);
    await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
    vi.clearAllMocks();
    m(stripe.stripeCardInstallmentsSupported).mockResolvedValue(false);
    m(stripe.stripeCreatePaymentIntent).mockImplementation(async (o: { paymentId: string }) => ({ clientSecret: `cs_${o.paymentId}`, paymentIntentId: `pi_new_${o.paymentId.slice(0, 8)}`, status: 'requires_payment_method' }));
    m(stripe.stripeGetOrCreateCustomer).mockResolvedValue('cus_test');
    for (const [i, key] of ['PIX', 'CARTAO'].entries()) {
        await prisma.paymentMethodConfig.create({
            data: { key, label: key, shortLabel: key, emoji: '-', description: key, color: '#000000', active: true, sortOrder: i },
        });
    }
    await prisma.integrationConfig.create({ data: { provider: 'STRIPE', enabled: true, environment: 'sandbox', config: '{}' } });
});

function cookie(u: { id: string; email: string | null; role: string }) {
    return `accessToken=${jwt.sign({ userId: u.id, email: u.email ?? '', role: u.role }, config.jwt.secret, { expiresIn: '1h' })}`;
}

async function call(path: string, who: { id: string; email: string | null; role: string }, body: unknown) {
    const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { Cookie: cookie(who), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

/** Serviço "Mensal no cartão → parcelar o total em até 3× sem juros" (D1): FULL + installmentCap 3. */
async function serviceSplitPayment(status: 'PENDING' | 'FAILED' = 'PENDING') {
    const u = await mkUser();
    const c = await mkContract(u.id, { type: 'SERVICO', paymentPlan: 'FULL', paymentMethod: 'CARTAO', durationMonths: 3, status: 'AWAITING_PAYMENT' });
    const p = await mkPayment(u.id, { contractId: c.id, provider: 'STRIPE', amount: 315000, status, metadata: { installmentCap: 3 } });
    return { u, c, p };
}

/** Avulso: política 1–12x, juros de 2x a 12x. */
async function avulsoPayment() {
    const u = await mkUser();
    const c = await mkContract(u.id, { type: 'AVULSO', paymentPlan: 'FULL', paymentMethod: 'CARTAO', durationMonths: 1 });
    const p = await mkPayment(u.id, { contractId: c.id, provider: 'STRIPE', amount: 30000 });
    return { u, c, p };
}

describe('conta Stripe sem parcelamento (BR) — só 1x', () => {
    it('installment-plans do serviço com teto 3 → só 1x (sem oferecer 2x/3x que sairiam em 1×)', async () => {
        const { u, p } = await serviceSplitPayment();
        const plans = await call('/api/stripe/installment-plans', u, { paymentId: p.id });
        expect(plans.status).toBe(200);
        expect(plans.body.plans.map((x: any) => x.count)).toEqual([1]);
        expect(plans.body.plans[0].total).toBe(315000);
        // Prévia do wizard (sem paymentId) segue a mesma regra.
        const preview = await call('/api/stripe/installment-plans', u, { amount: 315000, contractDurationMonths: 3, installmentCap: 3 });
        expect(preview.body.plans.map((x: any) => x.count)).toEqual([1]);
    });

    it('create-payment 3x com cartão NOVO ou SALVO → 400, nada criado no Stripe, Payment intacto', async () => {
        const { u, p } = await serviceSplitPayment();
        const novo = await call('/api/stripe/create-payment', u, { paymentId: p.id, paymentMethod: 'cartao', installments: 3 });
        expect(novo.status).toBe(400);
        expect(novo.body.code).toBe('INSTALLMENTS_UNAVAILABLE');
        expect(novo.body.error).toMatch(/parcelamento no cartão não está disponível/);
        const salvo = await call('/api/stripe/create-payment', u, { paymentId: p.id, paymentMethod: 'cartao', installments: 3, savedPaymentMethodId: 'pm_saved' });
        expect(salvo.status).toBe(400);
        expect(stripe.stripeCreatePaymentIntent).not.toHaveBeenCalled();
        const after = await prisma.payment.findUnique({ where: { id: p.id } });
        expect(after).toMatchObject({ status: 'PENDING', providerRef: null, chargedAmount: null, installments: p.installments });
    });

    it('create-payment 1x → PaymentIntent do total, sem parcelamento, installments gravado = 1', async () => {
        const { u, p } = await serviceSplitPayment();
        const res = await call('/api/stripe/create-payment', u, { paymentId: p.id, paymentMethod: 'cartao', installments: 1, savePaymentMethod: true });
        expect(res.status).toBe(200);
        const opts = m(stripe.stripeCreatePaymentIntent).mock.calls[0]![0];
        expect(opts).toMatchObject({ amount: 315000, installmentsEnabled: false, installmentPlanCount: undefined });
        const after = await prisma.payment.findUnique({ where: { id: p.id } });
        expect(after).toMatchObject({ installments: 1, chargedAmount: 315000, provider: 'STRIPE', providerRef: res.body.paymentIntentId });
    });

    it('avulso 6x (juros) → 400 e nenhum juro gravado; o cliente paga 1x sem juros', async () => {
        const { u, p } = await avulsoPayment();
        const plans = await call('/api/stripe/installment-plans', u, { paymentId: p.id });
        expect(plans.body.plans.map((x: any) => x.count)).toEqual([1]);
        const six = await call('/api/stripe/create-payment', u, { paymentId: p.id, paymentMethod: 'cartao', installments: 6 });
        expect(six.status).toBe(400);
        expect(stripe.stripeCreatePaymentIntent).not.toHaveBeenCalled();
        expect((await prisma.payment.findUnique({ where: { id: p.id } }))?.chargedAmount).toBeNull();
        const one = await call('/api/stripe/create-payment', u, { paymentId: p.id, paymentMethod: 'cartao', installments: 1 });
        expect(one.status).toBe(200);
        expect(m(stripe.stripeCreatePaymentIntent).mock.calls[0]![0].amount).toBe(30000);
    });

    it('recusa ANTES de reabrir uma cobrança FAILED (sem efeito colateral)', async () => {
        const { u, p } = await serviceSplitPayment('FAILED');
        const res = await call('/api/stripe/create-payment', u, { paymentId: p.id, paymentMethod: 'cartao', installments: 2 });
        expect(res.status).toBe(400);
        expect((await prisma.payment.findUnique({ where: { id: p.id } }))?.status).toBe('FAILED');
    });

    it('pedido acima do teto da política é limitado antes da checagem (serviço à vista, teto 1: 5x → 1x)', async () => {
        const u = await mkUser();
        const c = await mkContract(u.id, { type: 'SERVICO', paymentPlan: 'FULL', paymentMethod: 'CARTAO', durationMonths: 3, status: 'AWAITING_PAYMENT' });
        const p = await mkPayment(u.id, { contractId: c.id, provider: 'STRIPE', amount: 315000, metadata: { installmentCap: 1 } });
        const res = await call('/api/stripe/create-payment', u, { paymentId: p.id, paymentMethod: 'cartao', installments: 5 });
        expect(res.status).toBe(200);
        expect(m(stripe.stripeCreatePaymentIntent).mock.calls[0]![0]).toMatchObject({ amount: 315000, installmentsEnabled: false });
    });
});

describe('conta Stripe COM parcelamento (MX/JP) — N× só com o plano fixado no servidor', () => {
    beforeEach(() => { m(stripe.stripeCardInstallmentsSupported).mockResolvedValue(true); });

    it('installment-plans do serviço → 1x..3x, todos sem juros (teto D1)', async () => {
        const { u, p } = await serviceSplitPayment();
        const plans = await call('/api/stripe/installment-plans', u, { paymentId: p.id });
        expect(plans.body.plans.map((x: any) => x.count)).toEqual([1, 2, 3]);
        expect(plans.body.plans.every((x: any) => x.feePercent === 0 && x.total === 315000)).toBe(true);
    });

    it('cartão NOVO 3x → 400 (o seletor do Payment Element escolheria qualquer plano do emissor)', async () => {
        const { u, p } = await serviceSplitPayment();
        const res = await call('/api/stripe/create-payment', u, { paymentId: p.id, paymentMethod: 'cartao', installments: 3 });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/salve o cartão/);
        expect(stripe.stripeCreatePaymentIntent).not.toHaveBeenCalled();
    });

    it('cartão SALVO 3x → confirma no servidor com o plano 3 (sem juros, dentro do teto)', async () => {
        const { u, p } = await serviceSplitPayment();
        const res = await call('/api/stripe/create-payment', u, { paymentId: p.id, paymentMethod: 'cartao', installments: 3, savedPaymentMethodId: 'pm_saved' });
        expect(res.status).toBe(200);
        expect(m(stripe.stripeCreatePaymentIntent).mock.calls[0]![0]).toMatchObject({
            amount: 315000, installmentsEnabled: true, installmentPlanCount: 3, savedPaymentMethodId: 'pm_saved',
        });
        expect(await prisma.payment.findUnique({ where: { id: p.id } })).toMatchObject({ installments: 3, chargedAmount: 315000 });
    });

    it('cartão SALVO pedindo 12x num teto 3 → limitado a 3x (nunca acima do teto)', async () => {
        const { u, p } = await serviceSplitPayment();
        const res = await call('/api/stripe/create-payment', u, { paymentId: p.id, paymentMethod: 'cartao', installments: 12, savedPaymentMethodId: 'pm_saved' });
        expect(res.status).toBe(200);
        expect(m(stripe.stripeCreatePaymentIntent).mock.calls[0]![0].installmentPlanCount).toBe(3);
    });
});

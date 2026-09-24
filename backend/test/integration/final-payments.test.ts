import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// ─── Mocks dos provedores (Stripe / Sicoob): nenhuma chamada de rede real ────────────────────────
vi.mock('../../src/lib/sicoobService', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../../src/lib/sicoobService')>();
    return {
        ...orig,
        sicoobGetCob: vi.fn(),
        sicoobRemoveCob: vi.fn(async () => true),
        sicoobCreatePix: vi.fn(),
        getSicoobEnvironment: vi.fn(async () => 'sandbox'),
    };
});
vi.mock('../../src/lib/stripeService', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../../src/lib/stripeService')>();
    return {
        ...orig,
        isStripeEnabled: vi.fn(async () => true),
        stripeCardInstallmentsSupported: vi.fn(async () => false),
        stripeGetPaymentIntent: vi.fn(),
        stripeCancelPaymentIntent: vi.fn(async () => ({ status: 'canceled', canceled: true })),
        stripeChargeOffSession: vi.fn(),
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
import { cardChargeBaseAmount } from '../../src/lib/pixGateway';
import { applyContractServiceChange, generateBookingsForRenewedContract } from '../../src/lib/paymentEffects';
import { runAutoChargeJob } from '../../src/jobs/autoChargeJob';
import { getConfig } from '../../src/lib/businessConfig';
import { resolveFeeAt, computeGatewayFee } from '../../src/lib/gatewayFees';
import { getBasePriceDynamic, applyDiscount } from '../../src/utils/pricing';
import stripeRoutes from '../../src/modules/stripe/routes';
import contractRoutes from '../../src/modules/contracts/routes';
import pricingRoutes from '../../src/modules/pricing/routes';
import { financeRouter } from '../../src/modules/finance/routes';
import paymentRoutes from '../../src/modules/payments/routes';
import { mkUser, mkContract, mkPayment, mkBooking } from './factories';

// Frente final-payments (rodada final): desconto PIX só na cobrança que o teve; valor do cartão;
// relatório pelo valor cobrado; parcelamento só quando o gateway parcela; renovação sem overbooking.

const m = <T extends (...a: any[]) => any>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>;

let server: Server;
let base = '';

beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/stripe', stripeRoutes);
    app.use('/api/contracts', contractRoutes);
    app.use('/api/pricing', pricingRoutes);
    app.use('/api/finance', financeRouter);
    app.use('/api/payments', paymentRoutes);
    await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
    vi.clearAllMocks();
    m(stripe.isStripeEnabled).mockResolvedValue(true);
    m(stripe.stripeCardInstallmentsSupported).mockResolvedValue(false);
    m(stripe.stripeCreatePaymentIntent).mockImplementation(async (o: { paymentId: string }) => ({ clientSecret: `cs_${o.paymentId}`, paymentIntentId: `pi_new_${o.paymentId.slice(0, 8)}`, status: 'requires_payment_method' }));
    m(stripe.stripeGetOrCreateCustomer).mockResolvedValue('cus_test');
});

function cookie(u: { id: string; email: string | null; role: string }) {
    return `accessToken=${jwt.sign({ userId: u.id, email: u.email ?? '', role: u.role }, config.jwt.secret, { expiresIn: '1h' })}`;
}

async function call(method: string, path: string, who?: { id: string; email: string | null; role: string }, body?: unknown) {
    const res = await fetch(`${base}${path}`, {
        method,
        headers: {
            ...(who ? { Cookie: cookie(who) } : {}),
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

async function enableCard() {
    await prisma.paymentMethodConfig.create({
        data: { key: 'CARTAO', label: 'Cartão', shortLabel: 'Cartão', emoji: '-', description: 'Cartão', color: '#000000', active: true, sortOrder: 0 },
    });
    await prisma.integrationConfig.create({ data: { provider: 'STRIPE', enabled: true, environment: 'sandbox', config: '{}' } });
}

const secondsAgo = (s: number) => new Date(Date.now() - s * 1000);
// Linhas ANTIGAS (sem a marca pixDiscount): D1 regra única — sem a marca, o cartão cobra o próprio amount
// (sem fallback legado nem corte por data). A data só documenta que a linha é anterior à regra.
const legacyAt = (day: number) => new Date(Date.UTC(2026, 8, day, 12, 0, 0));

// ─── Item 1: o desconto PIX só é revertido na cobrança que REALMENTE o teve ───────────────────────
describe('cardChargeBaseAmount — extras e multa de contrato FULL+PIX cobram o valor cheio SEM inflar', () => {
    async function fullPixContract() {
        const u = await mkUser();
        const c = await mkContract(u.id, { type: 'FIXO', paymentPlan: 'FULL', paymentMethod: 'PIX' });
        // À vista ORIGINAL antiga, SEM a marca: 3 × 105000 = 315000 → PIX 10% = 283500 gravado.
        const original = await mkPayment(u.id, { contractId: c.id, amount: 283500, status: 'PAID', paidAt: new Date(), createdAt: legacyAt(1) });
        const booking = await mkBooking(u.id, c.id);
        const extras = await mkPayment(u.id, {
            contractId: c.id, bookingId: booking.id, provider: 'STRIPE', amount: 5000, createdAt: legacyAt(10),
            paymentUrl: JSON.stringify({ addonKeys: ['CORTES'] }), dueDate: secondsAgo(60),
        });
        // Multa de cancelamento: sem bookingId, criada DEPOIS da original (contract.lifecycle).
        const fine = await mkPayment(u.id, { contractId: c.id, provider: 'STRIPE', amount: 31500, createdAt: legacyAt(20), dueDate: secondsAgo(60) });
        return { u, c, original, extras, fine };
    }

    it('original antiga sem a marca → 283500 (o próprio amount, conservador); extras R$ 50 → 5000; multa R$ 315 → 31500', async () => {
        const { c, original, extras, fine } = await fullPixContract();
        // D1 regra única: sem a marca não há reversão do desconto PIX (pode ficar abaixo do preço de cartão, nunca acima).
        expect(await cardChargeBaseAmount({ ...original, contract: c })).toBe(283500);
        expect(await cardChargeBaseAmount({ ...extras, contract: c })).toBe(5000);
        expect(await cardChargeBaseAmount({ ...fine, contract: c })).toBe(31500);
        // Sem id (chamador que não identifica a linha) → nunca infla.
        expect(await cardChargeBaseAmount({ amount: 31500, contractId: c.id, bookingId: null, metadata: null, contract: c })).toBe(31500);
        // Sem o contrato incluído: mesmo resultado (a decisão é só pela linha).
        expect(await cardChargeBaseAmount({ ...original })).toBe(283500);
        expect(await cardChargeBaseAmount({ ...fine })).toBe(31500);
        // Nada é gravado nas linhas.
        for (const p of [original, extras, fine]) {
            expect(((await prisma.payment.findUnique({ where: { id: p.id } }))?.metadata as any)?.pixDiscount).toBeUndefined();
        }
    });

    it('rotas: installment-plans 1x e create-payment cobram extras/multa pelo amount', async () => {
        await enableCard();
        const { u, extras, fine } = await fullPixContract();

        for (const p of [extras, fine]) {
            const plans = await call('POST', '/api/stripe/installment-plans', u, { paymentId: p.id });
            expect(plans.status).toBe(200);
            expect(plans.body.plans.map((x: any) => x.count)).toEqual([1]);
            expect(plans.body.plans[0].total).toBe(p.amount);

            m(stripe.stripeCreatePaymentIntent).mockClear();
            const card = await call('POST', '/api/stripe/create-payment', u, { paymentId: p.id, paymentMethod: 'cartao', installments: 1 });
            expect(card.status).toBe(200);
            expect(m(stripe.stripeCreatePaymentIntent).mock.calls[0]![0].amount).toBe(p.amount);
            // Valor exibido = valor cobrado: a resposta traz o valor do PI (o checkout mostra este).
            expect(card.body.amount).toBe(p.amount);
            expect(card.body.installments).toBe(1);
            const row = await prisma.payment.findUnique({ where: { id: p.id } });
            expect(row?.chargedAmount).toBe(p.amount);
            expect(row?.amount).toBe(p.amount);
        }
    });

    it('linha ANTIGA FULL+PIX sem a marca paga no cartão → o próprio amount em installment-plans, create-payment e autoCharge (conservador, nunca a mais)', async () => {
        // Decisão documentada (D1, regra única): sem a marca metadata.pixDiscount o cartão cobra o valor gravado.
        // Numa cobrança à vista antiga com desconto PIX isso fica ABAIXO do preço de cartão (283500 < 315000) —
        // aceito: o fallback que revertia o % atual podia cobrar A MAIS (cupom 100%, forma trocada, % alterado).
        await enableCard();
        const u = await mkUser({ autoChargeEnabled: true, stripeCustomerId: 'cus_test' });
        const c = await mkContract(u.id, { type: 'FIXO', paymentPlan: 'FULL', paymentMethod: 'PIX' });
        const original = await mkPayment(u.id, {
            contractId: c.id, provider: 'SICOOB', pixString: '000201', amount: 283500,
            dueDate: secondsAgo(60), createdAt: legacyAt(5), metadata: { pixCharge: { attempt: 1, amount: 283500 } },
        });

        const plans = await call('POST', '/api/stripe/installment-plans', u, { paymentId: original.id });
        expect(plans.body.plans.map((x: any) => [x.count, x.total])).toEqual([[1, 283500]]);

        const card = await call('POST', '/api/stripe/create-payment', u, { paymentId: original.id, paymentMethod: 'cartao', installments: 1 });
        expect(card.status).toBe(200);
        expect(m(stripe.stripeCreatePaymentIntent).mock.calls[0]![0].amount).toBe(283500);
        expect(card.body.amount).toBe(283500);
        const row = await prisma.payment.findUnique({ where: { id: original.id } });
        expect(row?.chargedAmount).toBe(283500);
        expect(row?.amount).toBe(283500);
        expect((row?.metadata as any)?.pixDiscount).toBeUndefined(); // nada é congelado/gravado

        // autoCharge de outra cobrança antiga igual (cartão salvo): também o próprio amount.
        await prisma.savedPaymentMethod.create({ data: { userId: u.id, stripePaymentMethodId: 'pm_final_old', brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030, isDefault: true } });
        const c2 = await mkContract(u.id, { type: 'FIXO', paymentPlan: 'FULL', paymentMethod: 'PIX' });
        const other = await mkPayment(u.id, { contractId: c2.id, provider: 'STRIPE', amount: 283500, dueDate: secondsAgo(60), createdAt: legacyAt(6) });
        m(stripe.stripeChargeOffSession).mockImplementation(async (_c: string, _pm: string, _amt: number, meta: { paymentId: string }) =>
            ({ clientSecret: '', paymentIntentId: `pi_auto_${meta.paymentId.slice(0, 6)}`, status: 'succeeded' }));
        await runAutoChargeJob();
        const byPayment = new Map(m(stripe.stripeChargeOffSession).mock.calls.map(cl => [cl[3].paymentId, cl[2]]));
        expect(byPayment.get(other.id)).toBe(283500);
        const paid = await prisma.payment.findUnique({ where: { id: other.id } });
        expect(paid?.status).toBe('PAID');
        expect(paid?.chargedAmount).toBe(283500);
    });

    it('autoCharge: extras e multa de contrato FULL+PIX são cobrados pelo valor cheio (sem inflar)', async () => {
        const { u, extras, fine } = await fullPixContract();
        await prisma.user.update({ where: { id: u.id }, data: { autoChargeEnabled: true, stripeCustomerId: 'cus_test' } });
        await prisma.savedPaymentMethod.create({ data: { userId: u.id, stripePaymentMethodId: 'pm_final_1', brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030, isDefault: true } });
        m(stripe.stripeChargeOffSession).mockImplementation(async (_c: string, _pm: string, _amt: number, meta: { paymentId: string }) =>
            ({ clientSecret: '', paymentIntentId: `pi_auto_${meta.paymentId.slice(0, 6)}`, status: 'succeeded' }));

        await runAutoChargeJob();

        const byPayment = new Map(m(stripe.stripeChargeOffSession).mock.calls.map(cl => [cl[3].paymentId, cl[2]]));
        expect(byPayment.get(extras.id)).toBe(5000);
        expect(byPayment.get(fine.id)).toBe(31500);
        expect((await prisma.payment.findUnique({ where: { id: extras.id } }))?.chargedAmount).toBe(5000);
        expect((await prisma.payment.findUnique({ where: { id: fine.id } }))?.chargedAmount).toBe(31500);
    });

    it('troca de serviços (FULL + PIX): repreça só a parcela do plano, regrava a marca pixDiscount e não toca nos extras', async () => {
        const u = await mkUser();
        const c = await mkContract(u.id, { type: 'FIXO', paymentPlan: 'FULL', paymentMethod: 'PIX', fixedDayOfWeek: 1, fixedTime: '10:00' });
        const original = await mkPayment(u.id, { contractId: c.id, amount: 111111, createdAt: legacyAt(1) });
        const booking = await mkBooking(u.id, c.id);
        const extras = await mkPayment(u.id, { contractId: c.id, bookingId: booking.id, provider: 'STRIPE', amount: 5000, createdAt: secondsAgo(300) });

        await applyContractServiceChange(c.id, []);

        const sessions = await getConfig('sessions_per_month');
        const monthly = sessions * applyDiscount(await getBasePriceDynamic('COMERCIAL'), c.discountPct);
        const pct = Number(await getConfig('pix_extra_discount_pct'));
        const cardFull = monthly * c.durationMonths;
        const pixFull = Math.round(cardFull * (1 - pct / 100));

        const o = await prisma.payment.findUnique({ where: { id: original.id }, include: { contract: true } });
        expect(o?.amount).toBe(pixFull);
        expect((o?.metadata as any)?.pixDiscount).toEqual({ pct, cardAmount: cardFull, pixAmount: pixFull });
        expect(await cardChargeBaseAmount(o!)).toBe(cardFull);
        expect((await prisma.payment.findUnique({ where: { id: extras.id } }))?.amount).toBe(5000);
    });
});

// ─── Item 2 (backend): /contracts/:id/pay só reaproveita o PI que cobra o valor do cartão ─────────
describe('POST /contracts/:id/pay (cartão) — PI reaproveitado só com o valor do cartão (sem o desconto PIX)', () => {
    async function awaitingService() {
        await enableCard();
        const u = await mkUser();
        const c = await mkContract(u.id, { type: 'SERVICO', paymentPlan: 'FULL', paymentMethod: 'PIX', status: 'AWAITING_PAYMENT', paymentDeadline: new Date(Date.now() + 600_000), addOns: [] });
        const p = await mkPayment(u.id, {
            contractId: c.id, provider: 'STRIPE', providerRef: 'pi_old_1', amount: 283500, chargedAmount: 283500,
            metadata: { pixDiscount: { pct: 10, cardAmount: 315000 } },
        });
        return { u, c, p };
    }

    it('PI antigo com o valor PIX → cancelado e um PI novo de 315000; PI já no valor do cartão → reaproveitado', async () => {
        const { u, c, p } = await awaitingService();
        m(stripe.stripeGetPaymentIntent).mockResolvedValue({ id: 'pi_old_1', status: 'requires_payment_method', amount: 283500, client_secret: 'cs_old' });

        const res = await call('POST', `/api/contracts/${c.id}/pay`, u, { paymentMethod: 'CARTAO' });
        expect(res.status).toBe(200);
        expect(stripe.stripeCancelPaymentIntent).toHaveBeenCalledWith('pi_old_1');
        expect(m(stripe.stripeCreatePaymentIntent).mock.calls[0]![0].amount).toBe(315000);
        expect(res.body.amount).toBe(315000);
        const row = await prisma.payment.findUnique({ where: { id: p.id } });
        expect(row?.chargedAmount).toBe(315000);
        expect(row?.amount).toBe(283500);

        m(stripe.stripeCreatePaymentIntent).mockClear();
        m(stripe.stripeCancelPaymentIntent).mockClear();
        m(stripe.stripeGetPaymentIntent).mockResolvedValue({ id: row!.providerRef, status: 'requires_payment_method', amount: 315000, client_secret: 'cs_new' });
        const again = await call('POST', `/api/contracts/${c.id}/pay`, u, { paymentMethod: 'CARTAO' });
        expect(again.status).toBe(200);
        expect(again.body.clientSecret).toBe('cs_new');
        expect(again.body.amount).toBe(315000);
        expect(stripe.stripeCreatePaymentIntent).not.toHaveBeenCalled();
        expect(stripe.stripeCancelPaymentIntent).not.toHaveBeenCalled();
    });
});

// ─── Item 3: relatório financeiro pelo valor efetivamente cobrado ─────────────────────────────────
describe('GET /finance/closing — bruto = valor cobrado (chargedAmount no cartão), taxa versionada sobre ele', () => {
    it('cartão pago com chargedAmount conta 315000; PIX pago com chargedAmount velho conta o amount', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const u = await mkUser();
        const due = new Date(2027, 2, 10, 12, 0, 0);
        const card = await mkPayment(u.id, { provider: 'STRIPE', providerRef: 'pi_card_1', amount: 283500, chargedAmount: 315000, status: 'PAID', paidAt: due, dueDate: due });
        // Pago no PIX depois de uma tentativa de cartão abandonada (pagamentos-14 mantém o chargedAmount).
        const pix = await mkPayment(u.id, { provider: 'SICOOB', providerRef: 'a'.repeat(32), amount: 84000, chargedAmount: 99999, status: 'PAID', paidAt: due, dueDate: due });
        // Cartão cobrado por um PI tardio numa linha que ficou SICOOB (webhook não troca o provider).
        const lateCard = await mkPayment(u.id, { provider: 'SICOOB', providerRef: 'pi_late_1', amount: 90000, chargedAmount: 100000, status: 'PAID', paidAt: due, dueDate: due });
        const pending = await mkPayment(u.id, { provider: 'STRIPE', amount: 50000, chargedAmount: 55000, status: 'PENDING', dueDate: due });

        const res = await call('GET', '/api/finance/closing/2027/3', admin);
        expect(res.status).toBe(200);
        const rows = new Map<string, any>(res.body.payments.map((p: any) => [p.id, p]));

        expect(rows.get(card.id).amount).toBe(315000);
        expect(rows.get(card.id).baseAmount).toBe(283500);
        expect(rows.get(pix.id).amount).toBe(84000);
        expect(rows.get(lateCard.id).amount).toBe(100000);
        expect(rows.get(pending.id).amount).toBe(50000);
        expect(res.body.metrics.grossRevenue).toBe(315000 + 84000 + 100000);
        expect(res.body.metrics.pendingRevenue).toBe(50000);

        // Taxa do Stripe (versionada — aqui o fallback da config) sobre o valor COBRADO.
        const rate = resolveFeeAt([], 'STRIPE', due, { pct: await getConfig('gateway_stripe_fee_pct'), fixedCents: await getConfig('gateway_stripe_fee_cents') });
        expect(rows.get(card.id).feeDeduced).toBe(computeGatewayFee(315000, 'STRIPE', rate));
        expect(rows.get(card.id).netAmount).toBe(315000 - rows.get(card.id).feeDeduced);
    });
});

describe('GET /payments/summary — receita paga = valor cobrado', () => {
    it('paidRevenue e o gráfico mensal somam o chargedAmount do cartão pago (PIX pago conta o amount)', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const u = await mkUser();
        const now = new Date();
        const due = new Date(now.getFullYear(), now.getMonth(), 15, 12, 0, 0);
        await mkPayment(u.id, { provider: 'STRIPE', providerRef: 'pi_sum_1', amount: 283500, chargedAmount: 315000, status: 'PAID', paidAt: due, dueDate: due });
        await mkPayment(u.id, { provider: 'SICOOB', providerRef: 'b'.repeat(32), amount: 84000, chargedAmount: 99999, status: 'PAID', paidAt: due, dueDate: due });
        await mkPayment(u.id, { provider: 'STRIPE', amount: 50000, chargedAmount: 55000, status: 'PENDING', dueDate: due });

        const res = await call('GET', '/api/payments/summary', admin);
        expect(res.status).toBe(200);
        expect(res.body.summary.paidRevenue).toBe(315000 + 84000);
        expect(res.body.summary.pendingRevenue).toBe(50000);
        expect(res.body.summary.totalRevenue).toBe(315000 + 84000 + 50000);
        const month = res.body.monthlyBreakdown[res.body.monthlyBreakdown.length - 1];
        expect(month.paid).toBe(315000 + 84000);
        expect(month.total).toBe(315000 + 84000 + 50000);
    });
});

// ─── Item 5: parcelamento só quando o gateway parcela ─────────────────────────────────────────────
describe('POST /pricing/checkout-quote e /stripe/installment-plans — sem parcelamento no gateway, só 1x', () => {
    it('conta BR (sem parcelamento): cotação e prévia do serviço devolvem só 1x; conta que parcela: volta sozinho', async () => {
        const u = await mkUser();
        const quote = await call('POST', '/api/pricing/checkout-quote', u, { durationMonths: 6, tier: 'COMERCIAL' });
        expect(quote.status).toBe(200);
        expect(quote.body.installmentPlans.map((p: any) => p.count)).toEqual([1]);
        expect(quote.body.maxInstallments).toBe(1);
        expect(quote.body.freeUpTo).toBe(1);

        const preview = await call('POST', '/api/stripe/installment-plans', u, { amount: 450000, contractDurationMonths: 3, installmentCap: 3 });
        expect(preview.body.plans.map((p: any) => p.count)).toEqual([1]);

        m(stripe.stripeCardInstallmentsSupported).mockResolvedValue(true);
        const quote2 = await call('POST', '/api/pricing/checkout-quote', u, { durationMonths: 6, tier: 'COMERCIAL' });
        expect(quote2.body.installmentPlans.length).toBe(12);
        expect(quote2.body.maxInstallments).toBe(12);
        expect(quote2.body.freeUpTo).toBe(6);
        const preview2 = await call('POST', '/api/stripe/installment-plans', u, { amount: 450000, contractDurationMonths: 3, installmentCap: 3 });
        expect(preview2.body.plans.map((p: any) => p.count)).toEqual([1, 2, 3]);
    });
});

// ─── Item 7: renovação paga sem overbooking ───────────────────────────────────────────────────────
describe('generateBookingsForRenewedContract — anti-overbooking na renovação paga', () => {
    const CUSTOM_SCHEDULE = JSON.stringify({ frequency: 'WEEKLY', schedule: [{ day: 1, time: '10:00' }, { day: 3, time: '10:00' }] });

    async function renewedCustom(extra: Record<string, unknown> = {}) {
        const u = await mkUser();
        const c = await mkContract(u.id, {
            type: 'CUSTOM', tier: 'COMERCIAL', durationMonths: 1, discountPct: 0,
            startDate: new Date('2027-01-04T00:00:00Z'), endDate: new Date('2027-02-04T00:00:00Z'),
            customSchedule: CUSTOM_SCHEDULE, sessionsPerWeek: 2, sessionsPerCycle: 8, totalSessions: 8,
            accessMode: 'FULL', ...extra,
        });
        return { u, c };
    }

    async function occupy(date: string, time: string) {
        const other = await mkUser();
        const oc = await mkContract(other.id, { type: 'AVULSO' });
        return mkBooking(other.id, oc.id, { date: new Date(date + 'T00:00:00Z'), startTime: time, endTime: '12:00' });
    }

    it('CUSTOM: pula o horário ocupado (nunca sobrepõe) e a sessão pulada vira crédito; idempotente', async () => {
        const { c } = await renewedCustom();
        await occupy('2027-01-11', '10:00');

        await generateBookingsForRenewedContract(c.id);

        const mine = await prisma.booking.findMany({ where: { contractId: c.id }, orderBy: [{ date: 'asc' }, { startTime: 'asc' }] });
        const days = mine.map(b => b.date.toISOString().slice(0, 10));
        expect(days).toEqual(['2027-01-04', '2027-01-06', '2027-01-13', '2027-01-18', '2027-01-20', '2027-01-25', '2027-01-27']);
        expect(mine.every(b => b.startTime === '10:00' && b.status === 'CONFIRMED')).toBe(true);
        let after = await prisma.contract.findUnique({ where: { id: c.id } });
        expect(after?.customCreditsRemaining).toBe(1);
        expect(after?.totalSessions).toBe(8);

        // 2ª confirmação (ex.: parcela seguinte): nada muda.
        await generateBookingsForRenewedContract(c.id);
        expect(await prisma.booking.count({ where: { contractId: c.id } })).toBe(7);
        after = await prisma.contract.findUnique({ where: { id: c.id } });
        expect(after?.customCreditsRemaining).toBe(1);
    });

    it('CUSTOM: duas confirmações SIMULTÂNEAS geram uma vez só (sessões + créditos = volume pago, sem horário duplicado)', async () => {
        const { c } = await renewedCustom();
        await occupy('2027-01-18', '10:00');

        await Promise.all([generateBookingsForRenewedContract(c.id), generateBookingsForRenewedContract(c.id)]);

        const mine = await prisma.booking.findMany({ where: { contractId: c.id } });
        const keys = mine.map(b => `${b.date.toISOString().slice(0, 10)} ${b.startTime}`);
        expect(new Set(keys).size).toBe(keys.length);
        expect(keys).not.toContain('2027-01-18 10:00');
        const after = await prisma.contract.findUnique({ where: { id: c.id } });
        expect(mine.length + (after?.customCreditsRemaining ?? 0)).toBe(8);
    });

    it('contrato CANCELADO / PAUSADO / EXPIRADO sem sessões vivas (ex.: multa paga) → nada é gerado', async () => {
        for (const status of ['CANCELLED', 'PENDING_CANCELLATION', 'PAUSED', 'EXPIRED'] as const) {
            const u = await mkUser();
            const c = await mkContract(u.id, {
                type: 'FIXO', tier: 'COMERCIAL', durationMonths: 1, fixedDayOfWeek: 1, fixedTime: '10:00', status,
                startDate: new Date('2027-01-04T00:00:00Z'), endDate: new Date('2027-02-04T00:00:00Z'),
            });
            await mkBooking(u.id, c.id, { date: new Date('2027-01-04T00:00:00Z'), startTime: '10:00', endTime: '12:00', status: 'CANCELLED' });

            await generateBookingsForRenewedContract(c.id);

            expect(await prisma.booking.count({ where: { contractId: c.id, status: { not: 'CANCELLED' } } })).toBe(0);
        }
    });

    it('FIXO: pula a ocorrência ocupada', async () => {
        const u = await mkUser();
        const c = await mkContract(u.id, {
            type: 'FIXO', tier: 'COMERCIAL', durationMonths: 1, fixedDayOfWeek: 1, fixedTime: '10:00',
            startDate: new Date('2027-01-04T00:00:00Z'), endDate: new Date('2027-02-04T00:00:00Z'),
        });
        await occupy('2027-01-18', '10:00');

        await generateBookingsForRenewedContract(c.id);

        const days = (await prisma.booking.findMany({ where: { contractId: c.id }, orderBy: { date: 'asc' } }))
            .map(b => b.date.toISOString().slice(0, 10));
        expect(days).toEqual(['2027-01-04', '2027-01-11', '2027-01-25']);
    });
});

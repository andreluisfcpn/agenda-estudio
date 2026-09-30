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
        stripeCreatePaymentIntent: vi.fn(),
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
import { saoPauloParts } from '../../src/lib/spTime';
import * as sicoob from '../../src/lib/sicoobService';
import * as stripe from '../../src/lib/stripeService';
import { buildStaticBrCode } from '../../src/lib/brcode';
import { cardChargeBaseAmount, pixChargeAmount, pixPriceFromMark, pixDiscountMetaForFullCharge, issuePixCharge } from '../../src/lib/pixGateway';
import { runAutoChargeJob } from '../../src/jobs/autoChargeJob';
import { getConfig, invalidateConfigCache } from '../../src/lib/businessConfig';
import { getBasePriceDynamic, applyDiscount } from '../../src/utils/pricing';
import contractRoutes from '../../src/modules/contracts/routes';
import stripeRoutes from '../../src/modules/stripe/routes';
import { mkUser, mkContract, mkPayment, mkCoupon, mkCpf } from './factories';

// E2 (decisão do dono, 30/09/2026) — desconto PIX do à vista BIDIRECIONAL e determinístico:
//  • toda cobrança FULL grava na criação metadata.pixDiscount { pct, cardAmount, pixAmount }, também quando
//    criada no Cartão/Boleto (amount = cardAmount);
//  • emitir PIX de uma cobrança pendente com amount === cardAmount e pixAmount < amount → a cobrança passa a
//    valer pixAmount (update condicional atômico) e o QR sai com o desconto;
//  • pagar depois no cartão cobra cardAmount — nunca mais que o preço de cartão, nunca valor zero;
//  • mensal e avulso não têm diferença; cobranças antigas sem marca cobram o próprio amount;
//  • /stripe/installment-plans devolve pixAmount e cardAmount (o preço certo por aba ANTES de gerar).

type Who = { id: string; email: string | null; role: string };

const m = <T extends (...a: any[]) => any>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>;
const secondsAgo = (s: number) => new Date(Date.now() - s * 1000);

let server: Server;
let base = '';

beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/contracts', contractRoutes);
    app.use('/api/stripe', stripeRoutes);
    await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
    vi.clearAllMocks();
    invalidateConfigCache();
    m(sicoob.getSicoobEnvironment).mockResolvedValue('sandbox');
    m(sicoob.sicoobRemoveCob).mockResolvedValue(true);
    m(sicoob.sicoobCreatePix).mockImplementation(async (p: { amount: number; txid: string; expiresSeconds?: number }) => ({
        id: p.txid,
        pixString: buildStaticBrCode({ key: 'k', amountCents: p.amount, txid: p.txid }),
        status: 'ATIVA',
        expiresAt: new Date(Date.now() + (p.expiresSeconds ?? 3600) * 1000),
    }));
    m(stripe.isStripeEnabled).mockResolvedValue(true);
    m(stripe.stripeCardInstallmentsSupported).mockResolvedValue(false);
    m(stripe.stripeCancelPaymentIntent).mockResolvedValue({ status: 'canceled', canceled: true });
    m(stripe.stripeGetPaymentIntent).mockResolvedValue(undefined);
    m(stripe.stripeCreatePaymentIntent).mockImplementation(async (o: { paymentId: string; amount: number }) => ({
        clientSecret: `cs_${o.paymentId}_${o.amount}`, paymentIntentId: `pi_new_${o.paymentId.slice(0, 8)}_${o.amount}`, status: 'requires_payment_method',
    }));
    m(stripe.stripeGetOrCreateCustomer).mockResolvedValue('cus_test');
    for (const [i, key] of ['PIX', 'CARTAO', 'BOLETO'].entries()) {
        await prisma.paymentMethodConfig.create({
            data: { key, label: key, shortLabel: key, emoji: '-', description: key, color: '#000000', active: true, sortOrder: i },
        });
    }
    await prisma.integrationConfig.create({ data: { provider: 'SICOOB', enabled: true, environment: 'sandbox', config: '{}' } });
    await prisma.integrationConfig.create({ data: { provider: 'STRIPE', enabled: true, environment: 'sandbox', config: '{}' } });
});

function cookie(u: Who) {
    return `accessToken=${jwt.sign({ userId: u.id, email: u.email ?? '', role: u.role }, config.jwt.secret, { expiresIn: '1h' })}`;
}

async function call(method: string, path: string, who?: Who, body?: unknown) {
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

function nextWeekday(dow: number, minDays: number): string {
    const sp = saoPauloParts(new Date());
    const d = new Date(Date.UTC(sp.y, sp.m - 1, sp.day + minDays));
    while (d.getUTCDay() !== dow) d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
}

/** Total à vista (3 meses, COMERCIAL, sem serviços) no cartão e no PIX — mesma conta da criação. */
async function fullTotals3m() {
    const monthly = (await getConfig('sessions_per_month')) * applyDiscount(await getBasePriceDynamic('COMERCIAL'), await getConfig('discount_3months'));
    const cardFull = monthly * 3;
    const pct = Number(await getConfig('pix_extra_discount_pct'));
    return { cardFull, pixFull: Math.round(cardFull * (1 - pct / 100)), pct };
}

/** Contrato FLEX à vista criado pelo admin (POST /contracts) — o cliente já tem CPF (PIX exige). */
async function adminFull(paymentMethod: 'PIX' | 'CARTAO' | 'BOLETO', over: Record<string, unknown> = {}, clientOver: Record<string, unknown> = {}) {
    const admin = await mkUser({ role: 'ADMIN' });
    const client = await mkUser({ cpfCnpj: mkCpf(), ...clientOver });
    const r = await call('POST', '/api/contracts', admin, {
        userId: client.id, name: 'Flex à vista', type: 'FLEX', tier: 'COMERCIAL', durationMonths: 3,
        startDate: nextWeekday(1, 2), paymentPlan: 'FULL', paymentMethod, ...over,
    });
    expect(r.status).toBe(201);
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: r.body.firstPaymentId } });
    return { admin, client, contractId: r.body.contract.id as string, payment, res: r };
}

const row = (id: string) => prisma.payment.findUniqueOrThrow({ where: { id } });
const markOf = async (id: string) => ((await row(id)).metadata as any)?.pixDiscount;

async function plans(who: Who, paymentId: string) {
    const r = await call('POST', '/api/stripe/installment-plans', who, { paymentId });
    expect(r.status).toBe(200);
    return r.body as { plans: { count: number; total: number }[]; cardAmount: number; pixAmount: number };
}

async function payByPix(who: Who, paymentId: string) {
    m(sicoob.sicoobCreatePix).mockClear();
    const r = await call('POST', '/api/stripe/create-payment', who, { paymentId, paymentMethod: 'pix' });
    return { res: r, emitted: m(sicoob.sicoobCreatePix).mock.calls[0]?.[0]?.amount as number | undefined };
}

async function payByCard(who: Who, paymentId: string) {
    m(stripe.stripeCreatePaymentIntent).mockClear();
    const r = await call('POST', '/api/stripe/create-payment', who, { paymentId, paymentMethod: 'cartao', installments: 1 });
    return { res: r, piAmount: m(stripe.stripeCreatePaymentIntent).mock.calls[0]?.[0]?.amount as number | undefined };
}

// ─── 1) A marca nasce em TODA cobrança à vista ───────────────────────────────────────────────────
describe('E2 — toda cobrança FULL grava a marca dos dois preços na criação', () => {
    it('admin FULL + CARTÃO: amount = cardAmount; marca { pct, cardAmount, pixAmount }; installment-plans mostra os dois preços', async () => {
        const { client, payment } = await adminFull('CARTAO');
        const { cardFull, pixFull, pct } = await fullTotals3m();
        expect(pixFull).toBeLessThan(cardFull);
        expect(payment.amount).toBe(cardFull);
        expect(payment.provider).toBe('STRIPE');
        expect((payment.metadata as any).pixDiscount).toEqual({ pct, cardAmount: cardFull, pixAmount: pixFull });
        const p = await plans(client, payment.id);
        expect(p.cardAmount).toBe(cardFull);
        expect(p.pixAmount).toBe(pixFull);
        expect(p.plans.map(x => [x.count, x.total])).toEqual([[1, cardFull]]);
    });

    it('admin FULL + PIX: amount = pixAmount; a mesma marca; installment-plans mostra os dois preços', async () => {
        const { client, payment } = await adminFull('PIX');
        const { cardFull, pixFull, pct } = await fullTotals3m();
        expect(payment.amount).toBe(pixFull);
        expect((payment.metadata as any).pixDiscount).toEqual({ pct, cardAmount: cardFull, pixAmount: pixFull });
        expect(await plans(client, payment.id)).toMatchObject({ cardAmount: cardFull, pixAmount: pixFull });
    });

    it('cupom: o MESMO valor em R$ nos dois preços (VALOR e PERCENTUAL, criado no cartão)', async () => {
        const { cardFull, pixFull, pct } = await fullTotals3m();
        const admin = await mkUser({ role: 'ADMIN' });
        const fixed = await mkCoupon(admin.id, { discountType: 'VALOR', discountValue: 10000 });
        const a = await adminFull('CARTAO', { couponCode: fixed.code });
        expect(a.payment.discountAmount).toBe(10000);
        expect(a.payment.amount).toBe(cardFull - 10000);
        expect((a.payment.metadata as any).pixDiscount).toEqual({ pct, cardAmount: cardFull - 10000, pixAmount: pixFull - 10000 });

        const percent = await mkCoupon(admin.id, { discountType: 'PERCENTUAL', discountValue: 10 });
        const b = await adminFull('CARTAO', { couponCode: percent.code });
        const d = b.payment.discountAmount!;
        expect(d).toBeGreaterThan(0);
        expect(b.payment.amount).toBe(cardFull - d);
        expect((b.payment.metadata as any).pixDiscount).toEqual({ pct, cardAmount: cardFull - d, pixAmount: pixFull - d });
    });

    it('cupom que zeraria o preço PIX (entre o total PIX e o de cartão): sem marca — PIX e cartão cobram o amount', async () => {
        const { cardFull, pixFull } = await fullTotals3m();
        const admin = await mkUser({ role: 'ADMIN' });
        const coupon = await mkCoupon(admin.id, { discountType: 'VALOR', discountValue: pixFull + 100 });
        const { client, payment } = await adminFull('CARTAO', { couponCode: coupon.code });
        expect(payment.amount).toBe(cardFull - pixFull - 100);
        expect(payment.metadata).toBeNull();
        expect(await plans(client, payment.id)).toMatchObject({ cardAmount: payment.amount, pixAmount: payment.amount });
        const { res, emitted } = await payByPix(client, payment.id);
        expect(res.status).toBe(200);
        expect(emitted).toBe(payment.amount);
    });

    it('cupom 100% no cartão: R$ 0 nasce PAID, sem marca, nada vai ao gateway (PIX, cartão ou auto-charge)', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const coupon = await mkCoupon(admin.id, { discountType: 'PERCENTUAL', discountValue: 100 });
        const { client, payment } = await adminFull('CARTAO', { couponCode: coupon.code }, { autoChargeEnabled: true, stripeCustomerId: 'cus_test' });
        expect(payment).toMatchObject({ amount: 0, status: 'PAID', metadata: null });
        for (const paymentMethod of ['pix', 'cartao'] as const) {
            expect((await call('POST', '/api/stripe/create-payment', client, { paymentId: payment.id, paymentMethod })).status).toBe(400);
        }
        await runAutoChargeJob();
        expect(sicoob.sicoobCreatePix).not.toHaveBeenCalled();
        expect(stripe.stripeCreatePaymentIntent).not.toHaveBeenCalled();
        expect(stripe.stripeChargeOffSession).not.toHaveBeenCalled();
    });

    it('MENSAL (qualquer forma) não tem marca: PIX e cartão cobram o mesmo valor', async () => {
        for (const method of ['CARTAO', 'PIX'] as const) {
            const { client, contractId, payment } = await adminFull(method, { paymentPlan: 'MONTHLY' });
            const rows = await prisma.payment.findMany({ where: { contractId } });
            expect(rows.length).toBe(3);
            expect(rows.every(r => r.metadata === null)).toBe(true);
            expect(await plans(client, payment.id)).toMatchObject({ cardAmount: payment.amount, pixAmount: payment.amount });
        }
    });

    it('/self FULL + CARTÃO: a marca viaja com o contractData', async () => {
        const client = await mkUser({ cpfCnpj: mkCpf() });
        const r = await call('POST', '/api/contracts/self', client, {
            name: 'Flex', type: 'FLEX', tier: 'COMERCIAL', durationMonths: 3,
            firstBookingDate: nextWeekday(3, 3), firstBookingTime: '13:00', paymentMethod: 'CARTAO', paymentPlan: 'FULL',
        });
        expect(r.status).toBe(201);
        const p = await row(r.body.firstPaymentId);
        const { cardFull, pixFull, pct } = await fullTotals3m();
        expect(p.amount).toBe(cardFull);
        expect((p.metadata as any).pixDiscount).toEqual({ pct, cardAmount: cardFull, pixAmount: pixFull });
        expect((p.metadata as any).contractData.paymentMethod).toBe('CARTAO');
        // Trocar para o PIX no checkout: o QR sai com o desconto e o contractData continua intacto.
        const { res, emitted } = await payByPix(client, p.id);
        expect(res.status).toBe(200);
        expect(emitted).toBe(pixFull);
        const after = await row(p.id);
        expect(after.amount).toBe(pixFull);
        expect((after.metadata as any).contractData.type).toBe('FLEX');
    });

    it('/custom (admin) FULL + CARTÃO: marca com os dois preços; o PIX cobra o preço PIX', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser({ cpfCnpj: mkCpf() });
        const r = await call('POST', '/api/contracts/custom', admin, {
            userId: client.id, name: 'Personalizado', tier: 'COMERCIAL', durationMonths: 3, paymentMethod: 'CARTAO', paymentPlan: 'FULL',
            schedule: [{ day: 2, time: '10:00' }], startDate: nextWeekday(2, 2),
        });
        expect(r.status).toBe(201);
        const p = await row(r.body.firstPaymentId);
        const pct = Number(await getConfig('pix_extra_discount_pct'));
        const card = r.body.summary.cycleAmount * 3;
        const pix = Math.round(card * (1 - pct / 100));
        expect(p.amount).toBe(card);
        expect((p.metadata as any).pixDiscount).toEqual({ pct, cardAmount: card, pixAmount: pix });
        const { res, emitted } = await payByPix(admin, p.id);
        expect(res.status).toBe(200);
        expect(res.body.amount).toBe(pix);
        expect(emitted).toBe(pix);
    });

    it('serviço (POST /service): À vista + CARTÃO e o mensal parcelado no cartão nascem com a marca; no PIX saem com o desconto', async () => {
        await prisma.addOnConfig.create({ data: { key: 'GESTAO_TRAFEGO', name: 'Gestão de Tráfego', price: 150000, monthly: true, plansAllowed: 'FULL,MONTHLY', durationsOffered: '3,6' } });
        const pct = Number(await getConfig('pix_extra_discount_pct'));
        const monthly = Math.round(150000 * (1 - Number(await getConfig('service_discount_3months')) / 100));
        const card = monthly * 3;
        const pix = Math.round(card * (1 - pct / 100));

        const u = await mkUser({ cpfCnpj: mkCpf() });
        const full = await call('POST', '/api/contracts/service', u, { serviceKey: 'GESTAO_TRAFEGO', paymentMethod: 'CARTAO', durationMonths: 3, paymentPlan: 'FULL' });
        expect(full.status).toBe(201);
        const p = await row(full.body.firstPaymentId);
        expect(p.amount).toBe(card);
        expect(p.metadata).toMatchObject({ installmentCap: 1, pixDiscount: { pct, cardAmount: card, pixAmount: pix } });
        expect(await plans(u, p.id)).toMatchObject({ cardAmount: card, pixAmount: pix });
        const { res, emitted } = await payByPix(u, p.id);
        expect(res.status).toBe(200);
        expect(emitted).toBe(pix);
        expect((await row(p.id)).metadata).toMatchObject({ installmentCap: 1 }); // o teto do serviço sobrevive

        const u2 = await mkUser({ cpfCnpj: mkCpf() });
        const split = await call('POST', '/api/contracts/service', u2, { serviceKey: 'GESTAO_TRAFEGO', paymentMethod: 'CARTAO', durationMonths: 3, paymentPlan: 'MONTHLY', cardSplit: true });
        expect(split.status).toBe(201);
        const ps = await row(split.body.firstPaymentId);
        expect(ps.amount).toBe(card);
        expect(ps.metadata).toMatchObject({ installmentCap: 3, pixDiscount: { pct, cardAmount: card, pixAmount: pix } });
    });

    it('serviço à vista pago pelo /contracts/:id/pay (linha nova): contrato no CARTÃO pago no PIX ganha o desconto; no cartão cobra o preço de cartão', async () => {
        await prisma.addOnConfig.create({ data: { key: 'GESTAO_TRAFEGO', name: 'Gestão de Tráfego', price: 150000, monthly: true, plansAllowed: 'FULL,MONTHLY', durationsOffered: '3,6' } });
        const pct = Number(await getConfig('pix_extra_discount_pct'));
        const pix = Math.round(450000 * (1 - pct / 100));
        const mk = async () => {
            const client = await mkUser({ cpfCnpj: mkCpf() });
            const c = await mkContract(client.id, {
                type: 'SERVICO', paymentPlan: 'FULL', paymentMethod: 'CARTAO', status: 'AWAITING_PAYMENT', durationMonths: 3, discountPct: 0,
                paymentDeadline: new Date(Date.now() + 3 * 86_400_000), addOns: ['GESTAO_TRAFEGO'],
            });
            return { client, c };
        };
        const a = await mk();
        const byPix = await call('POST', `/api/contracts/${a.c.id}/pay`, a.client, { paymentMethod: 'PIX' });
        expect(byPix.status).toBe(200);
        expect(byPix.body.amount).toBe(pix);
        const p = await row(byPix.body.paymentId);
        expect(p.amount).toBe(pix);
        expect((p.metadata as any).pixDiscount).toEqual({ pct, cardAmount: 450000, pixAmount: pix });
        expect(m(sicoob.sicoobCreatePix).mock.calls[0]![0].amount).toBe(pix);

        const b = await mk();
        const byCard = await call('POST', `/api/contracts/${b.c.id}/pay`, b.client, { paymentMethod: 'CARTAO' });
        expect(byCard.status).toBe(200);
        expect(byCard.body.amount).toBe(450000);
        const pc = await row(byCard.body.paymentId);
        expect(pc).toMatchObject({ amount: 450000, chargedAmount: 450000 });
        expect((pc.metadata as any).pixDiscount).toEqual({ pct, cardAmount: 450000, pixAmount: pix });
    });
});

// ─── 2) PIX de uma cobrança criada no cartão: o amount passa a valer o preço PIX ─────────────────
describe('E2 — emitir PIX de uma cobrança no preço de cartão aplica o desconto (atômico) e o cartão volta a cobrar cardAmount', () => {
    it('CARTÃO → PIX → CARTÃO → PIX: QR com desconto; cartão cobra cardAmount; nunca desconta duas vezes', async () => {
        const { client, payment } = await adminFull('CARTAO');
        const { cardFull, pixFull, pct } = await fullTotals3m();

        const pix1 = await payByPix(client, payment.id);
        expect(pix1.res.status).toBe(200);
        expect(pix1.res.body.amount).toBe(pixFull);
        expect(pix1.emitted).toBe(pixFull);
        let r = await row(payment.id);
        expect(r.amount).toBe(pixFull);
        expect(r.provider).toBe('SICOOB');
        expect((r.metadata as any).pixDiscount).toEqual({ pct, cardAmount: cardFull, pixAmount: pixFull }); // a marca não muda
        expect((r.metadata as any).pixCharge.amount).toBe(pixFull);
        expect(r.discountAmount).toBeNull();
        // Depois do PIX, o checkout continua mostrando os dois preços certos.
        expect(await plans(client, payment.id)).toMatchObject({ cardAmount: cardFull, pixAmount: pixFull });

        const card = await payByCard(client, payment.id);
        expect(card.res.status).toBe(200);
        expect(card.piAmount).toBe(cardFull);
        expect(card.res.body.amount).toBe(cardFull);
        r = await row(payment.id);
        expect(r.amount).toBe(pixFull);           // a base não volta a subir
        expect(r.chargedAmount).toBe(cardFull);   // paridade do webhook do cartão
        expect(r.provider).toBe('STRIPE');
        expect(r.pixString).toBeNull();

        m(stripe.stripeGetPaymentIntent).mockResolvedValue({ id: r.providerRef, status: 'requires_payment_method', amount: cardFull, created: Math.floor(Date.now() / 1000) });
        const pix2 = await payByPix(client, payment.id);
        expect(pix2.res.status).toBe(200);
        expect(pix2.emitted).toBe(pixFull);       // o MESMO preço PIX — não desconta de novo
        expect((await row(payment.id)).amount).toBe(pixFull);
    });

    it('o QR vivo é reaproveitado (mesmo valor); nada é emitido nem repreçado de novo', async () => {
        const { client, payment } = await adminFull('CARTAO');
        const { pixFull } = await fullTotals3m();
        const first = await payByPix(client, payment.id);
        const again = await payByPix(client, payment.id);
        expect(again.res.status).toBe(200);
        expect(again.res.body.reused).toBe(true);
        expect(again.res.body.pixString).toBe(first.res.body.pixString);
        expect(again.emitted).toBeUndefined();
        expect((await row(payment.id)).amount).toBe(pixFull);
    });

    it('cupom criado no cartão: o PIX mantém o mesmo cupom em R$ (pixAmount = total PIX − cupom)', async () => {
        const { cardFull, pixFull } = await fullTotals3m();
        const admin = await mkUser({ role: 'ADMIN' });
        const coupon = await mkCoupon(admin.id, { discountType: 'VALOR', discountValue: 10000 });
        const { client, payment } = await adminFull('CARTAO', { couponCode: coupon.code });
        const { res, emitted } = await payByPix(client, payment.id);
        expect(res.status).toBe(200);
        expect(emitted).toBe(pixFull - 10000);
        const r = await row(payment.id);
        expect(r.amount).toBe(pixFull - 10000);
        expect(r.discountAmount).toBe(10000);
        expect((await payByCard(client, payment.id)).piAmount).toBe(cardFull - 10000);
    });

    it('mudar pix_extra_discount_pct depois da criação não altera nenhum dos dois preços', async () => {
        const { client, payment } = await adminFull('CARTAO');
        const { cardFull, pixFull } = await fullTotals3m();
        await prisma.businessConfig.upsert({
            where: { key: 'pix_extra_discount_pct' },
            create: { key: 'pix_extra_discount_pct', value: '25', type: 'percent', label: 'Desconto PIX', group: 'payments' } as any,
            update: { value: '25' },
        });
        invalidateConfigCache();
        expect(await plans(client, payment.id)).toMatchObject({ cardAmount: cardFull, pixAmount: pixFull });
        expect((await payByPix(client, payment.id)).emitted).toBe(pixFull);
    });

    it('cartão em processamento (PaymentIntent em voo): o PIX é recusado e o amount NÃO muda; liberado quando o PI deixa de estar em voo', async () => {
        const { client, payment } = await adminFull('CARTAO');
        const { cardFull, pixFull } = await fullTotals3m();
        await prisma.payment.update({ where: { id: payment.id }, data: { providerRef: 'pi_inflight_1', chargedAmount: cardFull } });
        for (const status of ['processing', 'succeeded', 'requires_action']) {
            m(stripe.stripeGetPaymentIntent).mockResolvedValue({ id: 'pi_inflight_1', status, amount: cardFull, created: Math.floor(Date.now() / 1000) });
            const blocked = await payByPix(client, payment.id);
            expect(blocked.res.status).toBe(400);
            expect(blocked.res.body.error).toMatch(/cartão em processamento/);
            expect(blocked.emitted).toBeUndefined();
            expect((await row(payment.id)).amount).toBe(cardFull);
        }
        m(stripe.stripeGetPaymentIntent).mockResolvedValue({ id: 'pi_inflight_1', status: 'requires_payment_method', amount: cardFull, created: Math.floor(Date.now() / 1000) });
        const ok = await payByPix(client, payment.id);
        expect(ok.res.status).toBe(200);
        expect(ok.emitted).toBe(pixFull);
        const r = await row(payment.id);
        expect(r.amount).toBe(pixFull);
        expect(r.chargedAmount).toBe(cardFull); // o PI antigo, se ainda aprovar, casa pelo chargedAmount (pagamentos-14)
    });

    it('dois pedidos de PIX SIMULTÂNEOS: o amount baixa UMA vez (nunca abaixo do preço PIX)', async () => {
        const { client, payment } = await adminFull('CARTAO');
        const { pixFull } = await fullTotals3m();
        const [a, b] = await Promise.all([
            call('POST', '/api/stripe/create-payment', client, { paymentId: payment.id, paymentMethod: 'pix' }),
            call('POST', '/api/stripe/create-payment', client, { paymentId: payment.id, paymentMethod: 'pix' }),
        ]);
        for (const r of [a, b]) if (r.status === 200) expect(r.body.amount).toBe(pixFull);
        expect([a.status, b.status]).toContain(200);
        expect((await row(payment.id)).amount).toBe(pixFull);
        for (const c of m(sicoob.sicoobCreatePix).mock.calls) expect(c[0].amount).toBe(pixFull);
    });

    it('update condicional: se a linha mudou entre a leitura e a emissão (repreço concorrente), nada é baixado', async () => {
        const { payment } = await adminFull('CARTAO');
        const { cardFull } = await fullTotals3m();
        // Um repreço concorrente troca o amount (a marca caduca) DEPOIS da leitura e ANTES do update
        // condicional — simulado na consulta ao PaymentIntent anterior, que acontece entre os dois.
        await prisma.payment.update({ where: { id: payment.id }, data: { providerRef: 'pi_race_1' } });
        m(sicoob.sicoobCreatePix).mockClear();
        m(stripe.stripeGetPaymentIntent).mockImplementationOnce(async () => {
            await prisma.payment.update({ where: { id: payment.id }, data: { amount: cardFull + 5000 } });
            return { id: 'pi_race_1', status: 'requires_payment_method', amount: cardFull, created: Math.floor(Date.now() / 1000) };
        });
        await expect(issuePixCharge(payment.id)).rejects.toThrow(/mudou de situação/);
        expect(sicoob.sicoobCreatePix).not.toHaveBeenCalled();
        expect((await row(payment.id)).amount).toBe(cardFull + 5000);
    });

    it('update condicional: a MARCA regravada no meio (mesmo amount, outro preço PIX) também impede baixar para o preço antigo', async () => {
        const { payment } = await adminFull('CARTAO');
        const { cardFull, pixFull, pct } = await fullTotals3m();
        await prisma.payment.update({ where: { id: payment.id }, data: { providerRef: 'pi_race_2' } });
        m(sicoob.sicoobCreatePix).mockClear();
        m(stripe.stripeGetPaymentIntent).mockImplementationOnce(async () => {
            await prisma.payment.update({
                where: { id: payment.id },
                data: { metadata: { pixDiscount: { pct, cardAmount: cardFull, pixAmount: pixFull + 1000 } } },
            });
            return { id: 'pi_race_2', status: 'requires_payment_method', amount: cardFull, created: Math.floor(Date.now() / 1000) };
        });
        await expect(issuePixCharge(payment.id)).rejects.toThrow(/mudou de situação/);
        expect(sicoob.sicoobCreatePix).not.toHaveBeenCalled();
        expect((await row(payment.id)).amount).toBe(cardFull); // nada foi baixado para o preço PIX antigo
        // A próxima tentativa lê a marca nova e aplica o preço PIX NOVO.
        m(stripe.stripeGetPaymentIntent).mockResolvedValue({ id: 'pi_race_2', status: 'requires_payment_method', amount: cardFull, created: Math.floor(Date.now() / 1000) });
        const next = await issuePixCharge(payment.id);
        expect(next.amount).toBe(pixFull + 1000);
    });

    it('falha do provedor na emissão: o repreço é desfeito (PAY-3 — a cobrança volta ao preço de cartão) e o cartão segue cobrando cardAmount', async () => {
        const { client, payment } = await adminFull('CARTAO');
        const { cardFull, pixFull } = await fullTotals3m();
        m(sicoob.sicoobCreatePix).mockRejectedValueOnce(new Error('Sicoob fora do ar'));
        const failed = await call('POST', '/api/stripe/create-payment', client, { paymentId: payment.id, paymentMethod: 'pix' });
        expect(failed.status).toBe(400);
        expect((await row(payment.id)).amount).toBe(cardFull);
        expect(await plans(client, payment.id)).toMatchObject({ cardAmount: cardFull, pixAmount: pixFull });
        expect((await payByCard(client, payment.id)).piAmount).toBe(cardFull);
    });

    it('o ADMIN cobrando o cliente no PIX (contrato criado no cartão): mesmo desconto, CPF do cliente', async () => {
        const { admin, client, payment } = await adminFull('CARTAO');
        const { pixFull } = await fullTotals3m();
        const { res, emitted } = await payByPix(admin, payment.id);
        expect(res.status).toBe(200);
        expect(emitted).toBe(pixFull);
        expect(m(sicoob.sicoobCreatePix).mock.calls[0]![0].customer.document.identity).toBe(client.cpfCnpj);
    });
});

// ─── 3) Sem a marca (ou com a marca caduca) nada muda ────────────────────────────────────────────
describe('E2 — cobranças antigas / sem marca continuam cobrando o próprio amount', () => {
    it('FULL antigo sem marca (criado no cartão antes da regra): PIX cobra o amount; installment-plans devolve o mesmo valor nas duas abas', async () => {
        const u = await mkUser({ cpfCnpj: mkCpf() });
        const c = await mkContract(u.id, { type: 'FIXO', paymentPlan: 'FULL', paymentMethod: 'CARTAO' });
        const p = await mkPayment(u.id, { contractId: c.id, provider: 'STRIPE', amount: 315000, dueDate: secondsAgo(60) });
        expect(pixPriceFromMark(p)).toBeNull();
        expect(await plans(u, p.id)).toMatchObject({ cardAmount: 315000, pixAmount: 315000 });
        const { res, emitted } = await payByPix(u, p.id);
        expect(res.status).toBe(200);
        expect(emitted).toBe(315000);
        expect((await row(p.id)).amount).toBe(315000);
    });

    it('marca antiga sem pixAmount, marca corrompida e marca caduca (amount alterado depois): o PIX nunca baixa o valor', async () => {
        const u = await mkUser({ cpfCnpj: mkCpf() });
        const c = await mkContract(u.id, { type: 'FIXO', paymentPlan: 'FULL', paymentMethod: 'CARTAO' });
        const cases: { amount: number; metadata: any; card: number }[] = [
            { amount: 315000, metadata: { pixDiscount: { pct: 10, cardAmount: 315000 } }, card: 315000 },                    // sem pixAmount
            { amount: 315000, metadata: { pixDiscount: { pct: 10, cardAmount: 315000, pixAmount: -1 } }, card: 315000 },     // corrompida
            { amount: 315000, metadata: { pixDiscount: { pct: 10, cardAmount: 315000, pixAmount: 0 } }, card: 315000 },      // preço PIX zero
            { amount: 315000, metadata: { pixDiscount: { pct: 10, cardAmount: 315000, pixAmount: 400000 } }, card: 315000 }, // PIX > cartão
            { amount: 300000, metadata: { pixDiscount: { pct: 10, cardAmount: 315000, pixAmount: 283500 } }, card: 300000 }, // caduca
        ];
        for (const k of cases) {
            const p = await mkPayment(u.id, { contractId: c.id, provider: 'STRIPE', amount: k.amount, metadata: k.metadata });
            expect(pixPriceFromMark(p)).toBeNull();
            expect(pixChargeAmount(p)).toBe(k.amount);
            expect(await cardChargeBaseAmount(p)).toBe(k.card);
            const { res, emitted } = await payByPix(u, p.id);
            expect(res.status).toBe(200);
            expect(emitted).toBe(k.amount);
            expect((await row(p.id)).amount).toBe(k.amount);
        }
    });

    it('parcela mensal, extras de gravação e multa (sem marca): PIX e cartão cobram o amount', async () => {
        const u = await mkUser({ cpfCnpj: mkCpf() });
        const c = await mkContract(u.id, { type: 'FIXO', paymentPlan: 'MONTHLY', paymentMethod: 'CARTAO' });
        const monthly = await mkPayment(u.id, { contractId: c.id, provider: 'STRIPE', amount: 84000 });
        const fine = await mkPayment(u.id, { contractId: c.id, provider: 'STRIPE', amount: 16800, metadata: { kind: 'CANCELLATION_FINE', finePct: 20, baseAmount: 84000 } });
        for (const p of [monthly, fine]) {
            expect(await plans(u, p.id)).toMatchObject({ cardAmount: p.amount, pixAmount: p.amount });
            expect((await payByPix(u, p.id)).emitted).toBe(p.amount);
            expect((await row(p.id)).amount).toBe(p.amount);
        }
    });

    it('prévia sem paymentId (wizard): pixAmount e cardAmount = o valor informado', async () => {
        const u = await mkUser();
        const r = await call('POST', '/api/stripe/installment-plans', u, { amount: 315000, contractDurationMonths: 3 });
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ cardAmount: 315000, pixAmount: 315000 });
    });

    it('pixDiscountMetaForFullCharge: sem % não há marca; o preço PIX nunca é ≥ o de cartão nem ≤ 0', () => {
        expect(pixDiscountMetaForFullCharge({ cardTotal: 315000, pixTotal: 315000, pct: 0 })).toBeUndefined();
        expect(pixDiscountMetaForFullCharge({ cardTotal: 315000, pixTotal: 283500, pct: 10 })).toEqual({ pct: 10, cardAmount: 315000, pixAmount: 283500 });
        expect(pixDiscountMetaForFullCharge({ cardTotal: 315000, pixTotal: 283500, couponDiscount: 283500, pct: 10 })).toBeUndefined();
        expect(pixDiscountMetaForFullCharge({ cardTotal: 315000, pixTotal: 283500, couponDiscount: 315000, pct: 10 })).toBeUndefined();
        expect(pixDiscountMetaForFullCharge({ cardTotal: 315000, pixTotal: 283500, couponDiscount: 1000, pct: 10 })).toEqual({ pct: 10, cardAmount: 314000, pixAmount: 282500 });
    });
});

// ─── 4) Cobrança automática (cartão) ─────────────────────────────────────────────────────────────
describe('E2 — autoCharge cobra sempre o preço de cartão marcado (nunca mais)', () => {
    async function autoUser() {
        const u = await mkUser({ autoChargeEnabled: true, stripeCustomerId: 'cus_test', cpfCnpj: mkCpf() });
        await prisma.savedPaymentMethod.create({ data: { userId: u.id, stripePaymentMethodId: `pm_${u.id.slice(0, 8)}`, brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030, isDefault: true } });
        m(stripe.stripeChargeOffSession).mockImplementation(async (_c: string, _pm: string, _amt: number, meta: { paymentId: string }) =>
            ({ clientSecret: '', paymentIntentId: `pi_auto_${meta.paymentId.slice(0, 6)}`, status: 'succeeded' }));
        return u;
    }

    it('criada no cartão (amount = cardAmount) → cobra cardAmount; baixada para o preço PIX e com o QR vencido → cobra cardAmount', async () => {
        const u = await autoUser();
        const c = await mkContract(u.id, { type: 'FIXO', paymentPlan: 'FULL', paymentMethod: 'CARTAO' });
        const mark = { pixDiscount: { pct: 10, cardAmount: 315000, pixAmount: 283500 } };
        const atCard = await mkPayment(u.id, { contractId: c.id, provider: 'STRIPE', amount: 315000, dueDate: secondsAgo(60), metadata: mark });
        await runAutoChargeJob();
        expect(m(stripe.stripeChargeOffSession).mock.calls.map(x => x[2])).toEqual([315000]);
        expect(await row(atCard.id)).toMatchObject({ status: 'PAID', amount: 315000, chargedAmount: 315000 });

        m(stripe.stripeChargeOffSession).mockClear();
        const c2 = await mkContract(u.id, { type: 'FIXO', paymentPlan: 'FULL', paymentMethod: 'CARTAO' });
        const atPix = await mkPayment(u.id, {
            contractId: c2.id, provider: 'SICOOB', providerRef: 'mock-abc', amount: 283500, dueDate: secondsAgo(60),
            pixExpiresAt: secondsAgo(3600), metadata: { ...mark, pixCharge: { attempt: 1, amount: 283500 } },
        });
        await runAutoChargeJob();
        expect(m(stripe.stripeChargeOffSession).mock.calls.map(x => x[2])).toEqual([315000]);
        expect(await row(atPix.id)).toMatchObject({ status: 'PAID', amount: 283500, chargedAmount: 315000 });
    });
});

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// ─── Mocks dos provedores (Sicoob / Stripe / Cora) e do push: nenhuma chamada de rede real ───────
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
        stripeCreatePaymentIntent: vi.fn(),
        stripeCancelSubscription: vi.fn(async () => {}),
        stripeGetOrCreateCustomer: vi.fn(async () => 'cus_test'),
    };
});
vi.mock('../../src/lib/coraPaymentHelper', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../../src/lib/coraPaymentHelper')>();
    return { ...orig, createCoraPayment: vi.fn() };
});
vi.mock('../../src/modules/push/pushService', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../../src/modules/push/pushService')>();
    return { ...orig, sendPushToUser: vi.fn(async () => 1) };
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
import { getConfig, invalidateConfigCache } from '../../src/lib/businessConfig';
import { getBasePriceDynamic, applyDiscount } from '../../src/utils/pricing';
import { applyContractServiceChange } from '../../src/lib/paymentEffects';
import { cardChargeBaseAmount, pixChargeAmount } from '../../src/lib/pixGateway';
import { planPaymentBlockedByPendingCancellation, CANCELLATION_PENDING_MESSAGE } from '../../src/lib/cancellationPending';
import contractRoutes from '../../src/modules/contracts/routes';
import stripeRoutes from '../../src/modules/stripe/routes';
import bookingRoutes from '../../src/modules/bookings/routes';
import { mkUser, mkContract, mkPayment, mkBooking, mkCpf } from './factories';

// Lote 2 — frente b6-be-fixups (pendências de backend da onda A):
//  1. applyContractServiceChange regrava a marca pixDiscount BIDIRECIONAL em toda cobrança à vista (E2);
//  2. PATCH /contracts/:id: BOLETO só com o boleto efetivo; boletoAllowed do corpo é ignorado (E3);
//  3. contrato em PENDING_CANCELLATION: o cliente não paga parcelas do plano (409 CANCELLATION_PENDING);
//  4. PUT /bookings/:id/undo-start-recording desfaz um "Iniciar gravação" clicado por engano (E11).

type Who = { id: string; email: string | null; role: string };
const m = <T extends (...a: any[]) => any>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>;
const createPix = m(sicoob.sicoobCreatePix);
const removeCob = m(sicoob.sicoobRemoveCob);
const createPI = m(stripe.stripeCreatePaymentIntent);

let server: Server;
let base = '';

beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/contracts', contractRoutes);
    app.use('/api/stripe', stripeRoutes);
    app.use('/api/bookings', bookingRoutes);
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
    removeCob.mockResolvedValue(true);
    createPix.mockImplementation(async (p: { amount: number; txid: string; expiresSeconds?: number }) => ({
        id: p.txid,
        pixString: buildStaticBrCode({ key: 'k', amountCents: p.amount, txid: p.txid }),
        status: 'ATIVA',
        expiresAt: new Date(Date.now() + (p.expiresSeconds ?? 3600) * 1000),
    }));
    m(stripe.isStripeEnabled).mockResolvedValue(true);
    m(stripe.stripeCardInstallmentsSupported).mockResolvedValue(false);
    m(stripe.stripeCancelPaymentIntent).mockResolvedValue({ status: 'canceled', canceled: true });
    m(stripe.stripeGetPaymentIntent).mockResolvedValue(undefined);
    createPI.mockImplementation(async (o: { paymentId: string; amount: number }) => ({
        clientSecret: `cs_${o.paymentId}_${o.amount}`, paymentIntentId: `pi_new_${o.paymentId.slice(0, 8)}_${o.amount}`, status: 'requires_payment_method',
    }));
    m(stripe.stripeGetOrCreateCustomer).mockResolvedValue('cus_test');
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

/** Métodos de pagamento + integrações. `boleto` = chave-mestra; `cora` = integração Cora habilitada. */
async function setupMethods(opts: { boleto?: boolean; cora?: boolean } = {}) {
    for (const [i, key] of ['PIX', 'CARTAO', 'BOLETO'].entries()) {
        await prisma.paymentMethodConfig.create({
            data: { key, label: key, shortLabel: key, emoji: '-', description: key, color: '#000000', active: key === 'BOLETO' ? !!opts.boleto : true, sortOrder: i },
        });
    }
    await prisma.integrationConfig.create({ data: { provider: 'SICOOB', enabled: true, environment: 'sandbox', config: '{}' } });
    await prisma.integrationConfig.create({ data: { provider: 'STRIPE', enabled: true, environment: 'sandbox', config: '{}' } });
    await prisma.integrationConfig.create({ data: { provider: 'CORA', enabled: !!opts.cora, environment: 'sandbox', config: '{}' } });
}

async function setConfig(key: string, value: string) {
    await prisma.businessConfig.upsert({
        where: { key },
        create: { key, value, type: 'percent', label: key, group: 'payments' },
        update: { value },
    });
    invalidateConfigCache();
}

function nextWeekday(dow: number, minDays: number): string {
    const sp = saoPauloParts(new Date());
    const d = new Date(Date.UTC(sp.y, sp.m - 1, sp.day + minDays));
    while (d.getUTCDay() !== dow) d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
}

/** Data-calendário de SP (hoje + n dias) como meia-noite UTC — o formato de Booking.date. */
function spDay(n: number): Date {
    const d = new Date(`${saoPauloParts(new Date()).dateStr}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d;
}

const row = (id: string) => prisma.payment.findUniqueOrThrow({ where: { id } });
const markOf = async (id: string) => ((await row(id)).metadata as any)?.pixDiscount;

const SERVICE = { key: 'GESTAO_SOCIAL', name: 'Gestão Social', price: 60000, monthly: true };

/** Total à vista (3 meses, COMERCIAL) com os serviços mensais dados — a mesma conta do repreço. */
async function fullTotals(discountPct: number, servicePrices: number[] = []) {
    const sessions = await getConfig('sessions_per_month');
    const monthly = sessions * applyDiscount(await getBasePriceDynamic('COMERCIAL'), discountPct)
        + servicePrices.reduce((s, p) => s + applyDiscount(p, discountPct), 0);
    const cardFull = monthly * 3;
    const pct = Number(await getConfig('pix_extra_discount_pct'));
    return { monthly, cardFull, pixFull: Math.round(cardFull * (1 - pct / 100)), pct };
}

/** Contrato FLEX à vista criado pelo admin (POST /contracts): ACTIVE, cobrança única PENDING com a marca E2. */
async function adminFull(paymentMethod: 'PIX' | 'CARTAO' | 'BOLETO') {
    const admin = await mkUser({ role: 'ADMIN' });
    const client = await mkUser({ cpfCnpj: mkCpf() });
    const r = await call('POST', '/api/contracts', admin, {
        userId: client.id, name: 'Flex à vista', type: 'FLEX', tier: 'COMERCIAL', durationMonths: 3,
        startDate: nextWeekday(1, 2), paymentPlan: 'FULL', paymentMethod,
    });
    expect(r.status).toBe(201);
    const contract = await prisma.contract.findUniqueOrThrow({ where: { id: r.body.contract.id } });
    expect(contract.status).toBe('ACTIVE');
    const payment = await row(r.body.firstPaymentId);
    return { admin, client, contract, payment };
}

// ═══ 1) Troca de serviços regrava a marca bidirecional (E2) ═══════════════════════════════════════
describe('applyContractServiceChange — à vista: a marca pixDiscount dos dois preços é regravada (E2)', () => {
    beforeEach(async () => {
        await setupMethods();
        await prisma.addOnConfig.create({ data: { ...SERVICE, plansAllowed: 'FULL,MONTHLY' } });
    });

    it('FULL + CARTÃO (PATCH addOns): amount = preço de cartão NOVO e a marca traz o preço PIX NOVO — o PIX continua com desconto', async () => {
        const { admin, client, contract, payment } = await adminFull('CARTAO');
        const before = await fullTotals(contract.discountPct);
        expect(payment.amount).toBe(before.cardFull);
        expect((payment.metadata as any).pixDiscount).toEqual({ pct: before.pct, cardAmount: before.cardFull, pixAmount: before.pixFull });

        const patch = await call('PATCH', `/api/contracts/${contract.id}`, admin, { addOns: [SERVICE.key] });
        expect(patch.status).toBe(200);

        const after = await fullTotals(contract.discountPct, [SERVICE.price]);
        expect(after.cardFull).toBeGreaterThan(before.cardFull);
        expect(after.pixFull).toBeLessThan(after.cardFull);
        const p = await row(payment.id);
        expect(p.amount).toBe(after.cardFull);
        expect(await markOf(payment.id)).toEqual({ pct: after.pct, cardAmount: after.cardFull, pixAmount: after.pixFull });
        expect(pixChargeAmount(p)).toBe(after.pixFull);
        expect(await cardChargeBaseAmount(p)).toBe(after.cardFull);

        // Checkout: as duas abas mostram o preço certo ANTES de gerar…
        const plans = await call('POST', '/api/stripe/installment-plans', client, { paymentId: payment.id });
        expect(plans.body).toMatchObject({ cardAmount: after.cardFull, pixAmount: after.pixFull });
        // …e o QR sai com o desconto (a cobrança passa a valer o preço PIX novo).
        const pix = await call('POST', '/api/stripe/create-payment', client, { paymentId: payment.id, paymentMethod: 'pix' });
        expect(pix.status).toBe(200);
        expect(pix.body.amount).toBe(after.pixFull);
        expect(createPix.mock.calls[0]![0].amount).toBe(after.pixFull);
        expect((await row(payment.id)).amount).toBe(after.pixFull);
        // Voltou para o cartão: cobra o preço de cartão novo — nunca o desconto PIX, nunca o valor antigo.
        const card = await call('POST', '/api/stripe/create-payment', client, { paymentId: payment.id, paymentMethod: 'cartao', installments: 1 });
        expect(card.status).toBe(200);
        expect(createPI.mock.calls[0]![0].amount).toBe(after.cardFull);
    });

    it('FULL + BOLETO (contrato legado): mesma regra do cartão — amount = preço de cartão novo + marca', async () => {
        const client = await mkUser({ cpfCnpj: mkCpf() });
        const contract = await mkContract(client.id, { type: 'FIXO', paymentPlan: 'FULL', paymentMethod: 'BOLETO', fixedDayOfWeek: 1, fixedTime: '10:00' });
        const payment = await mkPayment(client.id, { contractId: contract.id, provider: 'CORA', amount: 111111 });

        await applyContractServiceChange(contract.id, [SERVICE.key]);

        const t = await fullTotals(contract.discountPct, [SERVICE.price]);
        expect((await row(payment.id)).amount).toBe(t.cardFull);
        expect(await markOf(payment.id)).toEqual({ pct: t.pct, cardAmount: t.cardFull, pixAmount: t.pixFull });
    });

    it('FULL + CARTÃO com a linha no preço PIX e QR vivo: o QR antigo é aposentado e a linha volta ao preço de cartão novo, com a marca nova', async () => {
        const { client, contract, payment } = await adminFull('CARTAO');
        const before = await fullTotals(contract.discountPct);
        const pix = await call('POST', '/api/stripe/create-payment', client, { paymentId: payment.id, paymentMethod: 'pix' });
        expect(pix.status).toBe(200);
        const live = await row(payment.id);
        expect(live.amount).toBe(before.pixFull);
        expect(live.pixString).toBeTruthy();
        const oldTxid = live.providerRef;

        await applyContractServiceChange(contract.id, [SERVICE.key]);

        const after = await fullTotals(contract.discountPct, [SERVICE.price]);
        const p = await row(payment.id);
        expect(removeCob).toHaveBeenCalledWith(oldTxid);
        expect(p.amount).toBe(after.cardFull);
        expect(p.pixString).toBeNull();
        expect(p.pixExpiresAt).toBeNull();
        expect(p.providerRef).toBeNull();
        expect(await markOf(payment.id)).toEqual({ pct: after.pct, cardAmount: after.cardFull, pixAmount: after.pixFull });
        // O próximo PIX sai pelo preço PIX NOVO (nunca o antigo, nunca o valor cheio).
        createPix.mockClear();
        const again = await call('POST', '/api/stripe/create-payment', client, { paymentId: payment.id, paymentMethod: 'pix' });
        expect(again.status).toBe(200);
        expect(createPix.mock.calls[0]![0].amount).toBe(after.pixFull);
    });

    it('FULL + PIX: continua gravando o preço PIX novo, com a marca dos dois preços (sem regressão)', async () => {
        const { contract, payment } = await adminFull('PIX');
        const before = await fullTotals(contract.discountPct);
        expect(payment.amount).toBe(before.pixFull);

        await applyContractServiceChange(contract.id, [SERVICE.key]);

        const after = await fullTotals(contract.discountPct, [SERVICE.price]);
        const p = await row(payment.id);
        expect(p.amount).toBe(after.pixFull);
        expect(await markOf(payment.id)).toEqual({ pct: after.pct, cardAmount: after.cardFull, pixAmount: after.pixFull });
        expect(await cardChargeBaseAmount(p)).toBe(after.cardFull);
    });

    it('remover o serviço (volta ao valor anterior): a marca acompanha de novo', async () => {
        const { contract, payment } = await adminFull('CARTAO');
        await applyContractServiceChange(contract.id, [SERVICE.key]);
        await applyContractServiceChange(contract.id, []);
        const t = await fullTotals(contract.discountPct);
        expect((await row(payment.id)).amount).toBe(t.cardFull);
        expect(await markOf(payment.id)).toEqual({ pct: t.pct, cardAmount: t.cardFull, pixAmount: t.pixFull });
    });

    it('desconto PIX configurado em 0%: não há diferença de preço — a marca antiga sai e PIX/cartão cobram o amount', async () => {
        const { contract, payment } = await adminFull('CARTAO');
        expect(await markOf(payment.id)).toBeTruthy();
        await setConfig('pix_extra_discount_pct', '0');

        await applyContractServiceChange(contract.id, [SERVICE.key]);

        const t = await fullTotals(contract.discountPct, [SERVICE.price]);
        expect(t.pixFull).toBe(t.cardFull);
        const p = await row(payment.id);
        expect(p.amount).toBe(t.cardFull);
        expect(await markOf(payment.id)).toBeUndefined();
        expect(pixChargeAmount(p)).toBe(t.cardFull);
        expect(await cardChargeBaseAmount(p)).toBe(t.cardFull);
    });

    it('MENSAL: parcelas pendentes repreçadas sem marca (uma marca perdida é removida); a paga e os extras não mudam', async () => {
        const client = await mkUser();
        const contract = await mkContract(client.id, { type: 'FIXO', paymentPlan: 'MONTHLY', paymentMethod: 'CARTAO', fixedDayOfWeek: 1, fixedTime: '10:00' });
        const paid = await mkPayment(client.id, { contractId: contract.id, amount: 84000, status: 'PAID', paidAt: new Date() });
        const p2 = await mkPayment(client.id, { contractId: contract.id, provider: 'STRIPE', amount: 84000, metadata: { pixDiscount: { pct: 10, cardAmount: 84000, pixAmount: 75600 }, other: 'keep' } });
        const p3 = await mkPayment(client.id, { contractId: contract.id, provider: 'STRIPE', amount: 84000 });
        const booking = await mkBooking(client.id, contract.id, { date: spDay(3) });
        const extras = await mkPayment(client.id, { contractId: contract.id, bookingId: booking.id, provider: 'STRIPE', amount: 5000 });

        await applyContractServiceChange(contract.id, [SERVICE.key]);

        const t = await fullTotals(contract.discountPct, [SERVICE.price]);
        expect((await row(paid.id)).amount).toBe(84000);
        expect((await row(p2.id)).amount).toBe(t.monthly);
        expect((await row(p3.id)).amount).toBe(t.monthly);
        expect((await row(p2.id)).metadata).toEqual({ other: 'keep' });
        expect(await markOf(p3.id)).toBeUndefined();
        expect((await row(extras.id)).amount).toBe(5000);
    });

    it('multa de cancelamento pendente num contrato reaberto NÃO é repreçada (não é parcela do plano)', async () => {
        const client = await mkUser();
        const contract = await mkContract(client.id, { type: 'FIXO', paymentPlan: 'MONTHLY', paymentMethod: 'PIX', fixedDayOfWeek: 1, fixedTime: '10:00' });
        const installment = await mkPayment(client.id, { contractId: contract.id, amount: 84000 });
        const fineMeta = { kind: 'CANCELLATION_FINE', finePct: 20, baseAmount: 168000 };
        const fine = await mkPayment(client.id, { contractId: contract.id, amount: 33600, metadata: fineMeta });

        await applyContractServiceChange(contract.id, [SERVICE.key]);

        const t = await fullTotals(contract.discountPct, [SERVICE.price]);
        expect((await row(installment.id)).amount).toBe(t.monthly);
        const f = await row(fine.id);
        expect(f.amount).toBe(33600);
        expect(f.metadata).toEqual(fineMeta);
    });
});

// ═══ 2) PATCH /contracts/:id — BOLETO só com o boleto efetivo (E3) ════════════════════════════════
describe('PATCH /contracts/:id — paymentMethod BOLETO exige a chave-mestra + Cora; boletoAllowed é ignorado', () => {
    async function activeContract(over: Record<string, unknown> = {}) {
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser();
        const contract = await mkContract(client.id, { type: 'FIXO', paymentMethod: 'PIX', fixedDayOfWeek: 1, fixedTime: '10:00', ...over });
        return { admin, client, contract };
    }
    const fresh = (id: string) => prisma.contract.findUniqueOrThrow({ where: { id } });

    it('chave-mestra desligada → 400 BOLETO_UNAVAILABLE (SWITCH_OFF) e NADA do PATCH é gravado', async () => {
        await setupMethods({ boleto: false, cora: true });
        const { admin, contract } = await activeContract();
        const r = await call('PATCH', `/api/contracts/${contract.id}`, admin, { paymentMethod: 'BOLETO', contractUrl: 'https://exemplo.com/contrato.pdf' });
        expect(r.status).toBe(400);
        expect(r.body).toMatchObject({ code: 'BOLETO_UNAVAILABLE', reason: 'SWITCH_OFF' });
        expect(typeof r.body.error).toBe('string');
        const c = await fresh(contract.id);
        expect(c.paymentMethod).toBe('PIX');
        expect(c.contractUrl).toBeNull();
    });

    it('chave ligada mas Cora inativa → 400 BOLETO_UNAVAILABLE (PROVIDER_DISABLED)', async () => {
        await setupMethods({ boleto: true, cora: false });
        const { admin, contract } = await activeContract();
        const r = await call('PATCH', `/api/contracts/${contract.id}`, admin, { paymentMethod: 'BOLETO' });
        expect(r.status).toBe(400);
        expect(r.body).toMatchObject({ code: 'BOLETO_UNAVAILABLE', reason: 'PROVIDER_DISABLED' });
        expect((await fresh(contract.id)).paymentMethod).toBe('PIX');
    });

    it('sem nenhuma configuração de métodos (banco novo) → 400 (boleto nasce desligado)', async () => {
        const { admin, contract } = await activeContract();
        const r = await call('PATCH', `/api/contracts/${contract.id}`, admin, { paymentMethod: 'BOLETO' });
        expect(r.status).toBe(400);
        expect(r.body.code).toBe('BOLETO_UNAVAILABLE');
    });

    it('boleto efetivo (chave + Cora) → 200 e a forma passa a BOLETO', async () => {
        await setupMethods({ boleto: true, cora: true });
        const { admin, contract } = await activeContract();
        const r = await call('PATCH', `/api/contracts/${contract.id}`, admin, { paymentMethod: 'BOLETO' });
        expect(r.status).toBe(200);
        expect((await fresh(contract.id)).paymentMethod).toBe('BOLETO');
    });

    it('PIX e CARTÃO continuam aceitos com o boleto desligado', async () => {
        await setupMethods({ boleto: false, cora: false });
        const { admin, contract } = await activeContract();
        expect((await call('PATCH', `/api/contracts/${contract.id}`, admin, { paymentMethod: 'CARTAO' })).status).toBe(200);
        expect((await fresh(contract.id)).paymentMethod).toBe('CARTAO');
        expect((await call('PATCH', `/api/contracts/${contract.id}`, admin, { paymentMethod: 'PIX' })).status).toBe(200);
        expect((await fresh(contract.id)).paymentMethod).toBe('PIX');
    });

    it('contrato que JÁ era BOLETO: reenviar BOLETO com o boleto desligado não bloqueia as outras edições', async () => {
        await setupMethods({ boleto: false, cora: false });
        const { admin, contract } = await activeContract({ paymentMethod: 'BOLETO' });
        const r = await call('PATCH', `/api/contracts/${contract.id}`, admin, { paymentMethod: 'BOLETO', contractUrl: 'https://exemplo.com/c.pdf' });
        expect(r.status).toBe(200);
        const c = await fresh(contract.id);
        expect(c.paymentMethod).toBe('BOLETO');
        expect(c.contractUrl).toBe('https://exemplo.com/c.pdf');
    });

    it('boletoAllowed no corpo é ignorado nos dois sentidos (a coluna não muda) e o resto do PATCH é salvo', async () => {
        await setupMethods({ boleto: true, cora: true });
        const off = await activeContract();
        const r1 = await call('PATCH', `/api/contracts/${off.contract.id}`, off.admin, { boletoAllowed: true, contractUrl: 'https://exemplo.com/a.pdf' });
        expect(r1.status).toBe(200);
        expect((await fresh(off.contract.id)).boletoAllowed).toBe(false);
        expect((await fresh(off.contract.id)).contractUrl).toBe('https://exemplo.com/a.pdf');

        const on = await activeContract({ boletoAllowed: true });
        const r2 = await call('PATCH', `/api/contracts/${on.contract.id}`, on.admin, { boletoAllowed: false });
        expect(r2.status).toBe(200);
        expect((await fresh(on.contract.id)).boletoAllowed).toBe(true);
    });
});

// ═══ 3) Cancelamento em análise: o cliente não paga parcelas do plano ═════════════════════════════
describe('PENDING_CANCELLATION — cliente não paga parcelas do plano (409 CANCELLATION_PENDING); admin, extras e multa seguem', () => {
    const EXPECTED = { code: 'CANCELLATION_PENDING', error: 'Este contrato está com cancelamento em análise. Aguarde a decisão do estúdio.' };

    beforeEach(async () => { await setupMethods(); });

    /** FIXO mensal: 1ª paga, 2ª e 3ª pendentes; o cliente pede o cancelamento pela ROTA real. */
    async function requested() {
        const admin = await mkUser({ role: 'ADMIN', cpfCnpj: mkCpf() });
        const client = await mkUser({ cpfCnpj: mkCpf() });
        const contract = await mkContract(client.id, { type: 'FIXO', paymentMethod: 'PIX', startDate: spDay(-20), endDate: spDay(64), fixedDayOfWeek: 1, fixedTime: '10:00' });
        await mkPayment(client.id, { contractId: contract.id, amount: 84000, status: 'PAID', paidAt: new Date(), dueDate: spDay(-20) });
        const p2 = await mkPayment(client.id, { contractId: contract.id, amount: 84000, dueDate: spDay(8) });
        const p3 = await mkPayment(client.id, { contractId: contract.id, amount: 84000, dueDate: spDay(36) });
        const req = await call('POST', `/api/contracts/${contract.id}/request-cancellation`, client);
        expect(req.status).toBe(200);
        expect((await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } })).status).toBe('PENDING_CANCELLATION');
        return { admin, client, contract, p2, p3 };
    }

    it('mensagem e código são os combinados', () => {
        expect(CANCELLATION_PENDING_MESSAGE).toBe(EXPECTED.error);
    });

    it('create-payment do CLIENTE (PIX e cartão) numa parcela do plano → 409, sem QR, sem PaymentIntent, linha intacta', async () => {
        const { client, p2 } = await requested();
        for (const paymentMethod of ['pix', 'cartao'] as const) {
            const r = await call('POST', '/api/stripe/create-payment', client, { paymentId: p2.id, paymentMethod, installments: 1 });
            expect(r.status).toBe(409);
            expect(r.body).toEqual(EXPECTED);
        }
        expect(createPix).not.toHaveBeenCalled();
        expect(createPI).not.toHaveBeenCalled();
        const p = await row(p2.id);
        expect(p).toMatchObject({ status: 'PENDING', amount: 84000, pixString: null, providerRef: null, chargedAmount: null });
    });

    it('parcela FAILED não é reaberta pelo cliente durante a análise', async () => {
        const { client, p3 } = await requested();
        await prisma.payment.update({ where: { id: p3.id }, data: { status: 'FAILED' } });
        const r = await call('POST', '/api/stripe/create-payment', client, { paymentId: p3.id, paymentMethod: 'pix' });
        expect(r.status).toBe(409);
        expect(r.body.code).toBe('CANCELLATION_PENDING');
        expect((await row(p3.id)).status).toBe('FAILED');
    });

    it('o ADMIN continua podendo cobrar a mesma parcela (PIX e cartão)', async () => {
        const { admin, p2, p3 } = await requested();
        const pix = await call('POST', '/api/stripe/create-payment', admin, { paymentId: p2.id, paymentMethod: 'pix' });
        expect(pix.status).toBe(200);
        expect(pix.body.pixString).toBeTruthy();
        expect(createPix.mock.calls[0]![0].amount).toBe(84000);
        const card = await call('POST', '/api/stripe/create-payment', admin, { paymentId: p3.id, paymentMethod: 'cartao', installments: 1 });
        expect(card.status).toBe(200);
        expect(createPI.mock.calls[0]![0].amount).toBe(84000);
    });

    it('extras de uma gravação (bookingId) seguem pagáveis pelo cliente', async () => {
        const { client, contract } = await requested();
        const booking = await mkBooking(client.id, contract.id, { date: spDay(-3), status: 'COMPLETED' });
        const extras = await mkPayment(client.id, { contractId: contract.id, bookingId: booking.id, amount: 5000, paymentUrl: JSON.stringify({ addonKeys: ['CORTES'] }) });
        const r = await call('POST', '/api/stripe/create-payment', client, { paymentId: extras.id, paymentMethod: 'pix' });
        expect(r.status).toBe(200);
        expect(createPix.mock.calls[0]![0].amount).toBe(5000);
    });

    it('a multa segue pagável: decidida "Cobrar multa", o cliente paga; as parcelas anuladas continuam recusadas', async () => {
        const { admin, client, contract, p2 } = await requested();
        const res = await call('POST', `/api/contracts/${contract.id}/resolve-cancellation`, admin, { action: 'CHARGE_FEE' });
        expect(res.status).toBe(200);
        expect(res.body.fine.amount).toBe(33600); // 20% de R$ 1.680 que faltavam
        const pay = await call('POST', '/api/stripe/create-payment', client, { paymentId: res.body.fine.id, paymentMethod: 'pix' });
        expect(pay.status).toBe(200);
        expect(createPix.mock.calls[0]![0].amount).toBe(33600);
        // A parcela foi anulada na decisão: o 400 de "cancelado" (regra anterior), não o 409 da análise.
        const old = await call('POST', '/api/stripe/create-payment', client, { paymentId: p2.id, paymentMethod: 'pix' });
        expect(old.status).toBe(400);
        expect(old.body.code).toBeUndefined();
    });

    it('regra pura: multa e extras nunca são bloqueados, mesmo com o contrato ainda em análise', () => {
        const contract = { status: 'PENDING_CANCELLATION' };
        expect(planPaymentBlockedByPendingCancellation({ contract, bookingId: null, metadata: null }, false)).toBe(true);
        expect(planPaymentBlockedByPendingCancellation({ contract, bookingId: null, metadata: null }, true)).toBe(false);
        expect(planPaymentBlockedByPendingCancellation({ contract, bookingId: 'b1', metadata: null }, false)).toBe(false);
        expect(planPaymentBlockedByPendingCancellation({ contract, bookingId: null, metadata: { kind: 'CANCELLATION_FINE' } }, false)).toBe(false);
        expect(planPaymentBlockedByPendingCancellation({ contract: { status: 'ACTIVE' }, bookingId: null, metadata: null }, false)).toBe(false);
        expect(planPaymentBlockedByPendingCancellation({ contract: null, bookingId: null, metadata: null }, false)).toBe(false);
    });

    it('pedido desfeito pelo admin (contrato reaberto) → o cliente volta a pagar', async () => {
        const { admin, client, contract, p2 } = await requested();
        expect((await call('PATCH', `/api/contracts/${contract.id}`, admin, { status: 'ACTIVE' })).status).toBe(200);
        const r = await call('POST', '/api/stripe/create-payment', client, { paymentId: p2.id, paymentMethod: 'pix' });
        expect(r.status).toBe(200);
        expect(createPix.mock.calls[0]![0].amount).toBe(84000);
    });

    it('installment-plans (só leitura) continua respondendo durante a análise', async () => {
        const { client, p2 } = await requested();
        const r = await call('POST', '/api/stripe/installment-plans', client, { paymentId: p2.id });
        expect(r.status).toBe(200);
        expect(r.body.cardAmount).toBe(84000);
    });

    it('POST /contracts/:id/pay → 409 para o dono; 404 para outro cliente e para os demais status', async () => {
        const { client, contract } = await requested();
        const r = await call('POST', `/api/contracts/${contract.id}/pay`, client, { paymentMethod: 'PIX' });
        expect(r.status).toBe(409);
        expect(r.body).toEqual(EXPECTED);
        expect(createPix).not.toHaveBeenCalled();
        expect(await prisma.payment.count({ where: { contractId: contract.id } })).toBe(3);

        const stranger = await mkUser({ cpfCnpj: mkCpf() });
        expect((await call('POST', `/api/contracts/${contract.id}/pay`, stranger, { paymentMethod: 'PIX' })).status).toBe(404);

        const active = await mkContract(client.id, { type: 'FIXO', paymentMethod: 'PIX' });
        expect((await call('POST', `/api/contracts/${active.id}/pay`, client, { paymentMethod: 'PIX' })).status).toBe(404);
    });
});

// ═══ 4) Desfazer "Iniciar gravação" ═══════════════════════════════════════════════════════════════
describe('PUT /bookings/:id/undo-start-recording — desfaz o início clicado por engano', () => {
    async function scene(bookingOver: Record<string, unknown> = {}) {
        const admin = await mkUser({ role: 'ADMIN', name: 'Operadora Ana' });
        const client = await mkUser();
        const contract = await mkContract(client.id, { type: 'FIXO', fixedDayOfWeek: 1, fixedTime: '10:00' });
        const booking = await mkBooking(client.id, contract.id, { date: spDay(0), status: 'CONFIRMED', ...bookingOver });
        return { admin, client, contract, booking };
    }
    const fresh = (id: string) => prisma.booking.findUniqueOrThrow({ where: { id } });
    const audits = (id: string) => prisma.auditLog.findMany({ where: { entityType: 'BOOKING', entityId: id, action: 'RECORDING_START_UNDONE' } });
    const liveForClient = async (client: Who, id: string) => (await call('GET', `/api/bookings/${id}`, client)).body.booking?.isRecordingNow;

    it('iniciar → desfazer: zera início/operador, grava auditoria e o cliente deixa de ver "AO VIVO"', async () => {
        const { admin, client, booking } = await scene();
        expect((await call('PUT', `/api/bookings/${booking.id}/start-recording`, admin)).status).toBe(200);
        const started = await fresh(booking.id);
        expect(started.recordingStartedAt).toBeInstanceOf(Date);
        expect(await liveForClient(client, booking.id)).toBe(true);

        const r = await call('PUT', `/api/bookings/${booking.id}/undo-start-recording`, admin);
        expect(r.status).toBe(200);
        expect(r.body.message).toBe('Início da gravação desfeito.');
        expect(r.body.booking).toMatchObject({ id: booking.id, status: 'CONFIRMED', recordingStartedAt: null, recordingStartedById: null, recordingStartedByName: null });
        const b = await fresh(booking.id);
        expect(b).toMatchObject({ status: 'CONFIRMED', recordingStartedAt: null, recordingStartedById: null, recordingStartedByName: null });
        expect(await liveForClient(client, booking.id)).toBe(false);
        const my = await call('GET', '/api/bookings/my', client);
        expect(my.body.bookings.find((x: any) => x.id === booking.id).isRecordingNow).toBe(false);

        const log = await audits(booking.id);
        expect(log).toHaveLength(1);
        expect(log[0]!.performedBy).toBe(admin.id);
        expect(JSON.parse(log[0]!.changes!)).toEqual({
            recordingStartedAt: started.recordingStartedAt!.toISOString(),
            recordingStartedById: admin.id,
            recordingStartedByName: 'Operadora Ana',
        });
    });

    it('depois de desfazer, finalizar volta a exigir "Iniciar gravação"; iniciar de novo registra o novo operador e finaliza', async () => {
        const { admin, booking } = await scene();
        await call('PUT', `/api/bookings/${booking.id}/start-recording`, admin);
        await call('PUT', `/api/bookings/${booking.id}/undo-start-recording`, admin);

        const early = await call('PUT', `/api/bookings/${booking.id}/complete`, admin, {});
        expect(early.status).toBe(400);
        expect((await fresh(booking.id)).status).toBe('CONFIRMED');

        const other = await mkUser({ role: 'ADMIN', name: 'Operador Beto' });
        expect((await call('PUT', `/api/bookings/${booking.id}/start-recording`, other)).status).toBe(200);
        expect(await fresh(booking.id)).toMatchObject({ recordingStartedById: other.id, recordingStartedByName: 'Operador Beto' });
        expect((await call('PUT', `/api/bookings/${booking.id}/complete`, other, {})).status).toBe(200);
        expect((await fresh(booking.id)).status).toBe('COMPLETED');
    });

    it('gravação não iniciada → 200 idempotente, nada gravado e sem auditoria', async () => {
        const { admin, booking } = await scene();
        const r = await call('PUT', `/api/bookings/${booking.id}/undo-start-recording`, admin);
        expect(r.status).toBe(200);
        expect(r.body.message).toBe('A gravação não estava iniciada.');
        expect(await audits(booking.id)).toHaveLength(0);
        // Dois cliques seguidos: o segundo também é 200 e a auditoria continua com UMA linha.
        await call('PUT', `/api/bookings/${booking.id}/start-recording`, admin);
        expect((await call('PUT', `/api/bookings/${booking.id}/undo-start-recording`, admin)).status).toBe(200);
        expect((await call('PUT', `/api/bookings/${booking.id}/undo-start-recording`, admin)).status).toBe(200);
        expect(await audits(booking.id)).toHaveLength(1);
    });

    it('gravação já FINALIZADA → 409 e o registro do início é preservado', async () => {
        const startedAt = new Date(Date.now() - 90 * 60_000);
        const { admin, booking } = await scene({ status: 'COMPLETED', recordingStartedAt: startedAt, recordingStartedByName: 'Operadora Ana', durationMinutes: 85 });
        const r = await call('PUT', `/api/bookings/${booking.id}/undo-start-recording`, admin);
        expect(r.status).toBe(409);
        expect(r.body.code).toBe('RECORDING_UNDO_NOT_ALLOWED');
        expect(r.body.error).toBe('Esta gravação já foi finalizada. O início não pode mais ser desfeito.');
        const b = await fresh(booking.id);
        expect(b.recordingStartedAt?.getTime()).toBe(startedAt.getTime());
        expect(b.recordingStartedByName).toBe('Operadora Ana');
        expect(b.durationMinutes).toBe(85);
        expect(await audits(booking.id)).toHaveLength(0);
    });

    it('outros status (RESERVED, CANCELLED, FALTA) → 409 com o status na mensagem', async () => {
        for (const status of ['RESERVED', 'CANCELLED', 'FALTA'] as const) {
            const { admin, booking } = await scene({ status, startTime: status === 'RESERVED' ? '10:00' : status === 'CANCELLED' ? '13:00' : '15:30', endTime: '17:30' });
            const r = await call('PUT', `/api/bookings/${booking.id}/undo-start-recording`, admin);
            expect(r.status).toBe(409);
            expect(r.body.code).toBe('RECORDING_UNDO_NOT_ALLOWED');
            expect(r.body.error).toContain(status);
        }
    });

    it('só admin: cliente dono → 403; sem login → 401; agendamento inexistente → 404', async () => {
        const { admin, client, booking } = await scene();
        await call('PUT', `/api/bookings/${booking.id}/start-recording`, admin);
        expect((await call('PUT', `/api/bookings/${booking.id}/undo-start-recording`, client)).status).toBe(403);
        expect((await call('PUT', `/api/bookings/${booking.id}/undo-start-recording`)).status).toBe(401);
        expect((await fresh(booking.id)).recordingStartedAt).toBeInstanceOf(Date);
        expect((await call('PUT', '/api/bookings/00000000-0000-4000-8000-000000000000/undo-start-recording', admin)).status).toBe(404);
    });
});

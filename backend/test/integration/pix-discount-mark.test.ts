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
import { cardChargeBaseAmount } from '../../src/lib/pixGateway';
import { runAutoChargeJob } from '../../src/jobs/autoChargeJob';
import { getConfig, invalidateConfigCache } from '../../src/lib/businessConfig';
import { getBasePriceDynamic, applyDiscount } from '../../src/utils/pricing';
import contractRoutes from '../../src/modules/contracts/routes';
import stripeRoutes from '../../src/modules/stripe/routes';
import userRoutes from '../../src/modules/users/routes';
import { mkUser, mkContract, mkPayment, mkBooking, mkCoupon } from './factories';

type Who = { id: string; email: string | null; role: string };

// pagamentos-3 / D1 (regra única, conservadora): o desconto PIX do à vista só é revertido no cartão pela
// marca metadata.pixDiscount gravada na CRIAÇÃO. Sem a marca, o cartão cobra o próprio amount — não há
// fallback legado, corte por data nem congelamento. Cobrança antiga sem a marca pode sair ABAIXO do preço
// de cartão, NUNCA acima. Valor zero (cupom 100% / VALOR ≥ total) nunca recebe marca nem vai ao cartão.
// A troca de forma pelo admin não altera valores.

const VALID_CPF = '52998224725';
const m = <T extends (...a: any[]) => any>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>;
const secondsAgo = (s: number) => new Date(Date.now() - s * 1000);
/** Linha ANTIGA (sem a marca, criada antes da regra): a data não influi mais no valor do cartão. */
const legacyAt = (day: number) => new Date(Date.UTC(2026, 8, day, 12, 0, 0));

let server: Server;
let base = '';

beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/contracts', contractRoutes);
    app.use('/api/stripe', stripeRoutes);
    app.use('/api/users', userRoutes);
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
    await enableMethods();
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

/** PIX (Sicoob sandbox), Cartão (Stripe) e Boleto habilitados, como no dev. */
async function enableMethods() {
    for (const [i, key] of ['PIX', 'CARTAO', 'BOLETO'].entries()) {
        await prisma.paymentMethodConfig.create({
            data: { key, label: key, shortLabel: key, emoji: '-', description: key, color: '#000000', active: true, sortOrder: i },
        });
    }
    await prisma.integrationConfig.create({ data: { provider: 'SICOOB', enabled: true, environment: 'sandbox', config: '{}' } });
    await prisma.integrationConfig.create({ data: { provider: 'STRIPE', enabled: true, environment: 'sandbox', config: '{}' } });
}

async function setPixPct(v: number) {
    await prisma.businessConfig.upsert({
        where: { key: 'pix_extra_discount_pct' },
        create: { key: 'pix_extra_discount_pct', value: String(v), type: 'percent', label: 'Desconto PIX', group: 'payments' } as any,
        update: { value: String(v) },
    });
    invalidateConfigCache();
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

/** Contrato FIXO pelo admin (POST /contracts) e a sua cobrança à vista. */
async function adminFixo(paymentMethod: 'PIX' | 'CARTAO' | 'BOLETO', over: Record<string, unknown> = {}) {
    const admin = await mkUser({ role: 'ADMIN' });
    const client = await mkUser();
    const r = await call('POST', '/api/contracts', admin, {
        userId: client.id, name: 'Fixo à vista', type: 'FIXO', tier: 'COMERCIAL', durationMonths: 3,
        startDate: nextWeekday(1, 2), fixedDayOfWeek: 1, fixedTime: '13:00', paymentPlan: 'FULL', paymentMethod, ...over,
    });
    expect(r.status).toBe(201);
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: r.body.firstPaymentId } });
    return { admin, client, contractId: r.body.contract.id as string, payment };
}

async function plan1x(who: { id: string; email: string | null; role: string }, paymentId: string): Promise<number> {
    const r = await call('POST', '/api/stripe/installment-plans', who, { paymentId });
    expect(r.status).toBe(200);
    expect(r.body.plans.map((p: any) => p.count)).toEqual([1]);
    return r.body.plans[0].total;
}

async function payByCard(who: { id: string; email: string | null; role: string }, paymentId: string) {
    m(stripe.stripeCreatePaymentIntent).mockClear();
    const r = await call('POST', '/api/stripe/create-payment', who, { paymentId, paymentMethod: 'cartao', installments: 1 });
    return { res: r, piAmount: m(stripe.stripeCreatePaymentIntent).mock.calls[0]?.[0]?.amount as number | undefined };
}

const pixDiscountOf = async (id: string) => ((await prisma.payment.findUniqueOrThrow({ where: { id } })).metadata as any)?.pixDiscount;

// ─── 1) Criação: toda cobrança com desconto PIX grava a marca (base do cartão) ───────────────────
describe('criação grava metadata.pixDiscount com a BASE do cartão (FULL + PIX)', () => {
    it('admin FIXO à vista + PIX: amount com desconto; marca { pct, cardAmount = total sem desconto, pixAmount }', async () => {
        const { client, payment } = await adminFixo('PIX');
        const { cardFull, pixFull, pct } = await fullTotals3m();
        expect(payment.amount).toBe(pixFull);
        expect((payment.metadata as any).pixDiscount).toEqual({ pct, cardAmount: cardFull, pixAmount: pixFull });
        expect(await plan1x(client, payment.id)).toBe(cardFull);
        const { res, piAmount } = await payByCard(client, payment.id);
        expect(res.status).toBe(200);
        expect(piAmount).toBe(cardFull);
        expect(res.body.amount).toBe(cardFull);
    });

    it('admin FLEX à vista + PIX com cupom: o cartão mantém o MESMO cupom em R$ (cardAmount = total − cupom)', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser();
        const coupon = await mkCoupon(admin.id, { discountValue: 10 });
        const r = await call('POST', '/api/contracts', admin, {
            userId: client.id, name: 'Flex à vista', type: 'FLEX', tier: 'COMERCIAL', durationMonths: 3,
            startDate: nextWeekday(1, 2), paymentPlan: 'FULL', paymentMethod: 'PIX', couponCode: coupon.code,
        });
        expect(r.status).toBe(201);
        const p = await prisma.payment.findUniqueOrThrow({ where: { id: r.body.firstPaymentId } });
        const { cardFull, pixFull, pct } = await fullTotals3m();
        expect(p.discountAmount).toBeGreaterThan(0);
        expect(p.amount).toBe(pixFull - p.discountAmount!);
        expect((p.metadata as any).pixDiscount).toEqual({ pct, cardAmount: cardFull - p.discountAmount!, pixAmount: p.amount });
        expect(await cardChargeBaseAmount(p)).toBe(cardFull - p.discountAmount!);
    });

    it('sem desconto PIX não há marca: FULL + CARTÃO e MENSAL + PIX cobram o próprio amount', async () => {
        const card = await adminFixo('CARTAO');
        expect(card.payment.metadata).toBeNull();
        expect(await plan1x(card.client, card.payment.id)).toBe(card.payment.amount);

        const monthly = await adminFixo('PIX', { paymentPlan: 'MONTHLY' });
        const rows = await prisma.payment.findMany({ where: { contractId: monthly.contractId } });
        expect(rows.length).toBe(3);
        expect(rows.every(r => r.metadata === null)).toBe(true);
        expect(await plan1x(monthly.client, monthly.payment.id)).toBe(monthly.payment.amount);
    });

    it('/self FLEX à vista + PIX: a marca viaja com o contractData (e o gateway preserva o metadata)', async () => {
        const client = await mkUser({ cpfCnpj: VALID_CPF });
        const r = await call('POST', '/api/contracts/self', client, {
            name: 'Flex', type: 'FLEX', tier: 'COMERCIAL', durationMonths: 3,
            firstBookingDate: nextWeekday(3, 3), firstBookingTime: '13:00', paymentMethod: 'PIX', paymentPlan: 'FULL',
        });
        expect(r.status).toBe(201);
        const p = await prisma.payment.findUniqueOrThrow({ where: { id: r.body.firstPaymentId } });
        const { cardFull, pixFull, pct } = await fullTotals3m();
        expect(p.amount).toBe(pixFull);
        const meta = p.metadata as any;
        expect(meta.pixDiscount).toEqual({ pct, cardAmount: cardFull, pixAmount: pixFull });
        expect(meta.contractData.paymentMethod).toBe('PIX');
        expect(meta.pixCharge.attempt).toBe(1);
        expect(await plan1x(client, p.id)).toBe(cardFull);
    });

    it('/custom (admin) à vista + PIX: semanal e datas livres gravam a base do cartão', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser();
        const weekly = await call('POST', '/api/contracts/custom', admin, {
            userId: client.id, name: 'Personalizado', tier: 'COMERCIAL', durationMonths: 3, paymentMethod: 'PIX', paymentPlan: 'FULL',
            schedule: [{ day: 2, time: '10:00' }], startDate: nextWeekday(2, 2),
        });
        expect(weekly.status).toBe(201);
        const pw = await prisma.payment.findUniqueOrThrow({ where: { id: weekly.body.firstPaymentId } });
        const pct = Number(await getConfig('pix_extra_discount_pct'));
        const cardW = weekly.body.summary.cycleAmount * 3;
        expect(pw.amount).toBe(Math.round(cardW * (1 - pct / 100)));
        expect((pw.metadata as any).pixDiscount).toEqual({ pct, cardAmount: cardW, pixAmount: pw.amount });

        const d1 = nextWeekday(3, 20);
        const d2 = nextWeekday(4, 20);
        const d3 = nextWeekday(5, 20);
        const free = await call('POST', '/api/contracts/custom', admin, {
            userId: client.id, name: 'Datas livres', tier: 'COMERCIAL', durationMonths: 1, paymentMethod: 'PIX', paymentPlan: 'FULL',
            frequency: 'CUSTOM', schedule: [], customDates: [{ date: d1, time: '10:00' }, { date: d2, time: '10:00' }, { date: d3, time: '10:00' }],
            startDate: nextWeekday(1, 2),
        });
        expect(free.status).toBe(201);
        const pf = await prisma.payment.findUniqueOrThrow({ where: { id: free.body.firstPaymentId } });
        const exact = 3 * applyDiscount(await getBasePriceDynamic('COMERCIAL'), free.body.summary.discountPct);
        expect(pf.amount).toBe(Math.round(exact * (1 - pct / 100)));
        expect((pf.metadata as any).pixDiscount).toEqual({ pct, cardAmount: exact, pixAmount: pf.amount });
        expect(await cardChargeBaseAmount(pf)).toBe(exact);
    });

    it('serviço à vista + PIX pago pelo /contracts/:id/pay (renovação): a linha nova nasce marcada', async () => {
        await prisma.addOnConfig.create({ data: { key: 'GESTAO_TRAFEGO', name: 'Gestão de Tráfego', price: 150000, monthly: true, plansAllowed: 'FULL,MONTHLY', durationsOffered: '3,6' } });
        const client = await mkUser({ cpfCnpj: VALID_CPF });
        const c = await mkContract(client.id, {
            type: 'SERVICO', paymentPlan: 'FULL', paymentMethod: 'PIX', status: 'AWAITING_PAYMENT', durationMonths: 3, discountPct: 0,
            paymentDeadline: new Date(Date.now() + 3 * 86_400_000), addOns: ['GESTAO_TRAFEGO'],
        });
        const r = await call('POST', `/api/contracts/${c.id}/pay`, client, { paymentMethod: 'PIX' });
        expect(r.status).toBe(200);
        const p = await prisma.payment.findUniqueOrThrow({ where: { id: r.body.paymentId } });
        const pct = Number(await getConfig('pix_extra_discount_pct'));
        expect(p.amount).toBe(Math.round(450000 * (1 - pct / 100)));
        expect((p.metadata as any).pixDiscount).toEqual({ pct, cardAmount: 450000, pixAmount: p.amount });
        expect((p.metadata as any).pixCharge?.attempt).toBe(1);
    });
});

// ─── 2) PROBE 1: troca da forma de pagamento pelo admin nunca infla o cartão ──────────────────────
describe('PROBE 1 — admin troca a forma de pagamento (PATCH /contracts/:id): valores não mudam e o cartão nunca cobra a mais', () => {
    it('CARTÃO → PIX: a cobrança à vista (sem desconto) continua saindo pelo amount em plans, create-payment e autoCharge', async () => {
        const { admin, client, contractId, payment } = await adminFixo('CARTAO');
        const patch = await call('PATCH', `/api/contracts/${contractId}`, admin, { paymentMethod: 'PIX' });
        expect(patch.status).toBe(200);
        const after = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
        expect(after.amount).toBe(payment.amount);
        expect(await plan1x(client, payment.id)).toBe(payment.amount);

        const { res, piAmount } = await payByCard(client, payment.id);
        expect(res.status).toBe(200);
        expect(piAmount).toBe(payment.amount);
        expect(res.body.amount).toBe(payment.amount);
        expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).chargedAmount).toBe(payment.amount);
    });

    it('BOLETO → PIX: idem (a linha Cora sem QR não vira "PIX")', async () => {
        const { admin, client, contractId, payment } = await adminFixo('BOLETO');
        expect(payment.provider).toBe('CORA');
        expect((await call('PATCH', `/api/contracts/${contractId}`, admin, { paymentMethod: 'PIX' })).status).toBe(200);
        expect(await plan1x(client, payment.id)).toBe(payment.amount);
    });

    it('autoCharge de um FULL já editado para PIX cuja cobrança nasceu no cartão → cobra o amount', async () => {
        const u = await mkUser({ autoChargeEnabled: true, stripeCustomerId: 'cus_test' });
        await prisma.savedPaymentMethod.create({ data: { userId: u.id, stripePaymentMethodId: 'pm_mark_1', brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030, isDefault: true } });
        const c = await mkContract(u.id, { type: 'FIXO', paymentPlan: 'FULL', paymentMethod: 'PIX' });
        const p = await mkPayment(u.id, { contractId: c.id, provider: 'STRIPE', amount: 315000, dueDate: secondsAgo(60) });
        m(stripe.stripeChargeOffSession).mockImplementation(async (_c: string, _pm: string, _amt: number, meta: { paymentId: string }) =>
            ({ clientSecret: '', paymentIntentId: `pi_auto_${meta.paymentId.slice(0, 6)}`, status: 'succeeded' }));
        await runAutoChargeJob();
        expect(m(stripe.stripeChargeOffSession).mock.calls[0]?.[2]).toBe(315000);
        expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).chargedAmount).toBe(315000);
    });

    it('PIX → CARTÃO (linha nova, marcada): o cartão cobra a base marcada; o amount (PIX) não muda', async () => {
        const { admin, client, contractId, payment } = await adminFixo('PIX');
        const { cardFull, pixFull } = await fullTotals3m();
        expect((await call('PATCH', `/api/contracts/${contractId}`, admin, { paymentMethod: 'CARTAO' })).status).toBe(200);
        expect(await plan1x(client, payment.id)).toBe(cardFull);
        const { res, piAmount } = await payByCard(client, payment.id);
        expect(res.status).toBe(200);
        expect(piAmount).toBe(cardFull);
        const row = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
        expect(row.amount).toBe(pixFull);
        expect(row.chargedAmount).toBe(cardFull);
    });

    it('a troca de forma NÃO grava nada nas cobranças (nem marca, nem amount, nem provider) — marcadas ou não', async () => {
        const { admin, contractId, payment } = await adminFixo('PIX');
        const u = await mkUser();
        const c2 = await mkContract(u.id, { type: 'FIXO', paymentPlan: 'FULL', paymentMethod: 'PIX' });
        const old = await mkPayment(u.id, { contractId: c2.id, provider: 'SICOOB', amount: 283500, createdAt: legacyAt(2) });
        const snap = async (id: string) => {
            const r = await prisma.payment.findUniqueOrThrow({ where: { id } });
            return { amount: r.amount, metadata: r.metadata, provider: r.provider, chargedAmount: r.chargedAmount, updatedAt: r.updatedAt.getTime() };
        };
        const before = [await snap(payment.id), await snap(old.id)];
        for (const method of ['CARTAO', 'BOLETO', 'PIX'] as const) {
            expect((await call('PATCH', `/api/contracts/${contractId}`, admin, { paymentMethod: method })).status).toBe(200);
            expect((await call('PATCH', `/api/contracts/${c2.id}`, admin, { paymentMethod: method })).status).toBe(200);
        }
        expect([await snap(payment.id), await snap(old.id)]).toEqual(before);
    });

    it('linha antiga FULL + PIX sem a marca, PIX → CARTÃO: nada é congelado; o cartão cobra o próprio amount (conservador)', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const u = await mkUser();
        const c = await mkContract(u.id, { type: 'FIXO', paymentPlan: 'FULL', paymentMethod: 'PIX' });
        const p = await mkPayment(u.id, { contractId: c.id, provider: 'SICOOB', amount: 283500, dueDate: secondsAgo(60), createdAt: legacyAt(2) });
        expect((await call('PATCH', `/api/contracts/${c.id}`, admin, { paymentMethod: 'CARTAO' })).status).toBe(200);
        expect(await pixDiscountOf(p.id)).toBeUndefined();
        // Decisão conservadora: sem a marca, o valor do cartão é o gravado (abaixo do preço de cartão, nunca acima).
        expect(await plan1x(u, p.id)).toBe(283500);
        const { res, piAmount } = await payByCard(u, p.id);
        expect(res.status).toBe(200);
        expect(piAmount).toBe(283500);
        expect(res.body.amount).toBe(283500);
        const row = await prisma.payment.findUniqueOrThrow({ where: { id: p.id } });
        expect(row.amount).toBe(283500);
        expect(row.chargedAmount).toBe(283500);
        expect((row.metadata as any)?.pixDiscount).toBeUndefined();
    });

    it('linha antiga no cartão com o contrato trocado para PIX: nem um QR PIX gerado depois faz o cartão inflar', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const u = await mkUser();
        const c = await mkContract(u.id, { type: 'FIXO', paymentPlan: 'FULL', paymentMethod: 'CARTAO' });
        const p = await mkPayment(u.id, { contractId: c.id, provider: 'STRIPE', amount: 315000, dueDate: secondsAgo(60), createdAt: legacyAt(2) });
        expect((await call('PATCH', `/api/contracts/${c.id}`, admin, { paymentMethod: 'PIX' })).status).toBe(200);
        expect(await pixDiscountOf(p.id)).toBeUndefined();
        // O cliente abre a aba PIX (a linha ganha provider SICOOB, BR Code e pixCharge) e volta ao cartão.
        await prisma.payment.update({
            where: { id: p.id },
            data: { provider: 'SICOOB', providerRef: 'a'.repeat(32), pixString: 'x', metadata: { pixCharge: { attempt: 1, amount: 315000 } } },
        });
        expect(await plan1x(u, p.id)).toBe(315000);
    });

    it('linha antiga com a forma trocada ANTES da correção (contrato PIX, linha criada no cartão/boleto) → nunca infla, nada é gravado', async () => {
        const u = await mkUser();
        const c = await mkContract(u.id, { type: 'FIXO', paymentPlan: 'FULL', paymentMethod: 'PIX' });
        const p = await mkPayment(u.id, { contractId: c.id, provider: 'STRIPE', amount: 315000, createdAt: legacyAt(3) });
        expect(await cardChargeBaseAmount({ ...p })).toBe(315000);
        expect(await plan1x(u, p.id)).toBe(315000);
        expect(await pixDiscountOf(p.id)).toBeUndefined();
        // Boleto (Cora sem QR) idem.
        const c2 = await mkContract(u.id, { type: 'FIXO', paymentPlan: 'FULL', paymentMethod: 'PIX' });
        const p2 = await mkPayment(u.id, { contractId: c2.id, provider: 'CORA', amount: 315000, boletoUrl: 'https://b', createdAt: legacyAt(3) });
        expect(await cardChargeBaseAmount({ ...p2 })).toBe(315000);
        expect(await pixDiscountOf(p2.id)).toBeUndefined();
    });
});

// ─── 3) PROBE 2: mudar o % do PIX depois não altera a cobrança ────────────────────────────────────
describe('PROBE 2 — mudar pix_extra_discount_pct depois da criação não altera o valor do cartão', () => {
    it('linha nova: a marca vale (5% ou 15% depois → a mesma base)', async () => {
        const { client, payment } = await adminFixo('PIX');
        const { cardFull } = await fullTotals3m();
        for (const pct of [5, 15, 0]) {
            await setPixPct(pct);
            expect(await plan1x(client, payment.id)).toBe(cardFull);
        }
        const { piAmount } = await payByCard(client, payment.id);
        expect(piAmount).toBe(cardFull);
    });

    it('linha nova com cupom: a base marcada (total − o mesmo cupom em R$) também não muda com o %', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser();
        const coupon = await mkCoupon(admin.id, { discountType: 'VALOR', discountValue: 10000 });
        const r = await call('POST', '/api/contracts', admin, {
            userId: client.id, name: 'Fixo cupom', type: 'FIXO', tier: 'COMERCIAL', durationMonths: 3, startDate: nextWeekday(1, 2),
            fixedDayOfWeek: 1, fixedTime: '13:00', paymentPlan: 'FULL', paymentMethod: 'PIX', couponCode: coupon.code,
        });
        expect(r.status).toBe(201);
        const p = await prisma.payment.findUniqueOrThrow({ where: { id: r.body.firstPaymentId } });
        const { cardFull, pixFull } = await fullTotals3m();
        expect(p.amount).toBe(pixFull - 10000);
        for (const pct of [15, 0, 10]) {
            await setPixPct(pct);
            expect(await plan1x(client, p.id)).toBe(cardFull - 10000);
        }
    });

    it('linha antiga sem a marca: o valor do cartão é o amount com qualquer % (e com a troca de provider); nada é gravado', async () => {
        const u = await mkUser();
        const c = await mkContract(u.id, { type: 'FIXO', paymentPlan: 'FULL', paymentMethod: 'PIX' });
        const p = await mkPayment(u.id, { contractId: c.id, provider: 'SICOOB', amount: 283500, dueDate: secondsAgo(60), createdAt: legacyAt(4) });
        expect(await plan1x(u, p.id)).toBe(283500);
        await setPixPct(15);
        await prisma.payment.update({ where: { id: p.id }, data: { provider: 'STRIPE', providerRef: 'pi_attempt_1', pixString: null } });
        expect(await plan1x(u, p.id)).toBe(283500);
        expect(await pixDiscountOf(p.id)).toBeUndefined();
        // Com cupom: o amount gravado (já com o cupom), sem reverter o % nem reaplicar o cupom.
        const c2 = await mkContract(u.id, { type: 'FIXO', paymentPlan: 'FULL', paymentMethod: 'PIX' });
        const p2 = await mkPayment(u.id, { contractId: c2.id, provider: 'SICOOB', amount: 273500, discountAmount: 10000, createdAt: legacyAt(4) });
        for (const pct of [10, 5]) {
            await setPixPct(pct);
            expect(await cardChargeBaseAmount({ ...p2 })).toBe(273500);
            expect(await plan1x(u, p2.id)).toBe(273500);
        }
        expect(await pixDiscountOf(p2.id)).toBeUndefined();
    });

    it('/self sem a marca (contrato só no contractData), antigo ou novo → o próprio amount; o contractData fica intacto', async () => {
        const u = await mkUser();
        const legacy = await mkPayment(u.id, { amount: 283500, createdAt: legacyAt(5), metadata: { contractData: { type: 'FIXO', paymentPlan: 'FULL', paymentMethod: 'PIX' } } });
        expect(await plan1x(u, legacy.id)).toBe(283500);
        expect(await pixDiscountOf(legacy.id)).toBeUndefined();
        expect(((await prisma.payment.findUniqueOrThrow({ where: { id: legacy.id } })).metadata as any).contractData.type).toBe('FIXO');
        const fresh = await mkPayment(u.id, { amount: 283500, metadata: { contractData: { type: 'FIXO', paymentPlan: 'FULL', paymentMethod: 'PIX' } } });
        expect(await plan1x(u, fresh.id)).toBe(283500);
    });
});

// ─── 4) Extras e multa nunca inflam ───────────────────────────────────────────────────────────────
describe('extras e multa de um FULL + PIX nunca inflam no cartão', () => {
    it('extras da gravação e a multa gerada pelo resolve-cancellation saem pelo próprio amount', async () => {
        const { admin, client, contractId, payment } = await adminFixo('PIX');
        const booking = await prisma.booking.findFirstOrThrow({ where: { contractId } });
        const extras = await mkPayment(client.id, { contractId, bookingId: booking.id, provider: 'SICOOB', amount: 5000, dueDate: secondsAgo(60) });
        expect(await plan1x(client, extras.id)).toBe(5000);

        await prisma.payment.update({ where: { id: payment.id }, data: { status: 'PAID', paidAt: new Date() } });
        expect((await call('POST', `/api/contracts/${contractId}/request-cancellation`, client)).status).toBe(200);
        const resolved = await call('POST', `/api/contracts/${contractId}/resolve-cancellation`, admin, { action: 'CHARGE_FEE' });
        expect(resolved.status).toBe(200);
        const fine = await prisma.payment.findFirstOrThrow({ where: { contractId, status: 'PENDING', bookingId: null } });
        const finePct = await getConfig('cancellation_fine_pct');
        // Base da multa = soma do amount das cobranças PAGAS (o CancelContractModal mostra a mesma conta).
        expect(fine.amount).toBe(Math.round(payment.amount * finePct / 100));
        expect(fine.metadata).toBeNull();
        expect(await plan1x(client, fine.id)).toBe(fine.amount);
        const { piAmount } = await payByCard(client, fine.id);
        expect(piAmount).toBe(fine.amount);
    });

    it('linhas antigas sem a marca (original, extras e multa) → o próprio amount; nada é gravado', async () => {
        const u = await mkUser();
        const c = await mkContract(u.id, { type: 'FIXO', paymentPlan: 'FULL', paymentMethod: 'PIX' });
        const original = await mkPayment(u.id, { contractId: c.id, amount: 283500, createdAt: legacyAt(1) });
        const b = await mkBooking(u.id, c.id);
        const extras = await mkPayment(u.id, { contractId: c.id, bookingId: b.id, amount: 5000, createdAt: legacyAt(10) });
        const fine = await mkPayment(u.id, { contractId: c.id, amount: 56700, createdAt: legacyAt(20) });
        expect(await cardChargeBaseAmount({ ...original })).toBe(283500);
        expect(await cardChargeBaseAmount({ ...extras })).toBe(5000);
        expect(await cardChargeBaseAmount({ ...fine })).toBe(56700);
        for (const p of [original, extras, fine]) expect(await pixDiscountOf(p.id)).toBeUndefined();
    });
});

// ─── 5) PaymentIntent antigo com outro valor é cancelado; em andamento bloqueia ───────────────────
describe('create-payment / pay: PI anterior da cobrança', () => {
    async function markedRowWithOldPi(over: Record<string, unknown> = {}) {
        const u = await mkUser();
        const c = await mkContract(u.id, { type: 'FIXO', paymentPlan: 'FULL', paymentMethod: 'PIX' });
        const p = await mkPayment(u.id, {
            contractId: c.id, provider: 'STRIPE', providerRef: 'pi_old_1', amount: 283500, chargedAmount: 283500, dueDate: secondsAgo(60),
            metadata: { pixDiscount: { pct: 10, cardAmount: 315000, pixAmount: 283500 } }, ...over,
        });
        return { u, c, p };
    }

    it('PI pagável com o valor ANTIGO → cancelado antes de criar o novo (315000)', async () => {
        const { u, p } = await markedRowWithOldPi();
        m(stripe.stripeGetPaymentIntent).mockResolvedValue({ id: 'pi_old_1', status: 'requires_payment_method', amount: 283500, client_secret: 'cs_old' });
        const { res, piAmount } = await payByCard(u, p.id);
        expect(res.status).toBe(200);
        expect(stripe.stripeCancelPaymentIntent).toHaveBeenCalledWith('pi_old_1');
        expect(piAmount).toBe(315000);
        const row = await prisma.payment.findUniqueOrThrow({ where: { id: p.id } });
        expect(row.providerRef).toBe(res.body.paymentIntentId);
        expect(row.chargedAmount).toBe(315000);
    });

    it('PI aprovado ou processando → 409 e NENHUM PI novo; mesmo valor → sem cancelar', async () => {
        const { u, p } = await markedRowWithOldPi();
        for (const status of ['succeeded', 'processing']) {
            m(stripe.stripeGetPaymentIntent).mockResolvedValue({ id: 'pi_old_1', status, amount: 283500 });
            const { res } = await payByCard(u, p.id);
            expect(res.status).toBe(409);
            expect(res.body.code).toBe('CARD_PAYMENT_IN_FLIGHT');
            expect(stripe.stripeCreatePaymentIntent).not.toHaveBeenCalled();
        }
        expect(stripe.stripeCancelPaymentIntent).not.toHaveBeenCalled();

        m(stripe.stripeGetPaymentIntent).mockResolvedValue({ id: 'pi_old_1', status: 'requires_payment_method', amount: 315000, client_secret: 'cs_same' });
        const same = await payByCard(u, p.id);
        expect(same.res.status).toBe(200);
        expect(same.piAmount).toBe(315000);
        expect(stripe.stripeCancelPaymentIntent).not.toHaveBeenCalled();
    });

    it('falha ao consultar o PI anterior → 503 sem PI novo; PI inexistente (resource_missing) → segue', async () => {
        const { u, p } = await markedRowWithOldPi();
        m(stripe.stripeGetPaymentIntent).mockRejectedValueOnce(Object.assign(new Error('connection reset'), { type: 'StripeConnectionError' }));
        const down = await payByCard(u, p.id);
        expect(down.res.status).toBe(503);
        expect(stripe.stripeCreatePaymentIntent).not.toHaveBeenCalled();

        m(stripe.stripeGetPaymentIntent).mockRejectedValueOnce(Object.assign(new Error('No such payment_intent'), { code: 'resource_missing', statusCode: 404 }));
        const missing = await payByCard(u, p.id);
        expect(missing.res.status).toBe(200);
        expect(missing.piAmount).toBe(315000);
    });

    it('cobrança FAILED reaberta com o PI recusado de outro valor → o PI antigo é cancelado antes', async () => {
        const { u, p } = await markedRowWithOldPi({ status: 'FAILED', providerRef: 'pi_declined_1' });
        m(stripe.stripeGetPaymentIntent).mockResolvedValue({ id: 'pi_declined_1', status: 'requires_payment_method', amount: 283500 });
        const { res, piAmount } = await payByCard(u, p.id);
        expect(res.status).toBe(200);
        expect(stripe.stripeCancelPaymentIntent).toHaveBeenCalledWith('pi_declined_1');
        expect(piAmount).toBe(315000);
    });

    it('/contracts/:id/pay: PI aprovado → 409 (sem PI novo); PI com o valor antigo → cancelado e recriado', async () => {
        const u = await mkUser();
        const c = await mkContract(u.id, { type: 'SERVICO', paymentPlan: 'FULL', paymentMethod: 'PIX', status: 'AWAITING_PAYMENT', paymentDeadline: new Date(Date.now() + 600_000), addOns: [] });
        const p = await mkPayment(u.id, {
            contractId: c.id, provider: 'STRIPE', providerRef: 'pi_pay_1', amount: 283500, chargedAmount: 283500,
            metadata: { pixDiscount: { pct: 10, cardAmount: 315000, pixAmount: 283500 } },
        });
        m(stripe.stripeGetPaymentIntent).mockResolvedValue({ id: 'pi_pay_1', status: 'succeeded', amount: 283500 });
        const blocked = await call('POST', `/api/contracts/${c.id}/pay`, u, { paymentMethod: 'CARTAO' });
        expect(blocked.status).toBe(409);
        expect(stripe.stripeCreatePaymentIntent).not.toHaveBeenCalled();

        m(stripe.stripeGetPaymentIntent).mockResolvedValue({ id: 'pi_pay_1', status: 'requires_action', amount: 283500 });
        const ok = await call('POST', `/api/contracts/${c.id}/pay`, u, { paymentMethod: 'CARTAO' });
        expect(ok.status).toBe(200);
        expect(stripe.stripeCancelPaymentIntent).toHaveBeenCalledWith('pi_pay_1');
        expect(m(stripe.stripeCreatePaymentIntent).mock.calls[0]![0].amount).toBe(315000);
        expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).chargedAmount).toBe(315000);
    });
});

// ─── 6) "Pago" pelo valor efetivamente cobrado (listas do admin, exclusão, Meus Pagamentos) ───────
describe('somas de pago pelo valor cobrado (chargedAmount só quando a cobrança paga foi a do cartão)', () => {
    async function client3() {
        const admin = await mkUser({ role: 'ADMIN' });
        const u = await mkUser();
        const c = await mkContract(u.id, { type: 'FIXO', paymentPlan: 'FULL', paymentMethod: 'PIX' });
        await mkPayment(u.id, { contractId: c.id, provider: 'STRIPE', providerRef: 'pi_paid_1', amount: 283500, chargedAmount: 315000, status: 'PAID', paidAt: new Date() });
        await mkPayment(u.id, { contractId: c.id, provider: 'SICOOB', providerRef: 'b'.repeat(32), amount: 84000, chargedAmount: 99999, status: 'PAID', paidAt: new Date() });
        await mkPayment(u.id, { contractId: c.id, provider: 'STRIPE', amount: 50000, chargedAmount: 55000, status: 'PENDING' });
        return { admin, u, c };
    }

    it('GET /users: totalPaid = 315000 + 84000; totalPending = 50000 (amount)', async () => {
        const { admin, u } = await client3();
        const r = await call('GET', '/api/users', admin);
        expect(r.status).toBe(200);
        const row = r.body.users.find((x: any) => x.id === u.id);
        expect(row.totalPaid).toBe(315000 + 84000);
        expect(row.totalPending).toBe(50000);
        expect(row.payments).toBeUndefined();
    });

    it('GET /users/:id traz chargedAmount/provider/providerRef; a prévia da exclusão soma o pago pelo valor cobrado', async () => {
        const { admin, u } = await client3();
        const detail = await call('GET', `/api/users/${u.id}`, admin);
        const paid = detail.body.user.payments.find((p: any) => p.providerRef === 'pi_paid_1');
        expect(paid).toMatchObject({ amount: 283500, chargedAmount: 315000, provider: 'STRIPE' });
        const preview = await call('GET', `/api/users/${u.id}/deletion-preview`, admin);
        expect(preview.status).toBe(200);
        expect(preview.body.preview.preserved).toEqual({ paidPayments: 2, paidAmount: 315000 + 84000 });
    });

    it('GET /contracts/my traz chargedAmount/providerRef (Meus Pagamentos soma o total pago pelo valor cobrado)', async () => {
        const { u } = await client3();
        const r = await call('GET', '/api/contracts/my', u);
        expect(r.status).toBe(200);
        const pays = r.body.contracts[0].payments;
        expect(pays.find((p: any) => p.providerRef === 'pi_paid_1')?.chargedAmount).toBe(315000);
    });
});

// ─── 7) Cupom que zera a cobrança (100% / VALOR ≥ total) no POST /contracts do admin ─────────────
describe('admin POST /contracts FULL + PIX com cupom que zera a cobrança → PAID na hora, sem marca, nada vai ao gateway', () => {
    async function adminWithZeroCoupon(type: 'FIXO' | 'FLEX', coupon: Record<string, unknown>, over: Record<string, unknown> = {}) {
        const admin = await mkUser({ role: 'ADMIN' });
        // Cliente com cobrança automática e cartão salvo: se alguma linha ficasse cobrável, o autoCharge a pegaria.
        const client = await mkUser({ autoChargeEnabled: true, stripeCustomerId: 'cus_test' });
        await prisma.savedPaymentMethod.create({
            data: { userId: client.id, stripePaymentMethodId: `pm_zero_${type}`, brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030, isDefault: true },
        });
        const cp = await mkCoupon(admin.id, coupon);
        const r = await call('POST', '/api/contracts', admin, {
            userId: client.id, name: 'Cortesia', type, tier: 'COMERCIAL', durationMonths: 3, startDate: nextWeekday(1, 2),
            ...(type === 'FIXO' ? { fixedDayOfWeek: 1, fixedTime: '13:00' } : {}),
            paymentPlan: 'FULL', paymentMethod: 'PIX', couponCode: cp.code, ...over,
        });
        expect(r.status).toBe(201);
        const rows = await prisma.payment.findMany({ where: { contractId: r.body.contract.id }, orderBy: { dueDate: 'asc' } });
        return { admin, client, coupon: cp, contractId: r.body.contract.id as string, res: r, rows };
    }

    /** installment-plans, create-payment (cartão e PIX) e autoCharge: nenhuma cobrança sai. */
    async function expectNothingCharged(client: Who, rows: { id: string }[]) {
        for (const p of rows) {
            const plans = await call('POST', '/api/stripe/installment-plans', client, { paymentId: p.id });
            expect(plans.status).toBe(400);
            expect(plans.body.plans).toBeUndefined();
            for (const paymentMethod of ['cartao', 'pix'] as const) {
                const r = await call('POST', '/api/stripe/create-payment', client, { paymentId: p.id, paymentMethod, installments: 1 });
                expect(r.status).toBe(400);
            }
        }
        await runAutoChargeJob();
        expect(stripe.stripeChargeOffSession).not.toHaveBeenCalled();
        expect(stripe.stripeCreatePaymentIntent).not.toHaveBeenCalled();
        expect(sicoob.sicoobCreatePix).not.toHaveBeenCalled();
        for (const p of rows) {
            const row = await prisma.payment.findUniqueOrThrow({ where: { id: p.id } });
            expect(row.status).toBe('PAID');
            expect(row.chargedAmount).toBeNull();
            expect(row.providerRef).toBeNull();
        }
    }

    it('FIXO + cupom 100%: a parcela única nasce PAID (R$ 0, sem marca), efeitos de confirmação rodam e o contrato segue ativo', async () => {
        const { client, coupon, contractId, res, rows } = await adminWithZeroCoupon('FIXO', { discountType: 'PERCENTUAL', discountValue: 100 });
        const { pixFull } = await fullTotals3m();
        expect(rows.length).toBe(1);
        const [p] = rows;
        expect(p!.amount).toBe(0);
        expect(p!.discountAmount).toBe(pixFull);
        expect(p!.status).toBe('PAID');
        expect(p!.paidAt).toBeInstanceOf(Date);
        expect(p!.metadata).toBeNull(); // sem marca: o cupom 100% não vira "base do cartão" de R$ 315
        expect(res.body.payments.map((x: any) => [x.amount, x.status])).toEqual([[0, 'PAID']]);
        expect(res.body.firstPaymentId).toBe(p!.id);

        // Efeitos de confirmação (onPaymentConfirmed): o uso do cupom é CONFIRMADO; contrato ativo; as sessões
        // do FIXO continuam as da criação (a geração da renovação não duplica).
        const redemption = await prisma.couponRedemption.findFirstOrThrow({ where: { paymentId: p!.id } });
        expect(redemption.status).toBe('CONFIRMED');
        expect((await prisma.coupon.findUniqueOrThrow({ where: { id: coupon.id } })).usedCount).toBe(1);
        expect((await prisma.contract.findUniqueOrThrow({ where: { id: contractId } })).status).toBe('ACTIVE');
        const bookings = await prisma.booking.findMany({ where: { contractId } });
        expect(bookings.length).toBe(3 * Number(await getConfig('sessions_per_month')));
        expect(new Set(bookings.map(b => `${b.date.toISOString()} ${b.startTime}`)).size).toBe(bookings.length);

        await expectNothingCharged(client, rows);
    });

    it('FLEX + cupom VALOR ≥ total: idem (desconto limitado ao valor da cobrança), créditos intactos', async () => {
        const { client, contractId, rows } = await adminWithZeroCoupon('FLEX', { discountType: 'VALOR', discountValue: 10_000_000 });
        const { pixFull } = await fullTotals3m();
        expect(rows.length).toBe(1);
        expect(rows[0]).toMatchObject({ amount: 0, discountAmount: pixFull, status: 'PAID', metadata: null });
        expect((await prisma.couponRedemption.findFirstOrThrow({ where: { paymentId: rows[0]!.id } })).status).toBe('CONFIRMED');
        const c = await prisma.contract.findUniqueOrThrow({ where: { id: contractId } });
        expect(c.status).toBe('ACTIVE');
        expect(c.flexCreditsRemaining).toBe(c.flexCreditsTotal);

        await expectNothingCharged(client, rows);
    });

    it('cupom VALOR exatamente igual ao total PIX: R$ 0, PAID, sem marca (o cartão nunca cobraria a diferença do desconto PIX)', async () => {
        const { pixFull } = await fullTotals3m();
        const { client, rows } = await adminWithZeroCoupon('FIXO', { discountType: 'VALOR', discountValue: pixFull });
        expect(rows[0]).toMatchObject({ amount: 0, discountAmount: pixFull, status: 'PAID', metadata: null });
        expect(await cardChargeBaseAmount(rows[0]!)).toBe(0);
        await expectNothingCharged(client, rows);
    });

    it('MENSAL + PIX com cupom 100% em TODAS as parcelas: as 3 nascem PAID (sem marca) e nada é cobrado', async () => {
        const { client, rows } = await adminWithZeroCoupon('FLEX', { discountType: 'PERCENTUAL', discountValue: 100, scope: 'ALL_INSTALLMENTS' }, { paymentPlan: 'MONTHLY' });
        expect(rows.length).toBe(3);
        expect(rows.every(r => r.amount === 0 && r.status === 'PAID' && r.metadata === null && r.paidAt)).toBe(true);
        await expectNothingCharged(client, rows);
    });

    it('cupom 100% só na 1ª parcela (MENSAL): a 1ª nasce PAID; as demais seguem PENDING pelo valor cheio', async () => {
        const { rows } = await adminWithZeroCoupon('FLEX', { discountType: 'PERCENTUAL', discountValue: 100, scope: 'FIRST_PAYMENT' }, { paymentPlan: 'MONTHLY' });
        expect(rows.length).toBe(3);
        expect(rows[0]).toMatchObject({ amount: 0, status: 'PAID', metadata: null });
        expect(rows.slice(1).every(r => r.status === 'PENDING' && r.amount > 0 && r.metadata === null)).toBe(true);
    });

    it('linha de R$ 0 criada ANTES da correção (PENDING, com a marca de R$ 315): installment-plans não oferece nada', async () => {
        const u = await mkUser();
        const c = await mkContract(u.id, { type: 'FIXO', paymentPlan: 'FULL', paymentMethod: 'PIX' });
        const p = await mkPayment(u.id, {
            contractId: c.id, amount: 0, discountAmount: 283500, createdAt: legacyAt(10),
            metadata: { pixDiscount: { pct: 10, cardAmount: 31500, pixAmount: 0 } },
        });
        expect(await cardChargeBaseAmount({ ...p })).toBe(0);
        const plans = await call('POST', '/api/stripe/installment-plans', u, { paymentId: p.id });
        expect(plans.status).toBe(400);
        expect(stripe.stripeCreatePaymentIntent).not.toHaveBeenCalled();
    });
});

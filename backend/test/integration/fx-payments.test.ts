import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

// ─── Mocks dos provedores (Sicoob / Stripe): nenhuma chamada de rede real ───────────────────────
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
import { saoPauloParts } from '../../src/lib/spTime';
import * as sicoob from '../../src/lib/sicoobService';
import * as stripe from '../../src/lib/stripeService';
import { buildStaticBrCode } from '../../src/lib/brcode';
import { issuePixCharge, pixTxidForAttempt, cardChargeBaseAmount, PIX_LIVE_CHARGE_MESSAGE } from '../../src/lib/pixGateway';
import { reconcilePendingSicoobPayments } from '../../src/lib/sicoobReconciliation';
import { onPaymentConfirmed } from '../../src/lib/paymentEffects';
import { purgeAwaitingContract, releaseAndPurgeRedemptionsOnce, cleanExpiredHolds } from '../../src/jobs/cleanExpiredHolds';
import { runAutoChargeJob } from '../../src/jobs/autoChargeJob';
import contractRoutes from '../../src/modules/contracts/routes';
import stripeRoutes from '../../src/modules/stripe/routes';
import webhookRoutes from '../../src/modules/webhooks/routes';
import bookingRoutes from '../../src/modules/bookings/routes';
import { getConfig } from '../../src/lib/businessConfig';
import { mkUser, mkContract, mkPayment, mkBooking, mkCoupon } from './factories';

// Frente fx-payments: achados CONFIRMADOS da revisão adversarial (pagamentos-2..14, contratos-2,
// jobs-tempo-migrations-3, regressoes-1/2/3, cobertura-2) — testes nas funções e ROTAS reais.

const VALID_CPF = '52998224725';
const m = <T extends (...a: any[]) => any>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>;
const minutes = (n: number) => new Date(Date.now() + n * 60 * 1000);
const txid = (paymentId: string, attempt = 1) => pixTxidForAttempt(paymentId, attempt);
const brl = (cents: number) => (cents / 100).toFixed(2);

let server: Server;
let base = '';

beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/contracts', contractRoutes);
    app.use('/api/stripe', stripeRoutes);
    app.use('/api/webhooks', webhookRoutes);
    app.use('/api/bookings', bookingRoutes);
    await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

let prevUnverified: string | undefined;
beforeEach(async () => {
    vi.clearAllMocks();
    m(sicoob.getSicoobEnvironment).mockResolvedValue('sandbox');
    m(sicoob.sicoobRemoveCob).mockResolvedValue(true);
    m(sicoob.sicoobGetCob).mockResolvedValue({ status: 'ATIVA', calendario: { criacao: new Date().toISOString(), expiracao: 3600 }, valor: { original: '0.01' } });
    m(sicoob.sicoobCreatePix).mockImplementation(async (p: { amount: number; txid: string; expiresSeconds?: number }) => ({
        id: p.txid,
        pixString: buildStaticBrCode({ key: 'k', amountCents: p.amount, txid: p.txid }),
        status: 'ATIVA',
        expiresAt: new Date(Date.now() + (p.expiresSeconds ?? 3600) * 1000),
    }));
    m(stripe.isStripeEnabled).mockResolvedValue(true);
    m(stripe.stripeCreatePaymentIntent).mockImplementation(async (o: { paymentId: string }) => ({ clientSecret: `cs_${o.paymentId}`, paymentIntentId: `pi_new_${o.paymentId.slice(0, 8)}`, status: 'requires_payment_method' }));
    m(stripe.stripeGetOrCreateCustomer).mockResolvedValue('cus_test');
    prevUnverified = process.env.ALLOW_UNVERIFIED_WEBHOOKS;
    process.env.ALLOW_UNVERIFIED_WEBHOOKS = 'true';
});

afterEach(() => {
    if (prevUnverified === undefined) delete process.env.ALLOW_UNVERIFIED_WEBHOOKS;
    else process.env.ALLOW_UNVERIFIED_WEBHOOKS = prevUnverified;
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

/** PIX (Sicoob sandbox) + Cartão (Stripe) habilitados, como no dev. */
async function enableMethods() {
    for (const [i, key] of ['PIX', 'CARTAO', 'BOLETO'].entries()) {
        await prisma.paymentMethodConfig.create({
            data: { key, label: key, shortLabel: key, emoji: '-', description: key, color: '#000000', active: true, sortOrder: i },
        });
    }
    await prisma.integrationConfig.create({ data: { provider: 'SICOOB', enabled: true, environment: 'sandbox', config: '{}' } });
    await prisma.integrationConfig.create({ data: { provider: 'STRIPE', enabled: true, environment: 'sandbox', config: '{}' } });
}

/** Cob Sicoob (GET /cob) de teste. */
function cob(over: Record<string, unknown> = {}) {
    return { status: 'ATIVA', calendario: { criacao: new Date().toISOString(), expiracao: 3600 }, valor: { original: '840.00' }, ...over };
}

// ─── pagamentos-2 ────────────────────────────────────────────────────────────────────────────────
describe('pagamentos-2 — conciliação por cron cobre o PIX sob demanda de linhas antigas', () => {
    it('parcela criada há 30 dias com QR recente pago → PAID', async () => {
        const u = await mkUser();
        const c = await mkContract(u.id);
        const p = await mkPayment(u.id, { contractId: c.id, createdAt: new Date(Date.now() - 30 * 86400_000) });
        await prisma.payment.update({ where: { id: p.id }, data: { providerRef: txid(p.id), pixExpiresAt: minutes(-60) } });
        m(sicoob.sicoobGetCob).mockResolvedValue(cob({ status: 'CONCLUIDA', pix: [{ valor: '840.00' }] }));

        await reconcilePendingSicoobPayments();

        expect((await prisma.payment.findUnique({ where: { id: p.id } }))?.status).toBe('PAID');
    });

    it('QR sob demanda expirado sem pagamento em parcela antiga → continua PENDING (sem "Cobrança falhou"); linha recente segue o FAILED de antes', async () => {
        m(sicoob.getSicoobEnvironment).mockResolvedValue('production');
        m(sicoob.sicoobGetCob).mockResolvedValue(cob({ calendario: { criacao: new Date(Date.now() - 3 * 3600_000).toISOString(), expiracao: 3600 } }));
        const u = await mkUser();
        const c = await mkContract(u.id);
        const old = await mkPayment(u.id, { contractId: c.id, createdAt: new Date(Date.now() - 30 * 86400_000) });
        await prisma.payment.update({ where: { id: old.id }, data: { providerRef: txid(old.id), pixExpiresAt: minutes(-120) } });
        const recent = await mkPayment(u.id, { contractId: c.id });
        await prisma.payment.update({ where: { id: recent.id }, data: { providerRef: txid(recent.id), pixExpiresAt: minutes(-120) } });

        await reconcilePendingSicoobPayments();

        expect((await prisma.payment.findUnique({ where: { id: old.id } }))?.status).toBe('PENDING');
        expect((await prisma.payment.findUnique({ where: { id: recent.id } }))?.status).toBe('FAILED');
    });
});

// ─── pagamentos-4 / regressoes-3 ────────────────────────────────────────────────────────────────
describe('pagamentos-4/regressoes-3 — remoção da cob falhou: nunca emite outra por cima da viva', () => {
    async function legacyRow(amount = 84000) {
        await enableMethods();
        const u = await mkUser({ cpfCnpj: VALID_CPF });
        const c = await mkContract(u.id);
        const p = await mkPayment(u.id, { contractId: c.id, amount });
        const ref = txid(p.id);
        // Linha legada: cobrança emitida antes do deploy, sem pixExpiresAt.
        await prisma.payment.update({ where: { id: p.id }, data: { providerRef: ref, pixString: buildStaticBrCode({ key: 'k', amountCents: amount }) } });
        m(sicoob.getSicoobEnvironment).mockResolvedValue('production');
        m(sicoob.sicoobRemoveCob).mockResolvedValue(false);
        return { u, c, p, ref };
    }

    it('cob ATIVA do mesmo valor → adota a viva (reused), sem emitir outra', async () => {
        const { p, ref } = await legacyRow();
        const criacao = new Date(Date.now() - 5 * 60_000);
        const emv = buildStaticBrCode({ key: 'real', amountCents: 84000, txid: ref });
        m(sicoob.sicoobGetCob).mockResolvedValue(cob({ calendario: { criacao: criacao.toISOString(), expiracao: 3600 }, pixCopiaECola: emv }));

        const r = await issuePixCharge(p.id);

        expect(r.reused).toBe(true);
        expect(r.providerRef).toBe(ref);
        expect(sicoob.sicoobCreatePix).not.toHaveBeenCalled();
        const row = await prisma.payment.findUnique({ where: { id: p.id } });
        expect(row?.providerRef).toBe(ref);
        expect(row?.pixString).toBe(emv);
        expect(Math.abs(row!.pixExpiresAt!.getTime() - (criacao.getTime() + 3600_000))).toBeLessThan(2000);
    });

    it('cob ATIVA de OUTRO valor (ou GET falhou) → erro amigável, providerRef intacto, nada emitido', async () => {
        const { p, ref } = await legacyRow();
        m(sicoob.sicoobGetCob).mockResolvedValue(cob({ valor: { original: '900.00' } }));
        await expect(issuePixCharge(p.id)).rejects.toThrow(PIX_LIVE_CHARGE_MESSAGE);

        m(sicoob.sicoobGetCob).mockRejectedValue(new Error('Sicoob consultar cobrança falhou — 503: indisponível'));
        await expect(issuePixCharge(p.id)).rejects.toThrow(PIX_LIVE_CHARGE_MESSAGE);

        expect(sicoob.sicoobCreatePix).not.toHaveBeenCalled();
        expect((await prisma.payment.findUnique({ where: { id: p.id } }))?.providerRef).toBe(ref);
    });

    it('cob expirada → segue e emite a tentativa 2', async () => {
        const { p, ref } = await legacyRow();
        m(sicoob.sicoobGetCob).mockResolvedValue(cob({ calendario: { criacao: new Date(Date.now() - 3 * 3600_000).toISOString(), expiracao: 3600 } }));
        const r = await issuePixCharge(p.id);
        expect(r.reused).toBe(false);
        expect(r.providerRef).toBe(txid(p.id, 2));
        expect(r.providerRef).not.toBe(ref);
    });

    it('troca para cartão com a cob viva não removível → 409 e nenhum PaymentIntent', async () => {
        const { u, p, ref } = await legacyRow();
        m(sicoob.sicoobGetCob).mockResolvedValue(cob());
        const res = await call('POST', '/api/stripe/create-payment', u, { paymentId: p.id, paymentMethod: 'cartao', installments: 1 });
        expect(res.status).toBe(409);
        expect(stripe.stripeCreatePaymentIntent).not.toHaveBeenCalled();
        const row = await prisma.payment.findUnique({ where: { id: p.id } });
        expect(row?.provider).toBe('SICOOB');
        expect(row?.providerRef).toBe(ref);
    });

    it('webhook Sicoob de um QR ANTERIOR do mesmo Payment → concilia pela cob paga e cancela a atual', async () => {
        const u = await mkUser();
        const p = await mkPayment(u.id);
        const current = txid(p.id, 2);
        await prisma.payment.update({ where: { id: p.id }, data: { providerRef: current } });
        const old = txid(p.id, 1);
        m(sicoob.sicoobGetCob).mockImplementation(async (t: string) =>
            t === old ? cob({ status: 'CONCLUIDA', pix: [{ valor: '840.00' }] }) : cob());

        const res = await call('POST', '/api/webhooks/sicoob', undefined, { pix: [{ txid: old }] });
        expect(res.status).toBe(200);
        const row = await prisma.payment.findUnique({ where: { id: p.id } });
        expect(row?.status).toBe('PAID');
        expect(row?.providerRef).toBe(old);
        expect(sicoob.sicoobRemoveCob).toHaveBeenCalledWith(current);
    });
});

// ─── pagamentos-3 / cobertura-2 ─────────────────────────────────────────────────────────────────
describe('pagamentos-3/cobertura-2 — o desconto PIX do à vista nunca vale no cartão', () => {
    async function mkService() {
        await prisma.addOnConfig.create({
            data: { key: 'GESTAO_TRAFEGO', name: 'Gestão de Tráfego', price: 150000, monthly: true, plansAllowed: 'FULL,MONTHLY', durationsOffered: '3,6' },
        });
    }

    it('POST /service À vista + PIX grava metadata.pixDiscount; o cartão cobra o total SEM o desconto PIX', async () => {
        await enableMethods();
        await mkService();
        const u = await mkUser({ cpfCnpj: VALID_CPF });
        const created = await call('POST', '/api/contracts/service', u, { serviceKey: 'GESTAO_TRAFEGO', paymentMethod: 'PIX', durationMonths: 3, paymentPlan: 'FULL' });
        expect(created.status).toBe(201);
        const pay = await prisma.payment.findUnique({ where: { id: created.body.firstPaymentId } });
        const monthly = Math.round(150000 * (1 - Number(await getConfig('service_discount_3months')) / 100));
        const pixPct = Number(await getConfig('pix_extra_discount_pct'));
        expect(pay!.amount).toBe(Math.round(monthly * 3 * (1 - pixPct / 100))); // PIX: com o desconto
        const meta = (pay?.metadata as any)?.pixDiscount;
        expect(meta).toEqual({ pct: pixPct, cardAmount: monthly * 3, pixAmount: pay!.amount }); // cartão: o total SEM o desconto PIX
        expect((pay?.metadata as any)?.installmentCap).toBe(1);
        expect((pay?.metadata as any)?.pixCharge?.attempt).toBe(1); // o gateway preservou o metadata

        // Prévia das parcelas (checkout do cartão) já sai no valor do cartão.
        const plans = await call('POST', '/api/stripe/installment-plans', u, { paymentId: pay!.id });
        expect(plans.body.plans.map((x: any) => x.count)).toEqual([1]);
        expect(plans.body.plans[0].total).toBe(meta.cardAmount);

        const card = await call('POST', '/api/stripe/create-payment', u, { paymentId: pay!.id, paymentMethod: 'cartao', installments: 1 });
        expect(card.status).toBe(200);
        expect(m(stripe.stripeCreatePaymentIntent).mock.calls[0]![0].amount).toBe(meta.cardAmount);
        const after = await prisma.payment.findUnique({ where: { id: pay!.id } });
        expect(after?.amount).toBe(pay!.amount);              // a base (PIX) não muda
        expect(after?.chargedAmount).toBe(meta.cardAmount);   // paridade do webhook
        expect(after?.provider).toBe('STRIPE');
        expect(after?.pixString).toBeNull();
    });

    it('sem a marca → o próprio amount em qualquer linha antiga (FULL + PIX com ou sem cupom, avulso, mensal, /self): nada é recalculado nem gravado', async () => {
        // D1 regra única (conservadora): só a marca da criação reverte o desconto PIX no cartão. Uma cobrança
        // à vista antiga sem a marca cobra no cartão o valor gravado — pode ficar ABAIXO do preço de cartão,
        // nunca acima (o fallback que revertia o % atual foi removido; ver pix-discount-mark.test.ts).
        const u = await mkUser();
        const old = new Date('2026-09-01T12:00:00Z');
        const full = await mkContract(u.id, { type: 'FIXO', paymentPlan: 'FULL', paymentMethod: 'PIX' });
        // 3 × 105000 = 315000 → PIX 10% = 283500 → cupom R$ 100 → 273500 gravado.
        const withCoupon = await mkPayment(u.id, { contractId: full.id, amount: 273500, discountAmount: 10000, createdAt: old });
        expect(await cardChargeBaseAmount({ ...withCoupon, contract: full })).toBe(273500);
        const full2 = await mkContract(u.id, { type: 'FIXO', paymentPlan: 'FULL', paymentMethod: 'PIX' });
        const plain = await mkPayment(u.id, { contractId: full2.id, amount: 283500, createdAt: old });
        expect(await cardChargeBaseAmount({ ...plain, contract: full2 })).toBe(283500);
        const avulso = await mkContract(u.id, { type: 'AVULSO', paymentPlan: 'FULL', paymentMethod: 'PIX' });
        const pa = await mkPayment(u.id, { contractId: avulso.id, amount: 30000, createdAt: old });
        expect(await cardChargeBaseAmount({ ...pa, contract: avulso })).toBe(30000);
        const monthly = await mkContract(u.id, { type: 'FIXO', paymentPlan: 'MONTHLY', paymentMethod: 'PIX' });
        const pm = await mkPayment(u.id, { contractId: monthly.id, amount: 105000, createdAt: old });
        expect(await cardChargeBaseAmount({ ...pm, contract: monthly })).toBe(105000);
        // /self (contrato ainda só no metadata)
        expect(await cardChargeBaseAmount({ amount: 283500, createdAt: old, metadata: { contractData: { type: 'FIXO', paymentPlan: 'FULL', paymentMethod: 'PIX' } }, contract: null })).toBe(283500);
        // Linha nova sem a marca: idem.
        const fresh = await mkPayment(u.id, { contractId: (await mkContract(u.id, { type: 'FIXO', paymentPlan: 'FULL', paymentMethod: 'PIX' })).id, amount: 283500 });
        expect(await cardChargeBaseAmount({ ...fresh })).toBe(283500);
        // Nenhuma marca foi gravada.
        for (const p of [withCoupon, plain, pa, pm, fresh]) {
            expect(((await prisma.payment.findUnique({ where: { id: p.id } }))?.metadata as any)?.pixDiscount).toBeUndefined();
        }
    });
});

// ─── pagamentos-5 / regressoes-2 ─────────────────────────────────────────────────────────────────
describe('pagamentos-5/regressoes-2 — cobrança automática', () => {
    async function payer() {
        const u = await mkUser({ autoChargeEnabled: true, stripeCustomerId: 'cus_test' });
        await prisma.savedPaymentMethod.create({ data: { userId: u.id, stripePaymentMethodId: `pm_${u.id.slice(0, 8)}`, brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030, isDefault: true } });
        return u;
    }

    it('QR PIX vivo → não cobra o cartão; PIX já pago (webhook perdido) → concilia e não cobra; demais → cobra com chargedAmount', async () => {
        const u = await payer();
        const c = await mkContract(u.id, { status: 'ACTIVE' });
        const due = new Date(Date.now() - 3600_000);
        const live = await mkPayment(u.id, { contractId: c.id, dueDate: due });
        await prisma.payment.update({ where: { id: live.id }, data: { providerRef: txid(live.id), pixExpiresAt: minutes(30) } });
        const paidPix = await mkPayment(u.id, { contractId: c.id, dueDate: due });
        await prisma.payment.update({ where: { id: paidPix.id }, data: { providerRef: txid(paidPix.id), pixExpiresAt: minutes(-30) } });
        const plain = await mkPayment(u.id, { contractId: c.id, dueDate: due, provider: 'STRIPE' });
        m(sicoob.sicoobGetCob).mockImplementation(async (t: string) =>
            t === txid(paidPix.id) ? cob({ status: 'CONCLUIDA', pix: [{ valor: '840.00' }] }) : cob());
        m(stripe.stripeChargeOffSession).mockImplementation(async (_c: string, _pm: string, _amt: number, meta: { paymentId: string }) =>
            ({ clientSecret: '', paymentIntentId: `pi_auto_${meta.paymentId.slice(0, 6)}`, status: 'succeeded' }));

        await runAutoChargeJob();

        const charged = m(stripe.stripeChargeOffSession).mock.calls.map(cl => cl[3].paymentId);
        expect(charged).toEqual([plain.id]);
        expect((await prisma.payment.findUnique({ where: { id: live.id } }))?.status).toBe('PENDING');
        expect((await prisma.payment.findUnique({ where: { id: paidPix.id } }))?.status).toBe('PAID');
        const plainRow = await prisma.payment.findUnique({ where: { id: plain.id } });
        expect(plainRow?.status).toBe('PAID');
        expect(plainRow?.chargedAmount).toBe(84000);
    });

    it('renovação AGUARDANDO pagamento (3 dias) volta a ser cobrada; serviço/personalizado aguardando (10 min) não', async () => {
        const u = await payer();
        const original = await mkContract(u.id, { status: 'ACTIVE' });
        const renewal = await mkContract(u.id, { status: 'AWAITING_PAYMENT', paymentDeadline: minutes(3 * 24 * 60), renewedFromId: original.id });
        const service = await mkContract(u.id, { type: 'SERVICO', status: 'AWAITING_PAYMENT', paymentDeadline: minutes(8) });
        const custom = await mkContract(u.id, { type: 'CUSTOM', status: 'AWAITING_PAYMENT', paymentDeadline: minutes(8) });
        const pr = await mkPayment(u.id, { contractId: renewal.id, dueDate: new Date(), provider: 'STRIPE' });
        await mkPayment(u.id, { contractId: service.id, dueDate: new Date(), provider: 'STRIPE' });
        await mkPayment(u.id, { contractId: custom.id, dueDate: new Date(), provider: 'STRIPE' });
        m(stripe.stripeChargeOffSession).mockResolvedValue({ clientSecret: '', paymentIntentId: 'pi_auto_ren', status: 'succeeded' });

        await runAutoChargeJob();

        expect(m(stripe.stripeChargeOffSession).mock.calls.map(cl => cl[3].paymentId)).toEqual([pr.id]);
        expect((await prisma.contract.findUnique({ where: { id: renewal.id } }))?.status).toBe('ACTIVE');
    });
});

// ─── pagamentos-6 ────────────────────────────────────────────────────────────────────────────────
describe('pagamentos-6 — payment_failed só falha a cobrança de cartão ATUAL; reset de FAILED preserva o PIX vivo', () => {
    const failedEvent = (paymentId: string, piId: string) => ({ type: 'payment_intent.payment_failed', data: { object: { id: piId, metadata: { paymentId } } } });

    it('linha que virou PIX ignora a recusa atrasada; linha no cartão com o mesmo PI → FAILED; PI antigo não falha a tentativa nova', async () => {
        const u = await mkUser();
        const pix = await mkPayment(u.id, { provider: 'SICOOB' });
        await prisma.payment.update({ where: { id: pix.id }, data: { providerRef: txid(pix.id) } });
        const card = await mkPayment(u.id, { provider: 'STRIPE', providerRef: 'pi_same' });
        const newer = await mkPayment(u.id, { provider: 'STRIPE', providerRef: 'pi_newer' });

        await call('POST', '/api/webhooks/stripe', undefined, failedEvent(pix.id, 'pi_old'));
        await call('POST', '/api/webhooks/stripe', undefined, failedEvent(card.id, 'pi_same'));
        await call('POST', '/api/webhooks/stripe', undefined, failedEvent(newer.id, 'pi_older'));

        expect((await prisma.payment.findUnique({ where: { id: pix.id } }))?.status).toBe('PENDING');
        expect((await prisma.payment.findUnique({ where: { id: card.id } }))?.status).toBe('FAILED');
        expect((await prisma.payment.findUnique({ where: { id: newer.id } }))?.status).toBe('PENDING');
    });

    it('"Gerar novo QR" numa linha FAILED com a cob ainda viva reaproveita o QR (nunca descarta o txid sem aposentar)', async () => {
        await enableMethods();
        const u = await mkUser({ cpfCnpj: VALID_CPF });
        const p = await mkPayment(u.id, { status: 'FAILED' });
        const ref = txid(p.id);
        const emv = buildStaticBrCode({ key: 'k', amountCents: 84000, txid: ref });
        await prisma.payment.update({ where: { id: p.id }, data: { providerRef: ref, pixString: emv, pixExpiresAt: minutes(30), metadata: { pixCharge: { attempt: 1, amount: 84000, txid: ref } } } });

        const res = await call('POST', '/api/stripe/create-payment', u, { paymentId: p.id, paymentMethod: 'pix' });
        expect(res.status).toBe(200);
        expect(res.body.reused).toBe(true);
        const row = await prisma.payment.findUnique({ where: { id: p.id } });
        expect(row?.status).toBe('PENDING');
        expect(row?.providerRef).toBe(ref);
        expect(sicoob.sicoobCreatePix).not.toHaveBeenCalled();
    });
});

// ─── pagamentos-8 / pagamentos-13 ────────────────────────────────────────────────────────────────
describe('pagamentos-8/13 — PROGRESSIVE: a parcela k libera o ciclo k (nunca dois ciclos com uma parcela)', () => {
    async function weekly(userId: string, contractId: string, n: number, confirmedFirst: number) {
        const start = Date.parse('2026-10-05T00:00:00Z');
        for (let i = 0; i < n; i++) {
            await mkBooking(userId, contractId, { date: new Date(start + i * 7 * 86400_000), status: i < confirmedFirst ? 'CONFIRMED' : 'RESERVED', holdExpiresAt: null });
        }
    }
    const confirmed = (contractId: string) => prisma.booking.count({ where: { contractId, status: 'CONFIRMED' } });
    const pay = async (id: string) => {
        await prisma.payment.update({ where: { id }, data: { status: 'PAID', paidAt: new Date() } });
        await onPaymentConfirmed(id);
    };

    it('personalizado do ADMIN (nasce ACTIVE com o 1º ciclo liberado): p1 não libera o ciclo 2; p2 libera; repetição é idempotente; a última libera o resto', async () => {
        const u = await mkUser();
        const c = await mkContract(u.id, { type: 'CUSTOM', status: 'ACTIVE', accessMode: 'PROGRESSIVE', durationMonths: 3 });
        await weekly(u.id, c.id, 13, 4);
        const p1 = await mkPayment(u.id, { contractId: c.id, dueDate: new Date('2026-10-05T00:00:00Z') });
        const p2 = await mkPayment(u.id, { contractId: c.id, dueDate: new Date('2026-11-02T00:00:00Z') });
        const p3 = await mkPayment(u.id, { contractId: c.id, dueDate: new Date('2026-11-30T00:00:00Z') });

        await pay(p1.id);
        expect(await confirmed(c.id)).toBe(4);
        await pay(p2.id);
        expect(await confirmed(c.id)).toBe(8);
        await onPaymentConfirmed(p2.id); // efeitos rodando 2x para o mesmo PAID
        expect(await confirmed(c.id)).toBe(8);
        await pay(p3.id);
        expect(await confirmed(c.id)).toBe(13); // quitado → nada fica travado (inclui a 13ª semana)
    });

    it('à vista (FULL) com acesso PROGRESSIVE: a única parcela libera tudo', async () => {
        const u = await mkUser();
        const c = await mkContract(u.id, { type: 'CUSTOM', status: 'AWAITING_PAYMENT', paymentDeadline: minutes(10), accessMode: 'PROGRESSIVE', paymentPlan: 'FULL', durationMonths: 2 });
        await weekly(u.id, c.id, 8, 0);
        const p = await mkPayment(u.id, { contractId: c.id });
        await pay(p.id);
        expect(await confirmed(c.id)).toBe(8);
    });

    it('corrida webhook × varredura na 1ª parcela do personalizado do cliente → exatamente 1 ciclo', async () => {
        const u = await mkUser();
        const c = await mkContract(u.id, { type: 'CUSTOM', status: 'AWAITING_PAYMENT', paymentDeadline: minutes(-1), accessMode: 'PROGRESSIVE', durationMonths: 3 });
        await weekly(u.id, c.id, 12, 0);
        const p1 = await mkPayment(u.id, { contractId: c.id, dueDate: new Date('2026-10-05T00:00:00Z') });
        await mkPayment(u.id, { contractId: c.id, dueDate: new Date('2026-11-02T00:00:00Z') });
        await mkPayment(u.id, { contractId: c.id, dueDate: new Date('2026-11-30T00:00:00Z') });
        await prisma.payment.update({ where: { id: p1.id }, data: { status: 'PAID', paidAt: new Date() } });

        await Promise.all([onPaymentConfirmed(p1.id), purgeAwaitingContract(c.id), onPaymentConfirmed(p1.id)]);

        expect((await prisma.contract.findUnique({ where: { id: c.id } }))?.status).toBe('ACTIVE');
        expect(await confirmed(c.id)).toBe(4);
    });
});

// ─── jobs-tempo-migrations-3 ─────────────────────────────────────────────────────────────────────
describe('jobs-tempo-migrations-3 — purga concorrente devolve o uso do cupom UMA vez', () => {
    it('duas purgas simultâneas do mesmo contrato vencido → usedCount cai 1', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const u = await mkUser();
        const coupon = await mkCoupon(admin.id, { usedCount: 5, maxUses: 10 });
        const c = await mkContract(u.id, { type: 'CUSTOM', status: 'AWAITING_PAYMENT', paymentDeadline: minutes(-1), accessMode: 'FULL' });
        const p = await mkPayment(u.id, { contractId: c.id, couponId: coupon.id, couponCode: coupon.code, discountAmount: 8400 });
        await prisma.couponRedemption.create({ data: { couponId: coupon.id, userId: u.id, paymentId: p.id, status: 'RESERVED', originalAmount: 84000, discountAmount: 8400 } });

        const results = await Promise.all([purgeAwaitingContract(c.id), purgeAwaitingContract(c.id)]);

        expect(results).toContain('purged');
        expect(await prisma.contract.findUnique({ where: { id: c.id } })).toBeNull();
        expect((await prisma.coupon.findUnique({ where: { id: coupon.id } }))?.usedCount).toBe(4);
    });

    it('releaseAndPurgeRedemptionsOnce em paralelo decrementa só pelo que apagou', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const u = await mkUser();
        const coupon = await mkCoupon(admin.id, { usedCount: 3 });
        const p = await mkPayment(u.id);
        await prisma.couponRedemption.create({ data: { couponId: coupon.id, userId: u.id, paymentId: p.id, status: 'RESERVED', originalAmount: 84000, discountAmount: 8400 } });

        await Promise.all([releaseAndPurgeRedemptionsOnce([p.id]), releaseAndPurgeRedemptionsOnce([p.id]), releaseAndPurgeRedemptionsOnce([p.id])]);

        expect((await prisma.coupon.findUnique({ where: { id: coupon.id } }))?.usedCount).toBe(2);
        expect(await prisma.couponRedemption.count({ where: { paymentId: p.id } })).toBe(0);
    });
});

// ─── regressoes-1 ────────────────────────────────────────────────────────────────────────────────
describe('regressoes-1 — avulso com pagamento em andamento continua segurando o horário', () => {
    it('3DS em andamento → hold renovado (não fica "livre"), reserva e contrato mantidos', async () => {
        const u = await mkUser();
        const c = await mkContract(u.id, { type: 'AVULSO', status: 'AWAITING_PAYMENT', paymentDeadline: minutes(-1), durationMonths: 1, paymentPlan: 'FULL' });
        const b = await mkBooking(u.id, c.id, { status: 'RESERVED', holdExpiresAt: minutes(-1) });
        await mkPayment(u.id, { contractId: c.id, bookingId: b.id, provider: 'STRIPE', providerRef: 'pi_3ds_live' });
        m(stripe.stripeGetPaymentIntent).mockResolvedValue({ id: 'pi_3ds_live', status: 'requires_action', created: Math.floor(Date.now() / 1000) - 60, amount: 84000, metadata: {} });

        await cleanExpiredHolds();

        const row = await prisma.booking.findUnique({ where: { id: b.id } });
        expect(row?.status).toBe('RESERVED');
        expect(row!.holdExpiresAt!.getTime()).toBeGreaterThan(Date.now());
        expect(await prisma.contract.findUnique({ where: { id: c.id } })).not.toBeNull();
    });
});

// ─── contratos-2 ─────────────────────────────────────────────────────────────────────────────────
describe('contratos-2 — /pay escolhe a 1ª parcela (menor vencimento), não a mais recente por createdAt', () => {
    it('personalizado AWAITING com cupom (1ª criada antes das demais) → QR na parcela 1; 2..N intactas', async () => {
        await enableMethods();
        const u = await mkUser({ cpfCnpj: VALID_CPF });
        const c = await mkContract(u.id, { type: 'CUSTOM', status: 'AWAITING_PAYMENT', paymentDeadline: minutes(10), paymentMethod: 'PIX', accessMode: 'FULL' });
        const p1 = await mkPayment(u.id, { contractId: c.id, amount: 75600, dueDate: new Date('2026-09-24T00:00:00Z'), createdAt: new Date(Date.now() - 1000) });
        const p2 = await mkPayment(u.id, { contractId: c.id, dueDate: new Date('2026-10-22T00:00:00Z') });
        const p3 = await mkPayment(u.id, { contractId: c.id, dueDate: new Date('2026-11-19T00:00:00Z') });

        const res = await call('POST', `/api/contracts/${c.id}/pay`, u, { paymentMethod: 'PIX' });

        expect(res.status).toBe(200);
        expect(res.body.paymentId).toBe(p1.id);
        for (const id of [p2.id, p3.id]) {
            const row = await prisma.payment.findUnique({ where: { id } });
            expect(row?.providerRef).toBeNull();
            expect(row?.pixString).toBeNull();
        }
    });
});

// ─── pagamentos-9 ────────────────────────────────────────────────────────────────────────────────
describe('pagamentos-9 — POST /service não cria duas contratações simultâneas', () => {
    it('dois POST em paralelo → no máximo 1 AWAITING_PAYMENT (o outro recebe 409)', async () => {
        await enableMethods();
        await prisma.addOnConfig.create({ data: { key: 'GESTAO_TRAFEGO', name: 'Gestão de Tráfego', price: 150000, monthly: true, plansAllowed: 'FULL,MONTHLY' } });
        const u = await mkUser({ cpfCnpj: VALID_CPF });
        const slow = m(sicoob.sicoobCreatePix).getMockImplementation()!;
        m(sicoob.sicoobCreatePix).mockImplementation(async (p: any) => { await new Promise(r => setTimeout(r, 300)); return slow(p); });
        const body = { serviceKey: 'GESTAO_TRAFEGO', paymentMethod: 'PIX', durationMonths: 3, paymentPlan: 'MONTHLY' };

        const [a, b] = await Promise.all([call('POST', '/api/contracts/service', u, body), call('POST', '/api/contracts/service', u, body)]);

        expect([a.status, b.status].sort()).toEqual([201, 409]);
        expect(await prisma.contract.count({ where: { userId: u.id, type: 'SERVICO', status: 'AWAITING_PAYMENT' } })).toBe(1);
        // A trava é liberada ao terminar (nunca por tempo): uma nova tentativa logo depois substitui a anterior.
        const again = await call('POST', '/api/contracts/service', u, body);
        expect(again.status).toBe(201);
        expect(await prisma.contract.count({ where: { userId: u.id, type: 'SERVICO', status: 'AWAITING_PAYMENT' } })).toBe(1);
    });
});

// ─── pagamentos-10 ───────────────────────────────────────────────────────────────────────────────
describe('pagamentos-10 — avulso reaproveitado que troca PIX→Cartão usa o MESMO Payment', () => {
    function nextWeekday(minDays: number): string {
        const sp = saoPauloParts(new Date());
        const d = new Date(Date.UTC(sp.y, sp.m - 1, sp.day + minDays));
        while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
        return d.toISOString().slice(0, 10);
    }

    it('POST /bookings (CARTAO) na reserva PIX → 1 Payment só, sem PI criado ali; prazo do contrato = novo hold', async () => {
        await enableMethods();
        const u = await mkUser({ cpfCnpj: VALID_CPF });
        // Data distante e aleatória: o Redis das travas de horário é compartilhado com o dev e outras suítes.
        const date = nextWeekday(40 + Math.floor(Math.random() * 200));
        const first = await call('POST', '/api/bookings', u, { date, startTime: '10:00', paymentMethod: 'PIX' });
        expect(first.status, JSON.stringify(first.body)).toBe(201);
        const pid = first.body.paymentId as string;
        const pix = await call('POST', '/api/stripe/create-payment', u, { paymentId: pid, paymentMethod: 'pix' });
        expect(pix.status).toBe(200);

        const retry = await call('POST', '/api/bookings', u, { date, startTime: '10:00', paymentMethod: 'CARTAO', installments: 1, paymentType: 'CREDIT' });
        expect(retry.status, JSON.stringify(retry.body)).toBe(200);
        expect(retry.body.paymentId).toBe(pid);
        expect(stripe.stripeCreatePaymentIntent).not.toHaveBeenCalled();
        const bookingId = retry.body.booking.id as string;
        expect(await prisma.payment.count({ where: { bookingId } })).toBe(1);
        const booking = await prisma.booking.findUnique({ where: { id: bookingId }, include: { contract: true } });
        expect(booking?.contract?.paymentDeadline?.getTime()).toBe(booking?.holdExpiresAt?.getTime());

        // O checkout cria o PI a partir do mesmo Payment e aposenta o PIX.
        const card = await call('POST', '/api/stripe/create-payment', u, { paymentId: pid, paymentMethod: 'cartao', installments: 1 });
        expect(card.status).toBe(200);
        expect(sicoob.sicoobRemoveCob).toHaveBeenCalled();
        const row = await prisma.payment.findUnique({ where: { id: pid } });
        expect(row?.provider).toBe('STRIPE');
        expect(row?.pixString).toBeNull();
    });
});

// ─── pagamentos-14 ───────────────────────────────────────────────────────────────────────────────
describe('pagamentos-14 — PIX não é emitido por cima de um cartão aguardando 3DS', () => {
    async function cardRow() {
        await enableMethods();
        const u = await mkUser({ cpfCnpj: VALID_CPF });
        return mkPayment(u.id, { provider: 'STRIPE', providerRef: 'pi_card_3ds', chargedAmount: 90000 });
    }

    it('requires_action recente → bloqueia; PI, providerRef e chargedAmount intactos', async () => {
        const p = await cardRow();
        m(stripe.stripeGetPaymentIntent).mockResolvedValue({ id: 'pi_card_3ds', status: 'requires_action', created: Math.floor(Date.now() / 1000) - 120 });
        await expect(issuePixCharge(p.id)).rejects.toThrow(/cartão em processamento/);
        const row = await prisma.payment.findUnique({ where: { id: p.id } });
        expect(row?.provider).toBe('STRIPE');
        expect(row?.providerRef).toBe('pi_card_3ds');
        expect(row?.chargedAmount).toBe(90000);
    });

    it('PI abandonado (requires_payment_method) → emite o PIX sem zerar o chargedAmount do PI anterior', async () => {
        const p = await cardRow();
        m(stripe.stripeGetPaymentIntent).mockResolvedValue({ id: 'pi_card_3ds', status: 'requires_payment_method', created: Math.floor(Date.now() / 1000) - 120 });
        const r = await issuePixCharge(p.id);
        expect(r.reused).toBe(false);
        const row = await prisma.payment.findUnique({ where: { id: p.id } });
        expect(row?.provider).toBe('SICOOB');
        expect(row?.chargedAmount).toBe(90000);
    });
});

// Sanidade dos valores usados acima.
it('brl helper', () => expect(brl(84000)).toBe('840.00'));

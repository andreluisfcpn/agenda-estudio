import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// ─── Mocks dos provedores (Stripe / Sicoob / Cora): nenhuma chamada de rede real ─────────────────
vi.mock('../../src/lib/coraPaymentHelper', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../../src/lib/coraPaymentHelper')>();
    return { ...orig, createCoraPayment: vi.fn() };
});
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
        stripeGetCard: vi.fn(),
        stripeListPaymentMethods: vi.fn(async () => []),
        stripeGetPaymentIntent: vi.fn(),
        stripeCancelPaymentIntent: vi.fn(async () => ({ status: 'canceled', canceled: true })),
        stripeCreatePaymentIntent: vi.fn(),
        stripeGetOrCreateCustomer: vi.fn(),
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
import * as sicoob from '../../src/lib/sicoobService';
import { invalidateConfigCache } from '../../src/lib/businessConfig';
import stripeRoutes from '../../src/modules/stripe/routes';
import pricingRoutes from '../../src/modules/pricing/routes';
import { mkUser, mkContract, mkPayment, mkCpf } from './factories';

// Frente fxE-checkout (revisão do lote 2) — o que o CHECKOUT (frontend) passou a assumir do backend:
//  CHK-1  a caixa "Salvar cartão" é enviada no create-payment, ANTES de o PaymentIntent existir: o PI só
//         nasce com salvar-cartão quando `savePaymentMethod: true` — inclusive quando é o ADMIN que digita
//         o cartão do CLIENTE (o Customer é o do dono do pagamento).
//  CHK-2  a cotação (installment-plans) é a ÚNICA fonte do preço do cartão de uma cobrança à vista que está
//         no preço PIX: `amount` (798) ≠ `cardAmount` (840). Sem a cotação o checkout não mostra o `amount`
//         como preço do cartão nem cobra o cartão salvo — porque o create-payment cobra o `cardAmount`.
//  SEC-3  (consumidor) a rota PÚBLICA devolve o boleto saneado; o estado completo (chave × Cora, motivo e
//         mensagem de administração) vem só de GET /pricing/payment-methods/all — é de lá que a tela de
//         Configurações lê o switch, o bloqueio e o aviso "ative a Cora".

type Who = { id: string; email: string | null; role: string };
const m = <T extends (...a: any[]) => any>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>;

let server: Server;
let base = '';

beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/stripe', stripeRoutes);
    app.use('/api/pricing', pricingRoutes);
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
    m(stripe.isStripeEnabled).mockResolvedValue(true);
    m(stripe.stripeCardInstallmentsSupported).mockResolvedValue(false);
    m(stripe.stripeGetPaymentIntent).mockResolvedValue(undefined);
    m(stripe.stripeListPaymentMethods).mockResolvedValue([]);
    m(stripe.stripeCreatePaymentIntent).mockImplementation(async (o: { paymentId: string; amount: number }) => ({
        clientSecret: `cs_${o.paymentId}`, paymentIntentId: `pi_new_${o.paymentId.slice(0, 8)}_${o.amount}`, status: 'requires_payment_method',
    }));
    // Customer do PAGADOR (dono do pagamento) — nunca o de quem está logado.
    m(stripe.stripeGetOrCreateCustomer).mockImplementation(async (userId: string) => `cus_of_${userId}`);
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
async function setup(opts: { boleto?: boolean; cora?: boolean } = {}) {
    for (const [i, key] of ['PIX', 'CARTAO', 'BOLETO'].entries()) {
        await prisma.paymentMethodConfig.create({
            data: { key, label: key, shortLabel: key, emoji: '-', description: key, color: '#000000', active: key === 'BOLETO' ? !!opts.boleto : true, sortOrder: i },
        });
    }
    await prisma.integrationConfig.create({ data: { provider: 'SICOOB', enabled: true, environment: 'sandbox', config: '{}' } });
    await prisma.integrationConfig.create({ data: { provider: 'STRIPE', enabled: true, environment: 'sandbox', config: '{}' } });
    await prisma.integrationConfig.create({ data: { provider: 'CORA', enabled: !!opts.cora, environment: 'sandbox', config: '{}' } });
}

async function installment(over: { contract?: Record<string, unknown>; payment?: Record<string, unknown> } = {}) {
    const admin = await mkUser({ role: 'ADMIN' });
    const client = await mkUser({ cpfCnpj: mkCpf() });
    const contract = await mkContract(client.id, { type: 'FIXO', paymentPlan: 'MONTHLY', paymentMethod: 'CARTAO', ...over.contract });
    const payment = await mkPayment(client.id, { contractId: contract.id, provider: 'STRIPE', amount: 84000, ...over.payment });
    return { admin, client, contract, payment };
}

const card = (who: Who, paymentId: string, extra: Record<string, unknown> = {}) =>
    call('POST', '/api/stripe/create-payment', who, { paymentId, paymentMethod: 'cartao', installments: 1, ...extra });
const lastIntent = () => m(stripe.stripeCreatePaymentIntent).mock.calls.at(-1)![0] as Record<string, unknown>;

// ─── CHK-1 ───────────────────────────────────────────────────────────────────────────────────────
describe('CHK-1 — "Salvar cartão" decidido no create-payment (antes de o PaymentIntent existir)', () => {
    beforeEach(async () => { await setup(); });

    it('cliente com a caixa DESMARCADA → PaymentIntent criado sem salvar o cartão; marcada → com salvar', async () => {
        const { client, payment } = await installment();

        const off = await card(client, payment.id, { savePaymentMethod: false });
        expect(off.status, JSON.stringify(off.body)).toBe(200);
        expect(off.body.clientSecret).toBeTruthy();
        expect(lastIntent().savePaymentMethod).toBe(false);
        expect(lastIntent().savedPaymentMethodId).toBeUndefined();

        const on = await card(client, payment.id, { savePaymentMethod: true });
        expect(on.status, JSON.stringify(on.body)).toBe(200);
        expect(lastIntent().savePaymentMethod).toBe(true);
    });

    it('ADMIN digitando o cartão do CLIENTE com a caixa desmarcada → PI no Customer do CLIENTE e sem salvar', async () => {
        const { admin, client, payment } = await installment();

        const r = await card(admin, payment.id, { savePaymentMethod: false });

        expect(r.status, JSON.stringify(r.body)).toBe(200);
        expect(m(stripe.stripeGetOrCreateCustomer)).toHaveBeenCalledWith(client.id);
        expect(m(stripe.stripeGetOrCreateCustomer)).not.toHaveBeenCalledWith(admin.id);
        expect(lastIntent()).toMatchObject({ customerId: `cus_of_${client.id}`, userId: client.id, savePaymentMethod: false });
        // Nada é gravado como cartão salvo na criação do PI (quem grava é o webhook, só com setup_future_usage).
        expect(await prisma.savedPaymentMethod.count()).toBe(0);
    });

    it('sem o campo (chamador antigo) → o backend NÃO assume salvar', async () => {
        const { client, payment } = await installment();
        const r = await card(client, payment.id);
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        expect(lastIntent().savePaymentMethod).toBeFalsy();
    });
});

// ─── CHK-2 ───────────────────────────────────────────────────────────────────────────────────────
describe('CHK-2 — cobrança à vista no preço PIX: só a cotação conhece o preço do cartão', () => {
    beforeEach(async () => { await setup(); });
    const mark = { pixDiscount: { pct: 5, cardAmount: 84000, pixAmount: 79800 } };

    it('installment-plans devolve cardAmount (840) ≠ amount (798) e pixAmount (798); o plano 1x é o preço de cartão', async () => {
        const { client, payment } = await installment({ contract: { paymentPlan: 'FULL', paymentMethod: 'PIX' }, payment: { amount: 79800, provider: 'SICOOB', metadata: mark } });

        const q = await call('POST', '/api/stripe/installment-plans', client, { paymentId: payment.id, amount: 79800, contractDurationMonths: 3 });

        expect(q.status, JSON.stringify(q.body)).toBe(200);
        expect(q.body.cardAmount).toBe(84000);
        expect(q.body.pixAmount).toBe(79800);
        expect(q.body.plans.find((p: any) => p.count === 1)).toMatchObject({ total: 84000 });
    });

    it('create-payment no cartão cobra o cardAmount (840), nunca o amount exibido sem cotação (798) — e devolve o valor cobrado', async () => {
        const { client, payment } = await installment({ contract: { paymentPlan: 'FULL', paymentMethod: 'PIX' }, payment: { amount: 79800, provider: 'SICOOB', metadata: mark } });

        const r = await card(client, payment.id, { savePaymentMethod: false });

        expect(r.status, JSON.stringify(r.body)).toBe(200);
        expect(r.body.amount).toBe(84000); // é o que o formulário do cartão NOVO mostra antes de confirmar
        expect(lastIntent().amount).toBe(84000);
        const row = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
        expect(row.chargedAmount).toBe(84000);
    });

    it('cobrança sem marca (mensal): cotação e cobrança ficam no próprio amount — nada a confirmar', async () => {
        const { client, payment } = await installment();
        const q = await call('POST', '/api/stripe/installment-plans', client, { paymentId: payment.id });
        expect(q.body).toMatchObject({ cardAmount: 84000, pixAmount: 84000 });
        const r = await card(client, payment.id);
        expect(r.body.amount).toBe(84000);
    });
});

// ─── SEC-3 (consumidor) ──────────────────────────────────────────────────────────────────────────
describe('SEC-3 — a tela de Configurações lê o estado COMPLETO do boleto de /payment-methods/all (ADMIN)', () => {
    it('Cora inativa: a rota pública só diz "indisponível"; o /all traz chave, Cora, motivo e a mensagem do aviso', async () => {
        await setup({ boleto: false, cora: false });
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser();

        const pub = await call('GET', '/api/pricing/payment-methods');
        expect(pub.status).toBe(200);
        expect(pub.body.boleto).toEqual({ enabled: false, providerEnabled: false, available: false, reason: null, message: null });

        const all = await call('GET', '/api/pricing/payment-methods/all', admin);
        expect(all.status).toBe(200);
        expect(all.body.boleto).toMatchObject({ enabled: false, providerEnabled: false, available: false, reason: 'PROVIDER_DISABLED' });
        expect(all.body.boleto.message).toMatch(/Cora/);

        // O estado completo é só do ADMIN.
        expect((await call('GET', '/api/pricing/payment-methods/all', client)).status).toBe(403);
        expect((await call('GET', '/api/pricing/payment-methods/all')).status).toBe(401);
    });

    it('chave ligada com a Cora desativada depois: público = indisponível (sem dizer por quê); /all = chave ligada + Cora inativa', async () => {
        await setup({ boleto: true, cora: false });
        const admin = await mkUser({ role: 'ADMIN' });

        const pub = await call('GET', '/api/pricing/payment-methods');
        expect(pub.body.boleto).toEqual({ enabled: false, providerEnabled: false, available: false, reason: null, message: null });
        expect(pub.body.methods.map((x: any) => x.key)).toEqual(['PIX', 'CARTAO']);

        const all = await call('GET', '/api/pricing/payment-methods/all', admin);
        expect(all.body.boleto).toMatchObject({ enabled: true, providerEnabled: false, available: false, reason: 'PROVIDER_DISABLED' });
    });

    it('boleto efetivo: público e /all concordam em available=true; o método BOLETO vem com o contexto "avulso" (aba no sheet da avulsa do admin)', async () => {
        await setup({ boleto: true, cora: true });
        const admin = await mkUser({ role: 'ADMIN' });

        const pub = await call('GET', '/api/pricing/payment-methods');
        expect(pub.body.boleto).toEqual({ enabled: true, providerEnabled: true, available: true, reason: null, message: null });
        const boleto = pub.body.methods.find((x: any) => x.key === 'BOLETO');
        expect(boleto).toBeTruthy();
        // CHK-3/COV-1: o ChargeNowSheet filtra a aba por contexto — o padrão inclui `avulso` e `contract`.
        expect(String(boleto.contexts ?? 'avulso,contract,invoice').split(',')).toEqual(expect.arrayContaining(['avulso', 'contract']));

        const all = await call('GET', '/api/pricing/payment-methods/all', admin);
        expect(all.body.boleto).toMatchObject({ enabled: true, providerEnabled: true, available: true, reason: null });
    });
});

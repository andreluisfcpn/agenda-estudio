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
        stripeGetCard: vi.fn(),
        stripeListPaymentMethods: vi.fn(),
        stripeGetPaymentIntent: vi.fn(),
        stripeCancelPaymentIntent: vi.fn(async () => ({ status: 'canceled', canceled: true })),
        stripeChargeOffSession: vi.fn(),
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
import * as sicoob from '../../src/lib/sicoobService';
import * as stripe from '../../src/lib/stripeService';
import { buildStaticBrCode } from '../../src/lib/brcode';
import { runAutoChargeJob } from '../../src/jobs/autoChargeJob';
import stripeRoutes from '../../src/modules/stripe/routes';
import { mkUser, mkContract, mkPayment, mkCpf } from './factories';

// E1 (decisão do dono, 30/09/2026) — o admin cobrando o CLIENTE ("Cobrar 1ª parcela" / "Cobrar"):
//  • os cartões salvos listados são os do CLIENTE dono do pagamento (GET /stripe/payment-methods/for-payment/:id);
//  • create-payment do admin aceita o cartão salvo do CLIENTE (id do SavedPaymentMethod ou pm_…) e recusa
//    qualquer cartão que não seja do dono do pagamento (inclusive o do próprio admin);
//  • o CPF exigido no PIX é o do dono do pagamento, nunca o do admin.
// E13: a multa de cancelamento (metadata.kind = 'CANCELLATION_FINE') é pagável por PIX/cartão mesmo com o
// contrato CANCELLED — pelo cliente e pelo "Cobrar agora" do admin — e nunca entra no auto-charge.

type Who = { id: string; email: string | null; role: string };
const m = <T extends (...a: any[]) => any>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>;
const secondsAgo = (s: number) => new Date(Date.now() - s * 1000);

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

/** Cartões "no Stripe" deste teste: pm → dono (Customer) e tipo. */
let stripeCards: Record<string, { customerId: string | null; funding: string; last4: string }> = {};

beforeEach(async () => {
    vi.clearAllMocks();
    stripeCards = {};
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
    m(stripe.stripeGetPaymentIntent).mockResolvedValue(undefined);
    m(stripe.stripeCreatePaymentIntent).mockImplementation(async (o: { paymentId: string; amount: number }) => ({
        clientSecret: `cs_${o.paymentId}`, paymentIntentId: `pi_new_${o.paymentId.slice(0, 8)}_${o.amount}`, status: 'succeeded',
    }));
    // Customer do PAGADOR: devolve o stripeCustomerId do usuário pedido (nunca o do admin por engano).
    m(stripe.stripeGetOrCreateCustomer).mockImplementation(async (userId: string) =>
        (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).stripeCustomerId ?? `cus_created_${userId.slice(0, 6)}`);
    const infoOf = (pm: string) => ({ paymentMethodId: pm, brand: 'visa', last4: stripeCards[pm]!.last4, expMonth: 12, expYear: 2031, funding: stripeCards[pm]!.funding });
    m(stripe.stripeGetCard).mockImplementation(async (pm: string) => (stripeCards[pm] ? { ...infoOf(pm), customerId: stripeCards[pm]!.customerId } : null));
    m(stripe.stripeListPaymentMethods).mockImplementation(async (customerId: string) =>
        Object.keys(stripeCards).filter(pm => stripeCards[pm]!.customerId === customerId).map(infoOf));
    for (const [i, key] of ['PIX', 'CARTAO'].entries()) {
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

async function saveCard(userId: string, customerId: string, pm: string, over: { isDefault?: boolean; last4?: string; funding?: string } = {}) {
    stripeCards[pm] = { customerId, funding: over.funding ?? 'credit', last4: over.last4 ?? '4242' };
    return prisma.savedPaymentMethod.create({
        data: { userId, stripePaymentMethodId: pm, brand: 'visa', last4: over.last4 ?? '4242', expMonth: 12, expYear: 2031, isDefault: over.isDefault ?? false },
    });
}

/** Admin COM cartão e CPF próprios (para provar que nunca são usados) + cliente com 1ª parcela pendente. */
async function scene(clientOver: Record<string, unknown> = {}) {
    const admin = await mkUser({ role: 'ADMIN', stripeCustomerId: 'cus_admin', cpfCnpj: mkCpf() });
    const adminCard = await saveCard(admin.id, 'cus_admin', 'pm_admin', { isDefault: true, last4: '9999' });
    const client = await mkUser({ stripeCustomerId: 'cus_client', cpfCnpj: mkCpf(), ...clientOver });
    const contract = await mkContract(client.id, { type: 'FIXO', paymentPlan: 'MONTHLY', paymentMethod: 'CARTAO' });
    const payment = await mkPayment(client.id, { contractId: contract.id, provider: 'STRIPE', amount: 84000, dueDate: secondsAgo(60) });
    return { admin, adminCard, client, contract, payment };
}

const row = (id: string) => prisma.payment.findUniqueOrThrow({ where: { id } });
const byCard = (who: Who, paymentId: string, savedPaymentMethodId?: string) =>
    call('POST', '/api/stripe/create-payment', who, { paymentId, paymentMethod: 'cartao', installments: 1, ...(savedPaymentMethodId ? { savedPaymentMethodId } : {}) });
const byPix = (who: Who, paymentId: string) => call('POST', '/api/stripe/create-payment', who, { paymentId, paymentMethod: 'pix' });

// ─── 1) Cartões do CLIENTE para o admin ──────────────────────────────────────────────────────────
describe('E1 — GET /stripe/payment-methods/for-payment/:paymentId (ADMIN): os cartões são os do cliente', () => {
    it('lista os cartões do dono do pagamento (padrão primeiro nos dados do banco; funding do Stripe) e o pagador com o CPF — nunca os do admin', async () => {
        const { admin, client, payment } = await scene({ autoChargeEnabled: true });
        const c1 = await saveCard(client.id, 'cus_client', 'pm_c1', { isDefault: true, last4: '1111' });
        stripeCards.pm_c2 = { customerId: 'cus_client', funding: 'debit', last4: '2222' }; // só no Stripe (webhook ainda não sincronizou)

        const r = await call('GET', `/api/stripe/payment-methods/for-payment/${payment.id}`, admin);

        expect(r.status).toBe(200);
        expect(r.body.paymentMethods).toEqual([
            { id: c1.id, stripePaymentMethodId: 'pm_c1', brand: 'visa', last4: '1111', expMonth: 12, expYear: 2031, funding: 'credit', isDefault: true },
            { id: 'pm_c2', stripePaymentMethodId: 'pm_c2', brand: 'visa', last4: '2222', expMonth: 12, expYear: 2031, funding: 'debit', isDefault: false },
        ]);
        expect(r.body.paymentMethods.some((c: any) => c.last4 === '9999')).toBe(false);
        expect(r.body.payer).toEqual({ id: client.id, name: client.name, cpfCnpj: client.cpfCnpj, hasValidCpfCnpj: true, deleted: false });
        expect(r.body.autoChargeEnabled).toBe(true);
        expect(stripe.stripeListPaymentMethods).toHaveBeenCalledWith('cus_client');
        expect(stripe.stripeGetOrCreateCustomer).not.toHaveBeenCalled(); // listar nunca cria Customer
    });

    it('cliente sem Customer/cartão → lista vazia (sem criar Customer); cliente sem CPF → hasValidCpfCnpj false', async () => {
        const { admin, payment } = await scene({ stripeCustomerId: null, cpfCnpj: null });
        const r = await call('GET', `/api/stripe/payment-methods/for-payment/${payment.id}`, admin);
        expect(r.status).toBe(200);
        expect(r.body.paymentMethods).toEqual([]);
        expect(r.body.payer).toMatchObject({ cpfCnpj: null, hasValidCpfCnpj: false });
        expect(stripe.stripeListPaymentMethods).not.toHaveBeenCalled();
        expect(stripe.stripeGetOrCreateCustomer).not.toHaveBeenCalled();
    });

    it('Stripe fora do ar ou desligado → cai para os cartões do banco (funding desconhecido)', async () => {
        const { admin, client, payment } = await scene();
        const c1 = await saveCard(client.id, 'cus_client', 'pm_c1', { isDefault: true, last4: '1111' });
        m(stripe.stripeListPaymentMethods).mockRejectedValueOnce(new Error('connection reset'));
        const down = await call('GET', `/api/stripe/payment-methods/for-payment/${payment.id}`, admin);
        expect(down.status).toBe(200);
        expect(down.body.paymentMethods).toEqual([
            { id: c1.id, stripePaymentMethodId: 'pm_c1', brand: 'visa', last4: '1111', expMonth: 12, expYear: 2031, funding: 'unknown', isDefault: true },
        ]);
        m(stripe.isStripeEnabled).mockResolvedValue(false);
        const off = await call('GET', `/api/stripe/payment-methods/for-payment/${payment.id}`, admin);
        expect(off.body.paymentMethods.map((c: any) => c.id)).toEqual([c1.id]);
    });

    it('só ADMIN (cliente → 403, sem login → 401); pagamento inexistente → 404; id inválido → 400', async () => {
        const { admin, client, payment } = await scene();
        expect((await call('GET', `/api/stripe/payment-methods/for-payment/${payment.id}`, client)).status).toBe(403);
        expect((await call('GET', `/api/stripe/payment-methods/for-payment/${payment.id}`)).status).toBe(401);
        expect((await call('GET', '/api/stripe/payment-methods/for-payment/11111111-1111-4111-8111-111111111111', admin)).status).toBe(404);
        expect((await call('GET', '/api/stripe/payment-methods/for-payment/nao-e-uuid', admin)).status).toBe(400);
    });

    it('GET /stripe/payment-methods (sem :paymentId) continua devolvendo os cartões de QUEM está logado', async () => {
        const { admin } = await scene();
        const r = await call('GET', '/api/stripe/payment-methods', admin);
        expect(r.status).toBe(200);
        expect(r.body.paymentMethods.map((c: any) => c.last4)).toEqual(['9999']);
    });
});

// ─── 2) create-payment com o cartão salvo do cliente ─────────────────────────────────────────────
describe('E1 — POST /stripe/create-payment (cartão salvo): só o cartão do DONO do pagamento', () => {
    it('admin cobra o cartão salvo do CLIENTE (pelo id do banco e pelo pm_…): PaymentIntent no Customer e no cartão do cliente', async () => {
        const { admin, client, payment } = await scene();
        const card = await saveCard(client.id, 'cus_client', 'pm_client', { isDefault: true });

        const r = await byCard(admin, payment.id, card.id);
        expect(r.status).toBe(200);
        expect(stripe.stripeGetOrCreateCustomer).toHaveBeenCalledWith(client.id);
        expect(m(stripe.stripeCreatePaymentIntent).mock.calls[0]![0]).toMatchObject({
            amount: 84000, customerId: 'cus_client', userId: client.id, paymentId: payment.id, savedPaymentMethodId: 'pm_client',
        });
        expect(await row(payment.id)).toMatchObject({ provider: 'STRIPE', chargedAmount: 84000, providerRef: r.body.paymentIntentId });

        const second = await mkPayment(client.id, { contractId: payment.contractId, provider: 'STRIPE', amount: 84000 });
        const byPm = await byCard(admin, second.id, 'pm_client');
        expect(byPm.status).toBe(200);
        expect(m(stripe.stripeCreatePaymentIntent).mock.calls[1]![0]).toMatchObject({ customerId: 'cus_client', savedPaymentMethodId: 'pm_client' });
    });

    it('admin tenta o PRÓPRIO cartão (ou o de outro cliente) → 400 CARD_NOT_FOUND, nenhum PaymentIntent, cobrança intacta', async () => {
        const { admin, adminCard, payment } = await scene();
        const stranger = await mkUser({ stripeCustomerId: 'cus_stranger' });
        const strangerCard = await saveCard(stranger.id, 'cus_stranger', 'pm_stranger');
        stripeCards.pm_floating = { customerId: null, funding: 'credit', last4: '0000' };

        for (const ref of [adminCard.id, 'pm_admin', strangerCard.id, 'pm_stranger', 'pm_floating', 'pm_nao_existe']) {
            const r = await byCard(admin, payment.id, ref);
            expect(r.status, ref).toBe(400);
            expect(r.body.code).toBe('CARD_NOT_FOUND');
            expect(r.body.error).toMatch(/não pertence ao cliente/);
        }
        expect(stripe.stripeCreatePaymentIntent).not.toHaveBeenCalled();
        expect(await row(payment.id)).toMatchObject({ status: 'PENDING', providerRef: null, chargedAmount: null });
    });

    it('cliente: o próprio cartão funciona (inclusive um que só existe no Stripe); o cartão de outra pessoa → 400', async () => {
        const { admin, adminCard, client, payment } = await scene();
        expect(admin.id).not.toBe(client.id);
        const denied = await byCard(client, payment.id, adminCard.id);
        expect(denied.status).toBe(400);
        expect(denied.body.code).toBe('CARD_NOT_FOUND');
        expect((await byCard(client, payment.id, 'pm_admin')).status).toBe(400);
        expect(stripe.stripeCreatePaymentIntent).not.toHaveBeenCalled();

        stripeCards.pm_only_stripe = { customerId: 'cus_client', funding: 'credit', last4: '5555' };
        const ok = await byCard(client, payment.id, 'pm_only_stripe');
        expect(ok.status).toBe(200);
        expect(m(stripe.stripeCreatePaymentIntent).mock.calls[0]![0]).toMatchObject({ customerId: 'cus_client', savedPaymentMethodId: 'pm_only_stripe' });
    });

    it('cartão NOVO (sem savedPaymentMethodId) pelo admin: PaymentIntent no Customer do cliente, podendo salvar o cartão para ele', async () => {
        const { admin, client, payment } = await scene();
        const r = await call('POST', '/api/stripe/create-payment', admin, { paymentId: payment.id, paymentMethod: 'cartao', installments: 1, savePaymentMethod: true });
        expect(r.status).toBe(200);
        expect(stripe.stripeGetOrCreateCustomer).toHaveBeenCalledWith(client.id);
        const opts = m(stripe.stripeCreatePaymentIntent).mock.calls[0]![0];
        expect(opts).toMatchObject({ customerId: 'cus_client', userId: client.id, savePaymentMethod: true });
        expect(opts.savedPaymentMethodId).toBeUndefined();
    });
});

// ─── 3) PIX: o CPF é o do cliente ────────────────────────────────────────────────────────────────
describe('E1 — PIX cobrado pelo admin usa o CPF/CNPJ do DONO do pagamento', () => {
    it('admin sem CPF cobrando cliente COM CPF → QR emitido no CPF do cliente', async () => {
        const { admin, client, payment } = await scene();
        await prisma.user.update({ where: { id: admin.id }, data: { cpfCnpj: null } });
        const r = await byPix(admin, payment.id);
        expect(r.status).toBe(200);
        expect(r.body.amount).toBe(84000);
        expect(m(sicoob.sicoobCreatePix).mock.calls[0]![0].customer).toMatchObject({ name: client.name, document: { identity: client.cpfCnpj, type: 'CPF' } });
    });

    it('admin COM CPF cobrando cliente SEM CPF → 400 CPF_CNPJ_REQUIRED (do cliente); nada é emitido no CPF do admin', async () => {
        const { admin, client, payment } = await scene({ cpfCnpj: null });
        const r = await byPix(admin, payment.id);
        expect(r.status).toBe(400);
        expect(r.body).toMatchObject({ code: 'CPF_CNPJ_REQUIRED', payerUserId: client.id });
        expect(r.body.error).toMatch(/O cliente não tem CPF\/CNPJ/);
        expect(sicoob.sicoobCreatePix).not.toHaveBeenCalled();
        expect((await row(payment.id)).pixString).toBeNull();

        // O próprio cliente sem CPF recebe a mensagem dele (mesmo código).
        const own = await byPix(client, payment.id);
        expect(own.status).toBe(400);
        expect(own.body.code).toBe('CPF_CNPJ_REQUIRED');
        expect(own.body.error).toMatch(/Atualize o perfil/);

        // Depois de cadastrar o CPF do CLIENTE, o mesmo pedido do admin emite o QR.
        const cpf = mkCpf();
        await prisma.user.update({ where: { id: client.id }, data: { cpfCnpj: cpf } });
        const ok = await byPix(admin, payment.id);
        expect(ok.status).toBe(200);
        expect(m(sicoob.sicoobCreatePix).mock.calls[0]![0].customer.document.identity).toBe(cpf);
    });
});

// ─── 4) Multa de cancelamento: pagável com o contrato CANCELLED ──────────────────────────────────
describe('E13 (pagamentos) — a multa de cancelamento é pagável por PIX/cartão com o contrato CANCELLED e nunca é cobrada sozinha', () => {
    async function fineScene() {
        const s = await scene({ autoChargeEnabled: true });
        await saveCard(s.client.id, 'cus_client', 'pm_client', { isDefault: true });
        await prisma.contract.update({ where: { id: s.contract.id }, data: { status: 'CANCELLED' } });
        await prisma.payment.update({ where: { id: s.payment.id }, data: { status: 'CANCELLED' } }); // parcela anulada
        const fine = await mkPayment(s.client.id, {
            contractId: s.contract.id, provider: 'STRIPE', amount: 33600, dueDate: secondsAgo(86_400),
            metadata: { kind: 'CANCELLATION_FINE', finePct: 20, baseAmount: 168000 },
        });
        return { ...s, fine };
    }

    it('cliente paga a multa no PIX (valor cheio, sem desconto) e a parcela anulada continua recusada', async () => {
        const { client, payment, fine } = await fineScene();
        const plans = await call('POST', '/api/stripe/installment-plans', client, { paymentId: fine.id });
        expect(plans.status).toBe(200);
        expect(plans.body).toMatchObject({ cardAmount: 33600, pixAmount: 33600 });
        expect(plans.body.plans.map((p: any) => p.count)).toEqual([1]);

        const pix = await byPix(client, fine.id);
        expect(pix.status).toBe(200);
        expect(pix.body.amount).toBe(33600);
        expect(pix.body.pixString).toBeTruthy();
        expect(await row(fine.id)).toMatchObject({ status: 'PENDING', amount: 33600, provider: 'SICOOB' });
        expect(((await row(fine.id)).metadata as any).kind).toBe('CANCELLATION_FINE'); // a identidade da multa sobrevive ao PIX

        const voided = await byPix(client, payment.id);
        expect(voided.status).toBe(400);
        expect(voided.body.error).toMatch(/cancelado/);
    });

    it('cliente paga a multa no cartão; o admin ("Cobrar agora") cobra no PIX ou no cartão salvo do cliente', async () => {
        const { admin, client, fine } = await fineScene();
        const card = await byCard(client, fine.id);
        expect(card.status).toBe(200);
        expect(m(stripe.stripeCreatePaymentIntent).mock.calls[0]![0]).toMatchObject({ amount: 33600, customerId: 'cus_client' });
        expect(((await row(fine.id)).metadata as any).kind).toBe('CANCELLATION_FINE');

        const other = await fineScene2(client.id);
        const adminPix = await byPix(admin, other.id);
        expect(adminPix.status).toBe(200);
        expect(m(sicoob.sicoobCreatePix).mock.calls[0]![0].customer.document.identity).toBe(client.cpfCnpj);

        const third = await fineScene2(client.id);
        const adminCard = await byCard(admin, third.id, 'pm_client');
        expect(adminCard.status).toBe(200);
        expect(m(stripe.stripeCreatePaymentIntent).mock.calls[1]![0]).toMatchObject({ amount: 33600, customerId: 'cus_client', savedPaymentMethodId: 'pm_client' });
    });

    /** Outra multa pendente num contrato CANCELLED do mesmo cliente. */
    async function fineScene2(clientId: string) {
        const c = await mkContract(clientId, { status: 'CANCELLED' });
        return mkPayment(clientId, { contractId: c.id, provider: 'STRIPE', amount: 33600, dueDate: secondsAgo(86_400), metadata: { kind: 'CANCELLATION_FINE', finePct: 20, baseAmount: 168000 } });
    }

    it('auto-charge ligado, cartão padrão e multa vencida: o job NÃO cobra a multa', async () => {
        const { fine } = await fineScene();
        await runAutoChargeJob();
        expect(stripe.stripeChargeOffSession).not.toHaveBeenCalled();
        expect(await row(fine.id)).toMatchObject({ status: 'PENDING', providerRef: null, chargedAmount: null });
    });
});

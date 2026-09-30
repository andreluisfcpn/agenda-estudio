import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// ─── Mock do Stripe: nenhuma chamada de rede real ────────────────────────────────────────────────
vi.mock('../../src/lib/stripeService', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../../src/lib/stripeService')>();
    return {
        ...orig,
        isStripeEnabled: vi.fn(async () => true),
        stripeGetCard: vi.fn(),
        stripeGetSetupIntent: vi.fn(),
        stripeCreateSetupIntent: vi.fn(async () => ({ clientSecret: 'seti_secret', setupIntentId: 'seti_1' })),
        stripeSetDefaultPaymentMethod: vi.fn(async () => undefined),
        stripeListPaymentMethods: vi.fn(async () => []),
        stripeChargeOffSession: vi.fn(),
        stripeGetPaymentIntent: vi.fn(),
        stripeGetOrCreateCustomer: vi.fn(async () => 'cus_new'),
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
import { runAutoChargeJob } from '../../src/jobs/autoChargeJob';
import contractRoutes from '../../src/modules/contracts/routes';
import stripeRoutes from '../../src/modules/stripe/routes';
import { mkUser, mkContract, mkPayment } from './factories';

// E9 (decisão do dono, 30/09/2026) — "Ativar cobrança automática" usa o mecanismo CORRETO:
// User.autoChargeEnabled + cartão padrão + autoChargeJob. POST /contracts/:id/subscribe NÃO cria mais
// assinatura Stripe nem Payment (a assinatura paralela cobrava em dobro): liga a cobrança automática do
// CLIENTE com o cartão informado como padrão (id do SavedPaymentMethod OU pm_…), só crédito, idempotente.
// O cartão novo é cadastrado por SetupIntent e persistido por POST /stripe/setup-intent/confirm.
// A multa de cancelamento (metadata.kind = 'CANCELLATION_FINE') nunca entra no auto-charge.

type Who = { id: string; email: string | null; role: string };
const m = <T extends (...a: any[]) => any>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>;
const secondsAgo = (s: number) => new Date(Date.now() - s * 1000);
const daysAhead = (d: number) => new Date(Date.now() + d * 86_400_000);

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

/** Cartões "no Stripe" deste teste: pm → { customerId, funding }. */
let stripeCards: Record<string, { customerId: string | null; funding: string; brand?: string; last4?: string }> = {};

beforeEach(async () => {
    vi.clearAllMocks();
    stripeCards = {};
    m(stripe.isStripeEnabled).mockResolvedValue(true);
    m(stripe.stripeSetDefaultPaymentMethod).mockResolvedValue(undefined);
    m(stripe.stripeGetCard).mockImplementation(async (pm: string) => {
        const c = stripeCards[pm];
        if (!c) return null;
        return { paymentMethodId: pm, brand: c.brand ?? 'visa', last4: c.last4 ?? '4242', expMonth: 12, expYear: 2031, funding: c.funding, customerId: c.customerId };
    });
    m(stripe.stripeChargeOffSession).mockImplementation(async (_c: string, _pm: string, _amt: number, meta: { paymentId: string }) =>
        ({ clientSecret: '', paymentIntentId: `pi_auto_${meta.paymentId.slice(0, 8)}`, status: 'succeeded' }));
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

let seq = 0;
/** Cliente com Customer no Stripe e um contrato FIXO mensal: 1 parcela paga + 2 pendentes (a 2ª vence hoje). */
async function clientWithPlan(over: Record<string, unknown> = {}) {
    const n = ++seq;
    const user = await mkUser({ stripeCustomerId: `cus_${n}`, ...over });
    const contract = await mkContract(user.id, { type: 'FIXO', paymentPlan: 'MONTHLY', paymentMethod: 'CARTAO', durationMonths: 3 });
    const paid = await mkPayment(user.id, { contractId: contract.id, provider: 'STRIPE', amount: 84000, status: 'PAID', paidAt: secondsAgo(86400), dueDate: secondsAgo(28 * 86400) });
    const due = await mkPayment(user.id, { contractId: contract.id, provider: 'STRIPE', amount: 84000, dueDate: secondsAgo(60) });
    const future = await mkPayment(user.id, { contractId: contract.id, provider: 'STRIPE', amount: 84000, dueDate: daysAhead(28) });
    return { user, contract, paid, due, future, customerId: `cus_${n}` };
}

async function savedCard(userId: string, customerId: string | null, pm: string, over: { isDefault?: boolean; funding?: string; last4?: string } = {}) {
    stripeCards[pm] = { customerId, funding: over.funding ?? 'credit', last4: over.last4 };
    return prisma.savedPaymentMethod.create({
        data: { userId, stripePaymentMethodId: pm, brand: 'visa', last4: over.last4 ?? '4242', expMonth: 12, expYear: 2031, isDefault: over.isDefault ?? false },
    });
}

const userRow = (id: string) => prisma.user.findUniqueOrThrow({ where: { id } });
const cardsOf = (userId: string) => prisma.savedPaymentMethod.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
const subscribe = (who: Who, contractId: string, paymentMethodId: string) =>
    call('POST', `/api/contracts/${contractId}/subscribe`, who, { paymentMethodId });

// ─── 1) /subscribe liga a cobrança automática (sem assinatura, sem cobrança nova) ────────────────
describe('E9 — POST /contracts/:id/subscribe liga User.autoChargeEnabled + cartão padrão', () => {
    it('com o id do cartão salvo: NÃO cria Payment nem assinatura; liga a cobrança automática e torna o cartão o padrão', async () => {
        const { user, contract, customerId } = await clientWithPlan();
        const old = await savedCard(user.id, customerId, 'pm_old', { isDefault: true, last4: '1111' });
        const chosen = await savedCard(user.id, customerId, 'pm_chosen', { last4: '4242' });
        const before = await prisma.payment.findMany({ where: { contractId: contract.id }, orderBy: { id: 'asc' } });

        const r = await subscribe(user, contract.id, chosen.id);

        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({
            success: true, autoChargeEnabled: true, alreadyEnabled: false, scope: 'USER',
            defaultCard: { id: chosen.id, stripePaymentMethodId: 'pm_chosen', last4: '4242', funding: 'credit', isDefault: true },
        });
        expect(r.body.subscriptionId).toBeUndefined();
        expect(r.body.message).toMatch(/todos os seus contratos/);

        // Nada de cobrança em dobro: as MESMAS 3 parcelas, intactas, sem stripeSubscriptionId.
        const after = await prisma.payment.findMany({ where: { contractId: contract.id }, orderBy: { id: 'asc' } });
        expect(after).toEqual(before);
        expect(after.every(p => p.stripeSubscriptionId === null)).toBe(true);
        expect(await prisma.payment.count()).toBe(3);

        expect((await userRow(user.id)).autoChargeEnabled).toBe(true);
        const cards = await cardsOf(user.id);
        expect(cards.find(c => c.id === chosen.id)!.isDefault).toBe(true);
        expect(cards.find(c => c.id === old.id)!.isDefault).toBe(false);
        expect(stripe.stripeSetDefaultPaymentMethod).toHaveBeenCalledWith(customerId, 'pm_chosen');
        expect(await prisma.auditLog.count({ where: { entityType: 'USER', entityId: user.id, action: 'AUTO_CHARGE_ENABLED' } })).toBe(1);
    });

    it('com o pm_… de um cartão recém-cadastrado (ainda só no Stripe): grava o cartão, torna-o padrão e ativa', async () => {
        const { user, contract, customerId } = await clientWithPlan();
        stripeCards.pm_fresh = { customerId, funding: 'credit', last4: '0005', brand: 'mastercard' };

        const r = await subscribe(user, contract.id, 'pm_fresh');

        expect(r.status).toBe(200);
        const cards = await cardsOf(user.id);
        expect(cards).toHaveLength(1);
        expect(cards[0]).toMatchObject({ stripePaymentMethodId: 'pm_fresh', brand: 'mastercard', last4: '0005', isDefault: true });
        expect(r.body.defaultCard.id).toBe(cards[0]!.id);
        expect((await userRow(user.id)).autoChargeEnabled).toBe(true);
    });

    it('idempotente: repetir devolve alreadyEnabled sem tocar o Stripe nem duplicar a auditoria; trocar de cartão muda o padrão', async () => {
        const { user, contract, customerId } = await clientWithPlan();
        const a = await savedCard(user.id, customerId, 'pm_a');
        const b = await savedCard(user.id, customerId, 'pm_b');
        expect((await subscribe(user, contract.id, a.id)).status).toBe(200);
        m(stripe.stripeSetDefaultPaymentMethod).mockClear();

        const again = await subscribe(user, contract.id, 'pm_a'); // o mesmo cartão, agora pelo pm_…
        expect(again.status).toBe(200);
        expect(again.body).toMatchObject({ autoChargeEnabled: true, alreadyEnabled: true, defaultCard: { id: a.id } });
        expect(stripe.stripeSetDefaultPaymentMethod).not.toHaveBeenCalled();
        expect(await prisma.auditLog.count({ where: { entityId: user.id, action: 'AUTO_CHARGE_ENABLED' } })).toBe(1);
        expect(await prisma.payment.count()).toBe(3);

        const swap = await subscribe(user, contract.id, b.id);
        expect(swap.status).toBe(200);
        expect(swap.body).toMatchObject({ alreadyEnabled: false, defaultCard: { id: b.id, isDefault: true } });
        const cards = await cardsOf(user.id);
        expect(cards.filter(c => c.isDefault).map(c => c.id)).toEqual([b.id]);
    });

    it('cartão de OUTRO cliente (id do banco ou pm_…) → 404 CARD_NOT_FOUND; nada muda', async () => {
        const { user, contract } = await clientWithPlan();
        const other = await clientWithPlan();
        const theirs = await savedCard(other.user.id, other.customerId, 'pm_theirs', { isDefault: true });
        stripeCards.pm_loose = { customerId: other.customerId, funding: 'credit' }; // no Stripe, de outro Customer
        stripeCards.pm_nobody = { customerId: null, funding: 'credit' };            // não anexado a ninguém

        for (const ref of [theirs.id, 'pm_theirs', 'pm_loose', 'pm_nobody', 'pm_inexistente', 'qualquer-coisa']) {
            const r = await subscribe(user, contract.id, ref);
            expect(r.status, ref).toBe(404);
            expect(r.body.code).toBe('CARD_NOT_FOUND');
        }
        expect((await userRow(user.id)).autoChargeEnabled).toBe(false);
        expect(await cardsOf(user.id)).toHaveLength(0);
        expect((await cardsOf(other.user.id)).map(c => c.id)).toEqual([theirs.id]);
        expect(stripe.stripeSetDefaultPaymentMethod).not.toHaveBeenCalled();
    });

    it('só CRÉDITO: débito e pré-pago → 400 CARD_NOT_CREDIT; "unknown" é aceito', async () => {
        const { user, contract, customerId } = await clientWithPlan();
        const debit = await savedCard(user.id, customerId, 'pm_debit', { funding: 'debit' });
        const prepaid = await savedCard(user.id, customerId, 'pm_prepaid', { funding: 'prepaid' });
        const unknown = await savedCard(user.id, customerId, 'pm_unknown', { funding: 'unknown' });
        for (const c of [debit, prepaid]) {
            const r = await subscribe(user, contract.id, c.id);
            expect(r.status).toBe(400);
            expect(r.body.code).toBe('CARD_NOT_CREDIT');
        }
        expect((await userRow(user.id)).autoChargeEnabled).toBe(false);
        expect((await cardsOf(user.id)).some(c => c.isDefault)).toBe(false);

        expect((await subscribe(user, contract.id, unknown.id)).status).toBe(200);
        expect((await userRow(user.id)).autoChargeEnabled).toBe(true);
    });

    it('cartão salvo no banco que não existe mais no Stripe (removido lá) → 404; falha de rede na conferência → 502; nada muda', async () => {
        const { user, contract, customerId } = await clientWithPlan();
        const stale = await savedCard(user.id, customerId, 'pm_stale');
        delete stripeCards.pm_stale;
        expect((await subscribe(user, contract.id, stale.id)).status).toBe(404);

        const ok = await savedCard(user.id, customerId, 'pm_ok');
        m(stripe.stripeGetCard).mockRejectedValueOnce(new Error('connection reset'));
        const down = await subscribe(user, contract.id, ok.id);
        expect(down.status).toBe(502);
        m(stripe.stripeSetDefaultPaymentMethod).mockRejectedValueOnce(new Error('stripe 500'));
        expect((await subscribe(user, contract.id, ok.id)).status).toBe(502);
        expect((await userRow(user.id)).autoChargeEnabled).toBe(false);
        expect((await cardsOf(user.id)).some(c => c.isDefault)).toBe(false);
    });

    it('contrato de outro cliente → 404; cancelado → 400; à vista quitado → 400 NOTHING_TO_CHARGE; à vista com cobrança pendente → 200', async () => {
        const { user, customerId } = await clientWithPlan();
        const card = await savedCard(user.id, customerId, 'pm_1');
        const other = await clientWithPlan();
        expect((await subscribe(user, other.contract.id, card.id)).status).toBe(404);

        const cancelled = await mkContract(user.id, { status: 'CANCELLED' });
        const c1 = await subscribe(user, cancelled.id, card.id);
        expect(c1.status).toBe(400);
        expect(c1.body.code).toBe('CONTRACT_CANCELLED');

        const fullPaid = await mkContract(user.id, { type: 'FLEX', paymentPlan: 'FULL' });
        await mkPayment(user.id, { contractId: fullPaid.id, amount: 315000, status: 'PAID', paidAt: new Date() });
        const c2 = await subscribe(user, fullPaid.id, card.id);
        expect(c2.status).toBe(400);
        expect(c2.body.code).toBe('NOTHING_TO_CHARGE');
        expect((await userRow(user.id)).autoChargeEnabled).toBe(false);

        const fullPending = await mkContract(user.id, { type: 'FLEX', paymentPlan: 'FULL' });
        await mkPayment(user.id, { contractId: fullPending.id, amount: 315000 });
        expect((await subscribe(user, fullPending.id, card.id)).status).toBe(200);
    });

    it('sem Stripe habilitado → 503; sem autenticação → 401; corpo inválido → 400', async () => {
        const { user, contract, customerId } = await clientWithPlan();
        const card = await savedCard(user.id, customerId, 'pm_1');
        expect((await call('POST', `/api/contracts/${contract.id}/subscribe`, undefined, { paymentMethodId: card.id })).status).toBe(401);
        expect((await call('POST', `/api/contracts/${contract.id}/subscribe`, user, {})).status).toBe(400);
        m(stripe.isStripeEnabled).mockResolvedValue(false);
        expect((await subscribe(user, contract.id, card.id)).status).toBe(503);
        expect((await userRow(user.id)).autoChargeEnabled).toBe(false);
    });
});

// ─── 2) Depois de ativar, quem cobra é o autoChargeJob — uma vez, as parcelas que já existem ─────
describe('E9 — a cobrança automática ativada pelo modal cobra as parcelas existentes (sem dobrar)', () => {
    it('ativar → o job cobra a parcela vencida no cartão escolhido; a futura fica pendente; nenhuma cobrança extra', async () => {
        const { user, contract, due, future, customerId } = await clientWithPlan();
        await savedCard(user.id, customerId, 'pm_old', { isDefault: true });
        const chosen = await savedCard(user.id, customerId, 'pm_chosen');
        await runAutoChargeJob(); // ainda desligada: nada é cobrado
        expect(stripe.stripeChargeOffSession).not.toHaveBeenCalled();

        expect((await subscribe(user, contract.id, chosen.id)).status).toBe(200);
        await runAutoChargeJob();

        expect(m(stripe.stripeChargeOffSession).mock.calls).toHaveLength(1);
        const [cus, pm, amount, meta] = m(stripe.stripeChargeOffSession).mock.calls[0]!;
        expect([cus, pm, amount, meta.paymentId]).toEqual([customerId, 'pm_chosen', 84000, due.id]);
        expect((await prisma.payment.findUniqueOrThrow({ where: { id: due.id } })).status).toBe('PAID');
        expect((await prisma.payment.findUniqueOrThrow({ where: { id: future.id } })).status).toBe('PENDING');
        expect(await prisma.payment.count({ where: { contractId: contract.id } })).toBe(3);

        await runAutoChargeJob(); // rodar de novo não cobra duas vezes
        expect(m(stripe.stripeChargeOffSession).mock.calls).toHaveLength(1);
    });

    it('a multa de cancelamento (metadata.kind CANCELLATION_FINE) NUNCA é cobrada sozinha — contrato cancelado ou não', async () => {
        const { user, contract, due, customerId } = await clientWithPlan({ autoChargeEnabled: true });
        await savedCard(user.id, customerId, 'pm_1', { isDefault: true });
        const fineMeta = { kind: 'CANCELLATION_FINE', finePct: 20, baseAmount: 168000 };
        const fineOnActive = await mkPayment(user.id, { contractId: contract.id, provider: 'STRIPE', amount: 33600, dueDate: secondsAgo(120), metadata: fineMeta });
        const cancelled = await mkContract(user.id, { status: 'CANCELLED' });
        const fineOnCancelled = await mkPayment(user.id, { contractId: cancelled.id, provider: 'STRIPE', amount: 33600, dueDate: secondsAgo(120), metadata: fineMeta });

        await runAutoChargeJob();

        expect(m(stripe.stripeChargeOffSession).mock.calls.map(c => c[3].paymentId)).toEqual([due.id]);
        for (const f of [fineOnActive, fineOnCancelled]) {
            expect(await prisma.payment.findUniqueOrThrow({ where: { id: f.id } })).toMatchObject({ status: 'PENDING', providerRef: null, chargedAmount: null });
        }
    });

    it('linha legada de assinatura (stripeSubscriptionId) segue fora do auto-charge', async () => {
        const { user, due, customerId } = await clientWithPlan({ autoChargeEnabled: true });
        await savedCard(user.id, customerId, 'pm_1', { isDefault: true });
        await prisma.payment.update({ where: { id: due.id }, data: { stripeSubscriptionId: 'sub_legado' } });
        await runAutoChargeJob();
        expect(stripe.stripeChargeOffSession).not.toHaveBeenCalled();
    });
});

// ─── 3) Estado e desligar ────────────────────────────────────────────────────────────────────────
describe('E9 — GET /stripe/auto-charge (estado) e PUT /stripe/auto-charge (desligar)', () => {
    it('sem cartão → desligada e defaultCard null; depois de ativar → ligada com o cartão padrão; desligar mantém o cartão', async () => {
        const { user, contract, customerId } = await clientWithPlan();
        const empty = await call('GET', '/api/stripe/auto-charge', user);
        expect(empty.status).toBe(200);
        expect(empty.body).toEqual({ autoChargeEnabled: false, scope: 'USER', hasSavedCard: false, savedCards: 0, defaultCard: null });

        const card = await savedCard(user.id, customerId, 'pm_1', { last4: '4242' });
        expect((await subscribe(user, contract.id, card.id)).status).toBe(200);
        const on = await call('GET', '/api/stripe/auto-charge', user);
        expect(on.body).toMatchObject({
            autoChargeEnabled: true, hasSavedCard: true, savedCards: 1,
            defaultCard: { id: card.id, stripePaymentMethodId: 'pm_1', last4: '4242', isDefault: true },
        });

        const off = await call('PUT', '/api/stripe/auto-charge', user, { enabled: false });
        expect(off.status).toBe(200);
        const after = await call('GET', '/api/stripe/auto-charge', user);
        expect(after.body).toMatchObject({ autoChargeEnabled: false, defaultCard: { id: card.id } });
        expect((await call('GET', '/api/stripe/auto-charge')).status).toBe(401);
    });

    it('sem cartão padrão marcado, mostra o mais recente (o mesmo que o job cobraria)', async () => {
        const { user, customerId } = await clientWithPlan();
        await prisma.savedPaymentMethod.create({ data: { userId: user.id, stripePaymentMethodId: 'pm_older', brand: 'visa', last4: '1111', expMonth: 1, expYear: 2030, isDefault: false, createdAt: secondsAgo(3600) } });
        const newer = await savedCard(user.id, customerId, 'pm_newer', { last4: '2222' });
        const r = await call('GET', '/api/stripe/auto-charge', user);
        expect(r.body.defaultCard).toMatchObject({ id: newer.id, last4: '2222', isDefault: false });
    });
});

// ─── 4) Cadastro de cartão por SetupIntent dentro do modal ───────────────────────────────────────
describe('E9 — POST /stripe/setup-intent/confirm persiste o cartão para uso imediato', () => {
    function setupIntent(over: Record<string, unknown>) {
        m(stripe.stripeGetSetupIntent).mockResolvedValue({ id: 'seti_1', status: 'succeeded', customerId: null, paymentMethodId: null, ...over });
    }

    it('SetupIntent confirmado do próprio cliente → cartão salvo (1 linha, idempotente) e já utilizável no /subscribe', async () => {
        const { user, contract, customerId } = await clientWithPlan();
        stripeCards.pm_new = { customerId, funding: 'credit', last4: '4444', brand: 'visa' };
        setupIntent({ customerId, paymentMethodId: 'pm_new' });

        const r = await call('POST', '/api/stripe/setup-intent/confirm', user, { setupIntentId: 'seti_1' });
        expect(r.status).toBe(200);
        expect(r.body.card).toMatchObject({ stripePaymentMethodId: 'pm_new', brand: 'visa', last4: '4444', funding: 'credit' });
        const again = await call('POST', '/api/stripe/setup-intent/confirm', user, { setupIntentId: 'seti_1' });
        expect(again.status).toBe(200);
        expect(again.body.card.id).toBe(r.body.card.id);
        expect(await cardsOf(user.id)).toHaveLength(1);

        const activated = await subscribe(user, contract.id, r.body.card.id);
        expect(activated.status).toBe(200);
        expect(activated.body.defaultCard.id).toBe(r.body.card.id);
        expect((await userRow(user.id)).autoChargeEnabled).toBe(true);
    });

    it('makeDefault: o cartão novo vira o padrão (o antigo deixa de ser); o webhook que chegou antes não duplica a linha', async () => {
        const { user, customerId } = await clientWithPlan();
        const old = await savedCard(user.id, customerId, 'pm_old', { isDefault: true });
        // O webhook setup_intent.succeeded já gravou a linha do cartão novo.
        const hooked = await savedCard(user.id, customerId, 'pm_new');
        setupIntent({ customerId, paymentMethodId: 'pm_new' });

        const r = await call('POST', '/api/stripe/setup-intent/confirm', user, { setupIntentId: 'seti_1', makeDefault: true });
        expect(r.status).toBe(200);
        expect(r.body.card).toMatchObject({ id: hooked.id, isDefault: true });
        const cards = await cardsOf(user.id);
        expect(cards).toHaveLength(2);
        expect(cards.filter(c => c.isDefault).map(c => c.id)).toEqual([hooked.id]);
        expect(cards.find(c => c.id === old.id)!.isDefault).toBe(false);
        expect(stripe.stripeSetDefaultPaymentMethod).toHaveBeenCalledWith(customerId, 'pm_new');
        expect((await userRow(user.id)).autoChargeEnabled).toBe(false); // salvar o cartão não liga a cobrança automática
    });

    it('SetupIntent de OUTRO cliente → 404; ainda não confirmado → 409; cliente sem Customer → 400; nada é gravado', async () => {
        const { user, customerId } = await clientWithPlan();
        const other = await clientWithPlan();
        stripeCards.pm_x = { customerId: other.customerId, funding: 'credit' };

        setupIntent({ customerId: other.customerId, paymentMethodId: 'pm_x' });
        const foreign = await call('POST', '/api/stripe/setup-intent/confirm', user, { setupIntentId: 'seti_1' });
        expect(foreign.status).toBe(404);

        setupIntent({ customerId, paymentMethodId: null, status: 'requires_payment_method' });
        const pending = await call('POST', '/api/stripe/setup-intent/confirm', user, { setupIntentId: 'seti_1' });
        expect(pending.status).toBe(409);
        expect(pending.body.code).toBe('SETUP_INTENT_NOT_CONFIRMED');

        // SetupIntent do cliente apontando para um cartão que é de outro Customer → não salva.
        setupIntent({ customerId, paymentMethodId: 'pm_x' });
        expect((await call('POST', '/api/stripe/setup-intent/confirm', user, { setupIntentId: 'seti_1' })).status).toBe(404);

        const noCustomer = await mkUser();
        expect((await call('POST', '/api/stripe/setup-intent/confirm', noCustomer, { setupIntentId: 'seti_1' })).status).toBe(400);
        expect((await call('POST', '/api/stripe/setup-intent/confirm', user, {})).status).toBe(400);

        expect(await prisma.savedPaymentMethod.count()).toBe(0);
    });
});

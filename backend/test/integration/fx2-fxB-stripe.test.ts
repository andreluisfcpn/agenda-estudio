import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

// ─── Gravação em segundo plano (Z1-f) ────────────────────────────────────────────────────────────
// `notifyPaymentConfirmed` (lib/paymentEffects) dispara o aviso "pagamento confirmado" SEM await; o INSERT em
// `notifications` cruzava com o TRUNCATE do beforeEach seguinte (`deadlock detected`). O mock só embrulha as
// funções reais para o afterEach aguardar o que ficou pendente (mesmo cuidado de fx2-fxC-gateway).
const background = vi.hoisted(() => ({ pending: new Set<Promise<unknown>>() }));
vi.mock('../../src/modules/notifications/notificationService', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../../src/modules/notifications/notificationService')>();
    const tracked = <A extends unknown[], R>(fn: (...a: A) => Promise<R>) => (...a: A): Promise<R> => {
        const p = fn(...a);
        background.pending.add(p);
        const done = () => { background.pending.delete(p); };
        p.then(done, done);
        return p;
    };
    return { ...orig, notifyEvent: tracked(orig.notifyEvent), createNotification: tracked(orig.createNotification) };
});

// ─── Mocks dos provedores (Stripe / Sicoob) e do push: nenhuma chamada de rede real ─────────────
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
        stripeDetachPaymentMethod: vi.fn(async () => undefined),
        stripeSetDefaultPaymentMethod: vi.fn(async () => undefined),
        stripeGetSetupIntent: vi.fn(),
        stripeGetPaymentIntent: vi.fn(),
        stripeCancelPaymentIntent: vi.fn(async () => ({ status: 'canceled', canceled: true })),
        stripeChargeOffSession: vi.fn(),
        stripeCreatePaymentIntent: vi.fn(),
        stripeGetOrCreateCustomer: vi.fn(),
    };
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
import * as sicoob from '../../src/lib/sicoobService';
import * as stripe from '../../src/lib/stripeService';
import { buildStaticBrCode } from '../../src/lib/brcode';
import { pixTxidForAttempt } from '../../src/lib/pixGateway';
import contractRoutes from '../../src/modules/contracts/routes';
import stripeRoutes from '../../src/modules/stripe/routes';
import webhookRoutes from '../../src/modules/webhooks/routes';
import userRoutes from '../../src/modules/users/routes';
import { mkUser, mkContract, mkPayment, mkBooking, mkCpf } from './factories';

// Frente fxB-stripe (lote 2, revisão adversarial 2) — achados PAY-6, AC-3 (+ troca/remoção do cartão padrão),
// CLI-2 (create-payment / pay), SEC-4 e AC-1 (parte do /subscribe). AC-5 é unitário
// (test/stripe-get-or-create-customer.test.ts).

type Who = { id: string; email: string | null; role: string };
const m = <T extends (...a: any[]) => any>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>;
const secondsAgo = (s: number) => new Date(Date.now() - s * 1000);
const minutes = (n: number) => new Date(Date.now() + n * 60 * 1000);

let server: Server;
let base = '';

beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/contracts', contractRoutes);
    app.use('/api/stripe', stripeRoutes);
    app.use('/api/webhooks', webhookRoutes);
    app.use('/api/users', userRoutes);
    await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Cartões "no Stripe" deste teste: pm → dono (Customer), tipo e final. */
let stripeCards: Record<string, { customerId: string | null; funding: string; last4: string }> = {};
let prevUnverified: string | undefined;

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
    m(stripe.stripeDetachPaymentMethod).mockResolvedValue(undefined);
    m(stripe.stripeSetDefaultPaymentMethod).mockResolvedValue(undefined);
    m(stripe.stripeGetPaymentIntent).mockResolvedValue(undefined);
    m(stripe.stripeCreatePaymentIntent).mockImplementation(async (o: { paymentId: string; amount: number }) => ({
        clientSecret: `cs_${o.paymentId}`, paymentIntentId: `pi_new_${o.paymentId.slice(0, 8)}_${o.amount}`, status: 'requires_payment_method',
    }));
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
    prevUnverified = process.env.ALLOW_UNVERIFIED_WEBHOOKS;
    process.env.ALLOW_UNVERIFIED_WEBHOOKS = 'true';
});

afterEach(async () => {
    if (prevUnverified === undefined) delete process.env.ALLOW_UNVERIFIED_WEBHOOKS;
    else process.env.ALLOW_UNVERIFIED_WEBHOOKS = prevUnverified;
    // Z1-f: nenhum teste termina com notificação ainda gravando (ver o mock de notificationService no topo).
    while (background.pending.size > 0) await Promise.allSettled([...background.pending]);
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
/** Cliente com Customer no Stripe (cus_<n>). */
async function client(over: Record<string, unknown> = {}) {
    const customerId = `cus_${++seq}`;
    const user = await mkUser({ stripeCustomerId: customerId, cpfCnpj: mkCpf(), ...over });
    return { user, customerId };
}

async function saveCard(userId: string, customerId: string | null, pm: string, over: { isDefault?: boolean; funding?: string; last4?: string; createdAt?: Date } = {}) {
    stripeCards[pm] = { customerId, funding: over.funding ?? 'credit', last4: over.last4 ?? '4242' };
    return prisma.savedPaymentMethod.create({
        data: {
            userId, stripePaymentMethodId: pm, brand: 'visa', last4: over.last4 ?? '4242', expMonth: 12, expYear: 2031,
            isDefault: over.isDefault ?? false, ...(over.createdAt ? { createdAt: over.createdAt } : {}),
        },
    });
}

const row = (id: string) => prisma.payment.findUniqueOrThrow({ where: { id } });
const enabledOf = async (id: string) => (await prisma.user.findUniqueOrThrow({ where: { id } })).autoChargeEnabled;
const defaultOf = async (userId: string) => (await prisma.savedPaymentMethod.findFirst({ where: { userId, isDefault: true } }))?.stripePaymentMethodId ?? null;
const audits = (where: Record<string, unknown>) => prisma.auditLog.findMany({ where, orderBy: { createdAt: 'asc' } });

// ═══ PAY-6 ═══════════════════════════════════════════════════════════════════════════════════════
describe('PAY-6 — cartão aprovado no MESMO PaymentIntent que uma recusa atrasada marcou FAILED', () => {
    const failedEvent = (paymentId: string, piId: string) => ({ type: 'payment_intent.payment_failed', data: { object: { id: piId, metadata: { paymentId } } } });
    const succeededEvent = (paymentId: string, piId: string, amount: number) => ({
        type: 'payment_intent.succeeded',
        data: { object: { id: piId, amount, metadata: { paymentId }, payment_method_types: ['card'] } },
    });
    const webhook = (event: unknown) => call('POST', '/api/webhooks/stripe', undefined, event);
    const verify = (who: Who, paymentId: string, paymentIntentId: string) => call('POST', '/api/stripe/verify-payment', who, { paymentId, paymentIntentId });
    const approvedPi = (id: string, paymentId: string, amount: number) => ({ id, status: 'succeeded', amount, metadata: { paymentId }, payment_method_types: ['card'] });

    it('(a) webhook: recusa atrasada → FAILED; succeeded do MESMO PI com o valor certo → PAID, paidAt e efeitos (contrato ativado)', async () => {
        const { user } = await client();
        const c = await mkContract(user.id, { type: 'CUSTOM', status: 'AWAITING_PAYMENT', paymentDeadline: minutes(10), accessMode: 'FULL', paymentMethod: 'CARTAO' });
        const p = await mkPayment(user.id, { contractId: c.id, provider: 'STRIPE', providerRef: 'pi_same', amount: 84000, chargedAmount: 84000 });

        await webhook(failedEvent(p.id, 'pi_same'));
        expect((await row(p.id)).status).toBe('FAILED');

        const r = await webhook(succeededEvent(p.id, 'pi_same', 84000));
        expect(r.status).toBe(200);
        const paid = await row(p.id);
        expect(paid).toMatchObject({ status: 'PAID', providerRef: 'pi_same', paymentType: 'CREDIT' });
        expect(paid.paidAt).toBeInstanceOf(Date);
        expect((await prisma.contract.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('ACTIVE');
    });

    it('(b) webhook: FAILED de OUTRO PI, FAILED de PIX e valor divergente NÃO viram PAID', async () => {
        const { user } = await client();
        const other = await mkPayment(user.id, { provider: 'STRIPE', providerRef: 'pi_other', amount: 84000, status: 'FAILED' });
        const noRef = await mkPayment(user.id, { provider: 'STRIPE', providerRef: null, amount: 84000, status: 'FAILED' });
        const pix = await mkPayment(user.id, { provider: 'SICOOB', amount: 84000, status: 'FAILED' });
        await prisma.payment.update({ where: { id: pix.id }, data: { providerRef: pixTxidForAttempt(pix.id, 1) } });
        const wrongAmount = await mkPayment(user.id, { provider: 'STRIPE', providerRef: 'pi_amount', amount: 84000, status: 'FAILED' });

        await webhook(succeededEvent(other.id, 'pi_x', 84000));
        await webhook(succeededEvent(noRef.id, 'pi_x', 84000));
        await webhook(succeededEvent(pix.id, 'pi_x', 84000));
        await webhook(succeededEvent(wrongAmount.id, 'pi_amount', 99999));

        for (const id of [other.id, noRef.id, pix.id, wrongAmount.id]) {
            const fresh = await row(id);
            expect(fresh.status, id).toBe('FAILED');
            expect(fresh.paidAt).toBeNull();
        }
        expect((await row(other.id)).providerRef).toBe('pi_other');
    });

    it('(c) verify-payment: FAILED com o MESMO PI aprovado → PAID no banco e na resposta (efeitos rodam)', async () => {
        const { user } = await client();
        const c = await mkContract(user.id, { type: 'CUSTOM', status: 'AWAITING_PAYMENT', paymentDeadline: minutes(10), accessMode: 'FULL', paymentMethod: 'CARTAO' });
        const p = await mkPayment(user.id, { contractId: c.id, provider: 'STRIPE', providerRef: 'pi_same', amount: 84000, chargedAmount: 84000, status: 'FAILED' });
        m(stripe.stripeGetPaymentIntent).mockResolvedValue(approvedPi('pi_same', p.id, 84000));

        const r = await verify(user, p.id, 'pi_same');
        expect(r.status).toBe(200);
        expect(r.body.status).toBe('PAID');
        expect(await row(p.id)).toMatchObject({ status: 'PAID', providerRef: 'pi_same' });
        expect((await prisma.contract.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('ACTIVE');
    });

    it('(d) verify-payment: FAILED de OUTRO PI → 409 PAYMENT_NOT_SETTLED (nunca PAID) e a linha fica intacta', async () => {
        const { user } = await client();
        const p = await mkPayment(user.id, { provider: 'STRIPE', providerRef: 'pi_other', amount: 84000, status: 'FAILED' });
        m(stripe.stripeGetPaymentIntent).mockResolvedValue(approvedPi('pi_x', p.id, 84000));

        const r = await verify(user, p.id, 'pi_x');
        expect(r.status).toBe(409);
        expect(r.body).toMatchObject({ code: 'PAYMENT_NOT_SETTLED', paymentStatus: 'FAILED' });
        expect(r.body.status).toBeUndefined();
        expect(r.body.error).toMatch(/aprovado no cartão/);
        expect(await row(p.id)).toMatchObject({ status: 'FAILED', providerRef: 'pi_other', paidAt: null });
    });

    it('verify-payment segue igual no caminho feliz: PENDING → PAID; PI ainda não aprovado → devolve o status real (nunca PAID)', async () => {
        const { user } = await client();
        const p = await mkPayment(user.id, { provider: 'STRIPE', providerRef: 'pi_ok', amount: 84000 });
        m(stripe.stripeGetPaymentIntent).mockResolvedValueOnce({ id: 'pi_ok', status: 'requires_payment_method', amount: 84000, metadata: { paymentId: p.id } });
        const notYet = await verify(user, p.id, 'pi_ok');
        expect(notYet.status).toBe(200);
        expect(notYet.body.status).toBe('PENDING');

        m(stripe.stripeGetPaymentIntent).mockResolvedValueOnce(approvedPi('pi_ok', p.id, 84000));
        const ok = await verify(user, p.id, 'pi_ok');
        expect(ok.status).toBe(200);
        expect(ok.body).toEqual({ status: 'PAID', message: 'Pagamento sincronizado.' });
        expect((await row(p.id)).status).toBe('PAID');

        // Já paga: a resposta continua PAID sem consultar o Stripe de novo.
        m(stripe.stripeGetPaymentIntent).mockClear();
        expect((await verify(user, p.id, 'pi_ok')).body.status).toBe('PAID');
        expect(stripe.stripeGetPaymentIntent).not.toHaveBeenCalled();
    });
});

// ═══ AC-3 — admin liga a cobrança automática ═════════════════════════════════════════════════════
describe('AC-3 — PATCH /users/:id/auto-charge (ADMIN) confere "só crédito" como os outros caminhos de ligar', () => {
    const toggle = (admin: Who, userId: string, enabled: boolean) => call('PATCH', `/api/users/${userId}/auto-charge`, admin, { enabled });

    it('cartão padrão de DÉBITO (ou pré-pago) → 400 CARD_NOT_CREDIT na 3ª pessoa; nada é gravado', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const debit = await client();
        await saveCard(debit.user.id, debit.customerId, 'pm_debit', { isDefault: true, funding: 'debit' });
        const r = await toggle(admin, debit.user.id, true);
        expect(r.status).toBe(400);
        expect(r.body).toEqual({ error: 'O cartão padrão do cliente não é de crédito. A cobrança automática aceita apenas cartão de crédito.', code: 'CARD_NOT_CREDIT' });
        expect(await enabledOf(debit.user.id)).toBe(false);

        const prepaid = await client();
        await saveCard(prepaid.user.id, prepaid.customerId, 'pm_prepaid', { isDefault: true, funding: 'prepaid' });
        expect((await toggle(admin, prepaid.user.id, true)).body.code).toBe('CARD_NOT_CREDIT');
        expect(await enabledOf(prepaid.user.id)).toBe(false);
    });

    it('crédito e "unknown" → 200 e liga; confere o cartão que o job cobraria (o padrão, não o mais recente)', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const credit = await client();
        await saveCard(credit.user.id, credit.customerId, 'pm_credit', { isDefault: true, funding: 'credit', createdAt: secondsAgo(3600) });
        await saveCard(credit.user.id, credit.customerId, 'pm_newer_debit', { funding: 'debit' });
        const r = await toggle(admin, credit.user.id, true);
        expect(r.status).toBe(200);
        expect(r.body).toEqual({ autoChargeEnabled: true });
        expect(await enabledOf(credit.user.id)).toBe(true);
        expect(m(stripe.stripeGetCard)).toHaveBeenLastCalledWith('pm_credit');

        const unknown = await client();
        await saveCard(unknown.user.id, unknown.customerId, 'pm_unknown', { isDefault: true, funding: 'unknown' });
        expect((await toggle(admin, unknown.user.id, true)).status).toBe(200);
        expect(await enabledOf(unknown.user.id)).toBe(true);
    });

    it('DESLIGAR é sempre aceito e nunca consulta o Stripe (mesmo com débito e o Stripe fora)', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const c = await client({ autoChargeEnabled: true });
        await saveCard(c.user.id, c.customerId, 'pm_debit', { isDefault: true, funding: 'debit' });
        m(stripe.isStripeEnabled).mockResolvedValue(false);
        m(stripe.stripeGetCard).mockRejectedValue(new Error('network'));
        const r = await toggle(admin, c.user.id, false);
        expect(r.status).toBe(200);
        expect(r.body).toEqual({ autoChargeEnabled: false });
        expect(await enabledOf(c.user.id)).toBe(false);
        expect(stripe.stripeGetCard).not.toHaveBeenCalled();
        expect(stripe.isStripeEnabled).not.toHaveBeenCalled();
    });

    it('não conferido não liga: Stripe fora (502), Stripe desligado (503), cartão sumiu do Stripe (404), sem cartão (400) — nada gravado', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const c = await client();
        await saveCard(c.user.id, c.customerId, 'pm_1', { isDefault: true });

        m(stripe.stripeGetCard).mockRejectedValueOnce(new Error('connection reset'));
        const down = await toggle(admin, c.user.id, true);
        expect(down.status).toBe(502);
        expect(down.body.error).toMatch(/cartão do cliente/);

        m(stripe.isStripeEnabled).mockResolvedValueOnce(false);
        expect((await toggle(admin, c.user.id, true)).status).toBe(503);

        delete stripeCards.pm_1;
        const gone = await toggle(admin, c.user.id, true);
        expect(gone.status).toBe(404);
        expect(gone.body.code).toBe('CARD_NOT_FOUND');
        expect(await enabledOf(c.user.id)).toBe(false);

        const noCard = await client();
        const none = await toggle(admin, noCard.user.id, true);
        expect(none.status).toBe(400);
        expect(none.body).toEqual({ error: 'O cliente precisa ter um cartão salvo para ativar a cobrança automática.' });
        expect(await enabledOf(noCard.user.id)).toBe(false);

        // Só ADMIN.
        expect((await toggle(c.user, c.user.id, true)).status).toBe(403);
    });
});

// ═══ AC-3 / fila "só crédito" — troca e remoção do cartão padrão ═════════════════════════════════
describe('"só crédito" na troca do cartão padrão — PUT /stripe/payment-methods/:pmId/default', () => {
    const setDefault = (who: Who, ref: string) => call('PUT', `/api/stripe/payment-methods/${ref}/default`, who);

    it('cobrança automática LIGADA + cartão novo de débito → 400 CARD_NOT_CREDIT; o padrão não muda (banco e Stripe)', async () => {
        const c = await client({ autoChargeEnabled: true });
        await saveCard(c.user.id, c.customerId, 'pm_credit', { isDefault: true, createdAt: secondsAgo(3600) });
        const debit = await saveCard(c.user.id, c.customerId, 'pm_debit', { funding: 'debit' });

        for (const ref of [debit.id, 'pm_debit']) {
            const r = await setDefault(c.user, ref);
            expect(r.status, ref).toBe(400);
            expect(r.body).toEqual({
                error: 'Com a cobrança automática ligada, o cartão padrão precisa ser de crédito. Desligue a cobrança automática ou escolha um cartão de crédito.',
                code: 'CARD_NOT_CREDIT',
            });
        }
        expect(await defaultOf(c.user.id)).toBe('pm_credit');
        expect(stripe.stripeSetDefaultPaymentMethod).not.toHaveBeenCalled();
        expect(await enabledOf(c.user.id)).toBe(true);
    });

    it('LIGADA + cartão de crédito → 200 e troca; LIGADA + cartão de outra pessoa → 404; Stripe fora → 502 (nada muda)', async () => {
        const c = await client({ autoChargeEnabled: true });
        await saveCard(c.user.id, c.customerId, 'pm_a', { isDefault: true, createdAt: secondsAgo(3600) });
        const b = await saveCard(c.user.id, c.customerId, 'pm_b');
        const stranger = await client();
        await saveCard(stranger.user.id, stranger.customerId, 'pm_stranger');

        expect((await setDefault(c.user, 'pm_stranger')).status).toBe(404);
        m(stripe.stripeGetCard).mockRejectedValueOnce(new Error('connection reset'));
        expect((await setDefault(c.user, b.id)).status).toBe(502);
        expect(await defaultOf(c.user.id)).toBe('pm_a');
        expect(stripe.stripeSetDefaultPaymentMethod).not.toHaveBeenCalled();

        const ok = await setDefault(c.user, b.id);
        expect(ok.status).toBe(200);
        expect(await defaultOf(c.user.id)).toBe('pm_b');
        expect(stripe.stripeSetDefaultPaymentMethod).toHaveBeenCalledWith(c.customerId, 'pm_b');
    });

    it('cobrança automática DESLIGADA: a troca para débito segue livre e não consulta o tipo do cartão', async () => {
        const c = await client();
        await saveCard(c.user.id, c.customerId, 'pm_credit', { isDefault: true, createdAt: secondsAgo(3600) });
        const debit = await saveCard(c.user.id, c.customerId, 'pm_debit', { funding: 'debit' });
        const r = await setDefault(c.user, debit.id);
        expect(r.status).toBe(200);
        expect(await defaultOf(c.user.id)).toBe('pm_debit');
        expect(stripe.stripeGetCard).not.toHaveBeenCalled();
    });

    it('setup-intent/confirm com makeDefault e a cobrança automática LIGADA: débito é salvo mas NÃO vira o padrão', async () => {
        const c = await client({ autoChargeEnabled: true });
        await saveCard(c.user.id, c.customerId, 'pm_credit', { isDefault: true, createdAt: secondsAgo(3600) });
        stripeCards.pm_new_debit = { customerId: c.customerId, funding: 'debit', last4: '7777' };
        m(stripe.stripeGetSetupIntent).mockResolvedValue({ id: 'seti_1', status: 'succeeded', customerId: c.customerId, paymentMethodId: 'pm_new_debit' });

        const r = await call('POST', '/api/stripe/setup-intent/confirm', c.user, { setupIntentId: 'seti_1', makeDefault: true });
        expect(r.status).toBe(200);
        expect(r.body.card).toMatchObject({ stripePaymentMethodId: 'pm_new_debit', funding: 'debit', isDefault: false });
        expect(r.body.defaultNotApplied).toMatchObject({ code: 'CARD_NOT_CREDIT' });
        expect(await defaultOf(c.user.id)).toBe('pm_credit');
        expect(stripe.stripeSetDefaultPaymentMethod).not.toHaveBeenCalled();

        // Crédito: vira o padrão como antes (sem o campo de recusa).
        stripeCards.pm_new_credit = { customerId: c.customerId, funding: 'credit', last4: '8888' };
        m(stripe.stripeGetSetupIntent).mockResolvedValue({ id: 'seti_2', status: 'succeeded', customerId: c.customerId, paymentMethodId: 'pm_new_credit' });
        const ok = await call('POST', '/api/stripe/setup-intent/confirm', c.user, { setupIntentId: 'seti_2', makeDefault: true });
        expect(ok.status).toBe(200);
        expect(ok.body.card.isDefault).toBe(true);
        expect(ok.body.defaultNotApplied).toBeUndefined();
        expect(await defaultOf(c.user.id)).toBe('pm_new_credit');
    });
});

describe('"só crédito" na remoção do cartão cobrado — DELETE /stripe/payment-methods/:pmId', () => {
    const remove = (who: Who, ref: string) => call('DELETE', `/api/stripe/payment-methods/${ref}`, who);

    it('substituto (o salvo mais recente) é de CRÉDITO → a cobrança automática segue ligada, resposta de sempre', async () => {
        const c = await client({ autoChargeEnabled: true });
        const def = await saveCard(c.user.id, c.customerId, 'pm_default', { isDefault: true, createdAt: secondsAgo(7200) });
        await saveCard(c.user.id, c.customerId, 'pm_other_credit', { createdAt: secondsAgo(3600) });

        const r = await remove(c.user, def.id);
        expect(r.status).toBe(200);
        expect(r.body).toEqual({ message: 'Cartão removido com sucesso.' });
        expect(await enabledOf(c.user.id)).toBe(true);
        expect(stripe.stripeDetachPaymentMethod).toHaveBeenCalledWith('pm_default');
        expect(m(stripe.stripeGetCard)).toHaveBeenLastCalledWith('pm_other_credit');
        expect(await audits({ entityId: c.user.id, action: 'AUTO_CHARGE_DISABLED' })).toHaveLength(0);
        // Z1-a: o substituto conferido passa a ser o PADRÃO (um cartão salvo depois não assume a cobrança).
        expect(await defaultOf(c.user.id)).toBe('pm_other_credit');
        expect(stripe.stripeSetDefaultPaymentMethod).toHaveBeenCalledWith(c.customerId, 'pm_other_credit');
    });

    it('substituto de DÉBITO → a cobrança automática é DESLIGADA e a resposta avisa (com auditoria)', async () => {
        const c = await client({ autoChargeEnabled: true });
        const def = await saveCard(c.user.id, c.customerId, 'pm_default', { isDefault: true, last4: '1111', createdAt: secondsAgo(7200) });
        await saveCard(c.user.id, c.customerId, 'pm_other_debit', { funding: 'debit', createdAt: secondsAgo(3600) });

        const r = await remove(c.user, def.id);
        expect(r.status).toBe(200);
        expect(r.body).toEqual({
            message: 'Cartão removido. A cobrança automática foi desligada porque o outro cartão salvo não é de crédito.',
            autoChargeEnabled: false, autoChargeDisabled: true, autoChargeDisabledReason: 'CARD_NOT_CREDIT',
        });
        expect(await enabledOf(c.user.id)).toBe(false);
        expect(await prisma.savedPaymentMethod.count({ where: { userId: c.user.id } })).toBe(1);
        const log = await audits({ entityType: 'USER', entityId: c.user.id, action: 'AUTO_CHARGE_DISABLED' });
        expect(log).toHaveLength(1);
        expect(log[0]!.performedBy).toBe(c.user.id);
        expect(JSON.parse(log[0]!.changes!)).toEqual({ reason: 'CARD_NOT_CREDIT', removedCardLast4: '1111' });
    });

    it('sem substituto (era o único cartão) → desligada (NO_CARD); substituto não conferido (Stripe fora) → desligada (CARD_NOT_VERIFIED)', async () => {
        const only = await client({ autoChargeEnabled: true });
        const card = await saveCard(only.user.id, only.customerId, 'pm_only', { isDefault: true });
        const r = await remove(only.user, card.id);
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ autoChargeDisabled: true, autoChargeDisabledReason: 'NO_CARD' });
        expect(r.body.message).toMatch(/não há outro cartão salvo/);
        expect(await enabledOf(only.user.id)).toBe(false);

        const down = await client({ autoChargeEnabled: true });
        const def = await saveCard(down.user.id, down.customerId, 'pm_d_default', { isDefault: true, createdAt: secondsAgo(7200) });
        await saveCard(down.user.id, down.customerId, 'pm_d_other', { createdAt: secondsAgo(3600) });
        m(stripe.stripeGetCard).mockRejectedValueOnce(new Error('connection reset'));
        const rd = await remove(down.user, def.id);
        expect(rd.status).toBe(200);
        expect(rd.body).toMatchObject({ autoChargeDisabled: true, autoChargeDisabledReason: 'CARD_NOT_VERIFIED' });
        expect(await enabledOf(down.user.id)).toBe(false);
    });

    it('remover um cartão que NÃO é o da cobrança automática, ou com ela desligada → nada muda e o Stripe não é consultado', async () => {
        const on = await client({ autoChargeEnabled: true });
        await saveCard(on.user.id, on.customerId, 'pm_default', { isDefault: true, createdAt: secondsAgo(7200) });
        const extra = await saveCard(on.user.id, on.customerId, 'pm_extra_debit', { funding: 'debit' });
        const r = await remove(on.user, extra.id);
        expect(r.body).toEqual({ message: 'Cartão removido com sucesso.' });
        expect(await enabledOf(on.user.id)).toBe(true);

        const off = await client();
        const def = await saveCard(off.user.id, off.customerId, 'pm_off_default', { isDefault: true, createdAt: secondsAgo(7200) });
        await saveCard(off.user.id, off.customerId, 'pm_off_debit', { funding: 'debit' });
        expect((await remove(off.user, def.id)).body).toEqual({ message: 'Cartão removido com sucesso.' });
        expect(await enabledOf(off.user.id)).toBe(false);

        expect(stripe.stripeGetCard).not.toHaveBeenCalled();
        expect(await prisma.auditLog.count({ where: { action: 'AUTO_CHARGE_DISABLED' } })).toBe(0);
    });

    it('sem cartão padrão marcado: o cartão cobrado é o mais recente — removê-lo confere o próximo', async () => {
        const c = await client({ autoChargeEnabled: true });
        await saveCard(c.user.id, c.customerId, 'pm_old_debit', { funding: 'debit', createdAt: secondsAgo(7200) });
        const newest = await saveCard(c.user.id, c.customerId, 'pm_newest_credit');
        const r = await remove(c.user, newest.id);
        expect(r.body).toMatchObject({ autoChargeDisabled: true, autoChargeDisabledReason: 'CARD_NOT_CREDIT' });
        expect(await enabledOf(c.user.id)).toBe(false);
    });
});

// ═══ CLI-2 — cobrança de gravação cancelada ══════════════════════════════════════════════════════
describe('CLI-2 — cobrança cuja gravação foi CANCELADA não pode mais ser paga', () => {
    const pay = (who: Who, paymentId: string, paymentMethod: 'pix' | 'cartao') => call('POST', '/api/stripe/create-payment', who, { paymentId, paymentMethod });
    const addon = JSON.stringify({ addonKeys: ['CORTES'] });

    it('create-payment (cliente e admin, PIX e cartão) → 400 BOOKING_CANCELLED sem emitir QR/PaymentIntent; FAILED não é reaberta', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const { user } = await client();
        const contract = await mkContract(user.id, { type: 'FIXO', status: 'PENDING_CANCELLATION' });
        const cancelled = await mkBooking(user.id, contract.id, { status: 'CANCELLED' });
        const extra = await mkPayment(user.id, { contractId: contract.id, bookingId: cancelled.id, provider: 'STRIPE', amount: 5000, paymentUrl: addon });
        const failed = await mkPayment(user.id, { contractId: contract.id, bookingId: cancelled.id, provider: 'STRIPE', amount: 5000, status: 'FAILED', paymentUrl: addon });

        for (const [who, method] of [[user, 'pix'], [user, 'cartao'], [admin, 'pix'], [admin, 'cartao']] as const) {
            const r = await pay(who, extra.id, method);
            expect(r.status, `${who.role}/${method}`).toBe(400);
            expect(r.body).toEqual({ error: 'A gravação desta cobrança foi cancelada. Esta cobrança não pode mais ser paga.', code: 'BOOKING_CANCELLED' });
        }
        expect((await pay(user, failed.id, 'pix')).body.code).toBe('BOOKING_CANCELLED');

        expect(sicoob.sicoobCreatePix).not.toHaveBeenCalled();
        expect(stripe.stripeCreatePaymentIntent).not.toHaveBeenCalled();
        expect(await row(extra.id)).toMatchObject({ status: 'PENDING', providerRef: null, pixString: null });
        expect((await row(failed.id)).status).toBe('FAILED');
    });

    it('extra de gravação viva (COMPLETED/CONFIRMED) segue pagável, inclusive com o cancelamento em análise', async () => {
        const { user } = await client();
        const contract = await mkContract(user.id, { type: 'FIXO', status: 'PENDING_CANCELLATION' });
        const done = await mkBooking(user.id, contract.id, { status: 'COMPLETED' });
        const extra = await mkPayment(user.id, { contractId: contract.id, bookingId: done.id, provider: 'STRIPE', amount: 5000, paymentUrl: addon });

        const r = await pay(user, extra.id, 'pix');
        expect(r.status).toBe(200);
        expect(r.body.amount).toBe(5000);
        expect(sicoob.sicoobCreatePix).toHaveBeenCalledTimes(1);
    });

    it('/contracts/:id/pay nunca reaproveita a cobrança de uma gravação CANCELADA: cobra a parcela do plano', async () => {
        const { user } = await client();
        const contract = await mkContract(user.id, { type: 'CUSTOM', status: 'AWAITING_PAYMENT', paymentDeadline: minutes(10), paymentMethod: 'CARTAO', accessMode: 'FULL' });
        const cancelled = await mkBooking(user.id, contract.id, { status: 'CANCELLED' });
        // O extra vence ANTES da parcela: sem a regra, era ele o "pendente" reaproveitado pelo /pay.
        const extra = await mkPayment(user.id, { contractId: contract.id, bookingId: cancelled.id, provider: 'STRIPE', amount: 5000, dueDate: secondsAgo(86_400), paymentUrl: addon });
        const plan = await mkPayment(user.id, { contractId: contract.id, provider: 'STRIPE', amount: 84000, dueDate: minutes(60) });

        const r = await call('POST', `/api/contracts/${contract.id}/pay`, user, { paymentMethod: 'CARTAO' });
        expect(r.status).toBe(200);
        expect(r.body.paymentId).toBe(plan.id);
        expect(r.body.amount).toBe(84000);
        expect(m(stripe.stripeCreatePaymentIntent).mock.calls[0]![0]).toMatchObject({ paymentId: plan.id, amount: 84000 });
        expect(await row(extra.id)).toMatchObject({ status: 'PENDING', providerRef: null, chargedAmount: null });
    });
});

// ═══ SEC-4 — trilha de quem cobrou ═══════════════════════════════════════════════════════════════
describe('SEC-4 — admin cobrando o cartão do cliente deixa trilha de auditoria', () => {
    const byCard = (who: Who, paymentId: string, extra: Record<string, unknown> = {}) =>
        call('POST', '/api/stripe/create-payment', who, { paymentId, paymentMethod: 'cartao', installments: 1, ...extra });

    async function scene() {
        const admin = await mkUser({ role: 'ADMIN', stripeCustomerId: 'cus_admin' });
        const c = await client();
        const contract = await mkContract(c.user.id, { type: 'FIXO', paymentPlan: 'MONTHLY', paymentMethod: 'CARTAO' });
        const payment = await mkPayment(c.user.id, { contractId: contract.id, provider: 'STRIPE', amount: 84000, dueDate: secondsAgo(60) });
        const card = await saveCard(c.user.id, c.customerId, 'pm_client', { isDefault: true });
        return { admin, ...c, contract, payment, card };
    }

    it('cartão SALVO do cliente → ADMIN_CHARGED_SAVED_CARD (quem, pagador, PI, valor); metadata do PaymentIntent intacto', async () => {
        const { admin, user, payment, card } = await scene();
        const r = await byCard(admin, payment.id, { savedPaymentMethodId: card.id });
        expect(r.status).toBe(200);

        const log = await audits({ entityType: 'PAYMENT', entityId: payment.id });
        expect(log).toHaveLength(1);
        expect(log[0]).toMatchObject({ action: 'ADMIN_CHARGED_SAVED_CARD', performedBy: admin.id });
        expect(JSON.parse(log[0]!.changes!)).toEqual({
            payerUserId: user.id, paymentIntentId: r.body.paymentIntentId, amount: 84000, installments: 1, method: 'cartao',
        });
        // Nada de `chargedBy` no PaymentIntent (a chave de idempotência não cobre o metadata).
        const opts = m(stripe.stripeCreatePaymentIntent).mock.calls[0]![0];
        expect(opts.userId).toBe(user.id);
        expect(Object.keys(opts)).not.toContain('chargedBy');
    });

    it('cartão NOVO pelo admin → ADMIN_CHARGE_STARTED; recusa antes do PaymentIntent não gera trilha', async () => {
        const { admin, payment } = await scene();
        const denied = await byCard(admin, payment.id, { savedPaymentMethodId: 'pm_nao_existe' });
        expect(denied.status).toBe(400);
        expect(await prisma.auditLog.count({ where: { entityType: 'PAYMENT', entityId: payment.id } })).toBe(0);

        const r = await byCard(admin, payment.id);
        expect(r.status).toBe(200);
        const log = await audits({ entityType: 'PAYMENT', entityId: payment.id });
        expect(log.map(l => [l.action, l.performedBy])).toEqual([['ADMIN_CHARGE_STARTED', admin.id]]);
    });

    it('o próprio cliente pagando (cartão salvo ou novo) → nenhuma trilha de admin', async () => {
        const { user, payment, card } = await scene();
        expect((await byCard(user, payment.id, { savedPaymentMethodId: card.id })).status).toBe(200);
        expect(await prisma.auditLog.count({ where: { entityType: 'PAYMENT', entityId: payment.id } })).toBe(0);
    });
});

// ═══ AC-1 (parte do /subscribe) ══════════════════════════════════════════════════════════════════
describe('AC-1 — /contracts/:id/subscribe: o "à vista quitado" conta só parcelas do plano (bookingId null)', () => {
    const subscribe = (who: Who, contractId: string, paymentMethodId: string) =>
        call('POST', `/api/contracts/${contractId}/subscribe`, who, { paymentMethodId });

    it('à vista quitado com apenas um EXTRA de gravação pendente → 400 NOTHING_TO_CHARGE (não liga)', async () => {
        const c = await client();
        const card = await saveCard(c.user.id, c.customerId, 'pm_1');
        const contract = await mkContract(c.user.id, { type: 'FIXO', paymentPlan: 'FULL', paymentMethod: 'CARTAO' });
        await mkPayment(c.user.id, { contractId: contract.id, provider: 'STRIPE', amount: 252000, status: 'PAID', paidAt: secondsAgo(86_400) });
        const booking = await mkBooking(c.user.id, contract.id, { status: 'CONFIRMED' });
        await mkPayment(c.user.id, { contractId: contract.id, bookingId: booking.id, provider: 'STRIPE', amount: 5000, paymentUrl: JSON.stringify({ addonKeys: ['CORTES'] }) });

        const r = await subscribe(c.user, contract.id, card.id);
        expect(r.status).toBe(400);
        expect(r.body.code).toBe('NOTHING_TO_CHARGE');
        expect(await enabledOf(c.user.id)).toBe(false);
    });

    it('à vista com a parcela do PLANO pendente → 200 (pelo helper único: liga, torna o cartão padrão e audita)', async () => {
        const c = await client();
        const card = await saveCard(c.user.id, c.customerId, 'pm_1');
        const contract = await mkContract(c.user.id, { type: 'FIXO', paymentPlan: 'FULL', paymentMethod: 'CARTAO' });
        await mkPayment(c.user.id, { contractId: contract.id, provider: 'STRIPE', amount: 252000 });

        const r = await subscribe(c.user, contract.id, card.id);
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ success: true, autoChargeEnabled: true, alreadyEnabled: false, defaultCard: { id: card.id, funding: 'credit', isDefault: true } });
        expect(await enabledOf(c.user.id)).toBe(true);
        expect(await defaultOf(c.user.id)).toBe('pm_1');
        expect(await prisma.auditLog.count({ where: { entityId: c.user.id, action: 'AUTO_CHARGE_ENABLED' } })).toBe(1);
    });
});

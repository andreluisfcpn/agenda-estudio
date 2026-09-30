import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

// ─── Gravação em segundo plano ───────────────────────────────────────────────────────────────────
// `notifyPaymentConfirmed` (lib/paymentEffects) dispara o aviso "pagamento confirmado" SEM await; o INSERT em
// `notifications` cruzava com o TRUNCATE do beforeEach seguinte (`deadlock detected`). O mock só embrulha as
// funções reais para o afterEach abaixo aguardar o que ficou pendente (mesmo cuidado de fx2-fxC-gateway).
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
import * as push from '../../src/modules/push/pushService';
import { buildStaticBrCode } from '../../src/lib/brcode';
import { pixTxidForAttempt } from '../../src/lib/pixGateway';
import { autoChargeCardFor } from '../../src/lib/savedCards';
import { runAutoChargeJob, alertDoubleCardCharge } from '../../src/jobs/autoChargeJob';
import { NOTIFICATION_EVENT_BY_KEY } from '../../src/config/notificationEventCatalog';
import contractRoutes from '../../src/modules/contracts/routes';
import stripeRoutes from '../../src/modules/stripe/routes';
import webhookRoutes from '../../src/modules/webhooks/routes';
import userRoutes from '../../src/modules/users/routes';
import { mkUser, mkContract, mkPayment, mkBooking, mkCpf } from './factories';

// Frente z1-stripe-job (lote 2, 3ª rodada de correções):
//  Z1-a  o cartão COBRADO pela cobrança automática é o CONFERIDO: ao ligar (cliente e admin) e ao remover o
//        cartão cobrado com substituto aprovado, o cartão conferido vira o PADRÃO.
//  Z1-c  rede de segurança da cobrança em dobro: payment_intent.succeeded de OUTRO PaymentIntent numa linha
//        já PAID → aviso ao admin (1 por PaymentIntent). (O lado do job e o Z1-b estão em fx2-fxC-gateway.)
//  Z1-d  POST /contracts/:id/pay só reaproveita cobrança do PLANO (bookingId null).
//  Z1-e  create-payment não reabre uma linha FAILED cujo PaymentIntent já aprovou / está processando.

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
    m(push.sendPushToUser).mockResolvedValue(1);
    m(stripe.isStripeEnabled).mockResolvedValue(true);
    m(stripe.stripeCardInstallmentsSupported).mockResolvedValue(false);
    m(stripe.stripeDetachPaymentMethod).mockResolvedValue(undefined);
    m(stripe.stripeSetDefaultPaymentMethod).mockResolvedValue(undefined);
    m(stripe.stripeGetPaymentIntent).mockResolvedValue(undefined);
    m(stripe.stripeCancelPaymentIntent).mockResolvedValue({ status: 'canceled', canceled: true });
    m(stripe.stripeCreatePaymentIntent).mockImplementation(async (o: { paymentId: string; amount: number }) => ({
        clientSecret: `cs_${o.paymentId}`, paymentIntentId: `pi_new_${o.paymentId.slice(0, 8)}_${o.amount}`, status: 'requires_payment_method',
    }));
    m(stripe.stripeChargeOffSession).mockImplementation(async (_c: string, _pm: string, _amt: number, meta: { paymentId: string }) =>
        ({ clientSecret: '', paymentIntentId: `pi_auto_${meta.paymentId.slice(0, 8)}`, status: 'succeeded' }));
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
    // Nenhum teste termina com notificação ainda gravando (ver o mock de notificationService no topo).
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
/** Cliente com Customer no Stripe (cus_z<n>). */
async function client(over: Record<string, unknown> = {}) {
    const customerId = `cus_z${++seq}`;
    const user = await mkUser({ stripeCustomerId: customerId, cpfCnpj: mkCpf(), ...over });
    return { user, customerId };
}

let pmSeq = 0;
/** pm_… único por chamada (saved_payment_methods.stripe_payment_method_id é UNIQUE). */
const pm = (label: string) => `pm_${label}_${++pmSeq}`;

async function saveCard(userId: string, customerId: string | null, pmId: string, over: { isDefault?: boolean; funding?: string; last4?: string; createdAt?: Date } = {}) {
    stripeCards[pmId] = { customerId, funding: over.funding ?? 'credit', last4: over.last4 ?? '4242' };
    return prisma.savedPaymentMethod.create({
        data: {
            userId, stripePaymentMethodId: pmId, brand: 'visa', last4: over.last4 ?? '4242', expMonth: 12, expYear: 2031,
            isDefault: over.isDefault ?? false, ...(over.createdAt ? { createdAt: over.createdAt } : {}),
        },
    });
}

const row = (id: string) => prisma.payment.findUniqueOrThrow({ where: { id } });
const enabledOf = async (id: string) => (await prisma.user.findUniqueOrThrow({ where: { id } })).autoChargeEnabled;
const defaultsOf = async (userId: string) =>
    (await prisma.savedPaymentMethod.findMany({ where: { userId, isDefault: true } })).map(c => c.stripePaymentMethodId);
const offSessionCards = () => m(stripe.stripeChargeOffSession).mock.calls.map(c => c[1] as string);

/** Parcela do plano vencida de um contrato mensal ativo (o que o autoChargeJob cobra). */
async function dueInstallment(userId: string) {
    const contract = await mkContract(userId, { type: 'FIXO', paymentPlan: 'MONTHLY', paymentMethod: 'CARTAO' });
    return mkPayment(userId, { contractId: contract.id, provider: 'STRIPE', amount: 84000, dueDate: secondsAgo(3600) });
}

// ═══ Z1-a ════════════════════════════════════════════════════════════════════════════════════════
describe('Z1-a — o cartão cobrado pela cobrança automática é o CONFERIDO (vira o padrão)', () => {
    const toggleSelf = (who: Who, enabled: boolean) => call('PUT', '/api/stripe/auto-charge', who, { enabled });
    const toggleAdmin = (admin: Who, userId: string, enabled: boolean) => call('PATCH', `/api/users/${userId}/auto-charge`, admin, { enabled });
    const remove = (who: Who, ref: string) => call('DELETE', `/api/stripe/payment-methods/${ref}`, who);

    it('PUT /stripe/auto-charge sem cartão padrão: o conferido (o mais recente, crédito) vira o PADRÃO — um débito salvo DEPOIS não assume a cobrança', async () => {
        const c = await client();
        const older = pm('older_credit');
        const checked = pm('checked_credit');
        await saveCard(c.user.id, c.customerId, older, { createdAt: secondsAgo(7200) });
        await saveCard(c.user.id, c.customerId, checked, { createdAt: secondsAgo(3600) });

        const r = await toggleSelf(c.user, true);

        expect(r.status).toBe(200);
        expect(await enabledOf(c.user.id)).toBe(true);
        expect(m(stripe.stripeGetCard)).toHaveBeenLastCalledWith(checked);
        expect(await defaultsOf(c.user.id)).toEqual([checked]);
        expect(m(stripe.stripeSetDefaultPaymentMethod).mock.calls).toEqual([[c.customerId, checked]]);

        // Cartão de DÉBITO salvo depois (como o webhook setup_intent.succeeded / "salvar cartão" do checkout
        // gravam: isDefault = false, sem conferência de tipo). Antes da correção ele virava "o mais recente".
        const lateDebit = pm('late_debit');
        await saveCard(c.user.id, c.customerId, lateDebit, { funding: 'debit' });
        expect((await autoChargeCardFor(c.user.id))?.stripePaymentMethodId).toBe(checked);

        const due = await dueInstallment(c.user.id);
        await runAutoChargeJob();
        expect(offSessionCards()).toEqual([checked]);
        expect((await row(due.id)).status).toBe('PAID');
    });

    it('cartão conferido JÁ é o padrão → nada muda e o Stripe não é chamado para trocar o padrão', async () => {
        const c = await client();
        const def = pm('default');
        await saveCard(c.user.id, c.customerId, def, { isDefault: true, createdAt: secondsAgo(3600) });
        await saveCard(c.user.id, c.customerId, pm('newer'));

        expect((await toggleSelf(c.user, true)).status).toBe(200);
        expect(await defaultsOf(c.user.id)).toEqual([def]);
        expect(stripe.stripeSetDefaultPaymentMethod).not.toHaveBeenCalled();
    });

    it('padrão no Stripe é best-effort: se o Stripe falhar, o banco (fonte do job) já tem o padrão e a cobrança automática liga', async () => {
        const c = await client();
        const card = pm('only');
        await saveCard(c.user.id, c.customerId, card);
        m(stripe.stripeSetDefaultPaymentMethod).mockRejectedValue(new Error('stripe fora do ar'));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const r = await toggleSelf(c.user, true);
            expect(r.status).toBe(200);
        } finally {
            warn.mockRestore();
        }
        expect(await enabledOf(c.user.id)).toBe(true);
        expect(await defaultsOf(c.user.id)).toEqual([card]);
    });

    it('conferência reprovada (o mais recente é débito) → 400 e NENHUM cartão vira padrão', async () => {
        const c = await client();
        await saveCard(c.user.id, c.customerId, pm('credit'), { createdAt: secondsAgo(3600) });
        await saveCard(c.user.id, c.customerId, pm('debit'), { funding: 'debit' });

        const r = await toggleSelf(c.user, true);
        expect(r.status).toBe(400);
        expect(r.body.code).toBe('CARD_NOT_CREDIT');
        expect(await defaultsOf(c.user.id)).toEqual([]);
        expect(await enabledOf(c.user.id)).toBe(false);
        expect(stripe.stripeSetDefaultPaymentMethod).not.toHaveBeenCalled();
    });

    it('PATCH /users/:id/auto-charge (ADMIN) sem cartão padrão: o conferido vira o padrão do CLIENTE', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const c = await client();
        await saveCard(c.user.id, c.customerId, pm('older'), { createdAt: secondsAgo(7200) });
        const checked = pm('checked');
        await saveCard(c.user.id, c.customerId, checked, { createdAt: secondsAgo(3600) });

        const r = await toggleAdmin(admin, c.user.id, true);
        expect(r.status).toBe(200);
        expect(r.body).toEqual({ autoChargeEnabled: true });
        expect(await defaultsOf(c.user.id)).toEqual([checked]);
        expect(m(stripe.stripeSetDefaultPaymentMethod).mock.calls).toEqual([[c.customerId, checked]]);

        await saveCard(c.user.id, c.customerId, pm('late_prepaid'), { funding: 'prepaid' });
        expect((await autoChargeCardFor(c.user.id))?.stripePaymentMethodId).toBe(checked);

        // Desligar não mexe no padrão nem consulta o Stripe.
        m(stripe.stripeSetDefaultPaymentMethod).mockClear();
        expect((await toggleAdmin(admin, c.user.id, false)).status).toBe(200);
        expect(await defaultsOf(c.user.id)).toEqual([checked]);
        expect(stripe.stripeSetDefaultPaymentMethod).not.toHaveBeenCalled();
    });

    it('DELETE do cartão padrão com substituto de CRÉDITO aprovado: o substituto vira o padrão (resposta de sempre) e é ele que o job cobra', async () => {
        const c = await client({ autoChargeEnabled: true });
        const def = await saveCard(c.user.id, c.customerId, pm('default'), { isDefault: true, createdAt: secondsAgo(7200) });
        const substitute = pm('substitute');
        await saveCard(c.user.id, c.customerId, substitute, { createdAt: secondsAgo(3600) });

        const r = await remove(c.user, def.id);

        expect(r.status).toBe(200);
        expect(r.body).toEqual({ message: 'Cartão removido com sucesso.' });
        expect(await enabledOf(c.user.id)).toBe(true);
        expect(await defaultsOf(c.user.id)).toEqual([substitute]);
        expect(m(stripe.stripeSetDefaultPaymentMethod).mock.calls).toEqual([[c.customerId, substitute]]);

        await saveCard(c.user.id, c.customerId, pm('late_debit'), { funding: 'debit' });
        const due = await dueInstallment(c.user.id);
        await runAutoChargeJob();
        expect(offSessionCards()).toEqual([substitute]);
        expect((await row(due.id)).status).toBe('PAID');
    });

    it('DELETE sem padrão marcado (cobrado = o mais recente): o próximo aprovado vira o padrão; reprovado desliga e não fixa padrão', async () => {
        const ok = await client({ autoChargeEnabled: true });
        const next = pm('next_credit');
        await saveCard(ok.user.id, ok.customerId, next, { createdAt: secondsAgo(7200) });
        const newest = await saveCard(ok.user.id, ok.customerId, pm('newest'));
        expect((await remove(ok.user, newest.id)).body).toEqual({ message: 'Cartão removido com sucesso.' });
        expect(await defaultsOf(ok.user.id)).toEqual([next]);
        expect(await enabledOf(ok.user.id)).toBe(true);

        const bad = await client({ autoChargeEnabled: true });
        await saveCard(bad.user.id, bad.customerId, pm('old_debit'), { funding: 'debit', createdAt: secondsAgo(7200) });
        const badNewest = await saveCard(bad.user.id, bad.customerId, pm('newest'));
        const r = await remove(bad.user, badNewest.id);
        expect(r.body).toMatchObject({ autoChargeDisabled: true, autoChargeDisabledReason: 'CARD_NOT_CREDIT' });
        expect(await defaultsOf(bad.user.id)).toEqual([]);
        expect(await enabledOf(bad.user.id)).toBe(false);
    });
});

// ═══ Z1-c ════════════════════════════════════════════════════════════════════════════════════════
describe('Z1-c — payment_intent.succeeded de OUTRO PaymentIntent numa cobrança já PAID → aviso ao admin (cobrança em dobro)', () => {
    const succeeded = (paymentId: string, piId: string, amount: number) => call('POST', '/api/webhooks/stripe', undefined, {
        type: 'payment_intent.succeeded',
        data: { object: { id: piId, amount, metadata: { paymentId }, payment_method_types: ['card'] } },
    });
    const notesOf = (userId: string) => prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
    const doubleAudits = (paymentId: string) => prisma.auditLog.findMany({ where: { entityType: 'PAYMENT', entityId: paymentId, action: 'DOUBLE_CARD_CHARGE' } });

    async function paidByAnotherIntent() {
        const admin = await mkUser({ role: 'ADMIN' });
        const admin2 = await mkUser({ role: 'ADMIN' });
        const removedAdmin = await mkUser({ role: 'ADMIN', deletedAt: new Date() });
        const { user } = await client({ name: 'Maria Cobrada' });
        const contract = await mkContract(user.id, { name: 'Plano Fixo Z1', type: 'FIXO', paymentPlan: 'MONTHLY', paymentMethod: 'CARTAO' });
        const payment = await mkPayment(user.id, {
            contractId: contract.id, provider: 'STRIPE', providerRef: 'pi_B', amount: 84000, chargedAmount: 84000,
            status: 'PAID', paidAt: secondsAgo(60),
        });
        return { admin, admin2, removedAdmin, user, contract, payment };
    }

    it('linha PAID por pi_B recebe succeeded de pi_A → 1 aviso por admin (cliente, valor, os dois PIs, estorno no Stripe); repetir o webhook → continua 1', async () => {
        const { admin, admin2, removedAdmin, user, payment } = await paidByAnotherIntent();
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const r = await succeeded(payment.id, 'pi_A', 84000);
            expect(r.status).toBe(200);

            for (const a of [admin, admin2]) {
                const notes = await notesOf(a.id);
                expect(notes).toHaveLength(1);
                expect(notes[0]).toMatchObject({
                    type: 'SYSTEM', severity: 'critical', title: 'Cobrança em dobro no cartão',
                    entityType: 'PAYMENT', entityId: payment.id, actionUrl: '/admin/finance', pushSent: true,
                });
                expect(notes[0]!.message).toBe(
                    'Maria Cobrada foi debitado duas vezes no cartão: a cobrança do contrato "Plano Fixo Z1" já estava paga (pi_B) e outro pagamento de R$ 840,00 também foi aprovado (pi_A). Estorne pi_A no painel do Stripe.',
                );
            }
            // Admin excluído e o próprio cliente não recebem.
            expect(await notesOf(removedAdmin.id)).toHaveLength(0);
            expect(await notesOf(user.id)).toHaveLength(0);
            const audits = await doubleAudits(payment.id);
            expect(audits).toHaveLength(1);
            expect(audits[0]!.performedBy).toBe('SYSTEM');
            expect(JSON.parse(audits[0]!.changes!)).toEqual({ extraPaymentIntentId: 'pi_A', paidByPaymentIntentId: 'pi_B', amount: 84000 });
            expect(err.mock.calls.map(c => String(c[0])).filter(s => s.includes('cobrança em DOBRO'))).toHaveLength(1);

            // Webhook reentregue (e o helper chamado direto, como faz o job ao cancelar o PI anterior): continua 1.
            await succeeded(payment.id, 'pi_A', 84000);
            expect(await alertDoubleCardCharge(payment.id, { extraPi: 'pi_A', paidByPi: 'pi_B' })).toBe(false);
            expect(await notesOf(admin.id)).toHaveLength(1);
            expect(await notesOf(admin2.id)).toHaveLength(1);
            expect(await doubleAudits(payment.id)).toHaveLength(1);
        } finally {
            err.mockRestore();
        }
        // A cobrança não muda: continua PAID pelo PI que deu a baixa.
        expect(await row(payment.id)).toMatchObject({ status: 'PAID', providerRef: 'pi_B' });
    });

    it('succeeded do MESMO PaymentIntent que deu a baixa (webhook depois do verify / reentrega) → nenhum aviso', async () => {
        const { admin, admin2, payment } = await paidByAnotherIntent();

        expect((await succeeded(payment.id, 'pi_B', 84000)).status).toBe(200);
        expect((await succeeded(payment.id, 'pi_B', 84000)).status).toBe(200);

        expect(await notesOf(admin.id)).toHaveLength(0);
        expect(await notesOf(admin2.id)).toHaveLength(0);
        expect(await doubleAudits(payment.id)).toHaveLength(0);
    });

    it('um TERCEIRO PaymentIntent aprovado é outro débito: novo aviso (a dedupe é por PaymentIntent), com o valor do PI aprovado', async () => {
        const { admin, payment } = await paidByAnotherIntent();
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            await succeeded(payment.id, 'pi_A', 84000);
            await succeeded(payment.id, 'pi_C', 91234);
        } finally {
            err.mockRestore();
        }
        const notes = await notesOf(admin.id);
        expect(notes).toHaveLength(2);
        expect(notes[1]!.message).toContain('R$ 912,34');
        expect(notes[1]!.message).toContain('Estorne pi_C no painel do Stripe');
        expect(await doubleAudits(payment.id)).toHaveLength(2);
    });

    it('linha PAID por outro MEIO (PIX) não gera o aviso de "dois PaymentIntents" — fica o rastro no log; PENDING segue virando PAID sem aviso', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const { user } = await client();
        const pix = await mkPayment(user.id, { provider: 'SICOOB', amount: 84000, status: 'PAID', paidAt: secondsAgo(60) });
        await prisma.payment.update({ where: { id: pix.id }, data: { providerRef: pixTxidForAttempt(pix.id, 1) } });
        const pending = await mkPayment(user.id, { provider: 'STRIPE', providerRef: 'pi_ok', amount: 84000 });
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            await succeeded(pix.id, 'pi_A', 84000);
            expect(err.mock.calls.map(c => String(c[0])).filter(s => s.includes('[Webhook:Stripe][SECURITY]') && s.includes('pi_A'))).toHaveLength(1);
            await succeeded(pending.id, 'pi_ok', 84000);
        } finally {
            err.mockRestore();
        }
        expect((await row(pending.id)).status).toBe('PAID');
        expect(await notesOf(admin.id)).toHaveLength(0);
        expect(await prisma.auditLog.count({ where: { action: 'DOUBLE_CARD_CHARGE' } })).toBe(0);
    });

    it('alertDoubleCardCharge nunca avisa fora do caso: cobrança que não está PAID, PI igual ao da baixa, cobrança inexistente', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const { user } = await client();
        const pending = await mkPayment(user.id, { provider: 'STRIPE', providerRef: 'pi_B', amount: 84000 });
        const paid = await mkPayment(user.id, { provider: 'STRIPE', providerRef: 'pi_B', amount: 84000, status: 'PAID', paidAt: new Date() });

        expect(await alertDoubleCardCharge(pending.id, { extraPi: 'pi_A' })).toBe(false);
        expect(await alertDoubleCardCharge(paid.id, { extraPi: 'pi_B' })).toBe(false);
        expect(await alertDoubleCardCharge('00000000-0000-4000-8000-000000000000', { extraPi: 'pi_A' })).toBe(false);
        expect(await notesOf(admin.id)).toHaveLength(0);
    });

    it('catálogo: evento admin, crítico, com push, persistido — no padrão do admin_payment_on_cancelled_charge', () => {
        const ev = NOTIFICATION_EVENT_BY_KEY.admin_card_double_charge!;
        const ref = NOTIFICATION_EVENT_BY_KEY.admin_payment_on_cancelled_charge!;
        expect(ev).toMatchObject({ audience: 'admin', group: 'admin', kind: 'persisted', severity: 'critical', pushDefault: true });
        expect({ type: ev.type, actionUrl: ev.actionUrl }).toEqual({ type: ref.type, actionUrl: ref.actionUrl });
        expect(ev.variables.map(v => v.name)).toEqual(['cliente', 'valor', 'contrato', 'piPago', 'piExtra']);
        expect(ev.defaultMessage).toMatch(/Estorne \{piExtra\} no painel do Stripe/);
    });
});

// ═══ Z1-d ════════════════════════════════════════════════════════════════════════════════════════
describe('Z1-d — POST /contracts/:id/pay só reaproveita cobrança do PLANO (bookingId null), nunca um extra de gravação', () => {
    const addon = JSON.stringify({ addonKeys: ['CORTES'] });
    const pay = (who: Who, contractId: string, paymentMethod: 'PIX' | 'CARTAO') => call('POST', `/api/contracts/${contractId}/pay`, who, { paymentMethod });

    async function awaitingWithLiveExtra() {
        const { user } = await client();
        const contract = await mkContract(user.id, { type: 'CUSTOM', status: 'AWAITING_PAYMENT', paymentDeadline: minutes(10), paymentMethod: 'CARTAO', accessMode: 'FULL' });
        const live = await mkBooking(user.id, contract.id, { status: 'CONFIRMED' });
        // O extra vence ANTES da parcela: era ele o "pendente" reaproveitado pelo /pay (gravação viva).
        const extra = await mkPayment(user.id, { contractId: contract.id, bookingId: live.id, provider: 'STRIPE', amount: 5000, dueDate: secondsAgo(86_400), paymentUrl: addon });
        return { user, contract, live, extra };
    }

    it('CARTÃO: com um extra de gravação VIVA vencendo antes, o /pay cobra a parcela do plano; o extra fica intocado', async () => {
        const { user, contract, extra } = await awaitingWithLiveExtra();
        const plan = await mkPayment(user.id, { contractId: contract.id, provider: 'STRIPE', amount: 84000, dueDate: minutes(60) });

        const r = await pay(user, contract.id, 'CARTAO');

        expect(r.status).toBe(200);
        expect(r.body.paymentId).toBe(plan.id);
        expect(r.body.amount).toBe(84000);
        expect(m(stripe.stripeCreatePaymentIntent).mock.calls).toHaveLength(1);
        expect(m(stripe.stripeCreatePaymentIntent).mock.calls[0]![0]).toMatchObject({ paymentId: plan.id, amount: 84000 });
        expect(await row(extra.id)).toMatchObject({ status: 'PENDING', providerRef: null, chargedAmount: null, amount: 5000 });
    });

    it('PIX: idem — o QR sai da parcela do plano (valor do plano), nunca do extra', async () => {
        const { user, contract, extra } = await awaitingWithLiveExtra();
        const plan = await mkPayment(user.id, { contractId: contract.id, provider: 'STRIPE', amount: 84000, dueDate: minutes(60) });

        const r = await pay(user, contract.id, 'PIX');

        expect(r.status).toBe(200);
        expect(r.body.paymentId).toBe(plan.id);
        expect(r.body.amount).toBe(84000);
        expect(m(sicoob.sicoobCreatePix).mock.calls.map(c => c[0].amount)).toEqual([84000]);
        expect(await row(extra.id)).toMatchObject({ status: 'PENDING', providerRef: null, pixString: null, amount: 5000 });
    });

    it('só o extra pendente (nenhuma parcela do plano ainda): o /pay cria a cobrança do plano em vez de cobrar o extra', async () => {
        const { user, contract, extra } = await awaitingWithLiveExtra();

        const r = await pay(user, contract.id, 'CARTAO');

        expect(r.status).toBe(200);
        expect(r.body.paymentId).not.toBe(extra.id);
        const created = await row(r.body.paymentId);
        expect(created).toMatchObject({ contractId: contract.id, bookingId: null, status: 'PENDING', provider: 'STRIPE' });
        expect(created.amount).toBeGreaterThan(5000);
        expect(m(stripe.stripeCreatePaymentIntent).mock.calls[0]![0]).toMatchObject({ paymentId: created.id, amount: created.amount });
        expect(await row(extra.id)).toMatchObject({ status: 'PENDING', providerRef: null, chargedAmount: null, amount: 5000 });
    });
});

// ═══ Z1-e ════════════════════════════════════════════════════════════════════════════════════════
describe('Z1-e — create-payment não reabre uma linha FAILED cujo PaymentIntent já aprovou / está processando (PAY-6, passo 3)', () => {
    const pay = (who: Who, paymentId: string, paymentMethod: 'pix' | 'cartao') => call('POST', '/api/stripe/create-payment', who, { paymentId, paymentMethod });
    const intent = (id: string, status: string, amount = 84000) => ({ id, status, amount, client_secret: `cs_${id}`, created: Math.floor(Date.now() / 1000) - 60 });

    async function failedCardRow(providerRef: string | null = 'pi_late') {
        const { user } = await client();
        const contract = await mkContract(user.id, { type: 'FIXO', paymentPlan: 'MONTHLY', paymentMethod: 'CARTAO' });
        const payment = await mkPayment(user.id, { contractId: contract.id, provider: 'STRIPE', providerRef, amount: 84000, chargedAmount: 84000, status: 'FAILED', dueDate: secondsAgo(60) });
        return { user, contract, payment };
    }

    it('PI já APROVADO: cartão e PIX → 409 CARD_PAYMENT_IN_FLIGHT; a linha segue FAILED apontando para o PI (nada é emitido) e o webhook a baixa', async () => {
        const { user, payment } = await failedCardRow();
        m(stripe.stripeGetPaymentIntent).mockResolvedValue(intent('pi_late', 'succeeded'));
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            for (const method of ['cartao', 'pix'] as const) {
                const r = await pay(user, payment.id, method);
                expect(r.status, method).toBe(409);
                expect(r.body.code).toBe('CARD_PAYMENT_IN_FLIGHT');
                expect(r.body.error).toMatch(/já foi aprovado no cartão/);
            }
        } finally {
            err.mockRestore();
        }
        expect(stripe.stripeCreatePaymentIntent).not.toHaveBeenCalled();
        expect(stripe.stripeCancelPaymentIntent).not.toHaveBeenCalled();
        expect(sicoob.sicoobCreatePix).not.toHaveBeenCalled();
        expect(await row(payment.id)).toMatchObject({ status: 'FAILED', provider: 'STRIPE', providerRef: 'pi_late', chargedAmount: 84000 });

        // O providerRef preservado é o que deixa o webhook de aprovação dar a baixa (regra do PAY-6).
        const hook = await call('POST', '/api/webhooks/stripe', undefined, {
            type: 'payment_intent.succeeded',
            data: { object: { id: 'pi_late', amount: 84000, metadata: { paymentId: payment.id }, payment_method_types: ['card'] } },
        });
        expect(hook.status).toBe(200);
        expect(await row(payment.id)).toMatchObject({ status: 'PAID', providerRef: 'pi_late' });
    });

    it('PI PROCESSANDO → 409 com a mensagem de pagamento em processamento; a linha não é reaberta', async () => {
        const { user, payment } = await failedCardRow();
        m(stripe.stripeGetPaymentIntent).mockResolvedValue(intent('pi_late', 'processing'));

        const r = await pay(user, payment.id, 'pix');

        expect(r.status).toBe(409);
        expect(r.body.code).toBe('CARD_PAYMENT_IN_FLIGHT');
        expect(r.body.error).toMatch(/em processamento/);
        expect(sicoob.sicoobCreatePix).not.toHaveBeenCalled();
        expect(await row(payment.id)).toMatchObject({ status: 'FAILED', providerRef: 'pi_late' });
    });

    it('PI ainda pagável (requires_payment_method) → reabre como antes: PIX emite o QR; o cartão devolve um PaymentIntent', async () => {
        const viaPix = await failedCardRow('pi_open_a');
        m(stripe.stripeGetPaymentIntent).mockResolvedValue(intent('pi_open_a', 'requires_payment_method'));
        const pix = await pay(viaPix.user, viaPix.payment.id, 'pix');
        expect(pix.status).toBe(200);
        expect(pix.body.pixString).toBeTruthy();
        expect(await row(viaPix.payment.id)).toMatchObject({ status: 'PENDING', provider: 'SICOOB' });

        const viaCard = await failedCardRow('pi_open_b');
        m(stripe.stripeGetPaymentIntent).mockResolvedValue(intent('pi_open_b', 'requires_payment_method'));
        const card = await pay(viaCard.user, viaCard.payment.id, 'cartao');
        expect(card.status).toBe(200);
        expect(card.body.clientSecret).toBeTruthy();
        expect(await row(viaCard.payment.id)).toMatchObject({ status: 'PENDING', provider: 'STRIPE', providerRef: card.body.paymentIntentId });
    });

    it('consulta ao Stripe falhou, Stripe desligado ou PI inexistente → reabre como antes (o PIX não depende do Stripe)', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const down = await failedCardRow('pi_down');
            m(stripe.stripeGetPaymentIntent).mockRejectedValue(new Error('connection reset'));
            expect((await pay(down.user, down.payment.id, 'pix')).status).toBe(200);
            expect((await row(down.payment.id)).status).toBe('PENDING');

            const off = await failedCardRow('pi_off');
            m(stripe.stripeGetPaymentIntent).mockClear();
            m(stripe.isStripeEnabled).mockResolvedValue(false);
            expect((await pay(off.user, off.payment.id, 'pix')).status).toBe(200);
            expect(stripe.stripeGetPaymentIntent).not.toHaveBeenCalled();
            m(stripe.isStripeEnabled).mockResolvedValue(true);

            const gone = await failedCardRow('pi_gone');
            m(stripe.stripeGetPaymentIntent).mockResolvedValue(undefined);
            expect((await pay(gone.user, gone.payment.id, 'pix')).status).toBe(200);
            expect((await row(gone.payment.id)).status).toBe('PENDING');
        } finally {
            warn.mockRestore();
        }
    });

    it('linha FAILED sem PaymentIntent (sem ref, PI mock ou cobrança PIX) não consulta o Stripe antes de reabrir', async () => {
        const noRef = await failedCardRow(null);
        const mock = await failedCardRow('pi_mock_123');
        const { user } = await client();
        const pixRow = await mkPayment(user.id, { provider: 'SICOOB', amount: 84000, status: 'FAILED' });

        for (const [who, id] of [[noRef.user, noRef.payment.id], [mock.user, mock.payment.id], [user, pixRow.id]] as const) {
            const r = await pay(who, id, 'pix');
            expect(r.status, id).toBe(200);
            expect((await row(id)).status).toBe('PENDING');
        }
        expect(stripe.stripeGetPaymentIntent).not.toHaveBeenCalled();
    });
});

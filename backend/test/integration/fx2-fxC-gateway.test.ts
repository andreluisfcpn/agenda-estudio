import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

// ─── Gravação em segundo plano (Z1-f) ────────────────────────────────────────────────────────────
// `notifyPaymentConfirmed` (lib/paymentEffects) dispara o aviso "pagamento confirmado" SEM await: o teste
// termina e o INSERT em `notifications` (que ainda confere a FK em `users`) cruza com o TRUNCATE do
// beforeEach seguinte → `deadlock detected` (40P01) intermitente no teste SEGUINTE a qualquer confirmação
// de pagamento (job, PIX alreadyPaid, simulate). As funções reais continuam valendo; o mock só as embrulha
// para o afterEach abaixo poder AGUARDAR o que ficou pendente.
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

// ─── Mocks dos provedores (Cora / Sicoob / Stripe): nenhuma chamada de rede real ─────────────────
vi.mock('../../src/lib/coraPaymentHelper', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../../src/lib/coraPaymentHelper')>();
    return { ...orig, createCoraPayment: vi.fn() };
});
vi.mock('../../src/lib/coraService', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../../src/lib/coraService')>();
    return { ...orig, coraCreateBoleto: vi.fn(), coraCancelBoleto: vi.fn(async () => undefined), coraGetBoleto: vi.fn() };
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
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { prisma } from '../../src/lib/prisma';
import { redis } from '../../src/lib/redis';
import { config } from '../../src/config/index';
import { saoPauloParts } from '../../src/lib/spTime';
import { addDaysYmd } from '../../src/lib/avulsoMakeup';
import { invalidateConfigCache } from '../../src/lib/businessConfig';
import { getPackageSlots, getSlotDuration } from '../../src/utils/pricing';
import { buildStaticBrCode } from '../../src/lib/brcode';
import * as coraHelper from '../../src/lib/coraPaymentHelper';
import * as cora from '../../src/lib/coraService';
import * as sicoob from '../../src/lib/sicoobService';
import * as stripe from '../../src/lib/stripeService';
import { issuePixCharge, cardIntentAwaitingCustomer, cardIntentInFlight, PIX_LIVE_CHARGE_MESSAGE } from '../../src/lib/pixGateway';
import { reconcileCoraPayment } from '../../src/lib/coraReconciliation';
import { getBoletoStatus, BOLETO_PROVIDER_DISABLED_MESSAGE, BOLETO_SWITCH_OFF_MESSAGE } from '../../src/lib/paymentGateway';
import { runAutoChargeJob } from '../../src/jobs/autoChargeJob';
import contractRoutes from '../../src/modules/contracts/routes';
import stripeRoutes from '../../src/modules/stripe/routes';
import pricingRoutes from '../../src/modules/pricing/routes';
import bookingRoutes from '../../src/modules/bookings/routes';
import paymentRoutes from '../../src/modules/payments/routes';
import { mkUser, mkContract, mkPayment, mkBooking, mkCpf } from './factories';

// Correções da revisão adversarial do lote 2 — frente fxC-gateway:
//  AC-1  o autoChargeJob só cobra PARCELAS DO PLANO (bookingId null); extras de gravação nunca.
//  AC-2  o job não cobra por cima de um checkout de cartão ABERTO (PI aguardando o cliente, < 30 min) e,
//        depois de quitar, cancela em best-effort o PaymentIntent anterior da parcela.
//  PAY-3 issuePixCharge só baixa o amount para o preço PIX DEPOIS de conciliar/aposentar a cobrança
//        anterior (boleto Cora já pago não se perde); emissão que falha não deixa o amount rebaixado.
//  SEC-1 POST /payments/:id/simulate e GET /payments/sandbox-mode: provedor EFETIVO habilitado E em sandbox
//        (trava de deploy do Sicoob); linha placeholder CORA com a integração desligada nunca simula.
//  SEC-2 / PAY-2 a chave do boleto nasce DESLIGADA (seeds + migração só de dados, idempotente).
//  SEC-3 a rota PÚBLICA GET /pricing/payment-methods devolve o boleto saneado; o estado completo é do ADMIN.
//  CHK-3 (backend) o admin emite boleto numa cobrança AVULSA; o cliente segue barrado nos fluxos de 10 min.

type Who = { id: string; email: string | null; role: string };
const m = <T extends (...a: any[]) => any>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>;
const secondsAgo = (s: number) => new Date(Date.now() - s * 1000);
const unixSecondsAgo = (s: number) => Math.floor((Date.now() - s * 1000) / 1000);

let server: Server;
let base = '';

beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/contracts', contractRoutes);
    app.use('/api/stripe', stripeRoutes);
    app.use('/api/pricing', pricingRoutes);
    app.use('/api/bookings', bookingRoutes);
    app.use('/api/payments', paymentRoutes);
    await new Promise<void>((done) => { server = app.listen(0, () => done()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
});

beforeEach(async () => {
    vi.clearAllMocks();
    invalidateConfigCache();
    m(coraHelper.createCoraPayment).mockImplementation(async (req: { idempotencyKey?: string }) => ({
        result: { id: `inv_${(req.idempotencyKey || 'x').slice(0, 8)}`, status: 'OPEN' },
        pixString: null,
        qrCodeBase64: null,
        boletoUrl: `https://cora.test/boleto/${req.idempotencyKey}.pdf`,
        barcode: '34191.79001 01043.510047 91020.150008 1 00000000000000',
    }));
    m(cora.coraCancelBoleto).mockResolvedValue(undefined);
    m(cora.coraGetBoleto).mockResolvedValue(undefined);
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
    m(stripe.stripeCancelPaymentIntent).mockResolvedValue({ status: 'canceled', canceled: true });
    m(stripe.stripeGetOrCreateCustomer).mockResolvedValue('cus_test');
    m(stripe.stripeChargeOffSession).mockImplementation(async (_c: string, _pm: string, _amt: number, meta: { paymentId: string }) =>
        ({ clientSecret: '', paymentIntentId: `pi_auto_${meta.paymentId.slice(0, 8)}`, status: 'succeeded' }));
});

// Z1-f: nenhum teste termina com notificação ainda gravando (ver o mock de notificationService no topo).
afterEach(async () => {
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

type Integration = { enabled: boolean; environment: 'sandbox' | 'production' };
/** Integrações deste cenário (omitida = a linha não existe). */
async function integrations(opts: { sicoob?: Integration; cora?: Integration; stripe?: Integration }) {
    const rows: [string, Integration | undefined][] = [['SICOOB', opts.sicoob], ['CORA', opts.cora], ['STRIPE', opts.stripe]];
    for (const [provider, i] of rows) {
        if (i) await prisma.integrationConfig.create({ data: { provider, enabled: i.enabled, environment: i.environment, config: '{}' } });
    }
}
const on = (environment: 'sandbox' | 'production' = 'sandbox'): Integration => ({ enabled: true, environment });
const off = (environment: 'sandbox' | 'production' = 'sandbox'): Integration => ({ enabled: false, environment });

/** Métodos de pagamento; `boleto` = chave-mestra (PaymentMethodConfig BOLETO.active). */
async function methods(boleto: boolean) {
    for (const [i, key] of ['PIX', 'CARTAO', 'BOLETO'].entries()) {
        await prisma.paymentMethodConfig.create({
            data: { key, label: key, shortLabel: key, emoji: '-', description: key, color: '#000000', active: key === 'BOLETO' ? boleto : true, sortOrder: i },
        });
    }
}

/** Roda `fn` como se o servidor fosse um deploy de produção (a trava do Sicoob lê NODE_ENV a cada chamada). */
async function asProductionDeploy<T>(fn: () => Promise<T>): Promise<T> {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
        return await fn();
    } finally {
        process.env.NODE_ENV = prev;
    }
}

const row = (id: string) => prisma.payment.findUniqueOrThrow({ where: { id } });
const todaySp = saoPauloParts(new Date()).dateStr;
function nextWeekday(wanted: number, minDays: number): string {
    for (let d = addDaysYmd(todaySp, minDays); ; d = addDaysYmd(d, 1)) {
        if (new Date(`${d}T12:00:00Z`).getUTCDay() === wanted) return d;
    }
}

/** Cliente com cobrança automática ligada, Customer no Stripe e um cartão salvo padrão. */
let customerSeq = 0;
async function autoChargeClient(over: Record<string, unknown> = {}) {
    const user = await mkUser({ autoChargeEnabled: true, stripeCustomerId: `cus_auto_${++customerSeq}`, cpfCnpj: mkCpf(), ...over });
    await prisma.savedPaymentMethod.create({
        data: { userId: user.id, stripePaymentMethodId: `pm_${user.id.slice(0, 8)}`, brand: 'visa', last4: '4242', expMonth: 12, expYear: 2031, isDefault: true },
    });
    return user;
}
const offSessionIds = () => m(stripe.stripeChargeOffSession).mock.calls.map(c => c[3].paymentId as string);

// ─── AC-1 ────────────────────────────────────────────────────────────────────────────────────────
describe('AC-1 — a cobrança automática só debita PARCELAS DO PLANO (bookingId null)', () => {
    beforeEach(async () => { await integrations({ stripe: on() }); });

    it('extra de gravação pendente (checkout abandonado) NÃO é cobrado nem ativado; a parcela do plano é', async () => {
        const user = await autoChargeClient();
        const contract = await mkContract(user.id, { type: 'FIXO', paymentPlan: 'MONTHLY', paymentMethod: 'CARTAO' });
        const installment = await mkPayment(user.id, { contractId: contract.id, provider: 'STRIPE', amount: 84000, dueDate: secondsAgo(3600) });
        const booking = await mkBooking(user.id, contract.id);
        const extra = await mkPayment(user.id, {
            contractId: contract.id, bookingId: booking.id, provider: 'CORA', amount: 5000, dueDate: secondsAgo(3600),
            paymentUrl: JSON.stringify({ addonKeys: ['CORTES'] }),
        });

        await runAutoChargeJob();

        expect(offSessionIds()).toEqual([installment.id]);
        expect((await row(installment.id)).status).toBe('PAID');
        expect(await row(extra.id)).toMatchObject({ status: 'PENDING', provider: 'CORA', providerRef: null, chargedAmount: null });
        expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).addOns).not.toContain('CORTES');

        await runAutoChargeJob(); // outra rodada (ex.: restart do servidor): o extra continua intocado
        expect(offSessionIds()).toEqual([installment.id]);
    });

    it('variante em dobro: extra já pago numa 2ª tentativa + o 1º Payment órfão PENDING → nenhum débito', async () => {
        const user = await autoChargeClient();
        const contract = await mkContract(user.id, { type: 'FLEX', paymentPlan: 'MONTHLY', paymentMethod: 'CARTAO' });
        const booking = await mkBooking(user.id, contract.id, { addOns: ['CORTES'] }); // o extra já está ativo
        const addon = { contractId: contract.id, bookingId: booking.id, amount: 5000, dueDate: secondsAgo(7200), paymentUrl: JSON.stringify({ addonKeys: ['CORTES'] }) };
        const orphan = await mkPayment(user.id, { ...addon, provider: 'STRIPE' });
        await mkPayment(user.id, { ...addon, provider: 'STRIPE', status: 'PAID', paidAt: new Date() });

        await runAutoChargeJob();

        expect(stripe.stripeChargeOffSession).not.toHaveBeenCalled();
        expect(await row(orphan.id)).toMatchObject({ status: 'PENDING', providerRef: null, chargedAmount: null });
    });

    it('cobrança de uma reserva criada pelo admin (contrato avulso ATIVO + bookingId) também fica para o cliente pagar', async () => {
        const user = await autoChargeClient();
        const avulso = await mkContract(user.id, { type: 'AVULSO', paymentPlan: 'FULL', paymentMethod: 'CARTAO', durationMonths: 1 });
        const booking = await mkBooking(user.id, avulso.id, { status: 'RESERVED' });
        const charge = await mkPayment(user.id, { contractId: avulso.id, bookingId: booking.id, provider: 'STRIPE', amount: 30000, dueDate: secondsAgo(60) });

        await runAutoChargeJob();

        expect(stripe.stripeChargeOffSession).not.toHaveBeenCalled();
        expect((await row(charge.id)).status).toBe('PENDING');
    });
});

// ─── AC-2 ────────────────────────────────────────────────────────────────────────────────────────
describe('AC-2 — checkout de cartão aberto: o job espera; depois de quitar, cancela o PaymentIntent anterior', () => {
    beforeEach(async () => { await integrations({ stripe: on() }); });

    async function installmentWithOpenIntent(piId: string | null) {
        const user = await autoChargeClient();
        const contract = await mkContract(user.id, { type: 'FIXO', paymentPlan: 'MONTHLY', paymentMethod: 'CARTAO' });
        const due = await mkPayment(user.id, { contractId: contract.id, provider: 'STRIPE', providerRef: piId, amount: 84000, dueDate: secondsAgo(3600) });
        return { user, contract, due };
    }
    const openIntent = (id: string, createdSecondsAgo: number, status = 'requires_payment_method') =>
        m(stripe.stripeGetPaymentIntent).mockResolvedValue({ id, status, amount: 84000, created: unixSecondsAgo(createdSecondsAgo) });

    it('PI de cartão novo aguardando o cliente, criado há 60 s → o job NÃO cobra o cartão salvo; a parcela segue PENDING com o mesmo PI', async () => {
        const { due } = await installmentWithOpenIntent('pi_open_1');
        openIntent('pi_open_1', 60);

        await runAutoChargeJob();

        expect(stripe.stripeChargeOffSession).not.toHaveBeenCalled();
        expect(stripe.stripeCancelPaymentIntent).not.toHaveBeenCalled();
        expect(await row(due.id)).toMatchObject({ status: 'PENDING', providerRef: 'pi_open_1', chargedAmount: null });
    });

    it('o mesmo PI criado há 2 h (checkout abandonado) → o job cobra, a parcela vira PAID e o PI antigo é cancelado', async () => {
        const { due } = await installmentWithOpenIntent('pi_open_2');
        openIntent('pi_open_2', 2 * 3600);

        await runAutoChargeJob();

        expect(offSessionIds()).toEqual([due.id]);
        const paid = await row(due.id);
        expect(paid).toMatchObject({ status: 'PAID', chargedAmount: 84000 });
        expect(paid.providerRef).toBe(`pi_auto_${due.id.slice(0, 8)}`);
        expect(m(stripe.stripeCancelPaymentIntent).mock.calls).toEqual([['pi_open_2']]);
    });

    it('o PI anterior JÁ tinha aprovado quando foi cancelado (cobrança em dobro) → o ADMIN é avisado para estornar (Z1-c), além do erro no log; a parcela continua PAID', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const { due, user } = await installmentWithOpenIntent('pi_open_3');
        openIntent('pi_open_3', 2 * 3600);
        m(stripe.stripeCancelPaymentIntent).mockResolvedValue({ status: 'succeeded', canceled: false });
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            await runAutoChargeJob();
            const logged = errSpy.mock.calls.map(c => String(c[0])).filter(s => s.includes('[AUTO-CHARGE][SECURITY]'));
            expect(logged).toHaveLength(1);
            expect(logged[0]).toContain(due.id);
            expect(logged[0]).toContain('pi_open_3');
            expect(logged[0]).toMatch(/cobrança em DOBRO/);
        } finally {
            errSpy.mockRestore();
        }
        expect((await row(due.id)).status).toBe('PAID');
        // Z1-c: o mesmo helper do webhook (alertDoubleCardCharge) — aviso persistido ao admin, com os dois PIs.
        const paidBy = `pi_auto_${due.id.slice(0, 8)}`;
        const notes = await prisma.notification.findMany({ where: { userId: admin.id, entityType: 'PAYMENT', entityId: due.id } });
        expect(notes).toHaveLength(1);
        expect(notes[0]).toMatchObject({ type: 'SYSTEM', severity: 'critical', title: 'Cobrança em dobro no cartão', actionUrl: '/admin/finance' });
        expect(notes[0]!.message).toContain(user.name);
        expect(notes[0]!.message).toContain('pi_open_3');
        expect(notes[0]!.message).toContain(paidBy);
        expect(notes[0]!.message).toMatch(/Estorne pi_open_3 no painel do Stripe/);
        const audit = await prisma.auditLog.findMany({ where: { entityType: 'PAYMENT', entityId: due.id, action: 'DOUBLE_CARD_CHARGE' } });
        expect(audit).toHaveLength(1);
        expect(JSON.parse(audit[0]!.changes!)).toEqual({ extraPaymentIntentId: 'pi_open_3', paidByPaymentIntentId: paidBy, amount: 84000 });
    });

    it('PI anterior ainda PROCESSANDO no cancelamento → só o erro no log (sem aviso ao admin: se aprovar, o webhook avisa)', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const { due } = await installmentWithOpenIntent('pi_open_5');
        openIntent('pi_open_5', 2 * 3600);
        m(stripe.stripeCancelPaymentIntent).mockResolvedValue({ status: 'processing', canceled: false });
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            await runAutoChargeJob();
            const logged = errSpy.mock.calls.map(c => String(c[0])).filter(s => s.includes('[AUTO-CHARGE][SECURITY]'));
            expect(logged).toHaveLength(1);
            expect(logged[0]).toMatch(/possível cobrança em DOBRO/);
            expect(logged[0]).toContain('pi_open_5');
        } finally {
            errSpy.mockRestore();
        }
        expect((await row(due.id)).status).toBe('PAID');
        expect(await prisma.notification.count({ where: { userId: admin.id } })).toBe(0);
        expect(await prisma.auditLog.count({ where: { action: 'DOUBLE_CARD_CHARGE' } })).toBe(0);
    });

    it('Z1-b: os efeitos da confirmação NÃO esperam o cancelamento do PI anterior (o cancelamento é aguardado depois)', async () => {
        const { user, due } = await installmentWithOpenIntent('pi_open_6');
        openIntent('pi_open_6', 2 * 3600);
        let confirmedNoteAtCancelEnd: number | null = null;
        let releaseCancel!: () => void;
        const cancelGate = new Promise<void>((done) => { releaseCancel = done; });
        m(stripe.stripeCancelPaymentIntent).mockImplementation(async () => {
            await cancelGate; // o Stripe "demora" a responder o cancelamento
            confirmedNoteAtCancelEnd = await prisma.notification.count({ where: { userId: user.id, type: 'PAYMENT_CONFIRMED' } });
            return { status: 'canceled', canceled: true };
        });

        const job = runAutoChargeJob();
        // Com o cancelamento ainda preso, os efeitos (aviso "pagamento confirmado") já rodaram.
        for (let i = 0; i < 100 && (await prisma.notification.count({ where: { userId: user.id, type: 'PAYMENT_CONFIRMED' } })) === 0; i++) {
            await new Promise(r => setTimeout(r, 20));
        }
        expect(await prisma.notification.count({ where: { userId: user.id, type: 'PAYMENT_CONFIRMED' } })).toBe(1);
        expect((await row(due.id)).status).toBe('PAID');
        releaseCancel();
        await job; // o job só termina depois de aguardar o cancelamento

        expect(confirmedNoteAtCancelEnd).toBe(1);
        expect(m(stripe.stripeCancelPaymentIntent).mock.calls).toEqual([['pi_open_6']]);
    });

    it('cancelamento do PI antigo é best-effort: se o Stripe falhar, a parcela continua PAID e o job não acusa falha ao cliente', async () => {
        const { due } = await installmentWithOpenIntent('pi_open_4');
        openIntent('pi_open_4', 2 * 3600);
        m(stripe.stripeCancelPaymentIntent).mockRejectedValue(new Error('stripe fora do ar'));
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            await runAutoChargeJob();
            // Não cai no catch de "cobrança recusada" (que avisaria o cliente com auto_charge_failed).
            expect(errSpy.mock.calls.map(c => String(c[0])).filter(s => s.includes('[AUTO-CHARGE]'))).toEqual([]);
            expect(warnSpy.mock.calls.map(c => String(c[0])).some(s => s.includes('pi_open_4'))).toBe(true);
        } finally {
            errSpy.mockRestore();
            warnSpy.mockRestore();
        }
        expect(await row(due.id)).toMatchObject({ status: 'PAID', providerRef: `pi_auto_${due.id.slice(0, 8)}` });
    });

    it('sem PI anterior, PI mock ou o MESMO PI devolvido pelo Stripe → nada é cancelado', async () => {
        const none = await installmentWithOpenIntent(null);
        const mock = await installmentWithOpenIntent('pi_mock_abc');
        const same = await installmentWithOpenIntent('pi_same_1');
        m(stripe.stripeGetPaymentIntent).mockResolvedValue({ id: 'pi_same_1', status: 'requires_payment_method', amount: 84000, created: unixSecondsAgo(3 * 3600) });
        m(stripe.stripeChargeOffSession).mockImplementation(async (_c: string, _pm: string, _amt: number, meta: { paymentId: string }) =>
            ({ clientSecret: '', paymentIntentId: meta.paymentId === same.due.id ? 'pi_same_1' : `pi_auto_${meta.paymentId.slice(0, 8)}`, status: 'succeeded' }));

        await runAutoChargeJob();

        for (const s of [none, mock, same]) expect((await row(s.due.id)).status).toBe('PAID');
        expect(stripe.stripeCancelPaymentIntent).not.toHaveBeenCalled();
    });

    it('cardIntentAwaitingCustomer: só PI aberto e recente; cardIntentInFlight NÃO mudou (requires_payment_method continua liberando o PIX)', async () => {
        const at = (status: string, ago: number) => m(stripe.stripeGetPaymentIntent).mockResolvedValue({ id: 'pi_x', status, amount: 1, created: unixSecondsAgo(ago) });
        for (const status of ['requires_payment_method', 'requires_confirmation', 'requires_action']) {
            at(status, 60);
            expect(await cardIntentAwaitingCustomer('pi_x'), status).toBe(true);
            at(status, 31 * 60);
            expect(await cardIntentAwaitingCustomer('pi_x'), `${status} antigo`).toBe(false);
        }
        for (const status of ['succeeded', 'processing', 'requires_capture', 'canceled']) {
            at(status, 60);
            expect(await cardIntentAwaitingCustomer('pi_x'), status).toBe(false);
        }
        at('requires_payment_method', 60);
        expect(await cardIntentInFlight('pi_x')).toBe(false);
        expect(await cardIntentAwaitingCustomer(null)).toBe(false);
        expect(await cardIntentAwaitingCustomer('pi_mock_1')).toBe(false);
        expect(await cardIntentAwaitingCustomer('txid-que-nao-e-pi')).toBe(false);
        m(stripe.stripeGetPaymentIntent).mockRejectedValue(new Error('rede'));
        expect(await cardIntentAwaitingCustomer('pi_x')).toBe(false);
        m(stripe.isStripeEnabled).mockResolvedValue(false);
        expect(await cardIntentAwaitingCustomer('pi_x')).toBe(false);
    });
});

// ─── PAY-3 ───────────────────────────────────────────────────────────────────────────────────────
describe('PAY-3 — o desconto PIX só baixa o amount DEPOIS de conciliar/aposentar a cobrança anterior', () => {
    const CARD = 100000;
    const PIX = 90000;
    const mark = { pixDiscount: { pct: 10, cardAmount: CARD, pixAmount: PIX } };

    beforeEach(async () => {
        await methods(true);
        await integrations({ sicoob: on(), stripe: on(), cora: on() });
    });

    /** Cobrança à vista com a marca, no preço de CARTÃO, com um boleto Cora emitido por R$ 1.000 (sem QR). */
    async function fullChargeWithBoleto(over: Record<string, unknown> = {}, clientOver: Record<string, unknown> = {}) {
        const client = await mkUser({ cpfCnpj: mkCpf(), ...clientOver });
        const contract = await mkContract(client.id, { type: 'FIXO', paymentPlan: 'FULL', paymentMethod: 'BOLETO' });
        const payment = await mkPayment(client.id, {
            contractId: contract.id, provider: 'CORA', providerRef: 'inv_boleto_0001', amount: CARD,
            boletoUrl: 'https://cora.test/boleto/antigo.pdf', metadata: mark, ...over,
        });
        return { client, contract, payment };
    }

    it('boleto já PAGO na Cora (webhook ainda não chegou): abrir o PIX devolve alreadyPaid, a cobrança vira PAID em R$ 1.000 e nenhum QR é emitido', async () => {
        const { client, payment } = await fullChargeWithBoleto();
        m(cora.coraGetBoleto).mockResolvedValue({ id: 'inv_boleto_0001', status: 'PAID', total_amount: CARD, total_paid: CARD });

        const r = await call('POST', '/api/stripe/create-payment', client, { paymentId: payment.id, paymentMethod: 'pix' });

        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ status: 'PAID', alreadyPaid: true, amount: CARD });
        expect(await row(payment.id)).toMatchObject({ status: 'PAID', amount: CARD, provider: 'CORA', providerRef: 'inv_boleto_0001' });
        expect(sicoob.sicoobCreatePix).not.toHaveBeenCalled();
        expect(cora.coraGetBoleto).toHaveBeenCalledWith('inv_boleto_0001');
    });

    it('issuePixCharge direto: a conciliação do boleto roda com o amount ainda no preço de cartão', async () => {
        const { payment } = await fullChargeWithBoleto();
        let amountAtReconcile: number | null = null;
        m(cora.coraGetBoleto).mockImplementation(async () => {
            amountAtReconcile = (await row(payment.id)).amount;
            return { id: 'inv_boleto_0001', status: 'PAID', total_amount: CARD };
        });

        const res = await issuePixCharge(payment.id);

        expect(amountAtReconcile).toBe(CARD);
        expect(res).toMatchObject({ alreadyPaid: true, amount: CARD, pixString: null });
        expect((await row(payment.id)).status).toBe('PAID');
    });

    it('boleto ainda em aberto: o QR sai com o desconto e só então o amount passa a valer o preço PIX', async () => {
        const { payment } = await fullChargeWithBoleto();
        const amounts: number[] = [];
        m(cora.coraGetBoleto).mockImplementation(async () => {
            amounts.push((await row(payment.id)).amount);
            return { id: 'inv_boleto_0001', status: 'OPEN', total_amount: CARD };
        });

        const res = await issuePixCharge(payment.id);

        expect(amounts).toEqual([CARD]);
        expect(res).toMatchObject({ alreadyPaid: false, reused: false, amount: PIX, provider: 'SICOOB' });
        expect(m(sicoob.sicoobCreatePix).mock.calls.map(c => c[0].amount)).toEqual([PIX]);
        const after = await row(payment.id);
        expect(after).toMatchObject({ status: 'PENDING', amount: PIX, provider: 'SICOOB' });
        expect((after.metadata as any).pixCharge.amount).toBe(PIX);
        expect((after.metadata as any).pixDiscount).toEqual(mark.pixDiscount);
    });

    it('falha do provedor PIX na emissão NÃO altera o amount: o boleto de R$ 1.000 pago depois ainda concilia', async () => {
        const { payment } = await fullChargeWithBoleto();
        m(cora.coraGetBoleto).mockResolvedValue({ id: 'inv_boleto_0001', status: 'OPEN', total_amount: CARD });
        m(sicoob.sicoobCreatePix).mockRejectedValueOnce(new Error('Sicoob fora do ar'));

        await expect(issuePixCharge(payment.id)).rejects.toThrow(/Sicoob fora do ar/);

        expect(await row(payment.id)).toMatchObject({ status: 'PENDING', amount: CARD, provider: 'CORA', providerRef: 'inv_boleto_0001', pixString: null });
        m(cora.coraGetBoleto).mockResolvedValue({ id: 'inv_boleto_0001', status: 'PAID', total_amount: CARD });
        expect(await reconcileCoraPayment(payment.id)).toBe(true);
        expect(await row(payment.id)).toMatchObject({ status: 'PAID', amount: CARD });
    });

    it('cliente sem CPF (o PIX é recusado antes de emitir): o amount continua no preço de cartão; com o CPF, o QR sai com o desconto', async () => {
        const { client, payment } = await fullChargeWithBoleto({ provider: 'STRIPE', providerRef: null, boletoUrl: null }, { cpfCnpj: null });

        const denied = await call('POST', '/api/stripe/create-payment', client, { paymentId: payment.id, paymentMethod: 'pix' });
        expect(denied.status).toBe(400);
        expect(denied.body.code).toBe('CPF_CNPJ_REQUIRED');
        expect((await row(payment.id)).amount).toBe(CARD);

        await prisma.user.update({ where: { id: client.id }, data: { cpfCnpj: mkCpf() } });
        const ok = await call('POST', '/api/stripe/create-payment', client, { paymentId: payment.id, paymentMethod: 'pix' });
        expect(ok.status).toBe(200);
        expect(ok.body.amount).toBe(PIX);
        expect((await row(payment.id)).amount).toBe(PIX);
    });

    it('cobrança anterior ainda PAGÁVEL e não cancelável (viva): nada é repreçado nem emitido; nunca adota a cobrança do valor antigo', async () => {
        // Fatura Cora de PIX (tem pixString) emitida por R$ 1.000 que a Cora não deixa cancelar agora.
        const { payment } = await fullChargeWithBoleto({
            pixString: buildStaticBrCode({ key: 'k', amountCents: CARD, txid: 'x'.repeat(26) }),
            pixExpiresAt: new Date(Date.now() + 1800_000),
            metadata: { ...mark, pixCharge: { attempt: 1, amount: CARD } },
        });
        m(cora.coraGetBoleto).mockResolvedValue({ id: 'inv_boleto_0001', status: 'OPEN', total_amount: CARD });
        m(cora.coraCancelBoleto).mockRejectedValue(new Error('Cora 500'));

        await expect(issuePixCharge(payment.id)).rejects.toThrow(PIX_LIVE_CHARGE_MESSAGE);

        expect(sicoob.sicoobCreatePix).not.toHaveBeenCalled();
        expect(await row(payment.id)).toMatchObject({ status: 'PENDING', amount: CARD, provider: 'CORA', providerRef: 'inv_boleto_0001' });
    });

    it('o amount gravado acompanha SEMPRE o QR emitido, mesmo se um pedido gêmeo desfizer o repreço durante a emissão', async () => {
        const { payment } = await fullChargeWithBoleto({ provider: 'STRIPE', providerRef: null, boletoUrl: null });
        m(sicoob.sicoobCreatePix).mockImplementationOnce(async (p: { amount: number; txid: string }) => {
            // Pedido gêmeo cuja emissão falhou: devolve o amount ao preço de cartão no meio desta emissão.
            await prisma.payment.update({ where: { id: payment.id }, data: { amount: CARD } });
            return { id: p.txid, pixString: buildStaticBrCode({ key: 'k', amountCents: p.amount, txid: p.txid }), status: 'ATIVA', expiresAt: new Date(Date.now() + 3600_000) };
        });

        const res = await issuePixCharge(payment.id);

        expect(res.amount).toBe(PIX);
        const after = await row(payment.id);
        expect(after.amount).toBe(PIX);
        expect((after.metadata as any).pixCharge.amount).toBe(PIX);
    });
});

// ─── SEC-1 ───────────────────────────────────────────────────────────────────────────────────────
describe('SEC-1 — simulação só com o provedor EFETIVO habilitado e em sandbox (mesmo critério em /sandbox-mode e /simulate)', () => {
    /** Avulso do cliente como o POST /bookings o deixa: linha placeholder 'CORA', PENDING, sem cobrança emitida. */
    async function placeholderAvulso(provider: 'CORA' | 'STRIPE' | 'SICOOB' = 'CORA', over: Record<string, unknown> = {}) {
        const client = await mkUser({ cpfCnpj: mkCpf() });
        const contract = await mkContract(client.id, { type: 'AVULSO', paymentPlan: 'FULL', durationMonths: 1 });
        const booking = await mkBooking(client.id, contract.id, { status: 'RESERVED', holdExpiresAt: new Date(Date.now() + 600_000) });
        const payment = await mkPayment(client.id, { contractId: contract.id, bookingId: booking.id, provider, amount: 30000, ...over });
        return { client, contract, booking, payment };
    }
    const simulate = (who: Who | undefined, id: string) => call('POST', `/api/payments/${id}/simulate`, who);
    const sandboxMode = async (who: Who) => (await call('GET', '/api/payments/sandbox-mode', who)).body;

    async function expectRefused(who: Who, paymentId: string) {
        const r = await simulate(who, paymentId);
        expect(r.status).toBe(403);
        expect(r.body.error).toMatch(/sandbox/);
        expect(await row(paymentId)).toMatchObject({ status: 'PENDING', paidAt: null });
    }

    it('produção: linha placeholder CORA com a Cora DESLIGADA em sandbox + Sicoob de produção ativo → 403, continua PENDING; /sandbox-mode = false', async () => {
        await integrations({ sicoob: on('production'), cora: off('sandbox'), stripe: on('production') });
        const { client, booking, payment } = await placeholderAvulso('CORA');
        const admin = await mkUser({ role: 'ADMIN' });

        await asProductionDeploy(async () => {
            await expectRefused(client, payment.id);
            await expectRefused(admin, payment.id); // nem o admin simula uma cobrança de produção
            expect(await sandboxMode(client)).toEqual({ pix: false, card: false });
        });
        expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe('RESERVED');
    });

    it('a linha da Cora desligada em sandbox NUNCA habilita a simulação — nem fora de produção, sem outro provedor de PIX ativo', async () => {
        await integrations({ cora: off('sandbox'), stripe: on('production') });
        const { client, payment } = await placeholderAvulso('CORA');
        await expectRefused(client, payment.id);
        expect(await sandboxMode(client)).toEqual({ pix: false, card: false });
    });

    it('trava de deploy do Sicoob: num deploy de PRODUÇÃO o Sicoob marcado como sandbox não é o provedor efetivo → 403 e pix: false', async () => {
        await integrations({ sicoob: on('sandbox'), cora: off('sandbox') });
        const { client, payment } = await placeholderAvulso('SICOOB');
        await asProductionDeploy(async () => {
            await expectRefused(client, payment.id);
            expect((await sandboxMode(client)).pix).toBe(false);
        });
        // O MESMO banco num deploy de homologação/dev (Sicoob sandbox permitido) simula normalmente.
        expect((await sandboxMode(client)).pix).toBe(true);
        expect((await simulate(client, payment.id)).status).toBe(200);
    });

    it('homologação/dev com o provedor de PIX ativo em sandbox → 200 PAID e os efeitos da confirmação rodam (reserva confirmada)', async () => {
        await integrations({ sicoob: on('sandbox'), cora: off('sandbox'), stripe: on('sandbox') });
        const { client, booking, payment } = await placeholderAvulso('CORA');
        expect(await sandboxMode(client)).toEqual({ pix: true, card: true });

        const r = await simulate(client, payment.id);

        expect(r.status).toBe(200);
        expect(r.body.status).toBe('PAID');
        const paid = await row(payment.id);
        expect(paid.status).toBe('PAID');
        expect(paid.paidAt).not.toBeNull();
        expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe('CONFIRMED');
        // Repetir é idempotente.
        const again = await simulate(client, payment.id);
        expect(again.status).toBe(200);
        expect(again.body.status).toBe('PAID');
    });

    it('sandbox vale também num servidor com NODE_ENV=production quando o provedor efetivo é a Cora ATIVA em sandbox (homologação publicada)', async () => {
        await integrations({ sicoob: on('sandbox'), cora: on('sandbox') });
        const { client, payment } = await placeholderAvulso('CORA');
        await asProductionDeploy(async () => {
            expect((await sandboxMode(client)).pix).toBe(true); // Sicoob sandbox é barrado pelo deploy → cai na Cora sandbox
            expect((await simulate(client, payment.id)).status).toBe(200);
        });
        expect((await row(payment.id)).status).toBe('PAID');
    });

    it('cobrança JÁ emitida responde pelo provedor que a emitiu: boleto/PIX da Cora de produção não é simulável só porque o Sicoob está em sandbox', async () => {
        await integrations({ sicoob: on('sandbox'), cora: on('production') });
        const { client, payment } = await placeholderAvulso('CORA', { providerRef: 'inv_real_0001', boletoUrl: 'https://cora.test/boleto/real.pdf' });
        await expectRefused(client, payment.id);
        // Sem cobrança emitida (placeholder), quem atende é o PIX ativo (Sicoob sandbox) → simula.
        const placeholder = await placeholderAvulso('CORA');
        expect((await simulate(placeholder.client, placeholder.payment.id)).status).toBe(200);
    });

    it('cartão: Stripe habilitado em sandbox → simula; Stripe desligado (mesmo em sandbox) ou em produção → 403', async () => {
        await integrations({ sicoob: on('sandbox'), stripe: on('sandbox') });
        const ok = await placeholderAvulso('STRIPE');
        expect((await simulate(ok.client, ok.payment.id)).status).toBe(200);

        await prisma.integrationConfig.update({ where: { provider: 'STRIPE' }, data: { enabled: false } });
        const disabled = await placeholderAvulso('STRIPE');
        await expectRefused(disabled.client, disabled.payment.id);
        expect(await sandboxMode(disabled.client)).toEqual({ pix: true, card: false });

        await prisma.integrationConfig.update({ where: { provider: 'STRIPE' }, data: { enabled: true, environment: 'production' } });
        await expectRefused(disabled.client, disabled.payment.id);
        expect((await sandboxMode(disabled.client)).card).toBe(false);
    });

    it('pagamento de OUTRO usuário → 404 (o admin alcança qualquer um); sem login → 401', async () => {
        await integrations({ sicoob: on('sandbox') });
        const { payment } = await placeholderAvulso('CORA');
        const stranger = await mkUser();
        const denied = await simulate(stranger, payment.id);
        expect(denied.status).toBe(404);
        expect((await row(payment.id)).status).toBe('PENDING');
        expect((await simulate(undefined, payment.id)).status).toBe(401);
        expect((await call('GET', '/api/payments/sandbox-mode')).status).toBe(401);

        const admin = await mkUser({ role: 'ADMIN' });
        expect((await simulate(admin, payment.id)).status).toBe(200);
        expect((await row(payment.id)).status).toBe('PAID');
    });
});

// ─── SEC-2 / PAY-2 ───────────────────────────────────────────────────────────────────────────────
describe('SEC-2 / PAY-2 — a chave do boleto nasce DESLIGADA', () => {
    const backendRoot = resolve(__dirname, '..', '..');
    const migrationSql = readFileSync(resolve(backendRoot, 'prisma/migrations/20260930000100_boleto_switch_default_off/migration.sql'), 'utf8');
    const runMigration = () => prisma.$executeRawUnsafe(migrationSql);
    const boletoActive = async () => (await prisma.paymentMethodConfig.findUniqueOrThrow({ where: { key: 'BOLETO' } })).active;

    it('migração de dados: BOLETO herdado LIGADO com a Cora desligada (ou sem linha de integração) → desligado; PIX/Cartão intactos; idempotente', async () => {
        await methods(true);
        expect(await runMigration()).toBe(1); // sem nenhuma linha de integração
        expect(await boletoActive()).toBe(false);

        await prisma.paymentMethodConfig.update({ where: { key: 'BOLETO' }, data: { active: true } });
        await integrations({ cora: off('production'), sicoob: on('production') });
        expect(await runMigration()).toBe(1); // Cora cadastrada, mas desligada
        expect(await boletoActive()).toBe(false);

        expect(await runMigration()).toBe(0); // re-executar não muda nada
        const others = await prisma.paymentMethodConfig.findMany({ where: { key: { in: ['PIX', 'CARTAO'] } } });
        expect(others.map(o => o.active)).toEqual([true, true]);
    });

    it('migração de dados: quem JÁ opera boleto (Cora habilitada) não é tocado; banco sem a linha BOLETO → nada a fazer', async () => {
        expect(await runMigration()).toBe(0); // tabela vazia
        await methods(true);
        await integrations({ cora: on('production') });
        expect(await runMigration()).toBe(0);
        expect(await boletoActive()).toBe(true);
    });

    it('chave herdada desligada + Cora ativada DEPOIS → o boleto continua fora: GET /pricing/payment-methods sem BOLETO e create-payment boleto → 400 SWITCH_OFF', async () => {
        await methods(true); // banco antigo: BOLETO.active = true herdado do seed
        await integrations({ sicoob: on(), stripe: on(), cora: off() });
        await runMigration();
        await prisma.integrationConfig.update({ where: { provider: 'CORA' }, data: { enabled: true } }); // ex.: contingência de PIX

        const pub = await call('GET', '/api/pricing/payment-methods');
        expect(pub.body.methods.map((x: any) => x.key)).toEqual(['PIX', 'CARTAO']);
        expect(pub.body.boleto.available).toBe(false);
        expect(await getBoletoStatus()).toMatchObject({ enabled: false, providerEnabled: true, available: false, reason: 'SWITCH_OFF' });

        const client = await mkUser({ cpfCnpj: mkCpf() });
        const contract = await mkContract(client.id, { type: 'FIXO', paymentPlan: 'MONTHLY', paymentMethod: 'PIX' });
        const payment = await mkPayment(client.id, { contractId: contract.id, amount: 84000 });
        const r = await call('POST', '/api/stripe/create-payment', client, { paymentId: payment.id, paymentMethod: 'boleto' });
        expect(r.status).toBe(400);
        expect(r.body).toMatchObject({ code: 'BOLETO_UNAVAILABLE', reason: 'SWITCH_OFF' });
        expect(coraHelper.createCoraPayment).not.toHaveBeenCalled();
    });

    it('seeds: BOLETO nasce com active = false em todos (seed.prod, seed de dev, seed_pm.sql, scripts/seedPaymentMethods e o auto-seed de /payment-methods/all)', async () => {
        const read = (p: string) => readFileSync(resolve(backendRoot, p), 'utf8');
        const boletoLine = (src: string) => src.split(/\r?\n/).find(l => /key:\s*["']BOLETO["']/.test(l)) ?? '';
        for (const file of ['prisma/seed.prod.ts', 'prisma/seed.ts']) {
            expect(boletoLine(read(file)), file).toMatch(/active:\s*false/);
        }
        expect(read('seed_pm.sql').split(/\r?\n/).find(l => l.includes("'BOLETO'"))).toMatch(/'#f59e0b',\s*false,/);
        const script = read('src/scripts/seedPaymentMethods.ts');
        expect(script.slice(script.indexOf("key: 'BOLETO'"))).toMatch(/^[\s\S]*?active:\s*false/);
        expect(script.slice(script.indexOf("key: 'BOLETO'"))).not.toMatch(/active:\s*true/);

        const admin = await mkUser({ role: 'ADMIN' });
        const all = await call('GET', '/api/pricing/payment-methods/all', admin); // tabela vazia → auto-seed
        expect(all.body.methods.find((x: any) => x.key === 'BOLETO').active).toBe(false);
        expect(await boletoActive()).toBe(false);
    });
});

// ─── SEC-3 ───────────────────────────────────────────────────────────────────────────────────────
describe('SEC-3 — a rota PÚBLICA não expõe a chave, a integração Cora nem o texto de administração', () => {
    const matrix = [
        { boleto: false, cora: false, available: false, reason: 'PROVIDER_DISABLED', message: BOLETO_PROVIDER_DISABLED_MESSAGE },
        { boleto: true, cora: false, available: false, reason: 'PROVIDER_DISABLED', message: BOLETO_PROVIDER_DISABLED_MESSAGE },
        { boleto: false, cora: true, available: false, reason: 'SWITCH_OFF', message: BOLETO_SWITCH_OFF_MESSAGE },
        { boleto: true, cora: true, available: true, reason: null, message: null },
    ] as const;

    for (const k of matrix) {
        it(`chave ${k.boleto ? 'LIGADA' : 'desligada'} + Cora ${k.cora ? 'ATIVA' : 'inativa'}: público só vê available=${k.available}; o ADMIN (/all) vê o estado completo`, async () => {
            await methods(k.boleto);
            await integrations({ sicoob: on(), stripe: on(), cora: k.cora ? on() : off() });

            const pub = await call('GET', '/api/pricing/payment-methods'); // sem login
            expect(pub.status).toBe(200);
            expect(pub.body.boleto).toEqual({ enabled: k.available, providerEnabled: k.available, available: k.available, reason: null, message: null });
            expect(JSON.stringify(pub.body)).not.toMatch(/Cora|Integrações|Configurações|PROVIDER_DISABLED|SWITCH_OFF/);
            expect(pub.body.methods.map((x: any) => x.key)).toEqual(k.available ? ['PIX', 'CARTAO', 'BOLETO'] : ['PIX', 'CARTAO']);

            const admin = await mkUser({ role: 'ADMIN' });
            const all = await call('GET', '/api/pricing/payment-methods/all', admin);
            expect(all.status).toBe(200);
            expect(all.body.boleto).toEqual({ enabled: k.boleto, providerEnabled: k.cora, available: k.available, reason: k.reason, message: k.message });
        });
    }

    it('banco sem métodos (padrões fixos): o boleto público também vem saneado; /all exige ADMIN', async () => {
        const pub = await call('GET', '/api/pricing/payment-methods');
        expect(pub.body.methods.map((x: any) => x.key)).toEqual(['PIX', 'CARTAO']);
        expect(pub.body.boleto).toEqual({ enabled: false, providerEnabled: false, available: false, reason: null, message: null });

        const client = await mkUser();
        expect((await call('GET', '/api/pricing/payment-methods/all', client)).status).toBe(403);
        expect((await call('GET', '/api/pricing/payment-methods/all')).status).toBe(401);
    });
});

// ─── CHK-3 (backend) ─────────────────────────────────────────────────────────────────────────────
describe('CHK-3 — boleto na cobrança AVULSA do admin; o cliente segue barrado nos fluxos de 10 minutos', () => {
    /** Horário do avulso do CLIENTE deste describe (o único teste que deixa trava de horário no Redis). */
    const CLIENT_AVULSO = { date: nextWeekday(3, 3), startTime: '10:00' };
    beforeEach(async () => {
        await methods(true);
        await integrations({ sicoob: on(), stripe: on(), cora: on() });
        // A reserva do avulso do cliente deixa um lock de 10 min nos slots do horário: limpa o de uma rodada
        // anterior — SÓ as chaves que este describe usa (formato de makeLockKey em src/lib/redis.ts), nunca o
        // prefixo inteiro (apagaria as travas de reservas em espera de quem compartilhar o Redis).
        const slots = getPackageSlots(CLIENT_AVULSO.startTime, await getSlotDuration());
        await redis.del(...slots.map(slot => `booking:lock:${CLIENT_AVULSO.date}:${slot}`));
    });
    const boleto = (who: Who, paymentId: string) => call('POST', '/api/stripe/create-payment', who, { paymentId, paymentMethod: 'boleto' });

    it('admin cria a avulsa (PIX, "Cobrar o cliente agora") e emite BOLETO no sheet → 200 com o boleto no nome do CLIENTE', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser({ cpfCnpj: mkCpf() });
        const created = await call('POST', '/api/bookings/admin', admin, { userId: client.id, date: nextWeekday(2, 3), startTime: '10:00', status: 'RESERVED', paymentMethod: 'PIX' });
        expect(created.status, JSON.stringify(created.body)).toBe(201);
        const paymentId = created.body.paymentId as string;
        const before = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId }, include: { contract: true, booking: true } });
        // A avulsa do admin nasce com contrato AVULSO ATIVO e reserva SEM prazo de 10 min — não é "sem contrato".
        expect(before.contract).toMatchObject({ type: 'AVULSO', status: 'ACTIVE' });
        expect(before.booking).toMatchObject({ status: 'RESERVED', holdExpiresAt: null });
        expect(coraHelper.createCoraPayment).not.toHaveBeenCalled();

        const r = await boleto(admin, paymentId);

        expect(r.status, JSON.stringify(r.body)).toBe(200);
        expect(r.body).toMatchObject({ provider: 'CORA', paymentId, amount: before.amount });
        expect(r.body.boletoUrl).toMatch(/^https:\/\/cora\.test\/boleto\//);
        expect(m(coraHelper.createCoraPayment).mock.calls).toHaveLength(1);
        expect(m(coraHelper.createCoraPayment).mock.calls[0]![0]).toMatchObject({ userId: client.id, amount: before.amount, withPixQrCode: false, idempotencyKey: paymentId });
        expect(await row(paymentId)).toMatchObject({ status: 'PENDING', provider: 'CORA', amount: before.amount });
        expect((await row(paymentId)).boletoUrl).toBe(r.body.boletoUrl);
    });

    it('chave desligada → a mesma cobrança avulsa do admin recusa boleto (400 BOLETO_UNAVAILABLE)', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser({ cpfCnpj: mkCpf() });
        const created = await call('POST', '/api/bookings/admin', admin, { userId: client.id, date: nextWeekday(2, 3), startTime: '10:00', status: 'RESERVED', paymentMethod: 'PIX' });
        expect(created.status).toBe(201);
        await prisma.paymentMethodConfig.update({ where: { key: 'BOLETO' }, data: { active: false } });

        const r = await boleto(admin, created.body.paymentId);

        expect(r.status).toBe(400);
        expect(r.body).toMatchObject({ code: 'BOLETO_UNAVAILABLE', reason: 'SWITCH_OFF' });
        expect(coraHelper.createCoraPayment).not.toHaveBeenCalled();
    });

    it('avulso do CLIENTE (reserva de 10 minutos): boleto → 400 BOLETO_NOT_ALLOWED_HERE para o cliente e para o admin; PIX segue funcionando', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser({ cpfCnpj: mkCpf() });
        const created = await call('POST', '/api/bookings', client, { ...CLIENT_AVULSO, paymentMethod: 'PIX' });
        expect(created.status, JSON.stringify(created.body)).toBe(201);
        const paymentId = created.body.paymentId as string;
        expect(created.body.booking.holdExpiresAt).toBeTruthy();

        for (const who of [client, admin]) {
            const r = await boleto(who, paymentId);
            expect(r.status).toBe(400);
            expect(r.body.code).toBe('BOLETO_NOT_ALLOWED_HERE');
            expect(r.body.error).toMatch(/PIX ou cartão/);
        }
        expect(coraHelper.createCoraPayment).not.toHaveBeenCalled();
        expect((await row(paymentId)).boletoUrl).toBeNull();

        const pix = await call('POST', '/api/stripe/create-payment', client, { paymentId, paymentMethod: 'pix' });
        expect(pix.status).toBe(200);
    });

    it('contratação nova pelo cliente (/self, sem contrato ainda) e contrato AGUARDANDO pagamento → BOLETO_NOT_ALLOWED_HERE', async () => {
        const client = await mkUser({ cpfCnpj: mkCpf() });
        const selfPayment = await mkPayment(client.id, { amount: 283500, metadata: { contractData: { type: 'FIXO', paymentPlan: 'FULL', paymentMethod: 'PIX' } } });
        const awaiting = await mkContract(client.id, { type: 'SERVICO', status: 'AWAITING_PAYMENT', paymentDeadline: new Date(Date.now() + 600_000) });
        const awaitingPayment = await mkPayment(client.id, { contractId: awaiting.id, amount: 150000 });

        for (const id of [selfPayment.id, awaitingPayment.id]) {
            const r = await boleto(client, id);
            expect(r.status).toBe(400);
            expect(r.body.code).toBe('BOLETO_NOT_ALLOWED_HERE');
        }
        expect(coraHelper.createCoraPayment).not.toHaveBeenCalled();
    });
});

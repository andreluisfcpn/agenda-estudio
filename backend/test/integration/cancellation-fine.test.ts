import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// ─── Mocks dos provedores (Sicoob / Stripe) e do push: nenhuma chamada de rede real ─────────────
vi.mock('../../src/lib/sicoobService', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../../src/lib/sicoobService')>();
    return {
        ...orig,
        getSicoobEnvironment: vi.fn(async () => 'production'),
        sicoobGetCob: vi.fn(),
        sicoobRemoveCob: vi.fn(async () => true),
        sicoobCreatePix: vi.fn(),
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
        stripeCancelSubscription: vi.fn(async () => {}),
        stripeGetOrCreateCustomer: vi.fn(async () => 'cus_test'),
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
import { saoPauloParts } from '../../src/lib/spTime';
import * as sicoob from '../../src/lib/sicoobService';
import * as stripe from '../../src/lib/stripeService';
import * as push from '../../src/modules/push/pushService';
import { buildStaticBrCode } from '../../src/lib/brcode';
import { invalidateConfigCache } from '../../src/lib/businessConfig';
import { onPaymentConfirmed, voidContractPendingPayments } from '../../src/lib/paymentEffects';
import { sweepCancelledSicoobCharges } from '../../src/lib/sicoobReconciliation';
import { runAutoChargeJob } from '../../src/jobs/autoChargeJob';
import contractRoutes from '../../src/modules/contracts/routes';
import stripeRoutes from '../../src/modules/stripe/routes';
import webhookRoutes from '../../src/modules/webhooks/routes';
import { mkUser, mkContract, mkPayment, mkBooking } from './factories';

// E13 (lote 2, 30/09/2026) — multa de cancelamento:
//  • base = o que FALTA pagar do plano (parcelas não pagas, sem extras de gravação), CONGELADA no pedido
//    (nunca aumenta); parcela da base paga durante a análise SAI dela (mínimo entre a congelada e o que
//    ainda falta — casos dedicados em c-be-fixups.test.ts);
//  • "Cobrar multa" cria a cobrança identificada (metadata.kind), PENDENTE, fora do auto-charge;
//  • à vista quitado → sem multa; isenção → sem cobrança; cliente e admin são avisados (persistida + push);
//  • pedido / DELETE / PATCH só cancelam gravações que ainda NÃO aconteceram;
//  • anular parcelas aposenta a cobrança viva no provedor antes (PIX/PI pago → PAID, não CANCELLED);
//  • pagamento confirmado numa cobrança CANCELADA vira alerta ao admin;
//  • GET /contracts, /contracts/:id e /contracts/my expõem os dados para as telas (E13/E4/E11).

type Who = { id: string; email: string | null; role: string };

const VALID_CPF = '52998224725';
const m = <T extends (...a: any[]) => any>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>;
const getCob = m(sicoob.sicoobGetCob);
const removeCob = m(sicoob.sicoobRemoveCob);
const getPI = m(stripe.stripeGetPaymentIntent);
const cancelPI = m(stripe.stripeCancelPaymentIntent);
const chargeOffSession = m(stripe.stripeChargeOffSession);
const sendPush = m(push.sendPushToUser);

// txids no formato Sicoob (26–35 alfanuméricos).
const TX_LIVE = 'TXMULTAVIVA000000000000000001';
const TX_PAID = 'TXMULTAPAGA000000000000000001';

let server: Server;
let base = '';

beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/contracts', contractRoutes);
    app.use('/api/stripe', stripeRoutes);
    app.use('/api/webhooks', webhookRoutes);
    await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
    vi.clearAllMocks();
    invalidateConfigCache();
    m(sicoob.getSicoobEnvironment).mockResolvedValue('production');
    removeCob.mockResolvedValue(true);
    getCob.mockReset();
    m(sicoob.sicoobCreatePix).mockImplementation(async (p: { amount: number; txid: string; expiresSeconds?: number }) => ({
        id: p.txid,
        pixString: buildStaticBrCode({ key: 'k', amountCents: p.amount, txid: p.txid }),
        status: 'ATIVA',
        expiresAt: new Date(Date.now() + (p.expiresSeconds ?? 3600) * 1000),
    }));
    m(stripe.isStripeEnabled).mockResolvedValue(true);
    m(stripe.stripeCardInstallmentsSupported).mockResolvedValue(false);
    cancelPI.mockResolvedValue({ status: 'canceled', canceled: true });
    getPI.mockReset();
    m(stripe.stripeCreatePaymentIntent).mockImplementation(async (o: { paymentId: string; amount: number }) => ({
        clientSecret: `cs_${o.paymentId}_${o.amount}`, paymentIntentId: `pi_new_${o.paymentId.slice(0, 8)}_${o.amount}`, status: 'requires_payment_method',
    }));
    m(stripe.stripeGetOrCreateCustomer).mockResolvedValue('cus_test');
    sendPush.mockResolvedValue(1);
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

/** Data-calendário de SP (hoje + n dias) como meia-noite UTC — o formato de Booking.date. */
function spDay(n: number): Date {
    const d = new Date(`${saoPauloParts(new Date()).dateStr}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d;
}
const daysFromNow = (n: number) => new Date(Date.now() + n * 86_400_000);

async function setFinePct(v: number) {
    await prisma.businessConfig.upsert({
        where: { key: 'cancellation_fine_pct' },
        create: { key: 'cancellation_fine_pct', value: String(v), type: 'percent', label: 'Multa', group: 'policies' } as any,
        update: { value: String(v) },
    });
    invalidateConfigCache();
}

/** FIXO mensal de 3 parcelas de R$ 840: a 1ª paga, a 2ª e a 3ª pendentes (faltam R$ 1.680). */
async function monthlyFixo(opts: { clientData?: Record<string, unknown>; contract?: Record<string, unknown> } = {}) {
    const admin = await mkUser({ role: 'ADMIN' });
    const client = await mkUser({ ...(opts.clientData ?? {}) });
    const contract = await mkContract(client.id, {
        type: 'FIXO', paymentMethod: 'PIX', startDate: spDay(-20), endDate: spDay(64), ...(opts.contract ?? {}),
    });
    const p1 = await mkPayment(client.id, { contractId: contract.id, amount: 84000, status: 'PAID', paidAt: new Date(), dueDate: spDay(-20) });
    const p2 = await mkPayment(client.id, { contractId: contract.id, amount: 84000, dueDate: spDay(8) });
    const p3 = await mkPayment(client.id, { contractId: contract.id, amount: 84000, dueDate: spDay(36) });
    return { admin, client, contract, p1, p2, p3 };
}

const payStatus = async (id: string) => (await prisma.payment.findUniqueOrThrow({ where: { id } })).status;
const bookingStatus = async (id: string) => (await prisma.booking.findUniqueOrThrow({ where: { id } })).status;
const fineOf = (contractId: string) => prisma.payment.findFirst({
    where: { contractId, metadata: { path: ['kind'], equals: 'CANCELLATION_FINE' } },
});
/** "Pagamento confirmado" é disparado sem await pelos efeitos de pagamento → espera a linha aparecer. */
async function paymentConfirmedNotes(userId: string, expected = 1) {
    for (let i = 0; i < 40; i++) {
        const rows = await prisma.notification.findMany({ where: { userId, type: 'PAYMENT_CONFIRMED' } });
        if (rows.length >= expected) return rows;
        await new Promise(r => setTimeout(r, 50));
    }
    return prisma.notification.findMany({ where: { userId, type: 'PAYMENT_CONFIRMED' } });
}

// ─── 1) Cálculo, base congelada e decisão ────────────────────────────────────────────────────────
describe('multa = % do que FALTA pagar do plano, congelada no pedido', () => {
    it('pedido congela base e %; mudar o % depois não altera a multa; a parcela paga na análise sai da base', async () => {
        const { admin, client, contract, p1, p2, p3 } = await monthlyFixo();
        // Extra de gravação pendente: NÃO entra na base (tem bookingId).
        const booking = await mkBooking(client.id, contract.id, { date: spDay(-5), status: 'COMPLETED' });
        const extras = await mkPayment(client.id, { contractId: contract.id, bookingId: booking.id, amount: 5000, dueDate: spDay(-5) });

        const req = await call('POST', `/api/contracts/${contract.id}/request-cancellation`, client);
        expect(req.status).toBe(200);
        expect(req.body.contract.status).toBe('PENDING_CANCELLATION');
        expect(req.body.fine).toEqual({ finePct: 20, baseAmount: 168000, amount: 33600 });
        expect(req.body.contract.fineAmountPreview).toBe(33600);
        expect(req.body.message).toContain('R$ 336,00');
        expect(req.body.message).toContain('R$ 1.680,00');

        // A marca do pedido fica na auditoria do contrato (sem migration).
        const mark = await prisma.auditLog.findFirstOrThrow({ where: { entityType: 'CONTRACT', entityId: contract.id, action: 'CANCELLATION_REQUESTED' } });
        expect(JSON.parse(mark.changes!)).toMatchObject({
            baseAmount: 168000, finePct: 20, fineAmount: 33600,
            installments: expect.arrayContaining([{ id: p2.id, amount: 84000 }, { id: p3.id, amount: 84000 }]),
        });
        expect(mark.performedBy).toBe(client.id);

        // Durante a análise: o cliente paga a 2ª parcela e o estúdio muda o % nas políticas.
        await prisma.payment.update({ where: { id: p2.id }, data: { status: 'PAID', paidAt: new Date() } });
        await setFinePct(50);

        // O admin vê o valor em R$ ANTES de decidir (lista e detalhe): o % é o do pedido (20, não 50) e a
        // base é a EFETIVA — a 2ª parcela, paga durante a análise, saiu dela (nunca multa sobre o que foi pago).
        const list = await call('GET', '/api/contracts', admin);
        const row = list.body.contracts.find((c: any) => c.id === contract.id);
        expect(row).toMatchObject({
            status: 'PENDING_CANCELLATION',
            paidTotal: 168000,          // 1ª + 2ª pagas
            remainingTotal: 84000,      // hoje só falta a 3ª…
            fineBaseAmount: 84000,      // …e a base congelada (168000) cai para o que ainda falta
            finePct: 20,
            fineAmountPreview: 16800,
            cancellationFine: null,
            cancelledAt: null,
            alreadyRenewed: false,
        });
        expect(new Date(row.cancellationRequestedAt).getTime()).toBe(mark.createdAt.getTime());
        const detail = await call('GET', `/api/contracts/${contract.id}`, admin);
        expect(detail.body.contract).toMatchObject({ fineAmountPreview: 16800, fineBaseAmount: 84000, finePct: 20 });

        const res = await call('POST', `/api/contracts/${contract.id}/resolve-cancellation`, admin, { action: 'CHARGE_FEE' });
        expect(res.status).toBe(200);
        expect(res.body.contract.status).toBe('CANCELLED');
        expect(res.body.fine).toMatchObject({ amount: 16800, status: 'PENDING', finePct: 20, baseAmount: 84000 });
        expect(res.body.message).toContain('R$ 168,00');
        expect(res.body.voidedCount).toBe(2); // 3ª parcela + extra pendente

        const fine = await fineOf(contract.id);
        expect(fine).toMatchObject({ amount: 16800, status: 'PENDING', bookingId: null, userId: client.id });
        expect(fine!.id).toBe(res.body.fine.id);
        expect(fine!.metadata).toEqual({ kind: 'CANCELLATION_FINE', finePct: 20, baseAmount: 84000 });
        expect(fine!.dueDate).not.toBeNull();

        expect(await payStatus(p1.id)).toBe('PAID');
        expect(await payStatus(p2.id)).toBe('PAID');
        expect(await payStatus(p3.id)).toBe('CANCELLED');
        expect(await payStatus(extras.id)).toBe('CANCELLED');

        // Depois da decisão: a lista mostra a multa gerada e a DATA do cancelamento.
        const after = (await call('GET', '/api/contracts', admin)).body.contracts.find((c: any) => c.id === contract.id);
        expect(after.cancellationFine).toMatchObject({ id: fine!.id, amount: 16800, status: 'PENDING', finePct: 20, baseAmount: 84000 });
        expect(after.fineAmountPreview).toBe(16800);
        expect(after.remainingTotal).toBe(0);
        const cancelMark = await prisma.auditLog.findFirstOrThrow({ where: { entityType: 'CONTRACT', entityId: contract.id, action: 'CANCELLED' } });
        expect(new Date(after.cancelledAt).getTime()).toBe(cancelMark.createdAt.getTime());
        expect(JSON.parse(cancelMark.changes!)).toMatchObject({
            via: 'RESOLVE_CANCELLATION', action: 'CHARGE_FEE', fineAmount: 16800, baseAmount: 84000, frozenBaseAmount: 168000, finePaymentId: fine!.id,
        });
    });

    it('nenhuma parcela paga: a multa incide sobre o plano inteiro que falta; paga, não regera parcelas', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser();
        const contract = await mkContract(client.id, { type: 'FLEX', paymentMethod: 'CARTAO' });
        for (const n of [0, 28, 56]) await mkPayment(client.id, { contractId: contract.id, provider: 'STRIPE', amount: 84000, dueDate: daysFromNow(n) });

        expect((await call('POST', `/api/contracts/${contract.id}/request-cancellation`, client)).body.fine.amount).toBe(50400); // 20% de 2.520
        const res = await call('POST', `/api/contracts/${contract.id}/resolve-cancellation`, admin, { action: 'CHARGE_FEE' });
        expect(res.body.fine).toMatchObject({ amount: 50400, baseAmount: 252000 });
        const fine = await fineOf(contract.id);
        expect(fine!.provider).toBe('STRIPE'); // forma do contrato

        // Multa paga: só "pagamento confirmado" — nunca parcelas 2..N novas nem contrato reativado.
        await prisma.payment.update({ where: { id: fine!.id }, data: { status: 'PAID', paidAt: new Date() } });
        await onPaymentConfirmed(fine!.id);
        const rows = await prisma.payment.findMany({ where: { contractId: contract.id } });
        expect(rows).toHaveLength(4);
        expect(rows.filter(r => r.status === 'CANCELLED')).toHaveLength(3);
        expect((await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } })).status).toBe('CANCELLED');
        expect(await prisma.booking.count({ where: { contractId: contract.id } })).toBe(0);
        const notif = await paymentConfirmedNotes(client.id);
        expect(notif).toHaveLength(1);
        expect(notif[0]!.message).toContain('504,00');
    });

    it('à vista quitado → sem multa (nenhuma cobrança criada) e o cliente é avisado do cancelamento', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser();
        const contract = await mkContract(client.id, { type: 'FIXO', paymentPlan: 'FULL', paymentMethod: 'PIX' });
        const full = await mkPayment(client.id, { contractId: contract.id, amount: 252000, status: 'PAID', paidAt: new Date() });

        const req = await call('POST', `/api/contracts/${contract.id}/request-cancellation`, client);
        expect(req.body.fine).toEqual({ finePct: 20, baseAmount: 0, amount: 0 });
        expect(req.body.message).toContain('não tem multa');

        const res = await call('POST', `/api/contracts/${contract.id}/resolve-cancellation`, admin, { action: 'CHARGE_FEE' });
        expect(res.status).toBe(200);
        expect(res.body.fine).toBeNull();
        expect(res.body.message).toContain('Nenhuma multa aplicada');
        expect(res.body.contract.status).toBe('CANCELLED');
        expect(await prisma.payment.count({ where: { contractId: contract.id } })).toBe(1);
        expect(await payStatus(full.id)).toBe('PAID'); // sem devolução automática

        const notes = await prisma.notification.findMany({ where: { userId: client.id } });
        expect(notes).toHaveLength(1);
        expect(notes[0]).toMatchObject({ type: 'CANCELLATION_PENDING', severity: 'critical', entityType: 'CONTRACT', entityId: contract.id, actionUrl: '/meus-contratos' });
        expect(notes[0]!.message).toContain('sem multa');
    });

    it('WAIVE_FEE: nenhuma cobrança; parcelas pendentes anuladas; cliente avisado', async () => {
        const { admin, client, contract, p2, p3 } = await monthlyFixo();
        await call('POST', `/api/contracts/${contract.id}/request-cancellation`, client);
        const res = await call('POST', `/api/contracts/${contract.id}/resolve-cancellation`, admin, { action: 'WAIVE_FEE' });
        expect(res.status).toBe(200);
        expect(res.body.fine).toBeNull();
        expect(res.body.contract.status).toBe('CANCELLED');
        expect(await fineOf(contract.id)).toBeNull();
        expect(await payStatus(p2.id)).toBe('CANCELLED');
        expect(await payStatus(p3.id)).toBe('CANCELLED');
        expect(await prisma.payment.count({ where: { contractId: contract.id, status: 'PENDING' } })).toBe(0);
        const notes = await prisma.notification.findMany({ where: { userId: client.id } });
        expect(notes.map(n => n.title)).toEqual(['Contrato cancelado']);
    });

    it('pedido anterior à regra (sem a marca): a base é calculada na decisão, antes de anular as parcelas', async () => {
        const { admin, contract } = await monthlyFixo({ contract: { status: 'PENDING_CANCELLATION' } });
        const list = await call('GET', '/api/contracts', admin);
        const row = list.body.contracts.find((c: any) => c.id === contract.id);
        expect(row).toMatchObject({ remainingTotal: 168000, fineBaseAmount: 168000, fineAmountPreview: 33600 });
        expect(row.cancellationRequestedAt).not.toBeNull(); // última atualização do contrato

        const res = await call('POST', `/api/contracts/${contract.id}/resolve-cancellation`, admin, { action: 'CHARGE_FEE' });
        expect(res.status).toBe(200);
        expect(res.body.fine).toMatchObject({ amount: 33600, baseAmount: 168000 });
        const late = await prisma.auditLog.findFirstOrThrow({ where: { entityType: 'CONTRACT', entityId: contract.id, action: 'CANCELLATION_REQUESTED' } });
        expect(JSON.parse(late.changes!)).toMatchObject({ baseAmount: 168000, lateFreeze: true });
    });

    it('dois admins decidindo ao mesmo tempo: uma única multa', async () => {
        const { admin, client, contract } = await monthlyFixo();
        await call('POST', `/api/contracts/${contract.id}/request-cancellation`, client);
        const [a, b] = await Promise.all([
            call('POST', `/api/contracts/${contract.id}/resolve-cancellation`, admin, { action: 'CHARGE_FEE' }),
            call('POST', `/api/contracts/${contract.id}/resolve-cancellation`, admin, { action: 'CHARGE_FEE' }),
        ]);
        expect([a.status, b.status].sort()).not.toEqual([200, 200]);
        expect([a.status, b.status]).toContain(200);
        const fines = await prisma.payment.findMany({ where: { contractId: contract.id, metadata: { path: ['kind'], equals: 'CANCELLATION_FINE' } } });
        expect(fines).toHaveLength(1);
        // Pedido repetido pelo cliente também não passa (contrato já não está ativo).
        expect((await call('POST', `/api/contracts/${contract.id}/request-cancellation`, client)).status).toBe(400);
    });
});

// ─── 2) Cobrança da multa: pendente, pagável, fora do auto-charge ─────────────────────────────────
describe('a multa fica PENDENTE: pagável por cliente e admin, nunca cobrada sozinha', () => {
    async function finedContract() {
        const ctx = await monthlyFixo({ clientData: { cpfCnpj: VALID_CPF, autoChargeEnabled: true, stripeCustomerId: 'cus_test' } });
        await prisma.savedPaymentMethod.create({
            data: { userId: ctx.client.id, stripePaymentMethodId: 'pm_saved', brand: 'visa', last4: '4242', expMonth: 12, expYear: 2031, isDefault: true },
        });
        await call('POST', `/api/contracts/${ctx.contract.id}/request-cancellation`, ctx.client);
        const res = await call('POST', `/api/contracts/${ctx.contract.id}/resolve-cancellation`, ctx.admin, { action: 'CHARGE_FEE' });
        expect(res.status).toBe(200);
        return { ...ctx, fine: (await fineOf(ctx.contract.id))! };
    }

    it('o auto-charge não cobra a multa (nem vencida, com cartão salvo e cobrança automática ligada)', async () => {
        const { fine } = await finedContract();
        await prisma.payment.update({ where: { id: fine.id }, data: { dueDate: daysFromNow(-3), provider: 'STRIPE' } });
        chargeOffSession.mockResolvedValue({ status: 'succeeded', paymentIntentId: 'pi_off', clientSecret: 'x' });
        await runAutoChargeJob();
        expect(chargeOffSession).not.toHaveBeenCalled();
        expect(await payStatus(fine.id)).toBe('PENDING');
    });

    it('cliente paga a multa por PIX com o contrato CANCELADO; o admin também pode cobrar (PIX e cartão)', async () => {
        const { admin, client, fine } = await finedContract();

        const pix = await call('POST', '/api/stripe/create-payment', client, { paymentId: fine.id, paymentMethod: 'pix' });
        expect(pix.status).toBe(200);
        expect(pix.body.pixString).toBeTruthy();
        expect(pix.body.amount).toBe(33600);
        expect(m(sicoob.sicoobCreatePix).mock.calls[0]![0]).toMatchObject({ amount: 33600 });
        // O metadata da multa convive com o controle do PIX (a identificação não se perde).
        const withQr = await prisma.payment.findUniqueOrThrow({ where: { id: fine.id } });
        expect(withQr.metadata).toMatchObject({ kind: 'CANCELLATION_FINE', finePct: 20, baseAmount: 168000 });

        // Admin "Cobrar agora" com o cliente presente: mesmo QR (reuso) e cartão pelo valor da multa.
        const adminPix = await call('POST', '/api/stripe/create-payment', admin, { paymentId: fine.id, paymentMethod: 'pix' });
        expect(adminPix.status).toBe(200);
        expect(adminPix.body.amount).toBe(33600);
        getCob.mockResolvedValue({ status: 'ATIVA', valor: { original: '336.00' }, calendario: { criacao: new Date().toISOString(), expiracao: 3600 } });
        const card = await call('POST', '/api/stripe/create-payment', admin, { paymentId: fine.id, paymentMethod: 'cartao' });
        expect(card.status).toBe(200);
        expect(m(stripe.stripeCreatePaymentIntent).mock.calls[0]![0]).toMatchObject({ paymentId: fine.id, amount: 33600 });
        expect((await prisma.payment.findUniqueOrThrow({ where: { id: fine.id } })).metadata).toMatchObject({ kind: 'CANCELLATION_FINE' });
    });

    it('multa paga: contrato segue CANCELADO, nada é regerado e o cliente recebe "pagamento confirmado"', async () => {
        const { client, contract, fine } = await finedContract();
        const before = await prisma.payment.count({ where: { contractId: contract.id } });
        await prisma.payment.update({ where: { id: fine.id }, data: { status: 'PAID', paidAt: new Date() } });
        await onPaymentConfirmed(fine.id);
        expect(await prisma.payment.count({ where: { contractId: contract.id } })).toBe(before);
        expect((await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } })).status).toBe('CANCELLED');
        expect(await paymentConfirmedNotes(client.id)).toHaveLength(1);
    });
});

// ─── 3) Notificações ─────────────────────────────────────────────────────────────────────────────
describe('avisos do cancelamento (persistidos + push)', () => {
    it('pedido → cada admin é avisado na hora; decisão com multa → cliente avisado do valor e o aviso do admin some', async () => {
        const { admin, client, contract } = await monthlyFixo();
        const admin2 = await mkUser({ role: 'ADMIN' });

        await call('POST', `/api/contracts/${contract.id}/request-cancellation`, client);
        const adminNotes = await prisma.notification.findMany({ where: { userId: { in: [admin.id, admin2.id] } } });
        expect(adminNotes).toHaveLength(2);
        for (const n of adminNotes) {
            expect(n).toMatchObject({ type: 'CANCELLATION_PENDING', severity: 'warning', entityType: 'CONTRACT', entityId: contract.id, actionUrl: '/admin/contracts', pushSent: true });
            expect(n.message).toContain(client.name);
            expect(n.message).toContain('R$ 336,00');
        }
        expect(sendPush.mock.calls.map(c => c[0]).sort()).toEqual([admin.id, admin2.id].sort());
        // O cliente ainda não recebe nada persistido (o alerta "em análise" é o computado).
        expect(await prisma.notification.count({ where: { userId: client.id } })).toBe(0);

        sendPush.mockClear();
        const res = await call('POST', `/api/contracts/${contract.id}/resolve-cancellation`, admin, { action: 'CHARGE_FEE' });
        const fineId = res.body.fine.id;
        const clientNotes = await prisma.notification.findMany({ where: { userId: client.id } });
        expect(clientNotes).toHaveLength(1);
        expect(clientNotes[0]).toMatchObject({
            type: 'CANCELLATION_PENDING', severity: 'critical', entityType: 'PAYMENT', entityId: fineId,
            actionUrl: '/meus-pagamentos', pushSent: true, title: 'Multa de cancelamento: R$ 336,00',
        });
        expect(clientNotes[0]!.message).toContain('20% de R$ 1.680,00');
        expect(sendPush).toHaveBeenCalledTimes(1);
        expect(sendPush.mock.calls[0]![0]).toBe(client.id);
        expect(sendPush.mock.calls[0]![1]).toMatchObject({ severity: 'critical', actionUrl: '/meus-pagamentos' });
        // Pedido resolvido: o aviso persistido "pedido de cancelamento" dos admins é removido.
        expect(await prisma.notification.count({ where: { userId: { in: [admin.id, admin2.id] } } })).toBe(0);
    });

    it('cliente com "só essenciais" também é avisado (multa e isenção são críticos)', async () => {
        const a = await monthlyFixo({ clientData: { essentialNotificationsOnly: true } });
        await call('POST', `/api/contracts/${a.contract.id}/request-cancellation`, a.client);
        await call('POST', `/api/contracts/${a.contract.id}/resolve-cancellation`, a.admin, { action: 'WAIVE_FEE' });
        expect(await prisma.notification.count({ where: { userId: a.client.id } })).toBe(1);
    });

    it('admin reabre o contrato (PATCH ACTIVE): o aviso do pedido some e a multa volta a ser a prévia de hoje', async () => {
        const { admin, client, contract, p2 } = await monthlyFixo();
        await call('POST', `/api/contracts/${contract.id}/request-cancellation`, client);
        expect(await prisma.notification.count({ where: { userId: admin.id } })).toBe(1);
        await prisma.payment.update({ where: { id: p2.id }, data: { status: 'PAID', paidAt: new Date() } });

        expect((await call('PATCH', `/api/contracts/${contract.id}`, admin, { status: 'ACTIVE' })).status).toBe(200);
        expect(await prisma.notification.count({ where: { userId: admin.id } })).toBe(0);
        expect(await prisma.notification.count({ where: { userId: client.id } })).toBe(0);
        const row = (await call('GET', '/api/contracts', admin)).body.contracts.find((c: any) => c.id === contract.id);
        // Sem pedido em análise: nada de data de pedido antigo; a prévia usa o saldo de HOJE (só a 3ª parcela).
        expect(row).toMatchObject({ status: 'ACTIVE', cancellationRequestedAt: null, remainingTotal: 84000, fineBaseAmount: 84000, fineAmountPreview: 16800 });

        // Um novo pedido congela a base NOVA (a marca mais recente vence).
        const again = await call('POST', `/api/contracts/${contract.id}/request-cancellation`, client);
        expect(again.body.fine).toEqual({ finePct: 20, baseAmount: 84000, amount: 16800 });
        // …e o admin é avisado de novo (a dedup é por pedido, não por contrato).
        const notes = await prisma.notification.findMany({ where: { userId: admin.id } });
        expect(notes).toHaveLength(1);
        expect(notes[0]!.message).toContain('R$ 168,00');
        const res = await call('POST', `/api/contracts/${contract.id}/resolve-cancellation`, admin, { action: 'CHARGE_FEE' });
        expect(res.body.fine).toMatchObject({ amount: 16800, baseAmount: 84000 });
    });

    it('DELETE e PATCH (admin) também avisam o cliente e registram a data do cancelamento', async () => {
        const a = await monthlyFixo();
        const del = await call('DELETE', `/api/contracts/${a.contract.id}`, a.admin);
        expect(del.status).toBe(200);
        expect(del.body.voidedCount).toBe(2);
        expect((await prisma.notification.findMany({ where: { userId: a.client.id } })).map(n => n.title)).toEqual(['Contrato cancelado']);
        expect(await prisma.auditLog.count({ where: { entityType: 'CONTRACT', entityId: a.contract.id, action: 'CANCELLED' } })).toBe(1);

        const b = await monthlyFixo();
        const patch = await call('PATCH', `/api/contracts/${b.contract.id}`, b.admin, { status: 'CANCELLED' });
        expect(patch.status).toBe(200);
        expect(await prisma.notification.count({ where: { userId: b.client.id, title: 'Contrato cancelado' } })).toBe(1);
        const detail = await call('GET', `/api/contracts/${b.contract.id}`, b.admin);
        expect(detail.body.contract.cancelledAt).not.toBeNull();
        expect(detail.body.contract.cancellationFine).toBeNull();
    });
});

// ─── 4) Gravações: só as que ainda não aconteceram ───────────────────────────────────────────────
describe('cancelamento só libera gravações que ainda NÃO aconteceram', () => {
    async function sessions(clientId: string, contractId: string) {
        const mk = (o: Record<string, unknown>) => mkBooking(clientId, contractId, o as any);
        return {
            pastDone: await mk({ date: spDay(-7), status: 'COMPLETED' }),
            todayDone: await mk({ date: spDay(0), startTime: '00:00', endTime: '02:00', status: 'COMPLETED' }),
            todayFalta: await mk({ date: spDay(0), startTime: '02:00', endTime: '04:00', status: 'FALTA' }),
            todayNotDone: await mk({ date: spDay(0), startTime: '04:00', endTime: '06:00', status: 'NAO_REALIZADO' }),
            // Hoje, já começou (00:00 no relógio de SP) e ainda não foi finalizada → fica para o operador.
            todayStarted: await mk({ date: spDay(0), startTime: '00:00', endTime: '02:00', status: 'CONFIRMED' }),
            // Em gravação agora ("Iniciar gravação"), mesmo com horário nominal futuro.
            recording: await mk({ date: spDay(0), startTime: '23:59', endTime: '23:59', status: 'CONFIRMED', recordingStartedAt: new Date() }),
            todayLater: await mk({ date: spDay(0), startTime: '23:59', endTime: '23:59', status: 'CONFIRMED' }),
            futureConfirmed: await mk({ date: spDay(3), status: 'CONFIRMED' }),
            futureReserved: await mk({ date: spDay(10), status: 'RESERVED' }),
            futureHeld: await mk({ date: spDay(17), status: 'HELD', holdExpiresAt: daysFromNow(1) }),
        };
    }
    async function expectOnlyUpcomingCancelled(s: Awaited<ReturnType<typeof sessions>>) {
        expect(await bookingStatus(s.pastDone.id)).toBe('COMPLETED');
        expect(await bookingStatus(s.todayDone.id)).toBe('COMPLETED');
        expect(await bookingStatus(s.todayFalta.id)).toBe('FALTA');
        expect(await bookingStatus(s.todayNotDone.id)).toBe('NAO_REALIZADO');
        expect(await bookingStatus(s.todayStarted.id)).toBe('CONFIRMED');
        expect(await bookingStatus(s.recording.id)).toBe('CONFIRMED');
        for (const b of [s.todayLater, s.futureConfirmed, s.futureReserved, s.futureHeld]) expect(await bookingStatus(b.id)).toBe('CANCELLED');
    }

    it('pedido do cliente', async () => {
        const { client, contract } = await monthlyFixo();
        const s = await sessions(client.id, contract.id);
        const req = await call('POST', `/api/contracts/${contract.id}/request-cancellation`, client);
        expect(req.status).toBe(200);
        expect(req.body.cancelledBookings).toBe(4);
        expect(req.body.message).toContain('4 agendamentos futuros');
        await expectOnlyUpcomingCancelled(s);
    });

    it('DELETE do admin', async () => {
        const { admin, client, contract } = await monthlyFixo();
        const s = await sessions(client.id, contract.id);
        const del = await call('DELETE', `/api/contracts/${contract.id}`, admin);
        expect(del.status).toBe(200);
        expect(del.body.cancelledBookings).toBe(4);
        await expectOnlyUpcomingCancelled(s);
    });

    it('PATCH status=CANCELLED do admin', async () => {
        const { admin, client, contract } = await monthlyFixo();
        const s = await sessions(client.id, contract.id);
        expect((await call('PATCH', `/api/contracts/${contract.id}`, admin, { status: 'CANCELLED' })).status).toBe(200);
        await expectOnlyUpcomingCancelled(s);
    });
});

// ─── 5) Anulação aposenta a cobrança viva no provedor ────────────────────────────────────────────
describe('anular parcelas aposenta a cobrança viva antes (PIX / PaymentIntent)', () => {
    const pixRow = (clientId: string, contractId: string, txid: string, over: Record<string, unknown> = {}) => mkPayment(clientId, {
        contractId, provider: 'SICOOB', providerRef: txid, amount: 84000,
        pixString: buildStaticBrCode({ key: 'k', amountCents: 84000, txid }), pixExpiresAt: new Date(Date.now() + 1800_000),
        dueDate: daysFromNow(5), ...over,
    } as any);
    const cobAtiva = () => ({ status: 'ATIVA', valor: { original: '840.00' }, calendario: { criacao: new Date().toISOString(), expiracao: 3600 } });
    const cobPaga = () => ({ status: 'CONCLUIDA', valor: { original: '840.00' }, pix: [{ valor: '840.00' }] });

    it('QR PIX vivo é removido no Sicoob e a parcela é anulada; PaymentIntent aberto é cancelado', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser();
        const contract = await mkContract(client.id, { type: 'FIXO' });
        const pix = await pixRow(client.id, contract.id, TX_LIVE);
        const card = await mkPayment(client.id, { contractId: contract.id, provider: 'STRIPE', providerRef: 'pi_open', amount: 84000, dueDate: daysFromNow(30) });
        const noCharge = await mkPayment(client.id, { contractId: contract.id, amount: 84000, dueDate: daysFromNow(60) });
        getCob.mockResolvedValue(cobAtiva());
        getPI.mockResolvedValue({ id: 'pi_open', status: 'requires_payment_method', amount: 84000, metadata: { paymentId: card.id } });

        const del = await call('DELETE', `/api/contracts/${contract.id}`, admin);
        expect(del.status).toBe(200);
        expect(del.body).toMatchObject({ voidedCount: 3, paidAtProvider: 0, liveAtProvider: 0 });
        expect(removeCob).toHaveBeenCalledWith(TX_LIVE);
        expect(cancelPI).toHaveBeenCalledWith('pi_open');
        for (const p of [pix, card, noCharge]) expect(await payStatus(p.id)).toBe('CANCELLED');
    });

    it('PIX já pago no banco → a parcela vira PAID (com os efeitos), não CANCELLED; o resto é anulado', async () => {
        const { admin, client, contract, p2, p3 } = await monthlyFixo();
        await prisma.payment.update({
            where: { id: p2.id },
            data: { providerRef: TX_PAID, pixString: buildStaticBrCode({ key: 'k', amountCents: 84000, txid: TX_PAID }), pixExpiresAt: new Date(Date.now() + 1800_000) },
        });
        getCob.mockResolvedValue(cobPaga());
        await call('POST', `/api/contracts/${contract.id}/request-cancellation`, client);

        const res = await call('POST', `/api/contracts/${contract.id}/resolve-cancellation`, admin, { action: 'CHARGE_FEE' });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ voidedCount: 1, paidAtProvider: 1, liveAtProvider: 0 });
        expect(res.body.message).toContain('já estava paga');
        expect(removeCob).not.toHaveBeenCalledWith(TX_PAID);
        const paid = await prisma.payment.findUniqueOrThrow({ where: { id: p2.id } });
        expect(paid.status).toBe('PAID');
        expect(paid.paidAt).not.toBeNull();
        expect(await payStatus(p3.id)).toBe('CANCELLED');
        expect(await paymentConfirmedNotes(client.id)).toHaveLength(1);
        // A parcela confirmada no provedor ao anular SAI da base: multa só sobre a 3ª (20% de R$ 840).
        expect(res.body.fine).toMatchObject({ amount: 16800, baseAmount: 84000 });
    });

    it('PaymentIntent já aprovado → PAID; em processamento → anulada e sinalizada como viva', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser();
        const contract = await mkContract(client.id, { type: 'FIXO' });
        const approved = await mkPayment(client.id, { contractId: contract.id, provider: 'STRIPE', providerRef: 'pi_ok', amount: 84000, chargedAmount: 84000 });
        const processing = await mkPayment(client.id, { contractId: contract.id, provider: 'STRIPE', providerRef: 'pi_processing', amount: 84000 });
        getPI.mockImplementation(async (id: string) => (id === 'pi_ok'
            ? { id, status: 'succeeded', amount: 84000, metadata: { paymentId: approved.id }, payment_method_types: ['card'] }
            : { id, status: 'processing', amount: 84000, metadata: { paymentId: processing.id } }));

        const del = await call('DELETE', `/api/contracts/${contract.id}`, admin);
        expect(del.body).toMatchObject({ voidedCount: 1, paidAtProvider: 1, liveAtProvider: 1 });
        expect(del.body.message).toContain('você será avisado');
        expect(cancelPI).not.toHaveBeenCalled();
        expect(await payStatus(approved.id)).toBe('PAID');
        expect(await payStatus(processing.id)).toBe('CANCELLED');
    });

    it('QR que o banco não deixou remover: parcela anulada; se for paga depois, o admin é ALERTADO (uma vez)', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser();
        const contract = await mkContract(client.id, { type: 'FIXO', name: 'Podcast Alerta' });
        const pix = await pixRow(client.id, contract.id, TX_LIVE);
        removeCob.mockResolvedValue(false);
        getCob.mockResolvedValue(cobAtiva());

        const del = await call('DELETE', `/api/contracts/${contract.id}`, admin);
        expect(del.body).toMatchObject({ voidedCount: 1, liveAtProvider: 1 });
        expect(await payStatus(pix.id)).toBe('CANCELLED');
        expect(await prisma.notification.count({ where: { userId: admin.id } })).toBe(0);

        // O cliente paga o QR antigo: o webhook do Sicoob chega para uma linha CANCELADA.
        getCob.mockResolvedValue(cobPaga());
        sendPush.mockClear();
        const hook = await call('POST', '/api/webhooks/sicoob/pix', undefined, { pix: [{ txid: TX_LIVE, valor: '840.00' }] });
        expect(hook.status).toBe(200);
        expect(await payStatus(pix.id)).toBe('CANCELLED'); // não vira PAID sozinha
        const alerts = await prisma.notification.findMany({ where: { userId: admin.id } });
        expect(alerts).toHaveLength(1);
        expect(alerts[0]).toMatchObject({ type: 'SYSTEM', severity: 'critical', entityType: 'PAYMENT', entityId: pix.id, actionUrl: '/admin/finance', pushSent: true });
        expect(alerts[0]!.message).toContain(client.name);
        expect(alerts[0]!.message).toContain('R$ 840,00');
        expect(alerts[0]!.message).toContain('Podcast Alerta');
        expect(await prisma.auditLog.count({ where: { entityType: 'PAYMENT', entityId: pix.id, action: 'PAID_AFTER_CANCELLED' } })).toBe(1);

        // Webhook reentregue e varredura: nenhum aviso duplicado.
        await call('POST', '/api/webhooks/sicoob/pix', undefined, { pix: [{ txid: TX_LIVE, valor: '840.00' }] });
        await sweepCancelledSicoobCharges();
        expect(await prisma.notification.count({ where: { userId: admin.id } })).toBe(1);
    });

    it('varredura (sem webhook) também alerta; cobrança removida ou sandbox não geram alerta', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser();
        const contract = await mkContract(client.id, { type: 'FIXO', status: 'CANCELLED' });
        const paidLater = await pixRow(client.id, contract.id, TX_PAID, { status: 'CANCELLED' });
        const removed = await pixRow(client.id, contract.id, TX_LIVE, { status: 'CANCELLED' });
        getCob.mockImplementation(async (txid: string) => (txid === TX_PAID ? cobPaga() : { status: 'REMOVIDA_PELO_USUARIO_RECEBEDOR', valor: { original: '840.00' } }));

        m(sicoob.getSicoobEnvironment).mockResolvedValue('sandbox'); // GET do sandbox é mock aleatório
        expect(await sweepCancelledSicoobCharges()).toBe(0);
        expect(getCob).not.toHaveBeenCalled();

        m(sicoob.getSicoobEnvironment).mockResolvedValue('production');
        expect(await sweepCancelledSicoobCharges()).toBe(1);
        const alerts = await prisma.notification.findMany({ where: { userId: admin.id } });
        expect(alerts.map(a => a.entityId)).toEqual([paidLater.id]);
        expect(await payStatus(removed.id)).toBe('CANCELLED');
        expect(await sweepCancelledSicoobCharges()).toBe(0); // já avisado / já removida
    });

    it('webhook do Stripe aprovando um PaymentIntent de cobrança CANCELADA → alerta ao admin', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser();
        const contract = await mkContract(client.id, { type: 'FIXO', status: 'CANCELLED' });
        const voided = await mkPayment(client.id, { contractId: contract.id, provider: 'STRIPE', providerRef: 'pi_late', amount: 84000, status: 'CANCELLED' });
        process.env.ALLOW_UNVERIFIED_WEBHOOKS = 'true';
        try {
            const hook = await call('POST', '/api/webhooks/stripe', undefined, {
                type: 'payment_intent.succeeded',
                data: { object: { id: 'pi_late', amount: 84000, metadata: { paymentId: voided.id }, payment_method_types: ['card'] } },
            });
            expect(hook.status).toBe(200);
        } finally {
            delete process.env.ALLOW_UNVERIFIED_WEBHOOKS;
        }
        expect(await payStatus(voided.id)).toBe('CANCELLED');
        const alerts = await prisma.notification.findMany({ where: { userId: admin.id } });
        expect(alerts).toHaveLength(1);
        expect(alerts[0]).toMatchObject({ type: 'SYSTEM', entityId: voided.id });
    });

    it('cartão aprovado numa parcela que estava FAILED: anulada, e o admin é avisado na hora do dinheiro recebido', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser();
        const contract = await mkContract(client.id, { type: 'FIXO' });
        const failed = await mkPayment(client.id, { contractId: contract.id, provider: 'STRIPE', providerRef: 'pi_late_ok', amount: 84000, status: 'FAILED' });
        getPI.mockResolvedValue({ id: 'pi_late_ok', status: 'succeeded', amount: 84000, metadata: { paymentId: failed.id }, payment_method_types: ['card'] });

        const del = await call('DELETE', `/api/contracts/${contract.id}`, admin);
        expect(del.body).toMatchObject({ voidedCount: 1, paidAtProvider: 0, liveAtProvider: 1 });
        expect(await payStatus(failed.id)).toBe('CANCELLED');
        const alerts = await prisma.notification.findMany({ where: { userId: admin.id } });
        expect(alerts).toHaveLength(1);
        expect(alerts[0]).toMatchObject({ type: 'SYSTEM', severity: 'critical', entityType: 'PAYMENT', entityId: failed.id });
        expect(alerts[0]!.message).toContain('R$ 840,00');
    });

    it('parcela FAILED também é anulada e conta na base (continua devida até o cancelamento)', async () => {
        const { admin, client, contract, p2, p3 } = await monthlyFixo();
        await prisma.payment.update({ where: { id: p2.id }, data: { status: 'FAILED', provider: 'STRIPE' } });
        const req = await call('POST', `/api/contracts/${contract.id}/request-cancellation`, client);
        expect(req.body.fine).toMatchObject({ baseAmount: 168000, amount: 33600 });
        await call('POST', `/api/contracts/${contract.id}/resolve-cancellation`, admin, { action: 'WAIVE_FEE' });
        expect(await payStatus(p2.id)).toBe('CANCELLED');
        expect(await payStatus(p3.id)).toBe('CANCELLED');
    });

    it('voidContractPendingPayments continua idempotente e nunca toca em PAID', async () => {
        const { contract, p1 } = await monthlyFixo();
        expect(await voidContractPendingPayments(contract.id)).toBe(2);
        expect(await voidContractPendingPayments(contract.id)).toBe(0);
        expect(await payStatus(p1.id)).toBe('PAID');
    });
});

// ─── 6) Contratos para as telas: multa, renovação (E4) e visão do cliente (E11) ───────────────────
describe('GET /contracts, /contracts/:id e /contracts/my', () => {
    it('lista do admin: alreadyRenewed, dias para o fim e canRenew (≤ 30 dias, expirado, tipos sem suporte)', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser();
        const gone = await mkUser({ deletedAt: new Date() });
        const mk = (o: Record<string, unknown>, userId = client.id) => mkContract(userId, { type: 'FIXO', startDate: spDay(-60), ...o } as any);
        const far = await mk({ endDate: spDay(45) });
        const edge = await mk({ endDate: spDay(30) });
        const over = await mk({ endDate: spDay(31) });
        const expired = await mk({ status: 'EXPIRED', endDate: spDay(-3) });
        const completedEnded = await mk({ status: 'COMPLETED', endDate: spDay(-1) });
        const completedFar = await mk({ status: 'COMPLETED', endDate: spDay(50) });
        const renewedOnce = await mk({ endDate: spDay(10) });
        await mk({ startDate: spDay(10), endDate: spDay(100), renewedFromId: renewedOnce.id, status: 'AWAITING_PAYMENT' });
        const renewalCancelled = await mk({ endDate: spDay(10) });
        await mk({ startDate: spDay(10), endDate: spDay(100), renewedFromId: renewalCancelled.id, status: 'CANCELLED' });
        const avulso = await mk({ type: 'AVULSO', endDate: spDay(1) });
        const servico = await mk({ type: 'SERVICO', endDate: spDay(5) });
        const paused = await mk({ status: 'PAUSED', endDate: spDay(5) });
        const deletedClient = await mk({ endDate: spDay(5) }, gone.id);

        const list = await call('GET', '/api/contracts', admin);
        expect(list.status).toBe(200);
        const by = (id: string) => list.body.contracts.find((c: any) => c.id === id);
        expect(by(far.id)).toMatchObject({ daysToEnd: 45, canRenew: false, alreadyRenewed: false, renewedToId: null });
        expect(by(edge.id)).toMatchObject({ daysToEnd: 30, canRenew: true });
        expect(by(over.id)).toMatchObject({ daysToEnd: 31, canRenew: false });
        expect(by(expired.id)).toMatchObject({ daysToEnd: -3, canRenew: true });
        expect(by(completedEnded.id)).toMatchObject({ canRenew: true });
        expect(by(completedFar.id)).toMatchObject({ canRenew: false });
        expect(by(renewedOnce.id)).toMatchObject({ alreadyRenewed: true, canRenew: false });
        expect(by(renewedOnce.id).renewedToId).toBeTruthy();
        expect(by(renewalCancelled.id)).toMatchObject({ alreadyRenewed: false, canRenew: true });
        expect(by(avulso.id)).toMatchObject({ canRenew: false });
        expect(by(servico.id)).toMatchObject({ canRenew: false });
        expect(by(paused.id)).toMatchObject({ canRenew: false });
        expect(by(deletedClient.id)).toMatchObject({ canRenew: false });

        // A rota recusa os tipos sem renovação (o botão nem aparece).
        const denied = await call('POST', `/api/contracts/${servico.id}/renew`, admin, { durationMonths: 3 });
        expect(denied.status).toBe(400);
        expect(await prisma.contract.count({ where: { renewedFromId: servico.id } })).toBe(0);
        // O detalhe devolve os mesmos campos.
        const detail = await call('GET', `/api/contracts/${renewedOnce.id}`, admin);
        expect(detail.body.contract).toMatchObject({ alreadyRenewed: true, canRenew: false, daysToEnd: 10 });
    });

    it('detalhe: cpfCnpj e nota interna só para o admin; cobranças com kind', async () => {
        const { admin, client, contract } = await monthlyFixo({ clientData: { cpfCnpj: VALID_CPF } });
        await mkBooking(client.id, contract.id, { date: spDay(-3), status: 'COMPLETED', adminNotes: 'NOTA INTERNA', clientNotes: 'Recado do estúdio', recordingStartedByName: 'Operador' });
        await call('POST', `/api/contracts/${contract.id}/request-cancellation`, client);
        await call('POST', `/api/contracts/${contract.id}/resolve-cancellation`, admin, { action: 'CHARGE_FEE' });

        const asAdmin = (await call('GET', `/api/contracts/${contract.id}`, admin)).body.contract;
        expect(asAdmin.user.cpfCnpj).toBe(VALID_CPF);
        expect(asAdmin.bookings[0]).toMatchObject({ adminNotes: 'NOTA INTERNA', clientNotes: 'Recado do estúdio', recordingStartedByName: 'Operador' });
        // Ordem por vencimento: a multa (vence hoje) fica entre a parcela paga e as anuladas.
        expect(asAdmin.payments.map((p: any) => [p.status, p.kind])).toEqual([
            ['PAID', null], ['PENDING', 'CANCELLATION_FINE'], ['CANCELLED', null], ['CANCELLED', null],
        ]);
        const fineRow = asAdmin.payments.find((p: any) => p.kind === 'CANCELLATION_FINE');
        expect(fineRow.metadata).toMatchObject({ kind: 'CANCELLATION_FINE', finePct: 20, baseAmount: 168000 });
        expect(asAdmin.cancellationFine).toMatchObject({ id: fineRow.id, status: 'PENDING', amount: 33600 });

        const asClient = (await call('GET', `/api/contracts/${contract.id}`, client)).body.contract;
        expect(asClient.user).not.toHaveProperty('cpfCnpj');
        expect(asClient.bookings[0]).not.toHaveProperty('adminNotes');
        expect(asClient.bookings[0]).not.toHaveProperty('recordingStartedByName');
        expect(asClient.bookings[0].clientNotes).toBe('Recado do estúdio');
        expect(JSON.stringify(asClient)).not.toContain('NOTA INTERNA');
        // Outro cliente não enxerga o contrato.
        expect((await call('GET', `/api/contracts/${contract.id}`, await mkUser())).status).toBe(404);
    });

    it('/contracts/my: sem adminNotes; com recado, início da gravação, métricas, kind e os dados da multa', async () => {
        const { admin, client, contract, p1 } = await monthlyFixo();
        const startedAt = new Date(Date.now() - 3600_000);
        await mkBooking(client.id, contract.id, {
            date: spDay(-3), status: 'COMPLETED', adminNotes: 'NOTA INTERNA', clientNotes: 'Recado do estúdio',
            recordingStartedAt: startedAt, durationMinutes: 95, peakViewers: 120, chatMessages: 40, audienceOrigin: 'Instagram',
            isLivestream: true, streamMetrics: JSON.stringify({ YOUTUBE: { views: 300, peak: 120, likes: 20, comments: 40 } }),
            platforms: JSON.stringify(['YOUTUBE']), episodeTitle: 'Episódio 1',
        });

        // Antes do pedido: a prévia da multa é a de hoje (o CancelContractModal mostra este valor).
        let mine = (await call('GET', '/api/contracts/my', client)).body.contracts.find((c: any) => c.id === contract.id);
        expect(mine).toMatchObject({ remainingTotal: 168000, fineBaseAmount: 168000, finePct: 20, fineAmountPreview: 33600, paidTotal: 84000, cancellationRequestedAt: null, cancelledAt: null, cancellationFine: null, alreadyRenewed: false });
        const b = mine.bookings[0];
        expect(b).not.toHaveProperty('adminNotes');
        expect(JSON.stringify(mine)).not.toContain('NOTA INTERNA');
        expect(b).toMatchObject({ clientNotes: 'Recado do estúdio', durationMinutes: 95, peakViewers: 120, chatMessages: 40, audienceOrigin: 'Instagram', isLivestream: true, episodeTitle: 'Episódio 1' });
        expect(new Date(b.recordingStartedAt).getTime()).toBe(startedAt.getTime());
        expect(JSON.parse(b.streamMetrics).YOUTUBE.views).toBe(300);
        for (const p of mine.payments) {
            expect(p).not.toHaveProperty('metadata');
            expect(p.kind).toBeNull();
            expect(p.bookingId).toBeNull();
        }
        expect(mine.payments.find((p: any) => p.id === p1.id).paidAt).not.toBeNull();

        await call('POST', `/api/contracts/${contract.id}/request-cancellation`, client);
        mine = (await call('GET', '/api/contracts/my', client)).body.contracts.find((c: any) => c.id === contract.id);
        expect(mine.status).toBe('PENDING_CANCELLATION');
        expect(mine.cancellationRequestedAt).not.toBeNull();
        expect(mine.fineAmountPreview).toBe(33600);

        await call('POST', `/api/contracts/${contract.id}/resolve-cancellation`, admin, { action: 'CHARGE_FEE' });
        mine = (await call('GET', '/api/contracts/my', client)).body.contracts.find((c: any) => c.id === contract.id);
        expect(mine.status).toBe('CANCELLED');
        expect(mine.cancelledAt).not.toBeNull();
        expect(mine.cancellationFine).toMatchObject({ amount: 33600, status: 'PENDING', finePct: 20, baseAmount: 168000 });
        const kinds = mine.payments.map((p: any) => [p.status, p.kind]);
        expect(kinds).toContainEqual(['PENDING', 'CANCELLATION_FINE']);
        expect(kinds.filter(([, k]: [string, string | null]) => k === 'CANCELLATION_FINE')).toHaveLength(1);
    });
});

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// ─── Mocks dos provedores (Stripe / Sicoob) e do push: nenhuma chamada de rede real ─────────────
vi.mock('../../src/lib/stripeService', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../../src/lib/stripeService')>();
    return {
        ...orig,
        isStripeEnabled: vi.fn(async () => true),
        stripeGetCard: vi.fn(),
        stripeSetDefaultPaymentMethod: vi.fn(async () => undefined),
        stripeGetPaymentIntent: vi.fn(),
        stripeCancelPaymentIntent: vi.fn(async () => ({ status: 'canceled', canceled: true })),
        stripeCancelSubscription: vi.fn(async () => {}),
        stripeGetOrCreateCustomer: vi.fn(async () => 'cus_test'),
    };
});
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
import { redis } from '../../src/lib/redis';
import { config } from '../../src/config/index';
import { saoPauloParts } from '../../src/lib/spTime';
import * as stripe from '../../src/lib/stripeService';
import { invalidateConfigCache } from '../../src/lib/businessConfig';
import { voidContractPendingPayments } from '../../src/lib/paymentEffects';
import contractRoutes from '../../src/modules/contracts/routes';
import stripeRoutes from '../../src/modules/stripe/routes';
import notificationRoutes from '../../src/modules/notifications/routes';
import { mkUser, mkContract, mkPayment, mkBooking } from './factories';

// Frente c-be-fixups (lote 2, 30/09/2026) — pendências das ondas A/B:
//  1. E9 "só crédito": PUT /stripe/auto-charge { enabled: true } recusa cartão de débito/pré-pago com o
//     MESMO corpo do POST /contracts/:id/subscribe (400 CARD_NOT_CREDIT); desligar é sempre aceito.
//  2. E13: a base EFETIVA da multa = mínimo entre a congelada no pedido e o que ainda falta pagar — uma
//     parcela paga durante a análise sai da base (prévias e decisão); a base nunca aumenta.
//  3. O cliente não é lembrado ("Pagamento vencido" / "cartão falhou") de parcela do plano que as rotas
//     recusam com 409 CANCELLATION_PENDING; extras de gravação e a multa continuam avisando.

type Who = { id: string; email: string | null; role: string };
const m = <T extends (...a: any[]) => any>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>;

let server: Server;
let base = '';

beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/contracts', contractRoutes);
    app.use('/api/stripe', stripeRoutes);
    app.use('/api/notifications', notificationRoutes);
    await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Cartões "no Stripe" deste teste: pm → { customerId, funding }. */
let stripeCards: Record<string, { customerId: string | null; funding: string }> = {};

beforeEach(async () => {
    vi.clearAllMocks();
    invalidateConfigCache();
    stripeCards = {};
    m(stripe.isStripeEnabled).mockResolvedValue(true);
    m(stripe.stripeSetDefaultPaymentMethod).mockResolvedValue(undefined);
    m(stripe.stripeCancelPaymentIntent).mockResolvedValue({ status: 'canceled', canceled: true });
    m(stripe.stripeGetCard).mockImplementation(async (pm: string) => {
        const c = stripeCards[pm];
        if (!c) return null;
        return { paymentMethodId: pm, brand: 'visa', last4: '4242', expMonth: 12, expYear: 2031, funding: c.funding, customerId: c.customerId };
    });
    await prisma.integrationConfig.create({ data: { provider: 'STRIPE', enabled: true, environment: 'sandbox', config: '{}' } });
    await prisma.integrationConfig.create({ data: { provider: 'SICOOB', enabled: true, environment: 'sandbox', config: '{}' } });
    // Estado de leitura das notificações computadas (Redis): não vaza entre testes.
    const keys = await redis.keys('notif:computed-read:*');
    if (keys.length) await redis.del(...keys);
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

/** Data-calendário de SP (hoje + n dias) como meia-noite UTC — o formato de Booking.date / dueDate. */
function spDay(n: number): Date {
    const d = new Date(`${saoPauloParts(new Date()).dateStr}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d;
}
const secondsAgo = (s: number) => new Date(Date.now() - s * 1000);

// ═══ 1) PUT /stripe/auto-charge — só crédito ao LIGAR ════════════════════════════════════════════
describe('E9 — PUT /stripe/auto-charge: ligar exige cartão de crédito; desligar é sempre aceito', () => {
    let seq = 0;
    async function client(over: Record<string, unknown> = {}) {
        const customerId = `cus_c_${++seq}`;
        const user = await mkUser({ stripeCustomerId: customerId, ...over });
        return { user, customerId };
    }
    async function savedCard(userId: string, customerId: string | null, pm: string, over: { isDefault?: boolean; funding?: string; createdAt?: Date } = {}) {
        stripeCards[pm] = { customerId, funding: over.funding ?? 'credit' };
        return prisma.savedPaymentMethod.create({
            data: {
                userId, stripePaymentMethodId: pm, brand: 'visa', last4: '4242', expMonth: 12, expYear: 2031,
                isDefault: over.isDefault ?? false, ...(over.createdAt ? { createdAt: over.createdAt } : {}),
            },
        });
    }
    const enabledOf = async (id: string) => (await prisma.user.findUniqueOrThrow({ where: { id } })).autoChargeEnabled;
    const toggle = (who: Who, enabled: boolean) => call('PUT', '/api/stripe/auto-charge', who, { enabled });

    it('cartão padrão de DÉBITO: recusa com 400 CARD_NOT_CREDIT (o mesmo corpo do /subscribe) e não liga', async () => {
        const { user, customerId } = await client();
        const card = await savedCard(user.id, customerId, 'pm_debit', { isDefault: true, funding: 'debit' });

        const r = await toggle(user, true);
        expect(r.status).toBe(400);
        expect(r.body).toEqual({ error: 'A cobrança automática aceita apenas cartão de crédito.', code: 'CARD_NOT_CREDIT' });
        expect(await enabledOf(user.id)).toBe(false);

        // Paridade com o caminho do modal: o /subscribe devolve exatamente o mesmo status e corpo.
        const contract = await mkContract(user.id, { type: 'FIXO', paymentPlan: 'MONTHLY', paymentMethod: 'CARTAO' });
        await mkPayment(user.id, { contractId: contract.id, provider: 'STRIPE', amount: 84000, dueDate: spDay(10) });
        const sub = await call('POST', `/api/contracts/${contract.id}/subscribe`, user, { paymentMethodId: card.id });
        expect(sub.status).toBe(r.status);
        expect(sub.body).toEqual(r.body);
        expect(await enabledOf(user.id)).toBe(false);
    });

    it('pré-pago também é recusado; crédito e "unknown" (o Stripe nem sempre classifica) são aceitos', async () => {
        const prepaid = await client();
        await savedCard(prepaid.user.id, prepaid.customerId, 'pm_prepaid', { isDefault: true, funding: 'prepaid' });
        const rp = await toggle(prepaid.user, true);
        expect(rp.status).toBe(400);
        expect(rp.body.code).toBe('CARD_NOT_CREDIT');
        expect(await enabledOf(prepaid.user.id)).toBe(false);

        const credit = await client();
        await savedCard(credit.user.id, credit.customerId, 'pm_credit', { isDefault: true, funding: 'credit' });
        const rc = await toggle(credit.user, true);
        expect(rc.status).toBe(200);
        expect(rc.body.message).toContain('Cobrança automática ativada');
        expect(await enabledOf(credit.user.id)).toBe(true);
        // Ligar de novo (já ligada, cartão de crédito) continua 200.
        expect((await toggle(credit.user, true)).status).toBe(200);

        const unknown = await client();
        await savedCard(unknown.user.id, unknown.customerId, 'pm_unknown', { isDefault: true, funding: 'unknown' });
        expect((await toggle(unknown.user, true)).status).toBe(200);
        expect(await enabledOf(unknown.user.id)).toBe(true);
    });

    it('confere o cartão que o job cobraria: o PADRÃO; sem padrão, o mais recente', async () => {
        // Padrão de débito + outro de crédito salvo → recusa (o job cobraria o padrão).
        const a = await client();
        await savedCard(a.user.id, a.customerId, 'pm_a_debit', { isDefault: true, funding: 'debit', createdAt: secondsAgo(3600) });
        await savedCard(a.user.id, a.customerId, 'pm_a_credit', { funding: 'credit' });
        expect((await toggle(a.user, true)).body.code).toBe('CARD_NOT_CREDIT');

        // Padrão de crédito + outro de débito mais recente → aceita.
        const b = await client();
        await savedCard(b.user.id, b.customerId, 'pm_b_credit', { isDefault: true, funding: 'credit', createdAt: secondsAgo(3600) });
        await savedCard(b.user.id, b.customerId, 'pm_b_debit', { funding: 'debit' });
        expect((await toggle(b.user, true)).status).toBe(200);
        expect(m(stripe.stripeGetCard)).toHaveBeenLastCalledWith('pm_b_credit');

        // Sem padrão marcado: vale o mais recente (débito) → recusa.
        const c = await client();
        await savedCard(c.user.id, c.customerId, 'pm_c_credit', { funding: 'credit', createdAt: secondsAgo(3600) });
        await savedCard(c.user.id, c.customerId, 'pm_c_debit', { funding: 'debit' });
        expect((await toggle(c.user, true)).body.code).toBe('CARD_NOT_CREDIT');
        expect(await enabledOf(c.user.id)).toBe(false);
    });

    it('DESLIGAR é sempre aceito: com débito, sem cartão, com o Stripe fora — e nunca consulta o Stripe', async () => {
        const debit = await client({ autoChargeEnabled: true });
        await savedCard(debit.user.id, debit.customerId, 'pm_debit', { isDefault: true, funding: 'debit' });
        const off = await toggle(debit.user, false);
        expect(off.status).toBe(200);
        expect(off.body.message).toBe('Cobrança automática desativada.');
        expect(await enabledOf(debit.user.id)).toBe(false);

        const noCard = await client({ autoChargeEnabled: true });
        expect((await toggle(noCard.user, false)).status).toBe(200);
        expect(await enabledOf(noCard.user.id)).toBe(false);

        const stripeDown = await client({ autoChargeEnabled: true });
        await savedCard(stripeDown.user.id, stripeDown.customerId, 'pm_down', { isDefault: true });
        m(stripe.isStripeEnabled).mockResolvedValue(false);
        m(stripe.stripeGetCard).mockRejectedValue(new Error('network'));
        expect((await toggle(stripeDown.user, false)).status).toBe(200);
        expect(await enabledOf(stripeDown.user.id)).toBe(false);

        expect(m(stripe.stripeGetCard)).not.toHaveBeenCalled();
        expect((await call('PUT', '/api/stripe/auto-charge', undefined, { enabled: false })).status).toBe(401);
    });

    it('sem cartão salvo: a recusa de sempre (400, sem código); corpo inválido: 400', async () => {
        const { user } = await client();
        const r = await toggle(user, true);
        expect(r.status).toBe(400);
        expect(r.body).toEqual({ error: 'Adicione pelo menos um cartão antes de ativar a cobrança automática.' });
        expect(m(stripe.stripeGetCard)).not.toHaveBeenCalled();
        expect((await call('PUT', '/api/stripe/auto-charge', user, { enabled: 'sim' })).status).toBe(400);
        expect(await enabledOf(user.id)).toBe(false);
    });

    it('cartão que não pôde ser conferido não liga: Stripe fora (503), falha de rede (502), cartão sumiu (404)', async () => {
        const { user, customerId } = await client();
        await savedCard(user.id, customerId, 'pm_x', { isDefault: true, funding: 'credit' });

        m(stripe.isStripeEnabled).mockResolvedValue(false);
        expect((await toggle(user, true)).status).toBe(503);
        m(stripe.isStripeEnabled).mockResolvedValue(true);

        m(stripe.stripeGetCard).mockRejectedValueOnce(new Error('network'));
        const net = await toggle(user, true);
        expect(net.status).toBe(502);
        expect(net.body.error).toContain('Não foi possível conferir o cartão');

        delete stripeCards['pm_x']; // não existe mais no Stripe
        const gone = await toggle(user, true);
        expect(gone.status).toBe(404);
        expect(gone.body.code).toBe('CARD_NOT_FOUND');

        stripeCards['pm_x'] = { customerId: 'cus_de_outro', funding: 'credit' }; // anexado a outro Customer
        expect((await toggle(user, true)).status).toBe(404);

        expect(await enabledOf(user.id)).toBe(false);
    });
});

// ═══ 2) Multa: base efetiva = mínimo(congelada, o que ainda falta pagar) ═════════════════════════
describe('E13 — a base congelada nunca aumenta e nunca inclui parcela já quitada', () => {
    /** Plano mensal com 3 parcelas de R$ 840 EM ABERTO (faltam R$ 2.520 → multa de 20% = R$ 504). */
    async function threeOpen() {
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser();
        const contract = await mkContract(client.id, { type: 'FIXO', paymentMethod: 'PIX', startDate: spDay(-5), endDate: spDay(79) });
        const p1 = await mkPayment(client.id, { contractId: contract.id, amount: 84000, dueDate: spDay(2) });
        const p2 = await mkPayment(client.id, { contractId: contract.id, amount: 84000, dueDate: spDay(30) });
        const p3 = await mkPayment(client.id, { contractId: contract.id, amount: 84000, dueDate: spDay(58) });
        return { admin, client, contract, p1, p2, p3 };
    }
    const requestCancel = (who: Who, id: string) => call('POST', `/api/contracts/${id}/request-cancellation`, who);
    const resolve = (who: Who, id: string, action: 'CHARGE_FEE' | 'WAIVE_FEE' = 'CHARGE_FEE') =>
        call('POST', `/api/contracts/${id}/resolve-cancellation`, who, { action });
    const pay = (id: string) => prisma.payment.update({ where: { id }, data: { status: 'PAID', paidAt: new Date() } });
    const fineOf = (contractId: string) => prisma.payment.findFirst({
        where: { contractId, metadata: { path: ['kind'], equals: 'CANCELLATION_FINE' } },
    });
    const adminRow = async (admin: Who, id: string) =>
        (await call('GET', '/api/contracts', admin)).body.contracts.find((c: any) => c.id === id);

    it('3 parcelas em aberto no pedido → 1 é paga depois → multa = % × 2 parcelas (prévias e decisão)', async () => {
        const { admin, client, contract, p1, p2, p3 } = await threeOpen();

        const req = await requestCancel(client, contract.id);
        expect(req.body.fine).toEqual({ finePct: 20, baseAmount: 252000, amount: 50400 });
        // A marca do pedido guarda a base E a lista das parcelas que a compõem.
        const mark = await prisma.auditLog.findFirstOrThrow({ where: { entityType: 'CONTRACT', entityId: contract.id, action: 'CANCELLATION_REQUESTED' } });
        const frozen = JSON.parse(mark.changes!);
        expect(frozen).toMatchObject({ baseAmount: 252000, finePct: 20, fineAmount: 50400 });
        expect(frozen.installments).toHaveLength(3);
        expect(frozen.installments).toEqual(expect.arrayContaining([{ id: p1.id, amount: 84000 }, { id: p2.id, amount: 84000 }, { id: p3.id, amount: 84000 }]));

        // Durante a análise o cliente paga a 1ª parcela (QR PIX emitido ANTES do pedido).
        await pay(p1.id);

        // Prévias: lista e detalhe do admin, e Meus Contratos do cliente — base de 2 parcelas.
        const expected = { status: 'PENDING_CANCELLATION', remainingTotal: 168000, fineBaseAmount: 168000, finePct: 20, fineAmountPreview: 33600 };
        expect(await adminRow(admin, contract.id)).toMatchObject(expected);
        expect((await call('GET', `/api/contracts/${contract.id}`, admin)).body.contract).toMatchObject(expected);
        const mine = (await call('GET', '/api/contracts/my', client)).body.contracts.find((c: any) => c.id === contract.id);
        expect(mine).toMatchObject(expected);

        // Decisão: a multa é 20% de R$ 1.680 (2 parcelas), não de R$ 2.520.
        const res = await resolve(admin, contract.id);
        expect(res.status).toBe(200);
        expect(res.body.fine).toMatchObject({ amount: 33600, status: 'PENDING', finePct: 20, baseAmount: 168000 });
        expect(res.body.message).toContain('R$ 336,00');
        expect(res.body.message).toContain('R$ 1.680,00');
        expect(res.body.voidedCount).toBe(2);

        const fine = await fineOf(contract.id);
        expect(fine).toMatchObject({ amount: 33600, status: 'PENDING' });
        // metadata coerente com o valor cobrado: 33600 = 20% de 168000.
        expect(fine!.metadata).toEqual({ kind: 'CANCELLATION_FINE', finePct: 20, baseAmount: 168000 });
        // A auditoria do cancelamento guarda a base cobrada e a que estava congelada.
        const cancelMark = await prisma.auditLog.findFirstOrThrow({ where: { entityType: 'CONTRACT', entityId: contract.id, action: 'CANCELLED' } });
        expect(JSON.parse(cancelMark.changes!)).toMatchObject({ baseAmount: 168000, frozenBaseAmount: 252000, fineAmount: 33600, finePaymentId: fine!.id });
        // O cliente é avisado do valor cobrado.
        const note = await prisma.notification.findFirstOrThrow({ where: { userId: client.id, type: 'CANCELLATION_PENDING' } });
        expect(note.message).toContain('336,00');

        const after = await adminRow(admin, contract.id);
        expect(after.cancellationFine).toMatchObject({ amount: 33600, finePct: 20, baseAmount: 168000 });
        expect(after).toMatchObject({ status: 'CANCELLED', fineBaseAmount: 168000, fineAmountPreview: 33600 });
    });

    it('todas as parcelas da base pagas durante a análise → base 0 → sem multa (caminho do à vista quitado)', async () => {
        const { admin, client, contract, p1, p2, p3 } = await threeOpen();
        await requestCancel(client, contract.id);
        for (const p of [p1, p2, p3]) await pay(p.id);

        expect(await adminRow(admin, contract.id)).toMatchObject({ remainingTotal: 0, fineBaseAmount: 0, fineAmountPreview: 0 });
        const res = await resolve(admin, contract.id);
        expect(res.status).toBe(200);
        expect(res.body.fine).toBeNull();
        expect(res.body.message).toContain('Nenhuma multa aplicada');
        expect(res.body.contract.status).toBe('CANCELLED');
        expect(await fineOf(contract.id)).toBeNull();
        expect(await prisma.payment.count({ where: { contractId: contract.id } })).toBe(3);
    });

    it('a base nunca AUMENTA: parcela nova ou valor maior depois do pedido não entram; valor menor entra', async () => {
        const { admin, client, contract, p1, p2 } = await threeOpen();
        await requestCancel(client, contract.id);

        // Parcela nova + parcela existente reajustada para cima: o saldo de hoje sobe, a base não.
        await mkPayment(client.id, { contractId: contract.id, amount: 84000, dueDate: spDay(86) });
        await prisma.payment.update({ where: { id: p2.id }, data: { amount: 100000 } });
        expect(await adminRow(admin, contract.id)).toMatchObject({ remainingTotal: 352000, fineBaseAmount: 252000, fineAmountPreview: 50400 });

        // Uma parcela da base é paga: ela sai, mesmo com a parcela nova em aberto (nunca multa sobre o que foi pago).
        await pay(p1.id);
        expect(await adminRow(admin, contract.id)).toMatchObject({ fineBaseAmount: 168000, fineAmountPreview: 33600 });

        // Parcela da base que ficou mais barata (ex.: preço PIX do E2): vale o menor valor.
        await prisma.payment.update({ where: { id: p2.id }, data: { amount: 70000 } });
        expect(await adminRow(admin, contract.id)).toMatchObject({ fineBaseAmount: 154000, fineAmountPreview: 30800 });

        const res = await resolve(admin, contract.id);
        expect(res.body.fine).toMatchObject({ amount: 30800, baseAmount: 154000, finePct: 20 });
    });

    it('nova tentativa da decisão com as parcelas JÁ anuladas (falha no meio do caminho) chega à mesma multa', async () => {
        const { admin, client, contract, p1 } = await threeOpen();
        await requestCancel(client, contract.id);
        await pay(p1.id);
        // 1ª tentativa anulou as parcelas e caiu antes de gravar a decisão: contrato segue em análise.
        expect(await voidContractPendingPayments(contract.id)).toBe(2);
        expect((await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } })).status).toBe('PENDING_CANCELLATION');

        expect(await adminRow(admin, contract.id)).toMatchObject({ remainingTotal: 0, fineBaseAmount: 168000, fineAmountPreview: 33600 });
        const res = await resolve(admin, contract.id);
        expect(res.status).toBe(200);
        expect(res.body.fine).toMatchObject({ amount: 33600, baseAmount: 168000 });
        expect(res.body.voidedCount).toBe(0);
    });

    it('marca antiga (sem a lista de parcelas): mínimo entre a base congelada e o saldo de hoje', async () => {
        const { admin, client, contract, p1 } = await threeOpen();
        await prisma.contract.update({ where: { id: contract.id }, data: { status: 'PENDING_CANCELLATION' } });
        await prisma.auditLog.create({
            data: { entityType: 'CONTRACT', entityId: contract.id, action: 'CANCELLATION_REQUESTED', performedBy: client.id, changes: JSON.stringify({ baseAmount: 252000, finePct: 20, fineAmount: 50400 }) },
        });
        expect(await adminRow(admin, contract.id)).toMatchObject({ fineBaseAmount: 252000, fineAmountPreview: 50400 });

        await pay(p1.id);
        expect(await adminRow(admin, contract.id)).toMatchObject({ remainingTotal: 168000, fineBaseAmount: 168000, fineAmountPreview: 33600 });

        const res = await resolve(admin, contract.id);
        expect(res.body.fine).toMatchObject({ amount: 33600, baseAmount: 168000, finePct: 20 });
        expect((await fineOf(contract.id))!.metadata).toEqual({ kind: 'CANCELLATION_FINE', finePct: 20, baseAmount: 168000 });
    });

    it('sem pagamento durante a análise nada muda: multa cheia da base congelada; isenção não cobra', async () => {
        const a = await threeOpen();
        await requestCancel(a.client, a.contract.id);
        const charged = await resolve(a.admin, a.contract.id);
        expect(charged.body.fine).toMatchObject({ amount: 50400, baseAmount: 252000 });
        expect(charged.body.voidedCount).toBe(3);

        const b = await threeOpen();
        await requestCancel(b.client, b.contract.id);
        await pay(b.p1.id);
        const waived = await resolve(b.admin, b.contract.id, 'WAIVE_FEE');
        expect(waived.body.fine).toBeNull();
        expect(await fineOf(b.contract.id)).toBeNull();
    });
});

// ═══ 3) "Pagamento vencido" × cancelamento em análise ════════════════════════════════════════════
describe('E13 — o cliente não é lembrado de parcela que o backend não deixa pagar', () => {
    const listOf = async (who: Who) => (await call('GET', '/api/notifications', who)).body.notifications as any[];
    const overdueOf = async (who: Who) => (await listOf(who)).filter(n => n.id.startsWith('payment-overdue-'));
    const failedOf = async (who: Who) => (await listOf(who)).filter(n => n.id.startsWith('payment-failed-'));

    async function scenario() {
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser();
        const contract = await mkContract(client.id, { type: 'FIXO', paymentMethod: 'PIX', startDate: spDay(-40), endDate: spDay(44) });
        await mkPayment(client.id, { contractId: contract.id, amount: 84000, status: 'PAID', paidAt: secondsAgo(86400), dueDate: spDay(-40) });
        const overdue = await mkPayment(client.id, { contractId: contract.id, amount: 84000, dueDate: spDay(-5) });
        await mkPayment(client.id, { contractId: contract.id, amount: 84000, dueDate: spDay(16) });
        return { admin, client, contract, overdue };
    }

    it('parcela do plano vencida: avisa com o contrato ativo; some com o cancelamento em análise; volta se o admin reabrir', async () => {
        const { admin, client, contract } = await scenario();

        let mine = await overdueOf(client);
        expect(mine).toHaveLength(1);
        expect(mine[0]).toMatchObject({ id: 'payment-overdue-agg', type: 'PAYMENT_OVERDUE', actionUrl: '/meus-pagamentos' });
        expect(mine[0].message).toContain('1 fatura(s)');
        expect(mine[0].message).toContain('R$ 840,00');

        expect((await call('POST', `/api/contracts/${contract.id}/request-cancellation`, client)).status).toBe(200);
        expect(await overdueOf(client)).toHaveLength(0);
        // O alerta "cancelamento em análise" continua lá.
        expect((await listOf(client)).some(n => n.id === `cancellation-pending-${contract.id}`)).toBe(true);
        // O admin (que pode cobrar) continua vendo a fatura vencida do cliente.
        const forAdmin = await overdueOf(admin);
        expect(forAdmin).toHaveLength(1);
        expect(forAdmin[0]).toMatchObject({ id: `payment-overdue-${client.id}` });
        expect(forAdmin[0].message).toContain('R$ 840,00');

        expect((await call('PATCH', `/api/contracts/${contract.id}`, admin, { status: 'ACTIVE' })).status).toBe(200);
        expect(await overdueOf(client)).toHaveLength(1);
    });

    it('com o cancelamento em análise, extras de gravação vencidos continuam avisando (só eles entram no total)', async () => {
        const { client, contract } = await scenario();
        const booking = await mkBooking(client.id, contract.id, { date: spDay(-6), status: 'COMPLETED' });
        await mkPayment(client.id, { contractId: contract.id, bookingId: booking.id, amount: 5000, dueDate: spDay(-6) });
        await prisma.contract.update({ where: { id: contract.id }, data: { status: 'PENDING_CANCELLATION' } });

        const mine = await overdueOf(client);
        expect(mine).toHaveLength(1);
        expect(mine[0].message).toContain('1 fatura(s)');
        expect(mine[0].message).toContain('R$ 50,00');
        expect(mine[0].message).not.toContain('840');
    });

    it('a multa de cancelamento vencida avisa normalmente (contrato CANCELADO)', async () => {
        const { admin, client, contract } = await scenario();
        await call('POST', `/api/contracts/${contract.id}/request-cancellation`, client);
        const res = await call('POST', `/api/contracts/${contract.id}/resolve-cancellation`, admin, { action: 'CHARGE_FEE' });
        expect(res.body.fine).toMatchObject({ amount: 33600 });
        expect(await overdueOf(client)).toHaveLength(0); // a multa vence hoje; as parcelas foram anuladas

        await prisma.payment.update({ where: { id: res.body.fine.id }, data: { dueDate: spDay(-3) } });
        const mine = await overdueOf(client);
        expect(mine).toHaveLength(1);
        expect(mine[0].message).toContain('R$ 336,00');
    });

    it('outro contrato do mesmo cliente (ativo) segue avisando; só as parcelas do contrato em análise saem', async () => {
        const { client, contract } = await scenario();
        const other = await mkContract(client.id, { type: 'FLEX', paymentMethod: 'PIX' });
        await mkPayment(client.id, { contractId: other.id, amount: 30000, dueDate: spDay(-2) });
        await prisma.contract.update({ where: { id: contract.id }, data: { status: 'PENDING_CANCELLATION' } });

        const mine = await overdueOf(client);
        expect(mine).toHaveLength(1);
        expect(mine[0].message).toContain('1 fatura(s)');
        expect(mine[0].message).toContain('R$ 300,00');
    });

    it('"Pagamento com cartão falhou": mesma regra — o cliente não vê a parcela bloqueada; o admin vê', async () => {
        const { admin, client, contract, overdue } = await scenario();
        await prisma.payment.update({ where: { id: overdue.id }, data: { status: 'FAILED', provider: 'STRIPE' } });
        expect((await failedOf(client)).map(n => n.id)).toEqual([`payment-failed-${overdue.id}`]);

        await prisma.contract.update({ where: { id: contract.id }, data: { status: 'PENDING_CANCELLATION' } });
        expect(await failedOf(client)).toHaveLength(0);
        expect((await failedOf(admin)).map(n => n.id)).toEqual([`payment-failed-${overdue.id}`]);
    });
});

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
import { redis } from '../../src/lib/redis';
import { config } from '../../src/config/index';
import { saoPauloParts } from '../../src/lib/spTime';
import * as sicoob from '../../src/lib/sicoobService';
import * as stripe from '../../src/lib/stripeService';
import * as push from '../../src/modules/push/pushService';
import { buildStaticBrCode } from '../../src/lib/brcode';
import { getConfig, invalidateConfigCache } from '../../src/lib/businessConfig';
import { getBasePriceDynamic, applyDiscount } from '../../src/utils/pricing';
import { voidContractPendingPayments, voidContractPendingPaymentsDetailed } from '../../src/lib/paymentEffects';
import { deleteUser } from '../../src/lib/userDeletion';
import { runPushNotificationJob } from '../../src/jobs/pushNotificationJob';
import contractRoutes from '../../src/modules/contracts/routes';
import stripeRoutes from '../../src/modules/stripe/routes';
import webhookRoutes from '../../src/modules/webhooks/routes';
import { mkUser, mkContract, mkPayment, mkBooking } from './factories';

// Lote 2 — correções da revisão adversarial, frente fxA-cancel (cancelamento, multa, efeitos de
// pagamento e notificações):
//  PAY-1 / CAN-1  a anulação de parcelas nunca anula a multa de cancelamento; a decisão é serializada
//                 por contrato (trava) e o status é relido; multa nova substitui a anterior em aberto;
//  PAY-5          a troca de serviços aposenta o PaymentIntent antigo da parcela repreçada;
//  CAN-2 / ADM-1  decidir um pedido que não está mais em análise → 409 CANCELLATION_NOT_PENDING;
//  CAN-3 / ADM-2  PATCH status=CANCELLED devolve o que o provedor respondeu, como o DELETE;
//  CAN-4 / CLI-2  o pedido anula os extras das gravações que ele mesmo cancelou;
//  CLI-4          as mensagens de "sem multa" dizem o motivo verdadeiro;
//  FILA           o push de "faturas vencidas" segue o mesmo filtro do sino.

type Who = { id: string; email: string | null; role: string };

const m = <T extends (...a: any[]) => any>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>;
const getCob = m(sicoob.sicoobGetCob);
const removeCob = m(sicoob.sicoobRemoveCob);
const getPI = m(stripe.stripeGetPaymentIntent);
const cancelPI = m(stripe.stripeCancelPaymentIntent);
const sendPush = m(push.sendPushToUser);

// txids no formato Sicoob (26–35 alfanuméricos).
const TX_LIVE = 'TXFXACANCELVIVA0000000000001';
const TX_PAID = 'TXFXACANCELPAGA0000000000001';
const TX_FINE = 'TXFXACANCELMULTA000000000001';

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
    removeCob.mockReset();
    removeCob.mockResolvedValue(true);
    getCob.mockReset();
    m(stripe.isStripeEnabled).mockResolvedValue(true);
    m(stripe.stripeCardInstallmentsSupported).mockResolvedValue(false);
    cancelPI.mockReset();
    cancelPI.mockResolvedValue({ status: 'canceled', canceled: true });
    getPI.mockReset();
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
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms = 5000) {
    const until = Date.now() + ms;
    while (!cond() && Date.now() < until) await sleep(20);
    expect(cond()).toBe(true);
}

async function setFinePct(v: number) {
    await prisma.businessConfig.upsert({
        where: { key: 'cancellation_fine_pct' },
        create: { key: 'cancellation_fine_pct', value: String(v), type: 'percent', label: 'Multa', group: 'policies' } as any,
        update: { value: String(v) },
    });
    invalidateConfigCache();
}

/** FIXO mensal de 3 parcelas de R$ 840: a 1ª paga, a 2ª e a 3ª pendentes (faltam R$ 1.680). */
async function monthlyFixo(contractOver: Record<string, unknown> = {}) {
    const admin = await mkUser({ role: 'ADMIN' });
    const client = await mkUser();
    const contract = await mkContract(client.id, {
        type: 'FIXO', paymentMethod: 'PIX', startDate: spDay(-20), endDate: spDay(64), fixedDayOfWeek: 1, fixedTime: '10:00', ...contractOver,
    } as any);
    const p1 = await mkPayment(client.id, { contractId: contract.id, amount: 84000, status: 'PAID', paidAt: new Date(), dueDate: spDay(-20) });
    const p2 = await mkPayment(client.id, { contractId: contract.id, amount: 84000, dueDate: spDay(8) });
    const p3 = await mkPayment(client.id, { contractId: contract.id, amount: 84000, dueDate: spDay(36) });
    return { admin, client, contract, p1, p2, p3 };
}

const pixFields = (txid: string, amountCents: number) => ({
    provider: 'SICOOB' as const, providerRef: txid,
    pixString: buildStaticBrCode({ key: 'k', amountCents, txid }), pixExpiresAt: new Date(Date.now() + 1800_000),
});
const cobAtiva = (valor = '840.00') => ({ status: 'ATIVA', valor: { original: valor }, calendario: { criacao: new Date().toISOString(), expiracao: 3600 } });
const cobPaga = (valor = '840.00') => ({ status: 'CONCLUIDA', valor: { original: valor }, pix: [{ valor }] });

const pay = (id: string) => prisma.payment.findUniqueOrThrow({ where: { id } });
const payStatus = async (id: string) => (await pay(id)).status;
const contractStatus = async (id: string) => (await prisma.contract.findUniqueOrThrow({ where: { id } })).status;
const finesOf = (contractId: string) => prisma.payment.findMany({
    where: { contractId, metadata: { path: ['kind'], equals: 'CANCELLATION_FINE' } },
    orderBy: { createdAt: 'asc' },
});
const requestCancel = (client: Who, contractId: string) => call('POST', `/api/contracts/${contractId}/request-cancellation`, client);
const resolve = (admin: Who, contractId: string, action: 'CHARGE_FEE' | 'WAIVE_FEE' = 'CHARGE_FEE') =>
    call('POST', `/api/contracts/${contractId}/resolve-cancellation`, admin, { action });

/** Contrato cancelado pela decisão "Cobrar multa": a multa (R$ 336 = 20% de R$ 1.680) fica PENDING. */
async function finedContract() {
    const ctx = await monthlyFixo();
    expect((await requestCancel(ctx.client, ctx.contract.id)).status).toBe(200);
    const res = await resolve(ctx.admin, ctx.contract.id);
    expect(res.status).toBe(200);
    const [fine] = await finesOf(ctx.contract.id);
    expect(fine).toMatchObject({ amount: 33600, status: 'PENDING' });
    return { ...ctx, fine: fine! };
}

// ═══ PAY-1 / CAN-1 — a anulação nunca anula a multa; decisão serializada ═══════════════════════════
describe('PAY-1 / CAN-1 — a anulação de parcelas não anula a multa de cancelamento', () => {
    it('anulação tardia (o snapshot da 2ª requisição) não toca na multa; só includeFines a alcança', async () => {
        const { contract, fine } = await finedContract();

        // É o que a requisição "perdedora" fazia depois do commit da vencedora.
        expect(await voidContractPendingPaymentsDetailed(contract.id)).toMatchObject({ voided: 0, paidAtProvider: [], liveAtProvider: [] });
        expect(await voidContractPendingPayments(contract.id)).toBe(0);
        expect(await payStatus(fine.id)).toBe('PENDING');
        // Escopo "extras de gravações" também nunca pega a multa.
        expect(await voidContractPendingPayments(contract.id, { bookingIds: ['qualquer'] })).toBe(0);
        expect(await payStatus(fine.id)).toBe('PENDING');

        expect(await voidContractPendingPayments(contract.id, { includeFines: true })).toBe(1);
        expect(await payStatus(fine.id)).toBe('CANCELLED');
    });

    it('onlyFines anula só a multa (parcelas e extras em aberto ficam como estão)', async () => {
        const { client, contract, p2, p3 } = await monthlyFixo();
        const fine = await mkPayment(client.id, { contractId: contract.id, amount: 33600, metadata: { kind: 'CANCELLATION_FINE', finePct: 20, baseAmount: 168000 } });
        expect(await voidContractPendingPayments(contract.id, { onlyFines: true })).toBe(1);
        expect(await payStatus(fine.id)).toBe('CANCELLED');
        expect(await payStatus(p2.id)).toBe('PENDING');
        expect(await payStatus(p3.id)).toBe('PENDING');
    });

    it('dois admins decidindo ao mesmo tempo: um 200, um 409 com código, UMA multa e ela fica PENDING', async () => {
        const { admin, client, contract } = await monthlyFixo();
        await requestCancel(client, contract.id);
        const [a, b] = await Promise.all([resolve(admin, contract.id), resolve(admin, contract.id)]);
        expect([a.status, b.status].sort()).toEqual([200, 409]);
        const loser = a.status === 409 ? a : b;
        expect(loser.body).toMatchObject({ code: 'CANCELLATION_NOT_PENDING', error: 'Este pedido de cancelamento já foi resolvido.' });
        const fines = await finesOf(contract.id);
        expect(fines).toHaveLength(1);
        expect(fines[0]!.status).toBe('PENDING');
    });

    it('decisões sobrepostas com cobrança emitida: a 2ª espera a trava, recebe 409 e NÃO toca no provedor; a multa fica PENDING', async () => {
        const { admin, client, contract, p2 } = await monthlyFixo();
        await prisma.payment.update({ where: { id: p2.id }, data: pixFields(TX_LIVE, 84000) });
        getCob.mockResolvedValue(cobAtiva());
        await requestCancel(client, contract.id);

        // A 1ª decisão fica presa no provedor (remoção do QR), com a trava do contrato na mão.
        let release!: () => void;
        const gate = new Promise<void>(r => { release = r; });
        removeCob.mockImplementationOnce(async () => { await gate; return true; });
        const first = resolve(admin, contract.id, 'CHARGE_FEE');
        await waitFor(() => removeCob.mock.calls.length === 1);

        // A 2ª chega no meio: antes ela passava pela checagem de status e, ao terminar depois, anulava a multa.
        const second = resolve(admin, contract.id, 'WAIVE_FEE');
        await sleep(400);
        expect(await contractStatus(contract.id)).toBe('PENDING_CANCELLATION');
        expect(removeCob).toHaveBeenCalledTimes(1);

        release();
        const [a, b] = await Promise.all([first, second]);
        expect(a.status).toBe(200);
        expect(a.body.fine).toMatchObject({ amount: 33600, status: 'PENDING' });
        expect(b.status).toBe(409);
        expect(b.body.code).toBe('CANCELLATION_NOT_PENDING');
        expect(removeCob).toHaveBeenCalledTimes(1); // a 2ª não falou com o provedor

        const fines = await finesOf(contract.id);
        expect(fines).toHaveLength(1);
        expect(fines[0]!.status).toBe('PENDING');
        // O cliente recebe UM aviso (o da multa) — nada de "cancelado sem multa" por cima.
        const notes = await prisma.notification.findMany({ where: { userId: client.id, type: 'CANCELLATION_PENDING' } });
        expect(notes).toHaveLength(1);
        expect(notes[0]).toMatchObject({ entityType: 'PAYMENT', entityId: fines[0]!.id });
    });

    it('DELETE e PATCH status=CANCELLED concorrentes com a decisão: esperam a trava, não anulam a multa nem avisam de novo', async () => {
        for (const variant of ['DELETE', 'PATCH'] as const) {
            const { admin, client, contract, p2 } = await monthlyFixo();
            await prisma.payment.update({ where: { id: p2.id }, data: pixFields(`${TX_LIVE.slice(0, -1)}${variant === 'DELETE' ? '2' : '3'}`, 84000) });
            getCob.mockResolvedValue(cobAtiva());
            await requestCancel(client, contract.id);

            removeCob.mockClear();
            let release!: () => void;
            const gate = new Promise<void>(r => { release = r; });
            removeCob.mockImplementationOnce(async () => { await gate; return true; });
            const first = resolve(admin, contract.id, 'CHARGE_FEE');
            await waitFor(() => removeCob.mock.calls.length === 1);

            const second = variant === 'DELETE'
                ? call('DELETE', `/api/contracts/${contract.id}`, admin)
                : call('PATCH', `/api/contracts/${contract.id}`, admin, { status: 'CANCELLED' });
            await sleep(300);
            release();
            const [a, b] = await Promise.all([first, second]);
            expect(a.status).toBe(200);
            if (variant === 'DELETE') {
                expect(b.status).toBe(400);
                expect(b.body.error).toBe('Contrato já está cancelado.');
            } else {
                // O contrato já estava cancelado quando o PATCH pegou a trava: nada a anular nem a avisar.
                expect(b.status).toBe(200);
                expect(b.body.message).toBe('Contrato atualizado com sucesso.');
                expect(b.body.voidedCount).toBeUndefined();
            }
            const fines = await finesOf(contract.id);
            expect(fines).toHaveLength(1);
            expect(fines[0]!.status).toBe('PENDING');
            const notes = await prisma.notification.findMany({ where: { userId: client.id, type: 'CANCELLATION_PENDING' } });
            expect(notes).toHaveLength(1);
            expect(notes[0]).toMatchObject({ entityType: 'PAYMENT', entityId: fines[0]!.id });
            expect(await prisma.auditLog.count({ where: { entityType: 'CONTRACT', entityId: contract.id, action: 'CANCELLED' } })).toBe(1);
        }
    });

    it('trava ocupada por outra requisição que não termina → 409 CANCELLATION_IN_PROGRESS, sem nenhum efeito', async () => {
        const { admin, client, contract, p2, p3 } = await monthlyFixo();
        await requestCancel(client, contract.id);
        const key = `mutex:contract-cancel:${contract.id}`;
        await redis.set(key, '1', 'EX', 60);
        try {
            const res = await resolve(admin, contract.id);
            expect(res.status).toBe(409);
            expect(res.body.code).toBe('CANCELLATION_IN_PROGRESS');
        } finally {
            await redis.del(key);
        }
        expect(await contractStatus(contract.id)).toBe('PENDING_CANCELLATION');
        expect(await payStatus(p2.id)).toBe('PENDING');
        expect(await payStatus(p3.id)).toBe('PENDING');
        expect(await finesOf(contract.id)).toHaveLength(0);
        // Liberada a trava, a decisão segue normalmente (e a trava é solta ao final).
        expect((await resolve(admin, contract.id)).status).toBe(200);
        expect(await redis.exists(key)).toBe(0);
    }, 40000);

    it('contrato reaberto e cancelado de novo pelo admin (DELETE / PATCH): a multa anterior continua PENDING', async () => {
        for (const variant of ['DELETE', 'PATCH'] as const) {
            const { admin, contract, fine } = await finedContract();
            expect((await call('PATCH', `/api/contracts/${contract.id}`, admin, { status: 'ACTIVE' })).status).toBe(200);
            const res = variant === 'DELETE'
                ? await call('DELETE', `/api/contracts/${contract.id}`, admin)
                : await call('PATCH', `/api/contracts/${contract.id}`, admin, { status: 'CANCELLED' });
            expect(res.status).toBe(200);
            expect(res.body.voidedCount).toBe(0);
            expect(await contractStatus(contract.id)).toBe('CANCELLED');
            expect(await payStatus(fine.id)).toBe('PENDING');
        }
    });

    it('reaberto + novo pedido + "Cobrar multa": a multa anterior é aposentada no provedor e anulada — nunca duas em aberto', async () => {
        const { admin, client, contract, fine: old } = await finedContract();
        // A multa antiga já tinha um QR PIX emitido.
        await prisma.payment.update({ where: { id: old.id }, data: pixFields(TX_FINE, 33600) });
        getCob.mockResolvedValue(cobAtiva('336.00'));
        expect((await call('PATCH', `/api/contracts/${contract.id}`, admin, { status: 'ACTIVE' })).status).toBe(200);
        // Nova parcela do plano em aberto (as antigas foram anuladas no 1º cancelamento).
        const p4 = await mkPayment(client.id, { contractId: contract.id, amount: 84000, dueDate: spDay(40) });

        const req = await requestCancel(client, contract.id);
        expect(req.body.fine).toEqual({ finePct: 20, baseAmount: 84000, amount: 16800 }); // a multa antiga não entra na base
        const res = await resolve(admin, contract.id, 'CHARGE_FEE');
        expect(res.status).toBe(200);
        expect(res.body.fine).toMatchObject({ amount: 16800, status: 'PENDING', baseAmount: 84000 });
        expect(res.body.voidedCount).toBe(1); // só a parcela nova; a multa antiga não conta como parcela
        expect(res.body.message).toContain('substituída');

        expect(removeCob).toHaveBeenCalledWith(TX_FINE);
        expect(await payStatus(old.id)).toBe('CANCELLED');
        expect(await payStatus(p4.id)).toBe('CANCELLED');
        const fines = await finesOf(contract.id);
        expect(fines).toHaveLength(2);
        expect(fines.filter(f => f.status === 'PENDING' || f.status === 'FAILED')).toHaveLength(1);
        expect(fines.find(f => f.status === 'PENDING')!.id).toBe(res.body.fine.id);
        const mark = await prisma.auditLog.findFirstOrThrow({
            where: { entityType: 'CONTRACT', entityId: contract.id, action: 'CANCELLED', changes: { contains: res.body.fine.id } },
        });
        expect(JSON.parse(mark.changes!)).toMatchObject({ via: 'RESOLVE_CANCELLATION', replacedFines: 1 });
    });

    it('reaberto + novo pedido + multa antiga JÁ PAGA no banco: ela vira PAID (não é anulada) e a nova nasce PENDING', async () => {
        const { admin, client, contract, fine: old } = await finedContract();
        await prisma.payment.update({ where: { id: old.id }, data: pixFields(TX_PAID, 33600) });
        getCob.mockResolvedValue(cobPaga('336.00'));
        await call('PATCH', `/api/contracts/${contract.id}`, admin, { status: 'ACTIVE' });
        await mkPayment(client.id, { contractId: contract.id, amount: 84000, dueDate: spDay(40) });
        await requestCancel(client, contract.id);

        const res = await resolve(admin, contract.id, 'CHARGE_FEE');
        expect(res.status).toBe(200);
        expect(res.body.paidAtProvider).toBe(1);
        expect(res.body.message).toContain('já estava paga');
        expect(await payStatus(old.id)).toBe('PAID');
        expect(res.body.fine).toMatchObject({ amount: 16800, status: 'PENDING' });
    });

    it('reaberto + novo pedido SEM multa nova (isenção): a multa anterior continua devida e a resposta avisa o admin', async () => {
        const { admin, client, contract, fine: old } = await finedContract();
        await call('PATCH', `/api/contracts/${contract.id}`, admin, { status: 'ACTIVE' });
        await mkPayment(client.id, { contractId: contract.id, amount: 84000, dueDate: spDay(40) });
        await requestCancel(client, contract.id);

        const res = await resolve(admin, contract.id, 'WAIVE_FEE');
        expect(res.status).toBe(200);
        expect(res.body.fine).toBeNull();
        expect(res.body.message).toContain('continua pendente');
        expect(res.body.message).toContain('R$ 336,00');
        expect(await payStatus(old.id)).toBe('PENDING');
        expect((await finesOf(contract.id))).toHaveLength(1);
    });

    it('exclusão de cliente continua anulando a multa pendente (includeFines)', async () => {
        const { admin, client, contract, fine } = await finedContract();
        const result = await deleteUser(client.id, admin.id);
        expect(result.softDeleted).toBe(true);
        expect(await payStatus(fine.id)).toBe('CANCELLED');
        expect(await prisma.payment.count({ where: { contractId: contract.id, status: { in: ['PENDING', 'FAILED'] } } })).toBe(0);
    });
});

// ═══ CAN-2 / ADM-1 — decisão de um pedido que não está mais em análise ════════════════════════════
describe('CAN-2 / ADM-1 — resolve-cancellation fora de PENDING_CANCELLATION → 409 CANCELLATION_NOT_PENDING', () => {
    it('segunda decisão em SEQUÊNCIA (lista defasada): 409 "já foi resolvido", nada muda', async () => {
        const { admin, contract, fine } = await finedContract();
        for (const action of ['CHARGE_FEE', 'WAIVE_FEE'] as const) {
            const again = await resolve(admin, contract.id, action);
            expect(again.status).toBe(409);
            expect(again.body).toEqual({ error: 'Este pedido de cancelamento já foi resolvido.', code: 'CANCELLATION_NOT_PENDING' });
        }
        const fines = await finesOf(contract.id);
        expect(fines).toHaveLength(1);
        expect(fines[0]).toMatchObject({ id: fine.id, status: 'PENDING', amount: 33600 });
        expect(removeCob).not.toHaveBeenCalled();
    });

    it('contrato reaberto (ACTIVE) ou sem pedido: 409 "não está mais aguardando cancelamento"; inexistente → 404', async () => {
        const { admin, client, contract, p2 } = await monthlyFixo();
        const never = await resolve(admin, contract.id);
        expect(never.status).toBe(409);
        expect(never.body).toEqual({ error: 'O contrato não está mais aguardando cancelamento.', code: 'CANCELLATION_NOT_PENDING' });

        await requestCancel(client, contract.id);
        await call('PATCH', `/api/contracts/${contract.id}`, admin, { status: 'ACTIVE' });
        const reopened = await resolve(admin, contract.id);
        expect(reopened.status).toBe(409);
        expect(reopened.body.code).toBe('CANCELLATION_NOT_PENDING');
        expect(await payStatus(p2.id)).toBe('PENDING');
        expect(await finesOf(contract.id)).toHaveLength(0);

        expect((await resolve(admin, '00000000-0000-0000-0000-000000000000')).status).toBe(404);
        expect((await call('POST', `/api/contracts/${contract.id}/resolve-cancellation`, admin, { action: 'OUTRA' })).status).toBe(400);
    });
});

// ═══ CAN-3 / ADM-2 — PATCH status=CANCELLED devolve o resultado do provedor ═══════════════════════
describe('CAN-3 / ADM-2 — "Editar → Cancelado" (PATCH) responde como o DELETE', () => {
    it('PIX já pago no banco: parcela vira PAID, paidAtProvider = 1 e a mensagem avisa', async () => {
        const { admin, contract, p2, p3 } = await monthlyFixo();
        await prisma.payment.update({ where: { id: p2.id }, data: pixFields(TX_PAID, 84000) });
        getCob.mockResolvedValue(cobPaga());

        const res = await call('PATCH', `/api/contracts/${contract.id}`, admin, { status: 'CANCELLED' });
        expect(res.status).toBe(200);
        expect(res.body.contract.status).toBe('CANCELLED');
        expect(res.body).toMatchObject({ voidedCount: 1, paidAtProvider: 1, liveAtProvider: 0 });
        expect(res.body.message).toContain('Contrato cancelado.');
        expect(res.body.message).toContain('já estava paga');
        expect(await payStatus(p2.id)).toBe('PAID');
        expect(await payStatus(p3.id)).toBe('CANCELLED');
    });

    it('QR que o banco não deixou remover: liveAtProvider = 1 e a mensagem diz que o admin será avisado', async () => {
        const { admin, contract, p2 } = await monthlyFixo();
        await prisma.payment.update({ where: { id: p2.id }, data: pixFields(TX_LIVE, 84000) });
        removeCob.mockResolvedValue(false);
        getCob.mockResolvedValue(cobAtiva());

        const res = await call('PATCH', `/api/contracts/${contract.id}`, admin, { status: 'CANCELLED' });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ voidedCount: 2, paidAtProvider: 0, liveAtProvider: 1 });
        expect(res.body.message).toContain('você será avisado');
        expect(await payStatus(p2.id)).toBe('CANCELLED');
    });

    it('sem cobrança emitida: contagens zeradas no provedor; agendamentos futuros contados', async () => {
        const { admin, client, contract } = await monthlyFixo();
        await mkBooking(client.id, contract.id, { date: spDay(5), status: 'CONFIRMED' });
        const res = await call('PATCH', `/api/contracts/${contract.id}`, admin, { status: 'CANCELLED' });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ voidedCount: 2, paidAtProvider: 0, liveAtProvider: 0, cancelledBookings: 1 });
        expect(res.body.message).toBe('Contrato cancelado. Agendamentos futuros e 2 parcela(s) pendente(s) foram cancelados.');
        const mark = await prisma.auditLog.findFirstOrThrow({ where: { entityType: 'CONTRACT', entityId: contract.id, action: 'CANCELLED' } });
        expect(JSON.parse(mark.changes!)).toMatchObject({ via: 'ADMIN_PATCH', from: 'ACTIVE', voidedCount: 2 });
        expect(await redis.exists(`mutex:contract-cancel:${contract.id}`)).toBe(0);
    });

    it('os demais PATCH continuam com a resposta de sempre (sem os campos do cancelamento)', async () => {
        const { admin, contract, p2 } = await monthlyFixo();
        const res = await call('PATCH', `/api/contracts/${contract.id}`, admin, { contractUrl: 'https://exemplo.com/contrato.pdf' });
        expect(res.status).toBe(200);
        expect(res.body.message).toBe('Contrato atualizado com sucesso.');
        expect(Object.keys(res.body).sort()).toEqual(['contract', 'message']);
        expect(await payStatus(p2.id)).toBe('PENDING');
        // Cancelar o que já está cancelado também não é "cancelamento via PATCH".
        const done = await mkContract(contract.userId, { type: 'FIXO', status: 'CANCELLED' });
        const again = await call('PATCH', `/api/contracts/${done.id}`, admin, { status: 'CANCELLED' });
        expect(again.body.message).toBe('Contrato atualizado com sucesso.');
        expect(again.body.voidedCount).toBeUndefined();
    });
});

// ═══ CAN-4 / CLI-2 — extras das gravações que o pedido cancelou ═══════════════════════════════════
describe('CAN-4 / CLI-2 — o pedido de cancelamento anula os extras das gravações que ele cancelou', () => {
    it('extra da gravação futura (com QR vivo) é aposentado no banco e anulado; o da gravação realizada continua pagável', async () => {
        const { client, contract, p2, p3 } = await monthlyFixo();
        const future = await mkBooking(client.id, contract.id, { date: spDay(3), status: 'CONFIRMED' });
        const futureNoCharge = await mkBooking(client.id, contract.id, { date: spDay(10), status: 'RESERVED' });
        const done = await mkBooking(client.id, contract.id, { date: spDay(-5), status: 'COMPLETED' });
        const extraFuture = await mkPayment(client.id, { contractId: contract.id, bookingId: future.id, amount: 5000, dueDate: spDay(3), ...pixFields(TX_LIVE, 5000) });
        const extraFailed = await mkPayment(client.id, { contractId: contract.id, bookingId: futureNoCharge.id, provider: 'STRIPE', amount: 7000, status: 'FAILED', dueDate: spDay(10) });
        const extraDone = await mkPayment(client.id, { contractId: contract.id, bookingId: done.id, amount: 5000, dueDate: spDay(-5) });
        getCob.mockResolvedValue(cobAtiva('50.00'));

        const req = await requestCancel(client, contract.id);
        expect(req.status).toBe(200);
        expect(req.body).toMatchObject({ cancelledBookings: 2, voidedExtras: 2 });
        expect(req.body.message).toContain('2 agendamentos futuros');
        expect(req.body.message).toContain('2 cobranças de serviços extras dessas gravações foram canceladas.');
        // A base da multa não muda: extras nunca entraram nela.
        expect(req.body.fine).toEqual({ finePct: 20, baseAmount: 168000, amount: 33600 });

        expect(removeCob).toHaveBeenCalledWith(TX_LIVE);
        expect(await payStatus(extraFuture.id)).toBe('CANCELLED');
        expect(await payStatus(extraFailed.id)).toBe('CANCELLED');
        // Gravação já realizada: o extra continua em aberto e pagável.
        expect(await payStatus(extraDone.id)).toBe('PENDING');
        // Parcelas do plano: ficam como estão até a decisão do estúdio.
        expect(await payStatus(p2.id)).toBe('PENDING');
        expect(await payStatus(p3.id)).toBe('PENDING');

        // O extra anulado não é mais pagável; o da gravação realizada, sim.
        m(sicoob.sicoobCreatePix).mockImplementation(async (p: { amount: number; txid: string }) => ({
            id: p.txid, pixString: buildStaticBrCode({ key: 'k', amountCents: p.amount, txid: p.txid }), status: 'ATIVA', expiresAt: new Date(Date.now() + 3600_000),
        }));
        await prisma.user.update({ where: { id: client.id }, data: { cpfCnpj: '52998224725' } });
        const denied = await call('POST', '/api/stripe/create-payment', client, { paymentId: extraFuture.id, paymentMethod: 'pix' });
        expect(denied.status).toBeGreaterThanOrEqual(400);
        const ok = await call('POST', '/api/stripe/create-payment', client, { paymentId: extraDone.id, paymentMethod: 'pix' });
        expect(ok.status).toBe(200);
        expect(ok.body.amount).toBe(5000);
    });

    it('extra cujo PIX já foi pago no banco vira PAID (não é anulado); sem extras nada é anulado', async () => {
        const a = await monthlyFixo();
        const future = await mkBooking(a.client.id, a.contract.id, { date: spDay(3), status: 'CONFIRMED' });
        const extra = await mkPayment(a.client.id, { contractId: a.contract.id, bookingId: future.id, amount: 5000, dueDate: spDay(3), ...pixFields(TX_PAID, 5000) });
        getCob.mockResolvedValue(cobPaga('50.00'));
        const req = await requestCancel(a.client, a.contract.id);
        expect(req.status).toBe(200);
        expect(req.body.voidedExtras).toBe(0);
        expect(req.body.message).not.toContain('serviços extras');
        expect(await payStatus(extra.id)).toBe('PAID');
        expect(removeCob).not.toHaveBeenCalled();

        const b = await monthlyFixo();
        await mkBooking(b.client.id, b.contract.id, { date: spDay(3), status: 'CONFIRMED' });
        const plain = await requestCancel(b.client, b.contract.id);
        expect(plain.body).toMatchObject({ cancelledBookings: 1, voidedExtras: 0 });
        expect(await payStatus(b.p2.id)).toBe('PENDING');
    });

    it('gravação de hoje já iniciada não é cancelada pelo pedido → o extra dela continua em aberto', async () => {
        const { client, contract } = await monthlyFixo();
        const recording = await mkBooking(client.id, contract.id, { date: spDay(0), startTime: '23:59', endTime: '23:59', status: 'CONFIRMED', recordingStartedAt: new Date() });
        const extra = await mkPayment(client.id, { contractId: contract.id, bookingId: recording.id, amount: 5000, dueDate: spDay(0) });
        const req = await requestCancel(client, contract.id);
        expect(req.body).toMatchObject({ cancelledBookings: 0, voidedExtras: 0 });
        expect(await payStatus(extra.id)).toBe('PENDING');
    });
});

// ═══ CLI-4 — mensagens de "sem multa" dizem o motivo verdadeiro ═══════════════════════════════════
describe('CLI-4 — "sem multa" com o motivo verdadeiro', () => {
    it('multa configurada em 0% com parcelas em aberto: não afirma que não há parcelas em aberto', async () => {
        await setFinePct(0);
        const { admin, client, contract } = await monthlyFixo();

        const req = await requestCancel(client, contract.id);
        expect(req.body.fine).toEqual({ finePct: 0, baseAmount: 168000, amount: 0 });
        expect(req.body.message).toContain('O cancelamento não tem multa.');
        expect(req.body.message).not.toContain('Não há parcelas');
        expect(req.body.message).not.toContain('Não há saldo');

        const res = await resolve(admin, contract.id, 'CHARGE_FEE');
        expect(res.status).toBe(200);
        expect(res.body.fine).toBeNull();
        expect(res.body.message).toContain('Nenhuma multa aplicada');
        expect(res.body.message).toContain('0%');
        expect(res.body.message).not.toContain('não há parcelas');
        expect(res.body.message).not.toContain('não havia saldo');
        expect(await finesOf(contract.id)).toHaveLength(0);
    });

    it('nada em aberto (à vista quitado): diz que não há parcelas do plano em aberto', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser();
        const contract = await mkContract(client.id, { type: 'FIXO', paymentPlan: 'FULL', paymentMethod: 'PIX' });
        await mkPayment(client.id, { contractId: contract.id, amount: 252000, status: 'PAID', paidAt: new Date() });

        const req = await requestCancel(client, contract.id);
        expect(req.body.message).toContain('Não há parcelas do plano em aberto: o cancelamento não tem multa.');
        const res = await resolve(admin, contract.id, 'CHARGE_FEE');
        expect(res.body.message).toContain('Nenhuma multa aplicada: não há parcelas do plano em aberto.');
    });

    it('base quitada DURANTE a análise: a decisão diz que não há parcelas em aberto (presente), sem multa', async () => {
        const { admin, client, contract, p2, p3 } = await monthlyFixo();
        await requestCancel(client, contract.id);
        await prisma.payment.updateMany({ where: { id: { in: [p2.id, p3.id] } }, data: { status: 'PAID', paidAt: new Date() } });
        const res = await resolve(admin, contract.id, 'CHARGE_FEE');
        expect(res.body.fine).toBeNull();
        expect(res.body.message).toContain('Nenhuma multa aplicada: não há parcelas do plano em aberto.');
    });
});

// ═══ PAY-5 — troca de serviços aposenta o PaymentIntent antigo ════════════════════════════════════
describe('PAY-5 — troca de serviços: o PaymentIntent emitido pelo valor antigo não continua pagável', () => {
    const SERVICE = { key: 'GESTAO_SOCIAL', name: 'Gestão Social', price: 60000, monthly: true };

    async function newMonthly(discountPct: number) {
        const sessions = await getConfig('sessions_per_month');
        return sessions * applyDiscount(await getBasePriceDynamic('COMERCIAL'), discountPct) + applyDiscount(SERVICE.price, discountPct);
    }
    async function cardContract() {
        await prisma.addOnConfig.create({ data: { ...SERVICE, plansAllowed: 'FULL,MONTHLY' } });
        const ctx = await monthlyFixo({ paymentMethod: 'CARTAO' });
        await prisma.payment.update({ where: { id: ctx.p2.id }, data: { provider: 'STRIPE', providerRef: 'pi_open', chargedAmount: 84000, installments: 1 } });
        await prisma.payment.update({ where: { id: ctx.p3.id }, data: { provider: 'STRIPE' } });
        return ctx;
    }
    async function stripeSucceeded(paymentId: string, amount: number) {
        process.env.ALLOW_UNVERIFIED_WEBHOOKS = 'true';
        try {
            return await call('POST', '/api/webhooks/stripe', undefined, {
                type: 'payment_intent.succeeded',
                data: { object: { id: 'pi_open', amount, metadata: { paymentId }, payment_method_types: ['card'] } },
            });
        } finally {
            delete process.env.ALLOW_UNVERIFIED_WEBHOOKS;
        }
    }

    it('PI ainda pagável: cancelado no Stripe; a parcela perde o providerRef/chargedAmount e o webhook do valor antigo não dá baixa', async () => {
        const { admin, contract, p2, p3 } = await cardContract();
        getPI.mockResolvedValue({ id: 'pi_open', status: 'requires_payment_method', amount: 84000, client_secret: 'cs_old' });

        const patch = await call('PATCH', `/api/contracts/${contract.id}`, admin, { addOns: [SERVICE.key] });
        expect(patch.status).toBe(200);

        const amount = await newMonthly(contract.discountPct);
        expect(amount).not.toBe(84000);
        expect(cancelPI).toHaveBeenCalledWith('pi_open');
        expect(await pay(p2.id)).toMatchObject({ status: 'PENDING', amount, chargedAmount: null, providerRef: null });
        expect(await pay(p3.id)).toMatchObject({ status: 'PENDING', amount, providerRef: null });

        // A aba antiga conclui o PI de R$ 840 (se o Stripe ainda deixasse): o webhook recusa o valor antigo.
        expect((await stripeSucceeded(p2.id, 84000)).status).toBe(200);
        expect(await payStatus(p2.id)).toBe('PENDING');
    });

    it('PI em processamento: a parcela fica no valor antigo (PI intacto) e o pagamento dele dá baixa; as outras são repreçadas', async () => {
        const { admin, contract, p2, p3 } = await cardContract();
        getPI.mockResolvedValue({ id: 'pi_open', status: 'processing', amount: 84000 });

        expect((await call('PATCH', `/api/contracts/${contract.id}`, admin, { addOns: [SERVICE.key] })).status).toBe(200);

        expect(cancelPI).not.toHaveBeenCalled();
        expect(await pay(p2.id)).toMatchObject({ status: 'PENDING', amount: 84000, chargedAmount: 84000, providerRef: 'pi_open' });
        expect((await pay(p3.id)).amount).toBe(await newMonthly(contract.discountPct));
        expect((await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } })).addOns).toEqual([SERVICE.key]);

        expect((await stripeSucceeded(p2.id, 84000)).status).toBe(200);
        expect(await payStatus(p2.id)).toBe('PAID');
    });

    it('Stripe fora do ar (consulta falha) ou cancelamento recusado: valor antigo mantido, nada zerado', async () => {
        const a = await cardContract();
        getPI.mockRejectedValue(new Error('rede indisponível'));
        expect((await call('PATCH', `/api/contracts/${a.contract.id}`, a.admin, { addOns: [SERVICE.key] })).status).toBe(200);
        expect(cancelPI).not.toHaveBeenCalled();
        expect(await pay(a.p2.id)).toMatchObject({ amount: 84000, chargedAmount: 84000, providerRef: 'pi_open' });

        await prisma.addOnConfig.deleteMany({});
        const b = await cardContract();
        getPI.mockReset();
        getPI.mockResolvedValue({ id: 'pi_open', status: 'requires_action', amount: 84000 });
        cancelPI.mockResolvedValue({ status: 'requires_action', canceled: false });
        expect((await call('PATCH', `/api/contracts/${b.contract.id}`, b.admin, { addOns: [SERVICE.key] })).status).toBe(200);
        expect(await pay(b.p2.id)).toMatchObject({ amount: 84000, chargedAmount: 84000, providerRef: 'pi_open' });
    });

    it('PI que não existe mais no Stripe: a parcela é repreçada e deixa de apontar para ele', async () => {
        const { admin, contract, p2 } = await cardContract();
        getPI.mockRejectedValue(Object.assign(new Error('No such payment_intent'), { code: 'resource_missing' }));
        expect((await call('PATCH', `/api/contracts/${contract.id}`, admin, { addOns: [SERVICE.key] })).status).toBe(200);
        expect(await pay(p2.id)).toMatchObject({ amount: await newMonthly(contract.discountPct), chargedAmount: null, providerRef: null });
    });

    it('multa de cancelamento com PaymentIntent emitido (contrato reaberto) não é tocada pela troca de serviços', async () => {
        const { admin, client, contract } = await cardContract();
        const fine = await mkPayment(client.id, {
            contractId: contract.id, provider: 'STRIPE', providerRef: 'pi_fine', chargedAmount: 33600, amount: 33600,
            metadata: { kind: 'CANCELLATION_FINE', finePct: 20, baseAmount: 168000 },
        });
        getPI.mockImplementation(async (id: string) => ({ id, status: 'requires_payment_method', amount: id === 'pi_fine' ? 33600 : 84000 }));
        expect((await call('PATCH', `/api/contracts/${contract.id}`, admin, { addOns: [SERVICE.key] })).status).toBe(200);
        expect(cancelPI).not.toHaveBeenCalledWith('pi_fine');
        expect(await pay(fine.id)).toMatchObject({ amount: 33600, chargedAmount: 33600, providerRef: 'pi_fine' });
    });
});

// ═══ FILA — push de "faturas vencidas" com o mesmo filtro do sino ═════════════════════════════════
describe('pushNotificationJob — o cliente em análise não recebe push de parcela que não pode pagar', () => {
    const subscribe = (userId: string) => prisma.pushSubscription.create({
        data: { userId, endpoint: `https://push.example/${userId}`, p256dh: 'k', auth: 'a' },
    });
    const overdueNotes = (userId: string) => prisma.notification.findMany({ where: { userId, type: 'PAYMENT_OVERDUE' } });

    it('parcela do plano vencida em PENDING_CANCELLATION não gera push ao cliente; extras e contrato ativo geram; o admin vê tudo', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const mk = async (status: 'ACTIVE' | 'PENDING_CANCELLATION', withExtra: boolean) => {
            const client = await mkUser();
            const contract = await mkContract(client.id, { type: 'FIXO', paymentMethod: 'PIX', status, startDate: spDay(-40), endDate: spDay(44) });
            await mkPayment(client.id, { contractId: contract.id, amount: 84000, dueDate: spDay(-5) });
            if (withExtra) {
                const booking = await mkBooking(client.id, contract.id, { date: spDay(-6), status: 'COMPLETED' });
                await mkPayment(client.id, { contractId: contract.id, bookingId: booking.id, amount: 5000, dueDate: spDay(-6) });
            }
            await subscribe(client.id);
            return client;
        };
        const analysing = await mk('PENDING_CANCELLATION', false);
        const analysingWithExtra = await mk('PENDING_CANCELLATION', true);
        const active = await mk('ACTIVE', false);
        await subscribe(admin.id);

        await runPushNotificationJob();

        // Em análise, só parcela do plano: nada.
        expect(await overdueNotes(analysing.id)).toHaveLength(0);
        // Em análise com um extra vencido: só o extra entra no aviso.
        const extraOnly = await overdueNotes(analysingWithExtra.id);
        expect(extraOnly).toHaveLength(1);
        expect(extraOnly[0]!.message).toContain('1 fatura(s)');
        expect(extraOnly[0]!.message).toContain('R$ 50,00');
        // Contrato ativo: avisa normalmente.
        const normal = await overdueNotes(active.id);
        expect(normal).toHaveLength(1);
        expect(normal[0]!.message).toContain('R$ 840,00');
        // O admin (que pode cobrar) é avisado dos três clientes.
        const forAdmin = await overdueNotes(admin.id);
        expect(forAdmin.map(n => n.entityId).sort()).toEqual([analysing.id, analysingWithExtra.id, active.id].sort());
        expect(sendPush.mock.calls.map(c => c[0])).not.toContain(analysing.id);
    });
});

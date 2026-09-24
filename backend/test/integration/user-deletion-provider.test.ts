import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { prisma } from '../../src/lib/prisma';
import { redis } from '../../src/lib/redis';
import { config } from '../../src/config/index';
import * as sicoob from '../../src/lib/sicoobService';
import * as stripe from '../../src/lib/stripeService';
import { deleteUser, getDeletionPreview } from '../../src/lib/userDeletion';
import userRoutes from '../../src/modules/users/routes';
import authRoutes from '../../src/modules/auth/routes';
import { mkUser, mkContract, mkPayment, mkBooking } from './factories';

// D3 × provedores (revisão exclusao-auth-1/2/8/10):
//  • o soft delete CONCILIA e CANCELA no provedor antes de anular (PIX vivo / PaymentIntent aberto);
//    o que foi pago fica PAID; pagamento em processamento → 409 sem mexer em nada;
//  • excluir/bloquear revoga na hora a sessão já aberta;
//  • só são canceladas gravações cujo INÍCIO (data + hora SP) ainda não passou;
//  • o hard delete apaga o Customer do Stripe (o soft mantém).

vi.mock('../../src/lib/sicoobService', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../../src/lib/sicoobService')>();
    return {
        ...orig,
        getSicoobEnvironment: vi.fn(async () => 'production'),
        sicoobGetCob: vi.fn(),
        sicoobRemoveCob: vi.fn(async () => true),
    };
});

vi.mock('../../src/lib/stripeService', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../../src/lib/stripeService')>();
    return {
        ...orig,
        isStripeEnabled: vi.fn(async () => true),
        stripeGetPaymentIntent: vi.fn(),
        stripeCancelPaymentIntent: vi.fn(async () => ({ status: 'canceled', canceled: true })),
        stripeDetachPaymentMethod: vi.fn(async () => {}),
        stripeCancelSubscription: vi.fn(async () => {}),
        stripeDeleteCustomer: vi.fn(async () => {}),
    };
});

const getCob = vi.mocked(sicoob.sicoobGetCob);
const removeCob = vi.mocked(sicoob.sicoobRemoveCob);
const getPI = vi.mocked(stripe.stripeGetPaymentIntent);
const cancelPI = vi.mocked(stripe.stripeCancelPaymentIntent);
const deleteCustomer = (stripe as unknown as { stripeDeleteCustomer: ReturnType<typeof vi.fn> }).stripeDeleteCustomer;

let server: Server;
let base = '';
const touchedUsers: string[] = [];

beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/auth', authRoutes);
    app.use('/api/users', userRoutes);
    await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(async () => {
    vi.clearAllMocks();
    // Redis compartilhado com o dev: só as chaves de revogação dos usuários deste teste.
    const keys = touchedUsers.splice(0).map(id => `auth:revoked:${id}`);
    if (keys.length) await redis.del(...keys);
});

function cookieFor(u: { id: string; email: string | null; role: string }, iat?: number) {
    const payload = { userId: u.id, email: u.email ?? '', role: u.role, ...(iat ? { iat } : {}) };
    return `accessToken=${jwt.sign(payload, config.jwt.secret, { expiresIn: '1h' })}`;
}

async function call(method: string, path: string, cookie?: string, body?: unknown) {
    const res = await fetch(`${base}${path}`, {
        method,
        headers: {
            ...(cookie ? { Cookie: cookie } : {}),
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) as any };
}

function dayOffset(n: number): Date {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() + n);
    return d;
}

// txids no formato Sicoob (26–35 alfanuméricos).
const TX_ATIVA = 'TXCONTRATOATIVA00000000000001';
const TX_PAGA = 'TXCONTRATOPAGA000000000000001';
const TX_AVULSA = 'TXAVULSAATIVA0000000000000001';

describe('soft delete — conciliação e cancelamento no provedor antes de anular', () => {
    it('cancela PIX vivo e PaymentIntent aberto; cobrança já paga no provedor fica PAID', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser({ autoChargeEnabled: true, stripeCustomerId: 'cus_soft_keep' });
        touchedUsers.push(client.id);
        const contract = await mkContract(client.id, { type: 'FIXO', status: 'ACTIVE' });
        const pixAlive = await mkPayment(client.id, { contractId: contract.id, provider: 'SICOOB', providerRef: TX_ATIVA, amount: 84000, dueDate: dayOffset(20) });
        const pixPaid = await mkPayment(client.id, { contractId: contract.id, provider: 'SICOOB', providerRef: TX_PAGA, amount: 84000, dueDate: dayOffset(-1) });
        const cardOpen = await mkPayment(client.id, { contractId: contract.id, provider: 'STRIPE', providerRef: 'pi_contract_open', amount: 84000, dueDate: dayOffset(50) });
        const standalonePix = await mkPayment(client.id, { provider: 'SICOOB', providerRef: TX_AVULSA, amount: 5000 });
        const standaloneCard = await mkPayment(client.id, { provider: 'STRIPE', providerRef: 'pi_standalone_open', amount: 7000 });

        getCob.mockImplementation(async (txid: string) => (txid === TX_PAGA
            ? { status: 'CONCLUIDA', valor: { original: '840.00' }, pix: [{ valor: '840.00' }] }
            : { status: 'ATIVA', valor: { original: '840.00' }, calendario: { criacao: new Date().toISOString(), expiracao: 3600 } }) as any);
        getPI.mockImplementation(async (id: string) => ({ id, status: 'requires_payment_method', amount: 84000, created: Math.floor(Date.now() / 1000), metadata: {} }) as any);

        const del = await call('DELETE', `/api/users/${client.id}`, cookieFor(admin));
        expect(del.status).toBe(200);
        expect(del.body.softDeleted).toBe(true);
        expect(del.body.paidDuringDeletion).toEqual({ payments: 1, amount: 84000 });
        expect(del.body.message).toContain('Atenção: 1 pagamento(s) (R$ 840,00)');
        expect(del.body.cancelled.payments).toBe(4);

        // PIX vivos removidos no Sicoob; PaymentIntents abertos cancelados no Stripe.
        expect(removeCob).toHaveBeenCalledWith(TX_ATIVA);
        expect(removeCob).toHaveBeenCalledWith(TX_AVULSA);
        expect(removeCob).not.toHaveBeenCalledWith(TX_PAGA);
        expect(cancelPI).toHaveBeenCalledWith('pi_contract_open');
        expect(cancelPI).toHaveBeenCalledWith('pi_standalone_open');

        const status = async (id: string) => (await prisma.payment.findUniqueOrThrow({ where: { id } })).status;
        expect(await status(pixPaid.id)).toBe('PAID'); // pago no provedor: respeitado, nunca anulado
        for (const p of [pixAlive, cardOpen, standalonePix, standaloneCard]) expect(await status(p.id)).toBe('CANCELLED');

        // Soft delete mantém o Customer (conciliação/estorno).
        expect(deleteCustomer).not.toHaveBeenCalled();
        expect((await prisma.user.findUniqueOrThrow({ where: { id: client.id } })).stripeCustomerId).toBe('cus_soft_keep');
        const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityType: 'USER', entityId: client.id, action: 'SOFT_DELETED' } });
        expect(audit.changes ?? '').toContain('paidDuringDeletion');
    });

    it('pagamento em processamento no provedor → 409 e NADA muda (cliente, cobrança automática, contrato, sessão)', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser({ autoChargeEnabled: true });
        touchedUsers.push(client.id);
        const contract = await mkContract(client.id, { type: 'FIXO', status: 'ACTIVE' });
        const card = await mkPayment(client.id, { contractId: contract.id, provider: 'STRIPE', providerRef: 'pi_processing', amount: 84000 });
        const future = await mkBooking(client.id, contract.id, { date: dayOffset(5), status: 'CONFIRMED' });
        getPI.mockResolvedValue({ id: 'pi_processing', status: 'processing', amount: 84000, created: Math.floor(Date.now() / 1000), metadata: {} } as any);

        const session = cookieFor(client);
        const del = await call('DELETE', `/api/users/${client.id}`, cookieFor(admin));
        expect(del.status).toBe(409);
        expect(del.body.error).toContain('em processamento no provedor');
        expect(cancelPI).not.toHaveBeenCalled();

        const u = await prisma.user.findUniqueOrThrow({ where: { id: client.id } });
        expect(u.deletedAt).toBeNull();
        expect(u.email).toBe(client.email);
        expect(u.autoChargeEnabled).toBe(true);
        expect((await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } })).status).toBe('ACTIVE');
        expect((await prisma.payment.findUniqueOrThrow({ where: { id: card.id } })).status).toBe('PENDING');
        expect((await prisma.booking.findUniqueOrThrow({ where: { id: future.id } })).status).toBe('CONFIRMED');
        // A exclusão não aconteceu → a revogação é desfeita e a sessão do cliente segue valendo.
        expect(await redis.get(`auth:revoked:${client.id}`)).toBeNull();
        expect((await call('GET', '/api/auth/me', session)).status).toBe(200);
    });
});

describe('revogação imediata de sessão', () => {
    it('bloquear encerra na hora o token já emitido; token emitido depois (novo login) passa', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser();
        touchedUsers.push(client.id, admin.id);
        const before = cookieFor(client);
        expect((await call('GET', '/api/auth/me', before)).status).toBe(200);

        const block = await call('PATCH', `/api/users/${client.id}`, cookieFor(admin), { clientStatus: 'BLOCKED' });
        expect(block.status).toBe(200);
        const me = await call('GET', '/api/auth/me', before);
        expect(me.status).toBe(401);
        expect(me.body.error).toBe('Sessão encerrada. Faça login novamente.');
        // O refresh também recusa enquanto bloqueado.
        const refresh = await fetch(`${base}/api/auth/refresh`, {
            method: 'POST',
            headers: { Cookie: `refreshToken=${jwt.sign({ userId: client.id, email: client.email, role: 'CLIENTE' }, config.jwt.refreshSecret, { expiresIn: '1d' })}` },
        });
        expect(refresh.status).toBe(403);

        // Desbloqueado → um token novo (iat posterior à revogação) funciona normalmente.
        expect((await call('PATCH', `/api/users/${client.id}`, cookieFor(admin), { clientStatus: 'ACTIVE' })).status).toBe(200);
        const fresh = cookieFor(client, Math.floor(Date.now() / 1000) + 2);
        expect((await call('GET', '/api/auth/me', fresh)).status).toBe(200);
        // A sessão do admin não é afetada.
        expect((await call('GET', '/api/auth/me', cookieFor(admin))).status).toBe(200);
    });
});

describe('soft delete — só cancela gravações cujo início ainda não passou (SP)', () => {
    it('mantém as de hoje já iniciadas/realizadas; cancela as de mais tarde e as dos próximos dias; a prévia bate', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser();
        touchedUsers.push(client.id);
        const contract = await mkContract(client.id, { type: 'FIXO', status: 'ACTIVE' });
        // "Agora" = 10/03/2027 15:00 em São Paulo (18:00Z).
        const now = new Date('2027-03-10T18:00:00Z');
        const today = new Date('2027-03-10T00:00:00Z');
        const doneMorning = await mkBooking(client.id, contract.id, { date: today, startTime: '10:00', endTime: '12:00', status: 'CONFIRMED' });
        const startedEarly = await mkBooking(client.id, contract.id, { date: today, startTime: '15:30', endTime: '17:30', status: 'CONFIRMED', recordingStartedAt: new Date('2027-03-10T17:55:00Z') });
        const laterToday = await mkBooking(client.id, contract.id, { date: today, startTime: '18:00', endTime: '20:00', status: 'CONFIRMED' });
        const tomorrow = await mkBooking(client.id, contract.id, { date: new Date('2027-03-11T00:00:00Z'), startTime: '10:00', endTime: '12:00', status: 'CONFIRMED' });

        const preview = await getDeletionPreview(client.id, now);
        expect(preview.pending.futureBookings).toBe(2);

        const res = await deleteUser(client.id, admin.id, now);
        expect(res.cancelled.bookings).toBe(2);
        const st = async (id: string) => (await prisma.booking.findUniqueOrThrow({ where: { id } })).status;
        expect(await st(doneMorning.id)).toBe('CONFIRMED');
        expect(await st(startedEarly.id)).toBe('CONFIRMED');
        expect(await st(laterToday.id)).toBe('CANCELLED');
        expect(await st(tomorrow.id)).toBe('CANCELLED');
    });
});

describe('hard delete — Customer do Stripe', () => {
    it('apaga o Customer (e-mail/nome) no Stripe depois do delete local', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser({ stripeCustomerId: 'cus_hard_gone' });
        touchedUsers.push(client.id);
        const del = await call('DELETE', `/api/users/${client.id}`, cookieFor(admin));
        expect(del.status).toBe(200);
        expect(del.body.softDeleted).toBe(false);
        expect(await prisma.user.findUnique({ where: { id: client.id } })).toBeNull();
        expect(deleteCustomer).toHaveBeenCalledTimes(1);
        expect(deleteCustomer).toHaveBeenCalledWith('cus_hard_gone');
        const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityType: 'USER', entityId: client.id, action: 'DELETED' } });
        expect(audit.changes ?? '').toContain('"stripeCustomerDeleted":true');
    });
});

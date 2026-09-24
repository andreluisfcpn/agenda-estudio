import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { prisma } from '../../src/lib/prisma';
import { acquireMultiSlotLock, checkLock, releaseMultiSlotLock, redis } from '../../src/lib/redis';
import { config } from '../../src/config/index';
import { getPackageSlots } from '../../src/utils/pricing';
import { hardDeleteUser } from '../../src/lib/userDeletion';
import { createNotification } from '../../src/modules/notifications/notificationService';
import userRoutes from '../../src/modules/users/routes';
import authRoutes from '../../src/modules/auth/routes';
import { mkUser, mkContract, mkPayment, mkBooking, mkCoupon } from './factories';

// D3 — exclusão de cliente: hard delete sem vínculos; soft delete + anonimização com vínculos,
// cancelando/anulando as pendências. Exercita as ROTAS reais (users + auth) num app Express mínimo.

let server: Server;
let base = '';

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

// A exclusão grava a revogação de sessão no Redis (compartilhado com o dev): limpa as dos
// clientes deste arquivo mesmo quando uma asserção falha no meio do teste.
const revokedIds: string[] = [];
afterEach(async () => {
    const keys = revokedIds.splice(0).map(id => `auth:revoked:${id}`);
    if (keys.length) await redis.del(...keys);
});

function accessCookie(u: { id: string; email: string | null; role: string }) {
    const token = jwt.sign({ userId: u.id, email: u.email ?? '', role: u.role }, config.jwt.secret, { expiresIn: '1h' });
    return `accessToken=${token}`;
}

function refreshCookie(u: { id: string; email: string | null; role: string }) {
    const token = jwt.sign({ userId: u.id, email: u.email ?? '', role: u.role }, config.jwt.refreshSecret, { expiresIn: '1d' });
    return `refreshToken=${token}`;
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
    const json = await res.json().catch(() => ({}));
    return { status: res.status, body: json as any };
}

/** Data-calendário (00:00Z) a N dias de hoje — mesmo formato de Booking.date. */
function dayOffset(n: number): Date {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() + n);
    return d;
}

const VALID_CPF = '52998224725';

describe('DELETE /api/users/:id — hard delete (nenhum vínculo de negócio)', () => {
    it('apaga fisicamente o cliente sem nada vinculado (acessórios caem junto)', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser();
        revokedIds.push(client.id);
        const coupon = await mkCoupon(admin.id);
        // Acessórios: NÃO impedem o hard delete.
        await prisma.notification.create({ data: { userId: client.id, type: 'SYSTEM', title: 't', message: 'm' } });
        await prisma.pushSubscription.create({ data: { userId: client.id, endpoint: `https://push.test/${client.id}`, p256dh: 'k', auth: 'a' } });
        await prisma.savedPaymentMethod.create({ data: { userId: client.id, stripePaymentMethodId: `pm_test_${client.id}`, brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030 } });
        await prisma.couponEligibleUser.create({ data: { couponId: coupon.id, userId: client.id } });

        const preview = await call('GET', `/api/users/${client.id}/deletion-preview`, accessCookie(admin));
        expect(preview.status).toBe(200);
        expect(preview.body.preview.mode).toBe('hard');
        expect(preview.body.preview.links).toEqual({ contracts: 0, bookings: 0, payments: 0, couponRedemptions: 0, blockedSlots: 0 });
        expect(preview.body.preview.accessories).toMatchObject({ savedCards: 1, pushSubscriptions: 1, notifications: 1, couponEligibilities: 1 });

        const del = await call('DELETE', `/api/users/${client.id}`, accessCookie(admin));
        expect(del.status).toBe(200);
        expect(del.body).toMatchObject({ softDeleted: false, cancelled: { contracts: 0, bookings: 0, payments: 0 } });
        expect(del.body.message).toBe('Cliente excluído definitivamente.');

        expect(await prisma.user.findUnique({ where: { id: client.id } })).toBeNull();
        expect(await prisma.notification.count({ where: { userId: client.id } })).toBe(0);
        expect(await prisma.savedPaymentMethod.count({ where: { userId: client.id } })).toBe(0);
        expect(await prisma.auditLog.count({ where: { entityType: 'USER', entityId: client.id, action: 'DELETED' } })).toBe(1);
    });

    it('um vínculo RESTRICT faz o delete físico falhar com P2003 (base do fallback para o soft)', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser();
        await mkPayment(client.id, { status: 'PAID', paidAt: new Date() });
        await expect(hardDeleteUser(client.id, admin.id)).rejects.toMatchObject({ code: 'P2003' });
        expect(await prisma.user.findUnique({ where: { id: client.id } })).not.toBeNull();
    });
});

describe('DELETE /api/users/:id — recusas', () => {
    it('recusa auto-exclusão, conta ADMIN e usuário inexistente', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const otherAdmin = await mkUser({ role: 'ADMIN' });

        const self = await call('DELETE', `/api/users/${admin.id}`, accessCookie(admin));
        expect(self.status).toBe(400);
        const adm = await call('DELETE', `/api/users/${otherAdmin.id}`, accessCookie(admin));
        expect(adm.status).toBe(400);
        const pv = await call('GET', `/api/users/${otherAdmin.id}/deletion-preview`, accessCookie(admin));
        expect(pv.status).toBe(400);
        const missing = await call('DELETE', '/api/users/00000000-0000-0000-0000-000000000000', accessCookie(admin));
        expect(missing.status).toBe(404);
        expect(await prisma.user.count({ where: { role: 'ADMIN' } })).toBe(2);
    });
});

describe('DELETE /api/users/:id — soft delete com histórico e pendências', () => {
    it('cancela/anula pendências, anonimiza, preserva o PAID, libera e-mail/CPF e bloqueia o acesso', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const passwordHash = await bcrypt.hash('segredo123', 4);
        const client = await mkUser({
            email: 'excluir-me@example.com',
            passwordHash,
            googleId: 'google-sub-excluir',
            cpfCnpj: VALID_CPF,
            phone: '22999990000',
            address: 'Rua das Pedras',
            addressNumber: '10',
            complement: 'Casa',
            neighborhood: 'Centro',
            city: 'Búzios',
            state: 'RJ',
            zipCode: '28950-000',
            photoUrl: 'data:image/jpeg;base64,AAAA',
            socialLinks: '{"instagram":"@x"}',
            notes: 'observação interna',
            tags: ['vip'],
            stripeCustomerId: 'cus_test_excluir',
            autoChargeEnabled: true,
        });
        revokedIds.push(client.id);

        // Contrato ativo: 1 parcela PAGA (histórico) + 1 PENDENTE; gravação passada concluída,
        // 1 futura CONFIRMED e 1 futura RESERVED segurando trava no Redis.
        const active = await mkContract(client.id, { type: 'FIXO', status: 'ACTIVE' });
        const paid = await mkPayment(client.id, { contractId: active.id, status: 'PAID', paidAt: new Date(), amount: 84000 });
        const installment = await mkPayment(client.id, { contractId: active.id, status: 'PENDING', dueDate: dayOffset(20) });
        const past = await mkBooking(client.id, active.id, { date: dayOffset(-7), status: 'COMPLETED' });
        const futureConfirmed = await mkBooking(client.id, active.id, { date: dayOffset(5), startTime: '06:30', endTime: '08:30', status: 'CONFIRMED' });
        const lockDate = dayOffset(6).toISOString().slice(0, 10);
        const futureReserved = await mkBooking(client.id, active.id, { date: dayOffset(6), startTime: '06:30', endTime: '08:30', status: 'RESERVED' });
        expect(await acquireMultiSlotLock(lockDate, getPackageSlots('06:30'), client.id)).toBe(true);

        // Contrato já concluído com uma parcela ainda PENDING (sobra) — anulada, contrato fica COMPLETED.
        const completed = await mkContract(client.id, { type: 'AVULSO', durationMonths: 1, status: 'COMPLETED' });
        const leftover = await mkPayment(client.id, { contractId: completed.id, status: 'PENDING' });
        // Falta justificada com janela de remarcação aberta → encerrada.
        const missed = await mkBooking(client.id, completed.id, {
            date: dayOffset(-2), status: 'FALTA', makeupStatus: 'OPEN', makeupDeadline: new Date(Date.now() + 5 * 86_400_000), missedDate: dayOffset(-2),
        });

        // Cobrança avulsa (sem contrato) PENDING com cupom RESERVADO → anulada e uso devolvido.
        const coupon = await mkCoupon(admin.id, { usedCount: 2 });
        const standalone = await mkPayment(client.id, { status: 'PENDING', amount: 5000, couponId: coupon.id });
        await prisma.couponRedemption.create({ data: { couponId: coupon.id, userId: client.id, paymentId: standalone.id, status: 'RESERVED', originalAmount: 5500, discountAmount: 500 } });
        await prisma.couponRedemption.create({ data: { couponId: coupon.id, userId: client.id, paymentId: paid.id, status: 'CONFIRMED', originalAmount: 90000, discountAmount: 6000, confirmedAt: new Date() } });

        // Acessórios.
        await prisma.notification.create({ data: { userId: client.id, type: 'SYSTEM', title: 't', message: 'm' } });
        await prisma.pushSubscription.create({ data: { userId: client.id, endpoint: `https://push.test/${client.id}`, p256dh: 'k', auth: 'a' } });
        await prisma.savedPaymentMethod.create({ data: { userId: client.id, stripePaymentMethodId: `pm_test_${client.id}`, brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030 } });

        // Sessão do cliente aberta ANTES da exclusão (cenário real do token residual).
        const clientIdentity = { id: client.id, email: 'excluir-me@example.com', role: 'CLIENTE' };
        const residual = accessCookie(clientIdentity);
        expect((await call('GET', '/api/auth/me', residual)).status).toBe(200);

        try {
            // ── Prévia: consequências reais ──
            const pv = await call('GET', `/api/users/${client.id}/deletion-preview`, accessCookie(admin));
            expect(pv.status).toBe(200);
            expect(pv.body.preview).toMatchObject({
                mode: 'soft',
                links: { contracts: 2, bookings: 4, payments: 4, couponRedemptions: 2, blockedSlots: 0 },
                pending: { activeContracts: 1, futureBookings: 2, pendingPayments: 3 },
                preserved: { paidPayments: 1, paidAmount: 84000 },
                accessories: { savedCards: 1, pushSubscriptions: 1, notifications: 1, autoChargeEnabled: true },
            });

            // ── Exclusão ──
            const del = await call('DELETE', `/api/users/${client.id}`, accessCookie(admin));
            expect(del.status).toBe(200);
            expect(del.body).toMatchObject({ softDeleted: true, cancelled: { contracts: 1, bookings: 2, payments: 3 }, paidDuringDeletion: { payments: 0, amount: 0 } });

            // Anonimização (nome e stripeCustomerId ficam).
            const u = await prisma.user.findUniqueOrThrow({ where: { id: client.id } });
            expect(u.deletedAt).toBeInstanceOf(Date);
            expect(u.name).toBe(client.name);
            expect(u.stripeCustomerId).toBe('cus_test_excluir');
            expect(u.autoChargeEnabled).toBe(false);
            expect(u.tags).toEqual([]);
            for (const f of ['email', 'googleId', 'passwordHash', 'cpfCnpj', 'phone', 'address', 'addressNumber', 'complement', 'neighborhood', 'city', 'state', 'zipCode', 'photoUrl', 'socialLinks', 'notes'] as const) {
                expect(u[f], f).toBeNull();
            }

            // Contratos: o ativo cancelado; o concluído continua concluído.
            expect((await prisma.contract.findUniqueOrThrow({ where: { id: active.id } })).status).toBe('CANCELLED');
            expect((await prisma.contract.findUniqueOrThrow({ where: { id: completed.id } })).status).toBe('COMPLETED');

            // Pagamentos: PAID intacto; todos os PENDING anulados.
            const paidAfter = await prisma.payment.findUniqueOrThrow({ where: { id: paid.id } });
            expect(paidAfter.status).toBe('PAID');
            expect(paidAfter.amount).toBe(84000);
            for (const p of [installment, leftover, standalone]) {
                expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('CANCELLED');
            }

            // Cupom: reserva da avulsa devolvida; uso confirmado intacto.
            expect((await prisma.couponRedemption.findUniqueOrThrow({ where: { paymentId: standalone.id } })).status).toBe('RELEASED');
            expect((await prisma.couponRedemption.findUniqueOrThrow({ where: { paymentId: paid.id } })).status).toBe('CONFIRMED');
            expect((await prisma.coupon.findUniqueOrThrow({ where: { id: coupon.id } })).usedCount).toBe(1);

            // Agendamentos: passado intacto; futuros cancelados; trava liberada; remarcação encerrada.
            expect((await prisma.booking.findUniqueOrThrow({ where: { id: past.id } })).status).toBe('COMPLETED');
            expect((await prisma.booking.findUniqueOrThrow({ where: { id: futureConfirmed.id } })).status).toBe('CANCELLED');
            expect((await prisma.booking.findUniqueOrThrow({ where: { id: futureReserved.id } })).status).toBe('CANCELLED');
            expect(await checkLock(lockDate, '06:30')).toBeNull();
            expect((await prisma.booking.findUniqueOrThrow({ where: { id: missed.id } })).makeupStatus).toBe('EXPIRED');

            // Acessórios apagados.
            expect(await prisma.notification.count({ where: { userId: client.id } })).toBe(0);
            expect(await prisma.pushSubscription.count({ where: { userId: client.id } })).toBe(0);
            expect(await prisma.savedPaymentMethod.count({ where: { userId: client.id } })).toBe(0);

            // Auditoria sem PII.
            const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityType: 'USER', entityId: client.id, action: 'SOFT_DELETED' } });
            expect(audit.performedBy).toBe(admin.id);
            expect(audit.changes ?? '').not.toContain('excluir-me@example.com');
            expect(audit.changes ?? '').not.toContain(VALID_CPF);

            // Some da listagem; o perfil histórico continua acessível com deletedAt.
            const list = await call('GET', '/api/users', accessCookie(admin));
            expect(list.status).toBe(200);
            expect(list.body.users.some((x: { id: string }) => x.id === client.id)).toBe(false);
            const detail = await call('GET', `/api/users/${client.id}`, accessCookie(admin));
            expect(detail.status).toBe(200);
            expect(detail.body.user.deletedAt).toBeTruthy();
            expect(detail.body.user.email).toBeNull();

            // Cadastro excluído não pode ser alterado nem excluído de novo.
            expect((await call('PATCH', `/api/users/${client.id}`, accessCookie(admin), { name: 'Outro Nome' })).status).toBe(409);
            expect((await call('PATCH', `/api/users/${client.id}/auto-charge`, accessCookie(admin), { enabled: false })).status).toBe(409);
            expect((await call('DELETE', `/api/users/${client.id}`, accessCookie(admin))).status).toBe(409);
            expect((await call('GET', `/api/users/${client.id}/deletion-preview`, accessCookie(admin))).status).toBe(409);

            // Acesso bloqueado: senha, refresh e sessão residual.
            const login = await call('POST', '/api/auth/login', undefined, { email: 'excluir-me@example.com', password: 'segredo123' });
            expect(login.status).toBe(401);
            const refresh = await call('POST', '/api/auth/refresh', refreshCookie(clientIdentity));
            expect(refresh.status).toBe(401);
            expect(refresh.body.error).toBe('Conta não encontrada.');
            // Revogação imediata: o token emitido antes da exclusão é recusado já no authenticate
            // (inclusive nas rotas de reserva/pagamento, que não consultam deletedAt).
            const meRevoked = await call('GET', '/api/auth/me', residual);
            expect(meRevoked.status).toBe(401);
            expect(meRevoked.body.error).toBe('Sessão encerrada. Faça login novamente.');
            expect((await call('PATCH', '/api/auth/profile', residual, { cpfCnpj: VALID_CPF })).status).toBe(401);
            // Rede de segurança se a revogação faltar (Redis fora → fail-open): as rotas de perfil recusam a conta excluída.
            await redis.del(`auth:revoked:${client.id}`);
            expect((await call('GET', '/api/auth/me', residual)).status).toBe(404);
            expect((await call('PATCH', '/api/auth/profile', residual, { cpfCnpj: VALID_CPF })).status).toBe(404);
            expect((await prisma.user.findUniqueOrThrow({ where: { id: client.id } })).cpfCnpj).toBeNull();

            // Nenhuma notificação nova para a conta excluída (rede de segurança).
            expect(await createNotification({ userId: client.id, type: 'SYSTEM', severity: 'critical', title: 'x', message: 'y' })).toBe('');
            expect(await prisma.notification.count({ where: { userId: client.id } })).toBe(0);

            // E-mail e CPF livres para um novo cadastro.
            const again = await call('POST', '/api/users', accessCookie(admin), {
                email: 'excluir-me@example.com', password: 'nova-senha', name: 'Pessoa Nova', cpfCnpj: VALID_CPF,
            });
            expect(again.status).toBe(201);
            expect(again.body.user.id).not.toBe(client.id);
        } finally {
            await releaseMultiSlotLock(lockDate, getPackageSlots('06:30'), client.id);
        }
    });
});

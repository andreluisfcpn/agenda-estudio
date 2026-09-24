import { describe, it, expect } from 'vitest';
import { prisma } from '../../src/lib/prisma';
import { onPaymentConfirmed, activateAwaitingContract } from '../../src/lib/paymentEffects';
import { cleanExpiredHolds, purgeAwaitingContract } from '../../src/jobs/cleanExpiredHolds';
import { mkUser, mkContract, mkPayment, mkBooking } from './factories';

const past = () => new Date(Date.now() - 5 * 60 * 1000);
const future = () => new Date(Date.now() + 10 * 60 * 1000);

/** n sessões semanais a partir de uma data (UTC), todas no mesmo horário. */
async function mkWeeklySessions(userId: string, contractId: string, n: number, opts: { status?: 'RESERVED' | 'HELD'; holdExpiresAt?: Date | null } = {}) {
    const start = Date.parse('2026-10-05T00:00:00Z');
    for (let i = 0; i < n; i++) {
        await mkBooking(userId, contractId, {
            date: new Date(start + i * 7 * 24 * 60 * 60 * 1000),
            status: opts.status ?? 'RESERVED',
            holdExpiresAt: opts.holdExpiresAt ?? null,
        });
    }
}

async function markPaidAndConfirm(paymentId: string) {
    await prisma.payment.update({ where: { id: paymentId }, data: { status: 'PAID', paidAt: new Date() } });
    await onPaymentConfirmed(paymentId);
}

describe('D9 — ativação do personalizado do cliente promove as sessões reservadas', () => {
    it('accessMode FULL: todas as sessões RESERVED/HELD viram CONFIRMED (sem timer)', async () => {
        const u = await mkUser();
        const c = await mkContract(u.id, { type: 'CUSTOM', status: 'AWAITING_PAYMENT', paymentDeadline: future(), accessMode: 'FULL', durationMonths: 2 });
        await mkWeeklySessions(u.id, c.id, 6, { holdExpiresAt: future() });
        await mkBooking(u.id, c.id, { date: new Date('2026-11-20T00:00:00Z'), status: 'HELD', holdExpiresAt: future() });
        const p1 = await mkPayment(u.id, { contractId: c.id, dueDate: new Date('2026-10-05T00:00:00Z') });
        await mkPayment(u.id, { contractId: c.id, dueDate: new Date('2026-11-02T00:00:00Z') });

        await markPaidAndConfirm(p1.id);

        expect((await prisma.contract.findUnique({ where: { id: c.id } }))?.status).toBe('ACTIVE');
        expect(await prisma.booking.count({ where: { contractId: c.id, status: 'CONFIRMED', holdExpiresAt: null } })).toBe(7);
        expect(await prisma.booking.count({ where: { contractId: c.id, status: { in: ['RESERVED', 'HELD'] } } })).toBe(0);
    });

    it('accessMode PROGRESSIVE: só o 1º ciclo na ativação; a 2ª parcela libera o 2º (nunca 2 ciclos com 1 parcela)', async () => {
        const u = await mkUser();
        const c = await mkContract(u.id, { type: 'CUSTOM', status: 'AWAITING_PAYMENT', paymentDeadline: future(), accessMode: 'PROGRESSIVE', durationMonths: 3 });
        await mkWeeklySessions(u.id, c.id, 12, { holdExpiresAt: future() });
        const p1 = await mkPayment(u.id, { contractId: c.id, dueDate: new Date('2026-10-05T00:00:00Z') });
        const p2 = await mkPayment(u.id, { contractId: c.id, dueDate: new Date('2026-11-02T00:00:00Z') });
        await mkPayment(u.id, { contractId: c.id, dueDate: new Date('2026-11-30T00:00:00Z') });

        await markPaidAndConfirm(p1.id);
        expect((await prisma.contract.findUnique({ where: { id: c.id } }))?.status).toBe('ACTIVE');
        expect(await prisma.booking.count({ where: { contractId: c.id, status: 'CONFIRMED' } })).toBe(4);
        // Ciclos seguintes seguem travados, mas SEM o timer de espera (a varredura não os cancela).
        expect(await prisma.booking.count({ where: { contractId: c.id, status: 'RESERVED', holdExpiresAt: null } })).toBe(8);

        await markPaidAndConfirm(p2.id);
        expect(await prisma.booking.count({ where: { contractId: c.id, status: 'CONFIRMED' } })).toBe(8);
    });

    it('activateAwaitingContract é idempotente e não mexe em contrato já ativo', async () => {
        const u = await mkUser();
        const c = await mkContract(u.id, { type: 'CUSTOM', status: 'ACTIVE', accessMode: 'FULL' });
        await mkWeeklySessions(u.id, c.id, 2);
        const r = await activateAwaitingContract(c.id);
        expect(r).toEqual({ activated: false, promoted: 0, unlockedCycle: false });
        expect(await prisma.booking.count({ where: { contractId: c.id, status: 'RESERVED' } })).toBe(2);
    });
});

describe('Varredura segura de contratos aguardando pagamento (D2/D9)', () => {
    it('purgeAwaitingContract: sem pagamento e sem cobrança no provedor → apaga contrato, parcelas e sessões', async () => {
        const u = await mkUser();
        const c = await mkContract(u.id, { type: 'SERVICO', status: 'AWAITING_PAYMENT', paymentDeadline: past(), addOns: ['GESTAO_TRAFEGO'] });
        await mkPayment(u.id, { contractId: c.id, provider: 'SICOOB' }); // sem providerRef
        await mkPayment(u.id, { contractId: c.id, provider: 'STRIPE', providerRef: 'pi_mock_abc' });

        expect(await purgeAwaitingContract(c.id)).toBe('purged');
        expect(await prisma.contract.findUnique({ where: { id: c.id } })).toBeNull();
        expect(await prisma.payment.count({ where: { contractId: c.id } })).toBe(0);
    });

    it('purgeAwaitingContract: com PAID → promove (FULL) em vez de apagar', async () => {
        const u = await mkUser();
        const c = await mkContract(u.id, { type: 'CUSTOM', status: 'AWAITING_PAYMENT', paymentDeadline: past(), accessMode: 'FULL' });
        await mkWeeklySessions(u.id, c.id, 3, { holdExpiresAt: past() });
        await mkPayment(u.id, { contractId: c.id, status: 'PAID', paidAt: new Date() });

        expect(await purgeAwaitingContract(c.id)).toBe('paid');
        expect((await prisma.contract.findUnique({ where: { id: c.id } }))?.status).toBe('ACTIVE');
        expect(await prisma.booking.count({ where: { contractId: c.id, status: 'CONFIRMED' } })).toBe(3);
    });

    it('purgeAwaitingContract: ignora contrato que não está aguardando pagamento', async () => {
        const u = await mkUser();
        const c = await mkContract(u.id, { status: 'ACTIVE' });
        expect(await purgeAwaitingContract(c.id)).toBe('skipped');
        expect(await prisma.contract.findUnique({ where: { id: c.id } })).not.toBeNull();
    });

    it('cleanExpiredHolds: personalizado do cliente vencido é apagado INTEIRO pela seção de órfãos (sessões não são tratadas uma a uma)', async () => {
        const u = await mkUser();
        const c = await mkContract(u.id, {
            type: 'CUSTOM', status: 'AWAITING_PAYMENT', paymentDeadline: past(), accessMode: 'FULL', customCreditsRemaining: 0,
        });
        await mkWeeklySessions(u.id, c.id, 4, { holdExpiresAt: past() });
        await mkPayment(u.id, { contractId: c.id });
        await mkPayment(u.id, { contractId: c.id });

        await cleanExpiredHolds();

        expect(await prisma.contract.findUnique({ where: { id: c.id } })).toBeNull();
        expect(await prisma.booking.count({ where: { contractId: c.id } })).toBe(0);
        expect(await prisma.payment.count({ where: { contractId: c.id } })).toBe(0);
    });

    it('cleanExpiredHolds: personalizado ainda no prazo NÃO é tocado mesmo com timer de sessão vencido', async () => {
        const u = await mkUser();
        const c = await mkContract(u.id, {
            type: 'CUSTOM', status: 'AWAITING_PAYMENT', paymentDeadline: future(), accessMode: 'FULL', customCreditsRemaining: 0,
        });
        await mkWeeklySessions(u.id, c.id, 2, { holdExpiresAt: past() });

        await cleanExpiredHolds();

        expect((await prisma.contract.findUnique({ where: { id: c.id } }))?.customCreditsRemaining).toBe(0);
        expect(await prisma.booking.count({ where: { contractId: c.id, status: 'RESERVED' } })).toBe(2);
    });

    it('cleanExpiredHolds: avulso abandonado continua sendo apagado (sem cobrança no provedor)', async () => {
        const u = await mkUser();
        const c = await mkContract(u.id, { type: 'AVULSO', status: 'AWAITING_PAYMENT', paymentDeadline: past(), durationMonths: 1 });
        const b = await mkBooking(u.id, c.id, { status: 'RESERVED', holdExpiresAt: past() });
        await mkPayment(u.id, { contractId: c.id, bookingId: b.id, provider: 'SICOOB', providerRef: 'mock-abcdef12' });

        await cleanExpiredHolds();

        expect(await prisma.contract.findUnique({ where: { id: c.id } })).toBeNull();
        expect(await prisma.payment.count({ where: { contractId: c.id } })).toBe(0);
    });
});

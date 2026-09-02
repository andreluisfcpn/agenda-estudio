import { describe, it, expect } from 'vitest';
import { prisma } from '../../src/lib/prisma';
import { onPaymentConfirmed } from '../../src/lib/paymentEffects';
import { mkUser, mkContract, mkPayment } from './factories';

describe('Atomic PENDING→PAID guard — no double confirmation (money-critical)', () => {
    it('concurrent updateMany confirmations: exactly one flips the row', async () => {
        const u = await mkUser();
        const c = await mkContract(u.id);
        const pay = await mkPayment(u.id, { contractId: c.id, status: 'PENDING' });

        // Simulate a webhook + the reconcile sweep + the auto-charge all racing to confirm.
        const results = await Promise.all(
            Array.from({ length: 6 }, () =>
                prisma.payment.updateMany({
                    where: { id: pay.id, status: 'PENDING' },
                    data: { status: 'PAID', paidAt: new Date() },
                }),
            ),
        );
        const winners = results.filter(r => r.count === 1).length;
        expect(winners).toBe(1); // only ONE update sees status=PENDING; effects would run once
        expect((await prisma.payment.findUnique({ where: { id: pay.id } }))?.status).toBe('PAID');
    });
});

describe('onPaymentConfirmed — guarded effects', () => {
    it('is a no-op for a payment that is not PAID (defense in depth)', async () => {
        const u = await mkUser();
        const c = await mkContract(u.id, { status: 'AWAITING_PAYMENT', durationMonths: 3, paymentPlan: 'MONTHLY' });
        const pay = await mkPayment(u.id, { contractId: c.id, status: 'PENDING' });

        await onPaymentConfirmed(pay.id); // still PENDING → must not activate or generate anything

        expect((await prisma.contract.findUnique({ where: { id: c.id } }))?.status).toBe('AWAITING_PAYMENT');
        expect(await prisma.payment.count({ where: { contractId: c.id, status: 'PENDING' } })).toBe(1);
    });

    it('activates an AWAITING_PAYMENT contract and generates installments once (idempotent)', async () => {
        const u = await mkUser();
        const c = await mkContract(u.id, { status: 'AWAITING_PAYMENT', type: 'FLEX', durationMonths: 3, paymentPlan: 'MONTHLY' });
        const pay = await mkPayment(u.id, { contractId: c.id, amount: 84000, status: 'PAID', paidAt: new Date(), dueDate: new Date('2026-09-15T00:00:00Z') });

        await onPaymentConfirmed(pay.id);
        await onPaymentConfirmed(pay.id); // second call must not double-generate

        expect((await prisma.contract.findUnique({ where: { id: c.id } }))?.status).toBe('ACTIVE');
        // 1 paid + 2 generated installments (months 2..3), never doubled
        expect(await prisma.payment.count({ where: { contractId: c.id } })).toBe(3);
        expect(await prisma.payment.count({ where: { contractId: c.id, status: 'PENDING' } })).toBe(2);
    });
});

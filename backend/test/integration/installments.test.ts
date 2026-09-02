import { describe, it, expect } from 'vitest';
import { prisma } from '../../src/lib/prisma';
import { generateRemainingInstallments } from '../../src/lib/paymentEffects';
import { addBillingCycles } from '../../src/utils/pricing';
import { mkUser, mkContract, mkPayment } from './factories';

const START = new Date('2026-09-15T00:00:00Z');
const iso = (d: Date) => d.toISOString().slice(0, 10);

async function paidFirst(userId: string, contractId: string, amount = 84000) {
    return mkPayment(userId, { contractId, amount, status: 'PAID', paidAt: new Date(), dueDate: START });
}

describe('generateRemainingInstallments — cadence + idempotency (C7/C10)', () => {
    it('materializes months 2..N on the 28-day cadence with the first payment amount', async () => {
        const u = await mkUser();
        const c = await mkContract(u.id, { type: 'FLEX', durationMonths: 3, startDate: START, paymentPlan: 'MONTHLY' });
        await paidFirst(u.id, c.id, 84000);

        await generateRemainingInstallments(c.id);

        const pend = await prisma.payment.findMany({
            where: { contractId: c.id, status: 'PENDING' },
            orderBy: { dueDate: 'asc' },
        });
        expect(pend).toHaveLength(2); // months 2 and 3
        expect(pend.every(p => p.amount === 84000)).toBe(true);
        expect(iso(pend[0].dueDate!)).toBe(iso(addBillingCycles(START, 1))); // 2026-10-13
        expect(iso(pend[1].dueDate!)).toBe(iso(addBillingCycles(START, 2))); // 2026-11-10
    });

    it('is idempotent — a second call generates nothing (installments already exist)', async () => {
        const u = await mkUser();
        const c = await mkContract(u.id, { type: 'FLEX', durationMonths: 3, startDate: START });
        await paidFirst(u.id, c.id);

        await generateRemainingInstallments(c.id);
        await generateRemainingInstallments(c.id); // second call
        await generateRemainingInstallments(c.id); // third for good measure

        expect(await prisma.payment.count({ where: { contractId: c.id } })).toBe(3); // 1 paid + 2 pending, never 5/7
    });

    it('does nothing for a FULL (à-vista) plan', async () => {
        const u = await mkUser();
        const c = await mkContract(u.id, { type: 'FLEX', durationMonths: 3, paymentPlan: 'FULL' });
        await paidFirst(u.id, c.id);
        await generateRemainingInstallments(c.id);
        expect(await prisma.payment.count({ where: { contractId: c.id, status: 'PENDING' } })).toBe(0);
    });

    it('does nothing for an AVULSO contract', async () => {
        const u = await mkUser();
        const c = await mkContract(u.id, { type: 'AVULSO', durationMonths: 1 });
        await paidFirst(u.id, c.id);
        await generateRemainingInstallments(c.id);
        expect(await prisma.payment.count({ where: { contractId: c.id, status: 'PENDING' } })).toBe(0);
    });
});

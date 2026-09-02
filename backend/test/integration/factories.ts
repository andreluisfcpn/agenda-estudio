import { prisma } from '../../src/lib/prisma';
import type { Prisma } from '../../src/generated/prisma/client';

// Monotonic counter for unique-but-deterministic values (no Math.random needed —
// the DB is truncated before each test, so cross-test collisions can't happen).
let seq = 0;
const uniq = () => `${Date.now().toString(36)}-${++seq}`;

export async function mkUser(overrides: Partial<Prisma.UserUncheckedCreateInput> = {}) {
    const n = uniq();
    return prisma.user.create({
        data: {
            name: `Test User ${n}`,
            email: `itest-${n}@example.com`,
            ...overrides,
        },
    });
}

export async function mkContract(userId: string, overrides: Partial<Prisma.ContractUncheckedCreateInput> = {}) {
    return prisma.contract.create({
        data: {
            name: `Test Contract ${uniq()}`,
            userId,
            type: 'FLEX',
            tier: 'COMERCIAL',
            durationMonths: 3,
            discountPct: 30,
            startDate: new Date('2026-09-15T00:00:00Z'),
            endDate: new Date('2026-12-15T00:00:00Z'),
            status: 'ACTIVE',
            paymentPlan: 'MONTHLY',
            addOns: [],
            ...overrides,
        },
    });
}

export async function mkPayment(userId: string, overrides: Partial<Prisma.PaymentUncheckedCreateInput> = {}) {
    return prisma.payment.create({
        data: {
            userId,
            provider: 'SICOOB',
            amount: 84000,
            status: 'PENDING',
            ...overrides,
        },
    });
}

export async function mkBooking(userId: string, contractId: string, overrides: Partial<Prisma.BookingUncheckedCreateInput> = {}) {
    return prisma.booking.create({
        data: {
            userId,
            contractId,
            date: new Date('2026-09-15T00:00:00Z'),
            startTime: '14:00',
            endTime: '16:00',
            status: 'CONFIRMED',
            tierApplied: 'COMERCIAL',
            price: 30000,
            addOns: [],
            ...overrides,
        },
    });
}

export async function mkCoupon(createdBy: string, overrides: Partial<Prisma.CouponUncheckedCreateInput> = {}) {
    return prisma.coupon.create({
        data: {
            code: `ITEST${uniq().toUpperCase().replace(/[^A-Z0-9]/g, '')}`,
            discountType: 'PERCENTUAL',
            discountValue: 10,
            createdBy,
            ...overrides,
        },
    });
}

export async function mkBlockedSlot(createdBy: string, overrides: Partial<Prisma.BlockedSlotUncheckedCreateInput> = {}) {
    return prisma.blockedSlot.create({
        data: {
            date: new Date('2026-09-15T00:00:00Z'),
            startTime: '14:00',
            endTime: '16:00',
            createdBy,
            ...overrides,
        },
    });
}

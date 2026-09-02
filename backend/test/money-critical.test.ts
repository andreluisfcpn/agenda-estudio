import { describe, it, expect } from 'vitest';
import { isSicoobCobPaid, isSicoobCobCancelled } from '../src/lib/sicoobReconciliation';
import {
    applyDiscount,
    calculateEndTime,
    getPackageSlots,
    addBillingCycles,
    addMonths,
    BILLING_CYCLE_DAYS,
} from '../src/utils/pricing';

// ─────────────────────────────────────────────────────────────────────────────
// Foundation of the T1 recommendation: pure, CI-safe (no DB / gateway / network)
// unit tests over the money- and safety-critical predicates the audit touched.
// The integration suite (webhook idempotency, contract lifecycle, booking
// concurrency) still needs a test DB + gateway mocks — see auditoria-2026-09.md.
// ─────────────────────────────────────────────────────────────────────────────

describe('Sicoob reconciliation predicates (P1/P6 safety net)', () => {
    // The single guarantee that keeps a valid, unpaid PIX from being wrongly
    // confirmed OR wrongly failed: a charge is only PAID when CONCLUIDA (or fully
    // covered) and only CANCELLED when its status starts with REMOVIDA.

    describe('isSicoobCobPaid', () => {
        it('true only when status is CONCLUIDA', () => {
            expect(isSicoobCobPaid({ status: 'CONCLUIDA' })).toBe(true);
            expect(isSicoobCobPaid({ status: 'concluida' })).toBe(true); // case-insensitive
        });

        it('true when the received amount covers the original (fallback)', () => {
            expect(isSicoobCobPaid({ status: 'ATIVA', valor: { original: '840.00' }, pix: [{ valor: '840.00' }] })).toBe(true);
            expect(isSicoobCobPaid({ status: 'ATIVA', valor: { original: '840.00' }, pix: [{ valor: '500.00' }, { valor: '340.00' }] })).toBe(true);
        });

        it('false for an ATIVA charge with no/partial payment — never confirm a still-open charge', () => {
            expect(isSicoobCobPaid({ status: 'ATIVA' })).toBe(false);
            expect(isSicoobCobPaid({ status: 'ATIVA', valor: { original: '840.00' }, pix: [{ valor: '100.00' }] })).toBe(false);
        });

        it('false for cancelled / missing cobs', () => {
            expect(isSicoobCobPaid({ status: 'REMOVIDA_PELO_PSP' })).toBe(false);
            expect(isSicoobCobPaid(null)).toBe(false);
            expect(isSicoobCobPaid(undefined)).toBe(false);
            expect(isSicoobCobPaid({})).toBe(false);
        });
    });

    describe('isSicoobCobCancelled', () => {
        it('true only when status starts with REMOVIDA', () => {
            expect(isSicoobCobCancelled({ status: 'REMOVIDA_PELO_USUARIO_RECEBEDOR' })).toBe(true);
            expect(isSicoobCobCancelled({ status: 'REMOVIDA_PELO_PSP' })).toBe(true);
        });

        it('false for a valid ATIVA charge — the guarantee that prevents wrongful FAILED (P1/P6)', () => {
            expect(isSicoobCobCancelled({ status: 'ATIVA' })).toBe(false);
            expect(isSicoobCobCancelled({ status: 'CONCLUIDA' })).toBe(false);
            expect(isSicoobCobCancelled(null)).toBe(false);
            expect(isSicoobCobCancelled({})).toBe(false);
        });
    });

    it('a valid ATIVA charge is NEITHER paid NOR cancelled → stays PENDING', () => {
        const ativa = { status: 'ATIVA', valor: { original: '840.00' } };
        expect(isSicoobCobPaid(ativa)).toBe(false);
        expect(isSicoobCobCancelled(ativa)).toBe(false);
    });
});

describe('Pricing math (money correctness)', () => {
    it('applyDiscount rounds to the nearest cent', () => {
        expect(applyDiscount(30000, 30)).toBe(21000); // 30% off R$300 → R$210
        expect(applyDiscount(30000, 40)).toBe(18000); // 40% off → R$180
        expect(applyDiscount(30000, 0)).toBe(30000);  // no discount
        expect(applyDiscount(33333, 30)).toBe(23333); // 23333.1 → 23333 (rounded)
    });

    it('calculateEndTime respects the duration (B4: slot_duration_hours)', () => {
        expect(calculateEndTime('14:00')).toBe('16:00');       // default 2h
        expect(calculateEndTime('14:00', 2)).toBe('16:00');
        expect(calculateEndTime('14:00', 3)).toBe('17:00');    // non-default duration
        expect(calculateEndTime('15:30', 2)).toBe('17:30');    // half-hour start
    });

    it('getPackageSlots covers every 30-min slot for the duration (B4)', () => {
        expect(getPackageSlots('14:00', 2)).toEqual(['14:00', '14:30', '15:00', '15:30']);
        expect(getPackageSlots('14:00', 3)).toEqual(['14:00', '14:30', '15:00', '15:30', '16:00', '16:30']);
        expect(getPackageSlots('15:30')).toEqual(['15:30', '16:00', '16:30', '17:00']); // default 2h
    });
});

describe('Billing cadence (C7/C8/C10 installment due dates)', () => {
    it('addBillingCycles advances by exactly 28 days per cycle (no calendar drift)', () => {
        expect(BILLING_CYCLE_DAYS).toBe(28);
        const start = new Date('2026-09-15T00:00:00Z');
        expect(addBillingCycles(start, 1).toISOString().slice(0, 10)).toBe('2026-10-13');
        expect(addBillingCycles(start, 2).toISOString().slice(0, 10)).toBe('2026-11-10');
        expect(addBillingCycles(start, 0).toISOString().slice(0, 10)).toBe('2026-09-15');
    });

    it('addMonths advances by calendar month, clamping to the last valid day', () => {
        expect(addMonths(new Date('2026-09-15T00:00:00Z'), 1).getMonth()).toBe(9); // October (0-based)
        // Jan 31 + 1 month → Feb 28 (no overflow into March)
        const jan31 = new Date(2026, 0, 31);
        const feb = addMonths(jan31, 1);
        expect(feb.getMonth()).toBe(1);   // February
        expect(feb.getDate()).toBe(28);   // clamped
    });
});

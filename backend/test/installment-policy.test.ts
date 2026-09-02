import { describe, it, expect } from 'vitest';
import { getInstallmentPolicy } from '../src/lib/paymentPolicy';

describe('getInstallmentPolicy', () => {
  describe('AVULSO ("paid now")', () => {
    it('returns 1–12x, free in 1x', () => {
      expect(getInstallmentPolicy({ contractType: 'AVULSO' })).toEqual({
        maxInstallments: 12,
        freeUpTo: 1,
      });
    });

    it('AVULSO takes precedence over a FULL plan', () => {
      expect(
        getInstallmentPolicy({ plan: 'FULL', contractType: 'AVULSO', durationMonths: 6 }),
      ).toEqual({ maxInstallments: 12, freeUpTo: 1 });
    });

    it('AVULSO ignores durationMonths entirely', () => {
      expect(
        getInstallmentPolicy({ contractType: 'AVULSO', durationMonths: 99 }),
      ).toEqual({ maxInstallments: 12, freeUpTo: 1 });
    });
  });

  describe('FULL / à vista on a contract', () => {
    it('is free up to durationMonths, 1–12x', () => {
      expect(
        getInstallmentPolicy({ plan: 'FULL', contractType: 'FIXO', durationMonths: 6 }),
      ).toEqual({ maxInstallments: 12, freeUpTo: 6 });
    });

    it('freeUpTo equals durationMonths at the 12-month boundary', () => {
      expect(
        getInstallmentPolicy({ plan: 'FULL', durationMonths: 12 }),
      ).toEqual({ maxInstallments: 12, freeUpTo: 12 });
    });

    it('freeUpTo can exceed maxInstallments when durationMonths > 12', () => {
      // The function does NOT clamp freeUpTo to maxInstallments.
      expect(
        getInstallmentPolicy({ plan: 'FULL', durationMonths: 15 }),
      ).toEqual({ maxInstallments: 12, freeUpTo: 15 });
    });

    it('clamps freeUpTo to a floor of 1 when durationMonths is 1', () => {
      expect(
        getInstallmentPolicy({ plan: 'FULL', durationMonths: 1 }),
      ).toEqual({ maxInstallments: 12, freeUpTo: 1 });
    });

    it('durationMonths = 0 (falsy) falls back to 1', () => {
      // 0 is falsy → Math.max(1, 0 || 1) = 1
      expect(
        getInstallmentPolicy({ plan: 'FULL', durationMonths: 0 }),
      ).toEqual({ maxInstallments: 12, freeUpTo: 1 });
    });

    it('negative durationMonths clamps up to 1', () => {
      // -5 is truthy → Math.max(1, -5) = 1
      expect(
        getInstallmentPolicy({ plan: 'FULL', durationMonths: -5 }),
      ).toEqual({ maxInstallments: 12, freeUpTo: 1 });
    });

    it('null durationMonths falls back to 1', () => {
      expect(
        getInstallmentPolicy({ plan: 'FULL', durationMonths: null }),
      ).toEqual({ maxInstallments: 12, freeUpTo: 1 });
    });

    it('undefined durationMonths falls back to 1', () => {
      expect(
        getInstallmentPolicy({ plan: 'FULL' }),
      ).toEqual({ maxInstallments: 12, freeUpTo: 1 });
    });

    it('works with a CUSTOM contract type on a FULL plan', () => {
      expect(
        getInstallmentPolicy({ plan: 'FULL', contractType: 'CUSTOM', durationMonths: 3 }),
      ).toEqual({ maxInstallments: 12, freeUpTo: 3 });
    });
  });

  describe('MONTHLY installment (single 1x charge, no splitting)', () => {
    it('returns 1x only, free in 1x', () => {
      expect(
        getInstallmentPolicy({ plan: 'MONTHLY', contractType: 'FIXO', durationMonths: 6 }),
      ).toEqual({ maxInstallments: 1, freeUpTo: 1 });
    });

    it('MONTHLY never splits regardless of durationMonths', () => {
      expect(
        getInstallmentPolicy({ plan: 'MONTHLY', durationMonths: 12 }),
      ).toEqual({ maxInstallments: 1, freeUpTo: 1 });
    });
  });

  describe('fallback / neither AVULSO nor FULL', () => {
    it('empty args → monthly single-charge default', () => {
      expect(getInstallmentPolicy({})).toEqual({ maxInstallments: 1, freeUpTo: 1 });
    });

    it('null plan and null contractType → single-charge default', () => {
      expect(
        getInstallmentPolicy({ plan: null, contractType: null, durationMonths: null }),
      ).toEqual({ maxInstallments: 1, freeUpTo: 1 });
    });

    it('a non-AVULSO contractType with no FULL plan → single-charge default', () => {
      // durationMonths is ignored on this branch.
      expect(
        getInstallmentPolicy({ contractType: 'SERVICO', durationMonths: 6 }),
      ).toEqual({ maxInstallments: 1, freeUpTo: 1 });
    });

    it('FLEX contract with an unspecified plan → single-charge default', () => {
      expect(
        getInstallmentPolicy({ contractType: 'FLEX' }),
      ).toEqual({ maxInstallments: 1, freeUpTo: 1 });
    });
  });
});

import { describe, it, expect } from 'vitest';
import { computeCouponDiscount, normalizeCouponCode } from '../src/lib/couponService';

// Minimal shape accepted by computeCouponDiscount (Pick<Coupon,'discountType'|'discountValue'>).
const valor = (discountValue: number) => ({ discountType: 'VALOR' as const, discountValue });
const pct = (discountValue: number) => ({ discountType: 'PERCENTUAL' as const, discountValue });

describe('computeCouponDiscount — VALOR (fixed cents)', () => {
  it('returns the fixed value when it is below the base', () => {
    expect(computeCouponDiscount(valor(500), 1000)).toBe(500);
  });

  it('returns the full value when it exactly equals the base', () => {
    expect(computeCouponDiscount(valor(500), 500)).toBe(500);
  });

  it('clamps to the base amount when the value exceeds it (never over-discounts)', () => {
    // Math.min(1500, 1000) => 1000
    expect(computeCouponDiscount(valor(1500), 1000)).toBe(1000);
  });

  it('clamps to 0 when the base is 0', () => {
    // Math.min(500, 0) => 0
    expect(computeCouponDiscount(valor(500), 0)).toBe(0);
  });

  it('a zero-value coupon discounts nothing', () => {
    expect(computeCouponDiscount(valor(0), 1000)).toBe(0);
  });

  it('final amount (base - discount) stays >= 0 at the clamp boundary', () => {
    const base = 800;
    const d = computeCouponDiscount(valor(999999), base);
    expect(d).toBe(base);
    expect(base - d).toBe(0);
  });
});

describe('computeCouponDiscount — PERCENTUAL', () => {
  it('computes a clean percentage with no rounding needed', () => {
    // discounted = round(1000 * 0.90) = 900 ; discount = 1000 - 900 = 100
    expect(computeCouponDiscount(pct(10), 1000)).toBe(100);
  });

  it('handles a non-divisible percentage via round-half-up on the discounted amount', () => {
    // discounted = round(999 * 0.50) = round(499.5) = 500 ; discount = 999 - 500 = 499
    expect(computeCouponDiscount(pct(50), 999)).toBe(499);
  });

  it('rounds the discounted amount half-up (base 10, 25%)', () => {
    // discounted = round(10 * 0.75) = round(7.5) = 8 ; discount = 10 - 8 = 2
    expect(computeCouponDiscount(pct(25), 10)).toBe(2);
  });

  it('rounds the discounted amount half-up (base 10, 15%)', () => {
    // discounted = round(10 * 0.85) = round(8.5) = 9 ; discount = 10 - 9 = 1
    expect(computeCouponDiscount(pct(15), 10)).toBe(1);
  });

  it('another non-trivial rounding case (base 333, 15%)', () => {
    // discounted = round(333 * 0.85) = round(283.05) = 283 ; discount = 333 - 283 = 50
    expect(computeCouponDiscount(pct(15), 333)).toBe(50);
  });

  it('100% takes off the entire base (discount == base, final == 0)', () => {
    // discounted = round(5000 * 0) = 0 ; discount = 5000
    const base = 5000;
    const d = computeCouponDiscount(pct(100), base);
    expect(d).toBe(base);
    expect(base - d).toBe(0);
  });

  it('1% of a small base rounds to a whole cent', () => {
    // discounted = round(100 * 0.99) = round(99) = 99 ; discount = 1
    expect(computeCouponDiscount(pct(1), 100)).toBe(1);
  });

  it('1% of a base too small to yield a cent rounds down to 0 discount', () => {
    // discounted = round(10 * 0.99) = round(9.9) = 10 ; discount = 0
    expect(computeCouponDiscount(pct(1), 10)).toBe(0);
  });

  it('a zero base yields zero discount', () => {
    // discounted = round(0 * anything) = 0 ; discount = 0
    expect(computeCouponDiscount(pct(50), 0)).toBe(0);
  });

  it('discount never exceeds base for any percentage in 1..100', () => {
    for (let p = 1; p <= 100; p++) {
      for (const base of [0, 1, 7, 99, 100, 12345]) {
        const d = computeCouponDiscount(pct(p), base);
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThanOrEqual(base);
      }
    }
  });
});

describe('normalizeCouponCode', () => {
  it('trims surrounding whitespace and uppercases', () => {
    expect(normalizeCouponCode('  save10 ')).toBe('SAVE10');
  });

  it('uppercases an already-trimmed lowercase code', () => {
    expect(normalizeCouponCode('bemvindo')).toBe('BEMVINDO');
  });

  it('leaves an already-normalized code unchanged', () => {
    expect(normalizeCouponCode('DESCONTO20')).toBe('DESCONTO20');
  });

  it('preserves internal hyphens/digits while uppercasing', () => {
    expect(normalizeCouponCode('Bem-Vindo-2026')).toBe('BEM-VINDO-2026');
  });

  it('strips tabs and newlines around the code', () => {
    expect(normalizeCouponCode('\t\nCODE\n')).toBe('CODE');
  });

  it('returns an empty string for an empty input', () => {
    expect(normalizeCouponCode('')).toBe('');
  });

  it('returns an empty string for whitespace-only input', () => {
    expect(normalizeCouponCode('   ')).toBe('');
  });

  it('uppercases accented characters', () => {
    expect(normalizeCouponCode('café10')).toBe('CAFÉ10');
  });
});

describe('computeCouponDiscount — defensive clamp (discount always within [0, base])', () => {
  it('PERCENTUAL above 100 is clamped to 100 (never exceeds the charge / no negative)', () => {
    expect(computeCouponDiscount(pct(150), 1000)).toBe(1000); // clamped to full base, not >base
    expect(computeCouponDiscount(pct(100), 1000)).toBe(1000);
  });
  it('PERCENTUAL below 0 is clamped to 0 (no negative discount)', () => {
    expect(computeCouponDiscount(pct(-20), 1000)).toBe(0);
  });
  it('VALOR below 0 is clamped to 0', () => {
    expect(computeCouponDiscount(valor(-500), 1000)).toBe(0);
  });
});

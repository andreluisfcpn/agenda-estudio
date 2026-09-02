import { describe, it, expect } from 'vitest';
import { Tier } from '../src/generated/prisma/client';
import { canAccessTier, getBasePrice, formatBRL } from '../src/utils/pricing';

// Tier hierarchy levels (from source): COMERCIAL=1, AUDIENCIA=2, SABADO=3.
// canAccessTier(contract, slot) === level[contract] >= level[slot]
describe('canAccessTier — full access matrix', () => {
    // Same tier: always allowed (>=)
    it('allows same-tier access for every tier', () => {
        expect(canAccessTier(Tier.COMERCIAL, Tier.COMERCIAL)).toBe(true);
        expect(canAccessTier(Tier.AUDIENCIA, Tier.AUDIENCIA)).toBe(true);
        expect(canAccessTier(Tier.SABADO, Tier.SABADO)).toBe(true);
    });

    // Higher contract tier can access lower slot tiers (downward compatibility)
    it('lets higher contract tiers book lower slot tiers', () => {
        expect(canAccessTier(Tier.AUDIENCIA, Tier.COMERCIAL)).toBe(true); // 2 >= 1
        expect(canAccessTier(Tier.SABADO, Tier.COMERCIAL)).toBe(true);    // 3 >= 1
        expect(canAccessTier(Tier.SABADO, Tier.AUDIENCIA)).toBe(true);    // 3 >= 2
    });

    // Lower contract tier CANNOT access higher slot tiers
    it('blocks lower contract tiers from higher slot tiers', () => {
        expect(canAccessTier(Tier.COMERCIAL, Tier.AUDIENCIA)).toBe(false); // 1 >= 2 false
        expect(canAccessTier(Tier.COMERCIAL, Tier.SABADO)).toBe(false);    // 1 >= 3 false
        expect(canAccessTier(Tier.AUDIENCIA, Tier.SABADO)).toBe(false);    // 2 >= 3 false
    });

    // Exhaustive 3x3 matrix cross-check against the level rule
    it('matches the level rule across the entire 3x3 matrix', () => {
        const level: Record<string, number> = { COMERCIAL: 1, AUDIENCIA: 2, SABADO: 3 };
        const tiers = [Tier.COMERCIAL, Tier.AUDIENCIA, Tier.SABADO];
        for (const c of tiers) {
            for (const s of tiers) {
                expect(canAccessTier(c, s)).toBe(level[c] >= level[s]);
            }
        }
    });
});

describe('getBasePrice — static fallback prices (cents)', () => {
    it('returns the hardcoded price per tier', () => {
        expect(getBasePrice(Tier.COMERCIAL)).toBe(30000);
        expect(getBasePrice(Tier.AUDIENCIA)).toBe(40000);
        expect(getBasePrice(Tier.SABADO)).toBe(50000);
    });

    it('falls back to 30000 for an unknown tier value', () => {
        // Exercises the `?? 30000` branch with a value not in DEFAULT_PRICES
        expect(getBasePrice('UNKNOWN' as unknown as Tier)).toBe(30000);
    });
});

describe('formatBRL — cents to BRL string', () => {
    it('formats zero', () => {
        expect(formatBRL(0)).toBe('R$ 0,00');
    });

    it('formats whole reais with comma decimal separator', () => {
        expect(formatBRL(30000)).toBe('R$ 300,00');
        expect(formatBRL(40000)).toBe('R$ 400,00');
        expect(formatBRL(50000)).toBe('R$ 500,00');
    });

    it('formats sub-real amounts (cents)', () => {
        expect(formatBRL(1)).toBe('R$ 0,01');
        expect(formatBRL(99)).toBe('R$ 0,99');
        expect(formatBRL(5)).toBe('R$ 0,05');
    });

    it('formats mixed reais and cents', () => {
        expect(formatBRL(12345)).toBe('R$ 123,45');
        expect(formatBRL(101)).toBe('R$ 1,01');
    });

    it('does NOT add a thousands separator (no grouping)', () => {
        expect(formatBRL(100000)).toBe('R$ 1000,00');    // 1,000.00 → no grouping
        expect(formatBRL(123456789)).toBe('R$ 1234567,89');
    });

    it('rounds to 2 decimals via toFixed', () => {
        // 12345.6 cents / 100 = 123.456 → toFixed(2) = "123.46"
        expect(formatBRL(12345.6)).toBe('R$ 123,46');
        // 12345.4 cents / 100 = 123.454 → toFixed(2) = "123.45"
        expect(formatBRL(12345.4)).toBe('R$ 123,45');
    });

    it('handles negative amounts', () => {
        expect(formatBRL(-100)).toBe('R$ -1,00');
    });
});

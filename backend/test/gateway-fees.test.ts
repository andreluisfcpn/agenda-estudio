import { describe, it, expect } from 'vitest';
import { resolveFeeAt, computeGatewayFee, type FeeHistoryRow, type FeeRate } from '../src/lib/gatewayFees';

const d = (iso: string) => new Date(iso);
const STRIPE_FALLBACK: FeeRate = { pct: 3.99, fixedCents: 39 };
const CORA_FALLBACK: FeeRate = { pct: 0, fixedCents: 200 };

describe('resolveFeeAt — taxa vigente pela data do pagamento', () => {
    it('sem histórico → usa o fallback (config atual)', () => {
        expect(resolveFeeAt([], 'STRIPE', d('2026-09-16T12:00:00Z'), STRIPE_FALLBACK)).toEqual(STRIPE_FALLBACK);
    });

    it('pagamento ANTES da mudança usa a taxa antiga; DEPOIS usa a nova', () => {
        // Linha do tempo: até 2026-09-16 a taxa era 3.99+39; a partir daí passou a 4.50+49.
        const history: FeeHistoryRow[] = [
            { provider: 'STRIPE', feePct: 3.99, feeFixedCents: 39, effectiveFrom: new Date(0) },
            { provider: 'STRIPE', feePct: 4.50, feeFixedCents: 49, effectiveFrom: d('2026-09-16T00:00:00Z') },
        ];
        // Pagamento de ontem (antes da mudança)
        expect(resolveFeeAt(history, 'STRIPE', d('2026-09-15T23:00:00Z'), STRIPE_FALLBACK)).toEqual({ pct: 3.99, fixedCents: 39 });
        // Pagamento de hoje (após a mudança)
        expect(resolveFeeAt(history, 'STRIPE', d('2026-09-16T10:00:00Z'), STRIPE_FALLBACK)).toEqual({ pct: 4.50, fixedCents: 49 });
    });

    it('escolhe a linha de MAIOR effectiveFrom <= data, mesmo com histórico fora de ordem', () => {
        const history: FeeHistoryRow[] = [
            { provider: 'STRIPE', feePct: 5.0, feeFixedCents: 59, effectiveFrom: d('2026-11-01T00:00:00Z') },
            { provider: 'STRIPE', feePct: 3.99, feeFixedCents: 39, effectiveFrom: new Date(0) },
            { provider: 'STRIPE', feePct: 4.5, feeFixedCents: 49, effectiveFrom: d('2026-09-16T00:00:00Z') },
        ];
        expect(resolveFeeAt(history, 'STRIPE', d('2026-10-01T00:00:00Z'), STRIPE_FALLBACK)).toEqual({ pct: 4.5, fixedCents: 49 });
        expect(resolveFeeAt(history, 'STRIPE', d('2026-12-01T00:00:00Z'), STRIPE_FALLBACK)).toEqual({ pct: 5.0, fixedCents: 59 });
    });

    it('isola por provider (o histórico da Cora não afeta o Stripe)', () => {
        const history: FeeHistoryRow[] = [
            { provider: 'CORA', feePct: 0, feeFixedCents: 300, effectiveFrom: new Date(0) },
        ];
        // Stripe sem histórico próprio → fallback
        expect(resolveFeeAt(history, 'STRIPE', d('2026-09-16T12:00:00Z'), STRIPE_FALLBACK)).toEqual(STRIPE_FALLBACK);
        // Cora resolve pelo seu histórico
        expect(resolveFeeAt(history, 'CORA', d('2026-09-16T12:00:00Z'), CORA_FALLBACK)).toEqual({ pct: 0, fixedCents: 300 });
    });

    it('data anterior ao 1º registro cai no fallback', () => {
        const history: FeeHistoryRow[] = [
            { provider: 'STRIPE', feePct: 4.5, feeFixedCents: 49, effectiveFrom: d('2026-09-16T00:00:00Z') },
        ];
        expect(resolveFeeAt(history, 'STRIPE', d('2026-01-01T00:00:00Z'), STRIPE_FALLBACK)).toEqual(STRIPE_FALLBACK);
    });
});

describe('computeGatewayFee — taxa cobrada em centavos', () => {
    it('STRIPE: percentual + fixo', () => {
        // 10000 centavos (R$100) * 3.99% = 399 + 39 = 438
        expect(computeGatewayFee(10000, 'STRIPE', { pct: 3.99, fixedCents: 39 })).toBe(438);
    });

    it('STRIPE: nunca ultrapassa o bruto (cobrança mínima)', () => {
        // R$0,52 → 3.99% de 52 = ~2 + 39 = 41 (menor que 52, ok)
        expect(computeGatewayFee(52, 'STRIPE', { pct: 3.99, fixedCents: 39 })).toBe(41);
        // R$0,10 → 0 + 39 = 39, mas nunca acima de 10 → 10
        expect(computeGatewayFee(10, 'STRIPE', { pct: 3.99, fixedCents: 39 })).toBe(10);
    });

    it('CORA: só a taxa fixa', () => {
        expect(computeGatewayFee(10000, 'CORA', { pct: 0, fixedCents: 200 })).toBe(200);
    });

    it('SICOOB e demais: sem tarifa', () => {
        expect(computeGatewayFee(10000, 'SICOOB', { pct: 0, fixedCents: 0 })).toBe(0);
    });

    it('a taxa nova aplica-se ao valor com a resolução por data (integração leve)', () => {
        const history: FeeHistoryRow[] = [
            { provider: 'STRIPE', feePct: 3.99, feeFixedCents: 39, effectiveFrom: new Date(0) },
            { provider: 'STRIPE', feePct: 4.50, feeFixedCents: 49, effectiveFrom: d('2026-09-16T00:00:00Z') },
        ];
        const ontem = computeGatewayFee(10000, 'STRIPE', resolveFeeAt(history, 'STRIPE', d('2026-09-15T12:00:00Z'), STRIPE_FALLBACK));
        const hoje = computeGatewayFee(10000, 'STRIPE', resolveFeeAt(history, 'STRIPE', d('2026-09-16T12:00:00Z'), STRIPE_FALLBACK));
        expect(ontem).toBe(438);  // 3.99% + 39
        expect(hoje).toBe(499);   // 4.50% (450) + 49
    });
});

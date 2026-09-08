import { describe, it, expect } from 'vitest';
import { targetForfeit } from '../src/lib/flexCredits';

// targetForfeit(shortfall, floor, total, recordings):
//   quanto DEVERIA ter sido confiscado até agora, respeitando o grandfather floor
//   e sem nunca confiscar créditos já usados (clamp em total - recordings).
// Antes só tinha cobertura no script manual (src/scripts/testFlexCredits.ts) — sem vitest.
describe('targetForfeit', () => {
    it('grandfather: shortfall igual ao floor não confisca nada', () => {
        expect(targetForfeit(2, 2, 12, 1)).toBe(0);
    });

    it('grandfather: shortfall abaixo do floor não confisca (clamp em 0)', () => {
        expect(targetForfeit(5, 10, 12, 0)).toBe(0);
    });

    it('além do floor: confisca a diferença (shortfall - floor)', () => {
        expect(targetForfeit(3, 2, 12, 1)).toBe(1);
    });

    it('contrato novo (floor 0), atrasado em 2: confisca 2', () => {
        expect(targetForfeit(2, 0, 12, 1)).toBe(2);
    });

    it('clamp: nunca confisca mais que total - recordings', () => {
        // 10 gravações usaram 10 créditos → só 2 restam confiscáveis, mesmo com shortfall 99.
        expect(targetForfeit(99, 0, 12, 10)).toBe(2);
    });

    it('entradas negativas/estranhas são clampadas a 0', () => {
        expect(targetForfeit(-1, 0, 12, 0)).toBe(0);
    });

    it('nada confiscável quando gravações == total', () => {
        expect(targetForfeit(5, 0, 12, 12)).toBe(0);
    });
});

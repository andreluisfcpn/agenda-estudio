import { describe, it, expect, vi } from 'vitest';

// Só a regra PURA (isContractFulfilled): sem banco.
vi.mock('../src/lib/prisma.js', () => ({ prisma: {} }));
vi.mock('../src/lib/businessConfig.js', () => ({ getConfig: async () => 4 }));

import { isContractFulfilled, type CompletionInput } from '../src/lib/contractCompletion';

const SPM = 4; // sessions_per_month
const mk = (type: string, bookings: CompletionInput['bookings'], over: Partial<CompletionInput> = {}): CompletionInput => ({
    type, durationMonths: 3, flexCreditsRemaining: 0, customCreditsRemaining: 0, bookings, ...over,
});

describe('isContractFulfilled — AVULSO (D6/D4/D5)', () => {
    it('gravação finalizada → concluído', () => {
        expect(isContractFulfilled(mk('AVULSO', [{ status: 'COMPLETED' }]), SPM)).toBe(true);
    });
    it('FALTA sem justificativa, com prazo EXPIRED ou 2ª falta (USED) → concluído', () => {
        expect(isContractFulfilled(mk('AVULSO', [{ status: 'FALTA', makeupStatus: null }]), SPM)).toBe(true);
        expect(isContractFulfilled(mk('AVULSO', [{ status: 'FALTA', makeupStatus: 'EXPIRED' }]), SPM)).toBe(true);
        expect(isContractFulfilled(mk('AVULSO', [{ status: 'FALTA', makeupStatus: 'USED' }]), SPM)).toBe(true);
    });
    it('FALTA com janela aberta → NÃO conclui', () => {
        expect(isContractFulfilled(mk('AVULSO', [{ status: 'FALTA', makeupStatus: 'OPEN' }]), SPM)).toBe(false);
    });
    it('NAO_REALIZADO (culpa do estúdio) nunca conclui, nem com prazo EXPIRED', () => {
        expect(isContractFulfilled(mk('AVULSO', [{ status: 'NAO_REALIZADO', makeupStatus: 'OPEN' }]), SPM)).toBe(false);
        expect(isContractFulfilled(mk('AVULSO', [{ status: 'NAO_REALIZADO', makeupStatus: 'EXPIRED' }]), SPM)).toBe(false);
        expect(isContractFulfilled(mk('AVULSO', [{ status: 'NAO_REALIZADO', makeupStatus: null }]), SPM)).toBe(false);
    });
    it('sessão pendente ou só cancelada → NÃO conclui (cancelado com crédito devolvido fica ACTIVE)', () => {
        expect(isContractFulfilled(mk('AVULSO', [{ status: 'CONFIRMED' }]), SPM)).toBe(false);
        expect(isContractFulfilled(mk('AVULSO', [{ status: 'RESERVED' }]), SPM)).toBe(false);
        expect(isContractFulfilled(mk('AVULSO', [{ status: 'CANCELLED' }], { flexCreditsRemaining: 1 }), SPM)).toBe(false);
        expect(isContractFulfilled(mk('AVULSO', []), SPM)).toBe(false);
        expect(isContractFulfilled(mk('AVULSO', [{ status: 'COMPLETED' }, { status: 'CONFIRMED' }]), SPM)).toBe(false);
    });
});

describe('isContractFulfilled — FLEX / CUSTOM / FIXO', () => {
    it('FLEX: sem pendente, houve consumo e 0 crédito → concluído; com crédito → não', () => {
        const done = [{ status: 'COMPLETED' }, { status: 'FALTA' }];
        expect(isContractFulfilled(mk('FLEX', done, { flexCreditsRemaining: 0 }), SPM)).toBe(true);
        expect(isContractFulfilled(mk('FLEX', done, { flexCreditsRemaining: 1 }), SPM)).toBe(false);
        expect(isContractFulfilled(mk('FLEX', [...done, { status: 'CONFIRMED' }], { flexCreditsRemaining: 0 }), SPM)).toBe(false);
    });
    it('sem nenhum consumo (tudo cancelado) → não conclui', () => {
        expect(isContractFulfilled(mk('FLEX', [{ status: 'CANCELLED' }], { flexCreditsRemaining: 0 }), SPM)).toBe(false);
    });
    it('CUSTOM: NAO_REALIZADO devolve crédito → não conclui; sem crédito → conclui', () => {
        expect(isContractFulfilled(mk('CUSTOM', [{ status: 'COMPLETED' }, { status: 'NAO_REALIZADO' }], { customCreditsRemaining: 1 }), SPM)).toBe(false);
        expect(isContractFulfilled(mk('CUSTOM', [{ status: 'COMPLETED' }, { status: 'COMPLETED' }], { customCreditsRemaining: 0 }), SPM)).toBe(true);
    });
    it('FIXO: teto meses × sessões/mês — todas usadas → conclui; faltando uma → não', () => {
        const twelve = Array.from({ length: 12 }, (_, i) => ({ status: i % 4 === 0 ? 'FALTA' : 'COMPLETED' }));
        expect(isContractFulfilled(mk('FIXO', twelve), SPM)).toBe(true);
        expect(isContractFulfilled(mk('FIXO', twelve.slice(1)), SPM)).toBe(false);
        // NAO_REALIZADO não conta como sessão usada → sobra 1 no teto.
        expect(isContractFulfilled(mk('FIXO', [...twelve.slice(1), { status: 'NAO_REALIZADO' }]), SPM)).toBe(false);
    });
    it('SERVICO nunca entra', () => {
        expect(isContractFulfilled(mk('SERVICO', [{ status: 'COMPLETED' }]), SPM)).toBe(false);
    });
});

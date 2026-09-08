import { describe, it, expect } from 'vitest';
import { isSicoobCobPaid, isSicoobCobCancelled, isSicoobCobExpired } from '../src/lib/sicoobReconciliation';

const criacao = '2026-01-01T12:00:00.000Z';
const cob = (over: Record<string, unknown> = {}) => ({
    status: 'ATIVA',
    calendario: { criacao, expiracao: 3600 },
    valor: { original: '840.00' },
    ...over,
});

describe('isSicoobCobPaid', () => {
    it('CONCLUIDA → pago', () => expect(isSicoobCobPaid(cob({ status: 'CONCLUIDA' }))).toBe(true));
    it('ATIVA com pix[] cobrindo o original → pago (fallback)', () =>
        expect(isSicoobCobPaid(cob({ pix: [{ valor: '840.00' }] }))).toBe(true));
    it('ATIVA sem pix → não pago', () => expect(isSicoobCobPaid(cob())).toBe(false));
    it('null → não pago', () => expect(isSicoobCobPaid(null)).toBe(false));
});

describe('isSicoobCobCancelled', () => {
    it('REMOVIDA_PELO_USUARIO_RECEBEDOR → cancelada', () =>
        expect(isSicoobCobCancelled(cob({ status: 'REMOVIDA_PELO_USUARIO_RECEBEDOR' }))).toBe(true));
    it('REMOVIDA_PELO_PSP → cancelada', () =>
        expect(isSicoobCobCancelled(cob({ status: 'REMOVIDA_PELO_PSP' }))).toBe(true));
    it('ATIVA → não cancelada', () => expect(isSicoobCobCancelled(cob())).toBe(false));
});

describe('isSicoobCobExpired', () => {
    const base = Date.parse(criacao);
    it('além da expiração + margem → expirada', () =>
        expect(isSicoobCobExpired(cob(), new Date(base + 3600 * 1000 + 3 * 60 * 1000))).toBe(true));
    it('dentro da expiração → não expirada', () =>
        expect(isSicoobCobExpired(cob(), new Date(base + 1800 * 1000))).toBe(false));
    it('expirada mas dentro da margem (1 min) → ainda não', () =>
        expect(isSicoobCobExpired(cob(), new Date(base + 3600 * 1000 + 60 * 1000))).toBe(false));
    it('sem calendario → não expirada', () =>
        expect(isSicoobCobExpired({ status: 'ATIVA' }, new Date(base + 999 * 3600 * 1000))).toBe(false));
});

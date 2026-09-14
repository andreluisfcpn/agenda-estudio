import { describe, it, expect } from 'vitest';
import { formatSicoobError, normalizePixKey } from '../src/lib/sicoobService';

describe('formatSicoobError', () => {
    it('extrai title + violações do padrão Bacen (RFC 7807)', () => {
        const body = JSON.stringify({
            title: 'Cobrança inválida',
            detail: 'A cobrança não respeita o schema',
            violacoes: [{ razao: 'CPF inválido', propriedade: 'devedor.cpf' }],
        });
        const msg = formatSicoobError(400, body);
        expect(msg).toContain('400:');
        expect(msg).toContain('Cobrança inválida');
        expect(msg).toContain('devedor.cpf: CPF inválido');
    });

    it('usa só o title quando detail é igual/ausente', () => {
        expect(formatSicoobError(403, JSON.stringify({ title: 'Acesso negado' }))).toBe('403: Acesso negado');
    });

    it('corpo não-JSON → status + corpo cru truncado', () => {
        expect(formatSicoobError(502, 'Bad Gateway')).toBe('502: Bad Gateway');
    });

    it('trunca corpos longos', () => {
        const long = 'x'.repeat(500);
        expect(formatSicoobError(500, long).length).toBeLessThan(320);
    });
});

describe('normalizePixKey', () => {
    it('CNPJ com máscara → só dígitos (formato exigido pela API Pix)', () => {
        expect(normalizePixKey('12.345.678/0001-90')).toBe('12345678000190');
    });
    it('CPF com máscara → só dígitos', () => {
        expect(normalizePixKey('529.982.247-25')).toBe('52998224725');
    });
    it('CNPJ/CPF já só-dígitos → intacto', () => {
        expect(normalizePixKey('12345678000190')).toBe('12345678000190');
        expect(normalizePixKey('52998224725')).toBe('52998224725');
    });
    it('e-mail passa intacto', () => {
        expect(normalizePixKey('financeiro@estudio.com.br')).toBe('financeiro@estudio.com.br');
    });
    it('telefone passa intacto (não colide com CPF de 11 dígitos)', () => {
        expect(normalizePixKey('+5522999998888')).toBe('+5522999998888');
        expect(normalizePixKey('(22) 99999-8888')).toBe('(22) 99999-8888');
    });
    it('chave aleatória (UUID) passa intacta', () => {
        const uuid = '123e4567-e89b-12d3-a456-426614174000';
        expect(normalizePixKey(uuid)).toBe(uuid);
    });
    it('vazio/nulo → string vazia (o guard de chave ausente trata depois)', () => {
        expect(normalizePixKey('')).toBe('');
        expect(normalizePixKey(null)).toBe('');
        expect(normalizePixKey(undefined)).toBe('');
    });
});

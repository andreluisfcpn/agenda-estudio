import { describe, it, expect } from 'vitest';
import { cleanDocument, isValidCpf, isValidCnpj, isValidCpfCnpj } from '../src/utils/document';

// CPFs e CNPJs de teste com dígitos verificadores VÁLIDOS (módulo 11 da Receita Federal).
const VALID_CPFS = ['52998224725', '11144477735'];
const VALID_CNPJS = ['11222333000181', '19131243000197'];

describe('cleanDocument', () => {
    it('remove tudo que não é dígito', () => {
        expect(cleanDocument('529.982.247-25')).toBe('52998224725');
        expect(cleanDocument('11.222.333/0001-81')).toBe('11222333000181');
    });
    it('null/undefined/vazio → string vazia', () => {
        expect(cleanDocument(null)).toBe('');
        expect(cleanDocument(undefined)).toBe('');
        expect(cleanDocument('')).toBe('');
    });
});

describe('isValidCpf', () => {
    it('aceita CPFs com dígitos verificadores corretos (com e sem máscara)', () => {
        for (const cpf of VALID_CPFS) {
            expect(isValidCpf(cpf)).toBe(true);
        }
        expect(isValidCpf('529.982.247-25')).toBe(true);
    });
    it('rejeita dígito verificador errado', () => {
        expect(isValidCpf('52998224724')).toBe(false); // último dígito trocado (5→4)
        expect(isValidCpf('11144477734')).toBe(false);
    });
    it('rejeita sequências repetidas (000…, 111…, etc.)', () => {
        for (let d = 0; d <= 9; d++) {
            expect(isValidCpf(String(d).repeat(11))).toBe(false);
        }
    });
    it('rejeita tamanho errado', () => {
        expect(isValidCpf('5299822472')).toBe(false);   // 10 dígitos
        expect(isValidCpf('529982247250')).toBe(false);  // 12 dígitos
        expect(isValidCpf('')).toBe(false);
    });
});

describe('isValidCnpj', () => {
    it('aceita CNPJs com dígitos verificadores corretos (com e sem máscara)', () => {
        for (const cnpj of VALID_CNPJS) {
            expect(isValidCnpj(cnpj)).toBe(true);
        }
        expect(isValidCnpj('11.222.333/0001-81')).toBe(true);
    });
    it('rejeita dígito verificador errado', () => {
        expect(isValidCnpj('11222333000180')).toBe(false); // último dígito trocado (1→0)
        expect(isValidCnpj('19131243000198')).toBe(false);
    });
    it('rejeita sequências repetidas', () => {
        for (let d = 0; d <= 9; d++) {
            expect(isValidCnpj(String(d).repeat(14))).toBe(false);
        }
    });
    it('rejeita tamanho errado', () => {
        expect(isValidCnpj('1122233300018')).toBe(false);   // 13 dígitos
        expect(isValidCnpj('112223330001810')).toBe(false); // 15 dígitos
        expect(isValidCnpj('')).toBe(false);
    });
});

describe('isValidCpfCnpj (dispatch por tamanho)', () => {
    it('11 dígitos → valida como CPF', () => {
        expect(isValidCpfCnpj('52998224725')).toBe(true);
        expect(isValidCpfCnpj('52998224724')).toBe(false);
    });
    it('14 dígitos → valida como CNPJ', () => {
        expect(isValidCpfCnpj('11222333000181')).toBe(true);
        expect(isValidCpfCnpj('11222333000180')).toBe(false);
    });
    it('qualquer outro tamanho → inválido', () => {
        expect(isValidCpfCnpj('123')).toBe(false);
        expect(isValidCpfCnpj('5299822472')).toBe(false);   // 10
        expect(isValidCpfCnpj('112223330001')).toBe(false); // 12
        expect(isValidCpfCnpj('1122233300018')).toBe(false); // 13
        expect(isValidCpfCnpj(null)).toBe(false);
        expect(isValidCpfCnpj(undefined)).toBe(false);
        expect(isValidCpfCnpj('')).toBe(false);
    });
});

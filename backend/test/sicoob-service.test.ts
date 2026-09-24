import { describe, it, expect } from 'vitest';
import { formatSicoobError, normalizePixKey, resolveSicoobEmv, canUseSyntheticBrCode, computeCobExpiresAt, SANDBOX_TEST_PIX_KEY } from '../src/lib/sicoobService';
import { isValidBrCode, brCodeAmountCents, buildStaticBrCode } from '../src/lib/brcode';

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

// ─── D15: EMV do Sicoob (produção × sandbox) ─────────────

const TXID = 'f775d93058694961a6d2e5a2767e6a3e';
const VALID_DYNAMIC = '00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***63041D3D';

describe('canUseSyntheticBrCode (trava de ambiente)', () => {
    it('sandbox fora de produção → permitido', () => {
        expect(canUseSyntheticBrCode('sandbox', 'development')).toBe(true);
        expect(canUseSyntheticBrCode('sandbox', 'test')).toBe(true);
        expect(canUseSyntheticBrCode('sandbox', undefined)).toBe(true);
    });
    it('NUNCA em produção (nem com integração em sandbox, nem com Sicoob produção)', () => {
        expect(canUseSyntheticBrCode('sandbox', 'production')).toBe(false);
        expect(canUseSyntheticBrCode('production', 'production')).toBe(false);
        expect(canUseSyntheticBrCode('production', 'development')).toBe(false);
    });
});

describe('resolveSicoobEmv', () => {
    const base = { amountCents: 105000, txid: TXID, pixKey: 'chave@estudio.com' };

    it('produção + EMV válido → usa o do Sicoob', () => {
        const r = resolveSicoobEmv({ ...base, emv: VALID_DYNAMIC, environment: 'production', nodeEnv: 'production' });
        expect(r).toEqual({ emv: VALID_DYNAMIC, synthetic: false });
    });

    it('produção + EMV inválido (lorem ipsum) → ERRO, nunca QR falso', () => {
        expect(() => resolveSicoobEmv({ ...base, emv: 'proident', environment: 'production', nodeEnv: 'production' })).toThrow(/inválido/);
        expect(() => resolveSicoobEmv({ ...base, emv: '', environment: 'production', nodeEnv: 'production' })).toThrow();
    });

    it('sandbox mas deploy de produção (NODE_ENV) → erro, sem sintético', () => {
        expect(() => resolveSicoobEmv({ ...base, emv: 'fugiat', environment: 'sandbox', nodeEnv: 'production' })).toThrow();
    });

    it('sandbox + lorem ipsum → BR Code sintético VÁLIDO com o valor e o txid reais, mas chave FICTÍCIA', () => {
        const r = resolveSicoobEmv({ ...base, emv: 'ullamco irure dolore esse et', environment: 'sandbox', nodeEnv: 'development' });
        expect(r.synthetic).toBe(true);
        expect(isValidBrCode(r.emv)).toBe(true);
        expect(brCodeAmountCents(r.emv)).toBe(105000);
        expect(r.emv).toContain(TXID.slice(0, 25));
        // pagamentos-12: nunca a chave configurada (com a chave real o QR de teste seria pagável de verdade).
        expect(r.emv).not.toContain('chave@estudio.com');
        expect(r.emv).toContain(SANDBOX_TEST_PIX_KEY);
        expect(r.emv).toContain('TESTE SANDBOX NAO PAGAR');
    });

    it('sandbox: a chave real do estúdio (CNPJ) nunca entra no QR sintético', () => {
        const r = resolveSicoobEmv({ ...base, pixKey: '12345678000190', emv: '', environment: 'sandbox', nodeEnv: 'test' });
        expect(r.synthetic).toBe(true);
        expect(r.emv).not.toContain('12345678000190');
    });

    it('sandbox + EMV válido mas com valor aleatório → troca pelo sintético', () => {
        const wrongValue = buildStaticBrCode({ key: 'x', amountCents: 804015210970 });
        const r = resolveSicoobEmv({ ...base, emv: wrongValue, environment: 'sandbox', nodeEnv: 'development' });
        expect(r.synthetic).toBe(true);
        expect(brCodeAmountCents(r.emv)).toBe(105000);
    });

    it('sandbox + EMV válido com o valor certo (ou sem tag 54) → mantém o do provedor', () => {
        const right = buildStaticBrCode({ key: 'x', amountCents: 105000 });
        expect(resolveSicoobEmv({ ...base, emv: right, environment: 'sandbox', nodeEnv: 'development' })).toEqual({ emv: right, synthetic: false });
        expect(resolveSicoobEmv({ ...base, emv: VALID_DYNAMIC, environment: 'sandbox', nodeEnv: 'development' }).synthetic).toBe(false);
    });
});

describe('computeCobExpiresAt', () => {
    const now = new Date('2026-09-23T15:00:00.000Z');
    it('produção: criação + expiração do provedor', () => {
        const cob = { calendario: { criacao: '2026-09-23T14:59:50.000Z', expiracao: 600 } };
        expect(computeCobExpiresAt(cob, 600, 'production', now).toISOString()).toBe('2026-09-23T15:09:50.000Z');
    });
    it('sandbox: ignora a criação aleatória do mock (1964) → agora + expiração', () => {
        const cob = { calendario: { criacao: '1964-07-30T00:00:00Z', expiracao: 3600 } };
        expect(computeCobExpiresAt(cob, 600, 'sandbox', now).toISOString()).toBe('2026-09-23T15:10:00.000Z');
    });
    it('produção sem calendário ou com relógio absurdo → agora + expiração pedida', () => {
        expect(computeCobExpiresAt({}, 120, 'production', now).toISOString()).toBe('2026-09-23T15:02:00.000Z');
        expect(computeCobExpiresAt({ calendario: { criacao: '2020-01-01T00:00:00Z', expiracao: 60 } }, 120, 'production', now).toISOString()).toBe('2026-09-23T15:02:00.000Z');
    });
});

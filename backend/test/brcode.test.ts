import { describe, it, expect } from 'vitest';
import { crc16, isValidBrCode, buildStaticBrCode, brCodeAmountCents, parseTlv } from '../src/lib/brcode';

// Exemplo do "Manual de Padrões para Iniciação do Pix" (Bacen) — CRC 1D3D.
const BACEN_EXAMPLE = '00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***63041D3D';
// EMV fixo que o paymentGateway usava como mock (CRC declarado 1A2B; o correto seria 4D1D).
const OLD_MOCK = '00020126580014br.gov.bcb.pix0136123e4567-e89b-12d3-a456-426614174000520400005303986540510.005802BR5913Buzios Studio6008BuziosRJ62070503***63041A2B';

describe('crc16 (CCITT-FALSE)', () => {
    it('vetor padrão "123456789" → 29B1', () => expect(crc16('123456789')).toBe('29B1'));
    it('bate com o CRC do exemplo do Bacen', () => expect(crc16(BACEN_EXAMPLE.slice(0, -4))).toBe('1D3D'));
    it('sempre 4 hex maiúsculos', () => expect(crc16('')).toMatch(/^[0-9A-F]{4}$/));
});

describe('isValidBrCode', () => {
    it('aceita o exemplo oficial do Bacen', () => expect(isValidBrCode(BACEN_EXAMPLE)).toBe(true));
    it('rejeita texto aleatório do mock do sandbox (lorem ipsum)', () => {
        expect(isValidBrCode('proident')).toBe(false);
        expect(isValidBrCode('ullamco irure dolore esse et')).toBe(false);
        expect(isValidBrCode('')).toBe(false);
        expect(isValidBrCode(null)).toBe(false);
        expect(isValidBrCode(undefined)).toBe(false);
    });
    it('rejeita o EMV mock antigo (CRC 1A2B inválido)', () => expect(isValidBrCode(OLD_MOCK)).toBe(false));
    it('rejeita CRC adulterado', () => expect(isValidBrCode(BACEN_EXAMPLE.slice(0, -4) + '0000')).toBe(false));
    it('rejeita TLV truncado', () => expect(isValidBrCode(BACEN_EXAMPLE.slice(0, 40))).toBe(false));
    it('rejeita payload sem GUI br.gov.bcb.pix', () => {
        const noGui = BACEN_EXAMPLE.replace('br.gov.bcb.pix', 'br.gov.bcb.xxx').slice(0, -4);
        expect(isValidBrCode(noGui + crc16(noGui))).toBe(false);
    });
    it('aceita o CRC em minúsculas', () => {
        expect(isValidBrCode(BACEN_EXAMPLE.slice(0, -4) + '1d3d')).toBe(true);
    });
});

describe('buildStaticBrCode (sandbox/dev)', () => {
    it('gera BR Code válido com o valor, a chave e o txid informados', () => {
        const emv = buildStaticBrCode({
            key: 'sandbox-pix-key',
            amountCents: 105000,
            txid: 'f775d93058694961a6d2e5a2767e6a3e',
            merchantName: 'Estúdio Búzios Digital',
            city: 'Armação dos Búzios',
        });
        expect(isValidBrCode(emv)).toBe(true);
        expect(brCodeAmountCents(emv)).toBe(105000);
        expect(emv).toContain('sandbox-pix-key');
        // campos 59/60 são ASCII sem acento e respeitam os limites (25/15)
        const fields = parseTlv(emv)!;
        const name = fields.find(f => f.id === '59')!.value;
        const city = fields.find(f => f.id === '60')!.value;
        expect(name).toBe('Estudio Buzios Digital');
        expect(city.length).toBeLessThanOrEqual(15);
        expect(/^[\x20-\x7E]+$/.test(city)).toBe(true);
        // txid do QR estático: no máximo 25 alfanuméricos (prefixo do txid real)
        const add = parseTlv(fields.find(f => f.id === '62')!.value)!;
        expect(add.find(f => f.id === '05')!.value).toBe('f775d93058694961a6d2e5a27');
    });
    it('valor com centavos é formatado com 2 casas', () => {
        const emv = buildStaticBrCode({ key: 'k', amountCents: 1 });
        expect(brCodeAmountCents(emv)).toBe(1);
        expect(emv).toContain('54040.01');
    });
    it('sem txid usa "***"', () => {
        const emv = buildStaticBrCode({ key: 'k', amountCents: 500 });
        expect(emv).toContain('62070503***');
        expect(isValidBrCode(emv)).toBe(true);
    });
    it('recusa valor inválido ou chave vazia', () => {
        expect(() => buildStaticBrCode({ key: 'k', amountCents: 0 })).toThrow();
        expect(() => buildStaticBrCode({ key: 'k', amountCents: 10.5 })).toThrow();
        expect(() => buildStaticBrCode({ key: '  ', amountCents: 100 })).toThrow();
    });
});

describe('brCodeAmountCents', () => {
    it('QR sem tag 54 → null', () => expect(brCodeAmountCents(BACEN_EXAMPLE)).toBeNull());
});

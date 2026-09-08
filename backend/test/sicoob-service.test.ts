import { describe, it, expect } from 'vitest';
import { formatSicoobError } from '../src/lib/sicoobService';

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

import { describe, it, expect } from 'vitest';
import { NOTIFICATION_EVENT_CATALOG, NOTIFICATION_EVENT_BY_KEY } from '../src/config/notificationEventCatalog';

// COV-6 (lote 2, E3): com a chave-mestra do boleto desligada ele "não aparece em lugar nenhum" — nem
// nos textos PADRÃO enviados ao cliente (sino e push). A `description` é texto do painel do admin e pode
// citar o boleto; título e mensagem ao cliente, não.
describe('catálogo de notificações — textos ao cliente não citam boleto', () => {
    it('nenhum evento de cliente fala em boleto no título ou na mensagem padrão', () => {
        const offenders = NOTIFICATION_EVENT_CATALOG
            .filter(e => e.audience === 'client')
            .filter(e => /boleto/i.test(e.defaultTitle) || /boleto/i.test(e.defaultMessage))
            .map(e => e.eventKey);
        expect(offenders).toEqual([]);
    });

    it('"Cobrança expirada" não cita a forma de pagamento e manda gerar outra em Meus Pagamentos', () => {
        const ev = NOTIFICATION_EVENT_BY_KEY.payment_expired!;
        expect(ev.audience).toBe('client');
        expect(ev.defaultTitle).toBe('Cobrança expirada');
        expect(ev.defaultMessage).toBe('Sua cobrança foi cancelada ou expirou. Gere uma nova em Meus Pagamentos.');
        expect(ev.defaultMessage).not.toMatch(/pix|boleto/i);
        expect(ev.actionUrl).toBe('/meus-pagamentos');
    });
});

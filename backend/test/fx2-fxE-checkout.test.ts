import { describe, it, expect, vi, beforeEach } from 'vitest';

// Frente fxE-checkout (revisão do lote 2) — contrato do backend de que o checkout passou a depender.
// CHK-1: a caixa "Salvar cartão para futuras compras" agora é decidida ANTES de o PaymentIntent existir
//        (InlineCheckout envia `savePaymentMethod` no create-payment). O PI só leva `setup_future_usage`
//        quando a caixa está marcada — sem ele o Stripe NÃO anexa o cartão ao Customer do cliente.
// Stripe, prisma e crypto mocados — nenhuma chamada de rede ou banco.
const h = vi.hoisted(() => ({
    create: vi.fn(),
    confirm: vi.fn(),
    findUnique: vi.fn(),
}));

vi.mock('stripe', () => {
    class FakeStripe {
        static errors = {};
        paymentIntents = { create: h.create, confirm: h.confirm };
        constructor(_key: string, _opts?: unknown) { /* noop */ }
    }
    return { default: FakeStripe };
});
vi.mock('../src/lib/prisma', () => ({ prisma: { integrationConfig: { findUnique: h.findUnique } } }));
vi.mock('../src/utils/crypto', () => ({ decryptConfigSafe: (s: string) => s }));

import { stripeCreatePaymentIntent } from '../src/lib/stripeService';

const baseOpts = {
    amount: 84000,
    customerId: 'cus_cliente',
    description: 'Pagamento - M8D',
    paymentId: '22222222-2222-2222-2222-222222222222',
    userId: 'cliente-1',
};

beforeEach(() => {
    vi.clearAllMocks();
    h.findUnique.mockResolvedValue({
        provider: 'STRIPE',
        enabled: true,
        environment: 'sandbox',
        config: JSON.stringify({ sandbox: { secretKey: 'sk_test_FXE0001', publishableKey: 'pk_test_x', webhookSecret: 'whsec_x' } }),
    });
    h.create.mockResolvedValue({ id: 'pi_1', client_secret: 'pi_1_secret', status: 'requires_payment_method' });
});

describe('CHK-1 — "Salvar cartão" vale na CRIAÇÃO do PaymentIntent (cartão novo)', () => {
    it('caixa desmarcada (savePaymentMethod: false) → PI SEM setup_future_usage: o cartão não é anexado ao cliente', async () => {
        await stripeCreatePaymentIntent({ ...baseOpts, savePaymentMethod: false });
        const [params] = h.create.mock.calls[0]!;
        expect(params).not.toHaveProperty('setup_future_usage');
        expect(params.customer).toBe('cus_cliente');
        expect(params.payment_method).toBeUndefined();
        expect(params.confirm).toBeUndefined();
    });

    it('sem o campo (chamador antigo) → também SEM setup_future_usage (salvar é sempre opt-in explícito)', async () => {
        await stripeCreatePaymentIntent({ ...baseOpts });
        expect(h.create.mock.calls[0]![0]).not.toHaveProperty('setup_future_usage');
    });

    it('caixa marcada (savePaymentMethod: true) → PI com setup_future_usage on_session', async () => {
        await stripeCreatePaymentIntent({ ...baseOpts, savePaymentMethod: true });
        expect(h.create.mock.calls[0]![0].setup_future_usage).toBe('on_session');
    });

    it('trocar a caixa e voltar ("Voltar" → "Continuar com novo cartão") usa OUTRA chave idempotente — nunca reaproveita o PI da escolha anterior', async () => {
        await stripeCreatePaymentIntent({ ...baseOpts, savePaymentMethod: true });
        await stripeCreatePaymentIntent({ ...baseOpts, savePaymentMethod: false });
        const keySave = h.create.mock.calls[0]![1].idempotencyKey as string;
        const keyNoSave = h.create.mock.calls[1]![1].idempotencyKey as string;
        expect(keySave).not.toBe(keyNoSave);
        expect(keySave).toContain('-save');
        expect(keyNoSave).toContain('-nosave');
    });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

// pagamentos-1 / cobertura-1 (D1): parcelamento no cartão só quando o SERVIDOR fixa o plano.
// Stripe, prisma e crypto mocados — nenhuma chamada de rede ou banco.
const h = vi.hoisted(() => ({
    create: vi.fn(),
    confirm: vi.fn(),
    cancel: vi.fn(),
    retrieveCurrent: vi.fn(),
    findUnique: vi.fn(),
}));

vi.mock('stripe', () => {
    class FakeStripe {
        static errors = {};
        paymentIntents = { create: h.create, confirm: h.confirm, cancel: h.cancel };
        accounts = { retrieveCurrent: h.retrieveCurrent };
        constructor(_key: string, _opts?: unknown) { /* noop */ }
    }
    return { default: FakeStripe };
});
vi.mock('../src/lib/prisma', () => ({ prisma: { integrationConfig: { findUnique: h.findUnique } } }));
vi.mock('../src/utils/crypto', () => ({ decryptConfigSafe: (s: string) => s }));

import {
    accountCountrySupportsCardInstallments,
    cardInstallmentsBlockReason,
    stripeCardInstallmentsSupported,
    stripeCreatePaymentIntent,
    stripeChargeOffSession,
} from '../src/lib/stripeService';

function stripeConfig(secretKey: string) {
    return {
        provider: 'STRIPE',
        enabled: true,
        environment: 'sandbox',
        config: JSON.stringify({ sandbox: { secretKey, publishableKey: 'pk_test_x', webhookSecret: 'whsec_x' } }),
    };
}

const baseOpts = {
    amount: 315000,
    customerId: 'cus_1',
    description: 'Pagamento - Gestão de Tráfego',
    paymentId: '11111111-1111-1111-1111-111111111111',
    userId: 'u1',
};

beforeEach(() => {
    vi.clearAllMocks();
    h.findUnique.mockResolvedValue(stripeConfig('sk_test_AAAA1111'));
    h.create.mockImplementation(async (params: Record<string, unknown>) => ({
        id: 'pi_1', client_secret: 'pi_1_secret', status: params.confirm ? 'succeeded' : 'requires_payment_method',
        payment_method_options: { card: { installments: { enabled: true, available_plans: [], plan: null } } },
    }));
    h.confirm.mockResolvedValue({ id: 'pi_1', client_secret: 'pi_1_secret', status: 'succeeded' });
    h.cancel.mockResolvedValue({ id: 'pi_1', status: 'canceled' });
});

describe('accountCountrySupportsCardInstallments', () => {
    it('conta BR não parcela (verificado no modo teste); MX/JP sim', () => {
        expect(accountCountrySupportsCardInstallments('BR')).toBe(false);
        expect(accountCountrySupportsCardInstallments('MX')).toBe(true);
        expect(accountCountrySupportsCardInstallments('jp')).toBe(true);
        expect(accountCountrySupportsCardInstallments(null)).toBe(false);
        expect(accountCountrySupportsCardInstallments(undefined)).toBe(false);
        expect(accountCountrySupportsCardInstallments('')).toBe(false);
    });
});

describe('cardInstallmentsBlockReason', () => {
    it('1x sempre segue (qualquer cartão, qualquer conta)', () => {
        expect(cardInstallmentsBlockReason({ installments: 1, savedCard: false, gatewaySupported: false })).toBeNull();
        expect(cardInstallmentsBlockReason({ installments: 1, savedCard: true, gatewaySupported: true })).toBeNull();
    });
    it('N > 1 sem parcelamento no gateway (Stripe BR) → recusa, com cartão novo ou salvo', () => {
        const novo = cardInstallmentsBlockReason({ installments: 3, savedCard: false, gatewaySupported: false });
        const salvo = cardInstallmentsBlockReason({ installments: 3, savedCard: true, gatewaySupported: false });
        expect(novo).toMatch(/parcelamento no cartão não está disponível/);
        expect(salvo).toBe(novo);
    });
    it('N > 1 com cartão NOVO → recusa mesmo com gateway que parcela (o plano não seria fixado no servidor)', () => {
        expect(cardInstallmentsBlockReason({ installments: 12, savedCard: false, gatewaySupported: true })).toMatch(/salve o cartão/);
    });
    it('N > 1 com cartão SALVO e gateway que parcela → segue (confirmação no servidor com o plano)', () => {
        expect(cardInstallmentsBlockReason({ installments: 3, savedCard: true, gatewaySupported: true })).toBeNull();
    });
});

describe('stripeCardInstallmentsSupported', () => {
    it('conta BR → false, com cache (1 leitura da conta para várias perguntas)', async () => {
        h.retrieveCurrent.mockResolvedValue({ id: 'acct_br', country: 'BR' });
        expect(await stripeCardInstallmentsSupported()).toBe(false);
        expect(await stripeCardInstallmentsSupported()).toBe(false);
        expect(h.retrieveCurrent).toHaveBeenCalledTimes(1);
    });
    it('conta MX (outra credencial) → true', async () => {
        h.findUnique.mockResolvedValue(stripeConfig('sk_test_MXMX2222'));
        h.retrieveCurrent.mockResolvedValue({ id: 'acct_mx', country: 'MX' });
        expect(await stripeCardInstallmentsSupported()).toBe(true);
    });
    it('falha ao ler a conta → false (na dúvida, não oferece N×)', async () => {
        h.findUnique.mockResolvedValue(stripeConfig('sk_test_FAIL3333'));
        h.retrieveCurrent.mockRejectedValue(new Error('permission denied'));
        expect(await stripeCardInstallmentsSupported()).toBe(false);
    });
    it('Stripe não configurado → false sem chamar a API', async () => {
        h.findUnique.mockResolvedValue(null);
        expect(await stripeCardInstallmentsSupported()).toBe(false);
        expect(h.retrieveCurrent).not.toHaveBeenCalled();
    });
});

describe('stripeCreatePaymentIntent — installments.enabled só com plano fixado no servidor', () => {
    it('cartão NOVO com parcelamento pedido → PI SEM installments (o Payment Element não mostra seletor)', async () => {
        await stripeCreatePaymentIntent({ ...baseOpts, installmentsEnabled: true, savePaymentMethod: true });
        const [params, reqOpts] = h.create.mock.calls[0]!;
        expect(params.payment_method_options).toBeUndefined();
        expect(params.payment_method).toBeUndefined();
        expect(params.confirm).toBeUndefined();
        expect(h.confirm).not.toHaveBeenCalled();
        // chave idempotente estável (pedido do chamador), sem sufixo de plano
        expect(reqOpts.idempotencyKey).toContain('-inst-');
        expect(reqOpts.idempotencyKey).not.toMatch(/plan\d/);
    });

    it('PI da contratação (paymentGateway: installmentsEnabled true, sem cartão) → sem installments', async () => {
        await stripeCreatePaymentIntent({ ...baseOpts, installmentsEnabled: true });
        expect(h.create.mock.calls[0]![0].payment_method_options).toBeUndefined();
    });

    it('cartão SALVO 3x oferecido pelo emissor → cria sem confirmar e confirma COM o plano fixed_count 3', async () => {
        h.create.mockResolvedValueOnce({
            id: 'pi_2', client_secret: 's', status: 'requires_confirmation',
            payment_method_options: { card: { installments: { enabled: true, plan: null, available_plans: [
                { type: 'fixed_count', count: 2, interval: 'month' },
                { type: 'fixed_count', count: 3, interval: 'month' },
            ] } } },
        });
        h.confirm.mockResolvedValueOnce({ id: 'pi_2', client_secret: 's', status: 'succeeded' });
        const r = await stripeCreatePaymentIntent({ ...baseOpts, installmentsEnabled: true, installmentPlanCount: 3, savedPaymentMethodId: 'pm_saved' });
        const [params, reqOpts] = h.create.mock.calls[0]!;
        expect(params.payment_method_options).toEqual({ card: { installments: { enabled: true } } });
        expect(params.payment_method).toBe('pm_saved');
        expect(params.confirm).toBe(false);
        expect(reqOpts.idempotencyKey).toMatch(/-plan3$/);
        expect(h.confirm).toHaveBeenCalledWith('pi_2', {
            payment_method_options: { card: { installments: { plan: { type: 'fixed_count', count: 3, interval: 'month' } } } },
        }, { idempotencyKey: `${reqOpts.idempotencyKey}-confirm` });
        expect(r.status).toBe('succeeded');
    });

    it('cartão SALVO 3x sem o plano no cartão (conta BR: available_plans vazio) → cancela o PI e não cobra', async () => {
        await expect(stripeCreatePaymentIntent({ ...baseOpts, installmentsEnabled: true, installmentPlanCount: 3, savedPaymentMethodId: 'pm_saved' }))
            .rejects.toThrow(/3x não está disponível para este cartão/);
        expect(h.cancel).toHaveBeenCalledWith('pi_1', { cancellation_reason: 'abandoned' });
        expect(h.confirm).not.toHaveBeenCalled();
    });

    it('cobrança automática (off-session, sem parcelas) → confirma na criação, sem installments', async () => {
        await stripeChargeOffSession('cus_1', 'pm_saved', 105000, { paymentId: baseOpts.paymentId, userId: 'u1' });
        const [params, reqOpts] = h.create.mock.calls[0]!;
        expect(params.payment_method_options).toBeUndefined();
        expect(params.confirm).toBe(true);
        expect(params.off_session).toBe(true);
        expect(reqOpts.idempotencyKey).toContain('-noinst-');
    });
});

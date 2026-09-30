import { describe, it, expect, vi, beforeEach } from 'vitest';

// AC-5: stripeGetOrCreateCustomer só recria o Customer quando ele NÃO EXISTE MAIS (deleted / 404 /
// resource_missing). Um erro transitório do Stripe (rede, 429, 5xx) propaga — recriar nesse caso trocava o
// stripeCustomerId do usuário e deixava os cartões salvos órfãos no Customer antigo.
// Stripe, prisma e crypto mocados — nenhuma chamada de rede ou banco.
const h = vi.hoisted(() => ({
    retrieve: vi.fn(),
    create: vi.fn(),
    configFindUnique: vi.fn(),
    userFindUniqueOrThrow: vi.fn(),
    userUpdate: vi.fn(),
}));

vi.mock('stripe', () => {
    class FakeStripe {
        static errors = {};
        customers = { retrieve: h.retrieve, create: h.create };
        constructor(_key: string, _opts?: unknown) { /* noop */ }
    }
    return { default: FakeStripe };
});
vi.mock('../src/lib/prisma', () => ({
    prisma: {
        integrationConfig: { findUnique: h.configFindUnique },
        user: { findUniqueOrThrow: h.userFindUniqueOrThrow, update: h.userUpdate },
    },
}));
vi.mock('../src/utils/crypto', () => ({ decryptConfigSafe: (s: string) => s }));

import { stripeGetOrCreateCustomer } from '../src/lib/stripeService';

const USER = { id: 'user-1', email: 'cliente@example.com', name: 'Cliente Teste', stripeCustomerId: 'cus_old' as string | null };
const stripeError = (message: string, extra: Record<string, unknown>) => Object.assign(new Error(message), extra);

beforeEach(() => {
    vi.clearAllMocks();
    h.configFindUnique.mockResolvedValue({
        provider: 'STRIPE', enabled: true, environment: 'sandbox',
        config: JSON.stringify({ sandbox: { secretKey: 'sk_test_GOC00001', publishableKey: 'pk_test_x', webhookSecret: 'whsec_x' } }),
    });
    h.userFindUniqueOrThrow.mockResolvedValue({ ...USER });
    h.userUpdate.mockResolvedValue({});
    h.create.mockResolvedValue({ id: 'cus_new' });
});

describe('stripeGetOrCreateCustomer (AC-5)', () => {
    it('Customer existente → devolve o id atual, sem criar nem regravar', async () => {
        h.retrieve.mockResolvedValue({ id: 'cus_old' });
        await expect(stripeGetOrCreateCustomer('user-1')).resolves.toBe('cus_old');
        expect(h.retrieve).toHaveBeenCalledWith('cus_old');
        expect(h.create).not.toHaveBeenCalled();
        expect(h.userUpdate).not.toHaveBeenCalled();
    });

    it('usuário ainda sem Customer → cria e grava (sem consultar)', async () => {
        h.userFindUniqueOrThrow.mockResolvedValue({ ...USER, stripeCustomerId: null });
        await expect(stripeGetOrCreateCustomer('user-1')).resolves.toBe('cus_new');
        expect(h.retrieve).not.toHaveBeenCalled();
        expect(h.create).toHaveBeenCalledWith({ email: 'cliente@example.com', name: 'Cliente Teste', metadata: { userId: 'user-1' } });
        expect(h.userUpdate).toHaveBeenCalledWith({ where: { id: 'user-1' }, data: { stripeCustomerId: 'cus_new' } });
    });

    it('Customer ausente (resource_missing, raw.code ou 404) → cria outro e grava o novo id', async () => {
        const missing = [
            stripeError('No such customer', { code: 'resource_missing', statusCode: 404 }),
            stripeError('No such customer', { raw: { code: 'resource_missing' } }),
            stripeError('Not found', { statusCode: 404 }),
        ];
        for (const err of missing) {
            vi.clearAllMocks();
            h.retrieve.mockRejectedValueOnce(err);
            await expect(stripeGetOrCreateCustomer('user-1')).resolves.toBe('cus_new');
            expect(h.create).toHaveBeenCalledTimes(1);
            expect(h.userUpdate).toHaveBeenCalledWith({ where: { id: 'user-1' }, data: { stripeCustomerId: 'cus_new' } });
        }
    });

    it('Customer apagado no Stripe ({ deleted: true }) → cria outro e grava', async () => {
        h.retrieve.mockResolvedValue({ id: 'cus_old', deleted: true });
        await expect(stripeGetOrCreateCustomer('user-1')).resolves.toBe('cus_new');
        expect(h.create).toHaveBeenCalledTimes(1);
        expect(h.userUpdate).toHaveBeenCalledWith({ where: { id: 'user-1' }, data: { stripeCustomerId: 'cus_new' } });
    });

    it('erro transitório (conexão, 429, 500, credencial) PROPAGA: não cria Customer nem troca o stripeCustomerId', async () => {
        const transient = [
            stripeError('An error occurred with our connection to Stripe.', { type: 'StripeConnectionError' }),
            stripeError('Too many requests', { statusCode: 429, code: 'rate_limit' }),
            stripeError('Internal error', { statusCode: 500 }),
            stripeError('Invalid API Key', { statusCode: 401 }),
        ];
        for (const err of transient) {
            h.retrieve.mockRejectedValueOnce(err);
            await expect(stripeGetOrCreateCustomer('user-1')).rejects.toThrow(err.message);
        }
        expect(h.retrieve).toHaveBeenCalledTimes(transient.length);
        expect(h.create).not.toHaveBeenCalled();
        expect(h.userUpdate).not.toHaveBeenCalled();
    });
});

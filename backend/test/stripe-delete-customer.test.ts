import { describe, it, expect, vi, beforeEach } from 'vitest';

// exclusao-auth-10: stripeDeleteCustomer apaga o Customer no Stripe (delete físico do cliente) e é
// tolerante a Customer já removido. Stripe, prisma e crypto mocados — nenhuma chamada de rede ou banco.
const h = vi.hoisted(() => ({
    del: vi.fn(),
    findUnique: vi.fn(),
}));

vi.mock('stripe', () => {
    class FakeStripe {
        static errors = {};
        customers = { del: h.del };
        constructor(_key: string, _opts?: unknown) { /* noop */ }
    }
    return { default: FakeStripe };
});
vi.mock('../src/lib/prisma', () => ({ prisma: { integrationConfig: { findUnique: h.findUnique } } }));
vi.mock('../src/utils/crypto', () => ({ decryptConfigSafe: (s: string) => s }));

import { stripeDeleteCustomer } from '../src/lib/stripeService';
import * as stripeService from '../src/lib/stripeService';

beforeEach(() => {
    vi.clearAllMocks();
    h.findUnique.mockResolvedValue({
        provider: 'STRIPE', enabled: true, environment: 'sandbox',
        config: JSON.stringify({ sandbox: { secretKey: 'sk_test_DEL00001', publishableKey: 'pk_test_x', webhookSecret: 'whsec_x' } }),
    });
});

describe('stripeDeleteCustomer', () => {
    it('é exportado (userDeletion o procura em runtime) e apaga o Customer', async () => {
        expect(typeof (stripeService as Record<string, unknown>).stripeDeleteCustomer).toBe('function');
        h.del.mockResolvedValue({ id: 'cus_1', deleted: true });
        await stripeDeleteCustomer('cus_1');
        expect(h.del).toHaveBeenCalledWith('cus_1');
    });

    it('Customer já removido / inexistente (resource_missing, 404) → sucesso silencioso', async () => {
        h.del.mockRejectedValueOnce(Object.assign(new Error('No such customer'), { code: 'resource_missing', statusCode: 404 }));
        await expect(stripeDeleteCustomer('cus_gone')).resolves.toBeUndefined();
        h.del.mockRejectedValueOnce(Object.assign(new Error('Not found'), { statusCode: 404 }));
        await expect(stripeDeleteCustomer('cus_gone2')).resolves.toBeUndefined();
    });

    it('outros erros propagam (o chamador trata como best-effort); id vazio não chama o Stripe', async () => {
        h.del.mockRejectedValueOnce(Object.assign(new Error('boom'), { statusCode: 500 }));
        await expect(stripeDeleteCustomer('cus_err')).rejects.toThrow('boom');
        await stripeDeleteCustomer('');
        expect(h.del).toHaveBeenCalledTimes(1);
    });
});

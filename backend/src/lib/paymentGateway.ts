// ─── Payment Gateway Orchestrator ───────────────────────
// Central routing layer that dispatches payment creation to the
// correct provider (Cora for PIX/Boleto, Stripe for Cartão)
// Falls back to mock data when integrations are not configured.

import { coraCreateBoleto, isCoraEnabled, type CoraBoletoPayload } from './coraService';
import { stripeCreatePaymentIntent, stripeGetOrCreateCustomer, isStripeEnabled } from './stripeService';
import { prisma } from './prisma';

// ─── Global Provider Routing ────────────────────────────
// Fixed mapping: which provider handles which payment method.
// This is the SINGLE SOURCE OF TRUTH for the entire system.

export const PROVIDER_MAP: Record<string, 'STRIPE' | 'CORA'> = {
    CARTAO: 'STRIPE',
    PIX: 'CORA',
    BOLETO: 'CORA',
};

/** Returns only payment methods that are BOTH admin-active AND have their provider enabled. */
export async function getAvailablePaymentMethods() {
    const methods = await prisma.paymentMethodConfig.findMany({
        where: { active: true },
        orderBy: { sortOrder: 'asc' },
    });

    const integrations = await prisma.integrationConfig.findMany();
    const enabledProviders = new Set(
        integrations.filter(i => i.enabled).map(i => i.provider)
    );

    return methods.filter(m => {
        const provider = PROVIDER_MAP[m.key];
        // If no provider mapping exists, keep it (future-proof)
        return !provider || enabledProviders.has(provider);
    });
}

/** Check if a specific payment method is currently allowed. */
export async function isPaymentMethodAllowed(method: string): Promise<boolean> {
    const available = await getAvailablePaymentMethods();
    return available.some(m => m.key === method.toUpperCase());
}

/** Throws an error if the method is not available. Use as a guard in endpoints. */
export async function validatePaymentMethod(method: string): Promise<void> {
    if (!(await isPaymentMethodAllowed(method))) {
        throw new PaymentMethodDisabledError(method);
    }
}

/** Get the provider for a given method key. */
export function getProviderForMethod(method: string): 'STRIPE' | 'CORA' {
    return PROVIDER_MAP[method.toUpperCase()] || 'CORA';
}

/** Custom error for disabled payment methods — caught by route handlers to return 400. */
export class PaymentMethodDisabledError extends Error {
    constructor(method: string) {
        super(`Método de pagamento "${method.toUpperCase()}" não está disponível no momento.`);
        this.name = 'PaymentMethodDisabledError';
    }
}

// ─── Types ───────────────────────────────────────────────

export interface CreatePaymentOpts {
    paymentMethod: 'PIX' | 'BOLETO' | 'CARTAO';
    amount: number;        // in cents
    description: string;
    customer: {
        name: string;
        email: string;
        cpf?: string;
    };
    dueDate: Date;
    paymentId: string;     // internal Payment record ID
    contractId?: string;
    userId?: string;       // needed for Stripe PaymentIntent flow
    frontendUrl?: string;  // base URL for success/cancel redirects
}

export interface PaymentResult {
    provider: 'CORA' | 'STRIPE' | 'MOCK';
    providerRef: string | null;
    pixString: string | null;
    boletoUrl: string | null;
    paymentUrl: string | null;
    clientSecret: string | null; // Stripe PaymentIntent secret for inline card payment
    qrCodeBase64: string | null;
}

// ─── Mock Data (fallback when no integration configured) ─

function generateMockResult(opts: CreatePaymentOpts): PaymentResult {
    const mockId = `mock-${opts.paymentId.slice(0, 8)}`;

    if (opts.paymentMethod === 'PIX') {
        return {
            provider: 'MOCK',
            providerRef: mockId,
            pixString: '00020126580014br.gov.bcb.pix0136123e4567-e89b-12d3-a456-426614174000520400005303986540510.005802BR5913Buzios Studio6008BuziosRJ62070503***63041A2B',
            boletoUrl: null,
            paymentUrl: null,
            clientSecret: null,
            qrCodeBase64: null,
        };
    }

    if (opts.paymentMethod === 'BOLETO') {
        return {
            provider: 'MOCK',
            providerRef: mockId,
            pixString: null,
            boletoUrl: `https://cora.br/boleto/${mockId}.pdf`,
            paymentUrl: null,
            clientSecret: null,
            qrCodeBase64: null,
        };
    }

    // CARTAO
    return {
        provider: 'MOCK',
        providerRef: mockId,
        pixString: null,
        boletoUrl: null,
        paymentUrl: null,
        clientSecret: `pi_mock_secret_${mockId}`,
        qrCodeBase64: null,
    };
}

// ─── Public API ──────────────────────────────────────────

export async function createPayment(opts: CreatePaymentOpts): Promise<PaymentResult> {
    const { paymentMethod } = opts;

    // ─── PIX: Cora boleto with PIX QR code ───────────────
    if (paymentMethod === 'PIX') {
        const coraEnabled = await isCoraEnabled();
        if (!coraEnabled) {
            console.log('[Gateway] Cora not configured, using mock for PIX');
            return generateMockResult(opts);
        }

        try {
            const result = await coraCreateBoleto({
                amount: opts.amount,
                dueDate: opts.dueDate.toISOString().split('T')[0],
                customer: {
                    name: opts.customer.name,
                    email: opts.customer.email,
                    document: {
                        identity: opts.customer.cpf || '00000000000',
                        type: (opts.customer.cpf && opts.customer.cpf.length > 11) ? 'CNPJ' : 'CPF',
                    },
                },
                description: opts.description,
                withPixQrCode: true,
            });

            return {
                provider: 'CORA',
                providerRef: result.id,
                pixString: result.pixString || null,
                boletoUrl: result.boletoUrl || null,
                paymentUrl: null,
                clientSecret: null,
                qrCodeBase64: result.qrCodeBase64 || null,
            };
        } catch (err) {
            console.error('[Gateway] Cora PIX creation failed, falling back to mock:', err);
            return generateMockResult(opts);
        }
    }

    // ─── BOLETO: Cora boleto puro ────────────────────────
    if (paymentMethod === 'BOLETO') {
        const coraEnabled = await isCoraEnabled();
        if (!coraEnabled) {
            console.log('[Gateway] Cora not configured, using mock for BOLETO');
            return generateMockResult(opts);
        }

        try {
            const result = await coraCreateBoleto({
                amount: opts.amount,
                dueDate: opts.dueDate.toISOString().split('T')[0],
                customer: {
                    name: opts.customer.name,
                    email: opts.customer.email,
                    document: {
                        identity: opts.customer.cpf || '00000000000',
                        type: (opts.customer.cpf && opts.customer.cpf.length > 11) ? 'CNPJ' : 'CPF',
                    },
                },
                description: opts.description,
                withPixQrCode: false,
            });

            return {
                provider: 'CORA',
                providerRef: result.id,
                pixString: null,
                boletoUrl: result.boletoUrl || null,
                paymentUrl: null,
                clientSecret: null,
                qrCodeBase64: null,
            };
        } catch (err) {
            console.error('[Gateway] Cora BOLETO creation failed, falling back to mock:', err);
            return generateMockResult(opts);
        }
    }

    // ─── CARTAO: Stripe PaymentIntent (inline Elements) ──
    if (paymentMethod === 'CARTAO') {
        const stripeEnabled = await isStripeEnabled();
        if (!stripeEnabled) {
            console.log('[Gateway] Stripe not configured, using mock for CARTAO');
            return generateMockResult(opts);
        }

        if (!opts.userId) {
            console.error('[Gateway] userId is required for Stripe PaymentIntent flow');
            return generateMockResult(opts);
        }

        try {
            const customerId = await stripeGetOrCreateCustomer(opts.userId);
            const result = await stripeCreatePaymentIntent({
                amount: opts.amount,
                customerId,
                description: opts.description,
                paymentId: opts.paymentId,
                userId: opts.userId,
                contractId: opts.contractId,
                installmentsEnabled: true,
            });

            return {
                provider: 'STRIPE',
                providerRef: result.paymentIntentId,
                pixString: null,
                boletoUrl: null,
                paymentUrl: null,
                clientSecret: result.clientSecret,
                qrCodeBase64: null,
            };
        } catch (err) {
            console.error('[Gateway] Stripe PaymentIntent creation failed, falling back to mock:', err);
            return generateMockResult(opts);
        }
    }

    // Fallback
    return generateMockResult(opts);
}

/** Update a Payment record with gateway results */
export async function updatePaymentWithGatewayResult(paymentId: string, result: PaymentResult): Promise<void> {
    await prisma.payment.update({
        where: { id: paymentId },
        data: {
            provider: result.provider === 'MOCK' ? 'CORA' : result.provider as any,
            providerRef: result.providerRef,
            pixString: result.pixString,
            boletoUrl: result.boletoUrl,
            paymentUrl: result.paymentUrl,
        },
    });
}

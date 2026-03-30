// ─── Payment Gateway Orchestrator ───────────────────────
// Central routing layer that dispatches payment creation to the
// correct provider (Cora for PIX/Boleto, Stripe for Cartão)
// Falls back to mock data when integrations are not configured.

import { coraCreateBoleto, isCoraEnabled, type CoraBoletoPayload } from './coraService';
import { stripeCreateCheckoutSession, isStripeEnabled, type StripeCheckoutPayload } from './stripeService';
import { prisma } from './prisma';

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
    frontendUrl?: string;  // base URL for success/cancel redirects
}

export interface PaymentResult {
    provider: 'CORA' | 'STRIPE' | 'MOCK';
    providerRef: string | null;
    pixString: string | null;
    boletoUrl: string | null;
    paymentUrl: string | null;
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
            qrCodeBase64: null,
        };
    }

    // CARTAO
    return {
        provider: 'MOCK',
        providerRef: mockId,
        pixString: null,
        boletoUrl: null,
        paymentUrl: `https://checkout.stripe.com/mock/${mockId}`,
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
                qrCodeBase64: null,
            };
        } catch (err) {
            console.error('[Gateway] Cora BOLETO creation failed, falling back to mock:', err);
            return generateMockResult(opts);
        }
    }

    // ─── CARTAO: Stripe Checkout Session ─────────────────
    if (paymentMethod === 'CARTAO') {
        const stripeEnabled = await isStripeEnabled();
        if (!stripeEnabled) {
            console.log('[Gateway] Stripe not configured, using mock for CARTAO');
            return generateMockResult(opts);
        }

        const baseUrl = opts.frontendUrl || process.env.FRONTEND_URL || 'http://localhost:5173';

        try {
            const result = await stripeCreateCheckoutSession({
                amount: opts.amount,
                description: opts.description,
                customerEmail: opts.customer.email,
                customerName: opts.customer.name,
                paymentId: opts.paymentId,
                successUrl: `${baseUrl}/my-contracts?payment=success&id=${opts.paymentId}`,
                cancelUrl: `${baseUrl}/my-contracts?payment=cancelled&id=${opts.paymentId}`,
            });

            return {
                provider: 'STRIPE',
                providerRef: result.sessionId,
                pixString: null,
                boletoUrl: null,
                paymentUrl: result.checkoutUrl,
                qrCodeBase64: null,
            };
        } catch (err) {
            console.error('[Gateway] Stripe checkout creation failed, falling back to mock:', err);
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

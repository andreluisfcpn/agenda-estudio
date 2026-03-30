// ─── Stripe Payment Service ─────────────────────────────
// Handles Checkout Sessions and Payment Intents via Stripe API
// Docs: https://docs.stripe.com/api

import Stripe from 'stripe';
import { prisma } from './prisma';

// ─── Types ───────────────────────────────────────────────

interface StripeConfig {
    secretKey: string;
    publishableKey: string;
    webhookSecret: string;
}

export interface StripeCheckoutPayload {
    amount: number;          // in cents (BRL)
    description: string;
    customerEmail: string;
    customerName: string;
    paymentId: string;       // our internal payment ID for metadata
    successUrl: string;
    cancelUrl: string;
    installments?: number;   // number of installments (parcelas)
}

export interface StripeCheckoutResult {
    sessionId: string;
    checkoutUrl: string;
    paymentIntentId?: string;
}

// ─── Helpers ─────────────────────────────────────────────

async function getStripeConfig(): Promise<{ config: StripeConfig; environment: string } | null> {
    const integration = await prisma.integrationConfig.findUnique({ where: { provider: 'STRIPE' } });
    if (!integration || !integration.enabled) return null;
    try {
        const config = JSON.parse(integration.config) as StripeConfig;
        return { config, environment: integration.environment };
    } catch {
        return null;
    }
}

async function getStripeClient(): Promise<Stripe> {
    const setup = await getStripeConfig();
    if (!setup) throw new Error('Stripe integration not configured or disabled');

    return new Stripe(setup.config.secretKey, {
        apiVersion: '2025-02-24.acacia' as any,
        typescript: true,
    });
}

// ─── Public API ──────────────────────────────────────────

export async function stripeCreateCheckoutSession(payload: StripeCheckoutPayload): Promise<StripeCheckoutResult> {
    const stripe = await getStripeClient();

    const sessionParams: Stripe.Checkout.SessionCreateParams = {
        payment_method_types: ['card'],
        mode: 'payment',
        currency: 'brl',
        customer_email: payload.customerEmail,
        line_items: [{
            price_data: {
                currency: 'brl',
                product_data: {
                    name: payload.description,
                    description: `Pagamento - ${payload.customerName}`,
                },
                unit_amount: payload.amount,
            },
            quantity: 1,
        }],
        metadata: {
            paymentId: payload.paymentId,
            customerName: payload.customerName,
        },
        success_url: payload.successUrl,
        cancel_url: payload.cancelUrl,
    };

    // Add installments support for Brazilian cards
    if (payload.installments && payload.installments > 1) {
        sessionParams.payment_method_options = {
            card: {
                installments: { enabled: true },
            },
        };
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    return {
        sessionId: session.id,
        checkoutUrl: session.url || '',
        paymentIntentId: typeof session.payment_intent === 'string'
            ? session.payment_intent
            : session.payment_intent?.id,
    };
}

export async function stripeGetPaymentIntent(paymentIntentId: string): Promise<Stripe.PaymentIntent> {
    const stripe = await getStripeClient();
    return stripe.paymentIntents.retrieve(paymentIntentId);
}

export async function stripeCreateRefund(paymentIntentId: string, amount?: number): Promise<Stripe.Refund> {
    const stripe = await getStripeClient();
    return stripe.refunds.create({
        payment_intent: paymentIntentId,
        ...(amount ? { amount } : {}),
    });
}

export async function stripeGetSession(sessionId: string): Promise<Stripe.Checkout.Session> {
    const stripe = await getStripeClient();
    return stripe.checkout.sessions.retrieve(sessionId);
}

/** Verify Stripe webhook signature */
export async function stripeVerifyWebhook(body: string | Buffer, signature: string): Promise<Stripe.Event> {
    const setup = await getStripeConfig();
    if (!setup) throw new Error('Stripe not configured');

    const stripe = new Stripe(setup.config.secretKey, {
        apiVersion: '2025-02-24.acacia' as any,
    });

    return stripe.webhooks.constructEvent(body, signature, setup.config.webhookSecret);
}

/** Test connectivity — tries to list recent events */
export async function stripeTestConnection(): Promise<{ success: boolean; message: string }> {
    try {
        const stripe = await getStripeClient();
        // Simple API call to verify credentials
        const balance = await stripe.balance.retrieve();
        const available = balance.available.find(b => b.currency === 'brl');
        const amountStr = available ? `R$ ${(available.amount / 100).toFixed(2)}` : 'N/A';
        return {
            success: true,
            message: `Conexão Stripe OK! Saldo disponível: ${amountStr}`,
        };
    } catch (err) {
        const msg = err instanceof Error ? err.message : 'Erro desconhecido';
        return { success: false, message: `Falha na conexão: ${msg}` };
    }
}

/** Check if Stripe integration is configured and enabled */
export async function isStripeEnabled(): Promise<boolean> {
    const setup = await getStripeConfig();
    return setup !== null;
}

/** Get the publishable key for frontend */
export async function stripeGetPublishableKey(): Promise<string | null> {
    const setup = await getStripeConfig();
    return setup?.config.publishableKey || null;
}

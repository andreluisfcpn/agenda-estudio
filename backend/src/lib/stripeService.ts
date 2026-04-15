// ─── Stripe Payment Service ─────────────────────────────
// Handles Checkout Sessions and Payment Intents via Stripe API
// Docs: https://docs.stripe.com/api

import Stripe from 'stripe';
import { prisma } from './prisma';
import { getErrorMessage } from '../utils/errors';

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

import { decryptConfigSafe } from '../utils/crypto';

// Stripe client cache (TTL-based to pick up config changes)
let cachedStripeClient: Stripe | null = null;
let cachedStripeConfigHash: string | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function getStripeConfig(): Promise<{ config: StripeConfig; environment: string } | null> {
    const integration = await prisma.integrationConfig.findUnique({ where: { provider: 'STRIPE' } });
    if (!integration || !integration.enabled) return null;
    try {
        const decrypted = decryptConfigSafe(integration.config);
        const config = JSON.parse(decrypted) as StripeConfig;
        return { config, environment: integration.environment };
    } catch {
        return null;
    }
}

async function getStripeClient(): Promise<Stripe> {
    const now = Date.now();

    // Return cached client if still valid
    if (cachedStripeClient && (now - cacheTimestamp) < CACHE_TTL_MS) {
        return cachedStripeClient;
    }

    const setup = await getStripeConfig();
    if (!setup) throw new Error('Stripe integration not configured or disabled');

    // Check if config changed (invalidate cache on key rotation)
    const configHash = setup.config.secretKey.slice(-8);
    if (cachedStripeClient && configHash === cachedStripeConfigHash) {
        cacheTimestamp = now;
        return cachedStripeClient;
    }

    cachedStripeClient = new Stripe(setup.config.secretKey, {
        apiVersion: '2026-03-25.dahlia' as Stripe.LatestApiVersion,
    });
    cachedStripeConfigHash = configHash;
    cacheTimestamp = now;

    return cachedStripeClient;
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
        apiVersion: '2026-03-25.dahlia' as Stripe.LatestApiVersion,
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
    } catch (err: unknown) {
        const msg = getErrorMessage(err);
        // Provide more helpful error messages
        if (msg.includes('Invalid API Key') || (err instanceof Stripe.errors.StripeAuthenticationError)) {
            return { success: false, message: 'Secret Key inválida. Verifique se a chave começa com sk_test_ ou sk_live_.' };
        }
        if (msg.includes('network') || msg.includes('ECONNREFUSED')) {
            return { success: false, message: 'Erro de rede. Verifique sua conexão com a internet.' };
        }
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

// ─── Customer Management ────────────────────────────────

/** Get or create a Stripe Customer linked to our User */
export async function stripeGetOrCreateCustomer(userId: string): Promise<string> {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const stripe = await getStripeClient();

    // Verify existing Stripe Customer
    if (user.stripeCustomerId) {
        try {
            const customer = await stripe.customers.retrieve(user.stripeCustomerId);
            if (!customer.deleted) {
                return user.stripeCustomerId;
            }
            console.warn(`[Stripe] Customer ${user.stripeCustomerId} was deleted. Creating a new one.`);
        } catch (err: unknown) {
            console.warn(`[Stripe] Error retrieving customer ${user.stripeCustomerId} (e.g. absent in test mode). Creating a new one.`, getErrorMessage(err));
        }
    }

    const customer = await stripe.customers.create({
        email: user.email || undefined,
        name: user.name,
        metadata: { userId: user.id },
    });

    await prisma.user.update({
        where: { id: userId },
        data: { stripeCustomerId: customer.id },
    });

    return customer.id;
}

// ─── Payment Intents ────────────────────────────────────

export interface CreatePaymentIntentOpts {
    amount: number;            // in cents (BRL)
    customerId: string;        // Stripe Customer ID
    description: string;
    paymentId: string;         // our internal Payment ID
    userId: string;
    contractId?: string;
    installmentsEnabled?: boolean;
    savedPaymentMethodId?: string; // if paying with saved card
    offSession?: boolean;
    paymentMethodTypes?: string[];
    savePaymentMethod?: boolean; // save card for future use
}

export interface PaymentIntentResult {
    clientSecret: string;
    paymentIntentId: string;
    status: string;
}

/** Create a PaymentIntent for inline card payment */
export async function stripeCreatePaymentIntent(opts: CreatePaymentIntentOpts): Promise<PaymentIntentResult> {
    const stripe = await getStripeClient();

    const params: Stripe.PaymentIntentCreateParams = {
        amount: opts.amount,
        currency: 'brl',
        customer: opts.customerId,
        description: opts.description,
        // Save card for future use when customer opts in
        ...(opts.savePaymentMethod && { setup_future_usage: 'on_session' as const }),
        metadata: {
            paymentId: opts.paymentId,
            userId: opts.userId,
            ...(opts.contractId && { contractId: opts.contractId }),
        },
    };

    if (opts.paymentMethodTypes) {
        params.payment_method_types = opts.paymentMethodTypes;
    } else {
        params.automatic_payment_methods = { enabled: true };
    }

    // Enable installments for card payments
    if (opts.installmentsEnabled) {
        params.payment_method_options = {
            card: {
                installments: { enabled: true },
            },
        };
    }

    // If using a saved payment method, attach and confirm (on-session or off-session)
    if (opts.savedPaymentMethodId) {
        params.payment_method = opts.savedPaymentMethodId;
        params.confirm = true; // Always confirm when using a saved PM
        if (opts.offSession) {
            params.off_session = true;
        }
    }

    const intent = await stripe.paymentIntents.create(params, {
        idempotencyKey: `pi-${opts.paymentId}-${opts.amount}`,
    });

    return {
        clientSecret: intent.client_secret || '',
        paymentIntentId: intent.id,
        status: intent.status,
    };
}

// ─── Setup Intents (Save Card Without Charging) ─────────

/** Create a SetupIntent so the client can save a card */
export async function stripeCreateSetupIntent(customerId: string): Promise<{ clientSecret: string; setupIntentId: string }> {
    const stripe = await getStripeClient();

    const intent = await stripe.setupIntents.create({
        customer: customerId,
        payment_method_types: ['card'],
        usage: 'off_session', // allow future off-session charges
    });

    return {
        clientSecret: intent.client_secret || '',
        setupIntentId: intent.id,
    };
}

// ─── Payment Method Management ──────────────────────────

export interface StripeCardInfo {
    paymentMethodId: string;
    brand: string;
    last4: string;
    expMonth: number;
    expYear: number;
    funding: string; // 'credit' | 'debit' | 'prepaid' | 'unknown'
}

/** List all card payment methods for a Stripe Customer */
export async function stripeListPaymentMethods(customerId: string): Promise<StripeCardInfo[]> {
    const stripe = await getStripeClient();
    const methods = await stripe.paymentMethods.list({
        customer: customerId,
        type: 'card',
    });

    return methods.data.map(pm => ({
        paymentMethodId: pm.id,
        brand: pm.card?.brand || 'unknown',
        last4: pm.card?.last4 || '0000',
        expMonth: pm.card?.exp_month || 0,
        expYear: pm.card?.exp_year || 0,
        funding: pm.card?.funding || 'unknown',
    }));
}

/** Detach a payment method from a customer */
export async function stripeDetachPaymentMethod(paymentMethodId: string): Promise<void> {
    const stripe = await getStripeClient();
    await stripe.paymentMethods.detach(paymentMethodId);
}

/** Set a customer's default payment method */
export async function stripeSetDefaultPaymentMethod(customerId: string, paymentMethodId: string): Promise<void> {
    const stripe = await getStripeClient();
    await stripe.customers.update(customerId, {
        invoice_settings: { default_payment_method: paymentMethodId },
    });
}

// ─── Subscriptions (Recurring Payments) ─────────────────

export interface CreateSubscriptionOpts {
    customerId: string;
    amount: number;             // monthly amount in cents (BRL)
    description: string;
    paymentMethodId: string;    // saved card to charge
    paymentId: string;          // our internal first payment ID
    contractId?: string;
    userId: string;
    durationMonths?: number;    // optional: auto-cancel after N months
}

export interface SubscriptionResult {
    subscriptionId: string;
    clientSecret?: string; // if requires payment confirmation (3D Secure)
    status: string;
}

/** Create a Stripe Subscription for recurring billing */
export async function stripeCreateSubscription(opts: CreateSubscriptionOpts): Promise<SubscriptionResult> {
    const stripe = await getStripeClient();

    // Create a one-time Product + Price dynamically
    const product = await stripe.products.create({
        name: opts.description,
        metadata: { userId: opts.userId },
    });

    const price = await stripe.prices.create({
        product: product.id,
        unit_amount: opts.amount,
        currency: 'brl',
        recurring: { interval: 'month' },
    });

    // Attach payment method as default for the customer
    await stripeSetDefaultPaymentMethod(opts.customerId, opts.paymentMethodId);

    const subParams: Stripe.SubscriptionCreateParams = {
        customer: opts.customerId,
        items: [{ price: price.id }],
        default_payment_method: opts.paymentMethodId,
        payment_settings: {
            payment_method_types: ['card'],
            save_default_payment_method: 'on_subscription',
        },
        payment_behavior: 'default_incomplete',
        expand: ['latest_invoice.payment_intent'],
        metadata: {
            paymentId: opts.paymentId,
            userId: opts.userId,
            ...(opts.contractId && { contractId: opts.contractId }),
        },
    };

    if (opts.durationMonths) {
        const cancelAt = new Date();
        cancelAt.setMonth(cancelAt.getMonth() + opts.durationMonths);
        subParams.cancel_at = Math.floor(cancelAt.getTime() / 1000);
    }

    const subscription = await stripe.subscriptions.create(subParams);

    // Extract client secret if first invoice requires confirmation
    let clientSecret: string | undefined;
    const latestInvoice = subscription.latest_invoice;
    if (latestInvoice && typeof latestInvoice !== 'string') {
        // payment_intent exists at runtime but isn't exposed in all SDK type versions
        const pi = (latestInvoice as unknown as Record<string, unknown>).payment_intent;
        if (pi && typeof pi === 'object' && pi !== null && 'client_secret' in pi) {
            clientSecret = (pi as { client_secret?: string }).client_secret || undefined;
        }
    }

    return {
        subscriptionId: subscription.id,
        clientSecret,
        status: subscription.status,
    };
}

/** Cancel a Stripe Subscription */
export async function stripeCancelSubscription(subscriptionId: string): Promise<void> {
    const stripe = await getStripeClient();
    await stripe.subscriptions.cancel(subscriptionId);
}

// ─── Off-Session Charging ───────────────────────────────

/** Charge a saved card without the customer being present */
export async function stripeChargeOffSession(
    customerId: string,
    paymentMethodId: string,
    amount: number,
    metadata: Record<string, string>,
): Promise<PaymentIntentResult> {
    return stripeCreatePaymentIntent({
        amount,
        customerId,
        description: metadata.description || 'Cobrança automática',
        paymentId: metadata.paymentId || '',
        userId: metadata.userId || '',
        contractId: metadata.contractId,
        savedPaymentMethodId: paymentMethodId,
        offSession: true,
    });
}

// ─── Installment Plan Calculation ───────────────────────

export interface InstallmentPlan {
    count: number;
    perInstallment: number;
    total: number;
    feePercent: number;
    freeOfCharge: boolean; // true = studio absorbs the fee
}

/** Calculate available installment plans for a given amount */
export async function stripeGetInstallmentPlans(
    amount: number,
    contractDurationMonths: number,
): Promise<InstallmentPlan[]> {
    const plans: InstallmentPlan[] = [];

    // Get fee rates from BusinessConfig
    const feeConfigs = await prisma.businessConfig.findMany({
        where: { key: { startsWith: 'card_fee_' } },
    });
    const feeMap: Record<number, number> = {};
    for (const fc of feeConfigs) {
        const match = fc.key.match(/card_fee_(\d+)x_pct/);
        if (match) feeMap[parseInt(match[1])] = parseFloat(fc.value);
    }

    for (let n = 1; n <= 12; n++) {
        const freeOfCharge = n <= contractDurationMonths;
        const feePercent = n === 1 ? 0 : (freeOfCharge ? 0 : (feeMap[n] || feeMap[6] || 5));
        const total = n === 1 ? amount : Math.round(amount * (1 + feePercent / 100));
        const perInstallment = Math.round(total / n);

        plans.push({ count: n, perInstallment, total, feePercent, freeOfCharge });
    }

    return plans;
}


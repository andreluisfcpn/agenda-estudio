// ─── Stripe Payment Service ─────────────────────────────
// Handles Checkout Sessions and Payment Intents via Stripe API
// Docs: https://docs.stripe.com/api

import Stripe from 'stripe';
import { prisma } from './prisma.js';
import { getErrorMessage } from '../utils/errors.js';
import { CONFIG_DEFAULT_VALUES } from '../config/businessConfigCatalog.js';

// ─── Types ───────────────────────────────────────────────

/** Credentials for a single Stripe environment (sandbox or production) */
interface StripeCredentials {
    secretKey: string;
    publishableKey: string;
    webhookSecret: string;
}

/**
 * Dual-environment config stored in IntegrationConfig.config (encrypted JSON).
 * Both sandbox and production credentials are stored together.
 * The admin selects which environment is active via IntegrationConfig.environment.
 */
interface StripeConfigDual {
    sandbox?: StripeCredentials;
    production?: StripeCredentials;
}

// ─── Helpers ─────────────────────────────────────────────

import { decryptConfigSafe } from '../utils/crypto.js';

// Stripe client cache (TTL-based to pick up config changes)
let cachedStripeClient: Stripe | null = null;
let cachedStripeConfigHash: string | null = null;
let cachedStripeEnvironment: string | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function isDualConfig(parsed: any): parsed is StripeConfigDual {
    return parsed && (typeof parsed.sandbox === 'object' || typeof parsed.production === 'object');
}

async function getStripeConfig(): Promise<{ config: StripeCredentials; environment: string } | null> {
    const integration = await prisma.integrationConfig.findUnique({ where: { provider: 'STRIPE' } });
    if (!integration || !integration.enabled) return null;
    try {
        const decrypted = decryptConfigSafe(integration.config);
        const parsed = JSON.parse(decrypted);

        const environment = (integration.environment === 'production' ? 'production' : 'sandbox') as 'sandbox' | 'production';

        let credentials: StripeCredentials | undefined;

        if (isDualConfig(parsed)) {
            credentials = parsed[environment];
            // Self-heal: recover flat credentials orphaned at the top level by the (briefly
            // buggy) dual-format merge — see the matching note in coraService.getCoraConfig.
            // Legacy flat creds are ALWAYS sandbox → only recover them for the sandbox env.
            if (environment === 'sandbox' && !credentials?.secretKey && (parsed as any).secretKey) {
                const flat = parsed as StripeCredentials;
                credentials = {
                    secretKey: flat.secretKey,
                    publishableKey: flat.publishableKey,
                    webhookSecret: flat.webhookSecret,
                    ...(credentials || {}),
                };
            }
            if (!credentials?.secretKey) {
                console.warn(`[Stripe] No credentials configured for environment "${environment}"`);
                return null;
            }
        } else {
            // Legacy flat format → treat as sandbox credentials
            credentials = parsed as StripeCredentials;
            if (environment === 'production') {
                console.warn('[Stripe] Legacy flat config detected but environment is "production". Using flat credentials anyway.');
            }
        }

        return { config: credentials, environment };
    } catch {
        return null;
    }
}

async function getStripeClient(): Promise<Stripe> {
    const now = Date.now();
    const setup = await getStripeConfig();
    if (!setup) throw new Error('Stripe integration not configured or disabled');

    // Return cached client if still valid AND environment hasn't changed
    const configHash = setup.config.secretKey.slice(-8);
    if (
        cachedStripeClient &&
        (now - cacheTimestamp) < CACHE_TTL_MS &&
        configHash === cachedStripeConfigHash &&
        setup.environment === cachedStripeEnvironment
    ) {
        return cachedStripeClient;
    }

    cachedStripeClient = new Stripe(setup.config.secretKey, {
        apiVersion: '2026-03-25.dahlia' as Stripe.LatestApiVersion,
    });
    cachedStripeConfigHash = configHash;
    cachedStripeEnvironment = setup.environment;
    cacheTimestamp = now;

    return cachedStripeClient;
}

// ─── Public API ──────────────────────────────────────────

export async function stripeGetPaymentIntent(paymentIntentId: string): Promise<Stripe.PaymentIntent> {
    const stripe = await getStripeClient();
    return stripe.paymentIntents.retrieve(paymentIntentId);
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
        const setup = await getStripeConfig();
        const env = setup?.environment || 'unknown';
        // Simple API call to verify credentials
        const balance = await stripe.balance.retrieve();
        const available = balance.available.find(b => b.currency === 'brl');
        const amountStr = available ? `R$ ${(available.amount / 100).toFixed(2)}` : 'N/A';

        // The balance call above only proves the SECRET key works. The client
        // checkout also needs a valid Publishable Key (pk_) to load Stripe.js —
        // validate it here so a swapped/empty pk doesn't pass the test silently.
        const pk = setup?.config.publishableKey || '';
        if (!pk.startsWith('pk_')) {
            return {
                success: false,
                message: 'Secret Key OK, mas a Publishable Key está ausente ou inválida. Cole a chave que começa com "pk_" (não a sk_) no campo Publishable Key.',
            };
        }
        // Soft check: warn (don't fail) on test/live mismatch — legacy flat
        // configs legitimately mix prefixes, so this must never block a save.
        const expectedPkPrefix = env === 'production' ? 'pk_live_' : 'pk_test_';
        const envNote = pk.startsWith(expectedPkPrefix)
            ? ''
            : ` ⚠️ A Publishable Key não parece ser do ambiente "${env}" (esperado "${expectedPkPrefix}").`;

        return {
            success: true,
            message: `Conexão Stripe OK! Saldo: ${amountStr} (ambiente: ${env}).${envNote}`,
        };
    } catch (err: unknown) {
        const msg = getErrorMessage(err);
        // Provide more helpful error messages
        if (msg.includes('Invalid API Key') || (err instanceof Stripe.errors.StripeAuthenticationError)) {
            return { success: false, message: 'Secret Key inválida. Verifique se a chave começa com sk_ (ou rk_ para chave restrita).' };
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
        // Disable redirect-based methods to avoid requiring return_url
        params.automatic_payment_methods = { enabled: true, allow_redirects: 'never' };
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

    // Idempotency key must cover EVERY parameter that changes the PaymentIntent
    // body — otherwise a retry that flips the save-card toggle, changes the
    // installment plan, or switches on/off-session reuses a prior key with
    // different params and Stripe rejects it ("Keys for idempotent requests can
    // only be used with the same parameters they were first used with").
    const idempotencyKey = [
        'pi', opts.paymentId, opts.amount,
        opts.savedPaymentMethodId || 'new',
        opts.savePaymentMethod ? 'save' : 'nosave',
        opts.installmentsEnabled ? 'inst' : 'noinst',
        opts.offSession ? 'off' : 'on',
        opts.paymentMethodTypes ? opts.paymentMethodTypes.join('.') : 'auto',
    ].join('-');

    const intent = await stripe.paymentIntents.create(params, {
        idempotencyKey,
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
    // paymentId is the only field that makes two same-amount/same-card charges
    // unique in the idempotency key — never default it to '' or two distinct
    // charges would collide and the second would be silently skipped.
    if (!metadata.paymentId) {
        throw new Error('paymentId é obrigatório para cobrança off-session.');
    }
    return stripeCreatePaymentIntent({
        amount,
        customerId,
        description: metadata.description || 'Cobrança automática',
        paymentId: metadata.paymentId,
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

    // Central card-installment tariff (1x..12x → %) — single source for all card
    // services. Admin-editable via BusinessConfig; falls back to the catalog default.
    const surchargeRow = await prisma.businessConfig.findUnique({ where: { key: 'card_installment_surcharges' } });
    let tariff: Record<string, number> = {};
    try {
        tariff = JSON.parse(surchargeRow?.value ?? CONFIG_DEFAULT_VALUES.card_installment_surcharges ?? '{}');
    } catch { tariff = {}; }
    // Ultimate fallback for any installment count missing from the table.
    const defaultFeeRow = await prisma.businessConfig.findUnique({ where: { key: 'card_fee_default_pct' } });
    const defaultFeePct = parseFloat(defaultFeeRow?.value ?? CONFIG_DEFAULT_VALUES.card_fee_default_pct ?? '0');

    for (let n = 1; n <= 12; n++) {
        // Contract benefit: installments within the contract's duration are absorbed (free).
        const freeOfCharge = n <= contractDurationMonths;
        const tariffRate = tariff[String(n)];
        const feePercent = n === 1 ? 0 : (freeOfCharge ? 0 : (tariffRate != null ? tariffRate : defaultFeePct));
        const total = n === 1 ? amount : Math.round(amount * (1 + feePercent / 100));
        const perInstallment = Math.round(total / n);

        plans.push({ count: n, perInstallment, total, feePercent, freeOfCharge });
    }

    return plans;
}


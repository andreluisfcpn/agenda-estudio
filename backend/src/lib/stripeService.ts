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

        // Guard: uma config sem secretKey (ex.: flat/legado só com publishableKey, ou vazia)
        // faria getStripeClient estourar em `secretKey.slice(...)` com "reading 'slice'".
        // Trata como "não configurado" para retornar um erro limpo em vez de um TypeError.
        if (!credentials?.secretKey) {
            console.warn('[Stripe] No secretKey configured — treating Stripe as not configured.');
            return null;
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

// ─── Parcelamento no cartão: capacidade da conta ─────────

/**
 * Países cuja conta Stripe oferece parcelamento do emissor (docs.stripe.com/payments/installments: México —
 * meses sin intereses — e Japão). A conta BRASILEIRA não oferece. Verificado no modo teste em 23/09/2026:
 * `available_plans` vem sempre vazio (pm_card_br, pm_card_mx, pm_card_visa) e confirmar com
 * `installments.plan` (direto ou por ConfirmationToken) é recusado pelo Stripe ("The selected installment plan
 * is not supported for this payment method"). Se o Stripe liberar o Brasil, inclua 'BR': o cartão SALVO já
 * confirma no servidor com o plano conferido; o cartão NOVO segue recusando N > 1 até existir a confirmação no
 * servidor por ConfirmationToken (Elements em modo diferido + `stripe.createConfirmationToken` no navegador →
 * endpoint confirma o PI com `confirmation_token` + `installments.plan` do teto → `stripe.handleNextAction`).
 */
export const STRIPE_INSTALLMENT_ACCOUNT_COUNTRIES: readonly string[] = ['MX', 'JP'];

export function accountCountrySupportsCardInstallments(country: string | null | undefined): boolean {
    return !!country && STRIPE_INSTALLMENT_ACCOUNT_COUNTRIES.includes(country.toUpperCase());
}

let installmentSupportCache: { key: string; supported: boolean; expiresAt: number } | null = null;
const INSTALLMENT_SUPPORT_TTL_MS = 6 * 60 * 60 * 1000; // o país da conta não muda
const INSTALLMENT_SUPPORT_FAIL_TTL_MS = 60 * 1000;

/**
 * A conta Stripe ativa oferece parcelamento no cartão? Lê o país da conta (cache por credencial). Na dúvida
 * (Stripe não configurado, chave restrita sem leitura da conta, rede) responde NÃO — nunca oferecer N× que o
 * gateway não entrega (ele cobraria 1× o total, com os juros do app).
 */
export async function stripeCardInstallmentsSupported(): Promise<boolean> {
    let setup: Awaited<ReturnType<typeof getStripeConfig>> = null;
    try { setup = await getStripeConfig(); } catch { setup = null; }
    if (!setup) return false;
    const key = `${setup.environment}:${setup.config.secretKey.slice(-8)}`;
    const now = Date.now();
    if (installmentSupportCache && installmentSupportCache.key === key && installmentSupportCache.expiresAt > now) {
        return installmentSupportCache.supported;
    }
    try {
        const stripe = await getStripeClient();
        const account = await stripe.accounts.retrieveCurrent();
        const supported = accountCountrySupportsCardInstallments(account.country);
        installmentSupportCache = { key, supported, expiresAt: now + INSTALLMENT_SUPPORT_TTL_MS };
        return supported;
    } catch (err) {
        console.warn('[Stripe] país da conta indisponível — parcelamento no cartão desativado:', getErrorMessage(err));
        installmentSupportCache = { key, supported: false, expiresAt: now + INSTALLMENT_SUPPORT_FAIL_TTL_MS };
        return false;
    }
}

/**
 * D1 / pagamentos-1: o servidor só cobra em N× (N > 1) quando ELE fixa o plano na confirmação — cartão SALVO
 * (confirmado aqui com `installments.plan`, conferido em `available_plans`) numa conta que oferece
 * parcelamento. O cartão NOVO é confirmado no navegador (Payment Element): o nº de parcelas ficaria a critério
 * do seletor do Stripe (furando o teto da política) ou seria ignorado (1× do total, com os juros do app).
 * Devolve a mensagem de recusa (nada é cobrado) ou null quando pode seguir.
 */
export function cardInstallmentsBlockReason(opts: { installments: number; savedCard: boolean; gatewaySupported: boolean }): string | null {
    if (!(opts.installments > 1)) return null;
    if (!opts.gatewaySupported) {
        return 'O parcelamento no cartão não está disponível no momento. Pague em 1x no cartão ou use o PIX.';
    }
    if (!opts.savedCard) {
        return `Para parcelar em ${opts.installments}x, salve o cartão e pague com o cartão salvo — ou pague em 1x.`;
    }
    return null;
}

// ─── Public API ──────────────────────────────────────────

export async function stripeGetPaymentIntent(paymentIntentId: string): Promise<Stripe.PaymentIntent> {
    const stripe = await getStripeClient();
    return stripe.paymentIntents.retrieve(paymentIntentId);
}

/**
 * Cancela um PaymentIntent abandonado (varredura de reservas/contratos não pagos, D2). Tolerante:
 * se o PI já estiver cancelado/pago/processando (o cancel falha), relê e devolve o estado REAL —
 * quem chama decide (succeeded → confirmar; processing → aguardar). Só lança se nem a leitura der.
 * Cancelável pelo Stripe em: requires_payment_method, requires_confirmation, requires_action,
 * requires_capture e (raramente) processing.
 */
export async function stripeCancelPaymentIntent(paymentIntentId: string): Promise<{ status: Stripe.PaymentIntent.Status; canceled: boolean }> {
    const stripe = await getStripeClient();
    try {
        const pi = await stripe.paymentIntents.cancel(paymentIntentId, { cancellation_reason: 'abandoned' });
        return { status: pi.status, canceled: pi.status === 'canceled' };
    } catch (err) {
        const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
        if (pi.status !== 'canceled') {
            console.warn(`[Stripe] cancelar PI ${paymentIntentId} recusado (status=${pi.status}):`, getErrorMessage(err));
        }
        return { status: pi.status, canceled: pi.status === 'canceled' };
    }
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

/**
 * Apaga o Customer no Stripe (exclusão física do cliente — exclusao-auth-10). `customers.del` também
 * desvincula os cartões salvos e encerra as assinaturas do Customer. Idempotente: Customer já apagado
 * ou inexistente (404 / resource_missing) conta como sucesso. Demais erros propagam (o chamador decide;
 * userDeletion trata como best-effort).
 */
export async function stripeDeleteCustomer(customerId: string): Promise<void> {
    if (!customerId) return;
    const stripe = await getStripeClient();
    try {
        await stripe.customers.del(customerId);
    } catch (err: unknown) {
        const e = err as { code?: string; statusCode?: number; raw?: { code?: string } };
        if (e?.code === 'resource_missing' || e?.raw?.code === 'resource_missing' || e?.statusCode === 404) {
            console.warn(`[Stripe] Customer ${customerId} já não existe — nada a apagar.`);
            return;
        }
        throw err;
    }
}

// ─── Payment Intents ────────────────────────────────────

export interface CreatePaymentIntentOpts {
    amount: number;            // in cents (BRL)
    customerId: string;        // Stripe Customer ID
    description: string;
    paymentId: string;         // our internal Payment ID
    userId: string;
    contractId?: string;
    /** Pedido de parcelamento. Só vira `installments.enabled` no PI junto de um plano fixado (cartão salvo, N > 1). */
    installmentsEnabled?: boolean;
    savedPaymentMethodId?: string; // if paying with saved card
    offSession?: boolean;
    paymentMethodTypes?: string[];
    savePaymentMethod?: boolean; // save card for future use
    /**
     * Nº de parcelas escolhido no app (> 1) para cartão SALVO (confirmação no servidor). O plano
     * `fixed_count` só pode ser enviado na confirmação — então o PI é criado sem confirmar, o plano
     * é conferido em `available_plans` do cartão e o PI é confirmado COM o plano. Se o cartão não
     * oferecer esse parcelamento, o PI é cancelado e nada é cobrado (antes: cobrava 1x silenciosamente).
     * No cartão NOVO (Payment Element) a confirmação é no navegador: o plano não passa por aqui e o PI sai
     * SEM parcelamento — N > 1 com cartão novo é recusado antes, em POST /stripe/create-payment.
     */
    installmentPlanCount?: number;
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

    // Saved card + installment plan (> 1x): confirm in a SECOND step, with the plan (see below).
    const planCount = opts.savedPaymentMethodId && opts.installmentsEnabled && (opts.installmentPlanCount ?? 1) > 1
        ? Math.floor(opts.installmentPlanCount!)
        : 0;

    // Parcelamento só é habilitado no PI quando o SERVIDOR fixa o plano (cartão salvo, N > 1). Sem plano
    // fixado (cartão novo no Payment Element, PIs criados na contratação/reserva) o `installments.enabled`
    // deixaria o seletor do próprio Stripe escolher qualquer plano do emissor — ou, numa conta sem
    // parcelamento (BR), seria ignorado e o total cairia em 1× (pagamentos-1 / cobertura-1).
    if (planCount > 1) {
        params.payment_method_options = {
            card: {
                installments: { enabled: true },
            },
        };
    }

    // If using a saved payment method, attach and confirm (on-session or off-session)
    if (opts.savedPaymentMethodId) {
        params.payment_method = opts.savedPaymentMethodId;
        params.confirm = planCount === 0; // confirm now — unless a plan must be chosen first
        if (opts.offSession && planCount === 0) {
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
        // Mantido pelo pedido do chamador (estabilidade das chaves já emitidas); o corpo só leva
        // `installments` quando há plano — e aí o sufixo `plan${N}` abaixo distingue a chave.
        opts.installmentsEnabled ? 'inst' : 'noinst',
        opts.offSession ? 'off' : 'on',
        opts.paymentMethodTypes ? opts.paymentMethodTypes.join('.') : 'auto',
        // Só acrescenta quando há plano: a chave dos fluxos sem plano (ex.: auto-charge) não muda.
        ...(planCount > 1 ? [`plan${planCount}`] : []),
    ].join('-');

    const intent = await stripe.paymentIntents.create(params, {
        idempotencyKey,
    });

    if (planCount > 1) {
        // Fluxo de parcelamento do Stripe (BR/MX): com installments.enabled e o cartão anexado, o PI
        // lista os planos que ESTE cartão aceita; o plano escolhido vai na confirmação.
        const available = intent.payment_method_options?.card?.installments?.available_plans ?? [];
        const offered = available.some(p => p.type === 'fixed_count' && p.count === planCount && (p.interval ?? 'month') === 'month');
        if (!offered) {
            try { await stripe.paymentIntents.cancel(intent.id, { cancellation_reason: 'abandoned' }); } catch { /* best-effort */ }
            throw new Error(`O parcelamento em ${planCount}x não está disponível para este cartão. Escolha outra quantidade de parcelas ou pague à vista.`);
        }
        const confirmed = await stripe.paymentIntents.confirm(intent.id, {
            payment_method_options: {
                card: { installments: { plan: { type: 'fixed_count', count: planCount, interval: 'month' } } },
            },
            ...(opts.offSession ? { off_session: true } : {}),
        }, { idempotencyKey: `${idempotencyKey}-confirm` });
        return {
            clientSecret: confirmed.client_secret || '',
            paymentIntentId: confirmed.id,
            status: confirmed.status,
        };
    }

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


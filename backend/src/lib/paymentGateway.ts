// ─── Payment Gateway Orchestrator ───────────────────────
// Central routing layer that dispatches payment creation to the
// correct provider (Cora for PIX/Boleto, Stripe for Cartão)
// Falls back to mock data when integrations are not configured.

import { coraCreateBoleto, isCoraEnabled, type CoraBoletoPayload } from './coraService.js';
import { sicoobCreatePix, sicoobAllowedEnvironment, SANDBOX_TEST_PIX_KEY, SANDBOX_TEST_MERCHANT_NAME, SANDBOX_TEST_MERCHANT_CITY } from './sicoobService.js';
import { resolvePixProvider, toSicoobTxid, mergePaymentMetadata, PIX_DEFAULT_EXPIRES_SECONDS, PIX_MIN_EXPIRES_SECONDS } from './pixGateway.js';
import { stripeCreatePaymentIntent, stripeGetOrCreateCustomer, isStripeEnabled } from './stripeService.js';
import { prisma } from './prisma.js';
import { cleanDocument, isValidCpfCnpj } from '../utils/document.js';
import { buildStaticBrCode } from './brcode.js';

/**
 * Cora REJECTS payments whose customer document is not a real CPF/CNPJ
 * (e.g. the old '00000000000' fallback) with a cryptic 400. Resolve and
 * validate the document up-front so callers get a clear, actionable error
 * instead of an orphaned PENDING payment with no QR code.
 */
function resolveCoraDocument(cpf: string | undefined | null): { identity: string; type: 'CPF' | 'CNPJ' } {
    const cleaned = cleanDocument(cpf);
    if (!isValidCpfCnpj(cleaned)) {
        throw new Error('CPF/CNPJ inválido ou ausente no cadastro. Atualize seu perfil com um CPF válido antes de pagar via PIX ou boleto.');
    }
    return { identity: cleaned, type: cleaned.length > 11 ? 'CNPJ' : 'CPF' };
}

/**
 * Single up-front guard for every Cora (PIX/boleto) dispatch. Validates the
 * inputs Cora strictly checks — document, positive amount, a non-blank payer
 * email, and a due_date that is not in the past — so a bad value fails fast
 * with a clear message instead of a cryptic Cora 400 that leaves an orphan
 * PENDING payment. Mirrors the placeholder-email behavior of coraPaymentHelper.
 */
function resolveCoraInputs(opts: CreatePaymentOpts): { doc: { identity: string; type: 'CPF' | 'CNPJ' }; email: string; dueDateStr: string } {
    if (!Number.isInteger(opts.amount) || opts.amount <= 0) {
        throw new Error('Valor do pagamento inválido (deve ser maior que zero).');
    }
    const doc = resolveCoraDocument(opts.customer.cpf);
    const email = (opts.customer.email && opts.customer.email.trim()) || 'cliente@estudio.com';
    // Cora rejects an invoice whose due_date is in the past — clamp to today.
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const due = opts.dueDate && opts.dueDate >= today ? opts.dueDate : today;
    const dueDateStr = due.toISOString().split('T')[0]!;
    return { doc, email, dueDateStr };
}

// ─── Global Provider Routing ────────────────────────────
// Fixed mapping: which provider handles which payment method.
// This is the SINGLE SOURCE OF TRUTH for the entire system.

export const PROVIDER_MAP: Record<string, 'STRIPE' | 'CORA' | 'SICOOB'> = {
    CARTAO: 'STRIPE',
    // PIX é DINÂMICO: atendido por SICOOB ou CORA conforme o que o admin habilitar
    // (ver resolvePixProvider / getAvailablePaymentMethods). 'SICOOB' aqui é só o padrão.
    PIX: 'SICOOB',
    BOLETO: 'CORA',
};

/** Returns only payment methods that are BOTH admin-active AND have their provider enabled. */
export async function getAvailablePaymentMethods() {
    const methods = await prisma.paymentMethodConfig.findMany({
        where: { active: true },
        orderBy: { sortOrder: 'asc' },
    });

    const integrations = await prisma.integrationConfig.findMany();

    // In dev: if no IntegrationConfig records exist at all, skip provider filter
    // This prevents blocking the wizard when the table hasn't been seeded
    if (integrations.length === 0 && process.env.NODE_ENV !== 'production') {
        return methods;
    }

    // Trava por deploy (só Sicoob): espelha resolvePixProvider — um Sicoob habilitado num
    // ambiente proibido pelo deploy (NODE_ENV) NÃO conta como provedor disponível, senão o
    // checkout ofereceria PIX que o roteamento depois recusa.
    const allowedSicoobEnv = sicoobAllowedEnvironment();
    const enabledProviders = new Set(
        integrations
            .filter(i => i.enabled)
            .filter(i => i.provider !== 'SICOOB' || i.environment === allowedSicoobEnv)
            .map(i => i.provider)
    );

    return methods.filter(m => {
        const key = m.key.toUpperCase();
        // PIX é dinâmico: disponível se QUALQUER provedor de PIX (Sicoob OU Cora) estiver habilitado.
        if (key === 'PIX') {
            return enabledProviders.has('SICOOB') || enabledProviders.has('CORA');
        }
        const provider = PROVIDER_MAP[key];
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

/** Get the provider for a given method key. Placeholder inicial — o provider REAL do PIX
 *  é resolvido dinamicamente e persistido por updatePaymentWithGatewayResult. */
export function getProviderForMethod(method: string): 'STRIPE' | 'CORA' | 'SICOOB' {
    return PROVIDER_MAP[method.toUpperCase()] || 'SICOOB';
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
    /** PIX: validade da cobrança em segundos (default 3600). Ex.: serviço = 10 min (D2). */
    expiresSeconds?: number;
}

export interface PaymentResult {
    provider: 'CORA' | 'SICOOB' | 'STRIPE' | 'MOCK';
    providerRef: string | null;
    pixString: string | null;
    boletoUrl: string | null;
    paymentUrl: string | null;
    clientSecret: string | null; // Stripe PaymentIntent secret for inline card payment
    qrCodeBase64: string | null;
    /** PIX: fim da validade da cobrança emitida (persistido em Payment.pixExpiresAt). */
    expiresAt?: Date | null;
    /** PIX: valor (centavos) para o qual a cobrança foi emitida — base do reuso em issuePixCharge. */
    chargeAmount?: number | null;
}

function pixExpiresSeconds(opts: CreatePaymentOpts): number {
    return Math.max(PIX_MIN_EXPIRES_SECONDS, Math.round(opts.expiresSeconds ?? PIX_DEFAULT_EXPIRES_SECONDS));
}

// ─── Mock Data (fallback when no integration configured) ─
// SÓ fora de produção (quem chama garante). O PIX mock é um BR Code VÁLIDO com o valor REAL
// (antes era um EMV fixo de R$10,00 com CRC inválido, que nenhum banco lia).

function generateMockResult(opts: CreatePaymentOpts): PaymentResult {
    const mockId = `mock-${opts.paymentId.slice(0, 8)}`;

    if (opts.paymentMethod === 'PIX') {
        if (process.env.NODE_ENV === 'production') {
            // Defesa em profundidade: nunca entregar QR falso em produção.
            throw new Error('Nenhum provedor de PIX disponível. Tente novamente ou use outro método de pagamento.');
        }
        return {
            provider: 'MOCK',
            providerRef: mockId,
            // Chave FICTÍCIA e recebedor "TESTE…" (pagamentos-12): o QR de dev é lido, mas nunca pagável.
            pixString: buildStaticBrCode({
                key: SANDBOX_TEST_PIX_KEY,
                amountCents: opts.amount,
                txid: toSicoobTxid(opts.paymentId),
                merchantName: SANDBOX_TEST_MERCHANT_NAME,
                city: SANDBOX_TEST_MERCHANT_CITY,
            }),
            boletoUrl: null,
            paymentUrl: null,
            clientSecret: null,
            qrCodeBase64: null,
            expiresAt: new Date(Date.now() + pixExpiresSeconds(opts) * 1000),
            chargeAmount: opts.amount,
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

    // ─── PIX: Sicoob ou Cora (roteamento dinâmico) ───────
    if (paymentMethod === 'PIX') {
        const pixProvider = await resolvePixProvider();
        if (!pixProvider) {
            // D15: em produção, sem provedor PIX é ERRO (nunca QR mock). Em dev, mock válido.
            if (process.env.NODE_ENV === 'production') {
                throw new Error('Nenhum provedor de PIX está habilitado. Use outro método de pagamento ou contate o estúdio.');
            }
            console.log('[Gateway] Nenhum provedor de PIX configurado, usando mock (dev)');
            return generateMockResult(opts);
        }

        // Validate inputs up-front (outside try) so a missing CPF / invalid
        // amount / past due-date surfaces a clear error instead of a masked
        // generic PIX failure that strands an orphan PENDING payment.
        const pix = resolveCoraInputs(opts);

        // ── SICOOB ──
        if (pixProvider === 'SICOOB') {
            try {
                const result = await sicoobCreatePix({
                    amount: opts.amount,
                    txid: toSicoobTxid(opts.paymentId),
                    description: opts.description,
                    customer: { name: opts.customer.name, document: pix.doc },
                    expiresSeconds: pixExpiresSeconds(opts),
                });
                if (!result.pixString) {
                    throw new Error('O Sicoob não retornou o código PIX. Tente novamente em instantes.');
                }
                return {
                    provider: 'SICOOB',
                    providerRef: result.id,
                    pixString: result.pixString,
                    boletoUrl: null,
                    paymentUrl: null,
                    clientSecret: null,
                    qrCodeBase64: result.qrCodeBase64 || null,
                    expiresAt: result.expiresAt,
                    chargeAmount: opts.amount,
                };
            } catch (err) {
                console.error('[Gateway] Sicoob PIX creation failed:', err);
                if (process.env.NODE_ENV === 'production') {
                    throw new Error('Erro ao gerar PIX. Tente novamente ou use outro método de pagamento.');
                }
                console.log('[Gateway] Falling back to mock for PIX (dev only)');
                return generateMockResult(opts);
            }
        }

        // ── CORA ──
        try {
            const result = await coraCreateBoleto({
                amount: opts.amount,
                dueDate: pix.dueDateStr,
                customer: {
                    name: opts.customer.name,
                    email: pix.email,
                    document: pix.doc,
                },
                description: opts.description,
                withPixQrCode: true,
                idempotencyKey: opts.paymentId,
            });

            // A 2xx Cora response without an EMV string is unpayable — treat it
            // as a failure so the caller returns an error instead of a blank QR
            // that the client would poll forever.
            if (!result.pixString) {
                throw new Error('A Cora não retornou o código PIX. Tente novamente em instantes.');
            }

            return {
                provider: 'CORA',
                providerRef: result.id,
                pixString: result.pixString,
                boletoUrl: result.boletoUrl || null,
                paymentUrl: null,
                clientSecret: null,
                qrCodeBase64: result.qrCodeBase64 || null,
                // A Cora vence por dia: registra a validade pedida (≤ 24h) como limite de reuso.
                expiresAt: new Date(Date.now() + Math.min(pixExpiresSeconds(opts), 24 * 3600) * 1000),
                chargeAmount: opts.amount,
            };
        } catch (err) {
            console.error('[Gateway] Cora PIX creation failed:', err);
            if (process.env.NODE_ENV === 'production') {
                throw new Error('Erro ao gerar PIX. Tente novamente ou use outro método de pagamento.');
            }
            console.log('[Gateway] Falling back to mock for PIX (dev only)');
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

        // Validate inputs up-front (outside try) so a missing CPF / invalid
        // amount / past due-date surfaces a clear error instead of a masked
        // generic boleto failure that strands an orphan PENDING payment.
        const boleto = resolveCoraInputs(opts);

        try {
            const result = await coraCreateBoleto({
                amount: opts.amount,
                dueDate: boleto.dueDateStr,
                customer: {
                    name: opts.customer.name,
                    email: boleto.email,
                    document: boleto.doc,
                },
                description: opts.description,
                withPixQrCode: false,
                idempotencyKey: opts.paymentId,
            });

            if (!result.boletoUrl) {
                throw new Error('A Cora não retornou o boleto. Tente novamente em instantes.');
            }

            return {
                provider: 'CORA',
                providerRef: result.id,
                pixString: null,
                boletoUrl: result.boletoUrl,
                paymentUrl: null,
                clientSecret: null,
                qrCodeBase64: null,
            };
        } catch (err) {
            console.error('[Gateway] Cora BOLETO creation failed:', err);
            if (process.env.NODE_ENV === 'production') {
                throw new Error('Erro ao gerar boleto. Tente novamente ou use outro método de pagamento.');
            }
            console.log('[Gateway] Falling back to mock for BOLETO (dev only)');
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
            console.error('[Gateway] Stripe PaymentIntent creation failed:', err);
            if (process.env.NODE_ENV === 'production') {
                throw new Error('Erro ao processar cartão. Tente novamente.');
            }
            console.log('[Gateway] Falling back to mock for CARTAO (dev only)');
            return generateMockResult(opts);
        }
    }

    // Fallback
    return generateMockResult(opts);
}

/**
 * Update a Payment record with gateway results. Para PIX também grava a validade (pixExpiresAt) e
 * o controle `metadata.pixCharge` (emissão nº 1 + valor emitido), preservando o resto do metadata
 * (ex.: contractData do /self, installmentCap do serviço) — é o que permite ao issuePixCharge
 * reaproveitar esta cobrança enquanto viva e com o mesmo valor.
 */
export async function updatePaymentWithGatewayResult(paymentId: string, result: PaymentResult): Promise<void> {
    let metadata: ReturnType<typeof mergePaymentMetadata> | undefined;
    if (result.pixString) {
        const current = await prisma.payment.findUnique({ where: { id: paymentId }, select: { metadata: true, amount: true } });
        metadata = mergePaymentMetadata(current?.metadata, {
            pixCharge: {
                attempt: 1,
                amount: result.chargeAmount ?? current?.amount,
                ...(result.providerRef ? { txid: result.providerRef } : {}),
            },
        });
    }
    await prisma.payment.update({
        where: { id: paymentId },
        data: {
            provider: result.provider === 'MOCK'
                // Heurística só para o fallback MOCK (dev sem provedor). PIX default = Sicoob.
                ? (result.pixString ? 'SICOOB' : result.paymentUrl ? 'STRIPE' : 'SICOOB')
                : result.provider,
            providerRef: result.providerRef,
            pixString: result.pixString,
            pixExpiresAt: result.pixString ? (result.expiresAt ?? null) : null,
            boletoUrl: result.boletoUrl,
            paymentUrl: result.paymentUrl,
            ...(metadata !== undefined ? { metadata } : {}),
        },
    });
}

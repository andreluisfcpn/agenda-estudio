// ─── Cartões salvos (SavedPaymentMethod × Stripe) ───────
// Fonte única para "este cartão é DESTE usuário?" — usada pelo create-payment (cartão salvo do dono do
// pagamento, inclusive quando o admin cobra o cliente — E1), pela ativação da cobrança automática
// (/contracts/:id/subscribe — E9) e pelo cadastro de cartão por SetupIntent.
// Um cartão é aceito pelo id do SavedPaymentMethod OU pelo pm_… do Stripe, e só quando pertence ao
// usuário: linha dele no banco, ou (ainda não sincronizado pelo webhook) anexado ao Customer dele no Stripe.

import { prisma } from './prisma.js';
import { stripeGetCard, isStripeEnabled, stripeSetDefaultPaymentMethod } from './stripeService.js';

export interface UserCard {
    /** id do SavedPaymentMethod (null = o cartão existe só no Stripe e não foi sincronizado). */
    id: string | null;
    stripePaymentMethodId: string;
    brand: string;
    last4: string;
    expMonth: number;
    expYear: number;
    /** credit | debit | prepaid | unknown — null quando não foi conferido no Stripe. */
    funding: string | null;
    isDefault: boolean;
}

export interface ResolveUserCardOpts {
    /**
     * Confere o cartão no Stripe mesmo quando já está no banco: traz o `funding` e recusa (null) um cartão
     * que não existe mais ou não está anexado ao Customer do usuário. Falha de rede/credencial PROPAGA.
     */
    verify?: boolean;
    /** Grava no banco o cartão que só existe no Stripe (mesma linha que o webhook setup_intent.succeeded cria). */
    sync?: boolean;
}

const isUniqueViolation = (err: unknown) => (err as { code?: string } | null)?.code === 'P2002';

/** Cartões que a cobrança automática recusa (E9: só crédito). `unknown` segue — o Stripe nem sempre classifica. */
export function isNonCreditFunding(funding: string | null | undefined): boolean {
    return funding === 'debit' || funding === 'prepaid';
}

/**
 * Resolve um cartão do USUÁRIO a partir do id do SavedPaymentMethod ou do pm_… do Stripe.
 * null = o cartão não é deste usuário (ou não existe). Nunca devolve cartão de outro cliente.
 */
export async function resolveUserCard(userId: string, ref: string, opts: ResolveUserCardOpts = {}): Promise<UserCard | null> {
    const cardRef = (ref || '').trim();
    if (!cardRef) return null;

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { stripeCustomerId: true } });
    if (!user) return null;

    const saved = await prisma.savedPaymentMethod.findFirst({
        where: { userId, OR: [{ id: cardRef }, { stripePaymentMethodId: cardRef }] },
    });

    if (saved && !opts.verify) {
        return {
            id: saved.id, stripePaymentMethodId: saved.stripePaymentMethodId, brand: saved.brand, last4: saved.last4,
            expMonth: saved.expMonth, expYear: saved.expYear, funding: null, isDefault: saved.isDefault,
        };
    }

    const pmId = saved?.stripePaymentMethodId ?? (cardRef.startsWith('pm_') ? cardRef : null);
    if (!pmId || !user.stripeCustomerId) return null;

    let card: Awaited<ReturnType<typeof stripeGetCard>>;
    try {
        card = await stripeGetCard(pmId);
    } catch (err) {
        // Com `verify` a conferência é obrigatória (quem chama responde 502). Sem ela, um cartão que não
        // está no banco e não pôde ser conferido não é aceito.
        if (opts.verify) throw err;
        return null;
    }
    if (!card || card.customerId !== user.stripeCustomerId) return null;

    let row = saved;
    if (!row && opts.sync) {
        try {
            const count = await prisma.savedPaymentMethod.count({ where: { userId } });
            row = await prisma.savedPaymentMethod.create({
                data: {
                    userId, stripePaymentMethodId: card.paymentMethodId, brand: card.brand, last4: card.last4,
                    expMonth: card.expMonth, expYear: card.expYear, isDefault: count === 0,
                },
            });
        } catch (err) {
            // Corrida com o webhook setup_intent.succeeded (stripePaymentMethodId é único): usa a linha dele.
            if (!isUniqueViolation(err)) throw err;
            row = await prisma.savedPaymentMethod.findFirst({ where: { userId, stripePaymentMethodId: card.paymentMethodId } });
            if (!row) return null; // o pm está salvo para OUTRO usuário
        }
    }

    return {
        id: row?.id ?? null,
        stripePaymentMethodId: card.paymentMethodId,
        brand: card.brand, last4: card.last4, expMonth: card.expMonth, expYear: card.expYear,
        funding: card.funding,
        isDefault: row?.isDefault ?? false,
    };
}

/**
 * Cartão que a cobrança automática usa para este usuário: o padrão (isDefault) ou, sem padrão, o mais
 * recente — a MESMA escolha do autoChargeJob. null = nenhum cartão salvo.
 */
export async function autoChargeCardFor(userId: string) {
    return (await prisma.savedPaymentMethod.findFirst({ where: { userId, isDefault: true } }))
        ?? (await prisma.savedPaymentMethod.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } }));
}

/** Mensagem da troca de cartão padrão recusada por não ser crédito com a cobrança automática LIGADA. */
export const DEFAULT_CARD_NOT_CREDIT_MESSAGE = 'Com a cobrança automática ligada, o cartão padrão precisa ser de crédito. Desligue a cobrança automática ou escolha um cartão de crédito.';

export type AutoChargeCardCheck =
    | { ok: true; card: UserCard }
    /** Recusa pronta para a rota: `res.status(status).json(body)`. */
    | { ok: false; status: number; body: { error: string; code?: string } };

export interface CheckAutoChargeCardOpts {
    /**
     * Confere ESTE cartão (id do SavedPaymentMethod ou pm_…) — o que vai virar o padrão — em vez do
     * cartão que o autoChargeJob cobraria hoje (autoChargeCardFor).
     */
    cardRef?: string;
    /** Grava no banco o cartão que só existe no Stripe (ver resolveUserCard). */
    sync?: boolean;
    /** Mensagens na 3ª pessoa: o ADMIN ligando a cobrança automática do cliente. */
    forAdmin?: boolean;
    /** Prefixo do log quando o Stripe não responde. */
    logTag?: string;
}

/**
 * E9 "só crédito" — conferência ÚNICA de quem LIGA (ou mantém ligada) a cobrança automática: o cartão que
 * o autoChargeJob vai cobrar (o padrão ou, sem padrão, o mais recente — ou `cardRef`) existe, é do usuário
 * (conferido no Stripe) e é de CRÉDITO. Usada por PUT /stripe/auto-charge, POST /contracts/:id/subscribe,
 * PATCH /users/:id/auto-charge (admin), pela troca do cartão padrão e pela remoção do cartão cobrado.
 * Mesmos status/códigos em todos: 400 (sem cartão, sem código) · 503 (Stripe desligado) · 502 (Stripe não
 * respondeu) · 404 CARD_NOT_FOUND · 400 CARD_NOT_CREDIT. Não grava nada além do `sync` pedido.
 */
export async function checkAutoChargeCard(userId: string, opts: CheckAutoChargeCardOpts = {}): Promise<AutoChargeCardCheck> {
    let ref = opts.cardRef;
    if (!ref) {
        const card = await autoChargeCardFor(userId);
        if (!card) {
            return {
                ok: false, status: 400,
                body: {
                    error: opts.forAdmin
                        ? 'O cliente precisa ter um cartão salvo para ativar a cobrança automática.'
                        : 'Adicione pelo menos um cartão antes de ativar a cobrança automática.',
                },
            };
        }
        ref = card.id;
    }
    if (!(await isStripeEnabled())) {
        return { ok: false, status: 503, body: { error: 'O pagamento com cartão está indisponível no momento. Tente novamente mais tarde.' } };
    }
    let verified: UserCard | null;
    try {
        verified = await resolveUserCard(userId, ref, { verify: true, sync: opts.sync });
    } catch (err) {
        console.error(`${opts.logTag ?? '[AUTO-CHARGE]'} Cartão não pôde ser conferido no Stripe:`, err instanceof Error ? err.message : err);
        return {
            ok: false, status: 502,
            body: {
                error: opts.forAdmin
                    ? 'Não foi possível conferir o cartão do cliente agora. Tente novamente em instantes.'
                    : 'Não foi possível conferir o cartão agora. Tente novamente em instantes.',
            },
        };
    }
    if (!verified) {
        return {
            ok: false, status: 404,
            body: {
                error: opts.forAdmin
                    ? 'O cartão padrão do cliente não foi encontrado. Peça ao cliente para cadastrar o cartão novamente.'
                    : 'Cartão não encontrado. Cadastre o cartão e tente novamente.',
                code: 'CARD_NOT_FOUND',
            },
        };
    }
    if (isNonCreditFunding(verified.funding)) {
        return {
            ok: false, status: 400,
            body: {
                error: opts.forAdmin
                    ? 'O cartão padrão do cliente não é de crédito. A cobrança automática aceita apenas cartão de crédito.'
                    : 'A cobrança automática aceita apenas cartão de crédito.',
                code: 'CARD_NOT_CREDIT',
            },
        };
    }
    return { ok: true, card: verified };
}

/** Marca um cartão salvo como o padrão do usuário (só no banco — a cobrança automática lê daqui). */
export async function setDefaultSavedCard(userId: string, savedId: string): Promise<void> {
    await prisma.$transaction([
        prisma.savedPaymentMethod.updateMany({ where: { userId, id: { not: savedId } }, data: { isDefault: false } }),
        prisma.savedPaymentMethod.updateMany({ where: { userId, id: savedId }, data: { isDefault: true } }),
    ]);
}

/**
 * Z1-a — o cartão COBRADO tem de ser o CONFERIDO: fixa como padrão o cartão que `checkAutoChargeCard` acabou
 * de aprovar, quando ele ainda não é o padrão (caso "sem padrão → o mais recente"). Sem isto, um cartão salvo
 * DEPOIS (nasce sem conferência de tipo) viraria "o mais recente" e assumiria a cobrança automática. Com o
 * padrão fixado, o cartão cobrado só muda pelo PUT …/default ou pela remoção — e os dois conferem.
 * Usada ao LIGAR (PUT /stripe/auto-charge, PATCH /users/:id/auto-charge) e na remoção do cartão cobrado com
 * substituto aprovado. O banco é a fonte do autoChargeJob; o padrão no Stripe é best-effort (só log).
 */
export async function pinAutoChargeCard(userId: string, card: UserCard): Promise<void> {
    if (!card.id || card.isDefault) return;
    await setDefaultSavedCard(userId, card.id);
    try {
        const user = await prisma.user.findUnique({ where: { id: userId }, select: { stripeCustomerId: true } });
        if (user?.stripeCustomerId) await stripeSetDefaultPaymentMethod(user.stripeCustomerId, card.stripePaymentMethodId);
    } catch (err) {
        console.warn(`[AUTO-CHARGE] Cartão padrão não pôde ser definido no Stripe para o usuário ${userId} (best-effort):`, err instanceof Error ? err.message : err);
    }
}

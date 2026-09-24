// ─── PIX Provider Router ────────────────────────────────
// O PIX pode ser atendido por SICOOB ou CORA. O admin habilita um (ou ambos) no
// painel; este módulo resolve qual usar (preferência: Sicoob) e cria a cobrança
// no provedor certo, devolvendo o MESMO formato que o helper da Cora.
//
// D15 — fonte ÚNICA de emissão de QR sob demanda: `issuePixCharge(paymentId)`.
//  • Reusa a cobrança atual SÓ se estiver viva (pixExpiresAt no futuro), com BR Code válido e
//    emitida para o MESMO valor do Payment.
//  • Senão: concilia a anterior no provedor (paga → devolve alreadyPaid), cancela-a e emite uma NOVA
//    com txid de tentativa (1ª emissão = txid legado; 2ª em diante = sufixo). Se a anterior continua
//    pagável e não pôde ser cancelada ('live'), adota-a quando o valor bate; senão NÃO emite (erro
//    amigável) — um pagamento no QR antigo nunca pode ficar sem registro.
//  • Validade: avulso em espera → até o fim da reserva (piso 120s); contrato aguardando
//    pagamento → min(1h, prazo restante); senão 1h.

import QRCode from 'qrcode';
import { prisma } from './prisma.js';
import { Prisma } from '../generated/prisma/client.js';
import { sicoobCreatePix, sicoobAllowedEnvironment, sicoobRemoveCob } from './sicoobService.js';
import { createCoraPayment, type CoraPaymentRequest, type CoraPaymentResponse } from './coraPaymentHelper.js';
import { cleanDocument, isValidCpfCnpj } from '../utils/document.js';
import { isValidBrCode } from './brcode.js';

export type PixProvider = 'SICOOB' | 'CORA';

export const isPixProvider = (p: string | null | undefined): p is PixProvider => p === 'SICOOB' || p === 'CORA';

/** Validade padrão de uma cobrança PIX sem prazo de reserva/contrato (1h). */
export const PIX_DEFAULT_EXPIRES_SECONDS = 3600;
/** Piso de validade: um QR com menos de 2 min não dá tempo de pagar. */
export const PIX_MIN_EXPIRES_SECONDS = 120;
/** Só reusa a cobrança atual se ainda restar pelo menos este tempo de validade. */
const PIX_REUSE_MIN_REMAINING_MS = 60_000;

/** Deriva um txid Sicoob válido (26–35 alfanuméricos) a partir de uma chave estável. */
export function toSicoobTxid(seed: string): string {
    const alnum = (seed || '').replace(/[^a-zA-Z0-9]/g, '');
    // UUID sem hífens = 32 chars (dentro de 26–35). Garante mínimo de 26 com padding determinístico.
    return (alnum.length >= 26 ? alnum : (alnum + '0'.repeat(26)).slice(0, 26)).slice(0, 35);
}

/**
 * txid da N-ésima emissão de PIX de um Payment. A 1ª mantém o txid legado (compatível com os
 * providerRefs já gravados); da 2ª em diante acrescenta a tentativa em base36 — o Sicoob de
 * produção não aceita reemitir uma cob com o mesmo txid, e o txid novo nunca colide com a antiga.
 */
export function pixTxidForAttempt(seed: string, attempt = 1): string {
    const base = toSicoobTxid(seed);
    if (!attempt || attempt <= 1) return base;
    const suffix = Math.floor(attempt).toString(36);
    return base.slice(0, 35 - suffix.length) + suffix;
}

/** Chave de idempotência da Cora por tentativa (a mesma chave devolveria a fatura antiga). */
export function pixIdempotencyKeyForAttempt(key: string, attempt = 1): string {
    return !attempt || attempt <= 1 ? key : `${key}-${Math.floor(attempt)}`;
}

/** Resolve o provedor de PIX ativo. Preferência: Sicoob → Cora. `null` se nenhum habilitado. */
export async function resolvePixProvider(): Promise<PixProvider | null> {
    const integrations = await prisma.integrationConfig.findMany({
        where: { provider: { in: ['SICOOB', 'CORA'] }, enabled: true },
        select: { provider: true, environment: true },
    });
    // Trava por deploy (só Sicoob): se o ambiente ativo do Sicoob não é o permitido por este
    // servidor (NODE_ENV), ele NÃO é selecionável → cai graciosamente na Cora (ou null), em vez
    // de escolher Sicoob e estourar erro no checkout. Espelha o fail-closed de getSicoobConfig.
    const allowedEnv = sicoobAllowedEnvironment();
    const enabled = new Set(
        integrations
            .filter(i => i.provider !== 'SICOOB' || i.environment === allowedEnv)
            .map(i => i.provider),
    );
    if (enabled.has('SICOOB')) return 'SICOOB';
    if (enabled.has('CORA')) return 'CORA';
    return null;
}

/** Há ao menos um provedor de PIX habilitado? */
export async function isAnyPixProviderEnabled(): Promise<boolean> {
    return (await resolvePixProvider()) !== null;
}

export interface PixPaymentRequest extends CoraPaymentRequest {
    /** Chave estável do Payment (id). OBRIGATÓRIA: deriva o txid/Idempotency-Key. */
    idempotencyKey: string;
    /** Nº da emissão (1 = primeira). A partir da 2ª o txid/chave ganham sufixo. */
    attempt?: number;
    /** Validade da cobrança em segundos (Sicoob). Default 3600. */
    expiresSeconds?: number;
}

export interface PixPaymentResponse extends CoraPaymentResponse {
    provider: PixProvider;
    /** Fim da validade da cobrança emitida. */
    expiresAt: Date;
}

function validateDocument(cpfCnpj: string | null | undefined) {
    const docStr = cleanDocument(cpfCnpj);
    if (!isValidCpfCnpj(docStr)) return null;
    return { docStr, docType: docStr.length === 14 ? ('CNPJ' as const) : ('CPF' as const) };
}

/**
 * Cria uma cobrança PIX no provedor ativo (Sicoob ou Cora) para um usuário.
 * Mesmo shape de resposta do `createCoraPayment`, com `provider` e `expiresAt` a mais.
 * @throws se nenhum provedor de PIX estiver habilitado, sem idempotencyKey, usuário não existir
 *         ou CPF inválido.
 */
export async function createPixPayment(req: PixPaymentRequest): Promise<PixPaymentResponse> {
    // Sem chave estável o txid sairia do userId (colidindo entre pagamentos do mesmo cliente).
    if (!req.idempotencyKey || !req.idempotencyKey.trim()) {
        throw new Error('idempotencyKey (id do pagamento) é obrigatória para gerar PIX.');
    }
    const provider = await resolvePixProvider();
    if (!provider) {
        throw new Error('Nenhum provedor de PIX está habilitado. Configure o Sicoob (ou Cora) no painel admin.');
    }
    const attempt = req.attempt && req.attempt > 1 ? Math.floor(req.attempt) : 1;
    const expiresSeconds = Math.max(PIX_MIN_EXPIRES_SECONDS, Math.round(req.expiresSeconds ?? PIX_DEFAULT_EXPIRES_SECONDS));

    if (provider === 'CORA') {
        const res = await createCoraPayment({
            ...req,
            idempotencyKey: pixIdempotencyKeyForAttempt(req.idempotencyKey, attempt),
        });
        // A Cora vence por DIA (não suporta minutos). Registramos a validade PEDIDA (≤ 24h) como
        // limite de reuso — conservador: depois disso o QR é reemitido e a fatura antiga cancelada.
        const expiresAt = new Date(Date.now() + Math.min(expiresSeconds, 24 * 3600) * 1000);
        return { ...res, provider: 'CORA', expiresAt };
    }

    // ─── SICOOB ───
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user) throw new Error('Usuário não encontrado.');
    const doc = validateDocument(user.cpfCnpj);
    if (!doc) {
        throw new Error('CPF/CNPJ não cadastrado ou inválido. Atualize o perfil antes de pagar com PIX.');
    }

    const result = await sicoobCreatePix({
        amount: req.amount,
        txid: pixTxidForAttempt(req.idempotencyKey, attempt),
        description: req.description,
        customer: { name: user.name, document: { identity: doc.docStr, type: doc.docType } },
        expiresSeconds,
    });
    if (!result.pixString) {
        throw new Error('O Sicoob não retornou o código PIX. Tente novamente em instantes.');
    }

    return {
        provider: 'SICOOB',
        result: {
            id: result.id,
            barcode: '',
            boletoUrl: '',
            pixString: result.pixString,
            qrCodeBase64: result.qrCodeBase64,
            status: result.status,
        },
        pixString: result.pixString,
        qrCodeBase64: result.qrCodeBase64 || null,
        boletoUrl: null,
        barcode: null,
        expiresAt: result.expiresAt,
    };
}

// ─── Metadado de controle (Payment.metadata.pixCharge) ───

/** Controle da cobrança PIX atual: nº da emissão e o valor para o qual ela foi emitida. */
export interface PixChargeMeta {
    attempt: number;
    amount?: number;
    txid?: string;
}

function asObject(v: unknown): Record<string, unknown> {
    return v && typeof v === 'object' && !Array.isArray(v) ? { ...(v as Record<string, unknown>) } : {};
}

/** Lê `metadata.pixCharge` (ou null). */
export function readPixChargeMeta(metadata: unknown): PixChargeMeta | null {
    const raw = asObject(metadata).pixCharge;
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const attempt = Number(r.attempt);
    if (!Number.isFinite(attempt) || attempt < 1) return null;
    return {
        attempt: Math.floor(attempt),
        ...(typeof r.amount === 'number' ? { amount: r.amount } : {}),
        ...(typeof r.txid === 'string' ? { txid: r.txid } : {}),
    };
}

/** Mescla chaves no metadata sem perder o que já existe (ex.: contractData do /self, installmentCap). */
export function mergePaymentMetadata(metadata: unknown, patch: Record<string, unknown>): Prisma.InputJsonValue {
    return { ...asObject(metadata), ...patch } as Prisma.InputJsonValue;
}

/**
 * Metadata a gravar quando uma cobrança PIX existente é DESCARTADA sem reemissão (reset de FAILED,
 * mudança de valor, troca de método): garante que a próxima emissão use um txid NOVO mesmo em
 * linhas antigas sem `pixCharge` (a 1ª emissão consumiu o txid legado). `undefined` = nada a mudar.
 */
export function pixMetadataAfterDiscard(payment: { provider: string | null; providerRef: string | null; metadata: unknown }): Prisma.InputJsonValue | undefined {
    if (!isPixProvider(payment.provider) || !payment.providerRef) return undefined;
    const meta = readPixChargeMeta(payment.metadata);
    if (meta) return undefined; // o contador já está gravado
    return mergePaymentMetadata(payment.metadata, { pixCharge: { attempt: 1 } });
}

/** Próxima emissão para este Payment (1 se nunca emitiu). */
export function nextPixAttempt(payment: { provider: string | null; providerRef: string | null; metadata: unknown }): number {
    const meta = readPixChargeMeta(payment.metadata);
    const hadCharge = isPixProvider(payment.provider) && !!payment.providerRef;
    const last = meta?.attempt ?? (hadCharge ? 1 : 0);
    return last + 1;
}

/**
 * Validade (segundos) da próxima cobrança PIX de um Payment:
 *  • avulso com reserva HELD/RESERVED → até o fim da reserva (piso 120s, teto 1h);
 *  • contrato AWAITING_PAYMENT com prazo → min(1h, prazo restante) (piso 120s);
 *  • demais → 1h.
 */
export function pixExpirySecondsFor(
    payment: {
        booking?: { status: string; holdExpiresAt: Date | null } | null;
        contract?: { status: string; paymentDeadline: Date | null } | null;
    },
    now: Date = new Date(),
): number {
    const clamp = (ms: number) => Math.max(PIX_MIN_EXPIRES_SECONDS, Math.min(PIX_DEFAULT_EXPIRES_SECONDS, Math.ceil(ms / 1000)));
    const b = payment.booking;
    if (b && (b.status === 'HELD' || b.status === 'RESERVED') && b.holdExpiresAt) {
        return clamp(b.holdExpiresAt.getTime() - now.getTime());
    }
    const c = payment.contract;
    if (c && c.status === 'AWAITING_PAYMENT' && c.paymentDeadline) {
        return clamp(c.paymentDeadline.getTime() - now.getTime());
    }
    return PIX_DEFAULT_EXPIRES_SECONDS;
}

/**
 * A cobrança PIX atual deste Payment pode ser reaproveitada? Só se: PENDING, provedor PIX com
 * providerRef, BR Code válido, validade restante ≥ 60s e emitida para o MESMO valor do Payment
 * (metadata.pixCharge.amount). Linhas legadas (sem pixExpiresAt/sem valor gravado) → não.
 */
export function isPixChargeReusable(
    p: {
        status: string;
        provider: string | null;
        providerRef: string | null;
        pixString: string | null;
        pixExpiresAt: Date | null;
        amount: number;
        metadata: unknown;
    },
    now: Date = new Date(),
): boolean {
    if (p.status !== 'PENDING') return false;
    if (!isPixProvider(p.provider) || !p.providerRef || !p.pixString) return false;
    if (!p.pixExpiresAt || p.pixExpiresAt.getTime() <= now.getTime() + PIX_REUSE_MIN_REMAINING_MS) return false;
    if (!isValidBrCode(p.pixString)) return false;
    const meta = readPixChargeMeta(p.metadata);
    return meta?.amount === p.amount;
}

/** QR do copia-e-cola como data URL PNG (280px, correção M). `null` se falhar. */
export async function pixQrDataUrl(pixString: string | null | undefined): Promise<string | null> {
    if (!pixString) return null;
    try {
        return await QRCode.toDataURL(pixString, { width: 280, margin: 2, errorCorrectionLevel: 'M' });
    } catch (err) {
        console.error('[PIX] Falha ao gerar a imagem do QR:', err instanceof Error ? err.message : err);
        return null;
    }
}

// ─── Aposentar / emitir ──────────────────────────────────

/**
 * 'paid' = já paga (efeitos rodaram) · 'retired' = pode trocar (cancelada/expirada/inexistente) ·
 * 'live' = a cobrança continua PAGÁVEL no provedor e não pôde ser cancelada agora — quem chama NÃO
 * pode emitir outra nem trocar de método (o pagamento no QR antigo ficaria sem registro) ·
 * 'none' = não há cobrança PIX a aposentar.
 */
export type PixRetireResult = 'paid' | 'retired' | 'live' | 'none';

/** Mensagem única para o cliente quando a cobrança PIX anterior não pôde ser cancelada. */
export const PIX_LIVE_CHARGE_MESSAGE = 'Não foi possível cancelar o QR PIX anterior agora (ele ainda pode ser pago). Tente novamente em instantes.';

const isSicoobTxidRef = (ref: string | null | undefined): ref is string => !!ref && /^[a-zA-Z0-9]{26,35}$/.test(ref);

interface PixRetireDetail {
    result: PixRetireResult;
    /** 'live' no Sicoob de produção: a cob consultada (ATIVA e não expirada) — permite adotá-la. */
    liveCob?: any;
}

/**
 * Aposenta a cobrança PIX atual de um Payment antes de trocá-la (novo QR, troca para cartão,
 * mudança de valor, cobrança automática): 1) concilia no provedor — se já foi paga, marca PAID (com
 * todos os efeitos) e devolve 'paid'; 2) senão cancela a cobrança no provedor para que o QR antigo
 * não continue pagável sem casar com o Payment. Se o cancelamento FALHA e a cobrança não está
 * comprovadamente paga/removida/expirada, devolve 'live' (nunca finge que aposentou — pagamentos-4).
 * Não altera as colunas do Payment.
 */
export async function retirePixCharge(paymentId: string): Promise<PixRetireResult> {
    return (await retirePixChargeDetailed(paymentId)).result;
}

async function retirePixChargeDetailed(paymentId: string): Promise<PixRetireDetail> {
    const p = await prisma.payment.findUnique({
        where: { id: paymentId },
        select: { id: true, status: true, provider: true, providerRef: true, pixString: true },
    });
    if (!p) return { result: 'none' };
    if (p.status === 'PAID') return { result: 'paid' };
    if (p.status !== 'PENDING' || !isPixProvider(p.provider) || !p.providerRef) return { result: 'none' };

    const paidNow = async () => (await prisma.payment.findUnique({ where: { id: p.id }, select: { status: true } }))?.status === 'PAID';

    if (p.provider === 'SICOOB') {
        // Ref que não é txid (mock de dev "mock-xxxx") → não existe cobrança no provedor.
        if (!isSicoobTxidRef(p.providerRef)) return { result: 'retired' };
        const { reconcileSicoobPayment, isSicoobCobPaid, isSicoobCobCancelled, isSicoobCobExpired } = await import('./sicoobReconciliation.js');
        if (await reconcileSicoobPayment(p.id)) return { result: 'paid' };
        if (!(await sicoobRemoveCob(p.providerRef))) {
            // Remoção recusada pode significar que a cob acabou de ser PAGA (o Sicoob não remove uma
            // cob CONCLUIDA) → concilia mais uma vez antes de qualquer troca.
            if (await reconcileSicoobPayment(p.id)) return { result: 'paid' };
            // Produção: confirma no provedor se a cob ainda é pagável. (O GET do sandbox é um mock
            // aleatório — lá mantemos o comportamento anterior: segue como aposentada.)
            const { getSicoobEnvironment, sicoobGetCob } = await import('./sicoobService.js');
            if ((await getSicoobEnvironment()) === 'production') {
                let cob: any = null;
                try {
                    cob = await sicoobGetCob(p.providerRef);
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    // 404 = a cobrança não existe no provedor → nada pagável. Qualquer outra falha: fail-closed.
                    if (!/\b404\b/.test(msg)) {
                        console.warn(`[PIX] cob ${p.providerRef} não pôde ser removida nem consultada — mantida como viva:`, msg);
                        return { result: 'live' };
                    }
                }
                if (cob) {
                    if (isSicoobCobPaid(cob)) {
                        // Paga no provedor mas a conciliação recusou (ex.: valor divergente) → nunca emitir por cima.
                        if (await paidNow()) return { result: 'paid' };
                        console.error(`[PIX][SECURITY] cob ${p.providerRef} consta paga no Sicoob mas não conciliou (payment ${p.id}) — troca bloqueada para análise.`);
                        return { result: 'live' };
                    }
                    if (!isSicoobCobCancelled(cob) && !isSicoobCobExpired(cob)) {
                        console.warn(`[PIX] cob ${p.providerRef} continua ATIVA e a remoção foi recusada (payment ${p.id}).`);
                        return { result: 'live', liveCob: cob };
                    }
                }
            }
        }
    } else {
        // Cora: só cancela fatura de PIX (nunca um boleto puro, que não tem pixString).
        const { reconcileCoraPayment, isCoraInvoiceCancelled } = await import('./coraReconciliation.js');
        if (await reconcileCoraPayment(p.id)) return { result: 'paid' };
        if (p.pixString) {
            const { coraCancelBoleto, coraGetBoleto, isCoraEnabled } = await import('./coraService.js');
            try {
                await coraCancelBoleto(p.providerRef);
            } catch (err) {
                console.warn(`[PIX] cancelar fatura Cora ${p.providerRef} falhou:`, err instanceof Error ? err.message : err);
                if (await reconcileCoraPayment(p.id)) return { result: 'paid' };
                // Integração desligada: não há como cancelar nem consultar — segue (comportamento anterior).
                if (await isCoraEnabled().catch(() => false)) {
                    try {
                        if (!isCoraInvoiceCancelled(await coraGetBoleto(p.providerRef))) return { result: 'live' };
                    } catch {
                        return { result: 'live' };
                    }
                }
            }
        }
    }
    // Um webhook pode ter confirmado entre a conciliação e o cancelamento.
    return { result: (await paidNow()) ? 'paid' : 'retired' };
}

/**
 * Cancela no provedor, best-effort, a cobrança PIX que ficou para trás quando o Payment foi pago por
 * OUTRO meio (ex.: cartão aprovado depois de um QR emitido). Nunca lança.
 */
export async function cancelStalePixCharge(provider: string | null | undefined, providerRef: string | null | undefined, pixString?: string | null): Promise<void> {
    try {
        if (provider === 'SICOOB' && isSicoobTxidRef(providerRef)) {
            await sicoobRemoveCob(providerRef);
        } else if (provider === 'CORA' && providerRef && pixString) {
            const { coraCancelBoleto } = await import('./coraService.js');
            await coraCancelBoleto(providerRef);
        }
    } catch (err) {
        console.warn(`[PIX] cancelar cobrança ${providerRef} que ficou para trás falhou (best-effort):`, err instanceof Error ? err.message : err);
    }
}

/** requires_action/requires_confirmation (3DS / aprovação no app do banco) seguram por este tempo. */
const CARD_ACTION_GRACE_MS = 30 * 60 * 1000;

/**
 * O PaymentIntent de cartão desta cobrança ainda pode virar dinheiro? succeeded / processing /
 * requires_capture → sim; requires_action / requires_confirmation (3DS, aprovação no app do banco)
 * → sim, por até 30 min desde a criação (mesmo critério da varredura). Mock/sem Stripe → não.
 * Falha ao consultar → não (comportamento anterior; o webhook e a varredura cobrem o resto).
 */
export async function cardIntentInFlight(piId: string | null | undefined, now: Date = new Date()): Promise<boolean> {
    if (!piId || !piId.startsWith('pi_') || piId.startsWith('pi_mock')) return false;
    try {
        const { isStripeEnabled, stripeGetPaymentIntent } = await import('./stripeService.js');
        if (!(await isStripeEnabled())) return false;
        const pi = await stripeGetPaymentIntent(piId);
        if (pi.status === 'succeeded' || pi.status === 'processing' || pi.status === 'requires_capture') return true;
        if ((pi.status === 'requires_action' || pi.status === 'requires_confirmation')
            && now.getTime() - pi.created * 1000 < CARD_ACTION_GRACE_MS) return true;
        return false;
    } catch {
        return false;
    }
}

/**
 * PaymentIntent de cartão pendente nesta mesma cobrança (troca de método). Se já foi pago, está
 * processando ou aguardando o 3DS/aprovação (pagamentos-14), NÃO emitimos PIX (evita cobrança
 * dupla). O PI em aberto não é cancelado aqui: a chave de idempotência do cartão é derivada do
 * Payment, e cancelar faria uma volta ao cartão receber o PI cancelado.
 */
async function cardIntentBlocksPix(piId: string): Promise<boolean> {
    return cardIntentInFlight(piId);
}

// ─── Desconto PIX do "à vista" (D1) ─────────────────────
// Um Payment "à vista" (plano FULL) criado com PIX grava `amount` JÁ com o desconto PIX. O desconto
// só vale no PIX: pago no CARTÃO, cobra-se o valor SEM o desconto PIX (o cupom, se houver, é mantido
// no mesmo valor em R$). Regra ÚNICA (sem fallback que adivinhe pelo estado atual do contrato):
//  • TODA cobrança criada com desconto PIX grava `metadata.pixDiscount = { pct, cardAmount, pixAmount }`
//    (pixDiscountMetaForCharge): `cardAmount` é o VALOR BASE do cartão calculado na criação — o cartão
//    cobra exatamente ele, nunca um valor recalculado pelo % configurado hoje.
//  • Sem a marca → o cartão cobra o próprio `amount`. Troca de forma de pagamento do contrato, provider
//    da linha ou mudança do % nunca alteram o valor. Cobranças anteriores a esta regra (sem marca) cobram
//    no cartão o valor gravado — pode ficar ABAIXO do preço de cartão, NUNCA acima (decisão conservadora:
//    o fallback que revertia o % atual podia cobrar a mais — revisão final, 24/09/2026).
//  • Valor ZERO (cupom 100%) nunca recebe marca e nunca vai ao cartão.

export type PixDiscountMeta = {
    /** % de desconto PIX aplicado (informativo — o cartão usa `cardAmount`, nunca o % atual). */
    pct: number;
    /** VALOR BASE (centavos) desta cobrança no CARTÃO: sem o desconto PIX, com o mesmo cupom em R$. */
    cardAmount: number;
    /**
     * `amount` da linha quando a marca foi gravada. Se o amount mudar depois sem a marca ser regravada,
     * ela CADUCA e o cartão cobra o próprio amount (nunca a mais). Ausente = marca anterior a este campo.
     */
    pixAmount?: number;
};

/** Lê `metadata.pixDiscount` (ou null — marca ausente ou inválida). */
export function readPixDiscountMeta(metadata: unknown): PixDiscountMeta | null {
    const raw = asObject(metadata).pixDiscount;
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const cardAmount = Number(r.cardAmount);
    const pct = Number(r.pct);
    if (!Number.isInteger(cardAmount) || cardAmount <= 0) return null;
    if (r.pixAmount === undefined || r.pixAmount === null) return { pct: Number.isFinite(pct) ? pct : 0, cardAmount };
    const pixAmount = Number(r.pixAmount);
    if (!Number.isInteger(pixAmount) || pixAmount < 0) return null; // marca corrompida → sem reversão
    return { pct: Number.isFinite(pct) ? pct : 0, cardAmount, pixAmount };
}

/**
 * `metadata.pixDiscount` a gravar (ou undefined se o cartão não custa mais que o PIX). Cobrança de valor
 * ZERO (cupom 100%) nunca recebe marca: não há o que cobrar no cartão.
 */
export function buildPixDiscountMeta(args: { pixAmount: number; cardAmount: number; pct: number }): PixDiscountMeta | undefined {
    if (!(args.pixAmount > 0)) return undefined;
    if (!Number.isInteger(args.cardAmount) || args.cardAmount <= args.pixAmount) return undefined;
    return { pct: args.pct, cardAmount: args.cardAmount, pixAmount: args.pixAmount };
}

/**
 * Marca da CRIAÇÃO de uma cobrança com desconto PIX: `amount` = valor gravado (PIX, já com o cupom),
 * `cardTotal` = o mesmo total SEM o desconto PIX (antes do cupom) e `couponDiscount` = o desconto do cupom
 * em R$ (o cartão mantém o mesmo valor). undefined = não houve desconto PIX (o cartão cobra o amount).
 */
export function pixDiscountMetaForCharge(args: { amount: number; cardTotal: number; couponDiscount?: number | null; pct: number }): PixDiscountMeta | undefined {
    if (!(args.pct > 0)) return undefined;
    return buildPixDiscountMeta({
        pixAmount: args.amount,
        cardAmount: Math.max(0, args.cardTotal - Math.max(0, args.couponDiscount ?? 0)),
        pct: args.pct,
    });
}

type CardChargePayment = {
    /** Aceito por compatibilidade: o valor sai só de `amount` + `metadata` desta linha (nada é lido do banco). */
    id?: string;
    amount: number;
    metadata?: unknown;
    /** Aceitos por compatibilidade com os chamadores (não influem mais no valor). */
    discountAmount?: number | null;
    contractId?: string | null;
    bookingId?: string | null;
    createdAt?: Date | null;
    status?: string | null;
    provider?: string | null;
    pixString?: string | null;
    contract?: { type?: string | null; paymentPlan?: string | null; paymentMethod?: string | null } | null;
};

/** Valor do cartão pela marca (caduca se o amount mudou depois da marca). Nunca abaixo do amount. */
function markedCardAmount(amount: number, meta: PixDiscountMeta): number {
    if (amount <= 0) return amount;
    if (meta.pixAmount !== undefined && meta.pixAmount !== amount) return amount;
    return Math.max(amount, meta.cardAmount);
}

/**
 * Valor a cobrar no CARTÃO (antes de juros de parcelamento) para um Payment: a base marcada
 * (`metadata.pixDiscount.cardAmount`) quando a cobrança nasceu com desconto PIX; senão o próprio `amount`.
 * Valor zero volta zero (nunca vai ao cartão). Os chamadores passam a linha lida do banco (com metadata).
 * Mantida assíncrona por compatibilidade com os chamadores.
 */
export async function cardChargeBaseAmount(payment: CardChargePayment): Promise<number> {
    if (payment.amount <= 0) return payment.amount;
    const meta = readPixDiscountMeta(payment.metadata);
    return meta ? markedCardAmount(payment.amount, meta) : payment.amount;
}

// ─── PaymentIntent anterior da mesma cobrança (cartão) ──
const CARD_INTENT_IN_FLIGHT = new Set(['succeeded', 'processing', 'requires_capture']);

export type ExistingCardIntent =
    /** Sem PI real (mock/sem ref), Stripe desligado, PI inexistente ou já cancelado. */
    | { state: 'none' }
    /** PI pagável com o MESMO valor (quem chama decide se reaproveita). */
    | { state: 'reusable'; clientSecret: string | null }
    /** PI pagável com OUTRO valor → cancelado agora. */
    | { state: 'cancelled' }
    /** succeeded / processing / requires_capture → o dinheiro já está a caminho: NÃO criar outro. */
    | { state: 'in_flight'; status: string }
    /** Não deu para consultar/cancelar agora → NÃO criar outro (fail-closed). */
    | { state: 'unknown' };

/**
 * Antes de emitir um PaymentIntent NOVO para uma cobrança, resolve o PI anterior dela (`piId`, pi_…):
 * pagável com valor DIFERENTE do que será cobrado → cancela (um PI antigo pago numa aba aberta viraria
 * dinheiro sem registro — o webhook recusa valor divergente); succeeded/processing → 'in_flight' (nunca
 * criar outro). Consulta com falha → 'unknown'; PI inexistente (resource_missing) → 'none'.
 */
export async function settleExistingCardIntent(piId: string | null | undefined, chargeAmount: number): Promise<ExistingCardIntent> {
    if (!piId || !piId.startsWith('pi_') || piId.startsWith('pi_mock')) return { state: 'none' };
    const { isStripeEnabled, stripeGetPaymentIntent, stripeCancelPaymentIntent } = await import('./stripeService.js');
    if (!(await isStripeEnabled().catch(() => false))) return { state: 'none' };
    const missing = (err: unknown) => {
        const e = err as { code?: string; statusCode?: number } | null;
        return e?.code === 'resource_missing' || e?.statusCode === 404;
    };
    let pi: { id: string; status: string; amount: number; client_secret?: string | null } | undefined;
    try {
        pi = await stripeGetPaymentIntent(piId);
    } catch (err) {
        if (missing(err)) return { state: 'none' };
        console.warn(`[Stripe] PI anterior ${piId} não pôde ser consultado:`, err instanceof Error ? err.message : err);
        return { state: 'unknown' };
    }
    if (!pi) return { state: 'none' };
    if (CARD_INTENT_IN_FLIGHT.has(pi.status)) return { state: 'in_flight', status: pi.status };
    if (pi.status === 'canceled') return { state: 'none' };
    if (pi.amount === chargeAmount) return { state: 'reusable', clientSecret: pi.client_secret ?? null };
    try {
        const r = await stripeCancelPaymentIntent(pi.id);
        if (r.canceled || r.status === 'canceled') return { state: 'cancelled' };
        if (CARD_INTENT_IN_FLIGHT.has(r.status)) return { state: 'in_flight', status: r.status };
        return { state: 'unknown' };
    } catch (err) {
        if (missing(err)) return { state: 'none' };
        console.warn(`[Stripe] PI anterior ${piId} (valor ${pi.amount} ≠ ${chargeAmount}) não pôde ser cancelado:`, err instanceof Error ? err.message : err);
        return { state: 'unknown' };
    }
}

/** Mensagem do create-payment / pay quando já há um PI desta cobrança aprovado ou em processamento. */
export function cardIntentInFlightMessage(status: string): string {
    return status === 'succeeded'
        ? 'Este pagamento já foi aprovado no cartão e está sendo confirmado. Atualize a página em instantes — se ele não aparecer como pago, fale com o estúdio.'
        : 'Há um pagamento no cartão em processamento para esta cobrança. Aguarde a confirmação antes de tentar de novo.';
}

/**
 * Valor EFETIVAMENTE cobrado de um Payment pago (receita bruta dos relatórios): no cartão é o valor do
 * PaymentIntent (`chargedAmount`: sem o desconto PIX do à vista e com os juros de parcelamento, quando
 * houver); no PIX/boleto é o `amount`. `chargedAmount` só vale quando a cobrança paga foi a do CARTÃO
 * (provider STRIPE ou providerRef de PaymentIntent) — uma linha paga no PIX pode guardar o
 * chargedAmount de uma tentativa de cartão abandonada (pagamentos-14), que não entra na receita.
 */
export function paidChargedAmount(p: { amount: number; chargedAmount?: number | null; provider?: string | null; providerRef?: string | null }): number {
    const paidByCard = p.provider === 'STRIPE' || (typeof p.providerRef === 'string' && p.providerRef.startsWith('pi_'));
    return paidByCard && p.chargedAmount != null && p.chargedAmount > 0 ? p.chargedAmount : p.amount;
}

export interface IssuePixChargeOpts {
    /** Validade explícita (segundos). Sem isso: derivada da reserva/prazo do contrato (ver pixExpirySecondsFor). */
    expiresSeconds?: number;
    /** Texto da cobrança (solicitacaoPagador). */
    description?: string;
    /** Ignora o reuso e emite uma cobrança nova mesmo com a atual viva. */
    forceNew?: boolean;
}

export interface IssuePixChargeResult {
    provider: string;
    providerRef: string | null;
    pixString: string | null;
    /** PNG do QR como data URL (`data:image/png;base64,...`). */
    qrCodeDataUrl: string | null;
    /** ISO do fim da validade da cobrança. */
    expiresAt: string | null;
    /** Valor cobrado (centavos) = Payment.amount. */
    amount: number;
    reused: boolean;
    /** A cobrança já está paga (no banco ou confirmada agora pela conciliação). */
    alreadyPaid: boolean;
}

function paidResult(p: { provider: string; providerRef: string | null; amount: number }): IssuePixChargeResult {
    return {
        provider: p.provider,
        providerRef: p.providerRef,
        pixString: null,
        qrCodeDataUrl: null,
        expiresAt: null,
        amount: p.amount,
        reused: false,
        alreadyPaid: true,
    };
}

/**
 * Adota a cobrança Sicoob VIVA (que não pôde ser removida) quando ela é do mesmo valor do Payment e
 * ainda vale mais de 60s: grava pixString/pixExpiresAt/metadata a partir do GET /cob, sem emitir outra.
 * `null` quando não dá para adotar (valor diferente, EMV inválido, quase vencida, linha mudou).
 */
async function adoptLivePixCharge(
    payment: { id: string; provider: string; providerRef: string | null; pixString: string | null; amount: number; metadata: unknown },
    cob: any,
    now: Date,
): Promise<IssuePixChargeResult | null> {
    if (!cob || payment.provider !== 'SICOOB' || !payment.providerRef) return null;
    const cobCents = Math.round(Number(cob?.valor?.original) * 100);
    if (!Number.isFinite(cobCents) || cobCents !== payment.amount) return null;
    const emv = String(cob?.pixCopiaECola || cob?.brcode || '').trim();
    const pixString = isValidBrCode(emv) ? emv : (payment.pixString && isValidBrCode(payment.pixString) ? payment.pixString : null);
    if (!pixString) return null;
    const { computeCobExpiresAt } = await import('./sicoobService.js');
    const expiresAt = computeCobExpiresAt(cob, Number(cob?.calendario?.expiracao) || PIX_DEFAULT_EXPIRES_SECONDS, 'production', now);
    if (expiresAt.getTime() <= now.getTime() + PIX_REUSE_MIN_REMAINING_MS) return null;
    const attempt = readPixChargeMeta(payment.metadata)?.attempt ?? 1;
    const upd = await prisma.payment.updateMany({
        where: { id: payment.id, status: 'PENDING', providerRef: payment.providerRef },
        data: {
            pixString,
            pixExpiresAt: expiresAt,
            metadata: mergePaymentMetadata(payment.metadata, {
                pixCharge: { attempt, amount: payment.amount, txid: payment.providerRef },
            }),
        },
    });
    if (upd.count === 0) return null;
    console.log(`[PIX] cob viva ${payment.providerRef} adotada (não removível) — payment ${payment.id}, vale até ${expiresAt.toISOString()}`);
    return {
        provider: payment.provider,
        providerRef: payment.providerRef,
        pixString,
        qrCodeDataUrl: await pixQrDataUrl(pixString),
        expiresAt: expiresAt.toISOString(),
        amount: payment.amount,
        reused: true,
        alreadyPaid: false,
    };
}

/**
 * Fonte ÚNICA de emissão de PIX sob demanda para um Payment existente (D15).
 * Reusa a cobrança viva e com o mesmo valor; senão concilia/cancela a anterior e emite nova,
 * gravando provider/providerRef/pixString/pixExpiresAt e metadata.pixCharge num único update.
 * @throws Error com mensagem para o cliente (CPF ausente, provedor desligado, falha do provedor…).
 */
export async function issuePixCharge(paymentId: string, opts: IssuePixChargeOpts = {}): Promise<IssuePixChargeResult> {
    const payment = await prisma.payment.findUnique({
        where: { id: paymentId },
        include: {
            booking: { select: { status: true, holdExpiresAt: true } },
            contract: { select: { status: true, paymentDeadline: true, name: true } },
        },
    });
    if (!payment) throw new Error('Pagamento não encontrado.');
    if (payment.status === 'PAID') return paidResult(payment);
    if (payment.status !== 'PENDING') throw new Error('Esta cobrança não está pendente.');
    if (!Number.isInteger(payment.amount) || payment.amount <= 0) {
        throw new Error('Valor do pagamento inválido (deve ser maior que zero).');
    }

    const now = new Date();

    // 1) Reuso: só a cobrança viva, válida e com o MESMO valor.
    if (!opts.forceNew && isPixChargeReusable(payment, now)) {
        return {
            provider: payment.provider,
            providerRef: payment.providerRef,
            pixString: payment.pixString,
            qrCodeDataUrl: await pixQrDataUrl(payment.pixString),
            expiresAt: payment.pixExpiresAt ? payment.pixExpiresAt.toISOString() : null,
            amount: payment.amount,
            reused: true,
            alreadyPaid: false,
        };
    }

    // 2) Cartão em andamento nesta cobrança → não emitir PIX por cima.
    if (payment.provider === 'STRIPE' && payment.providerRef && await cardIntentBlocksPix(payment.providerRef)) {
        throw new Error('Há um pagamento com cartão em processamento para esta cobrança. Aguarde a confirmação antes de gerar o PIX.');
    }

    // 3) Cobrança PIX anterior: conciliar (pode já estar paga) e cancelar antes de reemitir.
    if (isPixProvider(payment.provider) && payment.providerRef) {
        const retired = await retirePixChargeDetailed(payment.id);
        if (retired.result === 'paid') {
            const fresh = await prisma.payment.findUnique({ where: { id: payment.id } });
            return paidResult(fresh ?? payment);
        }
        if (retired.result === 'live') {
            // pagamentos-4/regressoes-3: a cobrança anterior continua pagável e não pôde ser removida.
            // Emitir outra por cima trocaria o providerRef e um pagamento no QR antigo nunca casaria
            // com o Payment. Adota a viva quando é do MESMO valor (ex.: linha legada sem pixExpiresAt);
            // senão, erro amigável — o cliente tenta de novo em instantes.
            const adopted = await adoptLivePixCharge(payment, retired.liveCob, now);
            if (adopted) return adopted;
            throw new Error(PIX_LIVE_CHARGE_MESSAGE);
        }
    }

    // 4) Emitir nova cobrança.
    const attempt = nextPixAttempt(payment);
    const expiresSeconds = opts.expiresSeconds ?? pixExpirySecondsFor(payment, now);
    const pixRes = await createPixPayment({
        userId: payment.userId,
        amount: payment.amount,
        description: opts.description || `Pagamento PIX - ${payment.contract?.name || 'Avulso'}`,
        withPixQrCode: true,
        idempotencyKey: payment.id,
        attempt,
        expiresSeconds,
    });
    if (!pixRes.pixString) throw new Error('O provedor não retornou o código PIX. Tente novamente em instantes.');

    const expiresAt = pixRes.expiresAt ?? new Date(now.getTime() + expiresSeconds * 1000);
    const updated = await prisma.payment.updateMany({
        where: { id: payment.id, status: 'PENDING' },
        data: {
            provider: pixRes.provider,
            providerRef: pixRes.result.id,
            pixString: pixRes.pixString,
            pixExpiresAt: expiresAt,
            installments: 1,
            // chargedAmount NÃO é zerado (pagamentos-14): o PIX concilia por `amount` e nunca lê o
            // chargedAmount; um PaymentIntent anterior que ainda aprove (3DS concluído depois) precisa
            // dele para a checagem de valor do webhook. Uma volta ao cartão regrava o chargedAmount.
            metadata: mergePaymentMetadata(payment.metadata, {
                pixCharge: { attempt, amount: payment.amount, txid: pixRes.result.id },
            }),
        },
    });
    if (updated.count === 0) {
        // Mudou de estado no meio (webhook pagou a anterior / contrato cancelado).
        const fresh = await prisma.payment.findUnique({ where: { id: payment.id } });
        if (fresh?.status === 'PAID') return paidResult(fresh);
        throw new Error('Esta cobrança mudou de situação. Atualize a página e tente novamente.');
    }

    return {
        provider: pixRes.provider,
        providerRef: pixRes.result.id,
        pixString: pixRes.pixString,
        qrCodeDataUrl: await pixQrDataUrl(pixRes.pixString),
        expiresAt: expiresAt.toISOString(),
        amount: payment.amount,
        reused: false,
        alreadyPaid: false,
    };
}

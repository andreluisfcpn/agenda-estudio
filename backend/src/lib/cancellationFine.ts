// ─── Multa de cancelamento (E13) ─────────────────────────────────────────────
// Regra do dono (30/09/2026):
//  • base = o que FALTA PAGAR do plano: soma das parcelas do plano ainda não pagas (PENDING/FAILED, sem
//    bookingId — extras de uma gravação não entram — e sem a própria multa);
//  • multa = `cancellation_fine_pct`% dessa base, CONGELADA no pedido do cliente (request-cancellation):
//    mudar o % depois do pedido não altera a multa, e a base nunca AUMENTA depois dele;
//  • congelar NÃO faz o cliente pagar multa sobre parcela já quitada: a base EFETIVA (prévias e decisão)
//    é o MÍNIMO entre a congelada e o que ainda falta pagar — uma parcela que compunha a base e foi paga
//    durante a análise (QR PIX / PaymentIntent emitido antes do pedido, ou cobrada pelo admin) sai dela;
//  • à vista quitado (nada a pagar) ou base efetiva 0 → sem multa;
//  • a cobrança gerada é identificada por `Payment.metadata.kind = 'CANCELLATION_FINE'` (+ finePct e
//    baseAmount), fica PENDING e nunca é cobrada pelo auto-charge (o contrato já está CANCELLED).
//
// Sem migration: o congelamento e a data do cancelamento ficam na trilha de auditoria do contrato
// (`audit_logs`, entityType CONTRACT) — o mesmo lugar onde já vivem PAUSED/RESUMED/RENEWED e as marcas da
// remarcação do avulso. Contrato sem a marca (pedido anterior a esta regra) → base calculada na decisão.

import { prisma } from './prisma.js';
import type { Prisma } from '../generated/prisma/client.js';
import { getConfig } from './businessConfig.js';

export const CANCELLATION_FINE_KIND = 'CANCELLATION_FINE' as const;
/** audit_logs.action gravada no pedido de cancelamento (guarda a base congelada da multa). */
export const AUDIT_CANCELLATION_REQUESTED = 'CANCELLATION_REQUESTED';
/** audit_logs.action gravada quando o contrato vira CANCELLED (data do cancelamento). */
export const AUDIT_CONTRACT_CANCELLED = 'CANCELLED';

type Db = Prisma.TransactionClient | typeof prisma;

function asObject(v: unknown): Record<string, unknown> {
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** `metadata.kind` de uma cobrança (hoje só 'CANCELLATION_FINE'), ou null. */
export function paymentKind(metadata: unknown): string | null {
    const kind = asObject(metadata).kind;
    return typeof kind === 'string' && kind ? kind : null;
}

/** A cobrança é uma multa de cancelamento? */
export function isCancellationFine(p: { metadata?: unknown } | null | undefined): boolean {
    return !!p && paymentKind(p.metadata) === CANCELLATION_FINE_KIND;
}

/** Multa (centavos) = pct% da base, arredondada. Base ou % não positivos → 0. */
export function computeFineAmount(baseAmount: number, finePct: number): number {
    if (!Number.isFinite(baseAmount) || !Number.isFinite(finePct) || baseAmount <= 0 || finePct <= 0) return 0;
    return Math.round(baseAmount * finePct / 100);
}

export type FinePaymentLike = {
    amount: number;
    status: string;
    bookingId?: string | null;
    metadata?: unknown;
};

/**
 * Parcela do PLANO ainda não paga: PENDING ou FAILED (continua devida), sem bookingId (extras de uma
 * gravação têm valor próprio e não entram na base) e que não é a própria multa.
 */
export function isUnpaidPlanInstallment(p: FinePaymentLike): boolean {
    return (p.status === 'PENDING' || p.status === 'FAILED') && !p.bookingId && !isCancellationFine(p);
}

/** Soma (centavos) das parcelas do plano ainda não pagas — a BASE da multa. */
export function remainingPlanAmount(payments: FinePaymentLike[]): number {
    return payments.reduce((sum, p) => sum + (isUnpaidPlanInstallment(p) ? p.amount : 0), 0);
}

/** Parcela que compunha a base no pedido: id + valor congelado (centavos). */
export type FrozenInstallment = { id: string; amount: number };
/** Cobrança do contrato no formato que a base efetiva da multa lê. */
export type FineBasisPayment = FinePaymentLike & { id: string };

const FINE_BASIS_SELECT = { id: true, amount: true, status: true, bookingId: true, metadata: true } as const;

// ─── Congelamento no pedido ──────────────────────────────

export interface CancellationSnapshot {
    /** Momento do pedido (criação da marca). */
    requestedAt: Date;
    /** Base congelada (centavos): o que faltava pagar do plano no pedido. */
    baseAmount: number;
    /** % da multa vigente no pedido. */
    finePct: number;
    /** Multa congelada (centavos) = computeFineAmount(baseAmount, finePct). */
    fineAmount: number;
    /** false = contrato sem marca do pedido (anterior à regra): valores calculados na hora da leitura. */
    frozen: boolean;
    /**
     * Parcelas do plano que compunham a base no pedido (id + valor). null = marca antiga, sem a lista
     * (a base efetiva cai no critério simples: mínimo entre a congelada e o saldo de hoje).
     */
    installments: FrozenInstallment[] | null;
}

function parseInstallments(raw: unknown): FrozenInstallment[] | null {
    if (!Array.isArray(raw)) return null;
    const out: FrozenInstallment[] = [];
    for (const item of raw) {
        const o = asObject(item);
        const amount = Number(o.amount);
        if (typeof o.id !== 'string' || !o.id || !Number.isFinite(amount) || amount < 0) return null;
        out.push({ id: o.id, amount });
    }
    return out;
}

function parseSnapshot(row: { changes: string | null; createdAt: Date }): CancellationSnapshot | null {
    if (!row.changes) return null;
    try {
        const raw = asObject(JSON.parse(row.changes));
        const baseAmount = Number(raw.baseAmount);
        const finePct = Number(raw.finePct);
        if (!Number.isFinite(baseAmount) || baseAmount < 0 || !Number.isFinite(finePct) || finePct < 0) return null;
        return {
            requestedAt: row.createdAt, baseAmount, finePct, fineAmount: computeFineAmount(baseAmount, finePct), frozen: true,
            installments: parseInstallments(raw.installments),
        };
    } catch {
        return null;
    }
}

/**
 * Congela a multa no pedido de cancelamento: lê as parcelas do contrato, calcula a base (o que falta
 * pagar do plano) com o % vigente e grava a marca em audit_logs — com a LISTA das parcelas que compõem
 * a base (id + valor), para a base efetiva saber depois qual delas foi paga. Rode DENTRO da transação
 * que muda o contrato para PENDING_CANCELLATION (pedido e marca nascem juntos).
 */
export async function freezeCancellationFine(
    db: Db,
    contractId: string,
    performedBy: string,
    extra: Record<string, unknown> = {},
): Promise<CancellationSnapshot> {
    const [payments, finePct] = await Promise.all([
        db.payment.findMany({ where: { contractId }, select: FINE_BASIS_SELECT }),
        getConfig('cancellation_fine_pct'),
    ]);
    const installments: FrozenInstallment[] = payments.filter(isUnpaidPlanInstallment).map(p => ({ id: p.id, amount: p.amount }));
    const baseAmount = remainingPlanAmount(payments);
    const pct = Number.isFinite(finePct) && finePct > 0 ? finePct : 0;
    const fineAmount = computeFineAmount(baseAmount, pct);
    const row = await db.auditLog.create({
        data: {
            entityType: 'CONTRACT',
            entityId: contractId,
            action: AUDIT_CANCELLATION_REQUESTED,
            performedBy,
            changes: JSON.stringify({ baseAmount, finePct: pct, fineAmount, installments, ...extra }),
        },
    });
    return { requestedAt: row.createdAt, baseAmount, finePct: pct, fineAmount, frozen: true, installments };
}

/** Última marca de pedido de cancelamento do contrato (ou null — pedido anterior à regra). */
export async function readCancellationSnapshot(contractId: string, db: Db = prisma): Promise<CancellationSnapshot | null> {
    const row = await db.auditLog.findFirst({
        where: { entityType: 'CONTRACT', entityId: contractId, action: AUDIT_CANCELLATION_REQUESTED },
        orderBy: { createdAt: 'desc' },
        select: { changes: true, createdAt: true },
    });
    return row ? parseSnapshot(row) : null;
}

/**
 * Base da multa a usar na DECISÃO do admin: a congelada no pedido; sem marca (pedido anterior à regra),
 * calcula agora — ANTES de anular as parcelas — e grava a marca, para uma nova tentativa (falha no meio
 * do caminho) chegar ao mesmo valor mesmo com as parcelas já anuladas.
 */
export async function resolveCancellationBasis(contractId: string, performedBy: string): Promise<CancellationSnapshot> {
    const frozen = await readCancellationSnapshot(contractId);
    if (frozen) return frozen;
    const late = await freezeCancellationFine(prisma, contractId, performedBy, { lateFreeze: true });
    return { ...late, frozen: false };
}

// ─── Base efetiva (prévias e decisão) ────────────────────
// Congelar impede a base de AUMENTAR; nunca faz o cliente pagar multa sobre parcela já quitada.

/**
 * Base EFETIVA da multa (centavos) = MÍNIMO entre a base congelada no pedido e o que ainda falta pagar.
 *
 *  • Marca com a lista de parcelas (toda marca nova): soma, entre as parcelas que compunham a base, as
 *    que NÃO foram pagas depois do pedido — cada uma pelo menor valor entre o congelado e o atual. PAID /
 *    REFUNDED / linha apagada saem. CANCELLED continua contando: quem anula parcela do plano com o pedido
 *    em análise é o próprio cancelamento (a decisão anula antes de gerar a multa), então uma nova tentativa
 *    da decisão — falha no meio do caminho, parcelas já anuladas — chega ao mesmo valor.
 *  • Marca antiga (sem a lista): mínimo entre a base congelada e o saldo do plano de hoje (PENDING/FAILED).
 *    `voidedIds` = parcelas que estavam em aberto ANTES de a decisão anular: anuladas agora, ainda contam.
 */
export function effectiveFineBase(
    snapshot: Pick<CancellationSnapshot, 'baseAmount' | 'installments'>,
    payments: FineBasisPayment[],
    voidedIds?: ReadonlySet<string>,
): number {
    let owed = 0;
    if (snapshot.installments) {
        const byId = new Map(payments.map(p => [p.id, p]));
        for (const inst of snapshot.installments) {
            const cur = byId.get(inst.id);
            if (!cur) continue;
            if (cur.status === 'PENDING' || cur.status === 'FAILED' || cur.status === 'CANCELLED') owed += Math.min(inst.amount, cur.amount);
        }
    } else {
        for (const p of payments) {
            if (isUnpaidPlanInstallment(p) || (p.status === 'CANCELLED' && !!voidedIds?.has(p.id))) owed += p.amount;
        }
    }
    const frozenBase = Number.isFinite(snapshot.baseAmount) && snapshot.baseAmount > 0 ? snapshot.baseAmount : 0;
    return Math.max(0, Math.min(frozenBase, owed));
}

/** Base e multa EFETIVAS de um pedido (o % continua o congelado). `frozenBaseAmount` = a base do pedido. */
export function effectiveCancellationBasis(
    snapshot: CancellationSnapshot,
    payments: FineBasisPayment[],
    voidedIds?: ReadonlySet<string>,
): CancellationSnapshot & { frozenBaseAmount: number } {
    const baseAmount = effectiveFineBase(snapshot, payments, voidedIds);
    return { ...snapshot, baseAmount, fineAmount: computeFineAmount(baseAmount, snapshot.finePct), frozenBaseAmount: snapshot.baseAmount };
}

/** Cobranças do contrato no formato da base efetiva (leia de novo DEPOIS de anular, na decisão). */
export async function loadFineBasisPayments(contractId: string, db: Db = prisma): Promise<FineBasisPayment[]> {
    return db.payment.findMany({ where: { contractId }, select: FINE_BASIS_SELECT });
}

// ─── Visão para as telas (admin e cliente) ───────────────

export interface CancellationFineSummary {
    id: string;
    amount: number;
    status: string;
    dueDate: string | null;
    paidAt: string | null;
    /** % e base gravados na cobrança (metadata). */
    finePct: number | null;
    baseAmount: number | null;
}

export interface ContractCancellationInfo {
    /** Total efetivamente pago no contrato (cartão: valor do PaymentIntent) — parcelas, extras e multa. */
    paidTotal: number;
    /** O que falta pagar do PLANO agora (parcelas PENDING/FAILED sem bookingId e sem a multa). */
    remainingTotal: number;
    /** % da multa: o congelado no pedido (PENDING_CANCELLATION), o da multa gerada (CANCELLED) ou o vigente. */
    finePct: number;
    /**
     * Base da multa: a EFETIVA do pedido em análise (mínimo entre a congelada e o que ainda falta pagar),
     * a gravada na multa gerada, ou `remainingTotal` (prévia).
     */
    fineBaseAmount: number;
    /** Multa em centavos: a que "Cobrar multa" vai gerar (pedido em análise), a gerada, ou a prévia de hoje. */
    fineAmountPreview: number;
    /** ISO do pedido de cancelamento do cliente — só com o pedido em análise ou já resolvido (senão null). */
    cancellationRequestedAt: string | null;
    /** ISO do cancelamento (só com status CANCELLED). Contratos antigos: última atualização. */
    cancelledAt: string | null;
    /** Multa de cancelamento gerada (a mais recente não anulada), se houver. */
    cancellationFine: CancellationFineSummary | null;
}

type InfoContract = { id: string; status: string; updatedAt: Date };
type InfoPayment = {
    id: string;
    contractId: string | null;
    amount: number;
    chargedAmount: number | null;
    status: string;
    bookingId: string | null;
    metadata: unknown;
    provider: string | null;
    providerRef: string | null;
    dueDate: Date | null;
    paidAt: Date | null;
    createdAt: Date;
};

const INFO_PAYMENT_SELECT = {
    id: true, contractId: true, amount: true, chargedAmount: true, status: true, bookingId: true,
    metadata: true, provider: true, providerRef: true, dueDate: true, paidAt: true, createdAt: true,
} as const;

function pickFine(payments: InfoPayment[]): CancellationFineSummary | null {
    const fines = payments.filter(isCancellationFine).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const fine = fines.find(f => f.status !== 'CANCELLED') ?? fines[0];
    if (!fine) return null;
    const meta = asObject(fine.metadata);
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    return {
        id: fine.id,
        amount: fine.amount,
        status: fine.status,
        dueDate: fine.dueDate ? fine.dueDate.toISOString() : null,
        paidAt: fine.paidAt ? fine.paidAt.toISOString() : null,
        finePct: num(meta.finePct),
        baseAmount: num(meta.baseAmount),
    };
}

/**
 * Dados de cancelamento/multa de vários contratos de uma vez (lista do admin, detalhe e Meus Contratos):
 * 3 consultas no total, seja qual for o nº de contratos.
 */
export async function loadCancellationInfo(contracts: InfoContract[]): Promise<Map<string, ContractCancellationInfo>> {
    const result = new Map<string, ContractCancellationInfo>();
    if (contracts.length === 0) return result;
    const ids = contracts.map(c => c.id);
    // Import dinâmico: este módulo é carregado por paymentEffects (efeitos de pagamento) e não deve puxar
    // o roteador de PIX no carregamento — só o critério único de "valor efetivamente cobrado".
    const { paidChargedAmount } = await import('./pixGateway.js');

    const [payments, audits, currentPctRaw] = await Promise.all([
        prisma.payment.findMany({ where: { contractId: { in: ids } }, select: INFO_PAYMENT_SELECT }) as Promise<InfoPayment[]>,
        prisma.auditLog.findMany({
            where: { entityType: 'CONTRACT', entityId: { in: ids }, action: { in: [AUDIT_CANCELLATION_REQUESTED, AUDIT_CONTRACT_CANCELLED] } },
            orderBy: { createdAt: 'asc' },
            select: { entityId: true, action: true, changes: true, createdAt: true },
        }),
        getConfig('cancellation_fine_pct'),
    ]);
    const currentPct = Number.isFinite(currentPctRaw) && currentPctRaw > 0 ? currentPctRaw : 0;

    const byContract = new Map<string, InfoPayment[]>();
    for (const p of payments) {
        if (!p.contractId) continue;
        const list = byContract.get(p.contractId);
        if (list) list.push(p); else byContract.set(p.contractId, [p]);
    }
    // Ordenado por createdAt asc → o último de cada contrato vence.
    const lastRequest = new Map<string, { changes: string | null; createdAt: Date }>();
    const lastCancelled = new Map<string, Date>();
    for (const a of audits) {
        if (a.action === AUDIT_CANCELLATION_REQUESTED) lastRequest.set(a.entityId, a);
        else lastCancelled.set(a.entityId, a.createdAt);
    }

    for (const c of contracts) {
        const list = byContract.get(c.id) ?? [];
        const paidTotal = list.reduce((s, p) => s + (p.status === 'PAID' ? paidChargedAmount(p) : 0), 0);
        const remainingTotal = remainingPlanAmount(list);
        const fine = pickFine(list);
        const requestRow = lastRequest.get(c.id);
        const snapshot = requestRow ? parseSnapshot(requestRow) : null;

        let finePct = currentPct;
        let fineBaseAmount = remainingTotal;
        let fineAmountPreview = computeFineAmount(remainingTotal, currentPct);
        // Só vale para o pedido em análise ou já resolvido: um contrato reaberto pelo admin (volta a ACTIVE)
        // não carrega a data de um pedido antigo.
        let cancellationRequestedAt: string | null = null;
        let cancelledAt: string | null = null;

        if (c.status === 'PENDING_CANCELLATION') {
            if (snapshot) {
                // Base EFETIVA: parcela paga durante a análise sai da base (a mesma conta da decisão).
                const effective = effectiveCancellationBasis(snapshot, list);
                finePct = effective.finePct;
                fineBaseAmount = effective.baseAmount;
                fineAmountPreview = effective.fineAmount;
            }
            // Pedido anterior à regra (sem marca): a última atualização é a do pedido.
            cancellationRequestedAt = (requestRow?.createdAt ?? c.updatedAt).toISOString();
        } else if (c.status === 'CANCELLED') {
            cancellationRequestedAt = requestRow ? requestRow.createdAt.toISOString() : null;
            finePct = fine?.finePct ?? snapshot?.finePct ?? currentPct;
            fineBaseAmount = fine?.baseAmount ?? 0;
            fineAmountPreview = fine && fine.status !== 'CANCELLED' ? fine.amount : 0;
            cancelledAt = (lastCancelled.get(c.id) ?? c.updatedAt).toISOString();
        }

        result.set(c.id, {
            paidTotal, remainingTotal, finePct, fineBaseAmount, fineAmountPreview,
            cancellationRequestedAt, cancelledAt, cancellationFine: fine,
        });
    }
    return result;
}

/** Marca a data do cancelamento do contrato na trilha de auditoria (nunca lança). */
export async function markContractCancelled(contractId: string, performedBy: string, details: Record<string, unknown> = {}): Promise<void> {
    try {
        await prisma.auditLog.create({
            data: {
                entityType: 'CONTRACT', entityId: contractId, action: AUDIT_CONTRACT_CANCELLED, performedBy,
                changes: JSON.stringify(details),
            },
        });
    } catch (err) {
        console.error('[CancellationFine] Falha ao registrar o cancelamento na auditoria:', err);
    }
}

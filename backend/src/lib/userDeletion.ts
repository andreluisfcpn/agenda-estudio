// ─── Exclusão de cliente (D3) ────────────────────────────────────────────────
// Regra do dono:
//   • Cliente SEM nenhum vínculo de negócio → exclusão FÍSICA (hard delete).
//   • Com QUALQUER vínculo → SOFT DELETE com ANONIMIZAÇÃO: deletedAt = agora, dados pessoais → null
//     (o nome fica para o histórico financeiro; e-mail/CPF ficam livres para um novo cadastro).
//   • NÃO bloqueia por pendências: no soft delete, contratos em andamento são cancelados (parcelas
//     PENDING anuladas), gravações futuras canceladas (liberando os horários), cobranças PENDING
//     anuladas e a cobrança automática desligada — o modal mostra tudo isso antes (getDeletionPreview).
//   • Antes de anular qualquer cobrança, ela é CONCILIADA e CANCELADA no provedor (PIX Sicoob/Cora,
//     PaymentIntent Stripe): o que já foi pago fica PAID (nunca é anulado); pagamento em andamento no
//     provedor adia a exclusão (409) em vez de virar dinheiro sem registro.
//   • A sessão aberta do cliente é encerrada NA HORA (revogação no Redis, lida pelo authenticate).
//
// "Vínculo de negócio" = contratos, agendamentos, pagamentos, resgates de cupom e bloqueios de agenda
// criados pelo usuário (todas FKs RESTRICT). Notificações, push, cartões salvos e elegibilidade de cupom
// são ACESSÓRIOS (FK CASCADE) e não impedem o hard delete. AuditLog não tem FK.

import { prisma } from './prisma.js';
import { logAudit } from './audit.js';
import { acquireMutex, releaseMutex, releaseMultiSlotLock } from './redis.js';
import { saoPauloParts } from './spTime.js';
import { onPaymentConfirmed, voidContractPendingPayments } from './paymentEffects.js';
import { releaseCouponForPayments } from './couponService.js';
import { isPixProvider, retirePixCharge, paidChargedAmount } from './pixGateway.js';
import { settleContractCharges, type ChargeSettlement } from '../jobs/cleanExpiredHolds.js';
import { revokeUserSessions, clearUserSessionRevocation, userDeletionLockKey } from '../middleware/auth.js';
import { getPackageSlots } from '../utils/pricing.js';
import type { BookingStatus, ContractStatus, Prisma } from '../generated/prisma/client.js';

/**
 * Folga da revogação final (exclusão concluída): tokens assinados até N s DEPOIS do commit também
 * são recusados — cobre login/refresh que leram o usuário antes do deletedAt/delete e assinaram
 * logo depois (bcrypt, verificação do Google). Conta excluída nunca mais recebe token legítimo.
 */
const FINAL_REVOCATION_GRACE_S = 60;

/** Contratos "em andamento" que o soft delete cancela. */
const CANCELLABLE_CONTRACT_STATUSES: ContractStatus[] = ['ACTIVE', 'PAUSED', 'AWAITING_PAYMENT', 'PENDING_CANCELLATION'];
/** Gravações ainda não realizadas (as que ocupam agenda). */
const OPEN_BOOKING_STATUSES: BookingStatus[] = ['RESERVED', 'HELD', 'CONFIRMED'];

/** Erro de regra da exclusão, com o status HTTP que a rota deve devolver. */
export class UserDeletionError extends Error {
    constructor(public httpStatus: number, message: string) {
        super(message);
        this.name = 'UserDeletionError';
    }
}

export interface DeletionPreview {
    userId: string;
    name: string;
    /** 'hard' = nada de negócio vinculado (apaga de vez); 'soft' = anonimiza e preserva o histórico. */
    mode: 'hard' | 'soft';
    /** Vínculos de negócio (qualquer um > 0 força o soft delete). */
    links: { contracts: number; bookings: number; payments: number; couponRedemptions: number; blockedSlots: number };
    /** O que o soft delete vai cancelar/anular. pendingAmount em centavos. */
    pending: { activeContracts: number; futureBookings: number; pendingPayments: number; pendingAmount: number };
    /** Histórico financeiro preservado (sem dados pessoais). paidAmount em centavos. */
    preserved: { paidPayments: number; paidAmount: number };
    /** Acessórios apagados em qualquer modo (não impedem o hard delete). */
    accessories: { savedCards: number; pushSubscriptions: number; notifications: number; couponEligibilities: number; autoChargeEnabled: boolean };
}

export interface CancelledCounts { contracts: number; bookings: number; payments: number }

export interface DeleteUserResult {
    softDeleted: boolean;
    cancelled: CancelledCounts;
    /**
     * Cobranças que estavam PENDING na abertura da exclusão e foram confirmadas no provedor durante
     * ela (PIX pago no último instante, cartão aprovado): ficam PAID — não são anuladas nem estornadas
     * automaticamente. amount em centavos.
     */
    paidDuringDeletion: { payments: number; amount: number };
}

/** Meia-noite UTC da data-calendário de HOJE em São Paulo (mesmo padrão de Booking.date @db.Date). */
function startOfTodaySp(now: Date = new Date()): Date {
    return new Date(`${saoPauloParts(now).dateStr}T00:00:00.000Z`);
}

const SP_HHMM = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** 'HH:MM' de agora no relógio de São Paulo (mesmo formato de Booking.startTime). */
function nowHHMMSp(now: Date = new Date()): string {
    return SP_HHMM.format(now);
}

/**
 * Gravações que o soft delete cancela: ainda não realizadas (RESERVED/HELD/CONFIRMED) cujo INÍCIO
 * (data + hora, SP) ainda não chegou e sem gravação iniciada. As de hoje que já começaram (ou com
 * "Iniciar gravação") ficam como estão para o operador finalizar/marcar falta — não se reescreve o
 * histórico. `startTime` é sempre 'HH:MM' com zero à esquerda, então a comparação de texto vale.
 * A prévia usa o MESMO critério (o número do modal bate com o que é cancelado).
 */
function futureBookingsWhere(userId: string, now: Date): Prisma.BookingWhereInput {
    const today = startOfTodaySp(now);
    return {
        userId,
        status: { in: OPEN_BOOKING_STATUSES },
        recordingStartedAt: null,
        OR: [
            { date: { gt: today } },
            { date: today, startTime: { gt: nowHHMMSp(now) } },
        ],
    };
}

/**
 * Valida se `userId` pode ser excluído por `actorId` (admin). Lança UserDeletionError:
 * 400 auto-exclusão / conta ADMIN, 404 inexistente, 409 já excluído.
 */
export async function assertUserDeletable(userId: string, actorId: string): Promise<{ id: string; name: string }> {
    if (userId === actorId) throw new UserDeletionError(400, 'Você não pode excluir sua própria conta.');
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true, role: true, deletedAt: true },
    });
    if (!user) throw new UserDeletionError(404, 'Usuário não encontrado.');
    if (user.role === 'ADMIN') throw new UserDeletionError(400, 'Contas de administrador não podem ser excluídas por aqui.');
    if (user.deletedAt) throw new UserDeletionError(409, 'Este cliente já foi excluído.');
    return { id: user.id, name: user.name };
}

/** Contagens reais para o modal de exclusão mostrar as consequências. */
export async function getDeletionPreview(userId: string, now: Date = new Date()): Promise<DeletionPreview> {
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true, autoChargeEnabled: true },
    });
    if (!user) throw new UserDeletionError(404, 'Usuário não encontrado.');

    const [
        contracts, bookings, payments, couponRedemptions, blockedSlots,
        activeContracts, futureBookings, pendingAgg, paidRows,
        savedCards, pushSubscriptions, notifications, couponEligibilities,
    ] = await Promise.all([
        prisma.contract.count({ where: { userId } }),
        prisma.booking.count({ where: { userId } }),
        prisma.payment.count({ where: { userId } }),
        prisma.couponRedemption.count({ where: { userId } }),
        prisma.blockedSlot.count({ where: { createdBy: userId } }),
        prisma.contract.count({ where: { userId, status: { in: CANCELLABLE_CONTRACT_STATUSES } } }),
        prisma.booking.count({ where: futureBookingsWhere(userId, now) }),
        prisma.payment.aggregate({ where: { userId, status: 'PENDING' }, _count: { _all: true }, _sum: { amount: true } }),
        // Pago = valor EFETIVAMENTE cobrado (cartão: o do PaymentIntent) — mesmo critério do fechamento.
        prisma.payment.findMany({ where: { userId, status: 'PAID' }, select: { amount: true, chargedAmount: true, provider: true, providerRef: true } }),
        prisma.savedPaymentMethod.count({ where: { userId } }),
        prisma.pushSubscription.count({ where: { userId } }),
        prisma.notification.count({ where: { userId } }),
        prisma.couponEligibleUser.count({ where: { userId } }),
    ]);

    const businessLinks = contracts + bookings + payments + couponRedemptions + blockedSlots;
    return {
        userId: user.id,
        name: user.name,
        mode: businessLinks > 0 ? 'soft' : 'hard',
        links: { contracts, bookings, payments, couponRedemptions, blockedSlots },
        pending: {
            activeContracts,
            futureBookings,
            pendingPayments: pendingAgg._count._all,
            pendingAmount: pendingAgg._sum.amount ?? 0,
        },
        preserved: { paidPayments: paidRows.length, paidAmount: paidRows.reduce((s, p) => s + paidChargedAmount(p), 0) },
        accessories: { savedCards, pushSubscriptions, notifications, couponEligibilities, autoChargeEnabled: user.autoChargeEnabled },
    };
}

// ─── Conciliação/cancelamento no provedor ANTES de anular (D2/D15) ──────────
// Anular só no banco deixava o QR PIX pagável e o PaymentIntent confirmável: o dinheiro chegava
// e a conciliação/webhook ignoravam a linha CANCELLED (sem registro, sem alerta). Cobranças de
// contrato reusam settleContractCharges (mesma rotina da varredura de contratos abandonados).

/** Janela em que um cartão em autenticação (3DS) segura a exclusão — a mesma da varredura. */
const STRIPE_ACTION_GRACE_MS = 30 * 60 * 1000;

type StandaloneCharge = { id: string; provider: string; providerRef: string | null; amount: number; chargedAmount: number | null };

/** PI de cartão sem contrato já aprovado: marca PAID (atômico, mesmas checagens do webhook) + efeitos. */
async function confirmStandaloneIntent(
    p: StandaloneCharge,
    pi: { id: string; amount: number; metadata?: Record<string, string> | null; payment_method_types?: string[] },
): Promise<ChargeSettlement> {
    if (pi.metadata?.paymentId && pi.metadata.paymentId !== p.id) {
        console.error(`[UserDeletion][SECURITY] PI ${pi.id} pertence a outro pagamento (${pi.metadata.paymentId}) — payment ${p.id} mantido para análise.`);
        return 'inflight';
    }
    const expected = p.chargedAmount ?? p.amount;
    if (pi.amount !== expected) {
        console.error(`[UserDeletion][SECURITY] PI ${pi.id} pago com valor divergente (PI=${pi.amount}, DB=${expected}) — payment ${p.id} mantido para análise.`);
        return 'inflight';
    }
    const upd = await prisma.payment.updateMany({
        where: { id: p.id, status: 'PENDING' },
        data: {
            status: 'PAID',
            paidAt: new Date(),
            providerRef: pi.id,
            paymentType: pi.payment_method_types?.includes('card') ? 'CREDIT' : null,
        },
    });
    if (upd.count > 0) await onPaymentConfirmed(p.id);
    return 'paid';
}

async function settleStandaloneStripe(p: StandaloneCharge): Promise<ChargeSettlement> {
    const ref = p.providerRef;
    if (!ref || !ref.startsWith('pi_') || ref.startsWith('pi_mock')) return 'clear';
    const { isStripeEnabled, stripeGetPaymentIntent, stripeCancelPaymentIntent } = await import('./stripeService.js');
    if (!(await isStripeEnabled())) return 'clear';
    let pi;
    try {
        pi = await stripeGetPaymentIntent(ref);
    } catch (err) {
        const e = err as { code?: string; raw?: { code?: string } };
        if (e?.code === 'resource_missing' || e?.raw?.code === 'resource_missing') return 'clear';
        console.warn(`[UserDeletion] Stripe indisponível ao conciliar ${p.id}:`, err instanceof Error ? err.message : err);
        return 'inflight';
    }
    if (pi.status === 'succeeded') return confirmStandaloneIntent(p, pi);
    if (pi.status === 'canceled') return 'clear';
    if (pi.status === 'processing') return 'inflight';
    if (pi.status === 'requires_action' && Date.now() - pi.created * 1000 < STRIPE_ACTION_GRACE_MS) return 'inflight';
    const r = await stripeCancelPaymentIntent(ref);
    if (r.canceled) return 'clear';
    if (r.status === 'succeeded') return confirmStandaloneIntent(p, await stripeGetPaymentIntent(ref));
    return 'inflight';
}

/**
 * Cobrança sem contrato: PIX → retirePixCharge (concilia + cancela a cob/fatura); cartão → PI.
 * PIX 'live' = a cob continua PAGÁVEL no provedor (remoção recusada/provedor fora do ar, ou paga com
 * valor divergente) → 'inflight' (409, nada é anulado), igual ao caminho de contrato. Anular com o
 * QR ainda pagável viraria dinheiro sem registro.
 */
async function settleStandaloneCharge(p: StandaloneCharge): Promise<ChargeSettlement> {
    if (isPixProvider(p.provider)) {
        const r = await retirePixCharge(p.id);
        return r === 'paid' ? 'paid' : r === 'live' ? 'inflight' : 'clear';
    }
    if (p.provider === 'STRIPE') return settleStandaloneStripe(p);
    return 'clear';
}

/**
 * Concilia e cancela no provedor TODAS as cobranças PENDING do cliente que têm cobrança emitida
 * (providerRef). Pagas → PAID com os efeitos (saem sozinhas dos updateMany guardados por PENDING);
 * vivas → canceladas no provedor. Devolve quantas ficaram "em andamento" (não dá para anular agora).
 */
async function settleUserProviderCharges(userId: string): Promise<{ inflight: number }> {
    const charges = await prisma.payment.findMany({
        where: { userId, status: 'PENDING', providerRef: { not: null } },
        select: { id: true, contractId: true, provider: true, providerRef: true, amount: true, chargedAmount: true },
    });
    let inflight = 0;

    const byContract = new Map<string, number>();
    for (const c of charges) if (c.contractId) byContract.set(c.contractId, (byContract.get(c.contractId) ?? 0) + 1);
    for (const [contractId, count] of byContract) {
        // settleContractCharges para no 1º 'paid' (os efeitos já rodaram) → chama de novo até não
        // restar cobrança paga a conciliar (cada rodada relê só as ainda PENDING).
        for (let round = 0; round <= count; round++) {
            let r: ChargeSettlement;
            try {
                r = await settleContractCharges(contractId);
            } catch (err) {
                console.error(`[UserDeletion] Falha ao conciliar as cobranças do contrato ${contractId}:`, err);
                r = 'inflight';
            }
            if (r === 'paid') continue;
            if (r === 'inflight') inflight++;
            break;
        }
    }

    for (const p of charges.filter(c => !c.contractId)) {
        let r: ChargeSettlement;
        try {
            r = await settleStandaloneCharge(p);
        } catch (err) {
            console.error(`[UserDeletion] Falha ao conciliar o pagamento ${p.id}:`, err);
            r = 'inflight';
        }
        if (r === 'inflight') inflight++;
    }
    return { inflight };
}

/**
 * Anula as cobranças PENDING sem contrato (ex.: compra de serviço avulsa numa gravação), com a mesma
 * semântica de voidContractPendingPayments: PENDING → CANCELLED, devolve o cupom reservado e cancela
 * assinatura Stripe vinculada (best-effort). Só toca linhas ainda PENDING (um PAID concorrente vence).
 */
async function voidStandalonePendingPayments(userId: string): Promise<number> {
    const pending = await prisma.payment.findMany({
        where: { userId, contractId: null, status: 'PENDING' },
        select: { id: true, stripeSubscriptionId: true },
    });
    if (pending.length === 0) return 0;
    const ids = pending.map(p => p.id);

    const voided = await prisma.payment.updateMany({
        where: { id: { in: ids }, status: 'PENDING' },
        data: { status: 'CANCELLED' },
    });
    if (voided.count > 0) {
        // Devolve o cupom só das que de fato viraram CANCELLED aqui (uma confirmada no meio do
        // caminho mantém o uso — o RESERVED dela vira CONFIRMED pelo onPaymentConfirmed).
        const nowCancelled = await prisma.payment.findMany({
            where: { id: { in: ids }, status: 'CANCELLED' },
            select: { id: true },
        });
        await releaseCouponForPayments(nowCancelled.map(p => p.id));
    }

    const subscriptionIds = [...new Set(pending.map(p => p.stripeSubscriptionId).filter((s): s is string => !!s))];
    if (subscriptionIds.length > 0) {
        try {
            const { isStripeEnabled, stripeCancelSubscription } = await import('./stripeService.js');
            if (await isStripeEnabled()) {
                for (const subId of subscriptionIds) {
                    try {
                        await stripeCancelSubscription(subId);
                    } catch (subErr) {
                        console.error(`[UserDeletion] Falha ao cancelar a assinatura ${subId} (conferir manualmente):`, subErr instanceof Error ? subErr.message : subErr);
                    }
                }
            }
        } catch (err) {
            console.error('[UserDeletion] Cancelamento de assinatura Stripe ignorado:', err instanceof Error ? err.message : err);
        }
    }
    return voided.count;
}

/**
 * (a) do soft delete: encerra tudo que ainda "anda" no nome do cliente. Idempotente — uma nova
 * chamada só pega o que sobrou. Ordem: desliga a cobrança automática primeiro (o autoChargeJob não
 * dispara no meio), concilia/cancela as cobranças no provedor, e só então anula parcelas (ANTES de
 * mudar o status do contrato — mesmo padrão do DELETE /contracts/:id).
 * Pagamento em andamento no provedor → 409 SEM anular nada (a cobrança automática volta como estava).
 */
async function cancelUserPendencies(userId: string, now: Date): Promise<CancelledCounts> {
    const before = await prisma.user.findUnique({ where: { id: userId }, select: { autoChargeEnabled: true } });
    await prisma.user.update({ where: { id: userId }, data: { autoChargeEnabled: false } });

    // 0) Provedor primeiro: o que foi pago vira PAID; cobranças vivas são canceladas lá.
    const { inflight } = await settleUserProviderCharges(userId);
    if (inflight > 0) {
        if (before?.autoChargeEnabled) {
            await prisma.user.updateMany({ where: { id: userId, deletedAt: null }, data: { autoChargeEnabled: true } });
        }
        throw new UserDeletionError(409, 'Há um pagamento deste cliente em processamento no provedor (cartão em autenticação ou PIX sendo confirmado). Nada foi excluído — tente de novo em alguns minutos; se persistir, confira as cobranças pendentes do cliente no financeiro.');
    }

    let contracts = 0;
    let bookings = 0;
    let payments = 0;

    // 1) Contratos em andamento → parcelas PENDING anuladas + CANCELLED.
    const running = await prisma.contract.findMany({
        where: { userId, status: { in: CANCELLABLE_CONTRACT_STATUSES } },
        select: { id: true },
    });
    for (const c of running) {
        payments += await voidContractPendingPayments(c.id);
        const upd = await prisma.contract.updateMany({
            where: { id: c.id, status: { in: CANCELLABLE_CONTRACT_STATUSES } },
            data: { status: 'CANCELLED' },
        });
        contracts += upd.count;
    }

    // 2) Parcelas PENDING que sobraram em contratos já encerrados (EXPIRED/COMPLETED/CANCELLED —
    //    ex.: multa de cancelamento, parcela de contrato concluído) → anuladas também.
    const leftover = await prisma.payment.findMany({
        where: { userId, status: 'PENDING', contractId: { not: null } },
        select: { contractId: true },
        distinct: ['contractId'],
    });
    for (const p of leftover) {
        if (p.contractId) payments += await voidContractPendingPayments(p.contractId);
    }

    // 3) Cobranças PENDING sem contrato.
    payments += await voidStandalonePendingPayments(userId);

    // 4) Gravações que ainda não começaram → CANCELLED, liberando as travas Redis de RESERVED/HELD
    //    (mesmo critério do DELETE /bookings/:id). Sem devolução de crédito: os contratos foram
    //    cancelados acima. As de hoje já iniciadas ficam para o operador (futureBookingsWhere).
    const future = await prisma.booking.findMany({
        where: futureBookingsWhere(userId, now),
        select: { id: true, date: true, startTime: true, status: true, userId: true },
    });
    for (const b of future) {
        const upd = await prisma.booking.updateMany({
            where: { id: b.id, status: { in: OPEN_BOOKING_STATUSES }, recordingStartedAt: null },
            data: { status: 'CANCELLED' },
        });
        if (upd.count === 0) continue;
        bookings += upd.count;
        if (b.status === 'RESERVED' || b.status === 'HELD') {
            try {
                await releaseMultiSlotLock(b.date.toISOString().split('T')[0], getPackageSlots(b.startTime), b.userId);
            } catch (err) {
                console.error(`[UserDeletion] Falha ao liberar a trava do agendamento ${b.id} (expira sozinha pelo TTL):`, err instanceof Error ? err.message : err);
            }
        }
    }

    // 5) Janelas de remarcação abertas (falta justificada / não realizado) → encerradas: não há mais
    //    cliente para remarcar, e o job de expiração não deve alertar os admins por elas.
    await prisma.booking.updateMany({
        where: { userId, makeupStatus: 'OPEN' },
        data: { makeupStatus: 'EXPIRED' },
    });

    return { contracts, bookings, payments };
}

/** Desvincula no Stripe os cartões salvos (best-effort). Devolve quantos foram desvinculados. */
async function detachSavedCards(userId: string): Promise<number> {
    const cards = await prisma.savedPaymentMethod.findMany({
        where: { userId },
        select: { stripePaymentMethodId: true },
    });
    if (cards.length === 0) return 0;
    let detached = 0;
    try {
        const { isStripeEnabled, stripeDetachPaymentMethod } = await import('./stripeService.js');
        if (!(await isStripeEnabled())) return 0;
        for (const card of cards) {
            try {
                await stripeDetachPaymentMethod(card.stripePaymentMethodId);
                detached++;
            } catch (err) {
                console.error('[UserDeletion] Falha ao desvincular um cartão no Stripe (segue sem registro local):', err instanceof Error ? err.message : err);
            }
        }
    } catch (err) {
        console.error('[UserDeletion] Desvinculação de cartões no Stripe ignorada:', err instanceof Error ? err.message : err);
    }
    return detached;
}

/**
 * Apaga o Customer do Stripe (e-mail, nome, metadata.userId) no delete FÍSICO — best-effort: a
 * exclusão local nunca falha por isso. Usa o helper `stripeDeleteCustomer` de stripeService
 * (customers.del também desvincula os cartões e encerra assinaturas no Stripe).
 */
async function deleteStripeCustomer(customerId: string): Promise<boolean> {
    try {
        const stripe = await import('./stripeService.js') as typeof import('./stripeService.js') & {
            stripeDeleteCustomer?: (id: string) => Promise<void>;
        };
        if (!(await stripe.isStripeEnabled())) return false;
        if (typeof stripe.stripeDeleteCustomer !== 'function') {
            console.warn(`[UserDeletion] stripeDeleteCustomer indisponível — Customer ${customerId} mantido no Stripe (remover manualmente).`);
            return false;
        }
        await stripe.stripeDeleteCustomer(customerId);
        return true;
    } catch (err) {
        console.error(`[UserDeletion] Falha ao apagar o Customer ${customerId} no Stripe (conferir manualmente):`, err instanceof Error ? err.message : err);
        return false;
    }
}

/** PENDING na abertura que viraram PAID durante a exclusão (conciliação ou webhook concorrente). */
async function paidAmong(ids: string[]): Promise<{ payments: number; amount: number }> {
    if (ids.length === 0) return { payments: 0, amount: 0 };
    const agg = await prisma.payment.aggregate({
        where: { id: { in: ids }, status: 'PAID' },
        _count: { _all: true },
        _sum: { amount: true },
    });
    return { payments: agg._count._all, amount: agg._sum.amount ?? 0 };
}

/**
 * SOFT DELETE com anonimização. (a) concilia no provedor e cancela pendências; (b) desvincula
 * cartões no Stripe; (c) numa transação: deletedAt + anonimização + apaga acessórios (push, cartões,
 * elegibilidade de cupom, notificações); (d) auditoria SEM dados pessoais.
 * Mantém: name (histórico financeiro) e stripeCustomerId (referência para estorno/conciliação).
 */
export async function softDeleteUser(userId: string, adminId: string, now: Date = new Date()): Promise<DeleteUserResult> {
    const pendingAtStart = (await prisma.payment.findMany({ where: { userId, status: 'PENDING' }, select: { id: true } })).map(p => p.id);
    const cancelled = await cancelUserPendencies(userId, now);
    const detachedCards = await detachSavedCards(userId);

    const removed = await prisma.$transaction(async (tx) => {
        const upd = await tx.user.updateMany({
            where: { id: userId, deletedAt: null },
            data: {
                deletedAt: new Date(),
                email: null,
                googleId: null,
                passwordHash: null,
                cpfCnpj: null,
                phone: null,
                address: null,
                addressNumber: null,
                complement: null,
                neighborhood: null,
                city: null,
                state: null,
                zipCode: null,
                photoUrl: null,
                socialLinks: null,
                notes: null,
                tags: [],
                autoChargeEnabled: false,
            },
        });
        if (upd.count === 0) throw new UserDeletionError(409, 'Este cliente já foi excluído.');
        const push = await tx.pushSubscription.deleteMany({ where: { userId } });
        const cards = await tx.savedPaymentMethod.deleteMany({ where: { userId } });
        const eligibilities = await tx.couponEligibleUser.deleteMany({ where: { userId } });
        const notifications = await tx.notification.deleteMany({ where: { userId } });
        return {
            pushSubscriptions: push.count,
            savedCards: cards.count,
            couponEligibilities: eligibilities.count,
            notifications: notifications.count,
        };
    });
    // Revogação FINAL, depois do commit: um login/refresh que leu o usuário antes do deletedAt e
    // assinou o token durante a exclusão também morre (com folga para quem ainda está assinando).
    await revokeUserSessions(userId, { graceSeconds: FINAL_REVOCATION_GRACE_S });

    const paidDuringDeletion = await paidAmong(pendingAtStart);
    if (paidDuringDeletion.payments > 0) {
        console.warn(`[UserDeletion] ${paidDuringDeletion.payments} pagamento(s) de ${userId} confirmado(s) no provedor durante a exclusão — mantido(s) PAID; avaliar estorno.`);
    }
    await logAudit('USER', userId, 'SOFT_DELETED', adminId, { cancelled, removed, detachedCards, paidDuringDeletion });
    return { softDeleted: true, cancelled, paidDuringDeletion };
}

/**
 * HARD DELETE (só quando não há vínculo de negócio). Desvincula os cartões no Stripe (best-effort),
 * apaga o usuário — notificações/push/cartões/elegibilidade caem por CASCADE — e, SÓ DEPOIS do delete
 * local dar certo, apaga o Customer do Stripe. Se um vínculo RESTRICT surgir em corrida, o Postgres
 * recusa com P2003 (quem chama cai para o soft delete, que precisa do Customer para estorno).
 */
export async function hardDeleteUser(userId: string, adminId: string): Promise<void> {
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { stripeCustomerId: true } });
    await detachSavedCards(userId);
    await prisma.user.delete({ where: { id: userId } });
    // Revogação FINAL (ver softDeleteUser): token assinado por um login/refresh em corrida com o delete.
    await revokeUserSessions(userId, { graceSeconds: FINAL_REVOCATION_GRACE_S });
    const stripeCustomerDeleted = u?.stripeCustomerId ? await deleteStripeCustomer(u.stripeCustomerId) : false;
    await logAudit('USER', userId, 'DELETED', adminId, { mode: 'hard', stripeCustomerDeleted });
}

function isForeignKeyViolation(err: unknown): boolean {
    return !!err && typeof err === 'object' && (err as { code?: string }).code === 'P2003';
}

/** A exclusão não aconteceu: a sessão do cliente volta a valer (a menos que ele esteja bloqueado). */
async function undoRevocationIfNotDeleted(userId: string): Promise<void> {
    try {
        const u = await prisma.user.findUnique({ where: { id: userId }, select: { deletedAt: true, clientStatus: true } });
        if (u && !u.deletedAt && u.clientStatus !== 'BLOCKED') await clearUserSessionRevocation(userId);
    } catch (err) {
        console.error(`[UserDeletion] Falha ao restaurar a sessão de ${userId}:`, err instanceof Error ? err.message : err);
    }
}

/**
 * Ponto único usado pela rota DELETE /api/users/:id: valida, encerra a sessão do cliente na hora,
 * decide hard × soft pelos vínculos reais e executa. Serializado por usuário (mutex Redis) para um
 * duplo clique não rodar duas vezes.
 */
export async function deleteUser(userId: string, adminId: string, now: Date = new Date()): Promise<DeleteUserResult> {
    const lockKey = userDeletionLockKey(userId); // o login recusa enquanto ela existe
    if (!(await acquireMutex(lockKey, 120))) {
        throw new UserDeletionError(409, 'A exclusão deste cliente já está em andamento.');
    }
    try {
        await assertUserDeletable(userId, adminId);
        // Revoga ANTES de cancelar: o cliente não cria reserva/cobrança nova enquanto a exclusão roda.
        await revokeUserSessions(userId);
        try {
            const preview = await getDeletionPreview(userId, now);
            if (preview.mode === 'hard') {
                try {
                    await hardDeleteUser(userId, adminId);
                    return { softDeleted: false, cancelled: { contracts: 0, bookings: 0, payments: 0 }, paidDuringDeletion: { payments: 0, amount: 0 } };
                } catch (err) {
                    if (!isForeignKeyViolation(err)) throw err;
                    console.warn(`[UserDeletion] Vínculo criado durante a exclusão de ${userId} — seguindo com o soft delete.`);
                }
            }
            return await softDeleteUser(userId, adminId, now);
        } catch (err) {
            await undoRevocationIfNotDeleted(userId);
            throw err;
        }
    } finally {
        await releaseMutex(lockKey).catch(() => {});
    }
}

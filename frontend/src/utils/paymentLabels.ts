// ─── Rótulos e contagem das cobranças de um contrato (área do cliente) ─────────
// Fonte única de "Parcela N/Total", "Multa de cancelamento (N%)" e do bloqueio de pagamento durante o
// cancelamento em análise — usada por Meus Contratos (ContractCard) e Meus Pagamentos, para as duas telas
// nunca discordarem. Espelha as regras do backend (lib/cancellationFine.ts e lib/cancellationPending.ts).

import type { PaymentSummary } from '../api/client';

type ChargeLike = Pick<PaymentSummary, 'id' | 'status' | 'dueDate'> & {
    kind?: PaymentSummary['kind'] | string | null;
    bookingId?: string | null;
};

/** A cobrança é a multa de cancelamento (E13)? */
export function isCancellationFine(p: { kind?: string | null }): boolean {
    return p.kind === 'CANCELLATION_FINE';
}

/**
 * Parcela do PLANO: não é a multa nem a cobrança de uma gravação (`bookingId` = extra de uma sessão ou a
 * própria reserva avulsa). Só estas entram em "Parcela N/Total".
 */
export function isPlanInstallment(p: { kind?: string | null; bookingId?: string | null }): boolean {
    return !isCancellationFine(p) && !p.bookingId;
}

/** "Multa de cancelamento (20%)" — sem o % quando a cobrança não o traz (multa anterior à regra). */
export function fineLabel(finePct?: number | null): string {
    return finePct != null && finePct > 0 ? `Multa de cancelamento (${finePct}%)` : 'Multa de cancelamento';
}

export interface InstallmentPosition { ordinal: number; total: number; }

/**
 * Posição "N/Total" de cada parcela do plano, por vencimento. Ficam FORA da contagem: a multa de
 * cancelamento, as cobranças de gravação (extras) e as parcelas ANULADAS (CANCELLED).
 */
export function installmentPositions(payments: ChargeLike[]): Map<string, InstallmentPosition> {
    const counted = payments
        .filter(p => isPlanInstallment(p) && p.status !== 'CANCELLED')
        .map((p, i) => ({ p, i }))
        .sort((a, b) =>
            ((a.p.dueDate ? new Date(a.p.dueDate).getTime() : 0) - (b.p.dueDate ? new Date(b.p.dueDate).getTime() : 0)) || (a.i - b.i));
    const positions = new Map<string, InstallmentPosition>();
    counted.forEach(({ p }, idx) => positions.set(p.id, { ordinal: idx + 1, total: counted.length }));
    return positions;
}

/**
 * O que é a cobrança, em uma expressão curta: "Multa de cancelamento (20%)", "Extra de gravação",
 * "Parcela 2/3" — ou null quando não há o que dizer (cobrança única, reserva avulsa).
 */
export function chargeLabel(
    p: ChargeLike,
    ctx: { isAvulso: boolean; finePct?: number | null; position?: InstallmentPosition },
): string | null {
    if (isCancellationFine(p)) return fineLabel(ctx.finePct);
    if (p.bookingId) return ctx.isAvulso ? null : 'Extra de gravação';
    if (ctx.position && ctx.position.total > 1) return `Parcela ${ctx.position.ordinal}/${ctx.position.total}`;
    return null;
}

/**
 * Cancelamento em análise (contrato PENDING_CANCELLATION): o CLIENTE não paga parcelas do plano até o
 * estúdio decidir — o backend responde 409 `CANCELLATION_PENDING`. Extras de gravação e a multa seguem pagáveis.
 */
export function isBlockedByPendingCancellation(
    contractStatus: string | null | undefined,
    p: { kind?: string | null; bookingId?: string | null },
): boolean {
    return contractStatus === 'PENDING_CANCELLATION' && isPlanInstallment(p);
}

/** Data-calendário de São Paulo ('YYYY-MM-DD') de um instante. */
function spYmd(d: Date): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/**
 * A multa vence no instante da decisão do estúdio: só conta como "em atraso" a partir do DIA seguinte
 * (calendário de São Paulo) — senão já nasceria vencida.
 */
export function isFineOverdue(dueDate: string | null | undefined, now: Date = new Date()): boolean {
    if (!dueDate) return false;
    const due = new Date(dueDate);
    if (Number.isNaN(due.getTime())) return false;
    return spYmd(due) < spYmd(now);
}

/**
 * Fuso em que o VENCIMENTO da cobrança é exibido: a multa vence num instante real (a decisão do estúdio) →
 * São Paulo, o mesmo calendário de `isFineOverdue`; as demais são datas-calendário (00:00Z) → UTC.
 */
export function dueDateTimeZone(p: { kind?: string | null }): 'America/Sao_Paulo' | 'UTC' {
    return isCancellationFine(p) ? 'America/Sao_Paulo' : 'UTC';
}

/** Data (dd/mm/aaaa) de um INSTANTE real (pagamento, cancelamento, decisão) no fuso de São Paulo. */
export function formatInstantDate(iso: string | null | undefined): string {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

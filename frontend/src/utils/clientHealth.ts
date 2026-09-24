import { UserDetail } from '../api/client';
import { isAvulsoContract } from './contractStatus';

/**
 * Valor EFETIVAMENTE cobrado de uma cobrança paga — mesmo critério do backend (pixGateway.paidChargedAmount,
 * usado no fechamento financeiro): no cartão é o valor do PaymentIntent (`chargedAmount`: sem o desconto PIX
 * do à vista, com os juros quando parcelado); no PIX/boleto é o `amount`. `chargedAmount` só vale quando a
 * cobrança paga foi a do CARTÃO (provider STRIPE ou providerRef pi_…) — uma linha paga no PIX pode guardar o
 * chargedAmount de uma tentativa de cartão abandonada. Use nas somas de "pago"; pendente continua o amount.
 */
export function paidChargedAmount(p: { amount: number; chargedAmount?: number | null; provider?: string | null; providerRef?: string | null }): number {
    const paidByCard = p.provider === 'STRIPE' || (typeof p.providerRef === 'string' && p.providerRef.startsWith('pi_'));
    return paidByCard && p.chargedAmount != null && p.chargedAmount > 0 ? p.chargedAmount : p.amount;
}

/** Plano "Concluído" (D6) ainda conta como relação vigente até N dias depois do fim da vigência. */
export const COMPLETED_PLAN_GRACE_DAYS = 60;

/** "YYYY-MM-DD" do calendário de São Paulo para um instante. */
function spYmd(d: Date): string {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(d);
}

/**
 * O contrato mantém o cliente como "ativo" (KPIs/filtros de Clientes e saúde do cliente)?
 * - ACTIVE: sim.
 * - COMPLETED ("Concluído", D6) de PLANO (não avulso): sim até COMPLETED_PLAN_GRACE_DAYS dias depois
 *   do fim da vigência (endDate) — a conclusão automática acontece quando as gravações acabam (ou os
 *   créditos FLEX são confiscados), mas o cliente segue pagando parcelas e pode renovar. GET /users
 *   e GET /users/:id trazem endDate/durationMonths de cada contrato; sem endDate (payload antigo) o
 *   plano concluído conta como recente (fallback defensivo).
 * - AVULSO concluído (gravado/perdido) NÃO: vira ex-cliente, como antes.
 */
export function isPlanInForce(
    c: { status: string; type: string; durationMonths?: number | null; endDate?: string | null },
    now: Date = new Date(),
): boolean {
    if (c.status === 'ACTIVE') return true;
    if (c.status !== 'COMPLETED' || isAvulsoContract(c)) return false;
    if (!c.endDate) return true;
    const end = new Date(c.endDate);
    if (Number.isNaN(end.getTime())) return true;
    // endDate é @db.Date (00:00Z = dia SP): soma a carência em dias de calendário e compara com hoje (SP).
    const graceEnd = new Date(end.getTime() + COMPLETED_PLAN_GRACE_DAYS * 86_400_000).toISOString().slice(0, 10);
    return graceEnd >= spYmd(now);
}

export interface ClientHealthResult {
    paid: number;
    pending: number;
    overdue: number;
    completed: number;
    total: number;
    faltas: number;
    attendanceRate: number;
    paymentScore: number;
    contractScore: number;
    recencyScore: number;
    healthScore: number;
    healthColor: string;
    healthLabel: string;
    paymentsCount: number;
}

/**
 * Health score do cliente (0-100) + resumo financeiro — extraído verbatim do
 * IIFE da ClientProfilePage (pesos 0.3/0.35/0.2/0.15 e thresholds preservados).
 * Pressupõe user.bookings ordenado do mais recente p/ o mais antigo (como a
 * API retorna) para o cálculo de recência.
 */
export function computeClientHealth(user: UserDetail, now: Date = new Date()): ClientHealthResult {
    const payments = user.payments || [];
    const paid = payments.filter(p => p.status === 'PAID').reduce((s, p) => s + paidChargedAmount(p), 0);
    const pending = payments.filter(p => p.status === 'PENDING').reduce((s, p) => s + p.amount, 0);
    const overdue = payments.filter(p => p.status === 'PENDING' && p.dueDate && new Date(p.dueDate) < now).reduce((s, p) => s + p.amount, 0);

    const bookings = user.bookings || [];
    const completed = bookings.filter(b => b.status === 'COMPLETED').length;
    const total = bookings.length;
    const faltas = bookings.filter(b => b.status === 'FALTA' || b.status === 'NAO_REALIZADO').length;
    const attendanceRate = total > 0 ? ((completed / total) * 100) : 100;
    const paymentScore = payments.length > 0 ? (payments.filter(p => p.status === 'PAID').length / payments.length) * 100 : 100;
    const hasActiveContract = user.contracts.some(c => isPlanInForce(c, now));
    const contractScore = hasActiveContract ? 100 : user.contracts.length > 0 ? 40 : 20;
    const lastBooking = bookings[0];
    const daysSinceLast = lastBooking ? Math.floor((now.getTime() - new Date(lastBooking.date).getTime()) / 86400000) : 999;
    const recencyScore = daysSinceLast <= 7 ? 100 : daysSinceLast <= 30 ? 70 : daysSinceLast <= 90 ? 40 : 10;
    const healthScore = Math.round((attendanceRate * 0.3) + (paymentScore * 0.35) + (contractScore * 0.2) + (recencyScore * 0.15));
    const healthColor = healthScore >= 80 ? '#10b981' : healthScore >= 50 ? '#f59e0b' : '#ef4444';
    const healthLabel = healthScore >= 80 ? 'Excelente' : healthScore >= 60 ? 'Bom' : healthScore >= 40 ? 'Atenção' : 'Crítico';

    return {
        paid, pending, overdue, completed, total, faltas,
        attendanceRate, paymentScore, contractScore, recencyScore,
        healthScore, healthColor, healthLabel,
        paymentsCount: payments.length,
    };
}

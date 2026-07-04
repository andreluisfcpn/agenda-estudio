import { UserDetail } from '../api/client';

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
    const paid = payments.filter(p => p.status === 'PAID').reduce((s, p) => s + p.amount, 0);
    const pending = payments.filter(p => p.status === 'PENDING').reduce((s, p) => s + p.amount, 0);
    const overdue = payments.filter(p => p.status === 'PENDING' && p.dueDate && new Date(p.dueDate) < now).reduce((s, p) => s + p.amount, 0);

    const bookings = user.bookings || [];
    const completed = bookings.filter(b => b.status === 'COMPLETED').length;
    const total = bookings.length;
    const faltas = bookings.filter(b => b.status === 'FALTA' || b.status === 'NAO_REALIZADO').length;
    const attendanceRate = total > 0 ? ((completed / total) * 100) : 100;
    const paymentScore = payments.length > 0 ? (payments.filter(p => p.status === 'PAID').length / payments.length) * 100 : 100;
    const hasActiveContract = user.contracts.some(c => c.status === 'ACTIVE');
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

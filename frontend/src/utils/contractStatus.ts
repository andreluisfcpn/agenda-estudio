import { ContractWithStats } from '../api/client';

/**
 * O contrato conta como "ativo" para o CLIENTE? (mesma regra da aba "Ativos"
 * de MyContractsPage — extraída para o KPI do dashboard não divergir: status
 * ACTIVE no banco com todas as sessões consumidas é "finalizado" para o
 * usuário, não "ativo").
 */
export function isContractCurrent(c: ContractWithStats): boolean {
    if (c.status === 'CANCELLED' || c.status === 'EXPIRED') return false;

    // Optimistically filter out expired pending contracts before the cleanup cron job runs
    if (c.status === 'AWAITING_PAYMENT' && c.paymentDeadline && new Date(c.paymentDeadline).getTime() <= Date.now()) return false;

    if (c.status !== 'ACTIVE' && c.status !== 'PENDING_CANCELLATION' && c.status !== 'PAUSED' && c.status !== 'AWAITING_PAYMENT') return false;
    if (c.status === 'AWAITING_PAYMENT') return true;

    const bookings = c.bookings || [];
    const totalBookings = c.type === 'FIXO' ? c.durationMonths * 4 : c.totalBookings;
    const usedBookingsCount = c.type === 'FIXO'
        ? bookings.filter(b => b.status !== 'NAO_REALIZADO' && b.status !== 'CANCELLED').length
        : (c.flexCreditsTotal || 0) - (c.flexCreditsRemaining || 0);

    const now = new Date();
    const hasPending = bookings.some(b => {
        if (b.status === 'CANCELLED' || b.status === 'NAO_REALIZADO') return false;
        const bookingDateTime = new Date(`${b.date.split('T')[0]}T${b.startTime}:00`);
        return bookingDateTime >= now && (b.status === 'RESERVED' || b.status === 'CONFIRMED');
    });

    if (hasPending) return true;
    if (c.status === 'PENDING_CANCELLATION') return true;

    return totalBookings === 0 || (totalBookings != null && usedBookingsCount < totalBookings);
}

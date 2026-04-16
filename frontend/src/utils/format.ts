/**
 * Shared formatting utilities used across client pages.
 * Centralizes formatBRL, formatDate, daysUntil — previously duplicated
 * in DashboardPage, MyPaymentsPage, and MyContractsPage.
 */

export function formatBRL(cents: number): string {
    return new Intl.NumberFormat('pt-BR', {
        style: 'currency',
        currency: 'BRL',
    }).format(cents / 100);
}

export function formatDate(dateStr: string | null | undefined): string {
    if (!dateStr) return '—';
    const d = new Date(dateStr);
    if (isNaN(d.getTime()) || d.getFullYear() < 2000) return '—';
    return new Intl.DateTimeFormat('pt-BR', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
    }).format(d);
}

export function formatDateShort(dateStr: string): string {
    return new Date(dateStr).toLocaleDateString('pt-BR', {
        timeZone: 'UTC',
        weekday: 'short',
        day: '2-digit',
        month: '2-digit',
    });
}

export function formatDateFull(dateStr: string): string {
    return new Date(dateStr).toLocaleDateString('pt-BR', { timeZone: 'UTC' });
}

export function daysUntil(dateStr: string): number {
    const target = new Date(dateStr.split('T')[0] + 'T12:00:00');
    const now = new Date();
    return Math.ceil((target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}

export const DAY_NAMES = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

export const TIER_EMOJI: Record<string, string> = {
    COMERCIAL: '🏢',
    AUDIENCIA: '🎤',
    SABADO: '🌟',
};

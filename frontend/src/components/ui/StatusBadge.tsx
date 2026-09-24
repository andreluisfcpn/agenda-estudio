import { CheckCircle, Clock, XCircle, AlertTriangle, AlertCircle, Pause, Ban, CalendarCheck, Loader2, Hourglass, Lock, type LucideIcon } from 'lucide-react';
import { findStatusMeta } from '../../constants/adminMeta';

type StatusType =
    | 'CONFIRMED' | 'RESERVED' | 'HELD' | 'CANCELLED' | 'COMPLETED'
    | 'FALTA' | 'NAO_REALIZADO'
    | 'PAID' | 'PENDING' | 'FAILED' | 'REFUNDED'
    | 'ACTIVE' | 'PAUSED' | 'FINISHED'
    | 'AWAITING_PAYMENT' | 'EXPIRED' | 'PENDING_CANCELLATION'
    | 'CHECKED_IN' | 'NO_SHOW';

const CONFIG: Record<StatusType, { icon: React.ReactNode; label: string; color: string; bg: string }> = {
    CONFIRMED:  { icon: <CheckCircle size={13} />,    label: 'Confirmado',  color: '#3b82f6', bg: 'rgba(59,130,246,0.1)' },
    RESERVED:   { icon: <Clock size={13} />,          label: 'Reservado',   color: '#f59e0b', bg: 'rgba(245,158,11,0.1)' },
    HELD:       { icon: <Hourglass size={13} />,      label: 'Em espera',   color: '#f59e0b', bg: 'rgba(245,158,11,0.1)' },
    CANCELLED:  { icon: <XCircle size={13} />,        label: 'Cancelado',   color: '#6b7280', bg: 'rgba(107,114,128,0.1)' },
    COMPLETED:  { icon: <CheckCircle size={13} />,    label: 'Concluído',   color: '#10b981', bg: 'rgba(16,185,129,0.1)' },
    FALTA:      { icon: <XCircle size={13} />,        label: 'Falta',       color: '#ef4444', bg: 'rgba(239,68,68,0.1)' },
    NAO_REALIZADO: { icon: <AlertCircle size={13} />, label: 'Não realizado', color: '#14b8a6', bg: 'rgba(20,184,166,0.1)' },
    CHECKED_IN: { icon: <CalendarCheck size={13} />,  label: 'Check-in',    color: '#06b6d4', bg: 'rgba(6,182,212,0.1)' },
    NO_SHOW:    { icon: <Ban size={13} />,            label: 'Falta',       color: '#ef4444', bg: 'rgba(239,68,68,0.1)' },
    PAID:       { icon: <CheckCircle size={13} />,    label: 'Pago',        color: '#10b981', bg: 'rgba(16,185,129,0.1)' },
    PENDING:    { icon: <Clock size={13} />,          label: 'Pendente',    color: '#f59e0b', bg: 'rgba(245,158,11,0.1)' },
    FAILED:     { icon: <XCircle size={13} />,        label: 'Falhou',      color: '#ef4444', bg: 'rgba(239,68,68,0.1)' },
    REFUNDED:   { icon: <AlertTriangle size={13} />,  label: 'Estornado',   color: '#0d9488', bg: 'rgba(13,148,136,0.1)' },
    ACTIVE:     { icon: <CheckCircle size={13} />,    label: 'Ativo',       color: '#10b981', bg: 'rgba(16,185,129,0.1)' },
    PAUSED:     { icon: <Pause size={13} />,          label: 'Pausado',     color: '#d97706', bg: 'rgba(217,119,6,0.1)' },
    FINISHED:   { icon: <Loader2 size={13} />,        label: 'Finalizado',  color: '#6b7280', bg: 'rgba(107,114,128,0.1)' },
    AWAITING_PAYMENT:     { icon: <Hourglass size={13} />, label: 'Aguard. pagamento', color: '#f59e0b', bg: 'rgba(245,158,11,0.1)' },
    EXPIRED:              { icon: <Lock size={13} />,      label: 'Expirado',          color: '#6b7280', bg: 'rgba(107,114,128,0.1)' },
    PENDING_CANCELLATION: { icon: <Clock size={13} />,     label: 'Cancelamento solicitado', color: '#f59e0b', bg: 'rgba(245,158,11,0.1)' },
};

interface StatusBadgeProps {
    status?: string;
    label?: string;
    size?: 'sm' | 'md';
    /** Admin override: render from a metadata entry (see constants/adminMeta.ts)
     *  for statuses outside the built-in client union. */
    meta?: { label: string; color: string; bg: string; icon: LucideIcon };
}

export default function StatusBadge({ status = '', label, size = 'sm', meta }: StatusBadgeProps) {
    if (meta) {
        const Icon = meta.icon;
        return (
            <span
                className={`status-badge status-badge--${size}`}
                style={{ color: meta.color, background: meta.bg }}
            >
                <Icon size={13} />
                {label || meta.label}
            </span>
        );
    }

    // Fallback: status fora do CONFIG → consulta os mapas de adminMeta (reserva/contrato/
    // pagamento) antes de desistir; se ninguém conhece a chave, mostra '—' (nunca a chave
    // crua em inglês) e deixa a chave só no title, para depuração.
    let config = CONFIG[status as StatusType];
    let unknownKey = false;
    if (!config) {
        const m = findStatusMeta(status);
        if (m) {
            const Icon = m.icon;
            config = { icon: <Icon size={13} />, label: m.label, color: m.color, bg: m.bg };
        } else {
            unknownKey = !!status;
            config = { icon: <Clock size={13} />, label: '—', color: 'var(--text-muted)', bg: 'rgba(148,163,184,0.1)' };
        }
    }

    const displayLabel = label || config.label;

    return (
        <span
            className={`status-badge status-badge--${size}`}
            style={{ color: config.color, background: config.bg }}
            title={unknownKey && !label ? status : undefined}
        >
            {config.icon}
            {displayLabel}
        </span>
    );
}

// ─── Admin metadata — single source of truth ────────────
// Consolidates the status/tier/type maps that were duplicated (and divergent)
// inline across AdminBookingsPage, AdminContractsPage, AdminFinancePage,
// AdminReportsPage, AdminTodayPage and AdminClientsPage. Colors reconciled to a
// single canonical value per concept; emoji replaced by lucide icons.
import {
    Building2, Mic, Star,
    Clock, CheckCircle, CheckCircle2, Ban, XCircle, AlertCircle,
    Lock, Pause, Undo2, ShieldCheck, Pin, RefreshCw, Ticket, Circle, Hourglass,
    type LucideIcon,
} from 'lucide-react';

export interface MetaEntry {
    label: string;
    color: string;
    bg: string;
    icon: LucideIcon;
}

/** Contract tiers (used by bookings, today, reports, contracts). */
export const TIER_META: Record<string, MetaEntry> = {
    COMERCIAL: { label: 'Comercial', color: '#10b981', bg: 'rgba(16,185,129,0.12)', icon: Building2 },
    AUDIENCIA: { label: 'Audiência', color: '#2dd4bf', bg: 'rgba(45,212,191,0.12)', icon: Mic },
    SABADO:    { label: 'Sábado',    color: '#fbbf24', bg: 'rgba(245,158,11,0.12)', icon: Star },
};

/** Booking statuses (cancelled reconciled to neutral gray, matching StatusBadge). */
export const BOOKING_STATUS_META: Record<string, MetaEntry> = {
    HELD:          { label: 'Em espera',     color: '#f59e0b', bg: 'rgba(245,158,11,0.12)', icon: Hourglass },
    RESERVED:      { label: 'Reservado',     color: '#f59e0b', bg: 'rgba(245,158,11,0.12)', icon: Clock },
    CONFIRMED:     { label: 'Confirmado',    color: '#3b82f6', bg: 'rgba(59,130,246,0.12)', icon: CheckCircle },
    COMPLETED:     { label: 'Concluído',     color: '#10b981', bg: 'rgba(16,185,129,0.12)', icon: CheckCircle2 },
    CANCELLED:     { label: 'Cancelado',     color: '#6b7280', bg: 'rgba(107,114,128,0.12)', icon: Ban },
    FALTA:         { label: 'Falta',         color: '#ef4444', bg: 'rgba(239,68,68,0.12)',  icon: XCircle },
    NAO_REALIZADO: { label: 'Não Realizado', color: '#14b8a6', bg: 'rgba(20,184,166,0.12)', icon: AlertCircle },
};

/** Contract lifecycle statuses. */
export const CONTRACT_STATUS_META: Record<string, MetaEntry> = {
    ACTIVE:               { label: 'Ativo',        color: '#10b981', bg: 'rgba(16,185,129,0.12)',  icon: CheckCircle2 },
    EXPIRED:              { label: 'Expirado',     color: '#6b7280', bg: 'rgba(107,114,128,0.12)', icon: Lock },
    CANCELLED:            { label: 'Cancelado',    color: '#ef4444', bg: 'rgba(239,68,68,0.12)',   icon: Ban },
    PENDING_CANCELLATION: { label: 'Pend. Cancel', color: '#f59e0b', bg: 'rgba(245,158,11,0.12)',  icon: Clock },
    PAUSED:               { label: 'Pausado',      color: '#14b8a6', bg: 'rgba(20,184,166,0.12)',  icon: Pause },
};

/** Payment statuses. */
export const PAYMENT_STATUS_META: Record<string, MetaEntry> = {
    PAID:     { label: 'Pago',      color: '#10b981', bg: 'rgba(16,185,129,0.12)', icon: CheckCircle2 },
    PENDING:  { label: 'Pendente',  color: '#f59e0b', bg: 'rgba(245,158,11,0.12)', icon: Clock },
    FAILED:   { label: 'Falhou',    color: '#ef4444', bg: 'rgba(239,68,68,0.12)',  icon: XCircle },
    REFUNDED: { label: 'Estornado', color: '#14b8a6', bg: 'rgba(20,184,166,0.12)', icon: Undo2 },
};

/** Client "type" derived from role/contract (used by AdminClientsPage). */
export const USER_TYPE_META: Record<string, MetaEntry> = {
    ADMIN:  { label: 'Admin',  color: '#f59e0b', bg: 'rgba(245,158,11,0.12)',  icon: ShieldCheck },
    FIXO:   { label: 'Fixo',   color: '#818cf8', bg: 'rgba(129,140,248,0.12)', icon: Pin },
    FLEX:   { label: 'Flex',   color: '#34d399', bg: 'rgba(52,211,153,0.12)',  icon: RefreshCw },
    AVULSO: { label: 'Avulso', color: '#f97316', bg: 'rgba(249,115,22,0.12)',  icon: Ticket },
};

const FALLBACK: MetaEntry = { label: '—', color: 'var(--text-muted)', bg: 'rgba(148,163,184,0.12)', icon: Circle };

/** Safe lookup: returns the entry or a neutral fallback (label defaults to the key). */
export function getMeta(map: Record<string, MetaEntry>, key: string | null | undefined): MetaEntry {
    if (key && map[key]) return map[key];
    return { ...FALLBACK, label: key || FALLBACK.label };
}

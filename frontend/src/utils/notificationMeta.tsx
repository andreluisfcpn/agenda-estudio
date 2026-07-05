import {
    Bell, Wallet, CreditCard, CheckCircle, FileText, FileSignature, FileClock,
    Hourglass, Clock, CalendarCheck, CalendarClock, CalendarX, AlertTriangle, Megaphone,
    type LucideIcon,
} from 'lucide-react';

export type NotifTone = 'danger' | 'warning' | 'success' | 'info';

// Icon + base tone per notification type. Structural icon = lucide (no emoji);
// colors come exclusively from tokens (--danger/--warning/--success/--info).
const TYPE_META: Record<string, { icon: LucideIcon; tone: NotifTone }> = {
    PAYMENT_OVERDUE: { icon: Wallet, tone: 'danger' },
    PAYMENT_FAILED: { icon: CreditCard, tone: 'danger' },
    PAYMENT_CONFIRMED: { icon: CheckCircle, tone: 'success' },
    CONTRACT_EXPIRING: { icon: FileText, tone: 'warning' },
    CONTRACT_ACTIVATED: { icon: FileSignature, tone: 'success' },
    CONTRACT_AWAITING_PAYMENT: { icon: FileClock, tone: 'warning' },
    CANCELLATION_PENDING: { icon: Hourglass, tone: 'warning' },
    BOOKING_REMINDER: { icon: Clock, tone: 'info' },
    BOOKING_CONFIRMED: { icon: CalendarCheck, tone: 'success' },
    BOOKING_UNCONFIRMED: { icon: CalendarClock, tone: 'warning' },
    BOOKING_CANCELLED: { icon: CalendarX, tone: 'danger' },
    FLEX_CREDITS_LOW: { icon: AlertTriangle, tone: 'warning' },
    SYSTEM: { icon: Megaphone, tone: 'info' },
};

export interface NotifMeta { Icon: LucideIcon; tone: NotifTone; }

/**
 * Icon + tone for a notification. Severity wins the color: critical → danger,
 * warning → warning; for 'info' we keep the type's natural tone (so a confirmed
 * payment stays green instead of neutral blue).
 */
export function resolveNotifMeta(type: string, severity: 'critical' | 'warning' | 'info'): NotifMeta {
    const base = TYPE_META[type] ?? { icon: Bell, tone: 'info' as NotifTone };
    const tone: NotifTone = severity === 'critical' ? 'danger' : severity === 'warning' ? 'warning' : base.tone;
    return { Icon: base.icon, tone };
}

/** "agora", "há 5min", "há 2h", "há 3d". */
export function formatTimeAgo(isoDate: string): string {
    const diff = Date.now() - new Date(isoDate).getTime();
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return 'agora';
    if (minutes < 60) return `há ${minutes}min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `há ${hours}h`;
    const days = Math.floor(hours / 24);
    return `há ${days}d`;
}

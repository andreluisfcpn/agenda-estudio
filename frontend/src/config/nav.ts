import {
    LayoutDashboard,
    CalendarDays,
    Clapperboard,
    FileText,
    Wallet,
    MapPin,
    ClipboardList,
    Users,
    FileSignature,
    CreditCard,
    TicketPercent,
    BarChart3,
    BellRing,
    Settings,
    type LucideIcon,
} from 'lucide-react';

/**
 * Single source of truth for the app navigation.
 *
 * Both consumers read from the same lists so a new page never has to be added
 * in two places (which is exactly how Cupons/Notificações drifted before):
 *   - Sidebar (desktop) renders `label`/`icon`, groups by `section`, and expands
 *     items that carry `subItems`.
 *   - BottomTabBar (PWA/mobile) renders a flat row using `shortLabel ?? label`
 *     and `mobileIcon ?? icon`.
 *
 * To add a destination to both navs, add ONE entry here.
 */
export interface NavItem {
    to: string;
    /** Desktop / sidebar label. */
    label: string;
    /** Shorter label for the mobile bottom bar (falls back to `label`). */
    shortLabel?: string;
    /** Sidebar / default icon. */
    icon: LucideIcon;
    /** Bottom-bar icon override (falls back to `icon`). */
    mobileIcon?: LucideIcon;
    /** Sidebar group header this item belongs to (admin only). */
    section?: string;
    /** If present, the sidebar renders this item as an expandable parent. */
    subItems?: { sec: string; label: string }[];
}

/** Sub-sections of the Settings page, mirrored from AdminSettingsPage's SECTIONS. */
export const SETTINGS_SUBITEMS: { sec: string; label: string }[] = [
    { sec: 'gerais', label: 'Gerais' },
    { sec: 'horarios', label: 'Horários' },
    { sec: 'financeiro', label: 'Financeiro' },
    { sec: 'politicas', label: 'Políticas' },
    { sec: 'servicos', label: 'Serviços' },
    { sec: 'pagamentos', label: 'Pagamentos' },
    { sec: 'email', label: 'E-mail' },
    { sec: 'integracoes', label: 'Integrações' },
];

export const CLIENT_NAV: NavItem[] = [
    { to: '/dashboard', label: 'Dashboard', shortLabel: 'Início', icon: LayoutDashboard },
    { to: '/calendar', label: 'Agenda', icon: CalendarDays },
    { to: '/minhas-gravacoes', label: 'Minhas Gravações', shortLabel: 'Gravações', icon: Clapperboard },
    { to: '/meus-contratos', label: 'Meus Contratos', shortLabel: 'Contratos', icon: FileText },
    { to: '/meus-pagamentos', label: 'Pagamentos', shortLabel: 'Pagar', icon: Wallet },
];

export const ADMIN_NAV: NavItem[] = [
    { to: '/dashboard', label: 'Dashboard', shortLabel: 'Início', icon: LayoutDashboard },
    { to: '/calendar', label: 'Agenda', icon: CalendarDays },

    { to: '/admin/today', label: 'Hoje', icon: MapPin, section: 'Operação' },
    { to: '/admin/bookings', label: 'Agendamentos', icon: ClipboardList, mobileIcon: Clapperboard, section: 'Operação' },
    { to: '/admin/clients', label: 'Clientes', icon: Users, section: 'Operação' },

    { to: '/admin/contracts', label: 'Contratos', icon: FileSignature, mobileIcon: FileText, section: 'Gestão' },
    { to: '/admin/finance', label: 'Financeiro', icon: CreditCard, section: 'Gestão' },
    { to: '/admin/cupons', label: 'Cupons', icon: TicketPercent, section: 'Gestão' },
    { to: '/admin/reports', label: 'Relatórios', icon: BarChart3, section: 'Gestão' },

    { to: '/admin/notificacoes', label: 'Notificações', icon: BellRing, section: 'Sistema' },
    { to: '/admin/configuracoes', label: 'Configurações', shortLabel: 'Config', icon: Settings, section: 'Sistema', subItems: SETTINGS_SUBITEMS },
];

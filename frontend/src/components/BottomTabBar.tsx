import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useNavigation } from '../context/NavigationContext';
import {
    LayoutDashboard,
    CalendarDays,
    Clapperboard,
    FileText,
    Wallet,
    MapPin,
    Users,
    CreditCard,
    BarChart3,
    Settings,
    ChevronLeft,
    ChevronRight,
    type LucideIcon,
} from 'lucide-react';
import { useDragScroll } from '../hooks/useDragScroll';

interface TabItem {
    to: string;
    icon: LucideIcon;
    label: string;
}

const CLIENT_TABS: TabItem[] = [
    { to: '/dashboard', icon: LayoutDashboard, label: 'Início' },
    { to: '/calendar', icon: CalendarDays, label: 'Agenda' },
    { to: '/minhas-gravacoes', icon: Clapperboard, label: 'Gravações' },
    { to: '/meus-contratos', icon: FileText, label: 'Contratos' },
    { to: '/meus-pagamentos', icon: Wallet, label: 'Pagar' },
];

// All admin tabs live in a single horizontally-scrollable row (no "More" sheet).
const ADMIN_TABS: TabItem[] = [
    { to: '/dashboard', icon: LayoutDashboard, label: 'Início' },
    { to: '/admin/today', icon: MapPin, label: 'Hoje' },
    { to: '/calendar', icon: CalendarDays, label: 'Agenda' },
    { to: '/admin/bookings', icon: Clapperboard, label: 'Agendamentos' },
    { to: '/admin/clients', icon: Users, label: 'Clientes' },
    { to: '/admin/contracts', icon: FileText, label: 'Contratos' },
    { to: '/admin/finance', icon: CreditCard, label: 'Financeiro' },
    { to: '/admin/reports', icon: BarChart3, label: 'Relatórios' },
    { to: '/admin/configuracoes', icon: Settings, label: 'Config' },
];

export default function BottomTabBar() {
    const { user } = useAuth();
    const { navigateTo, isTransitioning, pendingPath } = useNavigation();
    const location = useLocation();
    const isAdmin = user?.role === 'ADMIN';
    const tabs = isAdmin ? ADMIN_TABS : CLIENT_TABS;

    const { ref: barRef, showLeft, showRight, scrollByPage, updateArrows } = useDragScroll<HTMLElement>();
    const activeRef = useRef<HTMLButtonElement>(null);

    // Keep the active tab in view as the route changes.
    useEffect(() => {
        activeRef.current?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
        // Recompute arrow visibility after the route-driven scroll settles.
        const t = setTimeout(updateArrows, 400);
        return () => clearTimeout(t);
    }, [location.pathname, updateArrows]);

    return (
        <div className="bottom-tab-bar-wrap scrollrow-wrap">
            {showLeft && (
                <button
                    type="button"
                    className="scrollrow-arrow bottom-tab-arrow scrollrow-arrow--left"
                    aria-label="Rolar para esquerda"
                    onClick={() => scrollByPage(-1)}
                    tabIndex={-1}
                >
                    <ChevronLeft size={16} />
                </button>
            )}
            <nav
                ref={barRef}
                className="bottom-tab-bar scrollrow-track"
                role="tablist"
                aria-label="Navegação principal"
            >
                {tabs.map(tab => {
                    // Active state stays bound to the committed location so the highlight and the
                    // on-screen page switch together (no blink). A separate "pending" class gives
                    // immediate tap feedback on the target while the transition resolves.
                    const isActive = location.pathname === tab.to;
                    const isPending = isTransitioning && pendingPath === tab.to;
                    return (
                        <button
                            key={tab.to}
                            ref={isActive ? activeRef : undefined}
                            className={`btb-tab ${isActive ? 'btb-tab--active' : ''} ${isPending ? 'btb-tab--pending' : ''}`}
                            role="tab"
                            aria-label={tab.label}
                            aria-selected={isActive}
                            onClick={() => navigateTo(tab.to)}
                        >
                            <tab.icon size={22} strokeWidth={1.8} className="btb-tab-icon" />
                            <span className="btb-tab-label">{tab.label}</span>
                        </button>
                    );
                })}
            </nav>
            {showRight && (
                <button
                    type="button"
                    className="scrollrow-arrow bottom-tab-arrow scrollrow-arrow--right scrollrow-arrow--pulse"
                    aria-label="Rolar para direita"
                    onClick={() => scrollByPage(1)}
                    tabIndex={-1}
                >
                    <ChevronRight size={16} />
                </button>
            )}
        </div>
    );
}

import { NavLink } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
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
    MoreHorizontal,
    type LucideIcon,
} from 'lucide-react';
import { useState } from 'react';

interface TabItem {
    to: string;
    icon: LucideIcon;
    label: string;
}

const CLIENT_TABS: TabItem[] = [
    { to: '/dashboard', icon: LayoutDashboard, label: 'Início' },
    { to: '/calendar', icon: CalendarDays, label: 'Agenda' },
    { to: '/my-bookings', icon: Clapperboard, label: 'Gravações' },
    { to: '/my-contracts', icon: FileText, label: 'Contratos' },
    { to: '/meus-pagamentos', icon: Wallet, label: 'Pagar' },
];

const ADMIN_PRIMARY_TABS: TabItem[] = [
    { to: '/dashboard', icon: LayoutDashboard, label: 'Início' },
    { to: '/admin/today', icon: MapPin, label: 'Hoje' },
    { to: '/calendar', icon: CalendarDays, label: 'Agenda' },
    { to: '/admin/clients', icon: Users, label: 'Clientes' },
];

const ADMIN_MORE_TABS: TabItem[] = [
    { to: '/admin/bookings', icon: Clapperboard, label: 'Agendamentos' },
    { to: '/admin/contracts', icon: FileText, label: 'Contratos' },
    { to: '/admin/finance', icon: CreditCard, label: 'Financeiro' },
    { to: '/admin/reports', icon: BarChart3, label: 'Relatórios' },
];

export default function BottomTabBar() {
    const { user } = useAuth();
    const isAdmin = user?.role === 'ADMIN';
    const [showMore, setShowMore] = useState(false);

    const primaryTabs = isAdmin ? ADMIN_PRIMARY_TABS : CLIENT_TABS;

    return (
        <>
            {/* "More" sheet overlay */}
            {isAdmin && showMore && (
                <div className="btb-sheet-backdrop" onClick={() => setShowMore(false)}>
                    <div className="btb-sheet" onClick={e => e.stopPropagation()}>
                        <div className="btb-sheet-handle" />
                        {ADMIN_MORE_TABS.map(tab => (
                            <NavLink
                                key={tab.to}
                                to={tab.to}
                                className={({ isActive }) => `btb-sheet-item ${isActive ? 'active' : ''}`}
                                onClick={() => setShowMore(false)}
                            >
                                <tab.icon size={20} strokeWidth={1.8} />
                                <span>{tab.label}</span>
                            </NavLink>
                        ))}
                    </div>
                </div>
            )}

            {/* Tab bar */}
            <nav className="bottom-tab-bar" role="tablist" aria-label="Navegação principal">
                {primaryTabs.map(tab => (
                    <NavLink
                        key={tab.to}
                        to={tab.to}
                        className={({ isActive }) => `btb-tab ${isActive ? 'btb-tab--active' : ''}`}
                        role="tab"
                        aria-label={tab.label}
                    >
                        <tab.icon size={22} strokeWidth={1.8} className="btb-tab-icon" />
                        <span className="btb-tab-label">{tab.label}</span>
                    </NavLink>
                ))}

                {isAdmin && (
                    <button
                        className={`btb-tab ${showMore ? 'btb-tab--active' : ''}`}
                        onClick={() => setShowMore(prev => !prev)}
                        role="tab"
                        aria-label="Mais opções"
                    >
                        <MoreHorizontal size={22} strokeWidth={1.8} className="btb-tab-icon" />
                        <span className="btb-tab-label">Mais</span>
                    </button>
                )}
            </nav>
        </>
    );
}

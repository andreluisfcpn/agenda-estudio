import React, { useState, useRef, useEffect } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useNavigation } from '../context/NavigationContext';
import {
    LayoutDashboard,
    CalendarDays,
    Clapperboard,
    FileText,
    MapPin,
    ClipboardList,
    Users,
    FileSignature,
    CreditCard,
    BarChart3,
    LucideIcon,
    ChevronRight,
    User,
    LogOut,
    Wallet,
    Settings,
} from 'lucide-react';

interface NavItemProps {
    to: string;
    icon: LucideIcon;
    label: string;
    collapsed: boolean;
}

function NavItem({ to, icon: Icon, label, collapsed }: NavItemProps) {
    const [showTooltip, setShowTooltip] = useState(false);
    const { navigateTo } = useNavigation();
    const location = useLocation();
    const isActive = location.pathname === to;

    return (
        <div style={{ position: 'relative' }}>
            <button
                className={`sidebar-link ${isActive ? 'active' : ''}`}
                onClick={() => navigateTo(to)}
                onMouseEnter={() => collapsed && setShowTooltip(true)}
                onMouseLeave={() => setShowTooltip(false)}
            >
                <span className="sidebar-link-icon">
                    <Icon size={20} strokeWidth={1.8} />
                </span>
                <span className="sidebar-link-label">{label}</span>
            </button>

            {collapsed && showTooltip && (
                <div className="sidebar-tooltip">
                    {label}
                    <div className="sidebar-tooltip-arrow" />
                </div>
            )}
        </div>
    );
}

/** Sub-sections of the Settings page, mirrored from AdminSettingsPage's SECTIONS. */
const SETTINGS_SUBITEMS: { sec: string; label: string }[] = [
    { sec: 'gerais', label: 'Gerais' },
    { sec: 'horarios', label: 'Horários' },
    { sec: 'financeiro', label: 'Financeiro' },
    { sec: 'politicas', label: 'Políticas' },
    { sec: 'servicos', label: 'Serviços' },
    { sec: 'pagamentos', label: 'Pagamentos' },
    { sec: 'email', label: 'E-mail' },
    { sec: 'integracoes', label: 'Integrações' },
];

/** Group header (reuses the existing divider markup; the label hides when collapsed via CSS). */
function SidebarSection({ label }: { label: string }) {
    return (
        <div className="sidebar-section-divider">
            <div className="sidebar-section-line" />
            <span className="sidebar-section-label">{label}</span>
            <div className="sidebar-section-line" />
        </div>
    );
}

interface ExpandableNavItemProps {
    to: string;
    icon: LucideIcon;
    label: string;
    collapsed: boolean;
    subItems: { sec: string; label: string }[];
}

/**
 * A parent nav item (e.g. Configurações) that reveals its `?sec=` sub-sections
 * indented below it. Expansion is derived from the route (auto-opens when on the
 * page) and can be toggled manually. `?sec=` is the single source of truth for the
 * active sub-item — read here and in AdminSettingsPage, so they never desync.
 */
function ExpandableNavItem({ to, icon: Icon, label, collapsed, subItems }: ExpandableNavItemProps) {
    const { navigateTo } = useNavigation();
    const location = useLocation();
    const [searchParams] = useSearchParams();
    const onPage = location.pathname === to;
    const activeSec = searchParams.get('sec') ?? subItems[0]?.sec;
    const [manualOpen, setManualOpen] = useState<boolean | null>(null);
    const expanded = collapsed ? false : (manualOpen ?? onPage);

    const handleParentClick = () => {
        if (!onPage) navigateTo(to);
        setManualOpen(prev => (prev === null ? !onPage : !prev));
    };

    return (
        <div className="sidebar-group">
            <button
                className={`sidebar-link sidebar-link--parent ${onPage ? 'active' : ''}`}
                onClick={handleParentClick}
                aria-expanded={expanded}
            >
                <span className="sidebar-link-icon">
                    <Icon size={20} strokeWidth={1.8} />
                </span>
                <span className="sidebar-link-label">{label}</span>
                {!collapsed && (
                    <ChevronRight
                        size={14}
                        className={`sidebar-link-caret ${expanded ? 'sidebar-link-caret--open' : ''}`}
                    />
                )}
            </button>

            {expanded && (
                <div className="sidebar-subnav" role="group" aria-label={label}>
                    {subItems.map(si => {
                        const isActive = onPage && activeSec === si.sec;
                        return (
                            <button
                                key={si.sec}
                                className={`sidebar-sublink ${isActive ? 'active' : ''}`}
                                onClick={() => navigateTo(`${to}?sec=${si.sec}`)}
                            >
                                <span className="sidebar-sublink-dot" aria-hidden />
                                <span className="sidebar-sublink-label">{si.label}</span>
                            </button>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

interface SidebarProps {
    collapsed: boolean;
}

export default function Sidebar({ collapsed }: SidebarProps) {
    const { user, logout } = useAuth();
    const { navigateTo } = useNavigation();
    const isAdmin = user?.role === 'ADMIN';
    const [menuOpen, setMenuOpen] = useState(false);
    const menuRef = useRef<HTMLDivElement>(null);

    const initials = user?.name
        ?.split(' ')
        .map(w => w[0])
        .join('')
        .slice(0, 2)
        .toUpperCase() || '??';

    // Close on outside click
    useEffect(() => {
        if (!menuOpen) return;
        const handler = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
                setMenuOpen(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [menuOpen]);

    const handleViewProfile = () => {
        setMenuOpen(false);
        navigateTo('/perfil');
    };

    const handleLogout = async () => {
        setMenuOpen(false);
        await logout();
    };

    return (
        <aside className={`sidebar ${collapsed ? 'sidebar--collapsed' : ''}`}>
            {/* ─── User Profile Section (Top) ─── */}
            <div className="sidebar-user-section" ref={menuRef}>
                <button
                    className={`sidebar-user-block ${menuOpen ? 'sidebar-user-block--active' : ''}`}
                    onClick={() => setMenuOpen(prev => !prev)}
                    title="Menu do usuário"
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                >
                    <div
                        className="sidebar-user-avatar"
                        style={user?.photoUrl ? {
                            backgroundImage: `url(${user.photoUrl})`,
                            backgroundSize: 'cover',
                            backgroundPosition: 'center',
                            fontSize: 0,
                        } : {}}
                    >
                        {!user?.photoUrl && initials}
                    </div>
                    <div className="sidebar-user-info">
                        <span className="sidebar-user-name">{user?.name}</span>
                        <span className="sidebar-user-role">
                            {isAdmin ? 'Administrador' : 'Cliente'}
                        </span>
                    </div>
                    {!collapsed && (
                        <ChevronRight
                            size={14}
                            className={`sidebar-user-chevron ${menuOpen ? 'sidebar-user-chevron--rotated' : ''}`}
                            strokeWidth={2.5}
                        />
                    )}
                </button>

                {/* ─── Profile Dropdown Menu ─── */}
                {menuOpen && (
                    <div className="sidebar-profile-menu" role="menu">
                        <button
                            className="sidebar-profile-menu-item"
                            onClick={handleViewProfile}
                            role="menuitem"
                            aria-label="Meu Perfil"
                        >
                            <User size={15} strokeWidth={2} />
                            <span>Meu Perfil</span>
                        </button>
                        <div className="sidebar-profile-menu-divider" />
                        <button
                            className="sidebar-profile-menu-item sidebar-profile-menu-item--danger"
                            onClick={handleLogout}
                            role="menuitem"
                            aria-label="Sair"
                        >
                            <LogOut size={15} strokeWidth={2} />
                            <span>Sair</span>
                        </button>
                    </div>
                )}
            </div>

            <nav className="sidebar-nav">
                <NavItem to="/dashboard" icon={LayoutDashboard} label="Dashboard" collapsed={collapsed} />
                <NavItem to="/calendar" icon={CalendarDays} label="Agenda" collapsed={collapsed} />

                {!isAdmin && (
                    <>
                        <NavItem to="/my-bookings" icon={Clapperboard} label="Minhas Gravações" collapsed={collapsed} />
                        <NavItem to="/my-contracts" icon={FileText} label="Meus Contratos" collapsed={collapsed} />
                        <NavItem to="/meus-pagamentos" icon={Wallet} label="Pagamentos" collapsed={collapsed} />
                    </>
                )}

                {isAdmin && (
                    <>
                        <SidebarSection label="Operação" />
                        <NavItem to="/admin/today" icon={MapPin} label="Hoje" collapsed={collapsed} />
                        <NavItem to="/admin/bookings" icon={ClipboardList} label="Agendamentos" collapsed={collapsed} />
                        <NavItem to="/admin/clients" icon={Users} label="Clientes" collapsed={collapsed} />

                        <SidebarSection label="Gestão" />
                        <NavItem to="/admin/contracts" icon={FileSignature} label="Contratos" collapsed={collapsed} />
                        <NavItem to="/admin/finance" icon={CreditCard} label="Financeiro" collapsed={collapsed} />
                        <NavItem to="/admin/reports" icon={BarChart3} label="Relatórios" collapsed={collapsed} />

                        <SidebarSection label="Sistema" />
                        <ExpandableNavItem
                            to="/admin/configuracoes"
                            icon={Settings}
                            label="Configurações"
                            collapsed={collapsed}
                            subItems={SETTINGS_SUBITEMS}
                        />
                    </>
                )}
            </nav>
        </aside>
    );
}

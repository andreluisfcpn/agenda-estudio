import React, { useState, useRef, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
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
    BadgeDollarSign,
    CreditCard,
    BarChart3,
    LucideIcon,
    ChevronRight,
    User,
    Pencil,
    LogOut,
    Wallet,
    Sparkles,
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

interface SidebarProps {
    collapsed: boolean;
    onProfileClick: () => void;
}

export default function Sidebar({ collapsed, onProfileClick }: SidebarProps) {
    const { user, logout } = useAuth();
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
        onProfileClick();
    };

    const handleEditProfile = () => {
        setMenuOpen(false);
        onProfileClick();
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
                            aria-label="Ver Perfil"
                        >
                            <User size={15} strokeWidth={2} />
                            <span>Ver Perfil</span>
                        </button>
                        <button
                            className="sidebar-profile-menu-item"
                            onClick={handleEditProfile}
                            role="menuitem"
                            aria-label="Editar Perfil"
                        >
                            <Pencil size={15} strokeWidth={2} />
                            <span>Editar Perfil</span>
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
                        <div className="sidebar-section-divider">
                            <div className="sidebar-section-line" />
                            <span className="sidebar-section-label">Admin</span>
                            <div className="sidebar-section-line" />
                        </div>

                        <NavItem to="/admin/today" icon={MapPin} label="Hoje" collapsed={collapsed} />
                        <NavItem to="/admin/bookings" icon={ClipboardList} label="Agendamentos" collapsed={collapsed} />
                        <NavItem to="/admin/clients" icon={Users} label="Clientes" collapsed={collapsed} />
                        <NavItem to="/admin/contracts" icon={FileSignature} label="Contratos" collapsed={collapsed} />
                        <NavItem to="/admin/pricing" icon={BadgeDollarSign} label="Planos & Valores" collapsed={collapsed} />
                        <NavItem to="/admin/services" icon={Sparkles} label="Serviços" collapsed={collapsed} />
                        <NavItem to="/admin/finance" icon={CreditCard} label="Financeiro" collapsed={collapsed} />
                        <NavItem to="/admin/reports" icon={BarChart3} label="Relatórios" collapsed={collapsed} />
                    </>
                )}
            </nav>
        </aside>
    );
}

import React, { useState, useRef, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import NotificationBell from './NotificationBell';
import {
    Menu,
    User,
    Pencil,
    LogOut,
    ChevronDown,
} from 'lucide-react';

interface TopbarProps {
    onToggleSidebar: () => void;
    onProfileClick: () => void;
}

export default function Topbar({ onToggleSidebar, onProfileClick }: TopbarProps) {
    const { user, logout } = useAuth();
    const [menuOpen, setMenuOpen] = useState(false);
    const menuRef = useRef<HTMLDivElement>(null);

    const initials = user?.name
        ?.split(' ')
        .map(w => w[0])
        .join('')
        .slice(0, 2)
        .toUpperCase() || '??';

    // Close on click outside
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

    const handleProfile = () => {
        setMenuOpen(false);
        onProfileClick();
    };

    const handleLogout = async () => {
        setMenuOpen(false);
        await logout();
    };

    return (
        <header className="topbar">
            {/* Left: Hamburger + Logo */}
            <div className="topbar-left">
                <button
                    className="topbar-hamburger"
                    onClick={onToggleSidebar}
                    aria-label="Menu"
                    title="Menu (Ctrl+B)"
                >
                    <Menu size={22} strokeWidth={2} />
                </button>

                <a href="/dashboard" className="topbar-brand">
                    <img
                        src="https://buzios.digital/wp-content/uploads/2025/01/logo-site-branca.svg"
                        alt="Búzios Digital"
                        className="topbar-brand-logo"
                    />
                </a>
            </div>

            {/* Right: Notifications + Profile */}
            <div className="topbar-right">
                <div className="topbar-notif">
                    <NotificationBell />
                </div>

                {/* ─── Profile Avatar + Dropdown ─── */}
                <div className="topbar-profile" ref={menuRef}>
                    <button
                        className={`topbar-profile-trigger ${menuOpen ? 'topbar-profile-trigger--active' : ''}`}
                        onClick={() => setMenuOpen(prev => !prev)}
                        aria-label="Menu do perfil"
                        aria-haspopup="menu"
                        aria-expanded={menuOpen}
                    >
                        <div
                            className="topbar-avatar"
                            style={user?.photoUrl ? {
                                backgroundImage: `url(${user.photoUrl})`,
                                backgroundSize: 'cover',
                                backgroundPosition: 'center',
                                fontSize: 0,
                            } : {}}
                        >
                            {!user?.photoUrl && initials}
                        </div>
                        <ChevronDown
                            size={14}
                            className={`topbar-profile-chevron ${menuOpen ? 'topbar-profile-chevron--open' : ''}`}
                            strokeWidth={2.5}
                        />
                    </button>

                    {/* Dropdown */}
                    {menuOpen && (
                        <div className="topbar-profile-dropdown" role="menu">
                            <div className="topbar-profile-dropdown__header">
                                <div
                                    className="topbar-avatar topbar-avatar--lg"
                                    style={user?.photoUrl ? {
                                        backgroundImage: `url(${user.photoUrl})`,
                                        backgroundSize: 'cover',
                                        backgroundPosition: 'center',
                                        fontSize: 0,
                                    } : {}}
                                >
                                    {!user?.photoUrl && initials}
                                </div>
                                <div>
                                    <div className="topbar-profile-dropdown__name">{user?.name}</div>
                                    <div className="topbar-profile-dropdown__email">{user?.email}</div>
                                </div>
                            </div>
                            <div className="topbar-profile-dropdown__divider" />
                            <button
                                className="topbar-profile-dropdown__item"
                                onClick={handleProfile}
                                role="menuitem"
                            >
                                <User size={16} strokeWidth={2} />
                                <span>Meu Perfil</span>
                            </button>
                            <button
                                className="topbar-profile-dropdown__item"
                                onClick={handleProfile}
                                role="menuitem"
                            >
                                <Pencil size={16} strokeWidth={2} />
                                <span>Editar Perfil</span>
                            </button>
                            <div className="topbar-profile-dropdown__divider" />
                            <button
                                className="topbar-profile-dropdown__item topbar-profile-dropdown__item--danger"
                                onClick={handleLogout}
                                role="menuitem"
                            >
                                <LogOut size={16} strokeWidth={2} />
                                <span>Sair</span>
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </header>
    );
}

import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import Avatar from './Avatar';
import NotificationBell from './NotificationBell';
import {
    Menu,
    User,
    LogOut,
    ChevronDown,
} from 'lucide-react';

interface TopbarProps {
    onToggleSidebar: () => void;
}

export default function Topbar({ onToggleSidebar }: TopbarProps) {
    const { user, logout } = useAuth();
    const navigate = useNavigate();
    const [menuOpen, setMenuOpen] = useState(false);
    const menuRef = useRef<HTMLDivElement>(null);

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
        navigate('/perfil');
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
                    {/* Logo servido localmente (public/icons) — não depende de URL externa (buzios.digital
                        estava fora do ar / ECONNRESET, quebrando o logo). Fallback: texto no onError. */}
                    <img
                        src="/icons/logo-branca.svg"
                        alt="Búzios Digital"
                        className="topbar-brand-logo"
                        onError={(e) => {
                            const img = e.currentTarget;
                            img.style.display = 'none';
                            const fb = img.nextElementSibling as HTMLElement | null;
                            if (fb) fb.style.display = 'inline';
                        }}
                    />
                    <span className="topbar-brand-fallback" style={{ display: 'none' }}>Búzios Digital</span>
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
                        <Avatar className="topbar-avatar" photoUrl={user?.photoUrl} name={user?.name} />
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
                                <Avatar className="topbar-avatar topbar-avatar--lg" photoUrl={user?.photoUrl} name={user?.name} />
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

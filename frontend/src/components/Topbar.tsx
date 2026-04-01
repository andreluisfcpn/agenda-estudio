import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import NotificationBell from './NotificationBell';
import {
    Menu,
} from 'lucide-react';

interface TopbarProps {
    onToggleSidebar: () => void;
}

export default function Topbar({ onToggleSidebar }: TopbarProps) {
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

            {/* Right: Notifications only */}
            <div className="topbar-right">
                <div className="topbar-notif">
                    <NotificationBell />
                </div>
            </div>
        </header>
    );
}

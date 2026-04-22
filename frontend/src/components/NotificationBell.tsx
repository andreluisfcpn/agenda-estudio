import React, { useState, useEffect, useRef, useCallback } from 'react';
import { notificationsApi, NotificationItem, NotificationSummary } from '../api/client';
import { useNavigate } from 'react-router-dom';
import { Bell, CheckCheck } from 'lucide-react';

const SEVERITY_META: Record<string, { color: string; bg: string; icon: string }> = {
    critical: { color: '#dc2626', bg: 'rgba(220,38,38,0.08)', icon: '🔴' },
    warning: { color: '#d97706', bg: 'rgba(217,119,6,0.06)', icon: '🟡' },
    info: { color: '#3b82f6', bg: 'rgba(59,130,246,0.06)', icon: '🔵' },
};

const styleId = 'notification-bell-styles';
if (typeof document !== 'undefined' && !document.getElementById(styleId)) {
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
        @keyframes bellShake {
            0%, 100% { transform: rotate(0); }
            15% { transform: rotate(12deg); }
            30% { transform: rotate(-10deg); }
            45% { transform: rotate(8deg); }
            60% { transform: rotate(-6deg); }
            75% { transform: rotate(3deg); }
        }
        .notif-bell-shake { animation: bellShake 0.6s ease-in-out; }
        @keyframes badgePulse {
            0%, 100% { transform: scale(1); }
            50% { transform: scale(1.15); }
        }
        .notif-badge-pulse { animation: badgePulse 2s infinite; }
        .notif-item { transition: all 0.2s; cursor: pointer; border-left: 3px solid transparent; }
        .notif-item:hover { background: rgba(17,129,155,0.06) !important; transform: translateX(2px); }
        .notif-item-read { opacity: 0.55; }
        .notif-item-unread { background: rgba(17,129,155,0.03); }
        @keyframes slideDown {
            from { opacity: 0; transform: translateY(-8px); }
            to { opacity: 1; transform: translateY(0); }
        }
        .notif-panel { animation: slideDown 0.2s ease-out; }
    `;
    document.head.appendChild(style);
}

export default function NotificationBell() {
    const navigate = useNavigate();
    const [notifications, setNotifications] = useState<NotificationItem[]>([]);
    const [summary, setSummary] = useState<NotificationSummary>({ total: 0, unread: 0, critical: 0, warning: 0, info: 0 });
    const [open, setOpen] = useState(false);
    const [shake, setShake] = useState(false);
    const panelRef = useRef<HTMLDivElement>(null);
    const bellRef = useRef<HTMLButtonElement>(null);
    const prevUnreadRef = useRef(0);

    const loadNotifications = useCallback(async () => {
        try {
            const res = await notificationsApi.getAll();
            setNotifications(res.notifications);
            setSummary(res.summary);

            // Shake bell if unread count increased
            if (res.summary.unread > prevUnreadRef.current && prevUnreadRef.current > 0) {
                setShake(true);
                setTimeout(() => setShake(false), 700);
            }
            prevUnreadRef.current = res.summary.unread;
        } catch (err) { console.error('Erro ao carregar notificações:', err); }
    }, []);

    useEffect(() => {
        loadNotifications();
        const interval = setInterval(loadNotifications, 60_000);
        return () => clearInterval(interval);
    }, [loadNotifications]);

    // Close panel on outside click
    useEffect(() => {
        function handleClick(e: MouseEvent) {
            if (panelRef.current && !panelRef.current.contains(e.target as Node) &&
                bellRef.current && !bellRef.current.contains(e.target as Node)) {
                setOpen(false);
            }
        }
        if (open) document.addEventListener('mousedown', handleClick);
        return () => document.removeEventListener('mousedown', handleClick);
    }, [open]);

    const handleMarkRead = async (id: string, source: string, e: React.MouseEvent) => {
        e.stopPropagation();
        if (source === 'persisted') {
            try {
                await notificationsApi.markAsRead(id);
                setNotifications(prev => prev.map(n => n.id === id ? { ...n, read: true } : n));
                setSummary(prev => ({ ...prev, unread: Math.max(0, prev.unread - 1) }));
            } catch { }
        } else {
            // Computed notifications: dismiss locally (they reset on refresh since they have no DB state)
            setNotifications(prev => prev.filter(n => n.id !== id));
            setSummary(prev => ({ ...prev, total: prev.total - 1, unread: Math.max(0, prev.unread - 1) }));
        }
    };

    const handleMarkAllRead = async () => {
        try {
            await notificationsApi.markAllAsRead();
            setNotifications(prev => prev.map(n => ({ ...n, read: true })));
            setSummary(prev => ({ ...prev, unread: 0, critical: 0, warning: 0, info: 0 }));
        } catch { }
    };

    const unreadNotifications = notifications.filter(n => !n.read);
    const unreadCount = summary.unread;
    const criticalCount = unreadNotifications.filter(n => n.severity === 'critical').length;

    return (
        <div style={{ position: 'relative' }}>
            {/* Bell Button */}
            <button
                ref={bellRef}
                onClick={() => setOpen(!open)}
                className={shake ? 'notif-bell-shake' : ''}
                style={{
                    background: open ? 'rgba(17,129,155,0.12)' : 'transparent',
                    border: '1px solid transparent',
                    borderRadius: 'var(--radius-md)',
                    padding: '8px 12px',
                    cursor: 'pointer',
                    display: 'flex', alignItems: 'center', gap: '8px',
                    color: unreadCount > 0 ? 'var(--text-primary)' : 'var(--text-muted)',
                    fontSize: '1.125rem',
                    transition: 'all 0.2s',
                    width: '100%',
                    fontFamily: 'inherit',
                }}
                title={`${unreadCount} notificação${unreadCount !== 1 ? 'ões' : ''} não lida${unreadCount !== 1 ? 's' : ''}`}
            >
                <span className="sidebar-link-icon"><Bell size={20} strokeWidth={1.8} /></span>
                <span className="sidebar-link-label" style={{ fontSize: '0.8125rem', fontWeight: 600, flex: 1, textAlign: 'left' }}>
                    Notificações
                </span>
                {unreadCount > 0 && (
                    <span className={criticalCount > 0 ? 'notif-badge-pulse' : ''} style={{
                        minWidth: 20, height: 20, borderRadius: 10,
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: '0.65rem', fontWeight: 800,
                        background: criticalCount > 0 ? '#dc2626' : '#d97706',
                        color: '#fff',
                        padding: '0 5px',
                    }}>
                        {unreadCount}
                    </span>
                )}
            </button>

            {/* Notification Panel */}
            {open && (
                <div ref={panelRef} className="notif-panel" style={{
                    position: 'absolute', top: '100%', right: 0,
                    width: 360, maxHeight: 480, marginTop: '8px',
                    background: 'var(--bg-elevated)', borderRadius: 'var(--radius-lg)',
                    border: '1px solid var(--border-default)',
                    boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
                    zIndex: 1000, overflow: 'hidden',
                    display: 'flex', flexDirection: 'column',
                }}>
                    {/* Header */}
                    <div style={{
                        padding: '14px 16px', borderBottom: '1px solid var(--border-default)',
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    }}>
                        <div style={{ fontWeight: 700, fontSize: '0.875rem', color: 'var(--text-primary)' }}>
                            🔔 Central de Alertas
                        </div>
                        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                            {unreadCount > 0 && (
                                <button onClick={handleMarkAllRead} style={{
                                    background: 'none', border: 'none', color: 'var(--accent-primary)',
                                    fontSize: '0.7rem', cursor: 'pointer', fontWeight: 600, fontFamily: 'inherit',
                                    display: 'flex', alignItems: 'center', gap: '3px',
                                }} title="Marcar todas como lidas">
                                    <CheckCheck size={13} /> Ler todas
                                </button>
                            )}
                            <div style={{ display: 'flex', gap: '4px' }}>
                                {criticalCount > 0 && <span style={{ fontSize: '0.65rem', background: 'rgba(220,38,38,0.12)', color: '#dc2626', padding: '2px 6px', borderRadius: 4, fontWeight: 700 }}>{criticalCount} 🔴</span>}
                                {summary.warning > 0 && <span style={{ fontSize: '0.65rem', background: 'rgba(217,119,6,0.1)', color: '#d97706', padding: '2px 6px', borderRadius: 4, fontWeight: 700 }}>{unreadNotifications.filter(n => n.severity === 'warning').length} 🟡</span>}
                            </div>
                        </div>
                    </div>

                    {/* List */}
                    <div style={{ overflowY: 'auto', flex: 1 }}>
                        {notifications.length === 0 ? (
                            <div style={{ padding: '40px 20px', textAlign: 'center' }}>
                                <div style={{ fontSize: '2.5rem', marginBottom: '8px' }}>✅</div>
                                <div style={{ fontWeight: 700, fontSize: '0.875rem', color: 'var(--text-primary)' }}>Tudo em dia!</div>
                                <p style={{ color: 'var(--text-muted)', fontSize: '0.75rem', marginTop: '4px' }}>Nenhum alerta pendente</p>
                            </div>
                        ) : (
                            notifications.map(n => {
                                const meta = SEVERITY_META[n.severity];
                                return (
                                    <div
                                        key={n.id}
                                        className={`notif-item ${n.read ? 'notif-item-read' : 'notif-item-unread'}`}
                                        style={{
                                            padding: '12px 16px',
                                            borderBottom: '1px solid var(--border-subtle)',
                                            borderLeftColor: n.read ? 'transparent' : meta.color,
                                            display: 'flex', gap: '10px', alignItems: 'flex-start',
                                        }}
                                        onClick={() => {
                                            if (n.actionUrl) { navigate(n.actionUrl); setOpen(false); }
                                        }}
                                    >
                                        {/* Unread dot */}
                                        <div style={{ width: 8, minWidth: 8, marginTop: '6px' }}>
                                            {!n.read && (
                                                <div style={{
                                                    width: 8, height: 8, borderRadius: '50%',
                                                    background: meta.color,
                                                }} />
                                            )}
                                        </div>
                                        <div style={{ flex: 1, minWidth: 0 }}>
                                            <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '2px' }}>
                                                {n.title}
                                            </div>
                                            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', lineHeight: 1.4, wordBreak: 'break-word' }}>
                                                {n.message}
                                            </div>
                                            {n.source === 'persisted' && n.createdAt && (
                                                <div style={{ fontSize: '0.6rem', color: 'var(--text-muted)', marginTop: '3px', opacity: 0.7 }}>
                                                    {formatTimeAgo(n.createdAt)}
                                                </div>
                                            )}
                                        </div>
                                        {!n.read && (
                                            <button
                                                onClick={(e) => handleMarkRead(n.id, n.source, e)}
                                                style={{
                                                    background: 'none', border: 'none', color: 'var(--text-muted)',
                                                    cursor: 'pointer', fontSize: '0.875rem', padding: '2px',
                                                    opacity: 0.5, transition: 'opacity 0.2s', flexShrink: 0,
                                                }}
                                                onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
                                                onMouseLeave={e => (e.currentTarget.style.opacity = '0.5')}
                                                title="Marcar como lida"
                                            >✕</button>
                                        )}
                                    </div>
                                );
                            })
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

function formatTimeAgo(isoDate: string): string {
    const diff = Date.now() - new Date(isoDate).getTime();
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return 'agora';
    if (minutes < 60) return `há ${minutes}min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `há ${hours}h`;
    const days = Math.floor(hours / 24);
    return `há ${days}d`;
}

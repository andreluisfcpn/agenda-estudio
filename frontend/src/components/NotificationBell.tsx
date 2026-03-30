import React, { useState, useEffect, useRef, useCallback } from 'react';
import { notificationsApi, NotificationItem, NotificationSummary } from '../api/client';
import { useNavigate } from 'react-router-dom';

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
    const [summary, setSummary] = useState<NotificationSummary>({ total: 0, critical: 0, warning: 0, info: 0 });
    const [open, setOpen] = useState(false);
    const [dismissed, setDismissed] = useState<Set<string>>(() => {
        try {
            const stored = localStorage.getItem('dismissed-notifications');
            return stored ? new Set(JSON.parse(stored)) : new Set();
        } catch { return new Set(); }
    });
    const [shake, setShake] = useState(false);
    const panelRef = useRef<HTMLDivElement>(null);
    const bellRef = useRef<HTMLButtonElement>(null);
    const prevCountRef = useRef(0);

    const loadNotifications = useCallback(async () => {
        try {
            const res = await notificationsApi.getAll();
            setNotifications(res.notifications);
            setSummary(res.summary);

            // Shake bell if count increased
            if (res.summary.total > prevCountRef.current && prevCountRef.current > 0) {
                setShake(true);
                setTimeout(() => setShake(false), 700);
            }
            prevCountRef.current = res.summary.total;
        } catch (err) { console.error('Erro ao carregar notificações:', err); }
    }, []);

    useEffect(() => {
        loadNotifications();
        const interval = setInterval(loadNotifications, 60_000); // refresh every minute
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

    const dismiss = (id: string, e: React.MouseEvent) => {
        e.stopPropagation();
        const newDismissed = new Set(dismissed);
        newDismissed.add(id);
        setDismissed(newDismissed);
        localStorage.setItem('dismissed-notifications', JSON.stringify([...newDismissed]));
    };

    const clearAllDismissed = () => {
        setDismissed(new Set());
        localStorage.removeItem('dismissed-notifications');
    };

    const visibleNotifications = notifications.filter(n => !dismissed.has(n.id));
    const activeCount = visibleNotifications.length;
    const criticalCount = visibleNotifications.filter(n => n.severity === 'critical').length;

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
                    color: activeCount > 0 ? 'var(--text-primary)' : 'var(--text-muted)',
                    fontSize: '1.125rem',
                    transition: 'all 0.2s',
                    width: '100%',
                    fontFamily: 'inherit',
                }}
                title={`${activeCount} notificação${activeCount !== 1 ? 'ões' : ''}`}
            >
                <span>🔔</span>
                <span style={{ fontSize: '0.8125rem', fontWeight: 600, flex: 1, textAlign: 'left' }}>
                    Notificações
                </span>
                {activeCount > 0 && (
                    <span className={criticalCount > 0 ? 'notif-badge-pulse' : ''} style={{
                        minWidth: 20, height: 20, borderRadius: 10,
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: '0.65rem', fontWeight: 800,
                        background: criticalCount > 0 ? '#dc2626' : '#d97706',
                        color: '#fff',
                        padding: '0 5px',
                    }}>
                        {activeCount}
                    </span>
                )}
            </button>

            {/* Notification Panel */}
            {open && (
                <div ref={panelRef} className="notif-panel" style={{
                    position: 'absolute', bottom: '100%', left: 0,
                    width: 360, maxHeight: 480, marginBottom: '8px',
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
                            {dismissed.size > 0 && (
                                <button onClick={clearAllDismissed} style={{
                                    background: 'none', border: 'none', color: 'var(--accent-primary)',
                                    fontSize: '0.7rem', cursor: 'pointer', fontWeight: 600, fontFamily: 'inherit',
                                }}>Restaurar</button>
                            )}
                            <div style={{ display: 'flex', gap: '4px' }}>
                                {criticalCount > 0 && <span style={{ fontSize: '0.65rem', background: 'rgba(220,38,38,0.12)', color: '#dc2626', padding: '2px 6px', borderRadius: 4, fontWeight: 700 }}>{criticalCount} 🔴</span>}
                                {summary.warning > 0 && <span style={{ fontSize: '0.65rem', background: 'rgba(217,119,6,0.1)', color: '#d97706', padding: '2px 6px', borderRadius: 4, fontWeight: 700 }}>{visibleNotifications.filter(n => n.severity === 'warning').length} 🟡</span>}
                            </div>
                        </div>
                    </div>

                    {/* List */}
                    <div style={{ overflowY: 'auto', flex: 1 }}>
                        {visibleNotifications.length === 0 ? (
                            <div style={{ padding: '40px 20px', textAlign: 'center' }}>
                                <div style={{ fontSize: '2.5rem', marginBottom: '8px' }}>✅</div>
                                <div style={{ fontWeight: 700, fontSize: '0.875rem', color: 'var(--text-primary)' }}>Tudo em dia!</div>
                                <p style={{ color: 'var(--text-muted)', fontSize: '0.75rem', marginTop: '4px' }}>Nenhum alerta pendente</p>
                            </div>
                        ) : (
                            visibleNotifications.map(n => {
                                const meta = SEVERITY_META[n.severity];
                                return (
                                    <div
                                        key={n.id}
                                        className="notif-item"
                                        style={{
                                            padding: '12px 16px',
                                            borderBottom: '1px solid var(--border-subtle)',
                                            borderLeftColor: meta.color,
                                            display: 'flex', gap: '10px', alignItems: 'flex-start',
                                        }}
                                        onClick={() => {
                                            if (n.actionUrl) { navigate(n.actionUrl); setOpen(false); }
                                        }}
                                    >
                                        <span style={{ fontSize: '0.75rem', marginTop: '2px' }}>{meta.icon}</span>
                                        <div style={{ flex: 1, minWidth: 0 }}>
                                            <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '2px' }}>
                                                {n.title}
                                            </div>
                                            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', lineHeight: 1.4, wordBreak: 'break-word' }}>
                                                {n.message}
                                            </div>
                                        </div>
                                        <button
                                            onClick={(e) => dismiss(n.id, e)}
                                            style={{
                                                background: 'none', border: 'none', color: 'var(--text-muted)',
                                                cursor: 'pointer', fontSize: '0.875rem', padding: '2px',
                                                opacity: 0.5, transition: 'opacity 0.2s', flexShrink: 0,
                                            }}
                                            onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
                                            onMouseLeave={e => (e.currentTarget.style.opacity = '0.5')}
                                            title="Dispensar"
                                        >✕</button>
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

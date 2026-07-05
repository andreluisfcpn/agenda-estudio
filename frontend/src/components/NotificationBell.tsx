import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { NotificationItem } from '../api/client';
import { useNavigate } from 'react-router-dom';
import { Bell, CheckCheck, Check, ArrowRight, CheckCircle } from 'lucide-react';
import BottomSheetModal from './BottomSheetModal';
import { useIsMobile } from '../hooks/useIsMobile';
import { useNotifications } from '../hooks/useNotifications';
import { resolveNotifMeta, formatTimeAgo } from '../utils/notificationMeta';

const PREVIEW_COUNT = 5;

export default function NotificationBell() {
    const navigate = useNavigate();
    const isMobile = useIsMobile();
    const [open, setOpen] = useState(false);
    const [shake, setShake] = useState(false);
    const panelRef = useRef<HTMLDivElement>(null);
    const bellRef = useRef<HTMLButtonElement>(null);

    const { notifications, summary, markRead, markAllRead } = useNotifications({
        poll: true,
        onBump: () => { setShake(true); setTimeout(() => setShake(false), 700); },
    });

    // Close the desktop dropdown on outside click (the sheet closes itself).
    useEffect(() => {
        if (!open || isMobile) return;
        function handleClick(e: MouseEvent) {
            if (panelRef.current && !panelRef.current.contains(e.target as Node) &&
                bellRef.current && !bellRef.current.contains(e.target as Node)) {
                setOpen(false);
            }
        }
        document.addEventListener('mousedown', handleClick);
        return () => document.removeEventListener('mousedown', handleClick);
    }, [open, isMobile]);

    const unreadCount = summary.unread;
    const criticalCount = summary.critical;
    const warningCount = summary.warning;

    const onItemClick = (n: NotificationItem) => {
        if (!n.read) markRead(n.id);        // clicking an item reads it (expected)
        if (n.actionUrl) { navigate(n.actionUrl); setOpen(false); }
    };

    const preview = notifications.slice(0, PREVIEW_COUNT);

    // ── Shared body (dropdown + sheet) ──
    const body = (
        <div className="notif-panel">
            <div className="notif-panel__header">
                <div className="notif-summary">
                    {criticalCount > 0 && <span className="notif-summary-chip notif-summary-chip--critical">{criticalCount} crítica{criticalCount !== 1 ? 's' : ''}</span>}
                    {warningCount > 0 && <span className="notif-summary-chip notif-summary-chip--warning">{warningCount} aviso{warningCount !== 1 ? 's' : ''}</span>}
                    {criticalCount === 0 && warningCount === 0 && (
                        <span className="notif-summary-muted">{unreadCount > 0 ? `${unreadCount} não lida${unreadCount !== 1 ? 's' : ''}` : 'Nenhuma pendente'}</span>
                    )}
                </div>
                {unreadCount > 0 && (
                    <button className="notif-mark-all" onClick={markAllRead} title="Marcar todas como lidas">
                        <CheckCheck size={14} /> Ler todas
                    </button>
                )}
            </div>

            <div className="notif-panel__list">
                {notifications.length === 0 ? (
                    <div className="notif-empty">
                        <CheckCircle size={40} className="notif-empty__icon" aria-hidden="true" />
                        <div className="notif-empty__title">Tudo em dia!</div>
                        <p className="notif-empty__hint">Nenhum alerta pendente</p>
                    </div>
                ) : (
                    preview.map(n => {
                        const { Icon, tone } = resolveNotifMeta(n.type, n.severity);
                        return (
                            <button
                                key={n.id}
                                type="button"
                                className={`notif-item notif-tone--${tone} ${n.read ? 'notif-item--read' : 'notif-item--unread'}`}
                                onClick={() => onItemClick(n)}
                            >
                                <span className="notif-item__icon"><Icon size={17} aria-hidden="true" /></span>
                                <span className="notif-item__body">
                                    <span className="notif-item__title">{n.title}</span>
                                    <span className="notif-item__msg">{n.message}</span>
                                    {n.source === 'persisted' && n.createdAt && (
                                        <span className="notif-item__time">{formatTimeAgo(n.createdAt)}</span>
                                    )}
                                </span>
                                {!n.read && (
                                    <span
                                        role="button" tabIndex={0}
                                        className="notif-item__read-btn"
                                        onClick={(e) => { e.stopPropagation(); markRead(n.id); }}
                                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); markRead(n.id); } }}
                                        title="Marcar como lida" aria-label="Marcar como lida"
                                    ><Check size={15} /></span>
                                )}
                            </button>
                        );
                    })
                )}
            </div>

            {notifications.length > 0 && (
                <div className="notif-panel__footer">
                    <button className="notif-panel__see-all" onClick={() => { setOpen(false); navigate('/notificacoes'); }}>
                        Ver todas{notifications.length > PREVIEW_COUNT ? ` (${notifications.length})` : ''} <ArrowRight size={14} />
                    </button>
                </div>
            )}
        </div>
    );

    return (
        <div style={{ position: 'relative' }}>
            <button
                ref={bellRef}
                onClick={() => setOpen(!open)}
                aria-label={`Notificações${unreadCount > 0 ? `, ${unreadCount} não lida${unreadCount !== 1 ? 's' : ''}` : ''}`}
                aria-haspopup="true"
                aria-expanded={open}
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
                    <span className={`notif-badge ${criticalCount > 0 ? 'notif-badge--critical' : ''}`}>
                        {unreadCount}
                    </span>
                )}
            </button>

            {isMobile ? (
                <BottomSheetModal isOpen={open} onClose={() => setOpen(false)} title="Notificações" maxWidth="520px">
                    <div style={{ display: 'flex', flexDirection: 'column', maxHeight: '70vh' }}>{body}</div>
                </BottomSheetModal>
            ) : (
                <AnimatePresence>
                    {open && (
                        <motion.div
                            ref={panelRef}
                            className="notif-dropdown"
                            initial={{ opacity: 0, y: -8, scale: 0.98 }}
                            animate={{ opacity: 1, y: 0, scale: 1 }}
                            exit={{ opacity: 0, y: -8, scale: 0.98 }}
                            transition={{ duration: 0.18, ease: 'easeOut' }}
                        >
                            <div className="notif-panel__header notif-panel__title">Notificações</div>
                            {body}
                        </motion.div>
                    )}
                </AnimatePresence>
            )}
        </div>
    );
}

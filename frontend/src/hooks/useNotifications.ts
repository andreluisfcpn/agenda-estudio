import { useState, useEffect, useRef, useCallback } from 'react';
import { notificationsApi, NotificationItem, NotificationSummary } from '../api/client';

const EMPTY_SUMMARY: NotificationSummary = { total: 0, unread: 0, critical: 0, warning: 0, info: 0 };

/**
 * Shared notification state (bell preview + full page). Polls every 60s only
 * when `poll` is true (the bell is always mounted; the page reuses without a
 * second poller). `onBump` fires when the unread count grows (bell shake).
 */
export function useNotifications(opts: { poll?: boolean; onBump?: () => void } = {}) {
    const { poll = false, onBump } = opts;
    const [notifications, setNotifications] = useState<NotificationItem[]>([]);
    const [summary, setSummary] = useState<NotificationSummary>(EMPTY_SUMMARY);
    const [loading, setLoading] = useState(true);
    const prevUnreadRef = useRef(0);
    const onBumpRef = useRef(onBump);
    onBumpRef.current = onBump;
    // Mirror the list so markRead can read an item's severity at call time.
    const notifsRef = useRef<NotificationItem[]>([]);
    notifsRef.current = notifications;

    const reload = useCallback(async () => {
        try {
            const res = await notificationsApi.getAll();
            setNotifications(res.notifications);
            setSummary(res.summary);
            if (res.summary.unread > prevUnreadRef.current && prevUnreadRef.current > 0) {
                onBumpRef.current?.();
            }
            prevUnreadRef.current = res.summary.unread;
        } catch (err) {
            // Transient poll failure (backend restart, network) — next tick recovers.
            if (import.meta.env.DEV) console.error('Erro ao carregar notificações:', err);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        reload();
        if (!poll) return;
        const interval = setInterval(reload, 60_000);
        return () => clearInterval(interval);
    }, [reload, poll]);

    const markRead = useCallback(async (id: string) => {
        // Optimistic; the backend records read-state for computed ids too (Redis).
        const target = notifsRef.current.find(n => n.id === id);
        if (target && !target.read) {
            const sev = target.severity; // 'critical' | 'warning' | 'info' — a summary bucket
            setSummary(prev => ({
                ...prev,
                unread: Math.max(0, prev.unread - 1),
                [sev]: Math.max(0, prev[sev] - 1), // keep the bell's severity chips in sync (B5)
            }));
        }
        setNotifications(prev => prev.map(n => n.id === id ? { ...n, read: true } : n));
        try { await notificationsApi.markAsRead(id); } catch { /* best-effort */ }
    }, []);

    const markAllRead = useCallback(async () => {
        setNotifications(prev => prev.map(n => ({ ...n, read: true })));
        setSummary(prev => ({ ...prev, unread: 0, critical: 0, warning: 0, info: 0 }));
        try { await notificationsApi.markAllAsRead(); } catch { /* best-effort */ }
    }, []);

    return { notifications, summary, loading, reload, markRead, markAllRead };
}

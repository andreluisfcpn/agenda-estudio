import { Bell, X, Check } from 'lucide-react';
import { usePushNotifications } from '../hooks/usePushNotifications';
import '../styles/pwa.css';

export default function NotificationBanner() {
    const { canAsk, isSubscribed, isLoading, subscribe, dismiss } = usePushNotifications();

    // Already subscribed — show nothing
    if (isSubscribed || !canAsk) return null;

    return (
        <div className="notification-banner">
            <div className="notification-banner-icon">
                <Bell size={18} />
            </div>
            <div className="notification-banner-text">
                <strong>🔔 Ativar notificações</strong>
                <span>Receba alertas de pagamentos, sessões e contratos.</span>
            </div>
            <div className="notification-banner-actions">
                <button
                    className="notification-banner-btn"
                    onClick={subscribe}
                    disabled={isLoading}
                >
                    {isLoading ? '...' : 'ATIVAR'}
                </button>
                <button className="notification-banner-close" onClick={dismiss} aria-label="Fechar">
                    <X size={14} />
                </button>
            </div>
        </div>
    );
}

/** Small inline component to show subscription status in settings/profile */
export function PushNotificationStatus() {
    const { isSubscribed, permission, subscribe, sendTest, isLoading } = usePushNotifications();

    if (permission === 'denied') {
        return (
            <div className="notification-banner" style={{ opacity: 0.6 }}>
                <div className="notification-banner-icon">
                    <X size={18} />
                </div>
                <div className="notification-banner-text">
                    <strong>Notificações bloqueadas</strong>
                    <span>Ative nas configurações do navegador para receber alertas.</span>
                </div>
            </div>
        );
    }

    if (isSubscribed) {
        return (
            <div className="notification-banner">
                <div className="notification-banner-icon" style={{ background: 'rgba(34,197,94,0.15)', color: '#22c55e' }}>
                    <Check size={18} />
                </div>
                <div className="notification-banner-text">
                    <strong>Notificações ativas</strong>
                    <span>Você receberá alertas de pagamentos, sessões e contratos.</span>
                </div>
                <div className="notification-banner-actions">
                    <button className="notification-banner-btn" onClick={sendTest}>
                        TESTAR
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className="notification-banner">
            <div className="notification-banner-icon">
                <Bell size={18} />
            </div>
            <div className="notification-banner-text">
                <strong>Notificações desativadas</strong>
                <span>Ative para receber alertas importantes.</span>
            </div>
            <div className="notification-banner-actions">
                <button className="notification-banner-btn" onClick={subscribe} disabled={isLoading}>
                    {isLoading ? '...' : 'ATIVAR'}
                </button>
            </div>
        </div>
    );
}

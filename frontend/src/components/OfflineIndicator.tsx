import { WifiOff } from 'lucide-react';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import '../styles/pwa.css';

export default function OfflineIndicator() {
    const isOnline = useOnlineStatus();

    if (isOnline) return null;

    return (
        <div className="offline-indicator" role="alert" aria-live="assertive">
            <WifiOff size={14} />
            <span>Sem conexão — modo offline</span>
        </div>
    );
}

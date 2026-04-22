import { RefreshCw, X } from 'lucide-react';
import { useServiceWorker } from '../hooks/useServiceWorker';
import '../styles/pwa.css';

export default function UpdateBanner() {
    const { needRefresh, updateServiceWorker, dismissUpdate } = useServiceWorker();

    if (!needRefresh) return null;

    return (
        <div className="update-banner" role="alert">
            <div className="update-banner-content">
                <div className="update-banner-icon">
                    <RefreshCw size={18} />
                </div>
                <div className="update-banner-text">
                    <strong>Nova versão disponível</strong>
                    <span>Atualize para ter a melhor experiência</span>
                </div>
            </div>
            <div className="update-banner-actions">
                <button className="update-banner-btn" onClick={updateServiceWorker}>
                    ATUALIZAR
                </button>
                <button className="update-banner-dismiss" onClick={dismissUpdate} aria-label="Fechar">
                    <X size={14} />
                </button>
            </div>
        </div>
    );
}

import { Download, X } from 'lucide-react';
import { useInstallPrompt } from '../hooks/useInstallPrompt';
import '../styles/pwa.css';

export default function InstallBanner() {
    const { canInstall, install, dismiss } = useInstallPrompt();

    if (!canInstall) return null;

    return (
        <div className="install-banner">
            <div className="install-banner-content">
                <div className="install-banner-icon">
                    <Download size={20} />
                </div>
                <div className="install-banner-text">
                    <strong>Instale o App</strong>
                    <span>Acesso rápido e notificações</span>
                </div>
            </div>
            <div className="install-banner-actions">
                <button className="install-banner-btn" onClick={install}>
                    INSTALAR
                </button>
                <button className="install-banner-dismiss" onClick={dismiss} aria-label="Fechar">
                    <X size={16} />
                </button>
            </div>
        </div>
    );
}

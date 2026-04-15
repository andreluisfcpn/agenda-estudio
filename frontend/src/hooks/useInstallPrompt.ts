import { useState, useEffect, useCallback } from 'react';

interface BeforeInstallPromptEvent extends Event {
    prompt: () => Promise<void>;
    userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const DISMISS_KEY = 'pwa-install-dismissed';
const DISMISS_DAYS = 7;

export function useInstallPrompt() {
    const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
    const [isInstalled, setIsInstalled] = useState(false);
    const [isDismissed, setIsDismissed] = useState(false);

    useEffect(() => {
        // Check if already installed (standalone mode)
        if (window.matchMedia('(display-mode: standalone)').matches) {
            setIsInstalled(true);
            return;
        }

        // Check if user dismissed recently
        const dismissedAt = localStorage.getItem(DISMISS_KEY);
        if (dismissedAt) {
            const dismissDate = new Date(dismissedAt);
            const daysSince = (Date.now() - dismissDate.getTime()) / (1000 * 60 * 60 * 24);
            if (daysSince < DISMISS_DAYS) {
                setIsDismissed(true);
                return;
            }
            localStorage.removeItem(DISMISS_KEY);
        }

        const handleBeforeInstall = (e: Event) => {
            e.preventDefault();
            setDeferredPrompt(e as BeforeInstallPromptEvent);
        };

        const handleAppInstalled = () => {
            setIsInstalled(true);
            setDeferredPrompt(null);
        };

        window.addEventListener('beforeinstallprompt', handleBeforeInstall);
        window.addEventListener('appinstalled', handleAppInstalled);

        return () => {
            window.removeEventListener('beforeinstallprompt', handleBeforeInstall);
            window.removeEventListener('appinstalled', handleAppInstalled);
        };
    }, []);

    const install = useCallback(async () => {
        if (!deferredPrompt) return false;
        deferredPrompt.prompt();
        const { outcome } = await deferredPrompt.userChoice;
        setDeferredPrompt(null);
        return outcome === 'accepted';
    }, [deferredPrompt]);

    const dismiss = useCallback(() => {
        localStorage.setItem(DISMISS_KEY, new Date().toISOString());
        setIsDismissed(true);
        setDeferredPrompt(null);
    }, []);

    return {
        canInstall: !!deferredPrompt && !isInstalled && !isDismissed,
        isInstalled,
        install,
        dismiss,
    };
}

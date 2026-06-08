import { useState, useEffect, useCallback } from 'react';

export function useServiceWorker() {
    const [needRefresh, setNeedRefresh] = useState(false);
    const [waitingWorker, setWaitingWorker] = useState<ServiceWorker | null>(null);

    useEffect(() => {
        if (!('serviceWorker' in navigator)) return;

        const handleControllerChange = () => {
            window.location.reload();
        };

        const checkWaiting = (reg: ServiceWorkerRegistration) => {
            if (reg.waiting) {
                setWaitingWorker(reg.waiting);
                setNeedRefresh(true);
            }
        };

        let cleanupChecks = () => {};

        navigator.serviceWorker.ready.then((reg) => {
            checkWaiting(reg);

            reg.addEventListener('updatefound', () => {
                const newWorker = reg.installing;
                if (!newWorker) return;

                newWorker.addEventListener('statechange', () => {
                    if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                        setWaitingWorker(newWorker);
                        setNeedRefresh(true);
                    }
                });
            });

            // Proactively poll for a new version so installed PWAs (which can stay open for
            // days) pick up deploys without a manual hard-reload: every 30 min, when the tab
            // becomes visible again, and when connectivity is restored.
            const check = () => { reg.update().catch(() => {}); };
            const interval = window.setInterval(check, 30 * 60 * 1000);
            const onVisible = () => { if (document.visibilityState === 'visible') check(); };
            document.addEventListener('visibilitychange', onVisible);
            window.addEventListener('online', check);
            cleanupChecks = () => {
                window.clearInterval(interval);
                document.removeEventListener('visibilitychange', onVisible);
                window.removeEventListener('online', check);
            };
        });

        navigator.serviceWorker.addEventListener('controllerchange', handleControllerChange);

        return () => {
            navigator.serviceWorker.removeEventListener('controllerchange', handleControllerChange);
            cleanupChecks();
        };
    }, []);

    const updateServiceWorker = useCallback(() => {
        if (waitingWorker) {
            waitingWorker.postMessage({ type: 'SKIP_WAITING' });
        }
    }, [waitingWorker]);

    const dismissUpdate = useCallback(() => {
        setNeedRefresh(false);
    }, []);

    return { needRefresh, updateServiceWorker, dismissUpdate };
}

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
        });

        navigator.serviceWorker.addEventListener('controllerchange', handleControllerChange);

        return () => {
            navigator.serviceWorker.removeEventListener('controllerchange', handleControllerChange);
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

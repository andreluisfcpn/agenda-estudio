import { useState, useEffect, useCallback } from 'react';

const DISMISS_KEY = 'push-notif-dismissed';
const DISMISS_DAYS = 30;

export function usePushNotifications() {
    const [permission, setPermission] = useState<NotificationPermission>(
        typeof Notification !== 'undefined' ? Notification.permission : 'default',
    );
    const [isSubscribed, setIsSubscribed] = useState(false);
    const [isDismissed, setIsDismissed] = useState(false);
    const [isLoading, setIsLoading] = useState(false);

    useEffect(() => {
        // Check dismissed state
        const dismissedAt = localStorage.getItem(DISMISS_KEY);
        if (dismissedAt) {
            const days = (Date.now() - new Date(dismissedAt).getTime()) / (1000 * 60 * 60 * 24);
            if (days < DISMISS_DAYS) {
                setIsDismissed(true);
                return;
            }
            localStorage.removeItem(DISMISS_KEY);
        }

        // Check if already subscribed
        if ('serviceWorker' in navigator && permission === 'granted') {
            navigator.serviceWorker.ready.then(async (reg) => {
                const sub = await reg.pushManager.getSubscription();
                setIsSubscribed(!!sub);
            });
        }
    }, [permission]);

    const subscribe = useCallback(async (): Promise<boolean> => {
        if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
            console.warn('[PUSH] Push not supported');
            return false;
        }

        setIsLoading(true);
        try {
            // 1. Request permission
            const perm = await Notification.requestPermission();
            setPermission(perm);
            if (perm !== 'granted') return false;

            // 2. Get VAPID key
            const res = await fetch('/api/push/vapid-key');
            const { publicKey } = await res.json();
            if (!publicKey) return false;

            // 3. Subscribe via Push API
            const reg = await navigator.serviceWorker.ready;
            const subscription = await reg.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(publicKey).buffer as ArrayBuffer,
            });

            // 4. Send subscription to backend
            const subJson = subscription.toJSON();
            const saveRes = await fetch('/api/push/subscribe', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    endpoint: subJson.endpoint,
                    keys: subJson.keys,
                }),
            });

            if (saveRes.ok) {
                setIsSubscribed(true);
                return true;
            }
            return false;
        } catch (err) {
            console.error('[PUSH] Subscribe failed:', err);
            return false;
        } finally {
            setIsLoading(false);
        }
    }, []);

    const dismiss = useCallback(() => {
        localStorage.setItem(DISMISS_KEY, new Date().toISOString());
        setIsDismissed(true);
    }, []);

    const sendTest = useCallback(async () => {
        try {
            await fetch('/api/push/test', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
            });
        } catch (err) {
            console.error('[PUSH] Test failed:', err);
        }
    }, []);

    return {
        permission,
        isSubscribed,
        isDismissed,
        isLoading,
        canAsk: permission === 'default' && !isDismissed && !isSubscribed,
        subscribe,
        dismiss,
        sendTest,
    };
}

/** Convert base64 VAPID key to Uint8Array for Push API. */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
}

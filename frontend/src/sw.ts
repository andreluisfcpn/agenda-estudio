/// <reference lib="webworker" />
import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching';

declare const self: ServiceWorkerGlobalScope;

// Workbox precaching — vite-plugin-pwa injects the manifest here
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// ─── Push Notification Handler ───
self.addEventListener('push', (event) => {
    if (!event.data) return;

    try {
        const data = event.data.json();
        const options: NotificationOptions = {
            body: data.message || '',
            icon: '/icons/icon-192.svg',
            badge: '/icons/icon-192.svg',
            tag: data.tag || 'buzios-default',
            data: { url: data.actionUrl || '/' },
            requireInteraction: data.severity === 'critical',
        };

        event.waitUntil(
            self.registration.showNotification(
                data.title || 'Estúdio Búzios Digital',
                options,
            ),
        );
    } catch (err) {
        console.error('[SW] Push parse error:', err);
    }
});

// ─── Notification Click Handler ───
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const url = event.notification.data?.url || '/';

    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
            // Focus existing window if any
            for (const client of clientList) {
                if (client.url.includes(self.location.origin) && 'focus' in client) {
                    client.focus();
                    client.navigate(url);
                    return;
                }
            }
            // Open new window
            return self.clients.openWindow(url);
        }),
    );
});

// ─── Auto-update ───
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});

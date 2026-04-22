/// <reference lib="webworker" />
import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching';
import { registerRoute, NavigationRoute, setCatchHandler } from 'workbox-routing';
import { NetworkFirst, StaleWhileRevalidate, CacheFirst } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';
import { CacheableResponsePlugin } from 'workbox-cacheable-response';

declare const self: ServiceWorkerGlobalScope;

// ─── Precaching ───
// Workbox precaching — vite-plugin-pwa injects the manifest here
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// ─── Runtime Caching Strategies ───

// API calls — NetworkFirst (try network, fallback to cached response)
registerRoute(
    ({ url }) => url.pathname.startsWith('/api/'),
    new NetworkFirst({
        cacheName: 'api-cache',
        networkTimeoutSeconds: 8,
        plugins: [
            new CacheableResponsePlugin({ statuses: [0, 200] }),
            new ExpirationPlugin({ maxEntries: 100, maxAgeSeconds: 60 * 60 }), // 1 hour
        ],
    }),
);

// Google Fonts stylesheets — StaleWhileRevalidate
registerRoute(
    ({ url }) => url.origin === 'https://fonts.googleapis.com',
    new StaleWhileRevalidate({
        cacheName: 'google-fonts-stylesheets',
        plugins: [
            new CacheableResponsePlugin({ statuses: [0, 200] }),
            new ExpirationPlugin({ maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 }), // 1 year
        ],
    }),
);

// Google Fonts webfonts — CacheFirst (font files rarely change)
registerRoute(
    ({ url }) => url.origin === 'https://fonts.gstatic.com',
    new CacheFirst({
        cacheName: 'google-fonts-webfonts',
        plugins: [
            new CacheableResponsePlugin({ statuses: [0, 200] }),
            new ExpirationPlugin({ maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 365 }), // 1 year
        ],
    }),
);

// Uploaded images — CacheFirst with expiration
registerRoute(
    ({ url }) => url.pathname.startsWith('/uploads/'),
    new CacheFirst({
        cacheName: 'uploads-cache',
        plugins: [
            new CacheableResponsePlugin({ statuses: [0, 200] }),
            new ExpirationPlugin({ maxEntries: 80, maxAgeSeconds: 60 * 60 * 24 * 30 }), // 30 days
        ],
    }),
);

// ─── Offline Fallback for Navigation Requests ───

const navigationHandler = new NetworkFirst({
    cacheName: 'pages-cache',
    networkTimeoutSeconds: 5,
    plugins: [
        new CacheableResponsePlugin({ statuses: [0, 200] }),
    ],
});

const navRoute = new NavigationRoute(navigationHandler);
registerRoute(navRoute);

// Serve offline.html when any navigation request fails
setCatchHandler(async ({ request }) => {
    if (request.destination === 'document') {
        const cached = await caches.match('/offline.html');
        return cached ?? new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/html' } });
    }
    return Response.error();
});

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

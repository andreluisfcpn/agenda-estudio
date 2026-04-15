import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
    plugins: [
        react(),
        VitePWA({
            strategies: 'injectManifest',
            srcDir: 'src',
            filename: 'sw.ts',
            registerType: 'autoUpdate',
            includeAssets: ['icons/icon-192.svg', 'icons/icon-512.svg'],
            manifest: {
                name: 'Estúdio Búzios Digital',
                short_name: 'Búzios Studio',
                description: 'Agende seu podcast ou vídeo no Estúdio Búzios Digital',
                theme_color: '#001e26',
                background_color: '#001e26',
                display: 'standalone',
                orientation: 'portrait',
                scope: '/',
                start_url: '/',
                categories: ['business', 'productivity'],
                icons: [
                    { src: '/icons/icon-192.svg', sizes: '192x192', type: 'image/svg+xml' },
                    { src: '/icons/icon-512.svg', sizes: '512x512', type: 'image/svg+xml' },
                    { src: '/icons/icon-512.svg', sizes: '512x512', type: 'image/svg+xml', purpose: 'maskable' },
                ],
            },
            injectManifest: {
                globPatterns: ['**/*.{js,css,html,ico,svg,woff2}'],
            },
            devOptions: {
                enabled: true,
                type: 'module',
            },
        }),
    ],
    server: {
        port: 5173,
        proxy: {
            '/api': {
                target: 'http://127.0.0.1:3001',
                changeOrigin: true,
            },
            '/uploads': {
                target: 'http://127.0.0.1:3001',
                changeOrigin: true,
            },
        },
    },
});

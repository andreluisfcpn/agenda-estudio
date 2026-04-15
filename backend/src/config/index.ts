import dotenv from 'dotenv';
import path from 'path';

// In production (Docker/Railway), env vars are injected directly.
// In development, load from ../.env
if (process.env.NODE_ENV !== 'production') {
    dotenv.config({ path: path.resolve(__dirname, '../../.env') });
}

export const config = {
    port: parseInt(process.env.PORT || '3001', 10),
    nodeEnv: process.env.NODE_ENV || 'development',
    frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',

    database: {
        url: process.env.DATABASE_URL!,
    },

    redis: {
        url: process.env.REDIS_URL || 'redis://localhost:6379',
    },

    jwt: {
        secret: process.env.JWT_SECRET || 'dev-secret',
        refreshSecret: process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret',
        accessExpiry: process.env.JWT_ACCESS_EXPIRY || '1h',
        refreshExpiry: process.env.JWT_REFRESH_EXPIRY || '365d',
    },

    stripe: {
        secretKey: process.env.STRIPE_SECRET_KEY || '',
    },

    cora: {
        apiKey: process.env.CORA_API_KEY || '',
        apiUrl: process.env.CORA_API_URL || 'https://api.cora.com.br',
    },

    // Business constants
    studio: {
        openTime: '09:00',
        closeTime: '23:00',
        slotDurationMinutes: 30,
        minPackageHours: 2,
        operatingDays: [1, 2, 3, 4, 5, 6], // Mon=1 to Sat=6
        lockTtlSeconds: 600, // 10 minutes
    },

    push: {
        vapidPublicKey: process.env.VAPID_PUBLIC_KEY || '',
        vapidPrivateKey: process.env.VAPID_PRIVATE_KEY || '',
        vapidSubject: process.env.VAPID_SUBJECT || 'mailto:contato@buzios.digital',
    },
} as const;

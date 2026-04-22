import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { config } from './config/index.js';
import { errorHandler } from './middleware/errorHandler.js';

// Route modules
import authRoutes from './modules/auth/routes.js';
import bookingRoutes from './modules/bookings/routes.js';
import contractRoutes from './modules/contracts/routes.js';
import userRoutes from './modules/users/routes.js';
import blockedSlotRoutes from './modules/blocked-slots/routes.js';
import pricingRoutes from './modules/pricing/routes.js';
import paymentRoutes from './modules/payments/routes.js';
import { financeRouter } from './modules/finance/routes.js';
import notificationRoutes from './modules/notifications/routes.js';
import reportRoutes from './modules/reports/routes.js';
import integrationRoutes from './modules/integrations/routes.js';
import webhookRoutes from './modules/webhooks/routes.js';
import stripeRoutes from './modules/stripe/routes.js';
import pushRoutes from './modules/push/routes.js';

import { prisma } from './lib/prisma.js';


const app = express();

// ─── Middleware ──────────────────────────────────────────

// ─── Security ───────────────────────────────────────────

// Trust first proxy hop (Railway load balancer) — required for
// express-rate-limit to correctly identify clients via X-Forwarded-For
if (config.nodeEnv === 'production') {
    app.set('trust proxy', 1);
}

app.use(helmet({
    contentSecurityPolicy: config.nodeEnv === 'production' ? {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            imgSrc: ["'self'", "data:", "blob:", "https://buzios.digital", "https://agenda.buzios.digital", "https://*.stripe.com"],
            connectSrc: ["'self'", "https://agenda.buzios.digital", "https://*.stripe.com", "https://matls-clients.api.stage.cora.com.br"],
            frameSrc: ["'self'", "https://*.stripe.com"],
        },
    } : false,
    crossOriginEmbedderPolicy: false,
}));

// CORS: accept FRONTEND_URL and production domain
const allowedOrigins = [
    config.frontendUrl,
    'https://agenda.buzios.digital',
].filter(Boolean);

app.use(cors({
    origin: (origin, callback) => {
        // Allow requests with no origin (server-to-server, curl, health checks)
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error('CORS not allowed'));
        }
    },
    credentials: true,
}));

// ─── Rate Limiting ──────────────────────────────────────

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 15,
    message: { error: 'Muitas tentativas. Tente novamente em 15 minutos.' },
    standardHeaders: true,
    legacyHeaders: false,
});

const otpLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: { error: 'Muitos códigos solicitados. Aguarde 15 minutos.' },
    standardHeaders: true,
    legacyHeaders: false,
});

const apiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 300,
    message: { error: 'Requisições excessivas. Aguarde 1 minuto.' },
    standardHeaders: true,
    legacyHeaders: false,
});

// PAY-04 FIX: Stricter limiter for financial endpoints
const paymentLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 20, // max 20 payment operations in 15 min per IP
    message: { error: 'Muitas tentativas de pagamento. Aguarde 15 minutos.' },
    standardHeaders: true,
    legacyHeaders: false,
});

// ─── Body Parsing ───────────────────────────────────────

// Stripe webhooks need the raw body for signature verification.
app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }));
app.use(express.json({
    verify: (req: any, _res, buf) => {
        // Store raw body for any other webhook that might need it
        req.rawBody = buf;
    },
}));
app.use(cookieParser());
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// ─── Health Check ───────────────────────────────────────

app.get('/api/health', (_req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
    });
});

// ─── Routes ─────────────────────────────────────────────

app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/auth/otp', otpLimiter);
app.use('/api/auth/register/send-code', otpLimiter);
app.use('/api/stripe/create-payment', paymentLimiter);
app.use('/api/stripe/verify-payment', paymentLimiter);
app.use('/api', apiLimiter);

app.use('/api/auth', authRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/contracts', contractRoutes);
app.use('/api/users', userRoutes);
app.use('/api/blocked-slots', blockedSlotRoutes);
app.use('/api/pricing', pricingRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/finance', financeRouter);
app.use('/api/notifications', notificationRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/integrations', integrationRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/stripe', stripeRoutes);
app.use('/api/push', pushRoutes);

// ─── Serve Frontend (Production) ────────────────────────

if (config.nodeEnv === 'production') {
    const frontendPath = path.join(__dirname, '../../frontend/dist');
    app.use(express.static(frontendPath));

    // Catch-all: send index.html for any non-API route (React Router)
    app.get('*', (_req, res) => {
        res.sendFile(path.join(frontendPath, 'index.html'));
    });
}

// ─── Error Handler ──────────────────────────────────────

app.use(errorHandler);

// ─── Start Server ───────────────────────────────────────

app.listen(config.port, async () => {
    console.log(`🎙️  Studio Scheduler API running on http://localhost:${config.port}`);
    console.log(`   Environment: ${config.nodeEnv}`);

    const { redis } = await import('./lib/redis.js');

    // Hold Expiration Cronjob — clean expired HELD bookings & AWAITING_PAYMENT contracts every 60s
    import('./jobs/cleanExpiredHolds.js').then(({ cleanExpiredHolds }) => {
        const runHoldCleanup = async () => {
            const holdLockKey = 'cron:hold-cleanup:lock';
            const lockAcquired = await redis.set(holdLockKey, 'running', 'EX', 50, 'NX');
            if (lockAcquired !== 'OK') return;
            try {
                await cleanExpiredHolds();
            } finally {
                await redis.del(holdLockKey);
            }
        };
        setInterval(runHoldCleanup, 60 * 1000);
        console.log('   ⏰ Hold cleanup job registered (every 60s)');
    }).catch(err => console.error('[HOLD-CLEANUP] Failed to load job:', err));

    // Push Notification Cronjob — checks & sends push every 5 minutes
    import('./jobs/pushNotificationJob.js').then(({ runPushNotificationJob }) => {
        const runPushJob = async () => {
            const pushLockKey = 'cron:push-notif:lock';
            const lockAcquired = await redis.set(pushLockKey, 'running', 'EX', 280, 'NX');
            if (lockAcquired !== 'OK') return;
            try {
                await runPushNotificationJob();
            } finally {
                await redis.del(pushLockKey);
            }
        };
        setInterval(runPushJob, 5 * 60 * 1000);
        console.log('   📱 Push notification job registered (every 5min)');
    }).catch(err => console.error('[PUSH-JOB] Failed to load:', err));

    // Booking Reminder Cronjob — sends reminders 24h and 2h before sessions
    import('./jobs/bookingReminderJob.js').then(({ runBookingReminderJob }) => {
        const runReminderJob = async () => {
            const reminderLockKey = 'cron:booking-reminder:lock';
            const lockAcquired = await redis.set(reminderLockKey, 'running', 'EX', 1500, 'NX');
            if (lockAcquired !== 'OK') return;
            try {
                await runBookingReminderJob();
            } finally {
                await redis.del(reminderLockKey);
            }
        };
        setInterval(runReminderJob, 30 * 60 * 1000);
        setTimeout(runReminderJob, 5000); // run once on boot
        console.log('   🔔 Booking reminder job registered (every 30min)');
    }).catch(err => console.error('[REMINDER-JOB] Failed to load:', err));

    // Notification Cleanup Cronjob — removes old read/unread notifications daily
    import('./jobs/notificationCleanupJob.js').then(({ runNotificationCleanupJob }) => {
        const runCleanupJob = async () => {
            const cleanupLockKey = 'cron:notif-cleanup:lock';
            const lockAcquired = await redis.set(cleanupLockKey, 'running', 'EX', 3600, 'NX');
            if (lockAcquired !== 'OK') return;
            try {
                await runNotificationCleanupJob();
            } finally {
                await redis.del(cleanupLockKey);
            }
        };
        setInterval(runCleanupJob, 24 * 60 * 60 * 1000);
        setTimeout(runCleanupJob, 10000); // run once on boot
        console.log('   🧹 Notification cleanup job registered (daily)');
    }).catch(err => console.error('[NOTIF-CLEANUP] Failed to load:', err));
});

export default app;

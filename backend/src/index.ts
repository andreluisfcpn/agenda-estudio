import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import path from 'path';
import { config } from './config';
import { errorHandler } from './middleware/errorHandler';

// Route modules
import authRoutes from './modules/auth/routes';
import bookingRoutes from './modules/bookings/routes';
import contractRoutes from './modules/contracts/routes';
import userRoutes from './modules/users/routes';
import blockedSlotRoutes from './modules/blocked-slots/routes';
import pricingRoutes from './modules/pricing/routes';
import paymentRoutes from './modules/payments/routes';
import { financeRouter } from './modules/finance/routes';
import notificationRoutes from './modules/notifications/routes';
import reportRoutes from './modules/reports/routes';
import integrationRoutes from './modules/integrations/routes';
import webhookRoutes from './modules/webhooks/routes';
import stripeRoutes from './modules/stripe/routes';
import pushRoutes from './modules/push/routes';

import { prisma } from './lib/prisma';


const app = express();

// ─── Middleware ──────────────────────────────────────────

// ─── Security ───────────────────────────────────────────

app.use(helmet({
    contentSecurityPolicy: config.nodeEnv === 'production' ? undefined : false,
    crossOriginEmbedderPolicy: false,
}));

app.use(cors({
    origin: config.frontendUrl,
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
        env: config.nodeEnv,
    });
});

// ─── Routes ─────────────────────────────────────────────

app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/auth/otp', otpLimiter);
app.use('/api/auth/register/send-code', otpLimiter);
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

app.listen(config.port, () => {
    console.log(`🎙️  Studio Scheduler API running on http://localhost:${config.port}`);
    console.log(`   Environment: ${config.nodeEnv}`);

    // Phase 2 Auto-Completion Cronjob
    // This runs on startup and every 5 minutes, flagging past-due events as COMPLETED.
    // Uses Redis lock to prevent duplicate execution across multiple instances.
    const { redis } = require('./lib/redis');

    const runCron = async () => {
        const lockKey = 'cron:auto-complete:lock';
        const lockAcquired = await redis.set(lockKey, 'running', 'EX', 240, 'NX');
        if (lockAcquired !== 'OK') return; // Another instance is running this job

        try {
            console.log(`[Cron] Checking for finished bookings to auto-complete...`);
            const now = new Date();
            const bookings = await prisma.booking.findMany({
                where: { status: { in: ['CONFIRMED', 'RESERVED'] } }
            });

            const toComplete = bookings.filter(b => {
                const [h, m] = b.endTime.split(':').map(Number);
                const endDateTime = new Date(b.date);
                endDateTime.setUTCHours(h, m, 0, 0);
                return endDateTime.getTime() < now.getTime();
            });

            if (toComplete.length > 0) {
                const updated = await prisma.booking.updateMany({
                    where: { id: { in: toComplete.map(x => x.id) } },
                    data: { status: 'COMPLETED' }
                });
                console.log(`[Cron] Auto-completed ${updated.count} bookings.`);
            }
        } catch (err) {
            console.error(`[Cron Error] Failed to process auto-completions:`, err);
        } finally {
            await redis.del(lockKey);
        }
    };

    setInterval(runCron, 5 * 60 * 1000);

    // Hold Expiration Cronjob — clean expired HELD bookings & AWAITING_PAYMENT contracts every 60s
    import('./jobs/cleanExpiredHolds').then(({ cleanExpiredHolds }) => {
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

    // Push Notification Cronjob — checks & sends push every 15 minutes
    import('./jobs/pushNotificationJob').then(({ runPushNotificationJob }) => {
        const runPushJob = async () => {
            const pushLockKey = 'cron:push-notif:lock';
            const lockAcquired = await redis.set(pushLockKey, 'running', 'EX', 840, 'NX');
            if (lockAcquired !== 'OK') return;
            try {
                await runPushNotificationJob();
            } finally {
                await redis.del(pushLockKey);
            }
        };
        setInterval(runPushJob, 15 * 60 * 1000);
        console.log('   📱 Push notification job registered (every 15min)');
    }).catch(err => console.error('[PUSH-JOB] Failed to load:', err));
});

export default app;

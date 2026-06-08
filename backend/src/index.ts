import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
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
import ambientRoutes from './modules/ambient/routes.js';
import paymentRoutes from './modules/payments/routes.js';
import { financeRouter } from './modules/finance/routes.js';
import notificationRoutes from './modules/notifications/routes.js';
import reportRoutes from './modules/reports/routes.js';
import integrationRoutes from './modules/integrations/routes.js';
import webhookRoutes from './modules/webhooks/routes.js';
import stripeRoutes from './modules/stripe/routes.js';
import pushRoutes from './modules/push/routes.js';

import { prisma } from './lib/prisma.js';
import { redis } from './lib/redis.js';


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
            scriptSrc: ["'self'", "https://js.stripe.com", "https://accounts.google.com"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://accounts.google.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            imgSrc: ["'self'", "data:", "blob:", "https://buzios.digital", "https://app.buzios.digital", "https://*.stripe.com", "https://*.googleusercontent.com"],
            connectSrc: ["'self'", "https://app.buzios.digital", "https://*.stripe.com", "https://matls-clients.api.cora.com.br", "https://accounts.google.com", "https://oauth2.googleapis.com"],
            frameSrc: ["'self'", "https://js.stripe.com", "https://*.stripe.com", "https://accounts.google.com"],
        },
    } : false,
    crossOriginEmbedderPolicy: false,
    // OAuth popups (Google login) need the opener relationship preserved. The
    // Helmet default ('same-origin') severs window.opener, so the popup can't
    // return the token and login silently fails.
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
}));

// CORS: accept FRONTEND_URL and production domain
const allowedOrigins = [
    config.frontendUrl,
    'https://app.buzios.digital',
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
// Backed by Redis so limits are enforced GLOBALLY across all app instances (an in-memory store
// would let an attacker bypass limits by spreading requests across instances). Each limiter gets
// its own key prefix. The app already hard-depends on Redis (locks, OTP), so this adds no new
// single point of failure.

const rlStore = (prefix: string) => new RedisStore({
    // ioredis: forward the raw command to the shared client.
    sendCommand: (...args: string[]) => (redis as unknown as { call: (...a: string[]) => Promise<unknown> }).call(...args) as Promise<never>,
    prefix,
});

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 15,
    store: rlStore('rl:auth:'),
    message: { error: 'Muitas tentativas. Tente novamente em 15 minutos.' },
    standardHeaders: true,
    legacyHeaders: false,
});

const otpLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    store: rlStore('rl:otp:'),
    message: { error: 'Muitos códigos solicitados. Aguarde 15 minutos.' },
    standardHeaders: true,
    legacyHeaders: false,
});

const apiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 300,
    store: rlStore('rl:api:'),
    message: { error: 'Requisições excessivas. Aguarde 1 minuto.' },
    standardHeaders: true,
    legacyHeaders: false,
});

// PAY-04 FIX: Stricter limiter for financial endpoints
const paymentLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 20, // max 20 payment operations in 15 min per IP
    store: rlStore('rl:pay:'),
    message: { error: 'Muitas tentativas de pagamento. Aguarde 15 minutos.' },
    standardHeaders: true,
    legacyHeaders: false,
});

// Refresh-token endpoint limiter (was unprotected) — modest cap to blunt token-grind attempts.
const refreshLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 60,
    store: rlStore('rl:refresh:'),
    message: { error: 'Muitas tentativas. Aguarde alguns minutos.' },
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
app.use('/api/auth/refresh', refreshLimiter);
app.use('/api/auth/otp', otpLimiter);
app.use('/api/auth/register/send-code', otpLimiter);
app.use('/api/stripe/create-payment', paymentLimiter);
app.use('/api/stripe/verify-payment', paymentLimiter);
// VULN-H1 FIX: Rate limit ALL financial endpoints
app.use('/api/contracts/:id/pay', paymentLimiter);
app.use('/api/contracts/:id/confirm-payment', paymentLimiter);
app.use('/api/contracts/:id/subscribe', paymentLimiter);
app.use('/api/contracts/:id/client-renew', paymentLimiter);
app.use('/api/bookings/:id/complete-payment', paymentLimiter);
app.use('/api', apiLimiter);

app.use('/api/auth', authRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/contracts', contractRoutes);
app.use('/api/users', userRoutes);
app.use('/api/blocked-slots', blockedSlotRoutes);
app.use('/api/pricing', pricingRoutes);
app.use('/api/ambient', ambientRoutes);
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

    // Loud, visible warning if the OTP dev-bypass flag is enabled — it must NEVER be on outside dev
    // (it's already double-gated by NODE_ENV !== 'production', but a silent flag is easy to miss).
    if (process.env.ALLOW_OTP_BYPASS === 'true') {
        console.warn(`⚠️  [SECURITY] OTP bypass (code 999999) is ENABLED (env ALLOW_OTP_BYPASS=true) in ${config.nodeEnv}. Remove it for any non-development environment.`);
    }
    if (config.jwt.secret === 'dev-secret' || config.jwt.refreshSecret === 'dev-refresh-secret') {
        console.warn('⚠️  [SECURITY] Using the DEFAULT dev JWT secret(s) — set JWT_SECRET and JWT_REFRESH_SECRET. (Production startup already hard-requires them; this guards misconfigured non-prod envs.)');
    }

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

    // FLEX Credit Expiry Cronjob — forfeits weekly credits when a window closes behind pace
    import('./jobs/flexCreditExpiryJob.js').then(({ runFlexCreditExpiryJob }) => {
        const runFlexExpiry = async () => {
            const lockKey = 'cron:flex-credit-expiry:lock';
            const lockAcquired = await redis.set(lockKey, 'running', 'EX', 1500, 'NX');
            if (lockAcquired !== 'OK') return;
            try {
                await runFlexCreditExpiryJob();
            } finally {
                await redis.del(lockKey);
            }
        };
        setInterval(runFlexExpiry, 6 * 60 * 60 * 1000); // every 6h
        setTimeout(runFlexExpiry, 8000); // run once on boot
        console.log('   🎟️ FLEX credit expiry job registered (every 6h)');
    }).catch(err => console.error('[FLEX-EXPIRY] Failed to load:', err));

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

    // Cora Reconciliation Cronjob — confirm paid PIX/Boleto whose webhook was missed (every 2min)
    import('./lib/coraReconciliation.js').then(({ reconcilePendingCoraPayments }) => {
        const runReconcile = async () => {
            const lockKey = 'cron:cora-reconcile:lock';
            const lockAcquired = await redis.set(lockKey, 'running', 'EX', 110, 'NX');
            if (lockAcquired !== 'OK') return;
            try {
                await reconcilePendingCoraPayments();
            } finally {
                await redis.del(lockKey);
            }
        };
        setInterval(runReconcile, 2 * 60 * 1000);
        setTimeout(runReconcile, 15000); // run once shortly after boot
        console.log('   💸 Cora reconciliation job registered (every 2min)');
    }).catch(err => console.error('[CORA-RECONCILE] Failed to load:', err));

    // Auto-Charge Cronjob — charges saved cards off-session for due installments (daily)
    import('./jobs/autoChargeJob.js').then(({ runAutoChargeJob }) => {
        const runAutoCharge = async () => {
            const lockKey = 'cron:auto-charge:lock';
            const lockAcquired = await redis.set(lockKey, 'running', 'EX', 1800, 'NX');
            if (lockAcquired !== 'OK') return;
            try {
                await runAutoChargeJob();
            } finally {
                await redis.del(lockKey);
            }
        };
        setInterval(runAutoCharge, 24 * 60 * 60 * 1000); // daily
        setTimeout(runAutoCharge, 20000); // run once shortly after boot
        console.log('   💳 Auto-charge job registered (daily)');
    }).catch(err => console.error('[AUTO-CHARGE] Failed to load:', err));

    // Daily Confirmation Cronjob — at 07:00 (São Paulo), notifies clients about the day's
    // recording: paid ⇒ "confirmada", not paid ⇒ "pague para confirmar". Runs hourly; the
    // job itself only acts at 7am SP and guards a once-per-day Redis marker.
    import('./jobs/dailyConfirmationJob.js').then(({ runDailyConfirmationJob }) => {
        const runDailyConfirm = async () => {
            const lockKey = 'cron:daily-confirm:lock';
            const lockAcquired = await redis.set(lockKey, 'running', 'EX', 280, 'NX');
            if (lockAcquired !== 'OK') return;
            try {
                await runDailyConfirmationJob();
            } finally {
                await redis.del(lockKey);
            }
        };
        setInterval(runDailyConfirm, 30 * 60 * 1000); // every 30min (acts only at 7am SP)
        setTimeout(runDailyConfirm, 25000); // check shortly after boot
        console.log('   🌅 Daily confirmation job registered (every 30min, fires at 7am SP)');
    }).catch(err => console.error('[DAILY-CONFIRM] Failed to load:', err));
});

export default app;

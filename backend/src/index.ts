import express from 'express';
import cors from 'cors';
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

import { prisma } from './lib/prisma';


const app = express();

// ─── Middleware ──────────────────────────────────────────

app.use(cors({
    origin: config.frontendUrl,
    credentials: true,
}));

// Stripe webhooks need the raw body for signature verification.
// Use express.raw() for the webhook path, express.json() for everything else.
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

app.use('/api/auth', authRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/contracts', contractRoutes);
app.use('/api/users', userRoutes);
app.use('/api/blocked-slots', blockedSlotRoutes);
app.use('/api/pricing', pricingRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/finance', financeRouter);

import notificationRoutes from './modules/notifications/routes';
app.use('/api/notifications', notificationRoutes);

import reportRoutes from './modules/reports/routes';
app.use('/api/reports', reportRoutes);

import integrationRoutes from './modules/integrations/routes';
app.use('/api/integrations', integrationRoutes);

import webhookRoutes from './modules/webhooks/routes';
app.use('/api/webhooks', webhookRoutes);

import stripeRoutes from './modules/stripe/routes';
app.use('/api/stripe', stripeRoutes);

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
    const runCron = async () => {
        try {
            console.log(`[Cron] Checking for finished bookings to auto-complete...`);
            const now = new Date();
            const bookings = await prisma.booking.findMany({
                where: { status: { in: ['CONFIRMED', 'RESERVED'] } }
            });

            const toComplete = bookings.filter(b => {
                const [h, m] = b.endTime.split(':').map(Number);
                const endDateTime = new Date(b.date);
                endDateTime.setUTCHours(h, m, 0, 0); // Event timezone
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
        }
    };

    // runCron(); // Temporarily disabled on startup to prevent sync block on typescript compilation errors during dev
    setInterval(runCron, 5 * 60 * 1000);

    // Hold Expiration Cronjob — clean expired HELD bookings & AWAITING_PAYMENT contracts every 60s
    import('./jobs/cleanExpiredHolds').then(({ cleanExpiredHolds }) => {
        setInterval(cleanExpiredHolds, 60 * 1000);
        console.log('   ⏰ Hold cleanup job registered (every 60s)');
    }).catch(err => console.error('[HOLD-CLEANUP] Failed to load job:', err));
});

export default app;

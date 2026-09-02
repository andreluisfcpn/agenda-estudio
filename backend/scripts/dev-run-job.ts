/**
 * Dev-only manual trigger for the background jobs that normally fire on setInterval.
 * There is no clock injection in the app, so time-dependent flows are tested by
 * BACKDATING the relevant DB date columns (snake_case) and then running the job here.
 *
 *   npx tsx scripts/dev-run-job.ts <job> [arg]
 *
 * Jobs:
 *   holds            cleanExpiredHolds        (hold_expires_at / payment_deadline sweep, 60s cron)
 *   autocharge       runAutoChargeJob         (charge saved cards for due_date <= today, daily cron)
 *   flex             runFlexCreditExpiryJob   (forfeit FLEX credits per closed 7d window, 6h cron)
 *   reminders        runBookingReminderJob    (24h / 2h session reminders, 30min cron)
 *   push             runPushNotificationJob   (overdue + expiring-soon notifications, 5min cron)
 *   daily-confirm    runDailyConfirmationJob  (07:00 SP daily confirmations; pass a YYYY-MM-DD to force a date)
 *   notif-cleanup    runNotificationCleanupJob(delete old notifications, daily cron)
 *   cora-reconcile   reconcilePendingCoraPayments   (2min cron)
 *   sicoob-reconcile reconcilePendingSicoobPayments (2min cron)
 *
 * NOTE: jobs are the exact production code the crons run — safe, idempotent, Redis-locked.
 */
import 'dotenv/config'; // loads backend/.env (run from the backend/ dir) before prisma/redis init

const JOBS: Record<string, () => Promise<unknown>> = {
    holds: async () => (await import('../src/jobs/cleanExpiredHolds.js')).cleanExpiredHolds(),
    autocharge: async () => (await import('../src/jobs/autoChargeJob.js')).runAutoChargeJob(),
    flex: async () => (await import('../src/jobs/flexCreditExpiryJob.js')).runFlexCreditExpiryJob(),
    reminders: async () => (await import('../src/jobs/bookingReminderJob.js')).runBookingReminderJob(),
    push: async () => (await import('../src/jobs/pushNotificationJob.js')).runPushNotificationJob(),
    'daily-confirm': async () => {
        const { runDailyConfirmationJob } = await import('../src/jobs/dailyConfirmationJob.js');
        const forceDate = process.argv[3];
        return runDailyConfirmationJob({ force: true, ...(forceDate ? { forceDate } : {}) });
    },
    'notif-cleanup': async () => (await import('../src/jobs/notificationCleanupJob.js')).runNotificationCleanupJob(),
    'cora-reconcile': async () => (await import('../src/lib/coraReconciliation.js')).reconcilePendingCoraPayments(),
    'sicoob-reconcile': async () => (await import('../src/lib/sicoobReconciliation.js')).reconcilePendingSicoobPayments(),
};

async function main() {
    const name = process.argv[2];
    if (!name || !JOBS[name]) {
        console.error(`Usage: npx tsx scripts/dev-run-job.ts <job> [arg]\nJobs: ${Object.keys(JOBS).join(', ')}`);
        process.exit(1);
    }
    console.log(`[dev-run-job] running "${name}" at ${new Date().toISOString()} ...`);
    const result = await JOBS[name]();
    console.log(`[dev-run-job] "${name}" done.`, result !== undefined ? `→ ${JSON.stringify(result)}` : '');
    // Jobs open Redis/Prisma handles; force exit so the script doesn't hang.
    process.exit(0);
}

main().catch(err => {
    console.error('[dev-run-job] failed:', err);
    process.exit(1);
});

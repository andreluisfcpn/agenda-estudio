/**
 * ─── Test-data cleanup ──────────────────────────────────────────────────────
 * Wipes transactional TEST data (contracts, bookings, payments, notifications and
 * the audit rows that reference them) while PRESERVING:
 *   - all User accounts (admin + test clients) so the app stays usable
 *   - all configuration (pricing, add-ons, business config, payment-method config,
 *     integration configs)
 *   - saved payment methods & push subscriptions (account artifacts, harmless)
 *
 * Safety:
 *   - DRY-RUN by default: prints counts and exits without touching anything.
 *   - Pass `--apply` to actually delete. Before deleting it writes a full JSON
 *     backup of everything it will remove to backend/backups/cleanup-<runId>.json.
 *   - Deletes in FK-safe order inside a single transaction (all-or-nothing).
 *
 * Usage (against the target DB whose DATABASE_URL is in the environment):
 *   npx tsx backend/src/scripts/cleanupTestData.ts            # dry-run (counts only)
 *   npx tsx backend/src/scripts/cleanupTestData.ts --apply    # perform the deletion
 *
 * To run against the Railway production DB without exposing the URL locally:
 *   railway run --service agenda-app npx tsx backend/src/scripts/cleanupTestData.ts --apply
 */

import { prisma } from '../lib/prisma.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const APPLY = process.argv.includes('--apply');
// A stable run id without Date.now()/Math.random (kept deterministic & dependency-free).
const runId = new Date().toISOString().replace(/[:.]/g, '-');

async function main() {
    console.log(`\n=== Test-data cleanup (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);

    // ── Snapshot counts of what will be removed vs preserved ──
    const [
        payments, bookings, contracts, notifications, auditLogs,
        users, pricing, addons, businessConfig, paymentMethodConfig, integrations,
        savedPm, pushSubs, blockedSlots,
    ] = await Promise.all([
        prisma.payment.count(),
        prisma.booking.count(),
        prisma.contract.count(),
        prisma.notification.count(),
        prisma.auditLog.count(),
        prisma.user.count(),
        prisma.pricingConfig.count(),
        prisma.addOnConfig.count(),
        prisma.businessConfig.count(),
        prisma.paymentMethodConfig.count(),
        prisma.integrationConfig.count(),
        prisma.savedPaymentMethod.count(),
        prisma.pushSubscription.count(),
        prisma.blockedSlot.count(),
    ]);

    console.log('WILL DELETE:');
    console.log(`  payments .............. ${payments}`);
    console.log(`  bookings .............. ${bookings}`);
    console.log(`  contracts ............. ${contracts}`);
    console.log(`  notifications ......... ${notifications}`);
    console.log(`  audit_logs ............ ${auditLogs}`);
    console.log('\nWILL PRESERVE:');
    console.log(`  users ................. ${users}`);
    console.log(`  pricing_config ........ ${pricing}`);
    console.log(`  addon_config .......... ${addons}`);
    console.log(`  business_config ....... ${businessConfig}`);
    console.log(`  payment_method_config . ${paymentMethodConfig}`);
    console.log(`  integration_configs ... ${integrations}`);
    console.log(`  saved_payment_methods . ${savedPm}`);
    console.log(`  push_subscriptions .... ${pushSubs}`);
    console.log(`  blocked_slots ......... ${blockedSlots}`);

    if (!APPLY) {
        console.log('\n(DRY-RUN) Nothing was deleted. Re-run with --apply to perform the cleanup.\n');
        return;
    }

    // ── Backup everything we will delete ──
    const [paymentRows, bookingRows, contractRows, notificationRows] = await Promise.all([
        prisma.payment.findMany(),
        prisma.booking.findMany(),
        prisma.contract.findMany(),
        prisma.notification.findMany(),
    ]);
    const auditRows = await prisma.auditLog.findMany({
        where: { entityType: { in: ['CONTRACT', 'BOOKING', 'PAYMENT'] } },
    });

    const here = dirname(fileURLToPath(import.meta.url));
    const backupDir = join(here, '..', '..', 'backups');
    mkdirSync(backupDir, { recursive: true });
    const backupPath = join(backupDir, `cleanup-${runId}.json`);
    writeFileSync(
        backupPath,
        JSON.stringify(
            { runId, payments: paymentRows, bookings: bookingRows, contracts: contractRows, notifications: notificationRows, auditLogs: auditRows },
            null,
            2,
        ),
    );
    console.log(`\nBackup written to: ${backupPath}`);

    // ── Delete in FK-safe order, all-or-nothing ──
    const result = await prisma.$transaction(async (tx) => {
        const delPayments = await tx.payment.deleteMany({});
        const delBookings = await tx.booking.deleteMany({});
        const delContracts = await tx.contract.deleteMany({});
        const delNotifications = await tx.notification.deleteMany({});
        const delAudit = await tx.auditLog.deleteMany({
            where: { entityType: { in: ['CONTRACT', 'BOOKING', 'PAYMENT'] } },
        });
        return { delPayments, delBookings, delContracts, delNotifications, delAudit };
    });

    console.log('\nDELETED:');
    console.log(`  payments .............. ${result.delPayments.count}`);
    console.log(`  bookings .............. ${result.delBookings.count}`);
    console.log(`  contracts ............. ${result.delContracts.count}`);
    console.log(`  notifications ......... ${result.delNotifications.count}`);
    console.log(`  audit_logs ............ ${result.delAudit.count}`);
    console.log('\n✅ Cleanup complete. Users and configuration preserved.\n');
}

main()
    .catch((e) => {
        console.error('[cleanupTestData] FAILED:', e);
        process.exitCode = 1;
    })
    .finally(async () => {
        await prisma.$disconnect();
    });

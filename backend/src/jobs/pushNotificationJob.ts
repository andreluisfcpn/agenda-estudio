import { prisma } from '../lib/prisma.js';
import { saoPauloParts } from '../lib/spTime.js';
import { notifyEvent } from '../modules/notifications/notificationService.js';

/**
 * Push Notification Job — runs every 5 minutes.
 * Delivers (push + persist) the SAME computed rule set that GET /notifications
 * shows, using the shared event catalog/templates (single source of truth). It
 * emits the deliverable subset: overdue (aggregated), today's unconfirmed
 * sessions (admin), and expiring contracts.
 *
 * De-noised vs the pre-rodada-5 version:
 *  - the "≤2 FLEX credits" info push was removed (it fired every poll and the
 *    jun/2026 prune already dropped that signal from the bell);
 *  - the client/admin "tomorrow unconfirmed" push was dropped — tomorrow is
 *    already covered by the 24h bookingReminderJob, and the GET computed rule
 *    is today-only. Push and bell now show exactly the same set.
 */
const fmtBRL = (cents: number) => `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;

interface PendingEvent {
    eventKey: string;
    vars: Record<string, string | number>;
    entityType: string;
    entityId: string;
    severityOverride?: 'critical' | 'warning' | 'info';
    dedupKey?: string;
}

export async function runPushNotificationJob(): Promise<void> {
    const now = new Date();
    // São Paulo calendar day as 00:00Z (matches @db.Date + keeps day windows/labels correct
    // after 21:00 SP, when the UTC date has already rolled over to tomorrow).
    const sp = saoPauloParts(now);
    const today = new Date(Date.UTC(sp.y, sp.m - 1, sp.day));

    const usersWithSubs = await prisma.pushSubscription.findMany({
        select: { userId: true },
        distinct: ['userId'],
    });
    if (usersWithSubs.length === 0) return;

    let totalSent = 0;
    for (const { userId } of usersWithSubs) {
        try {
            const events = await computeUserEvents(userId, today);
            for (const e of events) {
                try {
                    // notifyEvent resolves the (admin-editable) template, respects enabled,
                    // dedups and pushes. entityId matches the GET computed id so the two
                    // never show as duplicates.
                    const id = await notifyEvent(e.eventKey, {
                        userId,
                        vars: e.vars,
                        entityType: e.entityType,
                        entityId: e.entityId,
                        severityOverride: e.severityOverride,
                        dedupKey: e.dedupKey,
                    });
                    if (id) totalSent++;
                } catch { /* dedup or other error — skip silently */ }
            }
        } catch (err) {
            console.error(`[PUSH-JOB] Error processing user ${userId}:`, err);
        }
    }

    if (totalSent > 0) {
        console.log(`[PUSH-JOB] Processed ${totalSent} push notifications.`);
    }
}

/** Compute the events to deliver for a specific user (mirrors GET computed rules). */
async function computeUserEvents(userId: string, today: Date): Promise<PendingEvent[]> {
    const events: PendingEvent[] = [];
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
    if (!user) return events;

    const isAdmin = user.role === 'ADMIN';
    const thresholdDays = isAdmin ? 7 : 15;
    const targetDate = new Date(today);
    targetDate.setDate(targetDate.getDate() + thresholdDays);
    const daysOverdue = (p: { dueDate: Date | null }) => Math.ceil((today.getTime() - new Date(p.dueDate!).getTime()) / (1000 * 60 * 60 * 24));

    // ── Overdue payments — AGGREGATED (B1) ──
    const overduePayments = await prisma.payment.findMany({
        where: { status: 'PENDING', dueDate: { lt: today }, ...(isAdmin ? {} : { userId }) },
        include: { user: { select: { name: true } } },
    });
    if (isAdmin) {
        const byClient = new Map<string, { name: string; count: number; total: number; maxDays: number }>();
        for (const p of overduePayments) {
            const g = byClient.get(p.userId) ?? { name: p.user.name, count: 0, total: 0, maxDays: 0 };
            g.count++; g.total += p.amount; g.maxDays = Math.max(g.maxDays, daysOverdue(p));
            byClient.set(p.userId, g);
        }
        for (const [clientId, g] of byClient) {
            events.push({
                eventKey: 'computed_payment_overdue_admin',
                vars: { cliente: g.name, quantidade: g.count, total: fmtBRL(g.total), diasMax: g.maxDays },
                entityType: 'PAYMENT', entityId: clientId,
                severityOverride: g.maxDays > 7 ? 'critical' : 'warning',
            });
        }
    } else if (overduePayments.length > 0) {
        let total = 0, maxDays = 0;
        for (const p of overduePayments) { total += p.amount; maxDays = Math.max(maxDays, daysOverdue(p)); }
        events.push({
            eventKey: 'computed_payment_overdue',
            vars: { quantidade: overduePayments.length, total: fmtBRL(total), diasMax: maxDays },
            entityType: 'PAYMENT', entityId: 'agg',
            severityOverride: maxDays > 7 ? 'critical' : 'warning',
            // count in the key → a newly-due invoice re-pushes; same count is deduped.
            dedupKey: `overdue-agg:${userId}:${overduePayments.length}`,
        });
    }

    // ── Unconfirmed sessions — TODAY, ADMIN only (mirrors GET computed) ──
    if (isAdmin) {
        const tomorrow = new Date(today.getTime() + 86_400_000);
        const unconfirmed = await prisma.booking.findMany({
            where: { status: 'RESERVED', date: { gte: today, lt: tomorrow } },
            include: { user: { select: { name: true } } },
            take: 10,
        });
        for (const b of unconfirmed) {
            events.push({
                eventKey: 'computed_booking_unconfirmed_admin',
                vars: { cliente: b.user.name, hora: b.startTime, diaLabel: 'hoje' },
                entityType: 'BOOKING', entityId: b.id,
                severityOverride: 'critical',
            });
        }
    }

    // ── Expiring contracts ──
    const expiringContracts = await prisma.contract.findMany({
        where: { status: 'ACTIVE', endDate: { gte: today, lte: targetDate }, ...(isAdmin ? {} : { userId }) },
        include: { user: { select: { name: true } } },
        take: 3,
    });
    for (const c of expiringContracts) {
        const dias = Math.ceil((new Date(c.endDate).getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
        const vars: Record<string, string | number> = isAdmin ? { cliente: c.user.name, contrato: c.name, dias } : { contrato: c.name, dias };
        events.push({
            eventKey: isAdmin ? 'computed_contract_expiring_admin' : 'computed_contract_expiring',
            vars, entityType: 'CONTRACT', entityId: c.id,
            severityOverride: dias <= 2 ? 'critical' : 'warning',
        });
    }

    return events;
}

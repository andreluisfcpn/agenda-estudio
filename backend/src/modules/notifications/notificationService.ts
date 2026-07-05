import { prisma } from '../../lib/prisma.js';
import { redis } from '../../lib/redis.js';
import { sendPushToUser, PushPayload } from '../push/pushService.js';
import { NotificationType } from '../../generated/prisma/client.js';
import { getEffectiveEvent, renderTemplate } from './templateStore.js';

export interface CreateNotificationInput {
    userId: string;
    type: NotificationType;
    severity: 'critical' | 'warning' | 'info';
    title: string;
    message: string;
    entityType?: string;
    entityId?: string;
    actionUrl?: string;
    sendPush?: boolean; // default: true for critical/warning
    dedupKey?: string;  // override the default userId+type+entityId dedup identity
}

/**
 * Create a notification in DB and optionally send push immediately.
 * Uses Redis dedup to avoid spamming the same notification.
 */
export async function createNotification(input: CreateNotificationInput): Promise<string> {
    const { userId, type, severity, title, message, entityType, entityId, actionUrl } = input;
    const shouldPush = input.sendPush ?? (severity === 'critical' || severity === 'warning');

    // Respect the client's "essential only" preference: drop non-critical notifications
    // (no in-app, no push). Critical ones (payments, credit loss) always go through.
    if (severity !== 'critical') {
        const pref = await prisma.user.findUnique({
            where: { id: userId },
            select: { essentialNotificationsOnly: true },
        });
        if (pref?.essentialNotificationsOnly) return '';
    }

    // Dedup key: same type + entity within a window (or a caller-provided identity)
    const dedupKey = input.dedupKey
        ? `notif:dedup:${input.dedupKey}`
        : `notif:dedup:${userId}:${type}:${entityId || 'global'}`;
    const alreadyExists = await redis.get(dedupKey);
    if (alreadyExists) return alreadyExists; // return existing notification ID

    const notification = await prisma.notification.create({
        data: { userId, type, severity, title, message, entityType, entityId, actionUrl },
    });

    // Set dedup window based on severity
    const ttl = severity === 'critical' ? 6 * 3600 : severity === 'warning' ? 24 * 3600 : 72 * 3600;
    await redis.set(dedupKey, notification.id, 'EX', ttl);

    // Send push immediately
    if (shouldPush) {
        try {
            const payload: PushPayload = { title, message, tag: `${type}-${entityId || notification.id}`, actionUrl, severity };
            const sent = await sendPushToUser(userId, payload);
            if (sent > 0) {
                await prisma.notification.update({
                    where: { id: notification.id },
                    data: { pushSent: true },
                });
            }
        } catch (err) {
            console.error(`[NOTIF-SERVICE] Push failed for ${userId}:`, err);
        }
    }

    return notification.id;
}

export interface NotifyEventOptions {
    userId: string;
    vars?: Record<string, string | number>;
    entityType?: string;
    entityId?: string;
    actionUrl?: string;                                    // overrides the catalog default
    severityOverride?: 'critical' | 'warning' | 'info';    // for 'dynamic' events
    dedupKey?: string;
    sendPush?: boolean;                                    // last-resort override (rare)
}

/**
 * Emit a notification by EVENT KEY. Resolves the effective template (admin
 * overrides over the code catalog), respects the per-event enabled flag, and
 * interpolates {vars} before delegating to createNotification (dedup / essential
 * pref / push all unchanged). A disabled event is skipped BEFORE the dedup write,
 * so re-enabling it resumes immediately. An unknown eventKey is logged, not thrown.
 */
export async function notifyEvent(eventKey: string, opts: NotifyEventOptions): Promise<string> {
    const eff = await getEffectiveEvent(eventKey);
    if (!eff) {
        console.error(`[NOTIF] Unknown eventKey "${eventKey}" — notification skipped.`);
        return '';
    }
    if (!eff.enabled) return '';

    // 'dynamic' in the catalog means the caller decides; an admin who pins a fixed
    // severity (eff.severity !== 'dynamic') overrides that choice.
    const severity: 'critical' | 'warning' | 'info' =
        eff.severity !== 'dynamic'
            ? eff.severity
            : (opts.severityOverride ?? 'warning');

    return createNotification({
        userId: opts.userId,
        type: eff.def.type,
        severity,
        title: renderTemplate(eff.title, opts.vars),
        message: renderTemplate(eff.message, opts.vars),
        entityType: opts.entityType,
        entityId: opts.entityId,
        actionUrl: opts.actionUrl ?? eff.def.actionUrl,
        sendPush: opts.sendPush ?? eff.pushEnabled,
        dedupKey: opts.dedupKey,
    });
}

/** Create multiple notifications in batch. */
export async function createBulkNotifications(inputs: CreateNotificationInput[]): Promise<number> {
    let created = 0;
    for (const input of inputs) {
        try {
            await createNotification(input);
            created++;
        } catch (err) {
            console.error(`[NOTIF-SERVICE] Bulk create failed for ${input.userId}:`, err);
        }
    }
    return created;
}

/** Mark a single notification as read. */
export async function markAsRead(userId: string, notificationId: string): Promise<boolean> {
    const result = await prisma.notification.updateMany({
        where: { id: notificationId, userId },
        data: { read: true },
    });
    return result.count > 0;
}

/** Mark all notifications as read for a user. */
export async function markAllAsRead(userId: string): Promise<number> {
    const result = await prisma.notification.updateMany({
        where: { userId, read: false },
        data: { read: true },
    });
    return result.count;
}

/** Delete a notification (only by owner). */
export async function deleteNotification(userId: string, notificationId: string): Promise<boolean> {
    const result = await prisma.notification.deleteMany({
        where: { id: notificationId, userId },
    });
    return result.count > 0;
}

/** Get persisted notifications for a user. */
export async function getUserNotifications(userId: string, limit = 50) {
    return prisma.notification.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: limit,
    });
}

// Day-of / recurring signals that go stale fast: the session already happened,
// or the push job re-derives the current state every 5 min. Keeping them for the
// generic 30/90-day window left "Sessão em 2 horas!" lingering days later (B2).
const EPHEMERAL_TYPES = ['BOOKING_REMINDER', 'BOOKING_CONFIRMED', 'BOOKING_UNCONFIRMED', 'PAYMENT_OVERDUE'] as const;
const EPHEMERAL_MAX_AGE_MS = 48 * 3600 * 1000;

/** Delete old notifications (cleanup job). */
export async function cleanupOldNotifications(): Promise<{ readDeleted: number; unreadDeleted: number; ephemeralDeleted: number }> {
    const now = new Date();

    const readCutoff = new Date(now);
    readCutoff.setDate(readCutoff.getDate() - 30);

    const unreadCutoff = new Date(now);
    unreadCutoff.setDate(unreadCutoff.getDate() - 90);

    const readResult = await prisma.notification.deleteMany({
        where: { read: true, createdAt: { lt: readCutoff } },
    });

    const unreadResult = await prisma.notification.deleteMany({
        where: { read: false, createdAt: { lt: unreadCutoff } },
    });

    // Ephemeral types: purge after 48h regardless of read state.
    const ephemeralResult = await prisma.notification.deleteMany({
        where: {
            type: { in: EPHEMERAL_TYPES as unknown as NotificationType[] },
            createdAt: { lt: new Date(now.getTime() - EPHEMERAL_MAX_AGE_MS) },
        },
    });

    return { readDeleted: readResult.count, unreadDeleted: unreadResult.count, ephemeralDeleted: ephemeralResult.count };
}

import { prisma } from '../../lib/prisma.js';
import { redis } from '../../lib/redis.js';
import { sendPushToUser, PushPayload } from '../push/pushService.js';
import { NotificationType } from '../../generated/prisma/client.js';

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
}

/**
 * Create a notification in DB and optionally send push immediately.
 * Uses Redis dedup to avoid spamming the same notification.
 */
export async function createNotification(input: CreateNotificationInput): Promise<string> {
    const { userId, type, severity, title, message, entityType, entityId, actionUrl } = input;
    const shouldPush = input.sendPush ?? (severity === 'critical' || severity === 'warning');

    // Dedup key: same type + entity within a window
    const dedupKey = `notif:dedup:${userId}:${type}:${entityId || 'global'}`;
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

/** Delete old notifications (cleanup job). */
export async function cleanupOldNotifications(): Promise<{ readDeleted: number; unreadDeleted: number }> {
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

    return { readDeleted: readResult.count, unreadDeleted: unreadResult.count };
}

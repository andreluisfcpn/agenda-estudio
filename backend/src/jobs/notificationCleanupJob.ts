import { cleanupOldNotifications } from '../modules/notifications/notificationService.js';

/**
 * Notification Cleanup Job — runs daily.
 * Removes read notifications older than 30 days and unread older than 90 days.
 */
export async function runNotificationCleanupJob(): Promise<void> {
    try {
        const { readDeleted, unreadDeleted } = await cleanupOldNotifications();
        const total = readDeleted + unreadDeleted;
        if (total > 0) {
            console.log(`[NOTIF-CLEANUP] Cleaned ${readDeleted} read + ${unreadDeleted} unread notifications.`);
        }
    } catch (err) {
        console.error('[NOTIF-CLEANUP] Failed:', err);
    }
}

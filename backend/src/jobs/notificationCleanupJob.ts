import { cleanupOldNotifications } from '../modules/notifications/notificationService.js';

/**
 * Notification Cleanup Job — runs daily.
 * Removes read notifications older than 30 days, unread older than 90 days, and
 * ephemeral day-of/recurring types (reminders, day confirmations, overdue) older
 * than 48h regardless of read state.
 */
export async function runNotificationCleanupJob(): Promise<void> {
    try {
        const { readDeleted, unreadDeleted, ephemeralDeleted } = await cleanupOldNotifications();
        const total = readDeleted + unreadDeleted + ephemeralDeleted;
        if (total > 0) {
            console.log(`[NOTIF-CLEANUP] Cleaned ${readDeleted} read + ${unreadDeleted} unread + ${ephemeralDeleted} ephemeral notifications.`);
        }
    } catch (err) {
        console.error('[NOTIF-CLEANUP] Failed:', err);
    }
}

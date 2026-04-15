import webPush from 'web-push';
import { config } from '../../config';
import { prisma } from '../../lib/prisma';

// Initialize VAPID
if (config.push.vapidPublicKey && config.push.vapidPrivateKey) {
    webPush.setVapidDetails(
        config.push.vapidSubject,
        config.push.vapidPublicKey,
        config.push.vapidPrivateKey,
    );
}

export interface PushPayload {
    title: string;
    message: string;
    tag?: string;
    actionUrl?: string;
    severity?: 'critical' | 'warning' | 'info';
}

/** Send push to a single subscription. Returns false if subscription is invalid (410). */
export async function sendPush(
    subscription: { endpoint: string; p256dh: string; auth: string },
    payload: PushPayload,
): Promise<boolean> {
    try {
        await webPush.sendNotification(
            {
                endpoint: subscription.endpoint,
                keys: { p256dh: subscription.p256dh, auth: subscription.auth },
            },
            JSON.stringify(payload),
            { TTL: 60 * 60 }, // 1 hour TTL
        );
        return true;
    } catch (err: any) {
        // 410 Gone or 404 = subscription expired/invalid
        if (err.statusCode === 410 || err.statusCode === 404) {
            await prisma.pushSubscription.delete({
                where: { endpoint: subscription.endpoint },
            }).catch(() => {}); // ignore if already deleted
            return false;
        }
        console.error(`[PUSH] Failed to send to ${subscription.endpoint.slice(0, 50)}:`, err.message);
        return false;
    }
}

/** Send push to all subscriptions for a given user. */
export async function sendPushToUser(userId: string, payload: PushPayload): Promise<number> {
    const subscriptions = await prisma.pushSubscription.findMany({
        where: { userId },
    });

    if (subscriptions.length === 0) return 0;

    let sent = 0;
    for (const sub of subscriptions) {
        const ok = await sendPush(sub, payload);
        if (ok) sent++;
    }

    return sent;
}

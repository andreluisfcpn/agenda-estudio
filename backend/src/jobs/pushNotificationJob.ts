import { prisma } from '../lib/prisma.js';
import { redis } from '../lib/redis.js';
import { sendPushToUser, PushPayload } from '../modules/push/pushService.js';

// Redis TTL per severity (deduplication)
const SEVERITY_TTL: Record<string, number> = {
    critical: 6 * 60 * 60,   // 6 hours
    warning: 24 * 60 * 60,   // 24 hours
    info: 72 * 60 * 60,      // 72 hours
};

/**
 * Push Notification Job — runs every 15 minutes.
 * Computes notifications for each user with active push subscriptions,
 * deduplicates via Redis TTL, and sends push notifications.
 */
export async function runPushNotificationJob(): Promise<void> {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    // 1. Get all users with active push subscriptions
    const usersWithSubs = await prisma.pushSubscription.findMany({
        select: { userId: true },
        distinct: ['userId'],
    });

    if (usersWithSubs.length === 0) return;

    let totalSent = 0;

    for (const { userId } of usersWithSubs) {
        try {
            const notifications = await computeUserNotifications(userId, now, today);

            for (const notif of notifications) {
                const redisKey = `push:sent:${userId}:${notif.id}`;
                const alreadySent = await redis.get(redisKey);
                if (alreadySent) continue;

                const payload: PushPayload = {
                    title: notif.title,
                    message: notif.message,
                    tag: notif.id,
                    actionUrl: notif.actionUrl,
                    severity: notif.severity,
                };

                const sent = await sendPushToUser(userId, payload);
                if (sent > 0) {
                    const ttl = SEVERITY_TTL[notif.severity] || SEVERITY_TTL.info;
                    await redis.set(redisKey, '1', 'EX', ttl);
                    totalSent++;
                }
            }
        } catch (err) {
            console.error(`[PUSH-JOB] Error processing user ${userId}:`, err);
        }
    }

    if (totalSent > 0) {
        console.log(`[PUSH-JOB] Sent ${totalSent} push notifications.`);
    }
}

interface ComputedNotification {
    id: string;
    severity: 'critical' | 'warning' | 'info';
    title: string;
    message: string;
    actionUrl: string;
}

/** Compute notifications for a specific user (reuses logic from notifications module). */
async function computeUserNotifications(
    userId: string,
    now: Date,
    today: Date,
): Promise<ComputedNotification[]> {
    const notifications: ComputedNotification[] = [];
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
    if (!user) return notifications;

    const isAdmin = user.role === 'ADMIN';
    const thresholdDays = isAdmin ? 7 : 15;
    const targetDate = new Date(today);
    targetDate.setDate(targetDate.getDate() + thresholdDays);

    // Overdue payments
    const overduePayments = await prisma.payment.findMany({
        where: { status: 'PENDING', dueDate: { lt: today }, ...(!isAdmin ? { userId } : {}) },
        include: { user: { select: { name: true } } },
        take: 5,
    });

    for (const p of overduePayments) {
        const daysOverdue = Math.ceil((today.getTime() - new Date(p.dueDate!).getTime()) / (1000 * 60 * 60 * 24));
        notifications.push({
            id: `payment-overdue-${p.id}`,
            severity: daysOverdue > 7 ? 'critical' : 'warning',
            title: '💰 Pagamento Vencido',
            message: isAdmin
                ? `${p.user.name} — R$ ${(p.amount / 100).toFixed(2).replace('.', ',')} vencido há ${daysOverdue} dia(s)`
                : `Você possui uma fatura atrasada (vencida há ${daysOverdue} dias)`,
            actionUrl: isAdmin ? '/admin/finance' : '/meus-pagamentos',
        });
    }

    // Unconfirmed bookings (today or tomorrow)
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const unconfirmedBookings = await prisma.booking.findMany({
        where: { status: 'RESERVED', date: { gte: today, lte: tomorrow }, ...(!isAdmin ? { userId } : {}) },
        include: { user: { select: { name: true } } },
        take: 5,
    });

    for (const b of unconfirmedBookings) {
        const isToday = new Date(b.date).toISOString().split('T')[0] === today.toISOString().split('T')[0];
        notifications.push({
            id: `booking-unconfirmed-${b.id}`,
            severity: isToday ? 'critical' : 'warning',
            title: '⏳ Sessão Não Confirmada',
            message: isAdmin
                ? `${b.user.name} — ${isToday ? 'HOJE' : 'Amanhã'} às ${b.startTime}`
                : `Sua sessão de ${isToday ? 'HOJE' : 'Amanhã'} às ${b.startTime} precisa ser confirmada`,
            actionUrl: isAdmin ? '/admin/today' : '/dashboard',
        });
    }

    // Expiring contracts
    const expiringContracts = await prisma.contract.findMany({
        where: { status: 'ACTIVE', endDate: { gte: today, lte: targetDate }, ...(!isAdmin ? { userId } : {}) },
        include: { user: { select: { name: true } } },
        take: 3,
    });

    for (const c of expiringContracts) {
        const daysLeft = Math.ceil((new Date(c.endDate).getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
        notifications.push({
            id: `contract-expiring-${c.id}`,
            severity: daysLeft <= 2 ? 'critical' : 'warning',
            title: '📋 Contrato Expirando',
            message: isAdmin
                ? `${c.user.name} — "${c.name}" expira em ${daysLeft} dia(s)`
                : `Seu contrato "${c.name}" expira em ${daysLeft} dia(s)`,
            actionUrl: isAdmin ? `/admin/clients/${c.userId}` : '/my-contracts',
        });
    }

    // Low flex credits
    if (!isAdmin) {
        const lowCredits = await prisma.contract.findMany({
            where: { status: 'ACTIVE', type: 'FLEX', flexCreditsRemaining: { lte: 2, gt: 0 }, userId },
            take: 2,
        });

        for (const c of lowCredits) {
            notifications.push({
                id: `flex-credits-low-${c.id}`,
                severity: 'info',
                title: '🔄 Créditos Flex Baixos',
                message: `Seu plano Flex tem apenas ${c.flexCreditsRemaining} crédito(s) restante(s).`,
                actionUrl: '/my-contracts',
            });
        }
    }

    return notifications;
}

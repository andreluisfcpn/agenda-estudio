import { prisma } from '../lib/prisma.js';
import { createNotification } from '../modules/notifications/notificationService.js';
import { NotificationType } from '../generated/prisma/client.js';

/**
 * Push Notification Job — runs every 5 minutes.
 * Computes notifications for each user with active push subscriptions,
 * persists them in DB, and sends push notifications.
 */
export async function runPushNotificationJob(): Promise<void> {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    // Get all users with active push subscriptions
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
                // Use createNotification for dedup + persistence + push
                try {
                    await createNotification({
                        userId,
                        type: notif.type,
                        severity: notif.severity,
                        title: notif.title,
                        message: notif.message,
                        entityType: notif.entityType,
                        entityId: notif.entityId,
                        actionUrl: notif.actionUrl,
                        sendPush: true,
                    });
                    totalSent++;
                } catch {
                    // Dedup or other error — skip silently
                }
            }
        } catch (err) {
            console.error(`[PUSH-JOB] Error processing user ${userId}:`, err);
        }
    }

    if (totalSent > 0) {
        console.log(`[PUSH-JOB] Processed ${totalSent} push notifications.`);
    }
}

interface ComputedNotification {
    type: NotificationType;
    severity: 'critical' | 'warning' | 'info';
    title: string;
    message: string;
    entityType: string;
    entityId: string;
    actionUrl: string;
}

/** Compute notifications for a specific user. */
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
            type: 'PAYMENT_OVERDUE',
            severity: daysOverdue > 7 ? 'critical' : 'warning',
            title: '💰 Pagamento Vencido',
            message: isAdmin
                ? `${p.user.name} — R$ ${(p.amount / 100).toFixed(2).replace('.', ',')} vencido há ${daysOverdue} dia(s)`
                : `Você possui uma fatura atrasada (vencida há ${daysOverdue} dias)`,
            entityType: 'PAYMENT',
            entityId: p.id,
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
            type: 'BOOKING_UNCONFIRMED',
            severity: isToday ? 'critical' : 'warning',
            title: '⏳ Sessão Não Confirmada',
            message: isAdmin
                ? `${b.user.name} — ${isToday ? 'HOJE' : 'Amanhã'} às ${b.startTime}`
                : `Sua sessão de ${isToday ? 'HOJE' : 'Amanhã'} às ${b.startTime} precisa ser confirmada`,
            entityType: 'BOOKING',
            entityId: b.id,
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
            type: 'CONTRACT_EXPIRING',
            severity: daysLeft <= 2 ? 'critical' : 'warning',
            title: '📋 Contrato Expirando',
            message: isAdmin
                ? `${c.user.name} — "${c.name}" expira em ${daysLeft} dia(s)`
                : `Seu contrato "${c.name}" expira em ${daysLeft} dia(s)`,
            entityType: 'CONTRACT',
            entityId: c.id,
            actionUrl: isAdmin ? `/admin/clients/${c.userId}` : '/my-contracts',
        });
    }

    // Low flex credits (client only)
    if (!isAdmin) {
        const lowCredits = await prisma.contract.findMany({
            where: { status: 'ACTIVE', type: 'FLEX', flexCreditsRemaining: { lte: 2, gt: 0 }, userId },
            take: 2,
        });

        for (const c of lowCredits) {
            notifications.push({
                type: 'FLEX_CREDITS_LOW',
                severity: 'info',
                title: '🔄 Créditos Flex Baixos',
                message: `Seu plano Flex tem apenas ${c.flexCreditsRemaining} crédito(s) restante(s).`,
                entityType: 'CONTRACT',
                entityId: c.id,
                actionUrl: '/my-contracts',
            });
        }
    }

    return notifications;
}

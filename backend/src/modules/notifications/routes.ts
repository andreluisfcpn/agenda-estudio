import { Router, Request, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middleware/auth.js';
import {
    markAsRead,
    markAllAsRead,
    deleteNotification,
    getUserNotifications,
} from './notificationService.js';

const router = Router();

interface ComputedNotification {
    id: string;
    type: string;
    severity: 'critical' | 'warning' | 'info';
    title: string;
    message: string;
    entityType: string;
    entityId: string;
    actionUrl?: string;
    createdAt: string;
    read: boolean;
    source: 'computed' | 'persisted';
}

// ─── GET /api/notifications ─────────────────────────────
// Returns a mix of computed (real-time) and persisted (DB) notifications.

router.get('/', authenticate, async (req: Request, res: Response) => {
    try {
        const notifications: ComputedNotification[] = [];
        const userRole = req.user!.role;
        const userId = req.user!.userId;
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

        // ── Computed Notifications (real-time from data) ──

        // 1. Contracts expiring within threshold
        const thresholdDays = userRole === 'ADMIN' ? 7 : 15;
        const targetDateFromNow = new Date(today);
        targetDateFromNow.setDate(targetDateFromNow.getDate() + thresholdDays);

        const expiringContracts = await prisma.contract.findMany({
            where: {
                status: 'ACTIVE',
                endDate: { gte: today, lte: targetDateFromNow },
                ...(userRole !== 'ADMIN' ? { userId } : {}),
            },
            include: { user: { select: { name: true } } },
        });

        for (const c of expiringContracts) {
            const daysLeft = Math.ceil((new Date(c.endDate).getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
            notifications.push({
                id: `contract-expiring-${c.id}`,
                type: 'CONTRACT_EXPIRING',
                severity: daysLeft <= 2 ? 'critical' : 'warning',
                title: '📋 Contrato Expirando',
                message: userRole === 'ADMIN' ? `${c.user.name} — "${c.name}" expira em ${daysLeft} dia${daysLeft !== 1 ? 's' : ''}` : `Seu contrato "${c.name}" expira em ${daysLeft} dia${daysLeft !== 1 ? 's' : ''}`,
                entityType: 'CONTRACT', entityId: c.id,
                actionUrl: userRole === 'ADMIN' ? `/admin/clients/${c.userId}` : '/my-contracts',
                createdAt: now.toISOString(),
                read: false,
                source: 'computed',
            });
        }

        // 2. Overdue payments
        const overduePayments = await prisma.payment.findMany({
            where: {
                status: 'PENDING',
                dueDate: { lt: today },
                ...(userRole !== 'ADMIN' ? { userId } : {}),
            },
            include: { user: { select: { name: true } }, contract: { select: { name: true } } },
        });

        for (const p of overduePayments) {
            const daysOverdue = Math.ceil((today.getTime() - new Date(p.dueDate!).getTime()) / (1000 * 60 * 60 * 24));
            notifications.push({
                id: `payment-overdue-${p.id}`,
                type: 'PAYMENT_OVERDUE',
                severity: daysOverdue > 7 ? 'critical' : 'warning',
                title: '💰 Pagamento Vencido',
                message: userRole === 'ADMIN' ? `${p.user.name} — R$ ${(p.amount / 100).toFixed(2).replace('.', ',')} vencido há ${daysOverdue} dia${daysOverdue !== 1 ? 's' : ''}` : `Você possui uma fatura atrasada (vencida há ${daysOverdue} dias)`,
                entityType: 'PAYMENT', entityId: p.id,
                actionUrl: userRole === 'ADMIN' ? '/admin/finance' : '/meus-pagamentos',
                createdAt: now.toISOString(),
                read: false,
                source: 'computed',
            });
        }

        // 2b. Failed payments
        const failedPayments = await prisma.payment.findMany({
            where: {
                status: 'FAILED',
                ...(userRole !== 'ADMIN' ? { userId } : {}),
            },
            include: { user: { select: { name: true } } },
        });

        for (const p of failedPayments) {
            notifications.push({
                id: `payment-failed-${p.id}`,
                type: 'PAYMENT_OVERDUE',
                severity: 'critical',
                title: '❌ Pagamento Recusado',
                message: userRole === 'ADMIN' ? `${p.user.name} teve um pagamento recusado (R$ ${(p.amount / 100).toFixed(2).replace('.', ',')})` : `Seu último pagamento via cartão falhou. Acesse Meus Pagamentos para tentar novamente.`,
                entityType: 'PAYMENT', entityId: p.id,
                actionUrl: userRole === 'ADMIN' ? '/admin/finance' : '/meus-pagamentos',
                createdAt: now.toISOString(),
                read: false,
                source: 'computed',
            });
        }

        // 3. Unconfirmed bookings (today or tomorrow)
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        const unconfirmedBookings = await prisma.booking.findMany({
            where: {
                status: 'RESERVED',
                date: { gte: today, lte: tomorrow },
                ...(userRole !== 'ADMIN' ? { userId } : {}),
            },
            include: { user: { select: { name: true } } },
        });

        for (const b of unconfirmedBookings) {
            const isToday = new Date(b.date).toISOString().split('T')[0] === today.toISOString().split('T')[0];
            notifications.push({
                id: `booking-unconfirmed-${b.id}`,
                type: 'BOOKING_UNCONFIRMED',
                severity: isToday ? 'critical' : 'warning',
                title: '⏳ Sessão Não Confirmada',
                message: userRole === 'ADMIN' ? `${b.user.name} — ${isToday ? 'HOJE' : 'Amanhã'} às ${b.startTime}` : `Sua sessão de ${isToday ? 'HOJE' : 'Amanhã'} às ${b.startTime} precisa ser confirmada`,
                entityType: 'BOOKING', entityId: b.id,
                actionUrl: userRole === 'ADMIN' ? '/admin/today' : '/dashboard',
                createdAt: now.toISOString(),
                read: false,
                source: 'computed',
            });
        }

        // 4. Contracts pending cancellation
        const pendingCancellations = await prisma.contract.findMany({
            where: { status: 'PENDING_CANCELLATION', ...(userRole !== 'ADMIN' ? { userId } : {}) },
            include: { user: { select: { name: true } } },
        });

        for (const c of pendingCancellations) {
            notifications.push({
                id: `cancellation-pending-${c.id}`,
                type: 'CANCELLATION_PENDING',
                severity: 'warning',
                title: '🚫 Cancelamento Pendente',
                message: userRole === 'ADMIN' ? `${c.user.name} — "${c.name}" aguarda resolução` : `O cancelamento de "${c.name}" está sendo avaliado.`,
                entityType: 'CONTRACT', entityId: c.id,
                actionUrl: userRole === 'ADMIN' ? '/admin/contracts' : '/my-contracts',
                createdAt: now.toISOString(),
                read: false,
                source: 'computed',
            });
        }

        // 4b. Contracts awaiting payment
        const awaitingPayment = await prisma.contract.findMany({
            where: { status: 'AWAITING_PAYMENT', ...(userRole !== 'ADMIN' ? { userId } : {}) },
            include: { user: { select: { name: true } } },
        });

        for (const c of awaitingPayment) {
            const deadline = c.paymentDeadline ? new Date(c.paymentDeadline) : null;
            const isUrgent = deadline && (deadline.getTime() - now.getTime()) < 30 * 60 * 1000;
            notifications.push({
                id: `contract-awaiting-${c.id}`,
                type: 'CONTRACT_AWAITING_PAYMENT',
                severity: isUrgent ? 'critical' : 'warning',
                title: '💳 Pagamento Pendente',
                message: userRole === 'ADMIN'
                    ? `${c.user.name} — "${c.name}" aguardando pagamento`
                    : `Seu contrato "${c.name}" está aguardando pagamento para ser ativado.`,
                entityType: 'CONTRACT', entityId: c.id,
                actionUrl: userRole === 'ADMIN' ? `/admin/clients/${c.userId}` : '/my-contracts',
                createdAt: now.toISOString(),
                read: false,
                source: 'computed',
            });
        }

        // 5. Flex contracts with low credits
        const lowCreditContracts = await prisma.contract.findMany({
            where: {
                status: 'ACTIVE',
                type: 'FLEX',
                flexCreditsRemaining: { lte: 2, gt: 0 },
                ...(userRole !== 'ADMIN' ? { userId } : {}),
            },
            include: { user: { select: { name: true } } },
        });

        for (const c of lowCreditContracts) {
            notifications.push({
                id: `flex-credits-low-${c.id}`,
                type: 'FLEX_CREDITS_LOW',
                severity: 'info',
                title: '🔄 Créditos Flex Baixos',
                message: userRole === 'ADMIN' ? `${c.user.name} — ${c.flexCreditsRemaining} crédito${c.flexCreditsRemaining !== 1 ? 's' : ''} restante${c.flexCreditsRemaining !== 1 ? 's' : ''}` : `Seu plano Flex tem apenas ${c.flexCreditsRemaining} crédito${c.flexCreditsRemaining !== 1 ? 's' : ''} restante${c.flexCreditsRemaining !== 1 ? 's' : ''}. Deseja recarregar?`,
                entityType: 'CONTRACT', entityId: c.id,
                actionUrl: userRole === 'ADMIN' ? `/admin/clients/${c.userId}` : '/my-contracts',
                createdAt: now.toISOString(),
                read: false,
                source: 'computed',
            });
        }

        // 6. Inactive clients (admin only)
        if (userRole === 'ADMIN') {
            const fourteenDaysAgo = new Date(today);
            fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);

            const activeContractsQuery = await prisma.contract.findMany({
                where: { status: 'ACTIVE' },
                include: {
                    user: { select: { id: true, name: true } },
                    bookings: {
                        where: { date: { gte: fourteenDaysAgo }, status: { not: 'CANCELLED' } },
                        take: 1,
                    },
                },
            });

            for (const c of activeContractsQuery) {
                if (c.bookings.length === 0) {
                    if (!notifications.find(n => n.id === `client-inactive-${c.userId}`)) {
                        notifications.push({
                            id: `client-inactive-${c.userId}`,
                            type: 'CLIENT_INACTIVE',
                            severity: 'info',
                            title: '😴 Cliente Inativo',
                            message: `${c.user.name} — sem gravações há 14+ dias`,
                            entityType: 'USER', entityId: c.userId,
                            actionUrl: `/admin/clients/${c.userId}`,
                            createdAt: now.toISOString(),
                            read: false,
                            source: 'computed',
                        });
                    }
                }
            }
        }

        // ── Persisted Notifications (from DB) ──
        const persistedNotifs = await getUserNotifications(userId, 30);
        const persistedIds = new Set<string>();

        for (const n of persistedNotifs) {
            // Avoid duplicates with computed (same entity)
            const computedKey = `${n.type}-${n.entityId}`;
            const alreadyInComputed = notifications.some(cn =>
                cn.entityId === n.entityId && cn.type === n.type,
            );
            if (alreadyInComputed) continue;

            persistedIds.add(n.id);
            notifications.push({
                id: n.id,
                type: n.type,
                severity: n.severity as 'critical' | 'warning' | 'info',
                title: n.title,
                message: n.message,
                entityType: n.entityType || '',
                entityId: n.entityId || '',
                actionUrl: n.actionUrl || undefined,
                createdAt: n.createdAt.toISOString(),
                read: n.read,
                source: 'persisted',
            });
        }

        // Sort: critical first, then warning, then info; unread first
        const severityOrder = { critical: 0, warning: 1, info: 2 };
        notifications.sort((a, b) => {
            if (a.read !== b.read) return a.read ? 1 : -1;
            return severityOrder[a.severity] - severityOrder[b.severity];
        });

        const unreadCount = notifications.filter(n => !n.read).length;

        res.json({
            notifications,
            summary: {
                total: notifications.length,
                unread: unreadCount,
                critical: notifications.filter(n => n.severity === 'critical' && !n.read).length,
                warning: notifications.filter(n => n.severity === 'warning' && !n.read).length,
                info: notifications.filter(n => n.severity === 'info' && !n.read).length,
            },
        });
    } catch (err) {
        console.error('Erro ao gerar notificações:', err);
        res.status(500).json({ error: 'Erro ao gerar notificações.' });
    }
});

// ─── PATCH /api/notifications/read-all ──────────────────
// MUST be registered BEFORE /:id routes to avoid being intercepted by :id param
router.patch('/read-all', authenticate, async (req: Request, res: Response) => {
    try {
        const count = await markAllAsRead(req.user!.userId);
        res.json({ message: `${count} notificação(ões) marcada(s) como lida(s).`, count });
    } catch (err) {
        console.error('Erro ao marcar notificações:', err);
        res.status(500).json({ error: 'Erro ao marcar notificações.' });
    }
});

// ─── PATCH /api/notifications/:id/read ──────────────────
router.patch('/:id/read', authenticate, async (req: Request, res: Response) => {
    try {
        const success = await markAsRead(req.user!.userId, req.params.id as string);
        if (!success) return res.status(404).json({ error: 'Notificação não encontrada.' });
        res.json({ message: 'Marcada como lida.' });
    } catch (err) {
        console.error('Erro ao marcar notificação:', err);
        res.status(500).json({ error: 'Erro ao marcar notificação.' });
    }
});

// ─── DELETE /api/notifications/:id ──────────────────────
router.delete('/:id', authenticate, async (req: Request, res: Response) => {
    try {
        const success = await deleteNotification(req.user!.userId, req.params.id as string);
        if (!success) return res.status(404).json({ error: 'Notificação não encontrada.' });
        res.json({ message: 'Notificação removida.' });
    } catch (err) {
        console.error('Erro ao deletar notificação:', err);
        res.status(500).json({ error: 'Erro ao deletar notificação.' });
    }
});

export default router;

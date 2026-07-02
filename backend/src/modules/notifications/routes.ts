import { Router, Request, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { redis } from '../../lib/redis.js';
import { authenticate } from '../../middleware/auth.js';
import { saoPauloParts } from '../../lib/spTime.js';
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

// ─── Computed-notification read state ────────────────────
// Computed notifications are re-generated on every GET (they mirror live data:
// pending cancellation, overdue payment, …), so a plain DB markAllAsRead never
// touches them and they resurrect unread on the next poll. We remember which
// computed IDs the user has read in a per-user Redis set. The IDs are stable
// (`cancellation-pending-<contractId>` etc.), and once the underlying condition
// resolves the entry simply expires.
const COMPUTED_READ_TTL = 30 * 24 * 3600; // 30 days, refreshed on every write
const computedReadKey = (userId: string) => `notif:computed-read:${userId}`;
const COMPUTED_ID_RE = /^(contract-expiring|payment-overdue|payment-failed|booking-unconfirmed|cancellation-pending|contract-awaiting)-/;

const COMPUTED_READ_MAX = 500; // hard cap so a client can't grow the per-user set unbounded

async function markComputedRead(userId: string, ids: string[]): Promise<void> {
    // Length cap rejects forged long ids; real computed ids are `<prefix>-<uuid>` (~50 chars).
    const valid = ids.filter(id => id.length <= 80 && COMPUTED_ID_RE.test(id));
    if (valid.length === 0) return;
    const key = computedReadKey(userId);
    try { if ((await redis.scard(key)) >= COMPUTED_READ_MAX) return; } catch { /* best-effort */ }
    await redis.sadd(key, ...valid);
    await redis.expire(key, COMPUTED_READ_TTL);
}

/** Builds the real-time (computed) notifications for a user/role. Shared by GET and read-all. */
async function buildComputedNotifications(userId: string, userRole: string): Promise<ComputedNotification[]> {
    const notifications: ComputedNotification[] = [];
    const now = new Date();
    // São Paulo calendar day as 00:00Z — matches Booking.date (@db.Date) and keeps
    // day-based windows/labels correct after 21:00 SP (when the UTC date already flipped).
    const sp = saoPauloParts(now);
    const today = new Date(Date.UTC(sp.y, sp.m - 1, sp.day));

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

        // 3. Unconfirmed bookings — TODAY only (action needed now). Tomorrow's session is
        // already covered by the 24h BOOKING_REMINDER job, so we don't double-notify.
        // ADMIN-only: for clients, the 7am dailyConfirmationJob owns today's session signal
        // (paid → "confirmada" / unpaid → "pague para confirmar") and would otherwise be
        // shadowed by this computed one (same type+entityId).
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        const unconfirmedBookings = userRole === 'ADMIN'
            ? await prisma.booking.findMany({
                where: {
                    status: 'RESERVED',
                    date: { gte: today, lt: tomorrow },
                },
                include: { user: { select: { name: true } } },
            })
            : [];

        for (const b of unconfirmedBookings) {
            notifications.push({
                id: `booking-unconfirmed-${b.id}`,
                type: 'BOOKING_UNCONFIRMED',
                severity: 'critical',
                title: '⏳ Sessão Não Confirmada',
                message: userRole === 'ADMIN' ? `${b.user.name} — HOJE às ${b.startTime}` : `Sua sessão de HOJE às ${b.startTime} precisa ser confirmada`,
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

    // NOTE (notification pruning, jun/2026): the noisy "info" FLEX_CREDITS_LOW (≤2 credits)
    // and the admin-only CLIENT_INACTIVE computed notifications were removed — they fired on
    // every poll and added little value. The meaningful FLEX signals (crédito perdido =
    // critical, "grave esta semana" = warning) still come from the jobs as persisted rows.

    return notifications;
}

// ─── GET /api/notifications ─────────────────────────────
// Returns a mix of computed (real-time) and persisted (DB) notifications.

router.get('/', authenticate, async (req: Request, res: Response) => {
    try {
        const userRole = req.user!.role;
        const userId = req.user!.userId;

        const notifications = await buildComputedNotifications(userId, userRole);

        // Apply the computed-read state: read items stay visible (grey) but leave the counters.
        try {
            const readIds = new Set(await redis.smembers(computedReadKey(userId)));
            if (readIds.size > 0) {
                for (const n of notifications) {
                    if (readIds.has(n.id)) n.read = true;
                }
            }
        } catch { /* redis best-effort — worst case they show unread */ }

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
        // Also remember the CURRENT computed notifications as read — otherwise they
        // resurrect unread on the next poll (e.g. "Cancelamento Pendente").
        try {
            const computed = await buildComputedNotifications(req.user!.userId, req.user!.role);
            await markComputedRead(req.user!.userId, computed.map(n => n.id));
        } catch (err) { console.error('[NOTIF] computed read-all falhou (best-effort):', err); }
        res.json({ message: `${count} notificação(ões) marcada(s) como lida(s).`, count });
    } catch (err) {
        console.error('Erro ao marcar notificações:', err);
        res.status(500).json({ error: 'Erro ao marcar notificações.' });
    }
});

// ─── PATCH /api/notifications/:id/read ──────────────────
router.patch('/:id/read', authenticate, async (req: Request, res: Response) => {
    try {
        const id = req.params.id as string;
        // Computed notifications don't live in the DB — record the read in Redis.
        if (COMPUTED_ID_RE.test(id)) {
            await markComputedRead(req.user!.userId, [id]);
            res.json({ message: 'Marcada como lida.' });
            return;
        }
        const success = await markAsRead(req.user!.userId, id);
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

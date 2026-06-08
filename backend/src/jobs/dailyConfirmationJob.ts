import { prisma } from '../lib/prisma.js';
import { redis } from '../lib/redis.js';
import { createNotification } from '../modules/notifications/notificationService.js';

/**
 * Daily Confirmation Job — fires once per day at 07:00 (America/Sao_Paulo).
 *
 * On the MORNING of each recording day, notifies the CLIENT about that day's session:
 *  - paid    → "✅ Gravação confirmada"
 *  - not paid → "💳 Pague para confirmar"
 *
 * This job is the single owner of the client's "today's session" signal — the computed
 * BOOKING_UNCONFIRMED for TODAY is admin-only (routes.ts + pushNotificationJob), so the
 * 7am push isn't pre-empted by the 5-min push job's dedup window.
 *
 * "Paid" rules (per business decision):
 *  - Per-session payment PAID (covers avulso) → confirmed.
 *  - Avulso with no paid payment → confirmed only if the booking status is CONFIRMED
 *    (system lifecycle), otherwise not confirmed.
 *  - Recurring/contract session → confirmed if the contract is ACTIVE and not in arrears
 *    (no overdue PENDING installment); i.e. paid in full OR the current cycle isn't overdue.
 *
 * Runs every 30 min; the body only executes when the São Paulo hour is 7, guarded by a daily
 * Redis marker (optimization) plus per-booking dedup so each session gets exactly one message
 * per day even across restarts / multiple instances. Pass { force, forceDate } to test.
 */

const TARGET_HOUR_SP = 7;

interface SpParts { y: number; m: number; day: number; hour: number; dateStr: string; }

// Calendar parts of an instant in America/Sao_Paulo (UTC-3, no DST since 2019).
function saoPauloParts(d: Date): SpParts {
    const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Sao_Paulo',
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
    });
    const parts: Record<string, string> = {};
    for (const p of fmt.formatToParts(d)) parts[p.type] = p.value;
    // en-CA gives 24h; "24" can appear at midnight on some engines → normalize to "00".
    const hour = parts.hour === '24' ? 0 : Number(parts.hour);
    return {
        y: Number(parts.year), m: Number(parts.month), day: Number(parts.day),
        hour, dateStr: `${parts.year}-${parts.month}-${parts.day}`,
    };
}

type PaymentLite = { status: string; dueDate: Date | null; bookingId: string | null };
type BookingForConfirm = {
    status: string;
    payments: { status: string }[];
    contract: { status: string; type: string; payments: PaymentLite[] } | null;
};

function isBookingPaid(b: BookingForConfirm, now: Date): boolean {
    // 1. A paid payment tied to this session (covers avulso paid up-front).
    if (b.payments?.some(p => p.status === 'PAID')) return true;

    const c = b.contract;
    // 2. Avulso (or unknown contract): a CONFIRMED status means the session was confirmed
    // through the system lifecycle (e.g. by an admin), so treat it as confirmed even if the
    // payment row was later voided — avoids a contradictory "ainda não está paga" nudge.
    if (!c || c.type === 'AVULSO') return b.status === 'CONFIRMED';

    // 3. Recurring/contract session: confirmed only if the contract is active and not in arrears.
    if (c.status !== 'ACTIVE') return false;
    const installments = (c.payments || []).filter(p => p.bookingId == null && p.status !== 'CANCELLED');
    const hasOverdue = installments.some(p => p.status === 'PENDING' && p.dueDate != null && new Date(p.dueDate) < now);
    return !hasOverdue;
}

export async function runDailyConfirmationJob(opts?: { force?: boolean; forceDate?: string }): Promise<void> {
    const now = new Date();
    const sp = saoPauloParts(now);

    // Only fire at 07:00 São Paulo (unless forced for testing).
    if (!opts?.force && sp.hour !== TARGET_HOUR_SP) return;

    const dateStr = opts?.forceDate || sp.dateStr; // YYYY-MM-DD in São Paulo calendar

    // Once-per-day optimization: skip re-scanning if we already finished today's run.
    // (Per-booking dedup below still guarantees no double-sends even if this check races.)
    const doneKey = `cron:daily-confirm:done:${dateStr}`;
    if (!opts?.force) {
        try { if (await redis.get(doneKey)) return; } catch { /* redis best-effort */ }
    }

    // Bookings stored as @db.Date at 00:00Z — match the SP calendar date via a UTC range.
    const [y, m, d] = dateStr.split('-').map(Number);
    const dayStart = new Date(Date.UTC(y, m - 1, d));
    const dayEnd = new Date(Date.UTC(y, m - 1, d + 1));

    const bookings = await prisma.booking.findMany({
        where: {
            date: { gte: dayStart, lt: dayEnd },
            status: { in: ['RESERVED', 'CONFIRMED'] },
        },
        include: {
            payments: { select: { status: true } },
            contract: {
                select: {
                    status: true,
                    type: true,
                    payments: { select: { status: true, dueDate: true, bookingId: true } },
                },
            },
        },
    });

    let sent = 0;
    for (const b of bookings) {
        const paid = isBookingPaid(b as unknown as BookingForConfirm, now);
        // Date-scoped dedup identity, independent of the 5-min push job's BOOKING_* keys.
        const dedupId = `daily-confirm:${b.userId}:${b.id}:${dateStr}`;
        try {
            if (paid) {
                await createNotification({
                    userId: b.userId,
                    type: 'BOOKING_CONFIRMED',
                    severity: 'info',
                    title: '✅ Gravação confirmada',
                    message: `Sua gravação de hoje às ${b.startTime} está confirmada. Até logo!`,
                    entityType: 'BOOKING',
                    entityId: b.id,
                    actionUrl: '/my-bookings',
                    sendPush: true,
                    dedupKey: dedupId,
                });
            } else {
                await createNotification({
                    userId: b.userId,
                    type: 'BOOKING_UNCONFIRMED',
                    severity: 'warning',
                    title: '💳 Pague para confirmar',
                    message: `Sua gravação de hoje às ${b.startTime} ainda não está paga. Pague para confirmar.`,
                    entityType: 'BOOKING',
                    entityId: b.id,
                    actionUrl: '/meus-pagamentos',
                    sendPush: true,
                    dedupKey: dedupId,
                });
            }
            sent++;
        } catch (err) {
            console.error(`[DAILY-CONFIRM] Failed for booking ${b.id}:`, err);
        }
    }

    // Mark the day done only AFTER the loop, so a mid-loop crash lets the next tick retry.
    if (!opts?.force) {
        try { await redis.set(doneKey, '1', 'EX', 23 * 3600); } catch { /* best-effort */ }
    }

    if (sent > 0) console.log(`[DAILY-CONFIRM] Sent ${sent} confirmation notifications for ${dateStr}.`);
}

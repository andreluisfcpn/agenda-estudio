import { prisma } from '../lib/prisma.js';
import { createNotification } from '../modules/notifications/notificationService.js';
import { spDaysFromToday, spDdMm } from '../lib/spTime.js';

/**
 * Booking Reminder Job — runs every 30 minutes.
 * Sends reminders 24h and 2h before confirmed/reserved sessions.
 *
 * Copy rules (bugfix jun/2026):
 *  - The day label ("hoje"/"amanhã") is derived from the SP CALENDAR at creation
 *    time, never assumed from the window — and the explicit date (DD/MM) is always
 *    included, so a reminder read hours later (e.g. next morning, in the bell) can't
 *    claim "amanhã" for a session that is already today.
 *  - Each window has its OWN dedup key: the default type+entity key made the 24h
 *    reminder (warning, 24h dedup TTL) swallow the day-of 2h reminder entirely.
 */
export async function runBookingReminderJob(): Promise<void> {
    const now = new Date();

    // Windows: 24h ± 30min and 2h ± 30min
    const windows = [
        { label: '24h', hoursAhead: 24, severity: 'warning' as const },
        { label: '2h', hoursAhead: 2, severity: 'critical' as const },
    ];

    let totalSent = 0;

    for (const window of windows) {
        const rangeStart = new Date(now.getTime() + (window.hoursAhead - 0.5) * 60 * 60 * 1000);
        const rangeEnd = new Date(now.getTime() + (window.hoursAhead + 0.5) * 60 * 60 * 1000);

        // Find bookings whose start falls within the window
        const bookings = await prisma.booking.findMany({
            where: {
                status: { in: ['CONFIRMED', 'RESERVED'] },
                date: {
                    gte: new Date(rangeStart.getFullYear(), rangeStart.getMonth(), rangeStart.getDate()),
                    lte: new Date(rangeEnd.getFullYear(), rangeEnd.getMonth(), rangeEnd.getDate()),
                },
            },
            include: { user: { select: { id: true, name: true } } },
        });

        for (const booking of bookings) {
            // Calculate exact start datetime
            const [h, m] = booking.startTime.split(':').map(Number);
            const startDateTime = new Date(booking.date);
            // Booking times are BRT (UTC-3): add 3h offset for correct UTC comparison
            startDateTime.setUTCHours(h + 3, m, 0, 0);

            // Check if start time falls within the window
            if (startDateTime < rangeStart || startDateTime > rangeEnd) continue;

            try {
                const ddmm = spDdMm(booking.date);
                const daysAhead = spDaysFromToday(booking.date, now);
                // SP-calendar label at creation time; date always explicit.
                const dayLabel = daysAhead === 0 ? 'hoje' : daysAhead === 1 ? 'amanhã' : `em ${ddmm}`;

                const title = window.label === '2h'
                    ? '🎙️ Sessão em 2 horas!'
                    : daysAhead === 1 ? `📅 Sessão amanhã (${ddmm})` : `📅 Lembrete de sessão (${ddmm})`;

                const message = window.label === '2h'
                    ? `Sua gravação começa às ${booking.startTime} — prepare-se!`
                    : `Lembrete: você tem sessão ${dayLabel === 'em ' + ddmm ? dayLabel : `${dayLabel} (${ddmm})`} às ${booking.startTime}`;

                await createNotification({
                    userId: booking.user.id,
                    type: 'BOOKING_REMINDER',
                    severity: window.severity,
                    title,
                    message,
                    entityType: 'BOOKING',
                    entityId: booking.id,
                    actionUrl: '/minhas-gravacoes',
                    sendPush: true,
                    // Per-window identity — without it the 24h reminder's dedup (TTL 24h)
                    // suppressed the 2h reminder (same type+entity default key).
                    dedupKey: `reminder:${window.label}:${booking.id}:${booking.date.toISOString().slice(0, 10)}`,
                });

                totalSent++;
            } catch (err) {
                console.error(`[REMINDER-JOB] Failed for booking ${booking.id}:`, err);
            }
        }
    }

    if (totalSent > 0) {
        console.log(`[REMINDER-JOB] Sent ${totalSent} booking reminders.`);
    }
}

import { Router, Request, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { authenticate, authorize } from '../../middleware/auth.js';
import { generateTimeSlots } from '../../utils/pricing.js';

const router = Router();

// ─── GET /api/reports/summary ───────────────────────────
// KPIs: total sessions, completed, faltas, cancelled, revenue, rates

router.get('/summary', authenticate, authorize('ADMIN'), async (req: Request, res: Response) => {
    try {
        const { from, to } = req.query;
        const dateFilter = buildDateFilter(from as string | undefined, to as string | undefined);

        const [total, completed, falta, cancelled, naoRealizado] = await Promise.all([
            prisma.booking.count({ where: { date: dateFilter } }),
            prisma.booking.count({ where: { date: dateFilter, status: 'COMPLETED' } }),
            prisma.booking.count({ where: { date: dateFilter, status: 'FALTA' } }),
            prisma.booking.count({ where: { date: dateFilter, status: 'CANCELLED' } }),
            prisma.booking.count({ where: { date: dateFilter, status: 'NAO_REALIZADO' } }),
        ]);

        const revenueAgg = await prisma.booking.aggregate({
            where: { date: dateFilter, status: { not: 'CANCELLED' } },
            _sum: { price: true },
        });

        const totalFalta = falta + naoRealizado;
        const attendanceDenominator = completed + totalFalta || 1;

        res.json({
            summary: {
                totalBookings: total,
                completedBookings: completed,
                faltaBookings: totalFalta,
                cancelledBookings: cancelled,
                totalRevenue: revenueAgg._sum.price || 0,
                attendanceRate: Math.round((completed / attendanceDenominator) * 100),
                cancellationRate: total > 0 ? Math.round((cancelled / total) * 100) : 0,
            },
        });
    } catch (err) {
        console.error('Erro ao gerar resumo de relatórios:', err);
        res.status(500).json({ error: 'Erro ao gerar resumo.' });
    }
});

// ─── GET /api/reports/occupancy ─────────────────────────
// Occupancy by slot and by day of week

router.get('/occupancy', authenticate, authorize('ADMIN'), async (req: Request, res: Response) => {
    try {
        const { from, to } = req.query;
        const dateFilter = buildDateFilter(from as string | undefined, to as string | undefined);
        const fromDate = dateFilter?.gte || new Date(new Date().setDate(new Date().getDate() - 30));
        const toDate = dateFilter?.lte || new Date();

        // Count business days in range (Mon-Sat, excluding Sunday)
        let totalDays = 0;
        const dayCounts = [0, 0, 0, 0, 0, 0, 0]; // Sun-Sat
        const d = new Date(fromDate);
        while (d <= toDate) {
            if (d.getDay() !== 0) { totalDays++; dayCounts[d.getDay()]++; }
            d.setDate(d.getDate() + 1);
        }

        // Bookings grouped by startTime
        const bookings = await prisma.booking.findMany({
            where: { date: dateFilter, status: { not: 'CANCELLED' } },
            select: { startTime: true, date: true },
        });

        // Slot occupancy
        const SLOTS = await generateTimeSlots();
        const SLOT_LABELS: Record<string, string> = {};
        for (const s of SLOTS) { SLOT_LABELS[s] = s.replace(':00', 'h').replace(':30', 'h30'); }
        const slotCounts: Record<string, number> = {};
        SLOTS.forEach(s => slotCounts[s] = 0);
        bookings.forEach(b => { if (slotCounts[b.startTime] !== undefined) slotCounts[b.startTime]++; });

        const slotOccupancy = SLOTS.map(s => ({
            slot: s, label: SLOT_LABELS[s] || s,
            count: slotCounts[s], total: totalDays,
            pct: totalDays > 0 ? Math.round((slotCounts[s] / totalDays) * 100) : 0,
        }));

        // Day of week occupancy
        const DAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
        const dowCounts = [0, 0, 0, 0, 0, 0, 0];
        bookings.forEach(b => { dowCounts[new Date(b.date).getDay()]++; });

        const dayOccupancy = [1, 2, 3, 4, 5, 6].map(i => ({
            day: DAYS[i], count: dowCounts[i],
            total: dayCounts[i] * 5, // 5 slots per day
            pct: (dayCounts[i] * 5) > 0 ? Math.round((dowCounts[i] / (dayCounts[i] * 5)) * 100) : 0,
        }));

        res.json({ slotOccupancy, dayOccupancy });
    } catch (err) {
        console.error('Erro ao calcular ocupação:', err);
        res.status(500).json({ error: 'Erro ao calcular ocupação.' });
    }
});

// ─── GET /api/reports/tiers ─────────────────────────────
// Distribution by tier (count + revenue)

router.get('/tiers', authenticate, authorize('ADMIN'), async (req: Request, res: Response) => {
    try {
        const { from, to } = req.query;
        const dateFilter = buildDateFilter(from as string | undefined, to as string | undefined);

        const active = await prisma.booking.findMany({
            where: { date: dateFilter, status: { not: 'CANCELLED' } },
            select: { tierApplied: true, price: true },
        });

        const total = active.length || 1;
        const TIERS = ['COMERCIAL', 'AUDIENCIA', 'SABADO'] as const;
        const tierBreakdown = TIERS.map(t => {
            const items = active.filter(b => b.tierApplied === t);
            const count = items.length;
            const revenue = items.reduce((s, b) => s + b.price, 0);
            return { tier: t, count, revenue, pct: Math.round((count / total) * 100) };
        });

        res.json({ tierBreakdown });
    } catch (err) {
        console.error('Erro ao calcular distribuição por faixa:', err);
        res.status(500).json({ error: 'Erro ao calcular distribuição.' });
    }
});

// ─── GET /api/reports/audience ──────────────────────────
// Audience metrics (avg viewers, max, chat, duration)

router.get('/audience', authenticate, authorize('ADMIN'), async (req: Request, res: Response) => {
    try {
        const { from, to } = req.query;
        const dateFilter = buildDateFilter(from as string | undefined, to as string | undefined);

        const completed = await prisma.booking.findMany({
            where: { date: dateFilter, status: 'COMPLETED' },
            select: { peakViewers: true, chatMessages: true, durationMinutes: true },
        });

        const withViewers = completed.filter(b => b.peakViewers && b.peakViewers > 0);
        const withChat = completed.filter(b => b.chatMessages && b.chatMessages > 0);
        const withDuration = completed.filter(b => b.durationMinutes && b.durationMinutes > 0);

        res.json({
            audience: {
                totalCompleted: completed.length,
                avgViewers: withViewers.length > 0 ? Math.round(withViewers.reduce((s, b) => s + b.peakViewers!, 0) / withViewers.length) : 0,
                maxViewers: withViewers.length > 0 ? Math.max(...withViewers.map(b => b.peakViewers!)) : 0,
                avgChat: withChat.length > 0 ? Math.round(withChat.reduce((s, b) => s + b.chatMessages!, 0) / withChat.length) : 0,
                avgDuration: withDuration.length > 0 ? Math.round(withDuration.reduce((s, b) => s + b.durationMinutes!, 0) / withDuration.length) : 0,
            },
        });
    } catch (err) {
        console.error('Erro ao calcular métricas de audiência:', err);
        res.status(500).json({ error: 'Erro ao calcular audiência.' });
    }
});

// ─── GET /api/reports/ranking ───────────────────────────
// Top clients by revenue

router.get('/ranking', authenticate, authorize('ADMIN'), async (req: Request, res: Response) => {
    try {
        const { from, to, limit } = req.query;
        const dateFilter = buildDateFilter(from as string | undefined, to as string | undefined);
        const maxResults = parseInt(limit as string) || 10;

        const bookings = await prisma.booking.findMany({
            where: { date: dateFilter, status: { not: 'CANCELLED' } },
            select: {
                userId: true, price: true, status: true,
                peakViewers: true,
                user: { select: { id: true, name: true } },
            },
        });

        const map = new Map<string, { name: string; id: string; sessions: number; revenue: number; completed: number; falta: number; avgViewers: number; viewerCount: number }>();

        bookings.forEach(b => {
            const existing = map.get(b.userId) || { name: b.user.name, id: b.userId, sessions: 0, revenue: 0, completed: 0, falta: 0, avgViewers: 0, viewerCount: 0 };
            existing.sessions++;
            existing.revenue += b.price;
            if (b.status === 'COMPLETED') existing.completed++;
            if (b.status === 'FALTA' || b.status === 'NAO_REALIZADO') existing.falta++;
            if (b.peakViewers && b.peakViewers > 0) { existing.avgViewers += b.peakViewers; existing.viewerCount++; }
            map.set(b.userId, existing);
        });

        const ranking = Array.from(map.values())
            .map(c => ({ ...c, avgViewers: c.viewerCount > 0 ? Math.round(c.avgViewers / c.viewerCount) : 0 }))
            .sort((a, b) => b.revenue - a.revenue)
            .slice(0, maxResults);

        res.json({ ranking });
    } catch (err) {
        console.error('Erro ao calcular ranking:', err);
        res.status(500).json({ error: 'Erro ao calcular ranking.' });
    }
});

// ─── Helpers ────────────────────────────────────────────

function buildDateFilter(from?: string, to?: string): { gte?: Date; lte?: Date } | undefined {
    if (!from && !to) {
        // Default: last 30 days
        const now = new Date();
        return { gte: new Date(now.setDate(now.getDate() - 30)), lte: new Date() };
    }
    const filter: { gte?: Date; lte?: Date } = {};
    if (from) filter.gte = new Date(from);
    if (to) {
        const end = new Date(to);
        end.setDate(end.getDate() + 1); // inclusive
        filter.lte = end;
    }
    return filter;
}

export default router;

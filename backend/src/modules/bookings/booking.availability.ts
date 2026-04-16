import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { authenticate } from '../../middleware/auth';
import { BookingStatus } from '../../generated/prisma/client';
import { publicAvailabilitySchema, availabilitySchema } from './validators';
import { getPublicDayAvailability, getAuthDayAvailability } from './availability.service';

export function registerAvailabilityRoutes(router: Router) {

// ─── GET /api/bookings/public-availability ───────────────
// Public endpoint (no auth) — returns week of slot availability for the landing page

router.get('/public-availability', async (req: Request, res: Response) => {
    try {
        const { startDate, days } = publicAvailabilitySchema.parse(req.query);
        const result = [];

        for (let i = 0; i < days; i++) {
            const dateObj = new Date(startDate + 'T00:00:00');
            dateObj.setUTCDate(dateObj.getUTCDate() + i);
            const dateStr = dateObj.toISOString().split('T')[0];
            result.push(await getPublicDayAvailability(dateStr));
        }

        res.json({ days: result });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Parâmetros inválidos.', details: err.errors });
            return;
        }
        throw err;
    }
});

// ─── GET /api/bookings/availability?date=YYYY-MM-DD ─────

router.get('/availability', authenticate, async (req: Request, res: Response) => {
    try {
        const { date } = availabilitySchema.parse(req.query);
        const dayAvailability = await getAuthDayAvailability(date);

        if (dayAvailability.closed) {
            res.json({ date, closed: true, slots: [] });
            return;
        }

        // Get client's own bookings for this date
        const dateObj = new Date(date + 'T00:00:00');
        const myBookings = req.user ? await prisma.booking.findMany({
            where: {
                date: dateObj,
                userId: req.user.userId,
                status: { notIn: [BookingStatus.CANCELLED] },
            },
            select: {
                id: true, startTime: true, endTime: true, status: true,
                tierApplied: true, price: true, contractId: true,
                adminNotes: true, clientNotes: true, platforms: true, platformLinks: true,
                addOns: true, holdExpiresAt: true,
            },
        }) : [];

        res.json({
            date,
            dayOfWeek: dayAvailability.dayOfWeek,
            closed: false,
            slots: dayAvailability.slots,
            myBookings,
        });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Parâmetros inválidos.', details: err.errors });
            return;
        }
        throw err;
    }
});

} // end registerAvailabilityRoutes

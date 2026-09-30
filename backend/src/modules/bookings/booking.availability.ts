import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { authenticate } from '../../middleware/auth.js';
import { BookingStatus } from '../../generated/prisma/client.js';
import { publicAvailabilitySchema, availabilitySchema } from './validators.js';
import { getPublicDayAvailability, getAuthDayAvailability } from './availability.service.js';
import { CLIENT_BOOKING_SELECT, toClientBooking } from './booking.clientView.js';

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
            // Keep the response shape stable (dayOfWeek + myBookings) so the client
            // never hits an undefined field on closed days.
            res.json({ date, dayOfWeek: dayAvailability.dayOfWeek, closed: true, slots: [], myBookings: [] });
            return;
        }

        // Get client's own bookings for this date — na MESMA forma do GET /my (booking.clientView):
        // título/capa/contrato para o card da agenda não regredir ao nome da faixa, e sem adminNotes.
        const dateObj = new Date(date + 'T00:00:00');
        const now = new Date();
        const myBookings = req.user ? (await prisma.booking.findMany({
            where: {
                date: dateObj,
                userId: req.user.userId,
                status: { notIn: [BookingStatus.CANCELLED] },
            },
            orderBy: { startTime: 'asc' },
            select: CLIENT_BOOKING_SELECT,
        })).map(b => toClientBooking(b, now)) : [];

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

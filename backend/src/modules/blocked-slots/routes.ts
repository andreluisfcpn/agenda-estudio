import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { authenticate, authorize } from '../../middleware/auth.js';

const router = Router();

// ─── Validation Schema ──────────────────────────────────

const blockSlotSchema = z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    startTime: z.string().regex(/^\d{2}:\d{2}$/),
    endTime: z.string().regex(/^\d{2}:\d{2}$/),
    reason: z.string().optional(),
});

// ─── POST /api/blocked-slots (ADMIN) ────────────────────

router.post('/', authenticate, authorize('ADMIN'), async (req: Request, res: Response) => {
    try {
        const data = blockSlotSchema.parse(req.body);

        const slot = await prisma.blockedSlot.create({
            data: {
                date: new Date(data.date + 'T00:00:00'),
                startTime: data.startTime,
                endTime: data.endTime,
                reason: data.reason,
                createdBy: req.user!.userId,
            },
        });

        res.status(201).json({
            blockedSlot: slot,
            message: 'Horário bloqueado com sucesso.',
        });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        throw err;
    }
});

// ─── GET /api/blocked-slots?date=YYYY-MM-DD ─────────────

router.get('/', authenticate, authorize('ADMIN'), async (req: Request, res: Response) => {
    const { date } = req.query;

    const where: any = {};
    if (date && typeof date === 'string') {
        where.date = new Date(date + 'T00:00:00');
    }

    const slots = await prisma.blockedSlot.findMany({
        where,
        orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
        include: {
            creator: { select: { name: true } },
        },
    });

    res.json({ blockedSlots: slots });
});

// ─── DELETE /api/blocked-slots/:id (ADMIN) ──────────────

router.delete('/:id', authenticate, authorize('ADMIN'), async (req: Request, res: Response) => {
    const id = req.params.id as string;

    await prisma.blockedSlot.delete({ where: { id } });
    res.json({ message: 'Bloqueio removido.' });
});

export default router;

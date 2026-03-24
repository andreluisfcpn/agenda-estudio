import { Router, Request, Response } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { prisma } from '../../lib/prisma';
import { authenticate, authorize } from '../../middleware/auth';

const router = Router();

// ─── GET /api/users (ADMIN) ─────────────────────────────

router.get('/', authenticate, authorize('ADMIN'), async (req: Request, res: Response) => {
    const { role } = req.query;

    const where: any = {};
    if (role && typeof role === 'string') {
        where.role = role;
    }

    const users = await prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        select: {
            id: true,
            email: true,
            name: true,
            phone: true,
            role: true,
            createdAt: true,
            _count: {
                select: { bookings: true, contracts: true },
            },
            contracts: {
                where: { status: 'ACTIVE' },
                select: { type: true },
                take: 1,
            },
        },
    });

    res.json({ users });
});

// ─── GET /api/users/:id (ADMIN) ─────────────────────────

router.get('/:id', authenticate, authorize('ADMIN'), async (req: Request, res: Response) => {
    const id = req.params.id as string;

    const user = await prisma.user.findUnique({
        where: { id },
        select: {
            id: true,
            email: true,
            name: true,
            phone: true,
            role: true,
            notes: true,
            createdAt: true,
            contracts: {
                orderBy: { createdAt: 'desc' },
                select: {
                    id: true,
                    type: true,
                    tier: true,
                    status: true,
                    startDate: true,
                    endDate: true,
                    durationMonths: true,
                    discountPct: true,
                    contractUrl: true,
                    flexCreditsTotal: true,
                    flexCreditsRemaining: true,
                },
            },
            bookings: {
                orderBy: [{ date: 'desc' }, { startTime: 'desc' }],
                select: {
                    id: true,
                    date: true,
                    startTime: true,
                    endTime: true,
                    status: true,
                    tierApplied: true,
                    price: true,
                    contractId: true,
                    adminNotes: true,
                    clientNotes: true,
                    durationMinutes: true,
                    peakViewers: true,
                    chatMessages: true,
                    audienceOrigin: true,
                },
            },
        },
    });

    if (!user) {
        res.status(404).json({ error: 'Usuário não encontrado.' });
        return;
    }

    res.json({ user });
});

// ─── POST /api/users (ADMIN create) ─────────────────────

const createUserSchema = z.object({
    email: z.string().email(),
    password: z.string().min(6),
    name: z.string().min(2),
    phone: z.string().optional(),
    role: z.enum(['ADMIN', 'CLIENTE']).optional().default('CLIENTE'),
});

router.post('/', authenticate, authorize('ADMIN'), async (req: Request, res: Response) => {
    try {
        const data = createUserSchema.parse(req.body);

        const existing = await prisma.user.findUnique({ where: { email: data.email } });
        if (existing) {
            res.status(409).json({ error: 'E-mail já cadastrado.' });
            return;
        }

        const passwordHash = await bcrypt.hash(data.password, 10);

        const user = await prisma.user.create({
            data: {
                email: data.email,
                passwordHash,
                name: data.name,
                phone: data.phone,
                role: data.role as any,
            },
            select: { id: true, email: true, name: true, phone: true, role: true, createdAt: true },
        });

        res.status(201).json({ user, message: `Usuário ${data.name} criado com sucesso.` });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        throw err;
    }
});

// ─── PATCH /api/users/:id (ADMIN update) ────────────────

const updateUserSchema = z.object({
    name: z.string().min(2).optional(),
    email: z.string().email().optional(),
    phone: z.string().optional(),
    role: z.enum(['ADMIN', 'CLIENTE']).optional(),
    password: z.string().min(6).optional(),
    notes: z.string().optional(),
});

router.patch('/:id', authenticate, authorize('ADMIN'), async (req: Request, res: Response) => {
    try {
        const id = req.params.id as string;
        const data = updateUserSchema.parse(req.body);

        const existing = await prisma.user.findUnique({ where: { id } });
        if (!existing) {
            res.status(404).json({ error: 'Usuário não encontrado.' });
            return;
        }

        // Check email uniqueness if changing
        if (data.email && data.email !== existing.email) {
            const emailTaken = await prisma.user.findUnique({ where: { email: data.email } });
            if (emailTaken) {
                res.status(409).json({ error: 'E-mail já em uso por outro usuário.' });
                return;
            }
        }

        const updateData: any = {};
        if (data.name) updateData.name = data.name;
        if (data.email) updateData.email = data.email;
        if (data.phone !== undefined) updateData.phone = data.phone;
        if (data.role) updateData.role = data.role;
        if (data.notes !== undefined) updateData.notes = data.notes;
        if (data.password) {
            updateData.passwordHash = await bcrypt.hash(data.password, 10);
        }

        const user = await prisma.user.update({
            where: { id },
            data: updateData,
            select: { id: true, email: true, name: true, phone: true, role: true, createdAt: true },
        });

        res.json({ user, message: 'Usuário atualizado com sucesso.' });
    } catch (err) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        throw err;
    }
});

// ─── DELETE /api/users/:id (ADMIN) ──────────────────────

router.delete('/:id', authenticate, authorize('ADMIN'), async (req: Request, res: Response) => {
    const id = req.params.id as string;

    // Prevent self-delete
    if (id === req.user!.userId) {
        res.status(400).json({ error: 'Você não pode excluir sua própria conta.' });
        return;
    }

    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) {
        res.status(404).json({ error: 'Usuário não encontrado.' });
        return;
    }

    try {
        // Delete related records to respect foreign key constraints
        await prisma.payment.deleteMany({ where: { userId: id } });
        await prisma.booking.deleteMany({ where: { userId: id } });
        await prisma.contract.deleteMany({ where: { userId: id } });
        await prisma.blockedSlot.deleteMany({ where: { createdBy: id } });

        // Delete user
        await prisma.user.delete({ where: { id } });

        res.json({ message: `Usuário ${user.name} excluído com sucesso.` });
    } catch (err: any) {
        console.error(`[DELETE USER ERROR]:`, err);
        res.status(500).json({ error: 'Erro ao excluir usuário.', details: err.message });
    }
});

export default router;

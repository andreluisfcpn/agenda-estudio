import { Router, Request, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { authenticate, authorize } from '../../middleware/auth.js';

export function registerUserListingRoutes(router: Router) {
    // ─── GET /api/users (ADMIN) ─────────────────────────────

    router.get('/', authenticate, authorize('ADMIN'), async (req: Request, res: Response) => {
        const { role } = req.query;

        const where: any = {};
        if (role && typeof role === 'string') {
            where.role = role;
        }

        const rawUsers = await prisma.user.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            select: {
                id: true,
                email: true,
                name: true,
                phone: true,
                role: true,
                clientStatus: true,
                tags: true,
                createdAt: true,
                _count: {
                    select: { bookings: true, contracts: true },
                },
                contracts: {
                    select: { type: true, status: true, addOns: true },
                },
                payments: {
                    select: { amount: true, status: true },
                },
            },
        });

        const users = rawUsers.map(u => {
            const totalPaid = u.payments
                .filter(p => p.status === 'PAID')
                .reduce((sum, p) => sum + p.amount, 0);
            const totalPending = u.payments
                .filter(p => p.status === 'PENDING')
                .reduce((sum, p) => sum + p.amount, 0);
            const { payments, ...rest } = u;
            return { ...rest, totalPaid, totalPending };
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
                photoUrl: true,
                cpfCnpj: true,
                address: true,
                city: true,
                state: true,
                tags: true,
                socialLinks: true,
                clientStatus: true,
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
                payments: {
                    orderBy: { createdAt: 'desc' },
                    select: {
                        id: true,
                        amount: true,
                        status: true,
                        dueDate: true,
                        createdAt: true,
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
}

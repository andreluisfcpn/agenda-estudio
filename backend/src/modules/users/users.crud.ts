import { Router, Request, Response } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { prisma } from '../../lib/prisma.js';
import { authenticate, authorize } from '../../middleware/auth.js';
import { cleanDocument, isValidCpfCnpj } from '../../utils/document.js';
import { purgeCouponRedemptionsForUser } from '../../lib/couponService.js';

/**
 * Normalizes a CPF/CNPJ to digits-only and validates the check digits.
 * Returns { ok:false } when present-but-invalid so callers can 400.
 */
function normalizeCpfCnpj(value: string | null | undefined): { ok: true; value: string | null } | { ok: false } {
    if (value === undefined) return { ok: true, value: null };
    const digits = cleanDocument(value);
    if (digits && !isValidCpfCnpj(digits)) return { ok: false };
    return { ok: true, value: digits || null };
}

// ─── POST /api/users (ADMIN create) ─────────────────────

const createUserSchema = z.object({
    email: z.string().email(),
    password: z.string().min(6),
    name: z.string().min(2),
    phone: z.string().optional(),
    role: z.enum(['ADMIN', 'CLIENTE']).optional().default('CLIENTE'),
    notes: z.string().optional(),
    cpfCnpj: z.string().optional().nullable(),
    address: z.string().optional().nullable(),
    addressNumber: z.string().optional().nullable(),
    complement: z.string().optional().nullable(),
    neighborhood: z.string().optional().nullable(),
    city: z.string().optional().nullable(),
    state: z.string().optional().nullable(),
    zipCode: z.string().optional().nullable(),
    tags: z.array(z.string()).optional(),
    socialLinks: z.string().optional().nullable(),
    clientStatus: z.enum(['ACTIVE', 'INACTIVE', 'BLOCKED']).optional(),
});

// ─── PATCH /api/users/:id (ADMIN update) ────────────────

const updateUserSchema = z.object({
    name: z.string().min(2).optional(),
    email: z.string().email().optional(),
    phone: z.string().optional(),
    role: z.enum(['ADMIN', 'CLIENTE']).optional(),
    password: z.string().min(6).optional(),
    notes: z.string().optional(),
    cpfCnpj: z.string().optional().nullable(),
    address: z.string().optional().nullable(),
    addressNumber: z.string().optional().nullable(),
    complement: z.string().optional().nullable(),
    neighborhood: z.string().optional().nullable(),
    city: z.string().optional().nullable(),
    state: z.string().optional().nullable(),
    zipCode: z.string().optional().nullable(),
    tags: z.array(z.string()).optional(),
    socialLinks: z.string().optional().nullable(),
    clientStatus: z.enum(['ACTIVE', 'INACTIVE', 'BLOCKED']).optional(),
});

export function registerUserCrudRoutes(router: Router) {
    // ─── POST /api/users (ADMIN create) ─────────────────────

    router.post('/', authenticate, authorize('ADMIN'), async (req: Request, res: Response) => {
        try {
            const data = createUserSchema.parse(req.body);

            const existing = await prisma.user.findUnique({ where: { email: data.email } });
            if (existing) {
                res.status(409).json({ error: 'E-mail já cadastrado.' });
                return;
            }

            const cpf = normalizeCpfCnpj(data.cpfCnpj);
            if (!cpf.ok) {
                res.status(400).json({ error: 'CPF/CNPJ inválido. Confira os números.' });
                return;
            }

            const passwordHash = await bcrypt.hash(data.password, 12);

            const user = await prisma.user.create({
                data: {
                    email: data.email,
                    passwordHash,
                    name: data.name,
                    phone: data.phone,
                    role: data.role as any,
                    ...(data.notes ? { notes: data.notes } : {}),
                    ...(cpf.value !== null ? { cpfCnpj: cpf.value } : {}),
                    ...(data.tags ? { tags: data.tags } : {}),
                    ...(data.socialLinks !== undefined ? { socialLinks: data.socialLinks } : {}),
                    ...(data.address !== undefined ? { address: data.address } : {}),
                    ...(data.addressNumber !== undefined ? { addressNumber: data.addressNumber } : {}),
                    ...(data.complement !== undefined ? { complement: data.complement } : {}),
                    ...(data.neighborhood !== undefined ? { neighborhood: data.neighborhood } : {}),
                    ...(data.city !== undefined ? { city: data.city } : {}),
                    ...(data.state !== undefined ? { state: data.state } : {}),
                    ...(data.zipCode !== undefined ? { zipCode: data.zipCode } : {}),
                    ...(data.clientStatus ? { clientStatus: data.clientStatus as any } : {}),
                },
                select: { id: true, email: true, name: true, phone: true, role: true, createdAt: true },
            });

            res.status(201).json({ user, message: `Usuário ${data.name} criado com sucesso.` });
        } catch (err) {
            if (err instanceof z.ZodError) {
                res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
                return;
            }
            if (err && typeof err === 'object' && (err as { code?: string }).code === 'P2002') {
                res.status(409).json({ error: 'Este CPF/CNPJ já está cadastrado em outra conta.' });
                return;
            }
            throw err;
        }
    });

    // ─── PATCH /api/users/:id (ADMIN update) ────────────────

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
            if (data.cpfCnpj !== undefined) {
                const cpf = normalizeCpfCnpj(data.cpfCnpj);
                if (!cpf.ok) {
                    res.status(400).json({ error: 'CPF/CNPJ inválido. Confira os números.' });
                    return;
                }
                updateData.cpfCnpj = cpf.value;
            }
            if (data.address !== undefined) updateData.address = data.address;
            if (data.addressNumber !== undefined) updateData.addressNumber = data.addressNumber;
            if (data.complement !== undefined) updateData.complement = data.complement;
            if (data.neighborhood !== undefined) updateData.neighborhood = data.neighborhood;
            if (data.city !== undefined) updateData.city = data.city;
            if (data.state !== undefined) updateData.state = data.state;
            if (data.zipCode !== undefined) updateData.zipCode = data.zipCode;
            if (data.tags !== undefined) updateData.tags = data.tags;
            if (data.socialLinks !== undefined) updateData.socialLinks = data.socialLinks;
            if (data.clientStatus) updateData.clientStatus = data.clientStatus;
            if (data.password) {
                updateData.passwordHash = await bcrypt.hash(data.password, 12);
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
            if (err && typeof err === 'object' && (err as { code?: string }).code === 'P2002') {
                res.status(409).json({ error: 'Este CPF/CNPJ já está cadastrado em outra conta.' });
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
            // Delete related records to respect foreign key constraints.
            // Coupon redemptions FK to payments AND users with ON DELETE RESTRICT, so they
            // must be purged (and their coupon usedCount decremented) before the payments.
            await purgeCouponRedemptionsForUser(id);
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

    // ─── GET /api/users/:id/payment-overview (ADMIN) ────────
    // The admin's window into a client's billing: auto-charge status, saved cards (last4),
    // and upcoming/overdue installments — mirrors what the client sees in "Meus Pagamentos".
    router.get('/:id/payment-overview', authenticate, authorize('ADMIN'), async (req: Request, res: Response) => {
        try {
            const userId = req.params.id as string;
            const user = await prisma.user.findUnique({
                where: { id: userId },
                select: { autoChargeEnabled: true, stripeCustomerId: true },
            });
            if (!user) { res.status(404).json({ error: 'Usuário não encontrado.' }); return; }

            const cards = await prisma.savedPaymentMethod.findMany({
                where: { userId },
                select: { id: true, brand: true, last4: true, expMonth: true, expYear: true, isDefault: true },
                orderBy: { isDefault: 'desc' },
            });

            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const duePayments = await prisma.payment.findMany({
                where: { userId, status: 'PENDING' },
                orderBy: { dueDate: 'asc' },
                take: 36,
                select: { id: true, amount: true, dueDate: true, provider: true, contract: { select: { name: true } } },
            });

            res.json({
                autoChargeEnabled: user.autoChargeEnabled,
                hasSavedCard: cards.length > 0,
                cards,
                duePayments: duePayments.map(p => ({
                    id: p.id,
                    amount: p.amount,
                    dueDate: p.dueDate,
                    overdue: p.dueDate ? p.dueDate < today : false,
                    contractName: p.contract?.name ?? 'Avulso',
                })),
            });
        } catch (err) {
            console.error('[PAYMENT-OVERVIEW]', err);
            res.status(500).json({ error: 'Erro ao carregar a visão de pagamento.' });
        }
    });

    // ─── PATCH /api/users/:id/auto-charge (ADMIN) ───────────
    // Admin toggles a client's automatic charging (requires a saved card to enable).
    router.patch('/:id/auto-charge', authenticate, authorize('ADMIN'), async (req: Request, res: Response) => {
        try {
            const userId = req.params.id as string;
            const enabled = !!req.body?.enabled;
            if (enabled) {
                const cardCount = await prisma.savedPaymentMethod.count({ where: { userId } });
                if (cardCount === 0) {
                    res.status(400).json({ error: 'O cliente precisa ter um cartão salvo para ativar a cobrança automática.' });
                    return;
                }
            }
            await prisma.user.update({ where: { id: userId }, data: { autoChargeEnabled: enabled } });
            res.json({ autoChargeEnabled: enabled });
        } catch (err) {
            console.error('[AUTO-CHARGE-TOGGLE]', err);
            res.status(500).json({ error: 'Erro ao atualizar a cobrança automática.' });
        }
    });
}

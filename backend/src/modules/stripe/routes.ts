// ─── Stripe Payment Routes ──────────────────────────────
// Client-facing routes for card management, payment intents, and subscriptions
// All routes require authentication

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { authenticate } from '../../middleware/auth';
import {
    stripeGetPublishableKey,
    stripeGetOrCreateCustomer,
    stripeCreateSetupIntent,
    stripeListPaymentMethods,
    stripeDetachPaymentMethod,
    stripeSetDefaultPaymentMethod,
    stripeCreatePaymentIntent,
    stripeGetInstallmentPlans,
    stripeGetPaymentIntent,
} from '../../lib/stripeService';

const router = Router();

// ─── GET /api/stripe/publishable-key ────────────────────
// Returns the Stripe publishable key for frontend initialization
router.get('/publishable-key', authenticate, async (_req: Request, res: Response) => {
    try {
        const key = await stripeGetPublishableKey();
        if (!key) {
            res.status(503).json({ error: 'Stripe não está configurado.' });
            return;
        }
        res.json({ publishableKey: key });
    } catch (err: any) {
        console.error('[Stripe] Error getting publishable key:', err);
        res.status(500).json({ error: 'Erro ao obter configuração Stripe.' });
    }
});

// ─── POST /api/stripe/setup-intent ──────────────────────
// Creates a SetupIntent for saving a card without charging
router.post('/setup-intent', authenticate, async (req: Request, res: Response) => {
    try {
        const userId = req.user!.userId;
        const customerId = await stripeGetOrCreateCustomer(userId);
        const result = await stripeCreateSetupIntent(customerId);

        res.json({
            clientSecret: result.clientSecret,
            setupIntentId: result.setupIntentId,
        });
    } catch (err: any) {
        console.error('[Stripe] Error creating SetupIntent:', err);
        res.status(500).json({ error: err.message || 'Erro ao criar SetupIntent.' });
    }
});

// ─── GET /api/stripe/payment-methods ────────────────────
// Lists saved cards for the authenticated user
router.get('/payment-methods', authenticate, async (req: Request, res: Response) => {
    try {
        const userId = req.user!.userId;
        const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

        if (!user.stripeCustomerId) {
            res.json({ paymentMethods: [], autoChargeEnabled: user.autoChargeEnabled });
            return;
        }

        // Use stripeGetOrCreateCustomer to verify the customer and recreate if it was deleted
        const verifiedCustomerId = await stripeGetOrCreateCustomer(userId);

        // Get cards from Stripe
        const stripeCards = await stripeListPaymentMethods(verifiedCustomerId);

        // Get saved methods from our DB for default status
        const savedMethods = await prisma.savedPaymentMethod.findMany({
            where: { userId },
            orderBy: { createdAt: 'desc' },
        });

        // Merge: enrich with isDefault from our DB
        const paymentMethods = stripeCards.map(card => {
            const saved = savedMethods.find(s => s.stripePaymentMethodId === card.paymentMethodId);
            return {
                id: saved?.id || card.paymentMethodId,
                stripePaymentMethodId: card.paymentMethodId,
                brand: card.brand,
                last4: card.last4,
                expMonth: card.expMonth,
                expYear: card.expYear,
                funding: card.funding,
                isDefault: saved?.isDefault || false,
            };
        });

        res.json({ paymentMethods, autoChargeEnabled: user.autoChargeEnabled });
    } catch (err: any) {
        console.error('[Stripe] Error listing payment methods:', err);
        res.status(500).json({ error: err.message || 'Erro ao listar cartões.' });
    }
});

// ─── DELETE /api/stripe/payment-methods/:pmId ───────────
// Detaches a card from the customer
router.delete('/payment-methods/:pmId', authenticate, async (req: Request, res: Response) => {
    try {
        const userId = req.user!.userId;
        const pmId = req.params.pmId as string;

        // Find the saved method to get the Stripe PM ID
        const saved = await prisma.savedPaymentMethod.findFirst({
            where: { userId, OR: [{ id: pmId }, { stripePaymentMethodId: pmId }] },
        });

        const stripePmId = saved?.stripePaymentMethodId || pmId;

        // Detach from Stripe
        await stripeDetachPaymentMethod(stripePmId);

        // Remove from our DB
        if (saved) {
            await prisma.savedPaymentMethod.delete({ where: { id: saved.id } });
        }

        res.json({ message: 'Cartão removido com sucesso.' });
    } catch (err: any) {
        console.error('[Stripe] Error removing payment method:', err);
        res.status(500).json({ error: err.message || 'Erro ao remover cartão.' });
    }
});

// ─── PUT /api/stripe/payment-methods/:pmId/default ──────
// Sets a card as the default payment method
router.put('/payment-methods/:pmId/default', authenticate, async (req: Request, res: Response) => {
    try {
        const userId = req.user!.userId;
        const pmId = req.params.pmId as string;

        const customerId = await stripeGetOrCreateCustomer(userId);

        // Find the Stripe PM ID
        let saved = await prisma.savedPaymentMethod.findFirst({
            where: { userId, OR: [{ id: pmId }, { stripePaymentMethodId: pmId }] },
        });
        const stripePmId = saved?.stripePaymentMethodId || pmId;

        // Set as default in Stripe
        await stripeSetDefaultPaymentMethod(customerId, stripePmId);

        // Update our DB: unset all defaults, then set this one
        await prisma.savedPaymentMethod.updateMany({
            where: { userId },
            data: { isDefault: false },
        });

        if (saved) {
            await prisma.savedPaymentMethod.update({
                where: { id: saved.id },
                data: { isDefault: true },
            });
        } else {
            // Card exists in Stripe but not in our DB — sync it now
            const cards = await stripeListPaymentMethods(customerId);
            const card = cards.find(c => c.paymentMethodId === stripePmId);
            if (card) {
                saved = await prisma.savedPaymentMethod.create({
                    data: {
                        userId,
                        stripePaymentMethodId: stripePmId,
                        brand: card.brand,
                        last4: card.last4,
                        expMonth: card.expMonth,
                        expYear: card.expYear,
                        isDefault: true,
                    },
                });
                console.log(`[Stripe] Synced + set default: ${card.brand} ****${card.last4}`);
            }
        }

        // Also sync any other Stripe cards that are missing from our DB
        const allStripeCards = await stripeListPaymentMethods(customerId);
        const existingPmIds = (await prisma.savedPaymentMethod.findMany({
            where: { userId },
            select: { stripePaymentMethodId: true },
        })).map(s => s.stripePaymentMethodId);

        for (const sc of allStripeCards) {
            if (!existingPmIds.includes(sc.paymentMethodId)) {
                await prisma.savedPaymentMethod.create({
                    data: {
                        userId,
                        stripePaymentMethodId: sc.paymentMethodId,
                        brand: sc.brand,
                        last4: sc.last4,
                        expMonth: sc.expMonth,
                        expYear: sc.expYear,
                        isDefault: false,
                    },
                });
                console.log(`[Stripe] Synced missing card: ${sc.brand} ****${sc.last4}`);
            }
        }

        res.json({ message: 'Cartão padrão definido.' });
    } catch (err: any) {
        console.error('[Stripe] Error setting default:', err);
        res.status(500).json({ error: err.message || 'Erro ao definir cartão padrão.' });
    }
});

// ─── POST /api/stripe/create-payment ────────────────────
// Creates a PaymentIntent for paying a specific internal Payment
const createPaymentSchema = z.object({
    paymentId: z.string().uuid(),
    installments: z.number().min(1).max(12).optional(),
    savedPaymentMethodId: z.string().optional(),
    savePaymentMethod: z.boolean().optional(),
    paymentMethod: z.enum(['cartao', 'pix', 'boleto']).optional().default('cartao'),
});

router.post('/create-payment', authenticate, async (req: Request, res: Response) => {
    try {
        const data = createPaymentSchema.parse(req.body);
        const userId = req.user!.userId;

        // Global guard: reject if the payment method is disabled by admin
        const { validatePaymentMethod, PaymentMethodDisabledError } = await import('../../lib/paymentGateway');
        try {
            await validatePaymentMethod(data.paymentMethod);
        } catch (err) {
            if (err instanceof PaymentMethodDisabledError) {
                res.status(400).json({ error: err.message });
                return;
            }
            throw err;
        }

        // Get our internal payment
        const payment = await prisma.payment.findFirst({
            where: { id: data.paymentId, userId },
            include: { contract: true },
        });

        if (!payment) {
            res.status(404).json({ error: 'Pagamento não encontrado.' });
            return;
        }

        if (payment.status === 'PAID') {
            res.status(400).json({ error: 'Este pagamento já foi realizado.' });
            return;
        }

        // Get or create Stripe Customer
        const customerId = await stripeGetOrCreateCustomer(userId);

        if (data.paymentMethod === 'pix') {
            // Use Cora API for PIX instead of Stripe
            const { coraCreateBoleto } = await import('../../lib/coraService');
            
            // Re-fetch user properly to ensure we have cpfCnpj, address, etc.
            const user = await prisma.user.findUnique({ where: { id: userId } });
            
            if (!user) {
                res.status(404).json({ error: 'Usuário não encontrado.' });
                return;
            }
            
            // Format CPF/CNPJ for Cora explicitly
            let docStr = user.cpfCnpj ? user.cpfCnpj.replace(/\D/g, '') : "";
            // Reject if CPF/CNPJ is not valid (must be 11 or 14 digits)
            if (docStr.length !== 11 && docStr.length !== 14) {
                res.status(400).json({ error: 'CPF/CNPJ não cadastrado ou inválido. Atualize seu perfil antes de pagar com PIX.' });
                return;
            }
            let docType: 'CPF' | 'CNPJ' = docStr.length === 14 ? 'CNPJ' : 'CPF';
            
            const dueDate = new Date();
            dueDate.setDate(dueDate.getDate() + 1); // PIX expires tomorrow
            
            // Parse user address from JSON profile field
            let addressData: any = undefined;
            if (user.address) {
                try {
                    const addr = JSON.parse(user.address);
                    addressData = {
                        street: addr.street || 'N/A',
                        number: addr.number || 'S/N',
                        district: addr.district || 'Centro',
                        city: addr.city || user.city || 'Cidade',
                        state: addr.state || user.state || 'RJ',
                        zipCode: (addr.zipCode || addr.cep || '00000000').replace(/\D/g, ''),
                    };
                } catch { /* use fallback */ }
            }
            if (!addressData) {
                addressData = {
                    street: 'N/A',
                    number: 'S/N',
                    district: 'Centro',
                    city: user.city || 'Cidade',
                    state: user.state || 'RJ',
                    zipCode: '00000000',
                };
            }
            
            const result = await coraCreateBoleto({
                amount: payment.amount,
                dueDate: dueDate.toISOString().split('T')[0],
                description: `Pagamento PIX - ${payment.contract?.name || 'Avulso'}`,
                withPixQrCode: true,
                customer: {
                    name: user.name,
                    email: user.email || 'cliente@estudio.com',
                    document: { type: docType, identity: docStr },
                    address: addressData
                }
            });
            
            // Update our payment
            await prisma.payment.update({
                where: { id: payment.id },
                data: {
                    providerRef: result.id,
                    provider: 'CORA',
                    installments: 1,
                    pixString: result.pixString,
                },
            });
            
            res.json({
                provider: 'CORA',
                pixString: result.pixString,
                qrCodeBase64: result.qrCodeBase64,
                paymentId: payment.id // send back so frontend knows it's cora
            });
            return;
        }

        // ─── BOLETO: Cora boleto puro ────────────────────────
        if (data.paymentMethod === 'boleto') {
            const { coraCreateBoleto } = await import('../../lib/coraService');

            const user = await prisma.user.findUnique({ where: { id: userId } });
            if (!user) {
                res.status(404).json({ error: 'Usuário não encontrado.' });
                return;
            }

            let docStr = user.cpfCnpj ? user.cpfCnpj.replace(/\D/g, '') : "";
            if (docStr.length !== 11 && docStr.length !== 14) {
                res.status(400).json({ error: 'CPF/CNPJ não cadastrado ou inválido. Atualize o perfil do cliente antes de emitir boleto.' });
                return;
            }
            let docType: 'CPF' | 'CNPJ' = docStr.length === 14 ? 'CNPJ' : 'CPF';

            const dueDate = new Date();
            dueDate.setDate(dueDate.getDate() + 3); // Boleto vence em 3 dias

            // Parse user address from JSON profile field
            let addressData: any = undefined;
            if (user.address) {
                try {
                    const addr = JSON.parse(user.address);
                    addressData = {
                        street: addr.street || 'N/A',
                        number: addr.number || 'S/N',
                        district: addr.district || 'Centro',
                        city: addr.city || user.city || 'Cidade',
                        state: addr.state || user.state || 'RJ',
                        zipCode: (addr.zipCode || addr.cep || '00000000').replace(/\D/g, ''),
                    };
                } catch { /* use fallback */ }
            }
            if (!addressData) {
                addressData = {
                    street: 'N/A',
                    number: 'S/N',
                    district: 'Centro',
                    city: user.city || 'Cidade',
                    state: user.state || 'RJ',
                    zipCode: '00000000',
                };
            }

            const result = await coraCreateBoleto({
                amount: payment.amount,
                dueDate: dueDate.toISOString().split('T')[0],
                description: `Boleto - ${payment.contract?.name || 'Avulso'}`,
                withPixQrCode: false,
                customer: {
                    name: user.name,
                    email: user.email || 'cliente@estudio.com',
                    document: { type: docType, identity: docStr },
                    address: addressData
                }
            });

            await prisma.payment.update({
                where: { id: payment.id },
                data: {
                    providerRef: result.id,
                    provider: 'CORA',
                    installments: 1,
                    boletoUrl: result.boletoUrl,
                },
            });

            res.json({
                provider: 'CORA',
                boletoUrl: result.boletoUrl,
                barcode: result.barcode,
                paymentId: payment.id
            });
            return;
        }

        // Determine amount (with installment fees if applicable)
        let amount = payment.amount;
        let contractMonths = payment.contract?.durationMonths || 0;
        let installments = data.installments || 1;

        if (data.paymentMethod === 'cartao' && installments > 1 && installments > contractMonths) {
            // Client pays fees — get rate from BusinessConfig
            const plans = await stripeGetInstallmentPlans(amount, contractMonths);
            const plan = plans.find(p => p.count === installments);
            if (plan) amount = plan.total;
        }

        // Create PaymentIntent (CARDS ONLY now)
        const result = await stripeCreatePaymentIntent({
            amount,
            customerId,
            description: `Pagamento - ${payment.contract?.name || 'Avulso'}`,
            paymentId: payment.id,
            userId,
            contractId: payment.contractId || undefined,
            installmentsEnabled: true,
            savedPaymentMethodId: data.savedPaymentMethodId,
            savePaymentMethod: data.savePaymentMethod,
        });

        // Update our payment with the Stripe reference
        await prisma.payment.update({
            where: { id: payment.id },
            data: {
                providerRef: result.paymentIntentId,
                provider: 'STRIPE',
                installments,
            },
        });

        res.json({
            provider: 'STRIPE',
            clientSecret: result.clientSecret,
            paymentIntentId: result.paymentIntentId,
        });
    } catch (err: any) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        console.error('[Stripe] Error creating payment:', err);
        res.status(500).json({ error: err.message || 'Erro ao criar pagamento.' });
    }
});

// ─── POST /api/stripe/installment-plans ─────────────────
// Returns available installment plans for a given payment
const installmentSchema = z.object({
    paymentId: z.string().uuid().optional(),
    amount: z.number().min(100).optional(),
    contractDurationMonths: z.number().min(1).max(12).optional(),
});

router.post('/installment-plans', authenticate, async (req: Request, res: Response) => {
    try {
        const data = installmentSchema.parse(req.body);
        let amount = data.amount || 0;
        let contractMonths = data.contractDurationMonths || 0;

        // If a paymentId is given, derive amount and contract duration
        if (data.paymentId) {
            const payment = await prisma.payment.findFirst({
                where: { id: data.paymentId, userId: req.user!.userId },
                include: { contract: true },
            });
            if (!payment) {
                res.status(404).json({ error: 'Pagamento não encontrado.' });
                return;
            }
            amount = payment.amount;
            contractMonths = payment.contract?.durationMonths || 0;
        }

        if (amount <= 0) {
            res.status(400).json({ error: 'Valor inválido.' });
            return;
        }

        const plans = await stripeGetInstallmentPlans(amount, contractMonths);
        res.json({ plans });
    } catch (err: any) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.', details: err.errors });
            return;
        }
        res.status(500).json({ error: 'Erro ao calcular parcelas.' });
    }
});

// ─── PUT /api/stripe/auto-charge ────────────────────────
// Toggle automatic off-session charging (opt-in by client)
const autoChargeSchema = z.object({
    enabled: z.boolean(),
});

router.put('/auto-charge', authenticate, async (req: Request, res: Response) => {
    try {
        const { enabled } = autoChargeSchema.parse(req.body);
        const userId = req.user!.userId;

        // Verify user has at least one saved card if enabling
        if (enabled) {
            const savedCards = await prisma.savedPaymentMethod.count({
                where: { userId },
            });
            if (savedCards === 0) {
                res.status(400).json({ error: 'Adicione pelo menos um cartão antes de ativar a cobrança automática.' });
                return;
            }
        }

        await prisma.user.update({
            where: { id: userId },
            data: { autoChargeEnabled: enabled },
        });

        res.json({
            message: enabled
                ? 'Cobrança automática ativada. Seu cartão padrão será cobrado no vencimento.'
                : 'Cobrança automática desativada.',
        });
    } catch (err: any) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.' });
            return;
        }
        res.status(500).json({ error: 'Erro ao atualizar preferência.' });
    }
});

// ─── POST /api/stripe/verify-payment ────────────────────
// Manually verifies a payment intent with Stripe and forces DB update
// if the webhook hasn't arrived yet.
const verifyPaymentSchema = z.object({
    paymentId: z.string().uuid(),
    paymentIntentId: z.string(),
});

router.post('/verify-payment', authenticate, async (req: Request, res: Response) => {
    try {
        const data = verifyPaymentSchema.parse(req.body);
        const userId = req.user!.userId;

        const payment = await prisma.payment.findUnique({ where: { id: data.paymentId, userId } });
        if (!payment) {
            res.status(404).json({ error: 'Pagamento não encontrado.' });
            return;
        }

        if (payment.status === 'PAID') {
            res.json({ status: 'PAID', message: 'Já pago.' });
            return;
        }

        const pi = await stripeGetPaymentIntent(data.paymentIntentId);
        
        if (pi.status === 'succeeded') {
            // Atomic update: only update if still PENDING to prevent race with webhooks
            const updated = await prisma.payment.updateMany({
                where: { id: payment.id, status: 'PENDING' },
                data: {
                    status: 'PAID',
                    paidAt: new Date(),
                    providerRef: pi.id,
                    paymentType: pi.payment_method_types?.includes('card') ? 'CREDIT' : null,
                },
            });

            // Unlock progressive bookings if needed
            if (payment.contractId) {
                try {
                    const contract = await prisma.contract.findUnique({
                        where: { id: payment.contractId },
                        select: { accessMode: true, startDate: true },
                    });

                    if (contract && contract.accessMode === 'PROGRESSIVE') {
                        const reservedBookings = await prisma.booking.findMany({
                            where: { contractId: payment.contractId, status: 'RESERVED' },
                            orderBy: { date: 'asc' }, take: 20,
                        });

                        if (reservedBookings.length > 0) {
                            const firstDate = reservedBookings[0].date;
                            const cycleEnd = new Date(firstDate);
                            cycleEnd.setDate(cycleEnd.getDate() + 28);
                            const toConfirm = reservedBookings.filter(b => b.date < cycleEnd);

                            if (toConfirm.length > 0) {
                                await prisma.booking.updateMany({
                                    where: { id: { in: toConfirm.map(b => b.id) } },
                                    data: { status: 'CONFIRMED' },
                                });
                            }
                        }
                    }
                } catch (err) {
                    console.error('[Stripe:Verify] Error unlocking bookings:', err);
                }
            }

            console.log(`[Stripe:Verify] Manually verified payment ${payment.id} as PAID`);
            res.json({ status: 'PAID', message: 'Pagamento sincronizado.' });
            return;
        }
        
        res.json({ status: payment.status, message: 'Ainda não confirmado no Stripe.' });
    } catch (err: any) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'Dados inválidos.' });
            return;
        }
        console.error('[Stripe] Verify Error:', err);
        res.status(500).json({ error: 'Erro ao verificar sincronicidade do Stripe.' });
    }
});

export default router;
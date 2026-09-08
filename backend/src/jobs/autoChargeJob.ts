import { prisma } from '../lib/prisma.js';
import { notifyEvent } from '../modules/notifications/notificationService.js';
import { stripeChargeOffSession } from '../lib/stripeService.js';
import { onPaymentConfirmed } from '../lib/paymentEffects.js';

/**
 * Auto-Charge Job — runs daily.
 *
 * For every PENDING contract installment whose dueDate has arrived, if the client opted
 * into auto-charge (User.autoChargeEnabled) AND has a saved card, charge their default
 * card OFF-SESSION via Stripe. On synchronous success the payment is confirmed atomically
 * (PENDING→PAID → onPaymentConfirmed, exactly once even if the webhook also fires); on a
 * decline / authentication-required the client is notified to pay manually.
 *
 * Idempotency: Stripe's Idempotency-Key embeds paymentId+amount (see stripeCreatePaymentIntent),
 * so re-running across days never double-charges — a repeat returns the same PaymentIntent.
 */
export async function runAutoChargeJob(): Promise<void> {
    const now = new Date();
    const endOfToday = new Date(now);
    endOfToday.setHours(23, 59, 59, 999);

    const duePayments = await prisma.payment.findMany({
        where: {
            status: 'PENDING',
            dueDate: { lte: endOfToday },
            contractId: { not: null },
            // B1: parcelas de assinatura Stripe (têm stripeSubscriptionId) são cobradas pelo próprio
            // Stripe via invoice recorrente — o auto-charge NÃO deve tocá-las, senão cobra em dobro.
            stripeSubscriptionId: null,
            // Nunca cobrar parcelas de contratos pausados / em cancelamento / cancelados.
            // (ACTIVE, AWAITING_PAYMENT e EXPIRED seguem cobráveis — evita parar a cobrança da
            // 1ª parcela e da parcela final de um contrato recém-expirado.)
            contract: { status: { notIn: ['PAUSED', 'PENDING_CANCELLATION', 'CANCELLED'] } },
            user: { autoChargeEnabled: true, stripeCustomerId: { not: null } },
        },
        include: { user: { select: { id: true, name: true, stripeCustomerId: true } } },
        orderBy: { dueDate: 'asc' },
        take: 200,
    });

    let charged = 0, failed = 0, skipped = 0;

    for (const p of duePayments) {
        const customerId = p.user.stripeCustomerId;
        if (!customerId) { skipped++; continue; }

        // Prefer the default saved card; fall back to the most recent one.
        const card = (await prisma.savedPaymentMethod.findFirst({ where: { userId: p.userId, isDefault: true } }))
            ?? (await prisma.savedPaymentMethod.findFirst({ where: { userId: p.userId }, orderBy: { createdAt: 'desc' } }));
        if (!card) { skipped++; continue; } // no saved card → client pays manually

        try {
            const result = await stripeChargeOffSession(customerId, card.stripePaymentMethodId, p.amount, {
                paymentId: p.id,
                userId: p.userId,
                contractId: p.contractId ?? '',
                description: 'Cobrança automática de parcela',
            });

            if (result.status === 'succeeded') {
                // Atomic PENDING→PAID guard so the off-session charge and a late webhook
                // can't both run the confirmation effects.
                const upd = await prisma.payment.updateMany({
                    where: { id: p.id, status: 'PENDING' },
                    data: { status: 'PAID', paidAt: new Date(), provider: 'STRIPE', providerRef: result.paymentIntentId },
                });
                if (upd.count > 0) {
                    await onPaymentConfirmed(p.id);
                    charged++;
                }
            } else {
                // 'processing' — record the ref and let the webhook finish it.
                // (3DS off-session NÃO chega aqui: o Stripe LANÇA authentication_required
                //  em confirm+off_session; esse caso é tratado no catch abaixo.)
                await prisma.payment.update({
                    where: { id: p.id },
                    data: { provider: 'STRIPE', providerRef: result.paymentIntentId },
                });
            }
        } catch (err) {
            // 3DS off-session: o Stripe LANÇA StripeCardError code 'authentication_required'
            // (o PI vem em err.raw.payment_intent) — não retorna status 'requires_action'.
            // Persiste o PI e avisa o cliente para autenticar/pagar manualmente, em vez da
            // mensagem genérica de "cartão recusado".
            const se = err as { code?: string; raw?: { payment_intent?: { id?: string } }; payment_intent?: { id?: string } };
            if (se?.code === 'authentication_required') {
                const piId = se.raw?.payment_intent?.id ?? se.payment_intent?.id;
                if (piId) {
                    await prisma.payment.update({
                        where: { id: p.id },
                        data: { provider: 'STRIPE', providerRef: piId },
                    }).catch(() => {});
                }
                await notifyEvent('auto_charge_authentication', {
                    userId: p.userId,
                    entityType: 'payment',
                    entityId: p.id,
                }).catch(() => {});
                continue; // não conta como falha genérica
            }

            failed++;
            const msg = err instanceof Error ? err.message : 'Falha na cobrança automática.';
            console.error(`[AUTO-CHARGE] Payment ${p.id} failed:`, msg);
            await notifyEvent('auto_charge_failed', {
                userId: p.userId,
                entityType: 'payment',
                entityId: p.id,
            }).catch(() => {});
        }
    }

    if (charged || failed || skipped) {
        console.log(`[AUTO-CHARGE] charged=${charged} failed=${failed} skipped=${skipped} of ${duePayments.length} due`);
    }
}

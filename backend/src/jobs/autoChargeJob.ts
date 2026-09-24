import { prisma } from '../lib/prisma.js';
import { notifyEvent } from '../modules/notifications/notificationService.js';
import { stripeChargeOffSession } from '../lib/stripeService.js';
import { onPaymentConfirmed } from '../lib/paymentEffects.js';
import { isPixProvider, retirePixCharge, pixMetadataAfterDiscard, cardIntentInFlight, cardChargeBaseAmount } from '../lib/pixGateway.js';

/**
 * Auto-Charge Job — runs daily.
 *
 * For every PENDING installment of an ACTIVE/COMPLETED/EXPIRED contract — and of a client-started
 * RENEWAL still AWAITING_PAYMENT (3-day deadline; regressoes-2) — whose dueDate has arrived, if the
 * client opted into auto-charge (User.autoChargeEnabled) AND has a saved card, charge their default
 * card OFF-SESSION via Stripe. On synchronous success the payment is confirmed atomically
 * (PENDING→PAID → onPaymentConfirmed, exactly once even if the webhook also fires); on a
 * decline / authentication-required the client is notified to pay manually.
 *
 * Never charged: the short-lived hires still AWAITING_PAYMENT (serviço, personalizado do cliente,
 * avulso — 10-min deadline, D2: their first payment is made by the client in the checkout).
 *
 * Before charging the card (pagamentos-5): an installment with a LIVE PIX QR (the client may be paying
 * it right now) is skipped this round; an older PIX charge is reconciled + cancelled at the provider
 * first (already paid → no card charge; could not be cancelled → skipped). A card PaymentIntent of the
 * same installment still in flight (processing / 3DS) is also skipped.
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
            // Nunca cobrar parcelas de contratos pausados / em cancelamento / cancelados. AGUARDANDO
            // PAGAMENTO: só a RENOVAÇÃO iniciada pelo cliente (prazo de 3 dias) segue cobrável, como antes
            // do D2; as contratações de prazo curto (serviço, personalizado do cliente, avulso — 10 min)
            // nunca são cobradas off-session: o 1º pagamento parte do cliente e a varredura as apaga.
            // ACTIVE, COMPLETED (D6) e EXPIRED seguem cobráveis (parcelas pendentes continuam).
            contract: {
                status: { notIn: ['PAUSED', 'PENDING_CANCELLATION', 'CANCELLED'] },
                NOT: { status: 'AWAITING_PAYMENT', renewedFromId: null },
            },
            user: { autoChargeEnabled: true, stripeCustomerId: { not: null } },
        },
        include: {
            user: { select: { id: true, name: true, stripeCustomerId: true } },
            contract: { select: { type: true, paymentPlan: true, paymentMethod: true } },
        },
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

        // pagamentos-5: cobrança PIX desta parcela. QR vivo → o cliente pode estar pagando agora: não
        // cobra o cartão nesta rodada. Cobrança anterior → concilia (paga → os efeitos já confirmaram) e
        // cancela no provedor antes do cartão; se não der para cancelar, tenta na próxima rodada.
        if (isPixProvider(p.provider) && p.providerRef) {
            if (p.pixExpiresAt && p.pixExpiresAt.getTime() > Date.now()) { skipped++; continue; }
            try {
                const retired = await retirePixCharge(p.id);
                if (retired === 'paid' || retired === 'live') { skipped++; continue; }
            } catch (err) {
                console.warn(`[AUTO-CHARGE] Payment ${p.id}: não foi possível conciliar o PIX — tenta na próxima rodada:`, err instanceof Error ? err.message : err);
                skipped++;
                continue;
            }
        }
        // Cartão desta parcela ainda em andamento (processando / 3DS do cliente) → não cobra outro.
        if (p.provider === 'STRIPE' && await cardIntentInFlight(p.providerRef)) { skipped++; continue; }

        // D1: "à vista" criado com desconto PIX é cobrado no cartão SEM o desconto (pagamentos-3).
        const chargeAmount = await cardChargeBaseAmount(p);
        // Valor zero (cupom 100%) não é cobrança: nunca vai ao cartão nem gera aviso de falha.
        if (chargeAmount <= 0) { skipped++; continue; }
        const pixDiscardMeta = pixMetadataAfterDiscard(p);
        // Cartão não tem QR: descarta o PIX aposentado (o próximo QR sai com txid novo).
        const cardFields = {
            provider: 'STRIPE' as const,
            chargedAmount: chargeAmount,
            pixString: null,
            pixExpiresAt: null,
            ...(pixDiscardMeta !== undefined ? { metadata: pixDiscardMeta } : {}),
        };

        try {
            const result = await stripeChargeOffSession(customerId, card.stripePaymentMethodId, chargeAmount, {
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
                    data: { ...cardFields, status: 'PAID', paidAt: new Date(), providerRef: result.paymentIntentId },
                });
                if (upd.count > 0) {
                    await onPaymentConfirmed(p.id);
                    charged++;
                }
            } else {
                // 'processing' — record the ref and let the webhook finish it.
                // (3DS off-session NÃO chega aqui: o Stripe LANÇA authentication_required
                //  em confirm+off_session; esse caso é tratado no catch abaixo.)
                await prisma.payment.updateMany({
                    where: { id: p.id, status: 'PENDING' },
                    data: { ...cardFields, providerRef: result.paymentIntentId },
                });
            }
        } catch (err) {
            // O Stripe LANÇA na recusa/3DS off-session (o PI vem em err.raw.payment_intent). Grava o PI
            // como a cobrança atual da parcela: o webhook payment_intent.payment_failed só falha a linha
            // cujo providerRef é o PI recusado (pagamentos-6).
            const se = err as { code?: string; raw?: { payment_intent?: { id?: string } }; payment_intent?: { id?: string } };
            const piId = se?.raw?.payment_intent?.id ?? se?.payment_intent?.id;
            if (piId) {
                await prisma.payment.updateMany({
                    where: { id: p.id, status: 'PENDING' },
                    data: { ...cardFields, providerRef: piId },
                }).catch(() => {});
            }
            // 3DS off-session: avisa o cliente para autenticar/pagar manualmente, em vez da mensagem
            // genérica de "cartão recusado".
            if (se?.code === 'authentication_required') {
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

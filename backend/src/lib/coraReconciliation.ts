// ─── Cora Payment Reconciliation ────────────────────────────────────────
// Source-of-truth verification of Cora invoices via the authenticated (mTLS)
// Cora API. Used both as a webhook-independent safety net (cron + on-demand
// polling) AND as the *authentication* mechanism for the Cora webhook: because
// Cora's Direct Integration secures callbacks via mTLS/allowlist (not an HMAC
// header the app can configure), we never trust the webhook body — we re-read
// the real invoice state from Cora before marking anything PAID/FAILED.

import { prisma } from './prisma.js';
import { coraGetBoleto } from './coraService.js';
import { onPaymentConfirmed, notifyPaymentFailed } from './paymentEffects.js';

const CORA_PAID_STATUSES = new Set(['PAID', 'SETTLED', 'CLOSED', 'RECEIVED']);
const CORA_CANCELLED_STATUSES = new Set(['CANCELLED', 'CANCELED', 'EXPIRED', 'VOID']);

export function isCoraInvoicePaid(invoice: any): boolean {
    if (!invoice) return false;
    const status = String(invoice.status || '').toUpperCase();
    if (CORA_PAID_STATUSES.has(status)) return true;
    // Fallback: amount fully covered
    const totalPaid = Number(invoice.total_paid);
    const totalAmount = Number(invoice.total_amount);
    if (Number.isFinite(totalPaid) && Number.isFinite(totalAmount) && totalAmount > 0 && totalPaid >= totalAmount) {
        return true;
    }
    return false;
}

export function isCoraInvoiceCancelled(invoice: any): boolean {
    if (!invoice) return false;
    return CORA_CANCELLED_STATUSES.has(String(invoice.status || '').toUpperCase());
}

/**
 * Verify a single Cora payment against the Cora API and mark it PAID
 * (running all confirmation effects) if Cora confirms payment.
 * Returns true if it transitioned PENDING→PAID. Idempotent & safe to retry.
 */
export async function reconcileCoraPayment(paymentId: string): Promise<boolean> {
    const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment || payment.status !== 'PENDING' || payment.provider !== 'CORA' || !payment.providerRef) {
        return false;
    }

    let invoice: any;
    try {
        invoice = await coraGetBoleto(payment.providerRef);
    } catch (err) {
        console.error(`[Cora-Reconcile] getBoleto(${payment.providerRef}) failed:`, err instanceof Error ? err.message : err);
        return false;
    }

    if (!isCoraInvoicePaid(invoice)) return false;

    // Atomic PENDING→PAID guard prevents double-processing with the cron / webhook
    const updated = await prisma.payment.updateMany({
        where: { id: payment.id, status: 'PENDING' },
        data: { status: 'PAID', paidAt: new Date() },
    });
    if (updated.count === 0) return false;

    console.log(`[Cora-Reconcile] Payment ${payment.id} confirmed PAID via Cora API (invoice ${payment.providerRef})`);
    await onPaymentConfirmed(payment.id);
    return true;
}

/**
 * Verify a Cora payment is genuinely cancelled/expired before failing it.
 * Returns true if it transitioned PENDING→FAILED.
 */
export async function reconcileCoraCancellation(paymentId: string): Promise<boolean> {
    const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment || payment.status !== 'PENDING' || payment.provider !== 'CORA' || !payment.providerRef) {
        return false;
    }

    let invoice: any;
    try {
        invoice = await coraGetBoleto(payment.providerRef);
    } catch (err) {
        console.error(`[Cora-Reconcile] getBoleto(${payment.providerRef}) failed (cancel check):`, err instanceof Error ? err.message : err);
        return false;
    }

    // If it's actually paid, confirm instead of failing
    if (isCoraInvoicePaid(invoice)) {
        await reconcileCoraPayment(paymentId);
        return false;
    }
    if (!isCoraInvoiceCancelled(invoice)) return false;

    const updated = await prisma.payment.updateMany({
        where: { id: payment.id, status: 'PENDING' },
        data: { status: 'FAILED' },
    });
    if (updated.count === 0) return false;

    console.log(`[Cora-Reconcile] Payment ${payment.id} marked FAILED (invoice ${payment.providerRef} cancelled/expired)`);
    await notifyPaymentFailed(payment, 'Seu boleto/PIX foi cancelado ou expirou. Gere um novo em Meus Pagamentos.');
    return true;
}

/**
 * Cron sweep: reconcile recent pending Cora payments whose webhook may have
 * been missed. Bounded window + cap to keep API usage sane.
 */
export async function reconcilePendingCoraPayments(): Promise<number> {
    const since = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000); // last 3 days
    const pending = await prisma.payment.findMany({
        where: {
            provider: 'CORA',
            status: 'PENDING',
            providerRef: { not: null },
            createdAt: { gte: since },
        },
        select: { id: true },
        take: 200,
    });

    let confirmed = 0;
    for (const p of pending) {
        try {
            if (await reconcileCoraPayment(p.id)) confirmed++;
        } catch { /* continue with the next */ }
    }
    if (confirmed > 0) {
        console.log(`[Cora-Reconcile] Sweep confirmed ${confirmed}/${pending.length} pending Cora payment(s).`);
    }
    return confirmed;
}

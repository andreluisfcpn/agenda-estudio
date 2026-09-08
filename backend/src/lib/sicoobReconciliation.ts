// ─── Sicoob Payment Reconciliation ──────────────────────
// Verificação por fonte-de-verdade das cobranças PIX via API autenticada do Sicoob.
// Usada como rede de segurança (cron + polling) E como autenticação do webhook:
// nunca confiamos no corpo do webhook — relemos GET /cob/{txid} antes de dar baixa.

import { prisma } from './prisma.js';
import { sicoobGetCob } from './sicoobService.js';
import { onPaymentConfirmed, notifyPaymentExpired } from './paymentEffects.js';
import { releaseCouponForPayment } from './couponService.js';

/** Soma dos valores efetivamente pagos (array pix[]) em centavos. */
function paidCentsFromCob(cob: any): number {
    if (!cob || !Array.isArray(cob.pix)) return 0;
    return cob.pix.reduce((sum: number, p: any) => {
        const v = Number(p?.valor);
        return sum + (Number.isFinite(v) ? Math.round(v * 100) : 0);
    }, 0);
}

export function isSicoobCobPaid(cob: any): boolean {
    if (!cob) return false;
    const status = String(cob.status || '').toUpperCase();
    if (status === 'CONCLUIDA') return true;
    // Fallback: valor já recebido cobre o valor original.
    const paid = paidCentsFromCob(cob);
    const original = Math.round(Number(cob?.valor?.original) * 100);
    if (paid > 0 && Number.isFinite(original) && original > 0 && paid >= original) return true;
    return false;
}

export function isSicoobCobCancelled(cob: any): boolean {
    if (!cob) return false;
    // REMOVIDA_PELO_USUARIO_RECEBEDOR | REMOVIDA_PELO_PSP
    return String(cob.status || '').toUpperCase().startsWith('REMOVIDA');
}

// Margem: um pagamento feito no último segundo pode levar alguns segundos para refletir no cob
// (pix[]/status), então só consideramos "expirada" um tempo APÓS a expiração declarada.
const EXPIRY_GRACE_MS = 2 * 60 * 1000;

/**
 * A cobrança imediata EXPIROU sem pagamento? Uma cob imediata expirada permanece com status ATIVA
 * no Sicoob (não vira REMOVIDA), então sem esta checagem um PIX não pago ficaria PENDING até o sweep
 * de 72h desistir. Usa `calendario.criacao` (ISO) + `calendario.expiracao` (segundos) + margem.
 */
export function isSicoobCobExpired(cob: any, now: Date = new Date()): boolean {
    if (!cob) return false;
    const criacaoMs = Date.parse(cob?.calendario?.criacao ?? '');
    const expiracao = Number(cob?.calendario?.expiracao);
    if (!Number.isFinite(criacaoMs) || !Number.isFinite(expiracao) || expiracao <= 0) return false;
    return now.getTime() > criacaoMs + expiracao * 1000 + EXPIRY_GRACE_MS;
}

/**
 * Verifica um pagamento Sicoob contra a API e marca PAID (rodando os efeitos de
 * confirmação) se o Sicoob confirmar. Idempotente e seguro para repetir.
 */
export async function reconcileSicoobPayment(paymentId: string): Promise<boolean> {
    const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment || payment.status !== 'PENDING' || payment.provider !== 'SICOOB' || !payment.providerRef) {
        return false;
    }

    let cob: any;
    try {
        cob = await sicoobGetCob(payment.providerRef);
    } catch (err) {
        console.error(`[Sicoob-Reconcile] getCob(${payment.providerRef}) falhou:`, err instanceof Error ? err.message : err);
        return false;
    }

    if (!isSicoobCobPaid(cob)) return false;

    // Checagem de valor antes de marcar PAID (paridade com Cora/Stripe). Compara o valor
    // recebido (pix[]) OU o original da cobrança com o valor do Payment. Tolerância de 1 centavo.
    const paidCents = paidCentsFromCob(cob);
    const originalCents = Math.round(Number(cob?.valor?.original) * 100);
    const cobAmount = paidCents > 0 ? paidCents : originalCents;
    if (Number.isFinite(cobAmount) && cobAmount > 0 && Math.abs(cobAmount - payment.amount) > 1) {
        console.error(`[Sicoob-Reconcile][SECURITY] Valor divergente: cob=${cobAmount}, DB=${payment.amount} (payment ${payment.id}) — recusando marcar PAID`);
        return false;
    }

    const updated = await prisma.payment.updateMany({
        where: { id: payment.id, status: 'PENDING' },
        data: { status: 'PAID', paidAt: new Date() },
    });
    if (updated.count === 0) return false;

    console.log(`[Sicoob-Reconcile] Payment ${payment.id} confirmado PAID via Sicoob (txid ${payment.providerRef})`);
    await onPaymentConfirmed(payment.id);
    return true;
}

/** Verifica se a cobrança foi genuinamente removida/expirada antes de falhar o pagamento. */
export async function reconcileSicoobCancellation(paymentId: string): Promise<boolean> {
    const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment || payment.status !== 'PENDING' || payment.provider !== 'SICOOB' || !payment.providerRef) {
        return false;
    }

    let cob: any;
    try {
        cob = await sicoobGetCob(payment.providerRef);
    } catch (err) {
        console.error(`[Sicoob-Reconcile] getCob(${payment.providerRef}) falhou (cancel):`, err instanceof Error ? err.message : err);
        return false;
    }

    if (isSicoobCobPaid(cob)) {
        await reconcileSicoobPayment(paymentId);
        return false;
    }
    // Falha o pagamento se a cobrança foi REMOVIDA (cancelada) OU EXPIROU sem pagamento. A cobrança
    // imediata expirada fica ATIVA no Sicoob (não vira REMOVIDA); sem a checagem de expiração o
    // pagamento não pago ficaria PENDING até o sweep de 72h desistir.
    const cancelled = isSicoobCobCancelled(cob);
    const expired = isSicoobCobExpired(cob);
    if (!cancelled && !expired) return false;

    const updated = await prisma.payment.updateMany({
        where: { id: payment.id, status: 'PENDING' },
        data: { status: 'FAILED' },
    });
    if (updated.count === 0) return false;

    await releaseCouponForPayment(payment.id);
    console.log(`[Sicoob-Reconcile] Payment ${payment.id} marcado FAILED (cobrança ${payment.providerRef} ${cancelled ? 'removida' : 'expirada'})`);
    await notifyPaymentExpired(payment);
    return true;
}

/** Cron: reconcilia pagamentos Sicoob pendentes recentes cujo webhook possa ter falhado. */
export async function reconcilePendingSicoobPayments(): Promise<number> {
    const since = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const pending = await prisma.payment.findMany({
        where: {
            provider: 'SICOOB',
            status: 'PENDING',
            providerRef: { not: null },
            createdAt: { gte: since },
        },
        select: { id: true },
        take: 200,
    });

    let confirmed = 0;
    let cancelled = 0;
    for (const p of pending) {
        try {
            if (await reconcileSicoobPayment(p.id)) {
                confirmed++;
            } else {
                // Se não confirmou, verifica se a cobrança foi removida/expirada no Sicoob
                // (paridade com o webhook da Cora, que chama reconcileCoraCancellation) —
                // caso contrário PIX Sicoob expirado ficava PENDING para sempre.
                if (await reconcileSicoobCancellation(p.id)) cancelled++;
            }
        } catch { /* segue para o próximo */ }
    }
    if (confirmed > 0 || cancelled > 0) {
        console.log(`[Sicoob-Reconcile] Sweep: ${confirmed} confirmado(s), ${cancelled} expirado(s)/cancelado(s) de ${pending.length} pendente(s).`);
    }
    return confirmed;
}

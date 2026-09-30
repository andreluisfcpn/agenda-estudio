// ─── Cancelamento em análise × pagamento de parcelas (E13) ────────────────────
// Enquanto o pedido de cancelamento do cliente está em análise (contrato PENDING_CANCELLATION), a base da
// multa está CONGELADA. Se o cliente pagasse uma parcela do plano nesse intervalo, pagaria a parcela E a
// multa calculada sobre ela. Regra do dono: o CLIENTE não paga parcelas do plano até o estúdio decidir.
//  • O ADMIN continua podendo cobrar (cliente presente, acerto combinado).
//  • Extras de uma gravação (bookingId) e a multa de cancelamento seguem pagáveis.
//  • Só bloqueia a EMISSÃO de uma cobrança nova: um pagamento já feito (webhook/conciliação/confirmação)
//    é sempre registrado.

import { isCancellationFine } from './cancellationFine.js';

export const CANCELLATION_PENDING_CODE = 'CANCELLATION_PENDING' as const;
export const CANCELLATION_PENDING_MESSAGE = 'Este contrato está com cancelamento em análise. Aguarde a decisão do estúdio.';

/** Corpo do 409 devolvido pelas rotas de pagamento do cliente. */
export const cancellationPendingBody = () => ({ error: CANCELLATION_PENDING_MESSAGE, code: CANCELLATION_PENDING_CODE });

type GuardedPayment = {
    bookingId?: string | null;
    metadata?: unknown;
    contract?: { status?: string | null } | null;
};

/**
 * O CLIENTE está tentando pagar uma parcela do PLANO de um contrato com cancelamento em análise?
 * `isAdmin` = quem chama é admin (nunca bloqueia). Pagamento sem contrato nunca bloqueia.
 */
export function planPaymentBlockedByPendingCancellation(payment: GuardedPayment, isAdmin: boolean): boolean {
    if (isAdmin) return false;
    if (payment.contract?.status !== 'PENDING_CANCELLATION') return false;
    if (payment.bookingId) return false;          // extras de uma gravação: valor próprio, seguem pagáveis
    if (isCancellationFine(payment)) return false; // a multa é justamente o que o cliente deve pagar
    return true;
}

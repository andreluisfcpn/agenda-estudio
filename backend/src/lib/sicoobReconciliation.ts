// ─── Sicoob Payment Reconciliation ──────────────────────
// Verificação por fonte-de-verdade das cobranças PIX via API autenticada do Sicoob.
// Usada como rede de segurança (cron + polling) E como autenticação do webhook:
// nunca confiamos no corpo do webhook — relemos GET /cob/{txid} antes de dar baixa.

import { prisma } from './prisma.js';
import { sicoobGetCob, getSicoobEnvironment } from './sicoobService.js';

/** providerRef é um txid Sicoob de verdade? (o mock de dev grava "mock-xxxx", que nunca concilia). */
const isSicoobTxid = (ref: string | null | undefined): ref is string => !!ref && /^[a-zA-Z0-9]{26,35}$/.test(ref);
import { onPaymentConfirmed, notifyPaymentExpired, alertPaymentOnCancelledCharge } from './paymentEffects.js';
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
 * O txid pertence a este Payment? Todo txid emitido para um Payment começa pelo id dele sem hífens
 * (32 hex — `toSicoobTxid`); da 2ª emissão em diante só ganha um sufixo (`pixTxidForAttempt`).
 */
export function isTxidOfPayment(txid: string, paymentId: string): boolean {
    const base = (paymentId || '').replace(/[^a-zA-Z0-9]/g, '');
    return base.length === 32 && isSicoobTxid(txid) && txid.startsWith(base);
}

/** Id do Payment (UUID com hífens) derivado de um txid emitido por nós, ou null. */
export function paymentIdFromTxid(txid: string): string | null {
    if (!isSicoobTxid(txid)) return null;
    const hex = txid.slice(0, 32);
    if (!/^[0-9a-f]{32}$/i.test(hex)) return null;
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`.toLowerCase();
}

/** Cobranças canceladas já resolvidas no provedor (removidas ou já alertadas) — evita GETs repetidos na varredura. */
const settledCancelledCharges = new Set<string>();
/** Um QR só pode ser pago enquanto vale; a varredura acompanha a cobrança cancelada até este tempo após a expiração. */
const CANCELLED_CHARGE_WATCH_MS = 6 * 60 * 60 * 1000;

/**
 * E13 — uma cobrança CANCELADA (parcela anulada de contrato cancelado) cujo QR continuou pagável no
 * Sicoob foi PAGA? A linha não volta a PAID sozinha (o contrato foi encerrado), mas o dinheiro entrou:
 * em vez de só logar, avisa o admin (alertPaymentOnCancelledCharge — 1 aviso por cobrança).
 * Nunca confia no corpo do webhook: relê GET /cob/{txid}. `opts.txid` = cobrança ANTERIOR do mesmo
 * Payment (QR reemitido). Fora de produção o GET é um mock aleatório (sandbox) → nunca alerta.
 * Devolve true se avisou agora.
 */
export async function alertIfCancelledSicoobChargePaid(paymentId: string, opts: { txid?: string } = {}): Promise<boolean> {
    const payment = await prisma.payment.findUnique({
        where: { id: paymentId },
        select: { id: true, status: true, providerRef: true },
    });
    if (!payment || payment.status !== 'CANCELLED') return false;
    const txid = opts.txid && opts.txid !== payment.providerRef ? opts.txid : payment.providerRef;
    if (!isSicoobTxid(txid)) return false;
    if (txid !== payment.providerRef && !isTxidOfPayment(txid, payment.id)) return false;
    if ((await getSicoobEnvironment()) !== 'production') return false;

    let cob: any;
    try {
        cob = await sicoobGetCob(txid);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // 404 = a cobrança não existe no provedor → nunca será paga: sai da varredura.
        if (/\b404\b/.test(msg)) settledCancelledCharges.add(payment.id);
        else console.error(`[Sicoob-Reconcile] getCob(${txid}) falhou (cobrança cancelada ${payment.id}):`, msg);
        return false;
    }
    if (!isSicoobCobPaid(cob)) {
        // Removida → nunca mais será paga: a varredura não precisa consultá-la de novo.
        if (isSicoobCobCancelled(cob)) settledCancelledCharges.add(payment.id);
        return false;
    }
    settledCancelledCharges.add(payment.id);
    const paidCents = paidCentsFromCob(cob);
    const originalCents = Math.round(Number(cob?.valor?.original) * 100);
    return alertPaymentOnCancelledCharge(payment.id, {
        provider: 'Sicoob (PIX)',
        providerRef: txid,
        amountCents: paidCents > 0 ? paidCents : (Number.isFinite(originalCents) ? originalCents : null),
    });
}

/**
 * Varredura (junto da conciliação dos pendentes): cobranças Sicoob CANCELADAS cujo QR ainda valia há
 * pouco — cobre o caso em que a anulação não conseguiu remover a cob no banco e o webhook do pagamento
 * não chegou. Só produção; no máximo 50 por rodada; cada cobrança sai da varredura quando a cob aparece
 * removida ou o aviso é emitido.
 */
export async function sweepCancelledSicoobCharges(now: Date = new Date()): Promise<number> {
    if ((await getSicoobEnvironment()) !== 'production') return 0;
    if (settledCancelledCharges.size > 5000) settledCancelledCharges.clear();
    const rows = await prisma.payment.findMany({
        where: {
            provider: 'SICOOB',
            status: 'CANCELLED',
            providerRef: { not: null },
            pixExpiresAt: { gte: new Date(now.getTime() - CANCELLED_CHARGE_WATCH_MS) },
        },
        select: { id: true },
        orderBy: { updatedAt: 'desc' },
        take: 50,
    });
    let alerted = 0;
    for (const p of rows) {
        if (settledCancelledCharges.has(p.id)) continue;
        try {
            if (await alertIfCancelledSicoobChargePaid(p.id)) alerted++;
        } catch { /* segue para a próxima */ }
    }
    return alerted;
}

/**
 * Verifica um pagamento Sicoob contra a API e marca PAID (rodando os efeitos de
 * confirmação) se o Sicoob confirmar. Idempotente e seguro para repetir.
 *
 * `opts.txid`: concilia uma cobrança ANTERIOR deste mesmo Payment (QR reemitido/aposentado cujo
 * pagamento chegou pelo webhook). Só vale para um txid do próprio Payment (prefixo = id); ao marcar
 * PAID, o providerRef passa a apontar para a cobrança efetivamente paga e a cobrança atual (outra)
 * é cancelada no provedor (best-effort).
 */
export async function reconcileSicoobPayment(paymentId: string, opts: { txid?: string } = {}): Promise<boolean> {
    const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
    // E13: linha CANCELADA (parcela anulada) — nunca vira PAID aqui, mas um pagamento confirmado no
    // banco não pode ficar só no log: avisa o admin.
    if (payment && payment.status === 'CANCELLED') {
        await alertIfCancelledSicoobChargePaid(payment.id, { txid: opts.txid });
        return false;
    }
    if (!payment || payment.status !== 'PENDING' || payment.provider !== 'SICOOB' || !isSicoobTxid(payment.providerRef)) {
        return false;
    }
    const txid: string = opts.txid && opts.txid !== payment.providerRef ? opts.txid : payment.providerRef;
    const isRetiredTxid = txid !== payment.providerRef;
    if (isRetiredTxid && !isTxidOfPayment(txid, payment.id)) {
        console.error(`[Sicoob-Reconcile][SECURITY] txid ${txid} não pertence ao payment ${payment.id} — ignorado.`);
        return false;
    }

    let cob: any;
    try {
        cob = await sicoobGetCob(txid);
    } catch (err) {
        console.error(`[Sicoob-Reconcile] getCob(${txid}) falhou:`, err instanceof Error ? err.message : err);
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
        data: { status: 'PAID', paidAt: new Date(), ...(isRetiredTxid ? { providerRef: txid } : {}) },
    });
    if (updated.count === 0) return false;

    console.log(`[Sicoob-Reconcile] Payment ${payment.id} confirmado PAID via Sicoob (txid ${txid}${isRetiredTxid ? `, cobrança anterior; a atual ${payment.providerRef} é cancelada` : ''})`);
    if (isRetiredTxid) {
        // Pago pelo QR antigo: o atual (outro txid) não pode continuar pagável.
        const { sicoobRemoveCob } = await import('./sicoobService.js');
        await sicoobRemoveCob(payment.providerRef).catch(() => false);
    }
    await onPaymentConfirmed(payment.id);
    return true;
}

/** Verifica se a cobrança foi genuinamente removida/expirada antes de falhar o pagamento. */
export async function reconcileSicoobCancellation(paymentId: string): Promise<boolean> {
    const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment || payment.status !== 'PENDING' || payment.provider !== 'SICOOB' || !isSicoobTxid(payment.providerRef)) {
        return false;
    }

    // D15: o sandbox do Sicoob é um MOCK que devolve status/criação ALEATÓRIOS no GET /cob
    // (ex.: "REMOVIDA_PELO_USUARIO_RECEBEDOR" ou criação em 1964 → "expirada"). Confiar nele
    // marcava FAILED cobranças recém-geradas (~2 min) e derrubava o checkout. Em sandbox a
    // confirmação é pelo "Simular pagamento" e a expiração é tratada pelo pixExpiresAt/varredura.
    if ((await getSicoobEnvironment()) === 'sandbox') return false;

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
    // Só a cobrança ATUAL do Payment conta: se o QR foi reemitido entre a leitura e agora, o
    // providerRef mudou e a cob consultada é a antiga (já aposentada) → não falhar o pagamento.
    const current = await prisma.payment.findUnique({ where: { id: payment.id }, select: { providerRef: true } });
    if (current?.providerRef !== payment.providerRef) return false;
    // Falha o pagamento se a cobrança foi REMOVIDA (cancelada) OU EXPIROU sem pagamento. A cobrança
    // imediata expirada fica ATIVA no Sicoob (não vira REMOVIDA); sem a checagem de expiração o
    // pagamento não pago ficaria PENDING até o sweep de 72h desistir.
    const cancelled = isSicoobCobCancelled(cob);
    const expired = isSicoobCobExpired(cob);
    if (!cancelled && !expired) return false;

    const updated = await prisma.payment.updateMany({
        // providerRef no where: se um QR novo foi emitido no meio, a cob expirada é a antiga.
        where: { id: payment.id, status: 'PENDING', providerRef: payment.providerRef },
        data: { status: 'FAILED' },
    });
    if (updated.count === 0) return false;

    await releaseCouponForPayment(payment.id);
    console.log(`[Sicoob-Reconcile] Payment ${payment.id} marcado FAILED (cobrança ${payment.providerRef} ${cancelled ? 'removida' : 'expirada'})`);
    await notifyPaymentExpired(payment);
    return true;
}

/**
 * Cron: reconcilia pagamentos Sicoob pendentes cujo webhook possa ter falhado.
 *
 * Janela pela COBRANÇA, não pela linha (pagamentos-2): com a D15 o QR das parcelas 2..N, das parcelas
 * do personalizado e das cobranças "deixar pendente" é emitido SOB DEMANDA, bem depois da criação da
 * linha. Entram: linhas criadas nos últimos 3 dias (cobrança emitida junto com a linha) OU com
 * `pixExpiresAt` a partir de 3 dias atrás (QR sob demanda, verificado até 3 dias após expirar).
 * O FAILED por cobrança expirada/removida só vale para o critério antigo (linha recente): uma parcela
 * antiga cujo QR sob demanda expirou sem pagamento continua PENDING (pagável e cobrável) — sem o
 * "Cobrança falhou" que a D15 eliminou.
 */
export async function reconcilePendingSicoobPayments(): Promise<number> {
    const since = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const pending = await prisma.payment.findMany({
        where: {
            provider: 'SICOOB',
            status: 'PENDING',
            providerRef: { not: null },
            OR: [
                { createdAt: { gte: since } },
                { pixExpiresAt: { gte: since } },
            ],
        },
        select: { id: true, createdAt: true },
        // Mais recentes primeiro: com mais de 200 linhas, as cobranças novas nunca ficam de fora.
        orderBy: { updatedAt: 'desc' },
        take: 200,
    });

    let confirmed = 0;
    let cancelled = 0;
    for (const p of pending) {
        try {
            if (await reconcileSicoobPayment(p.id)) {
                confirmed++;
            } else if (p.createdAt >= since) {
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
    // E13: cobranças já CANCELADAS cujo QR continuou pagável → alerta ao admin se foram pagas.
    try {
        const alerted = await sweepCancelledSicoobCharges();
        if (alerted > 0) console.log(`[Sicoob-Reconcile] Sweep: ${alerted} pagamento(s) em cobrança cancelada — admin avisado.`);
    } catch (err) {
        console.error('[Sicoob-Reconcile] Varredura das cobranças canceladas falhou:', err instanceof Error ? err.message : err);
    }
    return confirmed;
}

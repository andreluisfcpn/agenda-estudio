// ─── Resolução temporal das taxas de gateway ───────────────────────────────
// A taxa de cada pagamento deve ser a que estava vigente na DATA em que ele foi pago — não a atual.
// `GatewayFeeHistory` guarda a linha do tempo; estas funções resolvem a taxa vigente numa data.

export interface FeeRate {
    /** Percentual sobre o valor (ex.: 3.99). 0 quando o provider não cobra percentual. */
    pct: number;
    /** Taxa fixa por transação em centavos (ex.: 39). */
    fixedCents: number;
}

export interface FeeHistoryRow {
    provider: string;
    feePct: number;
    feeFixedCents: number;
    effectiveFrom: Date;
}

/**
 * Taxa vigente de `provider` na data `atDate`, a partir do histórico.
 * Retorna a linha de MAIOR `effectiveFrom` que seja <= `atDate`. Se nenhuma se aplica
 * (provider sem histórico, ou pagamento anterior ao 1º registro), cai no `fallback` (config atual).
 * `history` pode vir em qualquer ordem.
 */
export function resolveFeeAt(history: FeeHistoryRow[], provider: string, atDate: Date, fallback: FeeRate): FeeRate {
    const at = atDate.getTime();
    let best: FeeHistoryRow | null = null;
    for (const row of history) {
        if (row.provider !== provider) continue;
        if (row.effectiveFrom.getTime() > at) continue;
        if (!best || row.effectiveFrom.getTime() > best.effectiveFrom.getTime()) best = row;
    }
    return best ? { pct: best.feePct, fixedCents: best.feeFixedCents } : fallback;
}

/**
 * Taxa cobrada (centavos) sobre um valor, por provider. Preserva a semântica atual do relatório:
 *  • STRIPE: percentual + fixo, nunca acima do bruto (evita líquido negativo em cobranças mínimas).
 *  • CORA:   apenas a taxa fixa.
 *  • SICOOB: sem tarifa por recebimento.
 */
export function computeGatewayFee(amountCents: number, provider: string, rate: FeeRate): number {
    if (provider === 'STRIPE') {
        return Math.min(amountCents, Math.round(amountCents * (rate.pct / 100)) + rate.fixedCents);
    }
    if (provider === 'CORA') {
        return rate.fixedCents;
    }
    return 0; // SICOOB e demais: sem tarifa configurada
}

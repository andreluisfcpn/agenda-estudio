import { useEffect, useState } from 'react';
import { stripeApi } from '../api/client';

/**
 * Parcelamento no cartão que o GATEWAY realmente oferece para uma prévia (antes de existir o Payment).
 * Consulta POST /stripe/installment-plans { amount, contractDurationMonths, installmentCap } — o backend
 * aplica a política única E a disponibilidade do gateway: conta Stripe BR não parcela → só [1x].
 *
 * Devolve o maior Nº de parcelas oferecido (1 = sem parcelamento) e quantas saem SEM juros. Enquanto
 * carrega, ou se a consulta falhar, vale 1 — nunca prometer o que o checkout não cumpre. O dia em que o
 * gateway parcelar, as opções voltam a aparecer sozinhas.
 */
export interface CardInstallmentsInfo {
    /** Maior Nº de parcelas oferecido (1 = só à vista no cartão). */
    maxCount: number;
    /** Maior Nº de parcelas SEM juros oferecido (≤ maxCount). */
    freeCount: number;
    loading: boolean;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { at: number; maxCount: number; freeCount: number }>();

export function useCardInstallments(opts: {
    amount: number;
    durationMonths?: number;
    /** Teto de parcelas SEM juros (serviço "parcelar o total em até N×"). */
    installmentCap?: number;
    enabled?: boolean;
}): CardInstallmentsInfo {
    const { amount, durationMonths, installmentCap, enabled = true } = opts;
    const key = `${amount}|${durationMonths ?? ''}|${installmentCap ?? ''}`;
    const active = enabled && amount >= 100;
    const cached = cache.get(key);
    const fresh = cached && Date.now() - cached.at < CACHE_TTL_MS ? cached : null;
    const [info, setInfo] = useState<{ key: string; maxCount: number; freeCount: number } | null>(
        fresh ? { key, maxCount: fresh.maxCount, freeCount: fresh.freeCount } : null,
    );

    useEffect(() => {
        if (!active) return;
        const hit = cache.get(key);
        if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
            setInfo({ key, maxCount: hit.maxCount, freeCount: hit.freeCount });
            return;
        }
        let alive = true;
        stripeApi.getInstallmentPlans({ amount, contractDurationMonths: durationMonths, installmentCap })
            .then(res => {
                const plans = res.plans || [];
                const maxCount = plans.reduce((m, p) => Math.max(m, p.count), 1);
                const freeCount = plans.filter(p => p.freeOfCharge).reduce((m, p) => Math.max(m, p.count), 1);
                cache.set(key, { at: Date.now(), maxCount, freeCount });
                if (alive) setInfo({ key, maxCount, freeCount });
            })
            .catch(() => { if (alive) setInfo({ key, maxCount: 1, freeCount: 1 }); });
        return () => { alive = false; };
    }, [active, key, amount, durationMonths, installmentCap]);

    if (!active) return { maxCount: 1, freeCount: 1, loading: false };
    if (!info || info.key !== key) return { maxCount: 1, freeCount: 1, loading: true };
    return { maxCount: info.maxCount, freeCount: info.freeCount, loading: false };
}

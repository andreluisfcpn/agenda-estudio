import { useCallback, useEffect, useMemo, useState } from 'react';
import { contractsApi, type ContractSlotGrid, type ContractSlotOption, type ContractTier } from '../api/client';

// ─── Grade de horários de CONTRATO (D8) ─────────────────────────────────────
// Fonte única: GET /contracts/slot-options?tier= (BusinessConfig no backend). Nunca cair numa
// lista fixa no front: em erro o hook expõe `error` e a tela deve bloquear o avanço.
// Regras (aplicadas pelo backend): SABADO só aos sábados; COMERCIAL/AUDIENCIA só seg–sex;
// faixa superior usa os horários da inferior (AUDIÊNCIA = 10:00/13:00/15:30 + 18:00/20:30).

// Cache em nível de módulo POR FAIXA (mesmo padrão do useBusinessConfig): 1 request por faixa
// para todos os componentes, com dedupe da chamada em voo. Com validade curta (GRID_TTL_MS): uma aba
// aberta há horas busca a grade de novo ao (re)abrir um assistente, sem precisar tomar um 400
// "Horário inválido" depois que o admin mudou a grade em Configurações.
const GRID_TTL_MS = 5 * 60 * 1000;
const gridCache = new Map<ContractTier, { grid: ContractSlotGrid; at: number }>();
const inflight = new Map<ContractTier, Promise<ContractSlotGrid>>();
const listeners = new Set<() => void>();

/** Grade em cache da faixa, se ainda dentro da validade. */
function freshCached(tier: ContractTier): ContractSlotGrid | null {
    const entry = gridCache.get(tier);
    if (!entry) return null;
    if (Date.now() - entry.at > GRID_TTL_MS) { gridCache.delete(tier); return null; }
    return entry.grid;
}

function fetchGrid(tier: ContractTier): Promise<ContractSlotGrid> {
    const cached = freshCached(tier);
    if (cached) return Promise.resolve(cached);
    let pending = inflight.get(tier);
    if (!pending) {
        pending = contractsApi.slotOptions(tier)
            .then(grid => { gridCache.set(tier, { grid, at: Date.now() }); return grid; })
            .finally(() => { inflight.delete(tier); });
        inflight.set(tier, pending);
    }
    return pending;
}

/**
 * Descarta a grade em cache (de uma faixa ou de todas) e faz os hooks montados buscarem de novo.
 * Chame depois que o admin salvar a grade em Configurações (ScheduleEditor), junto com
 * invalidateFrontendConfigCache(). O backend também guarda a config por até 60s.
 */
export function invalidateContractSlotGridCache(tier?: ContractTier): void {
    if (tier) gridCache.delete(tier);
    else gridCache.clear();
    listeners.forEach(fn => fn());
}

const normDow = (dow: number) => ((dow % 7) + 7) % 7;

export interface UseContractSlotGrid {
    /** Grade da faixa atual (null enquanto carrega, sem faixa ou em erro). */
    grid: ContractSlotGrid | null;
    /** Dias (0=dom..6=sáb) com pelo menos um horário válido para a faixa. */
    allowedDays: number[];
    /** Horários válidos de um dia da semana ([] se o dia não é permitido). */
    slotsFor: (dayOfWeek: number) => ContractSlotOption[];
    /** Dia + horário pertencem à grade da faixa? */
    isValidSlot: (dayOfWeek: number, time: string | null | undefined) => boolean;
    slotDurationHours: number | null;
    loading: boolean;
    /** Mensagem pronta para exibir (pt-BR) quando a grade não carregou. */
    error: string | null;
    /** Descarta o cache desta faixa e busca de novo (ex.: botão "Tentar novamente"). */
    invalidate: () => void;
}

/** Grade de horários de contrato de uma faixa, com cache por faixa. `tier` vazio → grade vazia. */
export function useContractSlotGrid(tier: ContractTier | null | undefined): UseContractSlotGrid {
    const [grid, setGrid] = useState<ContractSlotGrid | null>(() => (tier ? freshCached(tier) : null));
    const [loading, setLoading] = useState<boolean>(() => !!tier && !freshCached(tier));
    const [error, setError] = useState<string | null>(null);
    const [version, setVersion] = useState(0);

    // Invalidações globais (ex.: admin salvou a grade) → refaz a busca.
    useEffect(() => {
        const onInvalidate = () => setVersion(v => v + 1);
        listeners.add(onInvalidate);
        return () => { listeners.delete(onInvalidate); };
    }, []);

    useEffect(() => {
        if (!tier) {
            setGrid(null); setLoading(false); setError(null);
            return;
        }
        const cached = freshCached(tier);
        if (cached) {
            setGrid(cached); setLoading(false); setError(null);
            return;
        }
        let alive = true;
        setGrid(null); setLoading(true); setError(null);
        fetchGrid(tier)
            .then(g => { if (alive) { setGrid(g); setLoading(false); } })
            .catch(() => {
                if (!alive) return;
                setError('Não foi possível carregar os horários. Tente novamente.');
                setLoading(false);
            });
        return () => { alive = false; };
    }, [tier, version]);

    // Nunca expõe a grade de OUTRA faixa no render em que `tier` acabou de mudar.
    const current = grid && tier && grid.tier === tier ? grid : null;

    const allowedDays = useMemo(() => current?.days.map(d => d.dayOfWeek) ?? [], [current]);
    const slotsFor = useCallback(
        (dayOfWeek: number) => current?.days.find(d => d.dayOfWeek === normDow(dayOfWeek))?.slots ?? [],
        [current],
    );
    const isValidSlot = useCallback(
        (dayOfWeek: number, time: string | null | undefined) => !!time && slotsFor(dayOfWeek).some(s => s.time === time),
        [slotsFor],
    );
    const invalidate = useCallback(() => {
        if (tier) invalidateContractSlotGridCache(tier);
    }, [tier]);

    return {
        grid: current,
        allowedDays,
        slotsFor,
        isValidSlot,
        slotDurationHours: current?.slotDurationHours ?? null,
        loading: !!tier && (loading || (!current && !error)),
        error,
        invalidate,
    };
}

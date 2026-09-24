import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';

/**
 * Guarda de clique MÚLTIPLO dos botões do rodapé de wizard — ENVIO (salvar/criar/cadastrar/ir para
 * pagamento), "Próximo" e "Cancelar" — e das escolhas da última etapa que mudam o que será cobrado.
 * Ignora o 2º (e os seguintes) clique de um clique duplo: `e.detail > 1`.
 *
 * Por quê: o 2º clique de um clique/toque duplo humano chega ~100–250 ms depois do 1º, quando a
 * etapa seguinte JÁ renderizou. Como o rodapé fica no mesmo lugar, ele cairia no "Criar/Salvar" da
 * última etapa (salvando sem o admin ver essa etapa), no "Próximo" da etapa seguinte (pulando uma
 * etapa) ou no "Cancelar" da 1ª etapa depois de um "Voltar" (fechando o wizard). O setTimeout 0 e as
 * keys distintas só protegem o MESMO clique.
 *
 * Clique simples (detail 1) e teclado — Enter/Espaço, detail 0 — passam na hora. NÃO é trava por
 * tempo: é a contagem de cliques do próprio navegador (mesmo critério do overlay do BottomSheetModal).
 * Limite conhecido: no iOS Safari um toque duplo pode chegar com detail 1 (não coberto aqui).
 *
 * `fn` é chamada SEM argumentos (o evento nunca vaza para um parâmetro opcional do handler).
 *
 * @example <button key="submit" type="button" onClick={ignoreMultiClick(handleSave)}>Salvar</button>
 */
export function ignoreMultiClick(fn: () => unknown): (e: { detail: number }) => void {
    return (e) => {
        if (e.detail > 1) return;
        void fn();
    };
}

/**
 * Altura mínima estável das etapas dos wizards admin (casca canônica): o sheet não encolhe nem
 * recentraliza ao trocar de etapa, então o rodapé fica no mesmo lugar. Sem isso, o 2º clique de um
 * clique duplo em "Próximo" podia cair FORA do sheet (que diminuiu) e o clique no fundo fechava o
 * wizard, perdendo o que foi preenchido. Uso: contêiner da etapa = `wizardStepBodyStyle`, conteúdo =
 * `wizardStepContentStyle`, e o `.admin-actions-row` como irmão DEPOIS do conteúdo (fica no fim).
 */
export const wizardStepBodyStyle: CSSProperties = { display: 'flex', flexDirection: 'column', minHeight: 'min(540px, calc(100dvh - 280px))' };
export const wizardStepContentStyle: CSSProperties = { flex: '1 0 auto' };

export interface UseWizardStepOptions {
    /** Etapa inicial, 1-based (padrão 1). Também é o destino de `reset()`. */
    initialStep?: number;
}

export interface WizardStepControls {
    /** Etapa atual, 1-based. */
    step: number;
    /** Total de etapas (normalizado para ≥1). */
    total: number;
    /**
     * Avança UMA etapa, ADIADO 1 tick (setTimeout 0). Use no botão "Próximo".
     * O adiamento é a correção obrigatória do "submit espúrio": o botão do rodapé
     * não troca de identidade/tipo enquanto o clique ainda está sendo processado.
     * Idempotente por etapa: cliques repetidos antes do re-render avançam só uma etapa.
     */
    next: () => void;
    /** Volta uma etapa (síncrono, nunca abaixo de 1). Cancela um `next` pendente. */
    back: () => void;
    /** Vai direto para a etapa `n` (síncrono, com clamp 1..total). Use no stepper (onStepClick). */
    goTo: (n: number) => void;
    /** Volta para a etapa inicial (síncrono). */
    reset: () => void;
    isFirst: boolean;
    isLast: boolean;
}

const clampStep = (n: number, total: number) => Math.min(Math.max(1, Math.floor(n) || 1), total);

/**
 * Estado de etapa dos wizards (padrão admin — casca do CreateBookingModal).
 *
 * Regras anti-submit espúrio (ver design-system.md §3 "Padrão de wizard"):
 * sem <form>, todo botão `type="button"`, keys distintas nos botões do rodapé,
 * avanço SEMPRE via `next()` (adiado 1 tick), guard de etapa no salvar
 * (`if (!isLast) return`), `ignoreMultiClick` nos botões do rodapé e NUNCA trava por tempo.
 *
 * @example
 * const { step, next, back, goTo, isLast } = useWizardStep(3);
 * <WizardSteps steps={STEPS} current={step} onStepClick={goTo} allowJump={isEdit} />
 * <button key="next" type="button" className="btn-admin-go" disabled={!canStep1}
 *         onClick={ignoreMultiClick(() => { if (canStep1) next(); })}>Próximo →</button>
 * <button key="submit" type="button" className="btn-admin-go" onClick={ignoreMultiClick(handleSave)}>Salvar</button>
 */
export function useWizardStep(total: number, opts: UseWizardStepOptions = {}): WizardStepControls {
    const safeTotal = Math.max(1, Math.floor(total) || 1);
    const initialRef = useRef(opts.initialStep ?? 1);
    const [step, setStep] = useState(() => clampStep(initialRef.current, safeTotal));

    const totalRef = useRef(safeTotal);
    totalRef.current = safeTotal;

    // Etapa do último render: `next()` avança a partir DELA (destino fixo), não de `s => s + 1`.
    // Sem isso, um clique DUPLO real em "Próximo" enfileirava dois avanços antes do re-render e o
    // wizard pulava uma etapa ainda não validada (1→3).
    const stepRef = useRef(step);
    stepRef.current = step;
    const pendingTargetRef = useRef<number | null>(null);

    const timersRef = useRef(new Set<ReturnType<typeof setTimeout>>());
    const cancelPending = useCallback(() => {
        timersRef.current.forEach(clearTimeout);
        timersRef.current.clear();
        pendingTargetRef.current = null;
    }, []);

    // Desmontou com um avanço pendente: não aplica.
    useEffect(() => cancelPending, [cancelPending]);

    // O total mudou (etapas condicionais): mantém a etapa dentro do intervalo.
    useEffect(() => {
        setStep(s => (s > safeTotal ? safeTotal : s));
    }, [safeTotal]);

    const next = useCallback(() => {
        const target = Math.min(stepRef.current + 1, totalRef.current);
        // Idempotente por etapa: um 2º clique antes do re-render mira o MESMO destino e é ignorado.
        if (pendingTargetRef.current === target) return;
        pendingTargetRef.current = target;
        const t = setTimeout(() => {
            timersRef.current.delete(t);
            pendingTargetRef.current = null;
            setStep(target);
        }, 0);
        timersRef.current.add(t);
    }, []);

    const back = useCallback(() => {
        cancelPending();
        setStep(s => Math.max(1, s - 1));
    }, [cancelPending]);

    const goTo = useCallback((n: number) => {
        cancelPending();
        setStep(clampStep(n, totalRef.current));
    }, [cancelPending]);

    const reset = useCallback(() => {
        cancelPending();
        setStep(clampStep(initialRef.current, totalRef.current));
    }, [cancelPending]);

    return {
        step,
        total: safeTotal,
        next,
        back,
        goTo,
        reset,
        isFirst: step === 1,
        isLast: step === safeTotal,
    };
}

export default useWizardStep;

import { useRef, useState, type KeyboardEvent, type SelectHTMLAttributes } from 'react';

/** Teclas que, num select FECHADO, trocam o valor e disparam `change` a cada passo (Chrome/Edge no Windows). */
const STEP_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);
const isStepKey = (e: KeyboardEvent) =>
    !e.altKey && !e.ctrlKey && !e.metaKey && (STEP_KEYS.has(e.key) || (e.key.length === 1 && e.key !== ' '));

type CommitSelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, 'value' | 'defaultValue' | 'onChange'> & {
    value: string;
    /**
     * Chamado só quando a escolha é intencional: clique numa opção da lista, Enter, ou ao sair do campo
     * depois de navegar pelas setas. Navegar com setas/letras no select fechado NÃO grava a cada passo.
     */
    onCommit: (value: string) => void;
};

/**
 * `<select>` controlado que grava ao CONFIRMAR, não a cada passo do teclado.
 *
 * Com o select fechado e focado, setas/Home/End/letras mudam o valor e disparam `change` a cada
 * passo — num select de status que grava no onChange, cada status intermediário virava uma escrita
 * (ex.: Confirmado → ↓ gravava "Concluído" antes de chegar em "Cancelado"). Aqui o passo vira um
 * rascunho exibido no próprio select; Enter (ou sair do campo) aplica, Esc descarta. Clique do mouse
 * e escolha na lista aberta aplicam na hora, como antes.
 */
export default function CommitSelect({ value, onCommit, onKeyDown, onBlur, children, ...rest }: CommitSelectProps) {
    const [draft, setDraftState] = useState<string | null>(null);
    const draftRef = useRef<string | null>(null);
    const stepping = useRef(false);

    const setDraft = (v: string | null) => { draftRef.current = v; setDraftState(v); };
    const commit = (v: string) => {
        setDraft(null);
        if (v !== value) onCommit(v);
    };

    return (
        <select
            {...rest}
            value={draft ?? value}
            onKeyDown={e => {
                onKeyDown?.(e);
                stepping.current = isStepKey(e);
                if (e.key === 'Enter' && draftRef.current !== null) {
                    e.preventDefault();
                    commit(draftRef.current);
                } else if (e.key === 'Escape' && draftRef.current !== null) {
                    e.preventDefault();
                    setDraft(null);
                }
            }}
            onChange={e => {
                const v = e.target.value;
                if (stepping.current) {
                    stepping.current = false;
                    setDraft(v === value ? null : v);
                    return;
                }
                commit(v);
            }}
            onBlur={e => {
                onBlur?.(e);
                stepping.current = false;
                if (draftRef.current !== null) commit(draftRef.current);
            }}
        >
            {children}
        </select>
    );
}

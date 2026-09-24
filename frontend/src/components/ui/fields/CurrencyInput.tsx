import React, { useCallback, useLayoutEffect, useReducer, useRef, useState } from 'react';
import {
    MAX_CENTS,
    caretForDigitsRight,
    countDigits,
    digitsToCents,
    formatCentsInput,
    onlyDigits,
    parseBRLToCents,
} from '../../../utils/currency';

type AriaProps = Pick<
    React.InputHTMLAttributes<HTMLInputElement>,
    'aria-label' | 'aria-labelledby' | 'aria-describedby' | 'aria-invalid' | 'aria-required' | 'aria-errormessage'
>;

export interface CurrencyInputProps extends AriaProps {
    /** Valor em CENTAVOS inteiros (30000 = R$ 300,00). `null` = campo vazio. */
    value: number | null;
    /** Recebe centavos inteiros — ou `null` quando o campo fica vazio e `allowEmpty` está ligado. */
    onChange: (cents: number | null) => void;
    /** Campo opcional: apagar tudo emite `null` e mostra o placeholder. Sem ele, apagar tudo = 0 ("0,00"). */
    allowEmpty?: boolean;
    /** Teto em centavos (padrão MAX_CENTS = R$ 9.999.999,99). Digitação/colagem acima dele é ignorada. */
    max?: number;
    /** Prefixo visual à esquerda (padrão "R$"). `false` oculta — use quando o rótulo já diz "(R$)". */
    prefix?: string | false;
    /** Estilo do prefixo (ex.: cor/tamanho iguais ao input quando ele usa fonte maior). */
    prefixStyle?: React.CSSProperties;
    id?: string;
    name?: string;
    placeholder?: string;
    disabled?: boolean;
    readOnly?: boolean;
    autoFocus?: boolean;
    /** Classes EXTRAS do <input> (ele já tem `form-input sf-money-input`), ex.: "form-input--raised". */
    className?: string;
    /** Estilo do <input>. Com fonte maior, ajuste também `paddingLeft` para o prefixo. */
    style?: React.CSSProperties;
    /** Classes extras do wrapper `.sf-money`. */
    wrapperClassName?: string;
    wrapperStyle?: React.CSSProperties;
    onBlur?: React.FocusEventHandler<HTMLInputElement>;
    onFocus?: React.FocusEventHandler<HTMLInputElement>;
    /** Chamado ANTES do tratamento interno; `preventDefault()` desliga o tratamento de Backspace/Delete. */
    onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>;
    /** React 19: ref é prop comum — aponta para o <input>. */
    ref?: React.Ref<HTMLInputElement>;
}

const isDigit = (ch: string | undefined) => !!ch && ch >= '0' && ch <= '9';
const isSep = (ch: string | undefined) => ch === '.' || ch === ',';

function normalize(v: number | null | undefined): number | null {
    return v == null || !Number.isFinite(v) ? null : Math.max(0, Math.round(v));
}

const toText = (v: number | null) => (v == null ? '' : formatCentsInput(v));

/**
 * Campo de dinheiro em R$ no modo "banco" (D10): os dígitos entram da direita
 * para a esquerda — digitar 3-0-0-0-0 mostra "300,00". Valor sempre em centavos.
 *
 * - Colar "R$ 1.500,00", "1.500,00", "1500" ou "450.00" funciona (parseBRLToCents).
 * - Cursor estável ao editar no meio; Backspace/Delete encostados num separador
 *   apagam o dígito vizinho (sem isso a tecla "não faria nada").
 * - Seleciona tudo ao focar (a próxima digitação substitui o valor).
 * - `inputMode="numeric"`: teclado numérico no celular, sem depender da vírgula.
 * - Controlado: se o pai mudar `value` por fora (descartar alterações, reset,
 *   clamp), o texto é ressincronizado.
 *
 * Validar com DIGITAÇÃO REAL no teclado (físico e virtual): eventos sintéticos
 * não reproduzem problemas de cursor.
 */
export default function CurrencyInput({
    value,
    onChange,
    allowEmpty = false,
    max = MAX_CENTS,
    prefix = 'R$',
    prefixStyle,
    id,
    name,
    placeholder,
    disabled,
    readOnly,
    autoFocus,
    className,
    style,
    wrapperClassName,
    wrapperStyle,
    onBlur,
    onFocus,
    onKeyDown,
    ref,
    ...aria
}: CurrencyInputProps) {
    const inputRef = useRef<HTMLInputElement | null>(null);
    const external = normalize(value);
    const [text, setText] = useState(() => toText(external));
    const [, forceRender] = useReducer((n: number) => n + 1, 0);
    // Último valor que ESTE campo emitiu (ou aceitou de fora). Divergir dele = mudança externa.
    const lastEmittedRef = useRef<number | null>(external);
    const pendingCaretRef = useRef<number | null>(null);
    const selectOnMouseUpRef = useRef(false);

    const setRefs = useCallback((el: HTMLInputElement | null) => {
        inputRef.current = el;
        if (typeof ref === 'function') ref(el);
        else if (ref) (ref as React.RefObject<HTMLInputElement | null>).current = el;
    }, [ref]);

    // Sincroniza com o valor externo (sem deps de propósito: compara a cada commit,
    // então também cobre o pai que "recusa" a mudança mantendo o valor antigo).
    useLayoutEffect(() => {
        if (external !== lastEmittedRef.current) {
            lastEmittedRef.current = external;
            pendingCaretRef.current = null;
            setText(toText(external));
        }
    });

    // Reposiciona o cursor depois que o React escreveu o texto reformatado.
    useLayoutEffect(() => {
        const el = inputRef.current;
        const pos = pendingCaretRef.current;
        pendingCaretRef.current = null;
        if (el && pos != null && document.activeElement === el) {
            try { el.setSelectionRange(pos, pos); } catch { /* input sem suporte a seleção */ }
        }
    });

    const emit = (cents: number | null) => {
        lastEmittedRef.current = cents;
        onChange(cents);
    };

    /** Aplica um texto "cru" (o que o navegador produziu) com o cursor em `caret`. */
    const applyRaw = (raw: string, caret: number) => {
        const digits = onlyDigits(raw);
        // Campo opcional: apagar até zerar esvazia o campo (senão "0,0" ainda tem dígitos
        // e o Backspace ficaria preso em "0,00", sem nunca voltar a vazio).
        const deletedToZero = allowEmpty && digitsToCents(digits) === 0 && digits.length < countDigits(text);
        if (!digits || deletedToZero) {
            if (allowEmpty) {
                pendingCaretRef.current = 0;
                setText('');
                forceRender();
                if (lastEmittedRef.current !== null) emit(null);
            } else {
                const zero = formatCentsInput(0);
                pendingCaretRef.current = zero.length;
                setText(zero);
                forceRender();
                if (lastEmittedRef.current !== 0) emit(0);
            }
            return;
        }

        const digitsRight = countDigits(raw.slice(caret));
        const cents = digitsToCents(digits);
        if (cents > max) {
            // Acima do teto: mantém o texto anterior e devolve o cursor ao mesmo lugar.
            pendingCaretRef.current = caretForDigitsRight(text, digitsRight);
            forceRender();
            return;
        }

        const next = formatCentsInput(cents);
        pendingCaretRef.current = caretForDigitsRight(next, digitsRight);
        setText(next);
        forceRender(); // garante o commit (e o reposicionamento do cursor) mesmo se o texto não mudou
        if (cents !== lastEmittedRef.current) emit(cents);
    };

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const el = e.target;
        applyRaw(el.value, el.selectionStart ?? el.value.length);
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        onKeyDown?.(e);
        if (e.defaultPrevented || readOnly || disabled) return;
        const el = e.currentTarget;
        const start = el.selectionStart;
        const end = el.selectionEnd;
        if (start == null || start !== end) return; // com seleção, o comportamento nativo já serve
        const v = el.value;

        if (e.key === 'Backspace' && start > 0 && isSep(v[start - 1])) {
            e.preventDefault();
            let i = start - 2;
            while (i >= 0 && !isDigit(v[i])) i--;
            if (i < 0) return;
            applyRaw(v.slice(0, i) + v.slice(i + 1), i);
        } else if (e.key === 'Delete' && start < v.length && isSep(v[start])) {
            e.preventDefault();
            let i = start + 1;
            while (i < v.length && !isDigit(v[i])) i++;
            if (i >= v.length) return;
            applyRaw(v.slice(0, i) + v.slice(i + 1), start);
        }
    };

    const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
        if (readOnly || disabled) return;
        e.preventDefault();
        const cents = parseBRLToCents(e.clipboardData.getData('text'));
        if (cents == null || cents > max) return;
        const next = formatCentsInput(cents);
        pendingCaretRef.current = next.length;
        setText(next);
        forceRender();
        if (cents !== lastEmittedRef.current) emit(cents);
    };

    const handleFocus = (e: React.FocusEvent<HTMLInputElement>) => {
        onFocus?.(e);
        if (readOnly) return;
        const el = e.currentTarget;
        // Foco por teclado (Tab): seleciona tudo no próximo frame.
        requestAnimationFrame(() => {
            if (document.activeElement === el) el.select();
        });
    };

    // Foco por clique: alguns navegadores (Safari) desfazem a seleção no mouseup.
    const handleMouseDown = (e: React.MouseEvent<HTMLInputElement>) => {
        if (document.activeElement !== e.currentTarget) selectOnMouseUpRef.current = true;
    };
    const handleMouseUp = (e: React.MouseEvent<HTMLInputElement>) => {
        if (!selectOnMouseUpRef.current) return;
        selectOnMouseUpRef.current = false;
        if (readOnly) return;
        e.preventDefault();
        e.currentTarget.select();
    };

    const wrapperCls = [
        'sf-money',
        prefix === false ? 'sf-money--no-prefix' : '',
        wrapperClassName ?? '',
    ].filter(Boolean).join(' ');

    return (
        <div className={wrapperCls} style={wrapperStyle}>
            {prefix !== false && (
                <span className="sf-money-prefix" aria-hidden="true" style={prefixStyle}>{prefix}</span>
            )}
            <input
                {...aria}
                ref={setRefs}
                id={id}
                name={name}
                type="text"
                inputMode="numeric"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                className={`form-input sf-money-input${className ? ` ${className}` : ''}`}
                style={style}
                value={text}
                placeholder={placeholder ?? (allowEmpty ? '0,00' : undefined)}
                disabled={disabled}
                readOnly={readOnly}
                autoFocus={autoFocus}
                onChange={handleChange}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                onFocus={handleFocus}
                onBlur={onBlur}
                onMouseDown={handleMouseDown}
                onMouseUp={handleMouseUp}
            />
        </div>
    );
}

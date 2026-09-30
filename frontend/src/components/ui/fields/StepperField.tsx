import React from 'react';
import Tooltip from '../Tooltip';

interface StepperFieldProps {
    value: number;
    onChange: (n: number) => void;
    min?: number;
    max?: number;
    step?: number;
    suffix?: string;
    /** Nome do campo (ex.: "Ordem de exibição") — entra no rótulo dos botões: "Diminuir ordem de exibição". */
    'aria-label'?: string;
}

// <button disabled> não dispara eventos de ponteiro: a dica fica num <span> em volta (E7), e o botão
// desabilitado deixa o ponteiro "passar" para o span. O span é o item do flex no lugar do botão.
const tipWrap = (disabled: boolean): React.CSSProperties => ({
    display: 'inline-flex',
    flexShrink: 0,
    cursor: disabled ? 'not-allowed' : undefined,
});
const passThrough: React.CSSProperties = { pointerEvents: 'none' };

/** Number input with −/+ buttons and optional unit suffix. */
export default function StepperField({
    value, onChange, min, max, step = 1, suffix, 'aria-label': ariaLabel,
}: StepperFieldProps) {
    const clamp = (n: number) => {
        if (Number.isNaN(n)) return value;
        if (min !== undefined && n < min) return min;
        if (max !== undefined && n > max) return max;
        return n;
    };
    const dec = () => onChange(clamp(value - step));
    const inc = () => onChange(clamp(value + step));
    const decDisabled = min !== undefined && value <= min;
    const incDisabled = max !== undefined && value >= max;
    const field = ariaLabel?.trim();
    const fieldLower = field ? field.charAt(0).toLocaleLowerCase('pt-BR') + field.slice(1) : '';
    const decLabel = field ? `Diminuir ${fieldLower}` : 'Diminuir';
    const incLabel = field ? `Aumentar ${fieldLower}` : 'Aumentar';

    return (
        <div className="sf-stepper">
            <Tooltip content="Diminuir" describe={false}>
                <span style={tipWrap(decDisabled)}>
                    <button
                        type="button"
                        className="sf-stepper-btn"
                        onClick={dec}
                        disabled={decDisabled}
                        aria-label={decLabel}
                        style={decDisabled ? passThrough : undefined}
                    >−</button>
                </span>
            </Tooltip>
            <input
                type="number"
                className="sf-stepper-input"
                aria-label={field}
                value={value}
                onChange={e => onChange(clamp(Number(e.target.value)))}
                min={min}
                max={max}
                step={step}
            />
            {suffix && <span className="sf-stepper-suffix">{suffix}</span>}
            <Tooltip content="Aumentar" describe={false}>
                <span style={tipWrap(incDisabled)}>
                    <button
                        type="button"
                        className="sf-stepper-btn"
                        onClick={inc}
                        disabled={incDisabled}
                        aria-label={incLabel}
                        style={incDisabled ? passThrough : undefined}
                    >+</button>
                </span>
            </Tooltip>
        </div>
    );
}

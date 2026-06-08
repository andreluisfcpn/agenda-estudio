import React from 'react';

interface StepperFieldProps {
    value: number;
    onChange: (n: number) => void;
    min?: number;
    max?: number;
    step?: number;
    suffix?: string;
}

/** Number input with −/+ buttons and optional unit suffix. */
export default function StepperField({
    value, onChange, min, max, step = 1, suffix,
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

    return (
        <div className="sf-stepper">
            <button
                type="button"
                className="sf-stepper-btn"
                onClick={dec}
                disabled={decDisabled}
                aria-label="Diminuir"
            >−</button>
            <input
                type="number"
                className="sf-stepper-input"
                value={value}
                onChange={e => onChange(clamp(Number(e.target.value)))}
                min={min}
                max={max}
                step={step}
            />
            {suffix && <span className="sf-stepper-suffix">{suffix}</span>}
            <button
                type="button"
                className="sf-stepper-btn"
                onClick={inc}
                disabled={incDisabled}
                aria-label="Aumentar"
            >+</button>
        </div>
    );
}

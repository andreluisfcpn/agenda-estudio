import React from 'react';

/**
 * Pill-sliding radio group used in place of <select> for short, fixed enums.
 * Fills 100% width by default → never overflows its container (the bug that
 * cut the "Modo de Acesso" select in the Pagamentos section).
 */
export interface SegmentedOption<T extends string> {
    value: T;
    label: string;
    icon?: React.ReactNode;
}

interface SegmentedControlProps<T extends string> {
    value: T;
    onChange: (v: T) => void;
    options: SegmentedOption<T>[];
    'aria-label'?: string;
}

export default function SegmentedControl<T extends string>({
    value, onChange, options, 'aria-label': ariaLabel,
}: SegmentedControlProps<T>) {
    const idx = Math.max(0, options.findIndex(o => o.value === value));
    const widthPct = 100 / options.length;
    return (
        <div className="sf-segmented" role="radiogroup" aria-label={ariaLabel}>
            <span
                className="sf-segmented-slider"
                style={{
                    width: `calc(${widthPct}% - 6px)`,
                    left: `calc(${idx * widthPct}% + 3px)`,
                }}
            />
            {options.map(o => (
                <button
                    key={o.value}
                    type="button"
                    role="radio"
                    aria-checked={o.value === value}
                    className={`sf-segmented-opt ${o.value === value ? 'is-active' : ''}`}
                    onClick={() => onChange(o.value)}
                >
                    {o.icon}{o.label}
                </button>
            ))}
        </div>
    );
}

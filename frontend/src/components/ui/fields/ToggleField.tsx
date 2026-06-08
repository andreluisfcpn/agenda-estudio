interface ToggleFieldProps {
    checked: boolean;
    onChange: (v: boolean) => void;
    /** Label shown next to the switch (optional). */
    label?: string;
    'aria-label'?: string;
}

/** iOS-style switch. Replaces text fields for boolean settings. */
export default function ToggleField({ checked, onChange, label, 'aria-label': ariaLabel }: ToggleFieldProps) {
    return (
        <label className={`sf-toggle ${checked ? 'is-on' : ''}`}>
            <button
                type="button"
                role="switch"
                aria-checked={checked}
                aria-label={ariaLabel || label}
                className="sf-toggle-switch"
                onClick={() => onChange(!checked)}
            >
                <span className="sf-toggle-thumb" aria-hidden />
            </button>
            {label && <span className="sf-toggle-label">{label}</span>}
        </label>
    );
}

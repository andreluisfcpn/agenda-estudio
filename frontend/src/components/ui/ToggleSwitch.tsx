interface ToggleSwitchProps {
    checked: boolean;
    onChange: (checked: boolean) => void;
    label?: string;
    disabled?: boolean;
    id?: string;
}

export default function ToggleSwitch({ checked, onChange, label, disabled = false, id }: ToggleSwitchProps) {
    const switchId = id || `toggle-${Math.random().toString(36).slice(2, 8)}`;

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (disabled) return;
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onChange(!checked);
        }
    };

    return (
        <label className="toggle-switch" htmlFor={switchId}>
            {label && <span className="toggle-switch__label">{label}</span>}
            {/* SEM onClick aqui: o clique já chega via <label htmlFor> → input →
                onChange. Com onClick no track, 1 clique disparava onChange DUAS
                vezes (2 PATCHs idênticos — ex.: cobrança automática). Teclado
                continua no onKeyDown. */}
            <div
                className={`toggle-switch__track ${checked ? 'toggle-switch__track--on' : ''} ${disabled ? 'toggle-switch__track--disabled' : ''}`}
                role="switch"
                aria-checked={checked}
                aria-label={label || 'Toggle'}
                tabIndex={disabled ? -1 : 0}
                onKeyDown={handleKeyDown}
            >
                <div className="toggle-switch__thumb" />
            </div>
            <input
                type="checkbox"
                id={switchId}
                checked={checked}
                onChange={(e) => onChange(e.target.checked)}
                disabled={disabled}
                className="toggle-switch__input"
                tabIndex={-1}
                aria-hidden="true"
            />
        </label>
    );
}

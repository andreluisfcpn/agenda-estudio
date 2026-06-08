import { Mail } from 'lucide-react';

interface EmailFieldProps {
    value: string;
    onChange: (v: string) => void;
    placeholder?: string;
}

/** Email input with a leading mail icon. */
export default function EmailField({ value, onChange, placeholder }: EmailFieldProps) {
    return (
        <div className="sf-email">
            <span className="sf-email-icon" aria-hidden><Mail size={14} /></span>
            <input
                type="email"
                className="form-input sf-email-input"
                value={value}
                onChange={e => onChange(e.target.value)}
                placeholder={placeholder || 'voce@exemplo.com'}
                spellCheck={false}
            />
        </div>
    );
}

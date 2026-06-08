import { ExternalLink, Link2 } from 'lucide-react';

interface UrlFieldProps {
    value: string;
    onChange: (v: string) => void;
    placeholder?: string;
}

/** URL input with a leading link icon and a "open in new tab" button if valid. */
export default function UrlField({ value, onChange, placeholder }: UrlFieldProps) {
    const looksValid = /^https?:\/\//.test(value);
    return (
        <div className="sf-url">
            <span className="sf-url-icon" aria-hidden><Link2 size={14} /></span>
            <input
                type="url"
                className="form-input sf-url-input"
                value={value}
                onChange={e => onChange(e.target.value)}
                placeholder={placeholder || 'https://...'}
                spellCheck={false}
            />
            {looksValid && (
                <a
                    className="sf-url-open"
                    href={value}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="Abrir em nova aba"
                    aria-label="Abrir URL em nova aba"
                >
                    <ExternalLink size={14} />
                </a>
            )}
        </div>
    );
}

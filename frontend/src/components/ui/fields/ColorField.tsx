import React from 'react';

interface ColorFieldProps {
    value: string;
    onChange: (hex: string) => void;
    fallback?: string;
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/**
 * Native color picker + hex input bound together. Invalid hex falls back to
 * the provided default (or teal) so the <input type=color> never crashes.
 */
export default function ColorField({ value, onChange, fallback = '#14b8a6' }: ColorFieldProps) {
    const safeValue = HEX_RE.test(value) ? value : fallback;
    return (
        <div className="sf-color">
            <input
                type="color"
                className="sf-color-swatch"
                value={safeValue}
                onChange={e => onChange(e.target.value)}
                aria-label="Selecionar cor"
            />
            <input
                type="text"
                className="form-input sf-color-hex"
                value={value}
                onChange={e => onChange(e.target.value)}
                placeholder={fallback}
                maxLength={7}
            />
        </div>
    );
}

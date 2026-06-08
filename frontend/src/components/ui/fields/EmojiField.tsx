import { useEffect, useRef, useState } from 'react';

interface EmojiFieldProps {
    value: string;
    onChange: (emoji: string) => void;
}

/** Curated emoji palette aimed at payment methods. Keeps the dependency-free promise. */
const EMOJI_PALETTE = [
    '💳', '🏦', '💵', '📱', '🔁', '🧾', '💰', '✨',
    '⚡', '🟢', '🟣', '🔵', '🟡', '🟠', '🔴', '⭐',
    '📄', '📅', '💸', '🪙', '🎟️', '🏷️', '✅', '🔐',
];

/** Single-character emoji input with a click-to-pick popover. */
export default function EmojiField({ value, onChange }: EmojiFieldProps) {
    const [open, setOpen] = useState(false);
    const wrapRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const handler = (e: MouseEvent) => {
            if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [open]);

    return (
        <div className="sf-emoji" ref={wrapRef}>
            <input
                type="text"
                className="form-input sf-emoji-input"
                value={value}
                onChange={e => onChange(e.target.value.slice(0, 4))}
                onFocus={() => setOpen(true)}
                aria-label="Emoji"
                maxLength={4}
            />
            {open && (
                <div className="sf-emoji-popover" role="listbox" aria-label="Selecionar emoji">
                    {EMOJI_PALETTE.map(e => (
                        <button
                            key={e}
                            type="button"
                            className="sf-emoji-pick"
                            onClick={() => { onChange(e); setOpen(false); }}
                            aria-label={`Selecionar ${e}`}
                        >
                            {e}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

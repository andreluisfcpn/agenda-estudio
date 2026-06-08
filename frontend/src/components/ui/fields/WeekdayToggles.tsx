import React from 'react';

interface WeekdayTogglesProps {
    /** CSV with ISO weekday numbers (1=Mon..7=Sun). Example: "1,2,3,4,5,6". */
    value: string;
    onChange: (csv: string) => void;
}

/* ISO week starts on Monday in BR conventions (and our seed defaults). */
const DAYS = [
    { iso: 1, label: 'S', full: 'Segunda' },
    { iso: 2, label: 'T', full: 'Terça' },
    { iso: 3, label: 'Q', full: 'Quarta' },
    { iso: 4, label: 'Q', full: 'Quinta' },
    { iso: 5, label: 'S', full: 'Sexta' },
    { iso: 6, label: 'S', full: 'Sábado' },
    { iso: 7, label: 'D', full: 'Domingo' },
];

function parseSet(csv: string): Set<number> {
    const out = new Set<number>();
    csv.split(',').forEach(s => {
        const n = Number(s.trim());
        if (Number.isFinite(n) && n >= 1 && n <= 7) out.add(n);
    });
    return out;
}
function serialize(set: Set<number>): string {
    return [...set].sort((a, b) => a - b).join(',');
}

export default function WeekdayToggles({ value, onChange }: WeekdayTogglesProps) {
    const set = parseSet(value);
    const toggle = (iso: number) => {
        const next = new Set(set);
        if (next.has(iso)) next.delete(iso); else next.add(iso);
        onChange(serialize(next));
    };
    return (
        <div className="sf-weekdays" role="group" aria-label="Dias da semana">
            {DAYS.map(d => {
                const active = set.has(d.iso);
                return (
                    <button
                        key={d.iso}
                        type="button"
                        className={`sf-weekday ${active ? 'is-active' : ''}`}
                        aria-pressed={active}
                        aria-label={d.full}
                        title={d.full}
                        onClick={() => toggle(d.iso)}
                    >
                        {d.label}
                    </button>
                );
            })}
        </div>
    );
}

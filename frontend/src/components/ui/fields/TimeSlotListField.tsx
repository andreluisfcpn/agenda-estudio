import { Plus, X } from 'lucide-react';
import TimeField from './TimeField';

interface TimeSlotListFieldProps {
    /** CSV of HH:MM start times. Example: "10:00,13:00,15:30,18:00". */
    value: string;
    onChange: (csv: string) => void;
    'aria-label'?: string;
}

const HHMM = /^\d{2}:\d{2}$/;

function parse(csv: string): string[] {
    return csv.split(',').map(s => s.trim()).filter(s => HHMM.test(s));
}
function serialize(list: string[]): string {
    return [...list].sort().join(',');
}

export default function TimeSlotListField({ value, onChange, 'aria-label': ariaLabel }: TimeSlotListFieldProps) {
    const slots = parse(value);

    const update = (idx: number, hhmm: string) => {
        const next = [...slots];
        next[idx] = hhmm;
        onChange(serialize(next.filter(s => HHMM.test(s))));
    };
    const remove = (idx: number) => {
        const next = slots.filter((_, i) => i !== idx);
        onChange(serialize(next));
    };
    const add = () => {
        const next = [...slots, '09:00'];
        onChange(serialize(next));
    };

    return (
        <div className="sf-timeslots" role="group" aria-label={ariaLabel}>
            {slots.map((s, i) => (
                <div key={`${i}-${s}`} className="sf-timeslot-row">
                    <TimeField value={s} onChange={v => update(i, v)} aria-label={`Horário ${i + 1}`} />
                    <button
                        type="button"
                        className="sf-timeslot-remove"
                        onClick={() => remove(i)}
                        aria-label={`Remover horário ${s}`}
                    >
                        <X size={14} />
                    </button>
                </div>
            ))}
            <button type="button" className="sf-timeslot-add" onClick={add}>
                <Plus size={14} /> Adicionar horário
            </button>
        </div>
    );
}

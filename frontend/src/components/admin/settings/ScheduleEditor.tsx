import { BusinessConfigItem } from '../../../api/client';
import WeekdayToggles from '../../ui/fields/WeekdayToggles';
import TimeSlotListField from '../../ui/fields/TimeSlotListField';
import TimeField from '../../ui/fields/TimeField';
import StepperField from '../../ui/fields/StepperField';
import { CalendarDays, Clock, AlarmClock, Settings2 } from 'lucide-react';

interface ScheduleEditorProps {
    items: BusinessConfigItem[];
    onChange: (key: string, value: string) => void;
}

/**
 * Visual editor for the `schedule` business-config group. Dispatches by
 * `key` (the schema is discovered at runtime in the DB seed — keys may
 * differ between dev and prod, so we render only what's present and fall
 * back to a generic input for unknown keys so nothing vanishes).
 *
 * All editors serialize back to the same string type the backend expects
 * (CSVs / HH:MM / number), so the save flow (PUT /pricing/business-config)
 * is unchanged.
 */
export default function ScheduleEditor({ items, onChange }: ScheduleEditorProps) {
    const byKey = Object.fromEntries(items.map(i => [i.key, i])) as Record<string, BusinessConfigItem | undefined>;

    const slotKeys = ['time_slots', 'comercial_slots', 'audiencia_slots'].filter(k => !!byKey[k]);
    const dayItem = byKey['operating_days'];
    const closeItem = byKey['close_time'];
    const durationItem = byKey['slot_duration_hours'];

    /** Numeric keys not handled by a dedicated editor above. */
    const fallbackNumeric = items.filter(i =>
        i.key !== 'operating_days' &&
        !slotKeys.includes(i.key) &&
        i.key !== 'close_time' &&
        i.key !== 'slot_duration_hours' &&
        i.type !== 'string'
    );
    /** String keys not handled by a dedicated editor above. */
    const fallbackString = items.filter(i =>
        i.key !== 'operating_days' &&
        !slotKeys.includes(i.key) &&
        i.key !== 'close_time' &&
        i.type === 'string'
    );

    return (
        <div className="sf-schedule">
            {/* ── Dias ── */}
            {dayItem && (
                <div className="sf-schedule-block">
                    <div className="sf-schedule-block-title"><CalendarDays size={13} aria-hidden="true" /> Dias de funcionamento</div>
                    <WeekdayToggles
                        value={dayItem.value}
                        onChange={v => onChange(dayItem.key, v)}
                    />
                    <p className="sf-schedule-help">Toque nos dias em que o estúdio atende. Sem nenhum dia ativo, o estúdio fica fechado.</p>
                </div>
            )}

            {/* ── Horários de bloco ── */}
            {slotKeys.length > 0 && (
                <div className="sf-schedule-block">
                    <div className="sf-schedule-block-title"><Clock size={13} aria-hidden="true" /> Horários de início (HH:MM)</div>
                    {slotKeys.map(k => {
                        const it = byKey[k]!;
                        return (
                            <div key={k} className="sf-schedule-block" style={{ gap: 'var(--space-2)' }}>
                                <label className="form-label" style={{ fontSize: '0.75rem' }}>{it.label || k}</label>
                                <TimeSlotListField
                                    value={it.value}
                                    onChange={v => onChange(k, v)}
                                    aria-label={it.label || k}
                                />
                            </div>
                        );
                    })}
                </div>
            )}

            {/* ── Fechamento + duração ── */}
            {(closeItem || durationItem) && (
                <div className="sf-schedule-block">
                    <div className="sf-schedule-block-title"><AlarmClock size={13} aria-hidden="true" /> Fechamento & duração</div>
                    <div className="admin-grid-2">
                        {closeItem && (
                            <div className="form-group" style={{ marginBottom: 0 }}>
                                <label className="form-label">{closeItem.label || 'Horário de fechamento'}</label>
                                <TimeField
                                    value={closeItem.value}
                                    onChange={v => onChange(closeItem.key, v)}
                                    aria-label="Horário de fechamento"
                                />
                            </div>
                        )}
                        {durationItem && (
                            <div className="form-group" style={{ marginBottom: 0 }}>
                                <label className="form-label">{durationItem.label || 'Duração do bloco'}</label>
                                <StepperField
                                    value={Number(durationItem.value) || 1}
                                    onChange={n => onChange(durationItem.key, String(n))}
                                    min={1}
                                    max={8}
                                    suffix="h"
                                />
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* ── Outros numéricos (mantém visíveis chaves divergentes do seed) ── */}
            {fallbackNumeric.length > 0 && (
                <div className="sf-schedule-block">
                    <div className="sf-schedule-block-title"><Settings2 size={13} aria-hidden="true" /> Outras regras</div>
                    <div className="admin-grid-2">
                        {fallbackNumeric.map(it => {
                            const suffix = it.key.includes('minutes') ? 'min'
                                : it.key.includes('hours') ? 'h'
                                : it.key.includes('days') ? 'd'
                                : it.type === 'percent' ? '%'
                                : '';
                            return (
                                <div key={it.key} className="form-group" style={{ marginBottom: 0 }}>
                                    <label className="form-label">{it.label || it.key}</label>
                                    <StepperField
                                        value={Number(it.value) || 0}
                                        onChange={n => onChange(it.key, String(n))}
                                        min={0}
                                        suffix={suffix || undefined}
                                    />
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* ── Strings (campos de texto raros no schedule) ── */}
            {fallbackString.length > 0 && (
                <div className="sf-schedule-block">
                    {fallbackString.map(it => (
                        <div key={it.key} className="form-group" style={{ marginBottom: 0 }}>
                            <label className="form-label">{it.label || it.key}</label>
                            <input
                                className="form-input"
                                type="text"
                                value={it.value}
                                onChange={e => onChange(it.key, e.target.value)}
                            />
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

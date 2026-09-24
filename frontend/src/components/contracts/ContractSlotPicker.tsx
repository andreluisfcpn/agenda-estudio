import type { CSSProperties } from 'react';
import { AlertCircle, CalendarX2, Loader2, RefreshCw } from 'lucide-react';
import type { ContractSlotOption, ContractTier } from '../../api/client';
import { useContractSlotGrid } from '../../hooks/useContractSlotGrid';
import { TIER_META } from '../../constants/adminMeta';

// ─── Seletor de horário de CONTRATO (D8) ────────────────────────────────────
// Mostra só os horários válidos da faixa no dia da semana escolhido, vindos da grade do backend
// (useContractSlotGrid → GET /contracts/slot-options). Cada horário aparece como
// "HH:MM – HH:MM" com a cor da faixa DO HORÁRIO (AUDIÊNCIA também oferece os comerciais).
//  - variant 'buttons' (padrão): grade de botões (todos type="button", aria-pressed);
//  - variant 'select': select compacto para linhas por dia (ex.: personalizado com vários dias).
// Estados: sem dia escolhido, carregando, erro (com "Tentar novamente") e dia sem horários.

const WEEKDAY_PLURAL = ['aos domingos', 'às segundas', 'às terças', 'às quartas', 'às quintas', 'às sextas', 'aos sábados'];

export interface ContractSlotPickerProps {
    /** Faixa do contrato. */
    tier: ContractTier | null | undefined;
    /** Dia da semana (0=dom..6=sáb; 7 = domingo). null = ainda não escolhido. */
    dayOfWeek: number | null | undefined;
    /** Horário selecionado ("HH:MM"). */
    value: string | null | undefined;
    onChange: (time: string, slot: ContractSlotOption) => void;
    variant?: 'buttons' | 'select';
    /** Horários válidos mas indisponíveis agora (ex.: ocupados no dia) — aparecem desabilitados. */
    disabledTimes?: string[];
    disabled?: boolean;
    /** Rótulo acessível do grupo/select (padrão: "Horário de gravação"). */
    label?: string;
    id?: string;
    className?: string;
}

export function formatSlotRange(slot: Pick<ContractSlotOption, 'time' | 'end'>): string {
    return `${slot.time} – ${slot.end}`;
}

function tierStyle(tier: string): CSSProperties {
    const meta = TIER_META[tier];
    return {
        '--csp-tier-color': meta?.color ?? 'var(--accent-text)',
        '--csp-tier-bg': meta?.bg ?? 'var(--bg-elevated)',
    } as CSSProperties;
}

export default function ContractSlotPicker({
    tier,
    dayOfWeek,
    value,
    onChange,
    variant = 'buttons',
    disabledTimes,
    disabled = false,
    label = 'Horário de gravação',
    id,
    className,
}: ContractSlotPickerProps) {
    const { slotsFor, loading, error, invalidate } = useContractSlotGrid(tier);
    const rootClass = ['csp', `csp--${variant}`, className].filter(Boolean).join(' ');

    if (dayOfWeek == null || !tier) {
        return (
            <div className={rootClass}>
                <p className="csp-state csp-state--hint">
                    {!tier ? 'Escolha a faixa para ver os horários.' : 'Escolha o dia da semana para ver os horários.'}
                </p>
            </div>
        );
    }

    if (loading) {
        return (
            <div className={rootClass} aria-busy="true">
                <p className="csp-state" role="status">
                    <Loader2 size={16} className="csp-spin" aria-hidden="true" />
                    Carregando horários…
                </p>
            </div>
        );
    }

    if (error) {
        return (
            <div className={rootClass}>
                <div className="csp-state csp-state--error" role="alert">
                    <AlertCircle size={16} aria-hidden="true" />
                    <span>{error}</span>
                    <button key="retry" type="button" className="csp-retry" onClick={invalidate}>
                        <RefreshCw size={14} aria-hidden="true" />
                        Tentar novamente
                    </button>
                </div>
            </div>
        );
    }

    const slots = slotsFor(dayOfWeek);
    if (slots.length === 0) {
        const tierLabel = TIER_META[tier]?.label ?? tier;
        return (
            <div className={rootClass}>
                <p className="csp-state csp-state--empty">
                    <CalendarX2 size={16} aria-hidden="true" />
                    A faixa {tierLabel} não tem horários de gravação {WEEKDAY_PLURAL[((dayOfWeek % 7) + 7) % 7]}.
                </p>
            </div>
        );
    }

    const blocked = new Set(disabledTimes ?? []);
    const selected = slots.find(s => s.time === value) ?? null;

    if (variant === 'select') {
        return (
            <div className={rootClass} style={selected ? tierStyle(selected.tier) : undefined}>
                <span className={`csp-dot${selected ? '' : ' csp-dot--empty'}`} aria-hidden="true" />
                <select
                    id={id}
                    className="form-input form-input--raised csp-select"
                    aria-label={label}
                    value={selected ? selected.time : ''}
                    disabled={disabled}
                    onChange={e => {
                        const slot = slots.find(s => s.time === e.target.value);
                        if (slot) onChange(slot.time, slot);
                    }}
                >
                    <option value="" disabled>Selecione o horário</option>
                    {slots.map(s => (
                        <option key={s.time} value={s.time} disabled={blocked.has(s.time)}>
                            {formatSlotRange(s)} · {TIER_META[s.tier]?.label ?? s.tier}
                            {blocked.has(s.time) ? ' (ocupado)' : ''}
                        </option>
                    ))}
                </select>
            </div>
        );
    }

    return (
        <div className={rootClass} role="group" aria-label={label} id={id}>
            {slots.map(s => {
                const isSelected = s.time === selected?.time;
                const isBlocked = blocked.has(s.time);
                const tierLabel = TIER_META[s.tier]?.label ?? s.tier;
                return (
                    <button
                        key={`slot-${s.time}`}
                        type="button"
                        className={`csp-slot${isSelected ? ' csp-slot--selected' : ''}`}
                        style={tierStyle(s.tier)}
                        aria-pressed={isSelected}
                        aria-label={`${formatSlotRange(s)}, faixa ${tierLabel}${isBlocked ? ', ocupado' : ''}`}
                        disabled={disabled || isBlocked}
                        onClick={() => onChange(s.time, s)}
                    >
                        <span className="csp-slot__range">{formatSlotRange(s)}</span>
                        <span className="csp-slot__tier">{isBlocked ? 'Ocupado' : tierLabel}</span>
                    </button>
                );
            })}
        </div>
    );
}

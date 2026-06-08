import { Sparkles, Check } from 'lucide-react';
import { formatBRL } from '../../utils/format';
import '../../styles/service-line-item.css';

interface ServiceLineItemProps {
    name: string;
    /** Discounted value charged on each recording (per-episode services). */
    perRecordingCents: number;
    /** Recordings per month — renders the "× N/mês" aggregate. */
    sessionsPerMonth?: number;
    /** Explicit monthly aggregate; overrides the perRecording × sessions math. */
    perMonthCents?: number;
    /** Flat monthly service (e.g. gestão social) → no "por gravação" framing. */
    monthly?: boolean;
    description?: string | null;
    icon?: React.ReactNode;
    /** Pre-discount unit, to show a struck-through original + savings. */
    originalUnitCents?: number;
    /** When provided, renders as a selectable toggle row. */
    selected?: boolean;
    onToggle?: () => void;
    compact?: boolean;
}

/**
 * Canonical "valor por gravação" row, shared by the contract wizards and the admin
 * service selectors so the per-recording unit price is displayed identically everywhere.
 * Per-episode services lead with "R$ X /gravação" + a "× N/mês" aggregate; flat monthly
 * services lead with "R$ X /mês".
 */
export default function ServiceLineItem({
    name, perRecordingCents, sessionsPerMonth, perMonthCents, monthly,
    description, icon, originalUnitCents, selected, onToggle, compact,
}: ServiceLineItemProps) {
    const monthlyValue = perMonthCents ?? (perRecordingCents * (sessionsPerMonth ?? 1));
    const selectable = typeof onToggle === 'function';

    const body = (
        <>
            <div className="service-line__icon">{icon || <Sparkles size={16} />}</div>
            <div className="service-line__info">
                <div className="service-line__name">{name}</div>
                {description && !compact && <div className="service-line__desc">{description}</div>}
            </div>
            <div className="service-line__pricing">
                {monthly ? (
                    <div className="service-line__primary">{formatBRL(monthlyValue)}<span className="service-line__per">/mês</span></div>
                ) : (
                    <>
                        <div className="service-line__primary">{formatBRL(perRecordingCents)}<span className="service-line__per">/gravação</span></div>
                        {sessionsPerMonth ? (
                            <div className="service-line__secondary">{sessionsPerMonth}× = {formatBRL(monthlyValue)}/mês</div>
                        ) : originalUnitCents && originalUnitCents > perRecordingCents ? (
                            <div className="service-line__secondary"><s>{formatBRL(originalUnitCents)}</s></div>
                        ) : null}
                    </>
                )}
            </div>
            {selectable && (
                <div className={`service-line__check ${selected ? 'service-line__check--on' : ''}`}>
                    {selected && <Check size={14} />}
                </div>
            )}
        </>
    );

    if (selectable) {
        return (
            <button
                type="button"
                className={`service-line service-line--selectable ${selected ? 'service-line--selected' : ''} ${compact ? 'service-line--compact' : ''}`}
                onClick={onToggle}
                aria-pressed={selected}
            >
                {body}
            </button>
        );
    }
    return <div className={`service-line ${compact ? 'service-line--compact' : ''}`}>{body}</div>;
}

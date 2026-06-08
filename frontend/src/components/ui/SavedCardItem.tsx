import { Check } from 'lucide-react';
import { getBrandIcon } from '../../utils/cardBrand';

export interface SavedCardLike {
    id: string;
    brand: string;
    last4: string;
    expMonth: number;
    expYear: number;
    isDefault?: boolean;
}

interface SavedCardItemProps {
    card: SavedCardLike;
    /** When true, renders as a radio-card button; otherwise as a read-only div. */
    selectable?: boolean;
    selected?: boolean;
    onSelect?: () => void;
}

/**
 * Unified card display used both as a selectable radio in InlineCheckout and
 * as a read-only entry in ClientProfilePage's "💳 Pagamento" section.
 */
export default function SavedCardItem({
    card,
    selectable = false,
    selected = false,
    onSelect,
}: SavedCardItemProps) {
    const exp = `${String(card.expMonth).padStart(2, '0')}/${String(card.expYear).slice(-2)}`;
    const className = `sf-card${selected ? ' is-selected' : ''}`;
    const content = (
        <>
            <span className="sf-card-brand" aria-hidden>💳</span>
            <span className="sf-card-num">
                <span style={{ fontWeight: 700, marginRight: 6, textTransform: 'capitalize' }}>{getBrandIcon(card.brand)}</span>
                •••• {card.last4}
            </span>
            <span className="sf-card-exp">{exp}</span>
            {card.isDefault && <span className="sf-card-default">Padrão</span>}
            {selectable && (
                <span className="sf-card-radio" aria-hidden>
                    {selected && <Check size={12} strokeWidth={3} />}
                </span>
            )}
        </>
    );

    if (selectable) {
        return (
            <button
                type="button"
                className={className}
                onClick={onSelect}
                role="radio"
                aria-checked={selected}
            >
                {content}
            </button>
        );
    }
    return <div className={className}>{content}</div>;
}

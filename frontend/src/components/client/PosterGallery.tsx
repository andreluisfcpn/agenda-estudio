import { ReactNode, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useDragScroll } from '../../hooks/useDragScroll';

/**
 * Horizontal, draggable gallery of poster cards — shared by "Minhas Gravações"
 * and Agenda → "Seus Agendamentos". Finger = native scroll; mouse = drag via
 * useDragScroll. Side arrows appear only on wide hover devices (see CSS).
 *
 * Pass `revision` (e.g. item count or loading flag) so the arrow visibility is
 * re-evaluated whenever the content changes after mount.
 */
interface PosterGalleryProps {
    children: ReactNode;
    revision?: unknown;
    /** Persistent accessible name for the gallery group (exposed via role=group). */
    label?: string;
    /** When loading: exposes aria-busy and announces "Carregando…" via a polite live region. */
    busy?: boolean;
}

export function PosterGallery({ children, revision, label, busy }: PosterGalleryProps) {
    const { ref, showLeft, showRight, scrollByPage, updateArrows } = useDragScroll<HTMLDivElement>();
    useEffect(() => {
        const t = setTimeout(updateArrows, 80);
        return () => clearTimeout(t);
    }, [revision, updateArrows]);
    return (
        <div className="poster-gallery-wrap scrollrow-wrap">
            {/* Polite live region announces loading start/finish to screen readers. */}
            <span className="sr-only" role="status" aria-live="polite">{busy ? 'Carregando…' : ''}</span>
            {showLeft && (
                <button type="button" className="scrollrow-arrow scrollrow-arrow--left" aria-label="Anterior" tabIndex={-1} onClick={() => scrollByPage(-1)}>
                    <ChevronLeft size={16} />
                </button>
            )}
            <div ref={ref} role="group" aria-label={label} aria-busy={busy || undefined} className="poster-gallery scrollrow-track stagger-enter">
                {children}
            </div>
            {showRight && (
                <button type="button" className="scrollrow-arrow scrollrow-arrow--right" aria-label="Próximo" tabIndex={-1} onClick={() => scrollByPage(1)}>
                    <ChevronRight size={16} />
                </button>
            )}
        </div>
    );
}

/**
 * A single poster card (3:4) with cover/placeholder, optional top-left/top-right
 * chips, an eyebrow line, a title and an optional footer row. Tone controls the
 * placeholder gradient + focus/hover accent.
 */
interface PosterCardProps {
    coverUrl?: string | null;
    placeholder: ReactNode;
    badgeTopLeft?: ReactNode;
    badgeTopRight?: ReactNode;
    eyebrow: ReactNode;
    title: string;
    footer?: ReactNode;
    onClick?: () => void;
    ariaLabel?: string;
    highlight?: boolean;
    tone?: 'violet' | 'teal';
    index?: number;
}

export function PosterCard({
    coverUrl, placeholder, badgeTopLeft, badgeTopRight, eyebrow, title, footer,
    onClick, ariaLabel, highlight, tone = 'violet', index = 0,
}: PosterCardProps) {
    const [failed, setFailed] = useState(false);
    const hasCover = !!coverUrl && !failed;
    return (
        <button
            type="button"
            className={`poster-card poster-card--${tone} animate-card-enter ${highlight ? 'poster-card--highlight' : ''}`}
            style={{ '--i': index } as React.CSSProperties}
            aria-label={ariaLabel}
            onClick={onClick}
        >
            <div className="poster-card__media">
                <span className="poster-card__ph" aria-hidden="true">{placeholder}</span>
                {hasCover && <img src={coverUrl!} alt="" draggable={false} loading="lazy" onError={() => setFailed(true)} />}
            </div>
            <div className="poster-card__grad" />
            {badgeTopLeft && <span className="poster-card__tl">{badgeTopLeft}</span>}
            {badgeTopRight && <span className="poster-card__tr">{badgeTopRight}</span>}
            <div className="poster-card__info">
                <div className="poster-card__eyebrow">{eyebrow}</div>
                <div className="poster-card__title">{title}</div>
                {footer && <div className="poster-card__footer">{footer}</div>}
            </div>
        </button>
    );
}

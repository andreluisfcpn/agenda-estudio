import type { CSSProperties } from 'react';
import { useHeroAmbient } from '../../hooks/useHeroAmbient';
import '../../styles/hero-ambient.css';

export type HeroVariant = 'inicio' | 'agenda' | 'gravacoes' | 'contratos' | 'pagar';

/**
 * Subtle ambient layer behind the client hero: a per-tab themed glow + a weather/day-night
 * mood (sun glow, drifting clouds, light rain, night stars) for the studio's city.
 * Presentation-only, pointer-events:none, sits below the hero content. All motion is CSS
 * (the global prefers-reduced-motion rule neutralizes it). Renders nothing when disabled.
 */
export default function HeroAmbient({ variant }: { variant: HeroVariant }) {
    const { enabled, timeOfDay, condition } = useHeroAmbient();
    if (!enabled) return null;

    const isWet = condition === 'rain' || condition === 'storm';
    return (
        <div className={`hero-ambient hero-ambient--${variant} hero-ambient--${timeOfDay} hero-ambient--${condition}`} aria-hidden="true">
            <span className="hero-ambient__glow" />
            <span className="hero-ambient__sheen" />

            {isWet && (
                <span className="hero-ambient__rain">
                    {Array.from({ length: 10 }).map((_, i) => <i key={i} style={{ '--n': i } as CSSProperties} />)}
                </span>
            )}

            {condition === 'clouds' && (
                <span className="hero-ambient__clouds"><i /><i /></span>
            )}

            {timeOfDay === 'night' && (
                <span className="hero-ambient__stars">
                    {Array.from({ length: 12 }).map((_, i) => <i key={i} style={{ '--n': i } as CSSProperties} />)}
                </span>
            )}
        </div>
    );
}

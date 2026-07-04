import { useState, useEffect } from 'react';

/** Tiny countdown label for calendar cells with an active payment hold */
export default function HoldCountdownCell({ expiresAt, label, tier, rowLabel, onExpire, onClick }: {
    expiresAt: string; label: string; tier: string; rowLabel: string;
    onExpire: () => void; onClick: () => void;
}) {
    const [remaining, setRemaining] = useState(() => {
        const diff = new Date(expiresAt).getTime() - Date.now();
        return Math.max(0, Math.floor(diff / 1000));
    });

    useEffect(() => {
        const timer = setInterval(() => {
            const diff = new Date(expiresAt).getTime() - Date.now();
            const secs = Math.max(0, Math.floor(diff / 1000));
            setRemaining(secs);
            if (secs <= 0) { clearInterval(timer); onExpire(); }
        }, 1000);
        return () => clearInterval(timer);
    }, [expiresAt, onExpire]);

    const mins = Math.floor(remaining / 60);
    const secs = remaining % 60;
    const color = remaining <= 60 ? '#ef4444' : remaining <= 180 ? '#f59e0b' : '#d97706';

    return (
        <div
            className="calendar-cell occupied"
            onClick={onClick}
            style={{
                height: 80, padding: '4px',
                background: 'linear-gradient(135deg, rgba(217,119,6,0.18), rgba(245,158,11,0.10))',
                border: `1px solid ${color}`,
                cursor: 'pointer',
                animation: remaining <= 120 ? 'pulse 2s infinite' : undefined,
            }}
        >
            <div className={`calendar-slot tier-${tier}`}
                style={{ height: '100%', fontWeight: 800, fontSize: '0.7rem', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', gap: '2px' }}>
                <div style={{ fontSize: '0.65rem', opacity: 0.85 }}>{label}</div>
                <div style={{
                    fontSize: '0.875rem', fontWeight: 800, fontVariantNumeric: 'tabular-nums', color,
                }}>
                    ⏱ {String(mins).padStart(2, '0')}:{String(secs).padStart(2, '0')}
                </div>
                <div style={{ fontSize: '0.55rem', fontWeight: 600, color, opacity: 0.9 }}>Aguardando Pgto</div>
            </div>
        </div>
    );
}

// Nota (R4 L2): movido verbatim de CalendarPage.tsx — cores/emoji e useCountdown
// entram no loop de melhorias (L3), não aqui.

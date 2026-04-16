import { useState, useEffect } from 'react';

interface AwaitingPaymentBannerProps {
    paymentDeadline: string | null;
    onPay: () => void;
    onExpire?: () => void;
}

export default function AwaitingPaymentBanner({ paymentDeadline, onPay, onExpire }: AwaitingPaymentBannerProps) {
    const [remaining, setRemaining] = useState(() => {
        if (!paymentDeadline) return 600;
        const diff = new Date(paymentDeadline).getTime() - Date.now();
        return Math.max(0, Math.floor(diff / 1000));
    });

    useEffect(() => {
        if (!paymentDeadline) return;
        const timer = setInterval(() => {
            const diff = new Date(paymentDeadline).getTime() - Date.now();
            const secs = Math.max(0, Math.floor(diff / 1000));
            setRemaining(secs);
            if (secs <= 0) {
                clearInterval(timer);
                onExpire?.();
            }
        }, 1000);
        return () => clearInterval(timer);
    }, [paymentDeadline, onExpire]);

    const mins = Math.floor(remaining / 60);
    const secs = remaining % 60;
    const totalDuration = 600; // 10 min
    const pct = Math.max(0, (remaining / totalDuration) * 100);
    const timerColor = remaining <= 60 ? '#ef4444' : remaining <= 180 ? '#f59e0b' : '#d97706';

    return (
        <div style={{
            background: 'rgba(217, 119, 6, 0.1)', border: '1px solid rgba(217, 119, 6, 0.2)',
            borderLeft: '3px solid #d97706', padding: '16px', margin: '0 24px 16px 24px',
            borderRadius: 'var(--radius-sm)',
        }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: '180px' }}>
                    <h4 style={{ fontSize: '0.875rem', fontWeight: 700, color: '#d97706', marginBottom: '4px' }}>
                        Pagamento Necessário
                    </h4>
                    <p style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)', marginBottom: 0 }}>
                        Complete o pagamento para ativar. O horário será liberado quando o tempo esgotar.
                    </p>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <div style={{
                        display: 'flex', alignItems: 'baseline', gap: '2px',
                        fontSize: '1.5rem', fontWeight: 800, fontVariantNumeric: 'tabular-nums',
                        color: timerColor, minWidth: '65px', justifyContent: 'center',
                    }}>
                        <span>{String(mins).padStart(2, '0')}</span>
                        <span style={{ opacity: 0.5, fontSize: '1.25rem' }}>:</span>
                        <span>{String(secs).padStart(2, '0')}</span>
                    </div>
                    <button className="btn btn-primary btn-sm"
                        onClick={(e) => { e.stopPropagation(); onPay(); }}
                        aria-label="Pagar contrato agora"
                        style={{ whiteSpace: 'nowrap', minWidth: '130px', minHeight: '44px', background: '#d97706', borderColor: '#d97706' }}>
                        Pagar Agora
                    </button>
                </div>
            </div>
            {/* Progress bar */}
            <div style={{
                height: 4, borderRadius: 2, background: 'var(--bg-elevated)',
                marginTop: '10px', overflow: 'hidden',
            }}>
                <div style={{
                    height: '100%', borderRadius: 2,
                    background: timerColor,
                    width: `${pct}%`,
                    transition: 'width 1s linear, background 0.3s ease',
                }} />
            </div>
        </div>
    );
}

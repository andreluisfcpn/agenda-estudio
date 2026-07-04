import { useCountdown } from '../../hooks/useCountdown';

interface AwaitingPaymentBannerProps {
    paymentDeadline: string | null;
    onPay: () => void;
    onExpire?: () => void;
}

export default function AwaitingPaymentBanner({ paymentDeadline, onPay, onExpire }: AwaitingPaymentBannerProps) {
    // useCountdown guarda o onExpire em ref (interval não recicla por prop nova).
    const remaining = useCountdown(paymentDeadline, onExpire) ?? 600;

    const mins = Math.floor(remaining / 60);
    const secs = remaining % 60;
    const totalDuration = 600; // 10 min
    const pct = Math.max(0, (remaining / totalDuration) * 100);
    const timerColor = remaining <= 60 ? 'var(--danger)' : remaining <= 180 ? 'var(--warning)' : 'var(--warning-strong)';

    return (
        <div className="awaiting-banner" onClick={e => e.stopPropagation()}>
            <div className="awaiting-banner__row">
                <div style={{ flex: 1, minWidth: 180 }}>
                    <div className="awaiting-banner__title">Pagamento Necessário</div>
                    <p className="awaiting-banner__desc">
                        Complete o pagamento para ativar. O horário será liberado quando o tempo esgotar.
                    </p>
                </div>
                <div className="awaiting-banner__right">
                    <div className="awaiting-banner__timer" style={{ color: timerColor }}>
                        <span>{String(mins).padStart(2, '0')}</span>
                        <span className="awaiting-banner__timer-sep">:</span>
                        <span>{String(secs).padStart(2, '0')}</span>
                    </div>
                    <button className="btn btn-primary btn-sm awaiting-banner__pay"
                        onClick={(e) => { e.stopPropagation(); onPay(); }}
                        aria-label="Pagar contrato agora">
                        Pagar Agora
                    </button>
                </div>
            </div>
            <div className="awaiting-banner__progress">
                <div
                    className="awaiting-banner__progress-bar"
                    style={{ width: `${pct}%`, background: timerColor }}
                />
            </div>
        </div>
    );
}

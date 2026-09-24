import { Fragment, useRef } from 'react';
import { useCountdown } from '../../hooks/useCountdown';

/**
 * Quem está aguardando pagamento — muda o texto:
 *  - `booking`: reserva avulsa (horário segurado por 10 min);
 *  - `service`: contratação de serviço mensal (10 min, sem horário envolvido — D2);
 *  - `contract`: contrato de gravações (personalizado do cliente com horários reservados, ou
 *    renovação de FIXO/FLEX/PERSONALIZADO com 3 dias para pagar, sem horário segurado).
 */
export type AwaitingPaymentVariant = 'booking' | 'service' | 'contract';

interface AwaitingPaymentBannerProps {
    paymentDeadline: string | null;
    onPay: () => void;
    onExpire?: () => void;
    variant?: AwaitingPaymentVariant;
    /** `contract`: há sessões RESERVADAS na agenda esperando o pagamento (ex.: personalizado do cliente). */
    holdsSlots?: boolean;
    /** Início da janela de pagamento (ex.: createdAt do contrato) — base da barra de progresso. */
    startedAt?: string | number | null;
}

/** Janela nominal quando não se sabe o início: 10 min (reserva/serviço) ou 3 dias (renovação). */
const DEFAULT_WINDOW_SECS: Record<AwaitingPaymentVariant, number> = {
    booking: 600,
    service: 600,
    contract: 3 * 24 * 3600,
};

function describe(variant: AwaitingPaymentVariant, holdsSlots: boolean): string {
    if (variant === 'service') {
        return 'Conclua o pagamento em até 10 minutos para ativar o serviço. Se o tempo acabar, a contratação é cancelada e você pode contratar de novo.';
    }
    if (variant === 'booking') {
        return 'Conclua o pagamento para confirmar a gravação. Se o tempo acabar, o horário é liberado.';
    }
    return holdsSlots
        ? 'Conclua o pagamento para ativar o contrato. Seus horários ficam reservados até o fim do prazo; se o tempo acabar, a contratação é cancelada e os horários são liberados.'
        : 'Conclua o pagamento para ativar o contrato. Se o prazo acabar, esta contratação é cancelada e você pode solicitar de novo.';
}

const pad = (n: number) => String(n).padStart(2, '0');

export default function AwaitingPaymentBanner({
    paymentDeadline, onPay, onExpire, variant = 'contract', holdsSlots = false, startedAt,
}: AwaitingPaymentBannerProps) {
    // useCountdown guarda o onExpire em ref (interval não recicla por prop nova).
    const remaining = useCountdown(paymentDeadline, onExpire);

    // Progresso pelo prazo REAL: início conhecido → deadline − início; senão a janela nominal da
    // variante, nunca menor que o maior restante já visto (a barra nunca passa de 100%).
    const deadlineMs = paymentDeadline ? new Date(paymentDeadline).getTime() : NaN;
    const startMs = startedAt != null ? new Date(startedAt).getTime() : NaN;
    const knownWindow = Number.isFinite(deadlineMs) && Number.isFinite(startMs) && deadlineMs > startMs
        ? Math.round((deadlineMs - startMs) / 1000)
        : null;
    const maxSeenRef = useRef(0);
    if (remaining != null && remaining > maxSeenRef.current) maxSeenRef.current = remaining;
    const totalDuration = Math.max(knownWindow ?? DEFAULT_WINDOW_SECS[variant], maxSeenRef.current, 1);
    const pct = remaining == null ? 0 : Math.min(100, Math.max(0, (remaining / totalDuration) * 100));

    const secsLeft = remaining ?? 0;
    const hours = Math.floor(secsLeft / 3600);
    const mins = Math.floor((secsLeft % 3600) / 60);
    const secs = secsLeft % 60;
    // hh:mm:ss acima de 1h (renovação: 3 dias → 71:58:49); mm:ss abaixo.
    const clock = hours > 0 ? `${pad(hours)}:${pad(mins)}:${pad(secs)}` : `${pad(mins)}:${pad(secs)}`;
    const timerColor = secsLeft <= 60 ? 'var(--danger)' : secsLeft <= 180 ? 'var(--warning)' : 'var(--warning-strong)';
    const payLabel = variant === 'service' ? 'Pagar serviço agora' : variant === 'booking' ? 'Pagar reserva agora' : 'Pagar contrato agora';

    return (
        <div className="awaiting-banner" onClick={e => e.stopPropagation()}>
            <div className="awaiting-banner__row">
                <div style={{ flex: 1, minWidth: 180 }}>
                    <div className="awaiting-banner__title">Pagamento necessário</div>
                    <p className="awaiting-banner__desc">{describe(variant, holdsSlots)}</p>
                </div>
                <div className="awaiting-banner__right">
                    {remaining != null && (
                        <div
                            className="awaiting-banner__timer"
                            style={{ color: timerColor }}
                            role="timer"
                            aria-label={`Tempo restante para pagar: ${clock}`}
                        >
                            {clock.split(':').map((part, i) => (
                                <Fragment key={i}>
                                    {i > 0 && <span className="awaiting-banner__timer-sep" aria-hidden="true">:</span>}
                                    <span>{part}</span>
                                </Fragment>
                            ))}
                        </div>
                    )}
                    <button
                        type="button"
                        className="btn btn-primary btn-sm awaiting-banner__pay"
                        onClick={(e) => { e.stopPropagation(); onPay(); }}
                        aria-label={payLabel}
                    >
                        Pagar Agora
                    </button>
                </div>
            </div>
            {remaining != null && (
                <div className="awaiting-banner__progress" aria-hidden="true">
                    <div
                        className="awaiting-banner__progress-bar"
                        style={{ width: `${pct}%`, background: timerColor }}
                    />
                </div>
            )}
        </div>
    );
}

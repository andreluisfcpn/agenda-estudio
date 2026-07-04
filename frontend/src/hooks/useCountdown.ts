import { useState, useEffect, useRef } from 'react';

/**
 * Contagem regressiva em segundos até um deadline (ISO string ou epoch ms).
 * Retorna null quando não há deadline. `onExpire` dispara UMA vez ao zerar —
 * guardado em ref para o interval não resetar quando o caller passa uma arrow
 * function nova a cada render (padrão que se repetia em HoldCountdownCell,
 * PendingPaymentCard e AwaitingPaymentBanner).
 */
export function useCountdown(deadline: string | number | null | undefined, onExpire?: () => void): number | null {
    const deadlineMs = deadline == null ? null
        : typeof deadline === 'number' ? deadline
        : new Date(deadline).getTime();

    const [remaining, setRemaining] = useState<number | null>(() =>
        deadlineMs == null ? null : Math.max(0, Math.floor((deadlineMs - Date.now()) / 1000)));

    const onExpireRef = useRef(onExpire);
    onExpireRef.current = onExpire;

    useEffect(() => {
        if (deadlineMs == null) { setRemaining(null); return; }
        setRemaining(Math.max(0, Math.floor((deadlineMs - Date.now()) / 1000)));
        const timer = setInterval(() => {
            const secs = Math.max(0, Math.floor((deadlineMs - Date.now()) / 1000));
            setRemaining(secs);
            if (secs <= 0) { clearInterval(timer); onExpireRef.current?.(); }
        }, 1000);
        return () => clearInterval(timer);
    }, [deadlineMs]);

    return remaining;
}

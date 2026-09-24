import { useEffect, useRef, useState } from 'react';
import QRCodeLib from 'qrcode';
import { Check, Clock, Copy, Loader2, QrCode, RefreshCw, TimerOff } from 'lucide-react';
import { useCountdown } from '../hooks/useCountdown';
import { formatBRL } from '../utils/format';

export interface PixQrCodeProps {
    /** PIX copia-e-cola (BR Code/EMV). */
    pixString: string;
    /** Imagem pronta do backend: data URL ("data:image/png;base64,…") ou base64 cru. Sem ela, o QR é gerado aqui. */
    qrCodeDataUrl?: string | null;
    /** Validade da cobrança (ISO ou epoch ms). Sem ela, não há contagem nem estado "expirado". */
    expiresAt?: string | number | null;
    /** Valor em centavos, exibido acima do QR. */
    amount?: number | null;
    /**
     * Emite uma nova cobrança (ex.: chamar /stripe/create-payment de novo). Exibido
     * como "Gerar novo QR" quando o QR expira. Se devolver Promise e `regenerating`
     * não for passado, o botão mostra carregando até ela terminar.
     */
    onRegenerate?: () => unknown;
    /** Carregando controlado pelo pai (tem precedência sobre o estado interno). */
    regenerating?: boolean;
    /** Disparado UMA vez quando a contagem chega a zero (ex.: pausar o polling). */
    onExpire?: () => void;
    className?: string;
}

const QR_TIMEOUT_MS = 6000;
const COPY_FEEDBACK_MS = 3000;

function toImageSrc(v: string | null | undefined): string | null {
    const s = v?.trim();
    if (!s) return null;
    return s.startsWith('data:') ? s : `data:image/png;base64,${s}`;
}

function toDeadline(v: string | number | null | undefined): number | null {
    if (v == null || v === '') return null;
    const ms = typeof v === 'number' ? v : new Date(v).getTime();
    return Number.isFinite(ms) ? ms : null;
}

function formatRemaining(secs: number): string {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

async function copyToClipboard(text: string): Promise<boolean> {
    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch { /* cai no fallback */ }
    // Fallback (HTTP na rede local, WebViews antigos): textarea temporário + execCommand.
    const previouslyFocused = document.activeElement as HTMLElement | null;
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '0';
        ta.style.left = '0';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
    } catch {
        return false;
    } finally {
        previouslyFocused?.focus?.();
    }
}

type QrView = { status: 'loading' } | { status: 'ready'; src: string } | { status: 'error' };

/**
 * Bloco PIX presentacional: valor, QR Code, contagem de validade, copia-e-cola e
 * "QR expirado → Gerar novo QR" (D15). Não chama API — quem usa decide como
 * emitir/renovar a cobrança (`onRegenerate`) e continua responsável pelo polling.
 *
 * - Usa `qrCodeDataUrl` se vier; senão gera localmente com `qrcode`.
 * - Se a imagem não puder ser gerada/exibida, mostra orientação para usar o
 *   copia-e-cola (nunca spinner eterno: há timeout de geração).
 * - Expirado: esconde QR e código (não induz a pagar cobrança morta).
 *
 * Reaproveita as classes .checkout-qr-wrapper/.checkout-qr-loading/
 * .checkout-pix-code/.checkout-copy-btn (checkout.css) + pix-qrcode.css.
 *
 * @example
 * <PixQrCode pixString={pix.pixString} qrCodeDataUrl={pix.qrCodeDataUrl}
 *   expiresAt={pix.expiresAt} amount={pix.amount}
 *   onRegenerate={regeneratePix} regenerating={regenerating} />
 */
export default function PixQrCode({
    pixString,
    qrCodeDataUrl,
    expiresAt,
    amount,
    onRegenerate,
    regenerating,
    onExpire,
    className,
}: PixQrCodeProps) {
    const [failedSrc, setFailedSrc] = useState<string | null>(null);
    const providedRaw = toImageSrc(qrCodeDataUrl);
    // Imagem do backend que não carregou → cai para a geração local.
    const provided = providedRaw && providedRaw !== failedSrc ? providedRaw : null;
    const [generated, setGenerated] = useState<{ key: string; src: string | null } | null>(null);
    const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
    const [localBusy, setLocalBusy] = useState(false);
    const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const mountedRef = useRef(true);

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
        };
    }, []);

    // Geração local (só quando o backend não mandou a imagem).
    useEffect(() => {
        if (provided || !pixString) return;
        let done = false;
        const finish = (src: string | null) => {
            if (done) return;
            done = true;
            clearTimeout(timeout);
            setGenerated({ key: pixString, src });
        };
        const timeout = setTimeout(() => finish(null), QR_TIMEOUT_MS);
        try {
            QRCodeLib.toDataURL(pixString, {
                width: 280,
                margin: 2,
                color: { dark: '#000000', light: '#ffffff' },
                errorCorrectionLevel: 'M',
            }).then(src => finish(src), () => finish(null));
        } catch {
            finish(null);
        }
        return () => {
            done = true;
            clearTimeout(timeout);
        };
    }, [provided, pixString]);

    // Código novo → volta o feedback de cópia ao normal.
    useEffect(() => {
        setCopyState('idle');
    }, [pixString]);

    let qr: QrView;
    if (provided) qr = { status: 'ready', src: provided };
    else if (!pixString) qr = { status: 'error' };
    else if (generated && generated.key === pixString) qr = generated.src ? { status: 'ready', src: generated.src } : { status: 'error' };
    else qr = { status: 'loading' };
    if (qr.status === 'ready' && qr.src === failedSrc) qr = { status: 'error' };

    const deadline = toDeadline(expiresAt);
    const remaining = useCountdown(deadline, onExpire);
    const expired = remaining === 0;
    const timerLevel = remaining == null ? 'calm' : remaining <= 60 ? 'danger' : remaining <= 180 ? 'warning' : 'calm';

    const busy = regenerating ?? localBusy;

    const handleCopy = async () => {
        if (!pixString || expired) return;
        const ok = await copyToClipboard(pixString);
        if (!mountedRef.current) return;
        setCopyState(ok ? 'copied' : 'failed');
        if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
        copyTimerRef.current = setTimeout(() => {
            if (mountedRef.current) setCopyState('idle');
        }, COPY_FEEDBACK_MS);
    };

    const handleRegenerate = () => {
        if (!onRegenerate || busy) return;
        const result = onRegenerate();
        if (regenerating === undefined && result && typeof (result as Promise<unknown>).then === 'function') {
            setLocalBusy(true);
            (result as Promise<unknown>)
                .catch(() => { /* o chamador exibe o erro */ })
                .finally(() => { if (mountedRef.current) setLocalBusy(false); });
        }
    };

    const liveMessage = expired
        ? 'O QR Code PIX expirou.'
        : copyState === 'copied'
            ? 'Código PIX copiado.'
            : copyState === 'failed'
                ? 'Não foi possível copiar o código PIX.'
                : '';

    return (
        <div className={`pix-qr${className ? ` ${className}` : ''}`}>
            {amount != null && (
                <div className="pix-qr__amount">
                    <span className="pix-qr__amount-label">Valor</span>
                    <strong className="pix-qr__amount-value">{formatBRL(amount)}</strong>
                </div>
            )}

            {remaining != null && !expired && (
                <div
                    className="pix-qr__timer"
                    data-level={timerLevel}
                    role="timer"
                    aria-label={`O QR Code expira em ${formatRemaining(remaining)}`}
                >
                    <Clock size={14} aria-hidden="true" />
                    <span>Expira em <strong>{formatRemaining(remaining)}</strong></span>
                </div>
            )}

            {expired ? (
                <div className="checkout-qr-loading pix-qr__state pix-qr__state--expired">
                    <TimerOff size={30} aria-hidden="true" className="pix-qr__state-icon" />
                    <strong className="pix-qr__state-title">QR expirado</strong>
                    <span className="pix-qr__state-text">
                        {onRegenerate
                            ? 'Este código não pode mais ser pago. Gere um novo para continuar.'
                            : 'Este código não pode mais ser pago. Gere uma nova cobrança para continuar.'}
                    </span>
                    {onRegenerate && (
                        <button
                            type="button"
                            className="pix-qr__regen-btn"
                            onClick={handleRegenerate}
                            disabled={busy}
                            aria-busy={busy || undefined}
                        >
                            {busy
                                ? <><Loader2 size={16} className="pix-qr__spin" aria-hidden="true" /> Gerando…</>
                                : <><RefreshCw size={16} aria-hidden="true" /> Gerar novo QR</>}
                        </button>
                    )}
                </div>
            ) : busy ? (
                <div className="checkout-qr-loading pix-qr__state" role="status">
                    <Loader2 size={28} className="pix-qr__spin pix-qr__state-icon" aria-hidden="true" />
                    <span className="pix-qr__state-text">Gerando novo QR Code…</span>
                </div>
            ) : qr.status === 'ready' ? (
                <div className="checkout-qr-wrapper">
                    <img
                        src={qr.src}
                        alt="QR Code PIX"
                        onError={() => setFailedSrc(qr.status === 'ready' ? qr.src : null)}
                    />
                </div>
            ) : qr.status === 'loading' ? (
                <div className="checkout-qr-loading pix-qr__state" role="status">
                    <Loader2 size={28} className="pix-qr__spin pix-qr__state-icon" aria-hidden="true" />
                    <span className="pix-qr__state-text">Gerando QR Code…</span>
                </div>
            ) : (
                <div className="checkout-qr-loading pix-qr__state pix-qr__state--fallback">
                    <QrCode size={30} aria-hidden="true" className="pix-qr__state-icon" />
                    <strong className="pix-qr__state-title">QR Code indisponível</strong>
                    <span className="pix-qr__state-text">
                        {pixString
                            ? 'Use o PIX copia e cola: copie o código abaixo e cole no app do seu banco.'
                            : 'O código PIX não foi recebido. Gere a cobrança novamente.'}
                    </span>
                </div>
            )}

            {!expired && pixString && (
                <>
                    <div className="checkout-pix-code pix-qr__code" title="Toque para selecionar o código">
                        {pixString}
                    </div>
                    <button
                        type="button"
                        onClick={handleCopy}
                        disabled={busy}
                        className={`checkout-copy-btn${copyState === 'copied' ? ' checkout-copy-btn--copied' : ''}`}
                    >
                        {copyState === 'copied'
                            ? <><Check size={14} aria-hidden="true" /> Copiado!</>
                            : <><Copy size={14} aria-hidden="true" /> Copiar código PIX</>}
                    </button>
                    {copyState === 'failed' && (
                        <p className="pix-qr__copy-hint" role="alert">
                            Não foi possível copiar automaticamente. Toque no código acima para selecioná-lo e copie manualmente.
                        </p>
                    )}
                </>
            )}

            <span className="pix-qr__sr" aria-live="polite">{liveMessage}</span>
        </div>
    );
}

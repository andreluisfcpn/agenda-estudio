// ─── CouponField — campo compartilhado de cupom de desconto ─────────
// Estado vazio: link discreto "Tem um cupom de desconto?" → expande para
// input (uppercase, Enter aplica) + botão "Aplicar".
// Aplicado: colapsa para linha verde com o desconto + botão "✕ Remover".
// Re-valida automaticamente (debounce ~400ms) quando o amount muda; se a
// re-validação falhar, remove o cupom e mostra um aviso.
import { useEffect, useRef, useState } from 'react';
import { couponsApi, ApiError, type CouponValidation } from '../api/client';
import { formatBRL } from '../utils/format';

interface CouponFieldProps {
    /** Total atual em centavos (pré-cupom). */
    amount: number;
    /** Fluxos admin: id do cliente-alvo. */
    userId?: string;
    applied: CouponValidation | null;
    onApply: (v: CouponValidation) => void;
    onRemove: () => void;
    disabled?: boolean;
}

const FALLBACK_ERROR = 'Não foi possível validar o cupom. Tente novamente.';
const LOCKED_TITLE = 'O pagamento já foi gerado — não é possível alterar o cupom.';

export default function CouponField({ amount, userId, applied, onApply, onRemove, disabled = false }: CouponFieldProps) {
    const [expanded, setExpanded] = useState(false);
    const [code, setCode] = useState('');
    const [validating, setValidating] = useState(false);
    const [error, setError] = useState('');
    const [warning, setWarning] = useState('');
    // Último amount validado com sucesso — evita re-validar logo após aplicar.
    const lastValidatedAmount = useRef<number | null>(null);

    const apply = async () => {
        const trimmed = code.trim().toUpperCase();
        if (!trimmed || validating || disabled) return;
        setValidating(true);
        setError('');
        setWarning('');
        try {
            const v = await couponsApi.validate({ code: trimmed, amount, ...(userId ? { userId } : {}) });
            lastValidatedAmount.current = amount;
            onApply(v);
            setExpanded(false);
            setCode('');
        } catch (err) {
            setError(err instanceof ApiError && err.message ? err.message : FALLBACK_ERROR);
        } finally {
            setValidating(false);
        }
    };

    // Re-validação automática quando o total muda com cupom aplicado (debounce ~400ms).
    const appliedCode = applied?.code ?? null;
    useEffect(() => {
        if (!appliedCode || disabled) return;
        if (lastValidatedAmount.current === amount) return;
        const t = window.setTimeout(async () => {
            try {
                const v = await couponsApi.validate({ code: appliedCode, amount, ...(userId ? { userId } : {}) });
                lastValidatedAmount.current = amount;
                onApply(v);
            } catch (err) {
                lastValidatedAmount.current = null;
                onRemove();
                setWarning(err instanceof ApiError && err.message
                    ? `Cupom removido: ${err.message}`
                    : 'O cupom não é válido para o novo valor e foi removido.');
            }
        }, 400);
        return () => window.clearTimeout(t);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [amount, appliedCode, userId, disabled]);

    // ── Aplicado: linha verde + remover ──
    if (applied) {
        return (
            <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
                padding: '10px 12px', marginBottom: 12,
                background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.25)',
                borderRadius: 'var(--radius-sm)',
            }}>
                <span style={{ fontSize: '0.8125rem', fontWeight: 600, color: '#10b981' }}>
                    ✓ Cupom {applied.code} aplicado — −{formatBRL(applied.discountAmount)}
                </span>
                <button
                    type="button"
                    onClick={() => { if (!disabled) { lastValidatedAmount.current = null; setWarning(''); onRemove(); } }}
                    disabled={disabled}
                    title={disabled ? LOCKED_TITLE : undefined}
                    style={{
                        background: 'none', border: 'none', padding: 0,
                        fontSize: '0.78rem', fontWeight: 600, whiteSpace: 'nowrap',
                        color: disabled ? 'var(--text-muted)' : '#ef4444',
                        cursor: disabled ? 'not-allowed' : 'pointer',
                    }}>
                    ✕ Remover
                </button>
            </div>
        );
    }

    // ── Vazio: link discreto → input + botão aplicar ──
    return (
        <div style={{ marginBottom: 12 }}>
            {!expanded ? (
                <button
                    type="button"
                    onClick={() => { if (!disabled) { setExpanded(true); setWarning(''); } }}
                    disabled={disabled}
                    title={disabled ? LOCKED_TITLE : undefined}
                    style={{
                        background: 'none', border: 'none', padding: 0,
                        fontSize: '0.85rem', color: 'var(--text-secondary)',
                        textDecoration: 'underline', textUnderlineOffset: 3,
                        cursor: disabled ? 'not-allowed' : 'pointer',
                    }}>
                    Tem um cupom de desconto?
                </button>
            ) : (
                <div style={{ display: 'flex', gap: 8 }}>
                    <input
                        className="form-input"
                        type="text"
                        value={code}
                        onChange={e => { setCode(e.target.value.toUpperCase()); setError(''); }}
                        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); apply(); } }}
                        placeholder="CÓDIGO DO CUPOM"
                        disabled={disabled || validating}
                        title={disabled ? LOCKED_TITLE : undefined}
                        autoFocus
                        style={{ flex: 1, textTransform: 'uppercase', fontSize: '0.875rem' }}
                    />
                    <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={apply}
                        disabled={disabled || validating || !code.trim()}
                        style={{ whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 6 }}>
                        {validating && <span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />}
                        {validating ? 'Validando...' : 'Aplicar'}
                    </button>
                </div>
            )}
            {error && (
                <div style={{ fontSize: '0.78rem', color: '#ef4444', marginTop: 6 }}>{error}</div>
            )}
            {warning && (
                <div style={{ fontSize: '0.78rem', color: '#f59e0b', marginTop: 6 }}>{warning}</div>
            )}
        </div>
    );
}

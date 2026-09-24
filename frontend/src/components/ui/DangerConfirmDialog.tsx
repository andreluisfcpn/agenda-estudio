import React, { useEffect, useId, useRef, useState } from 'react';
import { AlertTriangle, Loader2, Lock, OctagonAlert, type LucideIcon } from 'lucide-react';
import BottomSheetModal from '../BottomSheetModal';
import { getErrorMessage } from '../../utils/errors';

/**
 * 'danger' = destrutivo (vermelho; por padrão com o selo "Irreversível"). 'warning' = reversível, mas com
 * impacto (âmbar). Ação destrutiva que TEM volta (ex.: bloquear cliente, remover um webhook que pode ser
 * registrado de novo) fica vermelha com `irreversible={false}` — sem o selo.
 */
export type DangerTone = 'danger' | 'warning';

/** Motivo do fechamento: 'cancel' (Voltar/Esc/fundo/arrastar) ou 'confirmed' (onConfirm concluiu). */
export type DangerCloseReason = 'cancel' | 'confirmed';

export interface DangerConfirmDialogProps {
    isOpen: boolean;
    /** Padrão 'danger'. */
    tone?: DangerTone;
    title: string;
    /** Texto principal. Strings respeitam quebras de linha (\n) — white-space: pre-line. */
    description?: React.ReactNode;
    /** Lista "O que vai acontecer" (efeitos concretos da ação). */
    consequences?: string[];
    /** Verbo explícito (ex.: "Excluir cliente"). Padrão: "Confirmar". */
    confirmLabel?: string;
    /** Padrão: "Voltar". */
    cancelLabel?: string;
    /** Texto do botão enquanto `onConfirm` roda (padrão: o próprio confirmLabel). */
    loadingLabel?: string;
    /**
     * Palavra que o usuário precisa digitar para liberar o botão (ex.: "EXCLUIR").
     * Comparação sem diferenciar maiúsculas/minúsculas e sem espaços nas pontas.
     */
    requireText?: string;
    /** Ícone do círculo (padrão: OctagonAlert no danger, AlertTriangle no warning). Ex.: Trash2. */
    icon?: LucideIcon;
    /**
     * Mostra o selo "Irreversível". Padrão: `true` no tom danger, `false` no warning. Passe `false`
     * numa ação vermelha que pode ser desfeita (ou cujo desfecho pode ser só uma desativação), para
     * o diálogo não afirmar uma consequência falsa.
     */
    irreversible?: boolean;
    /**
     * A ação. Se devolver Promise, o diálogo mostra spinner, bloqueia o fechamento
     * e aguarda. Resolveu → fecha com onClose('confirmed'). Rejeitou/lançou → a
     * mensagem do erro aparece DENTRO do diálogo e ele continua aberto.
     */
    onConfirm: () => unknown | Promise<unknown>;
    /** Chamado ao fechar. Callers simples podem ignorar o argumento. */
    onClose: (reason: DangerCloseReason) => void;
    /** Empilhamento acima de outro modal (o showConfirm global usa 10000). */
    zIndex?: number;
}

const normalizeWord = (s: string) => s.trim().toLocaleUpperCase('pt-BR');

/**
 * Diálogo de confirmação de ação destrutiva/crítica (D3), sobre BottomSheetModal.
 *
 * Visual: tom `danger` puxado para o vermelho (ícone em círculo --danger-bg,
 * borda/acento vermelho, selo "Irreversível" — desligável com `irreversible={false}` —,
 * botão vermelho SÓLIDO `.btn-danger-solid`); tom `warning` em âmbar para ações reversíveis.
 *
 * Comportamento: foco inicial no "Voltar"; botões type="button" (sem <form>,
 * Enter no campo de digitação confirma só quando o texto confere); durante o
 * onConfirm assíncrono, spinner + Esc/fundo/arrastar/Voltar bloqueados.
 *
 * @example
 * <DangerConfirmDialog
 *   isOpen={open} tone="danger" icon={Trash2}
 *   title="Excluir cliente?" description={`${u.name} perderá o acesso ao app.`}
 *   consequences={['2 contratos ativos serão cancelados', 'Cobranças pendentes serão anuladas']}
 *   confirmLabel="Excluir cliente" requireText="EXCLUIR"
 *   onConfirm={async () => { await usersApi.remove(u.id); reload(); }}
 *   onClose={() => setOpen(false)}
 * />
 */
export default function DangerConfirmDialog({
    isOpen,
    tone = 'danger',
    title,
    description,
    consequences,
    confirmLabel = 'Confirmar',
    cancelLabel = 'Voltar',
    loadingLabel,
    requireText,
    icon,
    irreversible,
    onConfirm,
    onClose,
    zIndex,
}: DangerConfirmDialogProps) {
    const [typed, setTyped] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const cancelRef = useRef<HTMLButtonElement>(null);
    // Cada abertura ganha uma "época": um onConfirm antigo que termina depois não mexe na abertura nova.
    const epochRef = useRef(0);
    const inputId = useId();
    const errorId = useId();

    useEffect(() => {
        epochRef.current += 1;
        setTyped('');
        setLoading(false);
        setError(null);
        if (!isOpen) return;
        // Foco inicial no "Voltar": o useFocusTrap do BottomSheetModal foca o 1º focável
        // num rAF registrado antes deste (efeito do filho roda primeiro) — este vence.
        const raf = requestAnimationFrame(() => cancelRef.current?.focus());
        return () => cancelAnimationFrame(raf);
    }, [isOpen]);

    const needsText = !!requireText && requireText.trim().length > 0;
    const textOk = !needsText || normalizeWord(typed) === normalizeWord(requireText!);
    const canConfirm = textOk && !loading;

    const dismiss = () => {
        if (!loading) onClose('cancel');
    };

    const handleConfirm = async () => {
        if (!canConfirm) return;
        const epoch = epochRef.current;
        setError(null);
        setLoading(true);
        try {
            await onConfirm();
            if (epoch !== epochRef.current) return;
            setLoading(false);
            onClose('confirmed');
        } catch (err) {
            if (epoch !== epochRef.current) return;
            setLoading(false);
            setError(getErrorMessage(err) || 'Não foi possível concluir a ação. Tente novamente.');
        }
    };

    const Icon = icon ?? (tone === 'danger' ? OctagonAlert : AlertTriangle);
    const showSeal = irreversible ?? tone === 'danger';
    const hasConsequences = !!consequences && consequences.length > 0;

    return (
        <BottomSheetModal
            isOpen={isOpen}
            onClose={dismiss}
            title={title}
            hideHeader
            size="sm"
            preventClose={loading}
            zIndex={zIndex}
            className={`danger-dialog-sheet danger-dialog-sheet--${tone}`}
        >
            <div className={`danger-dialog danger-dialog--${tone}`}>
                <div className="danger-dialog__head">
                    <span className="danger-dialog__icon" aria-hidden="true">
                        <Icon size={26} strokeWidth={2.25} />
                    </span>
                    {showSeal && (
                        <span className="danger-dialog__seal">
                            <Lock size={11} aria-hidden="true" /> Irreversível
                        </span>
                    )}
                    <h2 className="danger-dialog__title">{title}</h2>
                </div>

                {description != null && description !== '' && (
                    <div className="danger-dialog__desc">{description}</div>
                )}

                {hasConsequences && (
                    <div className="danger-dialog__consequences">
                        <p className="danger-dialog__consequences-title">O que vai acontecer</p>
                        <ul className="danger-dialog__consequences-list">
                            {consequences!.map((c, i) => <li key={i}>{c}</li>)}
                        </ul>
                    </div>
                )}

                {needsText && (
                    <div className="danger-dialog__typeconfirm">
                        <label htmlFor={inputId} className="danger-dialog__typeconfirm-label">
                            Para confirmar, digite <strong>{requireText}</strong>
                        </label>
                        <input
                            id={inputId}
                            type="text"
                            className="form-input form-input--raised danger-dialog__typeconfirm-input"
                            value={typed}
                            onChange={e => setTyped(e.target.value)}
                            onKeyDown={e => {
                                if (e.key !== 'Enter') return;
                                e.preventDefault();
                                e.stopPropagation();
                                if (canConfirm) void handleConfirm();
                            }}
                            disabled={loading}
                            autoComplete="off"
                            autoCorrect="off"
                            autoCapitalize="characters"
                            spellCheck={false}
                            aria-invalid={typed.length > 0 && !textOk ? true : undefined}
                            aria-describedby={error ? errorId : undefined}
                        />
                    </div>
                )}

                {error && (
                    <div id={errorId} className="danger-dialog__error" role="alert">{error}</div>
                )}

                <div className="danger-dialog__actions">
                    <button
                        key="cancel"
                        ref={cancelRef}
                        type="button"
                        className="btn btn-secondary danger-dialog__btn"
                        onClick={dismiss}
                        disabled={loading}
                    >
                        {cancelLabel}
                    </button>
                    <button
                        key="confirm"
                        type="button"
                        className={`btn ${tone === 'danger' ? 'btn-danger-solid' : 'btn-warning-solid'} danger-dialog__btn`}
                        onClick={() => void handleConfirm()}
                        disabled={!canConfirm}
                        aria-busy={loading || undefined}
                    >
                        {loading && <Loader2 size={16} className="danger-dialog__spinner" aria-hidden="true" />}
                        {loading ? (loadingLabel ?? confirmLabel) : confirmLabel}
                    </button>
                </div>
            </div>
        </BottomSheetModal>
    );
}

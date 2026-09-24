import React, { createContext, useContext, useState, useCallback, useRef } from 'react';
import { XCircle, CheckCircle2, AlertTriangle, Info, type LucideIcon } from 'lucide-react';
import BottomSheetModal from '../components/BottomSheetModal';
import DangerConfirmDialog, { type DangerTone, type DangerCloseReason } from '../components/ui/DangerConfirmDialog';

type ModalType = 'info' | 'error' | 'success' | 'warning';

const MODAL_ICON: Record<ModalType, LucideIcon> = { info: Info, error: XCircle, success: CheckCircle2, warning: AlertTriangle };
const MODAL_COLOR: Record<ModalType, string> = { info: '#3b82f6', error: '#ef4444', success: '#10b981', warning: '#f59e0b' };

interface ModalOptions {
    title?: string;
    message: string;
    type?: ModalType;
    onConfirm?: () => void;
}

/** 'danger' = irreversível (vermelho); 'warning' = reversível com impacto (âmbar). */
export type ConfirmTone = DangerTone;

export interface ConfirmOptions {
    title?: string;
    /**
     * Corpo do diálogo. Sem `tone`: string (visual legado). Com `tone`: aceita
     * ReactNode e respeita quebras de linha (\n).
     */
    message: React.ReactNode;
    /** Verbo explícito do botão de confirmar (padrão "Confirmar"). */
    confirmLabel?: string;
    /** Padrão: "Cancelar" (legado) / "Voltar" (com tone). */
    cancelLabel?: string;
    /**
     * Sem `tone`: disparado e o diálogo fecha na hora (legado).
     * Com `tone`: se devolver Promise, o diálogo AGUARDA (spinner, fechamento
     * bloqueado); se rejeitar/lançar, a mensagem aparece dentro do diálogo e ele
     * continua aberto — então lance o erro em vez de só mostrar toast.
     */
    onConfirm: () => unknown;
    /** Chamado ao cancelar (botão; com tone também Esc/fundo/arrastar). */
    onCancel?: () => void;
    /** Liga o DangerConfirmDialog (visual de perigo). Sem tone = diálogo genérico de sempre. */
    tone?: ConfirmTone;
    /** Só com tone: lista "O que vai acontecer". */
    consequences?: string[];
    /** Só com tone: palavra a digitar para liberar o botão (ex.: "EXCLUIR"; sem diferenciar maiúsculas). */
    requireText?: string;
    /** Só com tone: ícone do círculo (ex.: Trash2). */
    icon?: LucideIcon;
    /** Só com tone: texto do botão durante o onConfirm (padrão: o confirmLabel). */
    loadingLabel?: string;
    /**
     * Só com tone: selo "Irreversível" (padrão: ligado no danger, desligado no warning). Use `false`
     * numa ação vermelha que tem volta (ex.: bloquear cliente).
     */
    irreversible?: boolean;
}

interface ToastOptions {
    message: string;
    type?: 'success' | 'error';
}

interface UIContextType {
    showAlert: (options: ModalOptions | string) => void;
    showConfirm: (options: ConfirmOptions) => void;
    showToast: (options: ToastOptions | string) => void;
    closeModal: () => void;
}

/** Entrada da fila de modal global (alert, confirm legado ou confirm com tone). */
interface ModalEntry {
    title?: string;
    message: React.ReactNode;
    type?: ModalType;
    isConfirm?: boolean;
    confirmLabel?: string;
    cancelLabel?: string;
    loadingLabel?: string;
    onConfirm?: () => unknown;
    onCancel?: () => void;
    tone?: ConfirmTone;
    consequences?: string[];
    requireText?: string;
    icon?: LucideIcon;
    irreversible?: boolean;
}

const UIContext = createContext<UIContextType | undefined>(undefined);

export function UIProvider({ children }: { children: React.ReactNode }) {
    const [modal, setModal] = useState<ModalEntry | null>(null);
    const [toast, setToast] = useState<ToastOptions | null>(null);

    const showAlert = useCallback((options: ModalOptions | string) => {
        if (typeof options === 'string') {
            setModal({ message: options, type: 'info' });
        } else {
            setModal({ ...options, type: options.type || 'info' });
        }
    }, []);

    const showConfirm = useCallback((options: ConfirmOptions) => {
        setModal({ ...options, type: 'warning', isConfirm: true });
    }, []);

    const showToast = useCallback((options: ToastOptions | string) => {
        if (typeof options === 'string') {
            setToast({ message: options, type: 'success' });
        } else {
            setToast({ ...options, type: options.type || 'success' });
        }
        setTimeout(() => setToast(null), 4000);
    }, []);

    const closeModal = useCallback(() => {
        setModal(null);
    }, []);

    // Fecha SÓ a entrada indicada: se o onConfirm abriu outro alert/confirm, ele não é derrubado.
    const closeEntry = useCallback((entry: ModalEntry) => {
        setModal(prev => (prev === entry ? null : prev));
    }, []);

    // Caminho legado (sem tone): dispara e fecha na hora, como sempre.
    const handleConfirm = useCallback(() => {
        const entry = modal;
        if (!entry) return;
        if (entry.onConfirm) {
            const result = entry.onConfirm();
            if (result && typeof (result as Promise<unknown>).then === 'function') {
                (result as Promise<unknown>).catch(err => console.error('[showConfirm] onConfirm falhou:', err));
            }
        }
        closeEntry(entry);
    }, [modal, closeEntry]);

    const handleCancel = useCallback(() => {
        const entry = modal;
        if (!entry) return;
        entry.onCancel?.();
        closeEntry(entry);
    }, [modal, closeEntry]);

    // Caminho com tone → DangerConfirmDialog. Guarda a última entrada para o conteúdo
    // continuar estável durante a animação de saída.
    const toneEntry = modal?.tone ? modal : null;
    const lastToneRef = useRef<ModalEntry | null>(null);
    if (toneEntry) lastToneRef.current = toneEntry;
    const toneView = toneEntry ?? lastToneRef.current;

    const handleToneClose = (reason: DangerCloseReason) => {
        if (!toneEntry) return;
        if (reason === 'cancel') toneEntry.onCancel?.();
        closeEntry(toneEntry);
    };

    const legacyOpen = !!modal && !modal.tone;

    return (
        <UIContext.Provider value={{ showAlert, showConfirm, showToast, closeModal }}>
            {children}

            {/* Global Modal Render */}
            <BottomSheetModal
                isOpen={legacyOpen}
                onClose={closeModal}
                title={modal?.title || (modal?.type === 'error' ? 'Erro' : modal?.type === 'success' ? 'Sucesso' : modal?.type === 'warning' ? 'Atenção' : 'Aviso')}
                maxWidth="400px"
                zIndex={10000}
            >
                <div style={{ textAlign: 'center', padding: '0 4px' }}>
                    {(() => {
                        const t = modal?.type || 'info';
                        const Icon = MODAL_ICON[t];
                        return (
                            <div style={{
                                width: 56, height: 56, borderRadius: 16, margin: '0 auto 16px',
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                background: `${MODAL_COLOR[t]}1f`, color: MODAL_COLOR[t],
                            }}>
                                <Icon size={28} />
                            </div>
                        );
                    })()}
                    {typeof modal?.message === 'string' || modal?.message == null ? (
                        <p style={{ color: 'var(--text-secondary)', marginBottom: '24px', lineHeight: 1.5 }}>
                            {modal?.message}
                        </p>
                    ) : (
                        <div style={{ color: 'var(--text-secondary)', marginBottom: '24px', lineHeight: 1.5 }}>
                            {modal.message}
                        </div>
                    )}
                    <div style={{ display: 'flex', gap: '12px' }}>
                        {modal?.isConfirm && (
                            <button type="button" className="btn btn-secondary" style={{ flex: 1 }} onClick={handleCancel}>
                                {modal.cancelLabel || 'Cancelar'}
                            </button>
                        )}
                        <button type="button" className="btn btn-primary" style={{ flex: 1 }} onClick={handleConfirm}>
                            {modal?.isConfirm ? (modal.confirmLabel || 'Confirmar') : 'Entendido'}
                        </button>
                    </div>
                </div>
            </BottomSheetModal>

            {/* Confirmação com visual de perigo (showConfirm com tone) */}
            <DangerConfirmDialog
                isOpen={!!toneEntry}
                tone={toneView?.tone ?? 'danger'}
                title={toneView?.title || (toneView?.tone === 'warning' ? 'Atenção' : 'Confirmar ação')}
                description={toneView?.message}
                consequences={toneView?.consequences}
                confirmLabel={toneView?.confirmLabel}
                cancelLabel={toneView?.cancelLabel}
                loadingLabel={toneView?.loadingLabel}
                requireText={toneView?.requireText}
                icon={toneView?.icon}
                irreversible={toneView?.irreversible}
                onConfirm={() => toneEntry?.onConfirm?.()}
                onClose={handleToneClose}
                zIndex={10000}
            />

            {/* Global Toast Render */}
            {toast && (
                <div className="global-toast" style={{
                    position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', zIndex: 10001,
                    padding: '12px 24px', borderRadius: 'var(--radius-md)',
                    background: toast.type === 'error' ? 'var(--status-blocked)' : 'var(--tier-comercial)',
                    color: '#fff', fontWeight: 600, boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
                    animation: 'slideUp 0.3s ease-out', display: 'flex', alignItems: 'center', gap: '10px',
                    maxWidth: 'calc(100vw - 32px)',
                }}>
                    {toast.type === 'error' ? <XCircle size={18} /> : <CheckCircle2 size={18} />} {toast.message}
                </div>
            )}
        </UIContext.Provider>
    );
}

export function useUI() {
    const context = useContext(UIContext);
    if (!context) throw new Error('useUI must be used within UIProvider');
    return context;
}

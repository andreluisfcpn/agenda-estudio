import React, { createContext, useContext, useState, useCallback } from 'react';
import { XCircle, CheckCircle2, AlertTriangle, Info, type LucideIcon } from 'lucide-react';
import BottomSheetModal from '../components/BottomSheetModal';

type ModalType = 'info' | 'error' | 'success' | 'warning';

const MODAL_ICON: Record<ModalType, LucideIcon> = { info: Info, error: XCircle, success: CheckCircle2, warning: AlertTriangle };
const MODAL_COLOR: Record<ModalType, string> = { info: '#3b82f6', error: '#ef4444', success: '#10b981', warning: '#f59e0b' };

interface ModalOptions {
    title?: string;
    message: string;
    type?: ModalType;
    onConfirm?: () => void;
}

interface ToastOptions {
    message: string;
    type?: 'success' | 'error';
}

interface UIContextType {
    showAlert: (options: ModalOptions | string) => void;
    showConfirm: (options: { title?: string; message: string; confirmLabel?: string; onConfirm: () => void; onCancel?: () => void }) => void;
    showToast: (options: ToastOptions | string) => void;
    closeModal: () => void;
}

const UIContext = createContext<UIContextType | undefined>(undefined);

export function UIProvider({ children }: { children: React.ReactNode }) {
    const [modal, setModal] = useState<(ModalOptions & { isConfirm?: boolean; confirmLabel?: string; onCancel?: () => void }) | null>(null);
    const [toast, setToast] = useState<ToastOptions | null>(null);

    const showAlert = useCallback((options: ModalOptions | string) => {
        if (typeof options === 'string') {
            setModal({ message: options, type: 'info' });
        } else {
            setModal({ ...options, type: options.type || 'info' });
        }
    }, []);

    const showConfirm = useCallback((options: { title?: string; message: string; confirmLabel?: string; onConfirm: () => void; onCancel?: () => void }) => {
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

    const handleConfirm = useCallback(() => {
        if (modal?.onConfirm) modal.onConfirm();
        setModal(null);
    }, [modal]);

    const handleCancel = useCallback(() => {
        if (modal?.onCancel) modal.onCancel();
        setModal(null);
    }, [modal]);

    return (
        <UIContext.Provider value={{ showAlert, showConfirm, showToast, closeModal }}>
            {children}
            
            {/* Global Modal Render */}
            <BottomSheetModal
                isOpen={!!modal}
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
                    <p style={{ color: 'var(--text-secondary)', marginBottom: '24px', lineHeight: 1.5 }}>
                        {modal?.message}
                    </p>
                    <div style={{ display: 'flex', gap: '12px' }}>
                        {modal?.isConfirm && (
                            <button className="btn btn-secondary" style={{ flex: 1 }} onClick={handleCancel}>
                                Cancelar
                            </button>
                        )}
                        <button className="btn btn-primary" style={{ flex: 1 }} onClick={handleConfirm}>
                            {modal?.isConfirm ? (modal.confirmLabel || 'Confirmar') : 'Entendido'}
                        </button>
                    </div>
                </div>
            </BottomSheetModal>

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

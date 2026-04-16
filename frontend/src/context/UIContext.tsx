import React, { createContext, useContext, useState, useCallback } from 'react';
import ModalOverlay from '../components/ModalOverlay';

type ModalType = 'info' | 'error' | 'success' | 'warning';

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
    showConfirm: (options: { title?: string; message: string; onConfirm: () => void; onCancel?: () => void }) => void;
    showToast: (options: ToastOptions | string) => void;
    closeModal: () => void;
}

const UIContext = createContext<UIContextType | undefined>(undefined);

export function UIProvider({ children }: { children: React.ReactNode }) {
    const [modal, setModal] = useState<(ModalOptions & { isConfirm?: boolean; onCancel?: () => void }) | null>(null);
    const [toast, setToast] = useState<ToastOptions | null>(null);

    const showAlert = useCallback((options: ModalOptions | string) => {
        if (typeof options === 'string') {
            setModal({ message: options, type: 'info' });
        } else {
            setModal({ ...options, type: options.type || 'info' });
        }
    }, []);

    const showConfirm = useCallback((options: { title?: string; message: string; onConfirm: () => void; onCancel?: () => void }) => {
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
            {modal && (
                <ModalOverlay onClose={closeModal} style={{ zIndex: 10000 }}>
                    <div className="modal" style={{ maxWidth: 400, textAlign: 'center' }}>
                        <div style={{ fontSize: '3rem', marginBottom: '16px' }}>
                            {modal.type === 'error' ? '❌' : modal.type === 'success' ? '✅' : modal.type === 'warning' ? '⚠️' : 'ℹ️'}
                        </div>
                        {modal.title && <h2 className="modal-title" style={{ marginBottom: '8px' }}>{modal.title}</h2>}
                        <p style={{ color: 'var(--text-secondary)', marginBottom: '24px', lineHeight: 1.5 }}>
                            {modal.message}
                        </p>
                        <div style={{ display: 'flex', gap: '12px' }}>
                            {modal.isConfirm && (
                                <button className="btn btn-secondary" style={{ flex: 1 }} onClick={handleCancel}>
                                    Cancelar
                                </button>
                            )}
                            <button className="btn btn-primary" style={{ flex: 1 }} onClick={handleConfirm}>
                                {modal.isConfirm ? 'Confirmar' : 'Entendido'}
                            </button>
                        </div>
                    </div>
                </ModalOverlay>
            )}

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
                    {toast.type === 'error' ? '❌' : '✅'} {toast.message}
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

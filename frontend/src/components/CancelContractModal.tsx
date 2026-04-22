import { useState } from 'react';
import BottomSheetModal from './BottomSheetModal';
import { AlertTriangle } from 'lucide-react';

interface CancelContractModalProps {
    isOpen: boolean;
    feeNote: string;
    onClose: () => void;
    onConfirm: () => Promise<void>;
}

export default function CancelContractModal({ isOpen, feeNote, onClose, onConfirm }: CancelContractModalProps) {
    const [loading, setLoading] = useState(false);

    const handleConfirm = async () => {
        setLoading(true);
        try { await onConfirm(); }
        finally { setLoading(false); }
    };

    return (
        <BottomSheetModal isOpen={isOpen} onClose={onClose} title="Solicitar Cancelamento" preventClose={loading} maxWidth="400px">
            <div style={{ textAlign: 'center', marginBottom: '20px' }}>
                <AlertTriangle size={48} style={{ color: '#f59e0b', marginBottom: '10px' }} />
            </div>
            <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginBottom: '16px', lineHeight: 1.5, textAlign: 'center' }}>
                Tem certeza que deseja solicitar o cancelamento antecipado deste contrato?
            </p>
            <div style={{ background: '#FFF0F0', border: '1px solid #FFCDD2', padding: '12px 16px', borderRadius: 'var(--radius-md)', color: '#D32F2F', fontSize: '0.8125rem', marginBottom: '24px', fontWeight: 500, lineHeight: 1.4 }}>
                <strong>Atenção:</strong> O cancelamento implica uma respectiva multa de {feeNote} Todos os seus horários futuros atrelados a este contrato serão libertados e cancelados de imediato.
            </div>
            <div className="modal-actions">
                <button className="btn btn-secondary" onClick={onClose} disabled={loading} style={{ flex: 1 }}>
                    Voltar
                </button>
                <button className="btn btn-danger" onClick={handleConfirm} disabled={loading} style={{ flex: 1 }}>
                    {loading ? 'Aguarde...' : 'Confirmar Cancelamento'}
                </button>
            </div>
        </BottomSheetModal>
    );
}

import { useState } from 'react';
import BottomSheetModal from './BottomSheetModal';
import { getClientPaymentMethods } from '../constants/paymentMethods';

interface RenewContractModalProps {
    isOpen: boolean;
    tier: string;
    onClose: () => void;
    onConfirm: (durationMonths: 3 | 6 | 12, paymentMethod: 'PIX' | 'CARTAO') => Promise<void>;
}

export default function RenewContractModal({ isOpen, tier, onClose, onConfirm }: RenewContractModalProps) {
    const [duration, setDuration] = useState<3 | 6 | 12>(3);
    const [method, setMethod] = useState<'PIX' | 'CARTAO'>('PIX');
    const [loading, setLoading] = useState(false);

    const handleConfirm = async () => {
        setLoading(true);
        try { await onConfirm(duration, method); }
        finally { setLoading(false); }
    };

    return (
        <BottomSheetModal isOpen={isOpen} onClose={onClose} title="Renovar Contrato" preventClose={loading} maxWidth="400px">
            <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginBottom: '20px' }}>
                Renove seu plano <strong>{tier}</strong> agora para garantir seu horário e preço.
            </p>

            <div className="form-group">
                <label className="form-label">Duração (Meses)</label>
                <select className="form-input" value={duration} onChange={e => setDuration(Number(e.target.value) as 3 | 6 | 12)}>
                    <option value={3}>3 Meses</option>
                    <option value={6}>6 Meses</option>
                    <option value={12}>12 Meses</option>
                </select>
            </div>

            <div className="form-group" style={{ marginTop: '16px' }}>
                <label className="form-label">Método de Pagamento da Fatura</label>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px' }}>
                    {getClientPaymentMethods().map(pm => (
                        <button key={pm.key} onClick={() => setMethod(pm.key as 'PIX' | 'CARTAO')}
                            style={{
                                padding: '10px 0', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)',
                                background: method === pm.key ? 'var(--bg-card)' : 'transparent', fontWeight: 600, fontSize: '0.8125rem',
                                borderColor: method === pm.key ? pm.color : 'var(--border-subtle)',
                                color: method === pm.key ? pm.color : 'var(--text-secondary)'
                            }}>
                            {pm.emoji} {pm.label}
                        </button>
                    ))}
                </div>
            </div>

            <div className="modal-actions" style={{ marginTop: '24px' }}>
                <button className="btn btn-secondary" onClick={onClose} disabled={loading} style={{ flex: 1 }}>Voltar</button>
                <button className="btn btn-primary" onClick={handleConfirm} disabled={loading} style={{ flex: 1 }}>
                    {loading ? 'Gerando...' : 'Confirmar'}
                </button>
            </div>
        </BottomSheetModal>
    );
}

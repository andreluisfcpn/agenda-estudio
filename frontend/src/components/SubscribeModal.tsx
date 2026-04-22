import { useState } from 'react';
import BottomSheetModal from './BottomSheetModal';
import { CreditCard, AlertTriangle } from 'lucide-react';
import { type SavedCard } from '../api/client';

interface SubscribeModalProps {
    isOpen: boolean;
    contractName: string;
    contractTier: string;
    savedCards: SavedCard[];
    onClose: () => void;
    onConfirm: (paymentMethodId: string) => Promise<void>;
}

export default function SubscribeModal({ isOpen, contractName, contractTier, savedCards, onClose, onConfirm }: SubscribeModalProps) {
    const [selectedCardId, setSelectedCardId] = useState<string>(() => {
        const defaultCard = savedCards.find(c => c.isDefault) || savedCards[0];
        return defaultCard?.id || '';
    });
    const [loading, setLoading] = useState(false);

    const handleConfirm = async () => {
        if (!selectedCardId) return;
        setLoading(true);
        try { await onConfirm(selectedCardId); }
        finally { setLoading(false); }
    };

    return (
        <BottomSheetModal isOpen={isOpen} onClose={onClose} title="Ativar Cobrança Automática" preventClose={loading} maxWidth="450px">
            <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginBottom: '16px' }}>
                O plano <strong>{contractName} ({contractTier})</strong> será cobrado mensalmente no seu cartão salvo de forma automática.
            </p>

            {savedCards.length > 0 ? (
                <div className="form-group">
                    <label className="form-label" style={{ fontWeight: 700 }}>Escolha o Cartão</label>
                    <div style={{ display: 'grid', gap: '8px' }}>
                        {savedCards.map(card => (
                            <div key={card.id} onClick={() => setSelectedCardId(card.id)}
                                style={{
                                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                                    padding: '12px 16px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)',
                                    border: `2px solid ${selectedCardId === card.id ? 'var(--accent-primary)' : 'transparent'}`,
                                    cursor: 'pointer', transition: 'all 0.2s ease',
                                }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                                    <CreditCard size={24} />
                                    <div>
                                        <div style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--text-primary)' }}>
                                            {card.brand.toUpperCase()} final {card.last4}
                                        </div>
                                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Exp {card.expMonth.toString().padStart(2, '0')}/{card.expYear.toString().slice(-2)}</div>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            ) : (
                <div style={{ background: '#FFF8E1', padding: '16px', borderRadius: 'var(--radius-md)', border: '1px solid #FFE082', marginBottom: '20px' }}>
                    <AlertTriangle size={20} style={{ color: '#f59e0b' }} />
                    <span style={{ fontSize: '0.875rem', color: '#F57F17', fontWeight: 600, display: 'block', marginTop: '8px' }}>
                        Você precisa adicionar um Cartão de Crédito primeiro em "Meus Pagamentos".
                    </span>
                </div>
            )}

            <div className="modal-actions" style={{ marginTop: '24px' }}>
                <button className="btn btn-secondary" onClick={onClose} disabled={loading} style={{ flex: 1 }}>
                    Cancelar
                </button>
                <button className="btn btn-primary" onClick={handleConfirm} disabled={loading || savedCards.length === 0 || !selectedCardId} style={{ flex: 1 }}>
                    {loading ? 'Processando...' : 'Assinar Automaticamente'}
                </button>
            </div>
        </BottomSheetModal>
    );
}

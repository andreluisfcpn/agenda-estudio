import { useState } from 'react';
import BottomSheetModal from './BottomSheetModal';
import { Rocket } from 'lucide-react';
import { useBusinessConfig } from '../hooks/useBusinessConfig';
import { getClientPaymentMethods, type PaymentMethodKey } from '../constants/paymentMethods';
import { formatBRL } from '../utils/format';

interface Addon {
    key: string;
    name: string;
    price: number;
    description?: string | null;
    monthly?: boolean;
}

interface SocialServiceModalProps {
    isOpen: boolean;
    addon: Addon;
    onClose: () => void;
    onConfirm: (paymentMethod: PaymentMethodKey, durationMonths: 3 | 6) => Promise<void>;
}

export default function SocialServiceModal({ isOpen, addon, onClose, onConfirm }: SocialServiceModalProps) {
    const { get: getRule } = useBusinessConfig();
    const [duration, setDuration] = useState<3 | 6>(3);
    const [payment, setPayment] = useState<PaymentMethodKey | null>(null);
    const [loading, setLoading] = useState(false);

    const handleConfirm = async () => {
        if (!payment) return;
        setLoading(true);
        try { await onConfirm(payment, duration); }
        finally { setLoading(false); }
    };

    const monthlyBase = addon.price;
    const discountPct = duration === 6 ? getRule('service_discount_6months') : getRule('service_discount_3months');
    const monthlyDiscounted = Math.round(monthlyBase * (1 - discountPct / 100));
    const subtotal = monthlyDiscounted * duration;
    const pixExtra = getRule('pix_extra_discount_pct');
    const card3xFee = getRule('card_fee_3x_pct');
    const card6xFee = getRule('card_fee_6x_pct');
    const pixTotal = Math.round(subtotal * (1 - pixExtra / 100));
    const cardRate = duration === 3 ? (1 + card3xFee / 100) : (1 + card6xFee / 100);
    const cardTotal = Math.round(subtotal * cardRate);

    return (
        <BottomSheetModal isOpen={isOpen} onClose={onClose} title={`Assinar ${addon.name}`} preventClose={loading} maxWidth="460px">
            <div style={{ textAlign: 'center', marginBottom: '20px' }}>
                <Rocket size={48} style={{ color: 'var(--accent-primary)', marginBottom: '10px' }} />
            </div>

            <div style={{ fontWeight: 700, fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: '10px' }}>
                1. Escolha sua Fidelidade
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '24px' }}>
                {([3, 6] as const).map((dur) => {
                    const isSel = duration === dur;
                    const dp = dur === 6 ? getRule('service_discount_6months') : getRule('service_discount_3months');
                    return (
                        <div key={dur} onClick={() => setDuration(dur)} style={{
                            border: `2px solid ${isSel ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                            background: isSel ? 'rgba(139, 92, 246, 0.08)' : 'var(--bg-secondary)',
                            borderRadius: 'var(--radius-md)', padding: '16px', cursor: 'pointer', textAlign: 'center', transition: 'all 0.2s',
                            position: 'relative', overflow: 'hidden'
                        }}>
                            <div style={{ fontSize: '1.25rem', fontWeight: 800, color: isSel ? 'var(--accent-primary)' : 'var(--text-primary)' }}>{dur} Meses</div>
                            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '4px' }}>Desconto de {dp}%</div>
                            {dur === 6 && (
                                <div style={{ position: 'absolute', top: 12, right: -24, background: '#22c55e', color: '#fff', fontSize: '0.625rem', fontWeight: 800, padding: '2px 24px', transform: 'rotate(45deg)' }}>
                                    MELHOR
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>

            {/* Price Summary */}
            <div style={{ padding: '16px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)', marginBottom: '24px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px', fontSize: '0.875rem' }}>
                    <span style={{ color: 'var(--text-secondary)' }}>Valor Original ({duration}x {formatBRL(monthlyBase)})</span>
                    <span style={{ textDecoration: 'line-through', color: 'var(--text-muted)' }}>{formatBRL(monthlyBase * duration)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '1rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                    <span>Subtotal com {discountPct}% OFF</span>
                    <span>{formatBRL(subtotal)}</span>
                </div>
            </div>

            <div style={{ fontWeight: 700, fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: '10px' }}>
                2. Forma de Pagamento Única
            </div>

            {getClientPaymentMethods().map(pm => {
                const isSelected = payment === pm.key;
                return (
                    <div key={pm.key} onClick={() => setPayment(pm.key as PaymentMethodKey)}
                        style={{
                            padding: '12px 14px', borderRadius: 'var(--radius-sm)', marginBottom: '10px', cursor: 'pointer',
                            background: isSelected ? pm.bgActive : pm.bgInactive,
                            border: `2px solid ${isSelected ? pm.borderActive : pm.borderInactive}`,
                            transition: 'all 0.2s ease',
                        }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <div>
                                <div style={{ fontWeight: 700, fontSize: '0.875rem' }}>{pm.emoji} {pm.key === 'PIX' ? `${pm.label} (-${pixExtra}% Extra)` : `${pm.label} em até ${duration}x`}</div>
                                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{pm.key === 'PIX' ? 'Pagamento à vista' : `+ ${Math.round((cardRate - 1) * 100)}% Tx. de Parcelamento`}</div>
                            </div>
                            <div style={{ textAlign: 'right' }}>
                                {pm.key === 'PIX' ? (
                                    <div style={{ fontSize: '1.125rem', fontWeight: 800, color: pm.color }}>{formatBRL(pixTotal)}</div>
                                ) : (
                                    <div style={{ fontSize: '1.125rem', fontWeight: 800, color: 'var(--text-primary)' }}>
                                        {duration}x de {formatBRL(Math.round(cardTotal / duration))}<span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: 600 }}>/mês</span>
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                );
            })}

            <div className="modal-actions">
                <button className="btn btn-secondary" onClick={onClose} disabled={loading} style={{ flex: 1 }}>
                    Cancelar
                </button>
                <button className="btn btn-primary" onClick={handleConfirm} disabled={loading || !payment} style={{ flex: 1 }}>
                    {loading ? 'Processando...' : 'Confirmar Assinatura'}
                </button>
            </div>
        </BottomSheetModal>
    );
}

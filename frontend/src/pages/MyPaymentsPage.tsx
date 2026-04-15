import { getErrorMessage } from '../utils/errors';
import { useState, useEffect, useCallback } from 'react';
import { stripeApi, contractsApi, SavedCard, ContractWithStats, PaymentSummary } from '../api/client';
import StripeCardForm from '../components/StripeCardForm';
import { useUI } from '../context/UIContext';
import { useLocation, useNavigate } from 'react-router-dom';
import { CreditCard, Trash2, Shield, Plus, Zap, Clock, CheckCircle, XCircle, AlertTriangle, Wallet, X } from 'lucide-react';
import ModalOverlay from '../components/ModalOverlay';
import PaymentModal from '../components/PaymentModal';
import { getClientPaymentMethods } from '../constants/paymentMethods';
import ToggleSwitch from '../components/ui/ToggleSwitch';
import StatusBadge from '../components/ui/StatusBadge';

const BRAND_LABELS: Record<string, string> = {
    visa: 'Visa',
    mastercard: 'Mastercard',
    elo: 'Elo',
    amex: 'Amex',
    hipercard: 'Hipercard',
    unknown: 'Cartão',
};

const BRAND_ICONS: Record<string, string> = {};

const STATUS_CONFIG: Record<string, { icon: React.ReactNode; label: string; color: string; bg: string }> = {
    PAID: { icon: <CheckCircle size={14} />, label: 'Pago', color: '#10b981', bg: 'rgba(16,185,129,0.1)' },
    PENDING: { icon: <Clock size={14} />, label: 'Pendente', color: '#f59e0b', bg: 'rgba(245,158,11,0.1)' },
    FAILED: { icon: <XCircle size={14} />, label: 'Falhou', color: '#ef4444', bg: 'rgba(239,68,68,0.1)' },
    REFUNDED: { icon: <AlertTriangle size={14} />, label: 'Estornado', color: '#8b5cf6', bg: 'rgba(139,92,246,0.1)' },
};

function formatBRL(cents: number): string {
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100);
}

function formatDate(dateStr: string | null | undefined): string {
    if (!dateStr) return '—';
    const d = new Date(dateStr);
    if (isNaN(d.getTime()) || d.getFullYear() < 2000) return '—';
    return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' }).format(d);
}

export default function MyPaymentsPage() {
    const { showToast, showConfirm } = useUI();
    const location = useLocation();
    const navigate = useNavigate();

    // ─── State ────────────────────────────────────────────
    const [cards, setCards] = useState<SavedCard[]>([]);
    const [autoCharge, setAutoCharge] = useState(false);
    const [contracts, setContracts] = useState<ContractWithStats[]>([]);
    const [loading, setLoading] = useState(true);
    
    const [showAddCard, setShowAddCard] = useState(false);
    const [setupSecret, setSetupSecret] = useState<string | null>(null);
    const [removingId, setRemovingId] = useState<string | null>(null);
    const [settingDefaultId, setSettingDefaultId] = useState<string | null>(null);

    // Payment flow
    const [payingPayment, setPayingPayment] = useState<(PaymentSummary & { contractName: string; contractDuration: number }) | null>(null);
    const [showAllHistory, setShowAllHistory] = useState(false);

    // ─── Data Loading ─────────────────────────────────────
    const loadData = useCallback(async () => {
        try {
            const [cardsRes, contractsRes] = await Promise.all([
                stripeApi.listPaymentMethods().catch(() => ({ paymentMethods: [], autoChargeEnabled: false })),
                contractsApi.getMy(),
            ]);
            setCards(cardsRes.paymentMethods);
            setAutoCharge(cardsRes.autoChargeEnabled);
            setContracts(contractsRes.contracts);
        } catch (err: unknown) {
            showToast({ message: getErrorMessage(err) || 'Erro ao carregar dados.', type: 'error' });
        } finally {
            setLoading(false);
        }
    }, [showToast]);

    useEffect(() => { loadData(); }, [loadData]);

    // Handle auto-opening payment from Dashboard redirection
    useEffect(() => {
        if (location.state?.autoOpenPaymentId && contracts.length > 0) {
            const pid = location.state.autoOpenPaymentId;
            let targetContract = null;
            let targetPayment = null;
            
            for (const c of contracts) {
                const found = c.payments?.find(p => p.id === pid);
                if (found) {
                    targetContract = c;
                    targetPayment = found;
                    break;
                }
            }
            
            if (targetPayment && targetContract && !payingPayment) {
                setPayingPayment({
                    ...targetPayment,
                    contractName: targetContract.name || targetContract.type,
                    contractDuration: targetContract.durationMonths || 1
                });
                
                // Clear state so it doesn't reopen on refresh
                navigate('.', { replace: true, state: {} });
            }
        }
    }, [contracts, location.state, payingPayment, navigate]);


    // ─── Aggregating Payments ─────────────────────────────
    const allPayments: (PaymentSummary & { contractName: string; contractDuration: number })[] = [];
    contracts.forEach(c => {
        (c.payments || []).forEach(p => {
            allPayments.push({ ...p, contractName: c.name, contractDuration: c.durationMonths });
        });
    });

    const pendingPayments = allPayments.filter(p => p.status === 'PENDING' || p.status === 'FAILED').sort((a, b) => {
        if (a.status === 'FAILED' && b.status !== 'FAILED') return -1;
        if (b.status === 'FAILED' && a.status !== 'FAILED') return 1;
        return (a.dueDate ? new Date(a.dueDate).getTime() : 0) - (b.dueDate ? new Date(b.dueDate).getTime() : 0);
    });

    const paidPayments = allPayments.filter(p => p.status === 'PAID').sort((a, b) =>
        (b.dueDate ? new Date(b.dueDate).getTime() : 0) - (a.dueDate ? new Date(a.dueDate).getTime() : 0)
    );


    // ─── Card Actions ─────────────────────────────────────
    const handleAddCard = async () => {
        try {
            const res = await stripeApi.createSetupIntent();
            setSetupSecret(res.clientSecret);
            setShowAddCard(true);
        } catch (err: unknown) {
            showToast({ message: getErrorMessage(err) || 'Erro ao iniciar adição de cartão.', type: 'error' });
        }
    };

    const handleCardSaved = () => {
        setShowAddCard(false);
        setSetupSecret(null);
        showToast('Cartão salvo com sucesso!');
        loadData();
    };

    const handleRemoveCard = async (card: SavedCard) => {
        showConfirm({
            title: 'Remover Cartão',
            message: `Deseja remover o cartão ${BRAND_LABELS[card.brand] || card.brand} terminado em ${card.last4}?`,
            onConfirm: async () => {
                setRemovingId(card.id);
                try {
                    await stripeApi.removePaymentMethod(card.id);
                    showToast('Cartão removido.');
                    loadData();
                } catch (err: unknown) {
                    showToast({ message: getErrorMessage(err) || 'Erro ao remover cartão.', type: 'error' });
                } finally {
                    setRemovingId(null);
                }
            },
        });
    };

    const handleSetDefault = async (card: SavedCard) => {
        setSettingDefaultId(card.id);
        try {
            await stripeApi.setDefaultPaymentMethod(card.id);
            showToast('Cartão padrão definido!');
            loadData();
        } catch (err: unknown) {
            showToast({ message: getErrorMessage(err) || 'Erro ao definir padrão.', type: 'error' });
        } finally {
            setSettingDefaultId(null);
        }
    };

    const handleToggleAutoCharge = async (enabled: boolean) => {
        try {
            await stripeApi.setAutoCharge(enabled);
            // Optimistic update
            setAutoCharge(enabled);
            showToast(enabled ? 'Cobrança automática ATIVADA.' : 'Cobrança automática DESATIVADA.');
        } catch (err: unknown) {
            showToast({ message: getErrorMessage(err) || 'Erro ao alterar auto-charge.', type: 'error' });
        }
    };


    if (loading && contracts.length === 0) {
        return <div className="loading-spinner"><div className="spinner" /></div>;
    }

    return (
        <div>
            <div className="page-header" style={{ marginBottom: '32px' }}>
                <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <Wallet size={28} /> Pagamentos
                </h1>
                <p className="page-subtitle">Pague parcelas pendentes e gerencie seus cartões.</p>
            </div>

            {/* ─── 🔥 PENDENTES (HIERARQUIA #1) ──────────────────────────────────────────────── */}
            
            <div style={{ marginBottom: '48px' }}>
                <h2 style={{ fontSize: '1.25rem', fontWeight: 800, marginBottom: '20px', display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-primary)' }}>
                    <Zap className="text-warning" size={24} color="#f59e0b" />
                    Pagamentos Pendentes
                </h2>

                {pendingPayments.length === 0 ? (
                    <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-lg)', padding: '32px', textAlign: 'center', color: 'var(--text-muted)' }}>
                        <CheckCircle size={32} style={{ margin: '0 auto 12px', color: '#10b981', opacity: 0.8 }} />
                        <span style={{ fontSize: '0.875rem', fontWeight: 600 }}>Tudo em dia! Você não tem cobranças pendentes.</span>
                    </div>
                ) : (
                    <div style={{ display: 'grid', gap: '16px' }}>
                        {pendingPayments.map(p => {
                            const isOverdue = new Date(p.dueDate).getTime() < Date.now();
                            const isFailed = p.status === 'FAILED';
                            const defaultCard = cards.find(c => c.isDefault) || cards[0];
                            const availableMethods = getClientPaymentMethods();
                            const pixEnabled = availableMethods.some(m => m.key === 'PIX');
                            const cardEnabled = availableMethods.some(m => m.key === 'CARTAO');

                            return (
                                <div key={p.id} style={{
                                    background: 'var(--bg-primary)',
                                    border: `2px solid ${isFailed || isOverdue ? '#ef4444' : 'var(--border-color)'}`,
                                    borderRadius: 'var(--radius-lg)',
                                    padding: '24px',
                                    position: 'relative',
                                    boxShadow: (isFailed || isOverdue) ? '0 4px 12px rgba(239, 68, 68, 0.1)' : 'var(--shadow-sm)'
                                }}>
                                    {(isFailed || isOverdue) && (
                                        <div style={{ position: 'absolute', top: -12, left: 24, background: '#ef4444', color: '#fff', fontSize: '0.6875rem', fontWeight: 800, padding: '4px 12px', borderRadius: '12px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                                            {isFailed ? 'Falha no Cartão' : 'Em Atraso'}
                                        </div>
                                    )}

                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                                        <div>
                                            <div style={{ fontSize: '1.5rem', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '8px' }}>
                                                {formatBRL(p.amount)}
                                            </div>
                                            <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', fontWeight: 600 }}>
                                                {p.contractName}
                                            </div>
                                            <div style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                                                Vence(u) em {formatDate(p.dueDate)}
                                            </div>
                                        </div>

                                        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                                            <button 
                                                onClick={() => setPayingPayment(p)}
                                                className="btn btn-primary"
                                                style={{ padding: '14px 20px', borderRadius: 'var(--radius-full)', minHeight: '48px', width: '100%', justifyContent: 'center' }}>
                                                <CreditCard size={18} />
                                                Pagar Agora
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* ─── 🤖 COBRANÇA AUTOMÁTICA (HIERARQUIA #2) ──────────────────────────────────── */}
            
            {(cards.length > 0 || autoCharge) && (
                <div style={{ marginBottom: '48px', position: 'relative' }}>
                    <div style={{
                        background: autoCharge ? 'linear-gradient(135deg, rgba(16,185,129,0.15), rgba(16,185,129,0.05))' : 'var(--bg-secondary)',
                        border: `1px solid ${autoCharge ? '#10b981' : 'var(--border-subtle)'}`,
                        borderRadius: 'var(--radius-lg)', padding: '24px',
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '24px', flexWrap: 'wrap'
                    }}>
                        <div>
                            <h3 style={{ fontSize: '1.25rem', fontWeight: 800, display: 'flex', alignItems: 'center', gap: '8px', color: autoCharge ? '#10b981' : 'var(--text-primary)', marginBottom: '8px' }}>
                                <Shield size={20} />
                                Cobrança Automática {autoCharge ? 'Ativa' : ''}
                            </h3>
                            <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', maxWidth: 600 }}>
                                {autoCharge 
                                    ? "As parcelas dos seus contratos serão cobradas automaticamente no seu cartão padrão no dia do vencimento."
                                    : "Ative para cobrar suas parcelas no cartão padrão no dia do vencimento. Sem multas e preocupações."
                                }
                            </p>
                        </div>

                        <ToggleSwitch
                            checked={autoCharge}
                            onChange={handleToggleAutoCharge}
                            label={autoCharge ? 'Ligado' : 'Desligado'}
                        />
                    </div>
                </div>
            )}

            {/* ─── ✅ HISTÓRICO (HIERARQUIA #3) ────────────────────────────────────────────── */}
            
            {paidPayments.length > 0 && (
                <div style={{ marginBottom: '48px' }}>
                    <h2 style={{ fontSize: '1.125rem', fontWeight: 700, marginBottom: '16px', color: 'var(--text-primary)' }}>
                        Histórico de Pagamentos
                    </h2>
                    <div style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-lg)', overflow: 'hidden' }}>
                        {paidPayments.slice(0, showAllHistory ? undefined : 5).map((p, i, arr) => (
                            <div key={p.id} style={{
                                padding: '16px 20px', 
                                borderBottom: i < arr.length - 1 ? '1px solid var(--border-subtle)' : 'none',
                                display: 'flex', justifyContent: 'space-between', alignItems: 'center'
                            }}>
                                <div>
                                    <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{p.contractName}</div>
                                    <div style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', marginTop: '4px' }}>Pago em {formatDate(p.dueDate)}</div>
                                </div>
                                <div style={{ textAlign: 'right' }}>
                                    <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{formatBRL(p.amount)}</div>
                                    <StatusBadge status="PAID" label={p.provider === 'STRIPE' ? 'Automático' : 'Pago'} />
                                </div>
                            </div>
                        ))}
                    </div>
                    {paidPayments.length > 5 && !showAllHistory && (
                        <button onClick={() => setShowAllHistory(true)} style={{
                            display: 'block', width: '100%', padding: '12px', marginTop: '8px',
                            background: 'transparent', border: '1px solid var(--border-subtle)',
                            borderRadius: 'var(--radius-md)', color: 'var(--text-secondary)',
                            fontSize: '0.875rem', fontWeight: 600, cursor: 'pointer',
                            minHeight: '44px',
                        }}>Ver todos ({paidPayments.length})</button>
                    )}
                </div>
            )}

            {/* ─── 💳 CARTÕES SALVOS (HIERARQUIA #4) ───────────────────────────────────────── */}
            
            <div>
                <h2 style={{ fontSize: '1.125rem', fontWeight: 700, marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <Wallet size={20} className="text-secondary" />
                    Cartões Salvos
                </h2>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '16px' }}>
                    
                    {cards.map(card => (
                        <div key={card.id} style={{
                            background: 'var(--bg-primary)', padding: '20px', borderRadius: 'var(--radius-md)',
                            border: `1px solid ${card.isDefault ? '#10b981' : 'var(--border-subtle)'}`,
                            position: 'relative'
                        }}>
                            {card.isDefault && (
                                <div style={{ position: 'absolute', top: -10, right: 16, background: '#10b981', color: '#fff', fontSize: '0.625rem', fontWeight: 800, padding: '4px 10px', borderRadius: '12px' }}>
                                    PADRÃO
                                </div>
                            )}
                            
                            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                                <CreditCard size={32} style={{ color: 'var(--text-secondary)' }} />
                                <div style={{ flex: 1 }}>
                                    <div style={{ fontWeight: 800, fontSize: '0.925rem' }}>{BRAND_LABELS[card.brand] || card.brand} <span style={{ color: 'var(--text-secondary)' }}>•••• {card.last4}</span></div>
                                    <div style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>Vence {card.expMonth.toString().padStart(2, '0')}/{card.expYear}</div>
                                </div>
                            </div>

                            <div style={{ display: 'flex', gap: '8px', marginTop: '20px' }}>
                                {!card.isDefault && (
                                    <button
                                        onClick={() => handleSetDefault(card)}
                                        disabled={settingDefaultId === card.id}
                                        style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: 'none', padding: '10px 12px', borderRadius: '8px', fontSize: '0.8125rem', fontWeight: 600, cursor: 'pointer', flex: 1, minHeight: '44px' }}
                                    >
                                        {settingDefaultId === card.id ? '...' : 'Tornar Padrão'}
                                    </button>
                                )}
                                <button
                                    onClick={() => handleRemoveCard(card)}
                                    disabled={removingId === card.id}
                                    aria-label="Remover Cartão"
                                    style={{ background: 'rgba(239,68,68,0.1)', color: '#ef4444', border: 'none', padding: '10px 12px', borderRadius: '8px', fontSize: '0.8125rem', fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '44px', minWidth: '44px' }}
                                >
                                    {removingId === card.id ? <div className="spinner" style={{ width: 14, height: 14 }} /> : <Trash2 size={16} />}
                                </button>
                            </div>
                        </div>
                    ))}

                    <button 
                        onClick={handleAddCard}
                        style={{ border: '2px dashed var(--border-color)', background: 'transparent', borderRadius: 'var(--radius-md)', padding: '24px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px', color: 'var(--text-secondary)', cursor: 'pointer', minHeight: '130px', transition: 'border-color 0.2s, color 0.2s' }}
                        onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--accent-primary)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
                        onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border-color)'; e.currentTarget.style.color = 'var(--text-secondary)'; }}>
                        <Plus size={24} />
                        <span style={{ fontWeight: 700, fontSize: '0.875rem' }}>Adicionar Cartão</span>
                    </button>
                </div>
            </div>

            {/* ─── MODALS ─────────────────────────────────────────────────────────────────── */}

            {/* Add Card Modal */}
            {showAddCard && setupSecret && (
                <ModalOverlay onClose={() => setShowAddCard(false)}>
                    <div className="modal" style={{ maxWidth: 400 }}>
                        <h2 className="modal-title">Adicionar Novo Cartão</h2>
                        <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginBottom: '24px' }}>
                            Mantenha um cartão salvo para facilitar compras e habilitar renovação automática. Nenhuma cobrança é feita agora.
                        </p>
                        <StripeCardForm
                            mode="setup"
                            clientSecret={setupSecret}
                            onSuccess={handleCardSaved}
                            onError={(msg) => showToast({ message: msg, type: 'error' })}
                            onCancel={() => setShowAddCard(false)}
                        />
                    </div>
                </ModalOverlay>
            )}

            {/* Payment Modal — Unified PaymentModal */}
            {payingPayment && (
                <PaymentModal
                    title="Pagar Parcela"
                    amount={payingPayment.amount}
                    paymentId={payingPayment.id}
                    description={payingPayment.contractName || 'Avulso'}
                    contractDuration={payingPayment.contractDuration}
                    allowedMethods={['CARTAO', 'PIX']}
                    onSuccess={() => {
                        setPayingPayment(null);
                        showToast('Pagamento confirmado!');
                        loadData();
                    }}
                    onError={(msg) => showToast({ message: msg, type: 'error' })}
                    onClose={() => setPayingPayment(null)}
                />
            )}

        </div>
    );
}

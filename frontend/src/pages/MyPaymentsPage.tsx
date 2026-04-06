import { useState, useEffect, useCallback } from 'react';
import { stripeApi, contractsApi, SavedCard, InstallmentPlan, ContractWithStats, PaymentSummary } from '../api/client';
import StripeCardForm, { getStripe } from '../components/StripeCardForm';
import InstallmentSelector from '../components/InstallmentSelector';
import { useUI } from '../context/UIContext';
import { useLocation, useNavigate } from 'react-router-dom';
import { CreditCard, Trash2, Shield, Plus, Zap, Clock, CheckCircle, XCircle, AlertTriangle, QrCode, Wallet, Copy, X } from 'lucide-react';
import ModalOverlay from '../components/ModalOverlay';
import { getPaymentMethods } from '../constants/paymentMethods';

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
    const [paymentSecret, setPaymentSecret] = useState<string | null>(null);
    const [installmentPlans, setInstallmentPlans] = useState<InstallmentPlan[]>([]);
    const [selectedInstallments, setSelectedInstallments] = useState<number | null>(1);
    const [paymentContractDuration, setPaymentContractDuration] = useState(0);
    const [creatingPayment, setCreatingPayment] = useState(false);
    const [pixData, setPixData] = useState<{ pixString: string; qrCodeBase64?: string } | null>(null);

    // One-click/Pix mode
    const [paymentMode, setPaymentMode] = useState<'CARD' | 'PIX' | null>(null);

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
        } catch (err: any) {
            showToast({ message: err.message || 'Erro ao carregar dados.', type: 'error' });
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
        } catch (err: any) {
            showToast({ message: err.message || 'Erro ao iniciar adição de cartão.', type: 'error' });
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
                } catch (err: any) {
                    showToast({ message: err.message || 'Erro ao remover cartão.', type: 'error' });
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
        } catch (err: any) {
            showToast({ message: err.message || 'Erro ao definir padrão.', type: 'error' });
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
        } catch (err: any) {
            showToast({ message: err.message || 'Erro ao alterar auto-charge.', type: 'error' });
        }
    };


    // ─── Payment Flow ─────────────────────────────────────

    const openPaymentModal = async (payment: any, mode: 'CARD' | 'PIX') => {
        setPayingPayment(payment);
        setPaymentMode(mode);
        setSelectedInstallments(1);
        setPaymentContractDuration(payment.contractDuration);
        setPaymentSecret(null);
        setPixData(null);

        if (mode === 'CARD') {
            // Load installments
            try {
                const res = await stripeApi.getInstallmentPlans({ paymentId: payment.id });
                setInstallmentPlans(res.plans);
            } catch (err) {
                console.error("Installment error:", err);
            }
        } else {
            // For Pix
            setInstallmentPlans([]);
        }
    };

    const processPix = async () => {
        if (!payingPayment) return;
        setCreatingPayment(true);
        try {
            const res = await stripeApi.createPayment({ 
                paymentId: payingPayment.id,
                paymentMethod: 'pix'
            });

            if (res.provider === 'CORA' && res.pixString) {
                setPixData({ pixString: res.pixString, qrCodeBase64: res.qrCodeBase64 });
                showToast('PIX gerado! Leia o QR Code ou cole o código.');
            } else if (res.clientSecret) {
                const stripe = await getStripe();
                if (!stripe) throw new Error("Stripe não carregado.");

                // Show Pix QR Code Modal (Fallback if Stripe still used)
                const { error } = await stripe.confirmPixPayment(res.clientSecret, {
                    payment_method: {
                        billing_details: {
                            name: 'Cliente',
                        }
                    },
                    return_url: window.location.href,
                });
                if (error) {
                    throw new Error(error.message);
                }

                showToast('PIX gerado! Faça o pagamento no seu banco.');
                setPayingPayment(null);
                setTimeout(loadData, 2000);
            }
        } catch(err: any) {
            showToast({ message: err.message, type: 'error' });
        } finally {
            setCreatingPayment(false);
        }
    };

    const processOneClickCard = async () => {
        if (!payingPayment || !selectedInstallments) return;
        const defaultCard = cards.find(c => c.isDefault) || cards[0];
        if (!defaultCard) {
            // Fallback to manual entry if no card is somehow saved
            createCardIntent();
            return;
        }

        setCreatingPayment(true);
        try {
            const res = await stripeApi.createPayment({ 
                paymentId: payingPayment.id,
                installments: selectedInstallments,
                savedPaymentMethodId: defaultCard.stripePaymentMethodId,
                paymentMethod: 'cartao'
            });

            const stripe = await getStripe();
            if (!stripe) throw new Error("Stripe não carregado.");

            // Confirm payment with the attached card
            if (!res.clientSecret) throw new Error("Segredo do cliente ausente.");
            
            const { error, paymentIntent } = await stripe.confirmCardPayment(res.clientSecret, {
                payment_method: defaultCard.stripePaymentMethodId
            });

            if (error) {
                throw new Error(error.message);
            }

            if (paymentIntent?.status === 'succeeded') {
                showToast('Pagamento confirmado com sucesso!');
                
                // Atualização otimista da UI para evitar Race Condition com o Webhook
                if (payingPayment) {
                    setContracts(prev => prev.map(c => ({
                        ...c,
                        payments: c.payments?.map(p => 
                            p.id === payingPayment.id ? { ...p, status: 'PAID', provider: 'STRIPE' } : p
                        )
                    })));

                    await stripeApi.verifyPayment({
                        paymentId: payingPayment.id,
                        paymentIntentId: paymentIntent.id
                    }).catch(console.error); // Fogo e esquece, garante que o banco sincronizou
                }

                setPayingPayment(null);
            } else if (paymentIntent?.status === 'requires_action') {
                showToast('Autenticação adicional necessária.');
            }
        } catch(err: any) {
            showToast({ message: err.message, type: 'error' });
        } finally {
            setCreatingPayment(false);
        }
    };

    const createCardIntent = async () => {
        if (!payingPayment || !selectedInstallments) return;
        setCreatingPayment(true);
        try {
            const res = await stripeApi.createPayment({
                paymentId: payingPayment.id,
                installments: selectedInstallments,
                paymentMethod: 'cartao'
            });
            if (res.clientSecret) {
                setPaymentSecret(res.clientSecret);
            }
        } catch (err: any) {
            showToast({ message: err.message, type: 'error' });
        } finally {
            setCreatingPayment(false);
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
                            const availableMethods = getPaymentMethods();
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

                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '24px', alignItems: 'center', justifyContent: 'space-between' }}>
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

                                        {/* Actions */}
                                        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
                                            {cards.length > 0 ? (
                                                <>
                                                    {cardEnabled && (
                                                        <button 
                                                            onClick={() => openPaymentModal(p, 'CARD')}
                                                            className="btn btn-primary"
                                                            style={{ padding: '12px 20px', borderRadius: 'var(--radius-full)' }}>
                                                            <CreditCard size={18} />
                                                            Pagar com Cartão ({defaultCard.last4})
                                                        </button>
                                                    )}
                                                    {pixEnabled && (
                                                        <button 
                                                            onClick={() => openPaymentModal(p, 'PIX')}
                                                            className="btn btn-secondary"
                                                            style={{ padding: '12px 20px', borderRadius: 'var(--radius-full)' }}>
                                                            <QrCode size={18} />
                                                            PIX Agora
                                                        </button>
                                                    )}
                                                </>
                                            ) : (
                                                <>
                                                    {cardEnabled && (
                                                        <button 
                                                            onClick={() => openPaymentModal(p, 'CARD')}
                                                            className="btn btn-primary"
                                                            style={{ padding: '12px 20px', borderRadius: 'var(--radius-full)' }}>
                                                            <CreditCard size={18} />
                                                            Pagar com Cartão
                                                        </button>
                                                    )}
                                                    {pixEnabled && (
                                                        <button 
                                                            onClick={() => openPaymentModal(p, 'PIX')}
                                                            className="btn btn-secondary"
                                                            style={{ padding: '12px 20px', borderRadius: 'var(--radius-full)' }}>
                                                            <QrCode size={18} />
                                                            PIX
                                                        </button>
                                                    )}
                                                </>
                                            )}
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

                        <label style={{ display: 'flex', alignItems: 'center', gap: '12px', cursor: 'pointer' }}>
                            <span style={{ fontSize: '0.875rem', fontWeight: 700, color: 'var(--text-secondary)' }}>
                                {autoCharge ? 'Ligado' : 'Desligado'}
                            </span>
                            <div style={{
                                width: 50, height: 26, background: autoCharge ? '#10b981' : 'var(--text-muted)',
                                borderRadius: 13, position: 'relative', transition: 'background-color 0.2s', padding: 3
                            }}>
                                <div style={{
                                    width: 20, height: 20, background: '#fff', borderRadius: '50%',
                                    transform: `translateX(${autoCharge ? 24 : 0}px)`, transition: 'transform 0.2s',
                                    boxShadow: '0 2px 4px rgba(0,0,0,0.2)'
                                }} />
                            </div>
                            <input 
                                type="checkbox" 
                                checked={autoCharge} 
                                onChange={e => handleToggleAutoCharge(e.target.checked)} 
                                style={{ display: 'none' }} 
                            />
                        </label>
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
                        {paidPayments.slice(0, 5).map((p, i) => (
                            <div key={p.id} style={{
                                padding: '16px 20px', 
                                borderBottom: i < Math.min(paidPayments.length, 5) - 1 ? '1px solid var(--border-subtle)' : 'none',
                                display: 'flex', justifyContent: 'space-between', alignItems: 'center'
                            }}>
                                <div>
                                    <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{p.contractName}</div>
                                    <div style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', marginTop: '4px' }}>Pago em {formatDate(p.dueDate)}</div>
                                </div>
                                <div style={{ textAlign: 'right' }}>
                                    <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{formatBRL(p.amount)}</div>
                                    <div style={{ fontSize: '0.75rem', fontWeight: 800, color: '#10b981', background: 'rgba(16,185,129,0.1)', padding: '2px 8px', borderRadius: '12px', display: 'inline-block', marginTop: '4px' }}>
                                        {p.provider === 'STRIPE' ? 'Automático' : 'Pago'}
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
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
                                        style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: 'none', padding: '6px 12px', borderRadius: '6px', fontSize: '0.75rem', fontWeight: 600, cursor: 'pointer', flex: 1 }}
                                    >
                                        {settingDefaultId === card.id ? '...' : 'Tornar Padrão'}
                                    </button>
                                )}
                                <button
                                    onClick={() => handleRemoveCard(card)}
                                    disabled={removingId === card.id}
                                    aria-label="Remover Cartão"
                                    style={{ background: 'rgba(239,68,68,0.1)', color: '#ef4444', border: 'none', padding: '6px 12px', borderRadius: '6px', fontSize: '0.75rem', fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                                >
                                    {removingId === card.id ? <div className="spinner" style={{ width: 14, height: 14 }} /> : <Trash2 size={14} />}
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

            {/* Payment Modal (Pix or Card) */}
            {payingPayment && paymentMode && (
                <ModalOverlay onClose={() => !creatingPayment && setPayingPayment(null)}>
                    <div className="modal-content" style={{ maxWidth: 500, padding: 0 }}>
                        <div className="modal-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '24px', borderBottom: '1px solid var(--border-subtle)'}}>
                            <h2 style={{ fontSize: '1.25rem', fontWeight: 800, margin: 0, color: 'var(--text-primary)' }}>Pagar Parcela</h2>
                            <button 
                                onClick={() => setPayingPayment(null)} 
                                disabled={creatingPayment}
                                aria-label="Fechar"
                                style={{
                                    background: 'transparent',
                                    border: 'none',
                                    color: 'var(--text-secondary)',
                                    cursor: creatingPayment ? 'not-allowed' : 'pointer',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    padding: '8px',
                                    marginRight: '-8px',
                                    borderRadius: '50%',
                                    transition: 'background 0.2s',
                                }}
                                onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-secondary)'}
                                onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                            >
                                <X size={20} />
                            </button>
                        </div>
                        <div style={{ padding: '0 32px 32px' }}>
                            {/* Summary */}
                            <div style={{ 
                                background: 'var(--bg-secondary)', 
                                borderRadius: '24px', 
                                padding: '24px', 
                                marginBottom: '32px', 
                                textAlign: 'center',
                                boxShadow: 'inset 0 2px 4px rgba(0,0,0,0.02)'
                            }}>
                                <div style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '8px' }}>Valor do Pagamento</div>
                                <div style={{ fontSize: '2.5rem', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.02em', marginBottom: '4px' }}>{formatBRL(payingPayment.amount)}</div>
                                <div style={{ fontSize: '0.875rem', fontWeight: 500, color: 'var(--text-muted)' }}>{payingPayment.contractName || 'Avulso'}</div>
                            </div>

                            {paymentMode === 'PIX' ? (
                                <div style={{ textAlign: 'center' }}>
                                    {pixData ? (
                                        <div style={{ animation: typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'none' : 'fadeIn 0.4s cubic-bezier(0.16, 1, 0.3, 1)' }}>
                                            <div style={{ background: 'var(--bg-secondary)', padding: '32px', borderRadius: '24px', border: '1px solid var(--border-subtle)', marginBottom: '24px', textAlign: 'center' }}>
                                                <div style={{ color: 'var(--accent-primary)', marginBottom: '12px' }}>
                                                    <QrCode size={40} style={{ margin: '0 auto' }} />
                                                </div>
                                                <div style={{ fontSize: '1.25rem', fontWeight: 800, marginBottom: '8px', color: 'var(--text-primary)' }}>Pague via PIX</div>
                                                <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginBottom: '24px', lineHeight: 1.5 }}>
                                                    Abra o app do seu banco e escaneie o código abaixo para confirmar instantaneamente.
                                                </div>
                                                
                                                <div style={{ background: '#ffffff', padding: '16px', borderRadius: '16px', display: 'inline-block', marginBottom: '24px', boxShadow: '0 8px 24px rgba(0,0,0,0.08)' }}>
                                                    <img 
                                                        src={pixData.qrCodeBase64 ? `data:image/png;base64,${pixData.qrCodeBase64}` : `https://quickchart.io/qr?text=${encodeURIComponent(pixData.pixString)}&size=220&margin=0`} 
                                                        alt="PIX QR Code" 
                                                        width={220}
                                                        height={220}
                                                        style={{ display: 'block', borderRadius: '8px' }} 
                                                    />
                                                </div>
                                                
                                                <div style={{ textAlign: 'left', marginBottom: '12px', fontSize: '0.8125rem', fontWeight: 700, color: 'var(--text-secondary)' }}>
                                                    Ou use o código Pix Copia e Cola:
                                                </div>
                                                <div style={{ display: 'flex', gap: '8px' }}>
                                                    <div
                                                        style={{ flex: 1, padding: '12px 16px', borderRadius: '12px', border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: '0.8125rem', fontFamily: '"JetBrains Mono", monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', textAlign: 'left' }} 
                                                    >
                                                        {pixData.pixString}
                                                    </div>
                                                    <button 
                                                        onClick={() => {
                                                            navigator.clipboard.writeText(pixData.pixString);
                                                            showToast('Código Pix copiado para a área de transferência!');
                                                        }}
                                                        className="btn btn-secondary"
                                                        style={{ borderRadius: '12px', padding: '0 20px', display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0, boxShadow: '0 2px 4px rgba(0,0,0,0.05)' }}
                                                    >
                                                        <Copy size={16} /> <span style={{ fontWeight: 700 }}>Copiar</span>
                                                    </button>
                                                </div>
                                            </div>
                                            <button className="btn btn-primary" onClick={() => { setPixData(null); setPayingPayment(null); loadData(); }} style={{ width: '100%', padding: '18px', fontSize: '1rem', fontWeight: 800, borderRadius: 'var(--radius-full)' }}>
                                                Já fiz o pagamento
                                            </button>
                                        </div>
                                    ) : (
                                        <>
                                            <div style={{ background: '#E0F2FE', color: '#0369A1', padding: '16px', borderRadius: 'var(--radius-md)', marginBottom: '24px' }}>
                                                <QrCode size={48} style={{ margin: '0 auto 16px' }} />
                                                <div style={{ fontWeight: 700, fontSize: '1rem', marginBottom: '8px' }}>Pagamento PIX</div>
                                                <div style={{ fontSize: '0.875rem', opacity: 0.9 }}>Clique abaixo para gerar o <strong>QR Code</strong> ou <strong>Copia e Cola</strong> e pagar no app do seu banco.</div>
                                            </div>
                                            
                                            <button className="btn btn-primary" onClick={processPix} disabled={creatingPayment} style={{ width: '100%', padding: '16px', fontSize: '1rem', fontWeight: 700, borderRadius: 'var(--radius-full)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                                                {creatingPayment ? <><span className="spinner" aria-hidden="true" style={{width: 16, height: 16}} /> Gerando PIX...</> : 'Gerar PIX Agora'}
                                            </button>
                                        </>
                                    )}
                                </div>
                            ) : (
                                <div>
                                    {/* Installments */}
                                    {installmentPlans.length > 0 && (
                                        <div style={{ marginBottom: '32px' }}>
                                            <label style={{ display: 'block', fontSize: '1rem', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '16px' }}>
                                                Opções de Parcelamento
                                            </label>
                                            <div style={{ maxHeight: '320px', overflowY: 'auto', paddingRight: '4px', margin: '0 -4px' }}>
                                                <div style={{ padding: '0 4px' }}>
                                                    <InstallmentSelector
                                                        plans={installmentPlans}
                                                        selected={selectedInstallments}
                                                        onSelect={setSelectedInstallments}
                                                        maxFreeInstallments={paymentContractDuration}
                                                    />
                                                </div>
                                            </div>
                                        </div>
                                    )}

                                    {/* Action */}
                                    {paymentSecret ? (
                                        <div style={{ marginTop: '16px' }}>
                                            <StripeCardForm
                                                mode="payment"
                                                clientSecret={paymentSecret}
                                                onSuccess={async () => {
                                                    showToast('Pagamento recebido com sucesso!');
                                                    
                                                    // Atualização otimista
                                                    if (payingPayment && paymentSecret) {
                                                        setContracts(prev => prev.map(c => ({
                                                            ...c,
                                                            payments: c.payments?.map(p => 
                                                                p.id === payingPayment.id ? { ...p, status: 'PAID', provider: 'STRIPE' } : p
                                                            )
                                                        })));

                                                        // Extrair o ID do intent do clientSecret (que é pi_xxxxx_secret_yyyy)
                                                        const paymentIntentId = paymentSecret.split('_secret_')[0];
                                                        
                                                        await stripeApi.verifyPayment({
                                                            paymentId: payingPayment.id,
                                                            paymentIntentId: paymentIntentId
                                                        }).catch(console.error);
                                                    }

                                                    setPayingPayment(null);
                                                }}
                                                onError={(msg: any) => showToast({ message: String(msg), type: 'error' })}
                                                onCancel={() => setPayingPayment(null)}
                                                submitLabel={`Confirmar Pagamento (${selectedInstallments}x)`}
                                            />
                                        </div>
                                    ) : (
                                        <button className="btn btn-primary" onClick={processOneClickCard} disabled={creatingPayment || !selectedInstallments} style={{ width: '100%', padding: '18px', fontSize: '1rem', fontWeight: 800, borderRadius: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px', transition: 'background-color 0.2s, transform 0.1s' }}>
                                            {creatingPayment ? <><span className="spinner" aria-hidden="true" style={{width: 16, height: 16}} /> Processando...</> : (
                                                <>
                                                    <Wallet size={20} />
                                                    Pagar com Cartão Salvo
                                                </>
                                            )}
                                        </button>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>
                </ModalOverlay>
            )}

        </div>
    );
}

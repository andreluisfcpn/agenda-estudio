import { getErrorMessage } from '../utils/errors';
import { useState, useEffect, useCallback } from 'react';
import { stripeApi, contractsApi, SavedCard, ContractWithStats, PaymentSummary } from '../api/client';
import StripeCardForm from '../components/StripeCardForm';
import { useUI } from '../context/UIContext';
import { useAuth } from '../context/AuthContext';
import { useLocation, useNavigate } from 'react-router-dom';
import {
    CreditCard, Trash2, Shield, Plus, Zap, Clock,
    CheckCircle, XCircle, AlertTriangle, Wallet, ArrowRight, Landmark,
} from 'lucide-react';
import AddCardModal from '../components/AddCardModal';
import PaymentModal from '../components/PaymentModal';
import { getClientPaymentMethods } from '../constants/paymentMethods';
import ToggleSwitch from '../components/ui/ToggleSwitch';
import StatCard from '../components/ui/StatCard';
import StatusBadge from '../components/ui/StatusBadge';
import { formatBRL, formatDate } from '../utils/format';
import { PaymentsSkeleton } from '../components/ui/SkeletonLoader';
import '../styles/my-payments.css';

const BRAND_LABELS: Record<string, string> = {
    visa: 'Visa', mastercard: 'Mastercard', elo: 'Elo',
    amex: 'Amex', hipercard: 'Hipercard', unknown: 'Cartão',
};

export default function MyPaymentsPage() {
    const { showToast, showConfirm } = useUI();
    const { user } = useAuth();
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

    const now = new Date();
    const pendingPayments = allPayments.filter(p => p.status === 'PENDING' || p.status === 'FAILED').sort((a, b) => {
        if (a.status === 'FAILED' && b.status !== 'FAILED') return -1;
        if (b.status === 'FAILED' && a.status !== 'FAILED') return 1;
        return (a.dueDate ? new Date(a.dueDate).getTime() : 0) - (b.dueDate ? new Date(b.dueDate).getTime() : 0);
    });

    const paidPayments = allPayments.filter(p => p.status === 'PAID').sort((a, b) =>
        (b.dueDate ? new Date(b.dueDate).getTime() : 0) - (a.dueDate ? new Date(a.dueDate).getTime() : 0)
    );

    const totalPending = pendingPayments.reduce((acc, p) => acc + p.amount, 0);
    const totalPaid = paidPayments.reduce((acc, p) => acc + p.amount, 0);
    const overdueCount = pendingPayments.filter(p => p.dueDate && new Date(p.dueDate) < now).length;

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
        stripeApi.invalidateCache();
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
            setAutoCharge(enabled);
            showToast(enabled ? 'Cobrança automática ATIVADA.' : 'Cobrança automática DESATIVADA.');
        } catch (err: unknown) {
            showToast({ message: getErrorMessage(err) || 'Erro ao alterar auto-charge.', type: 'error' });
        }
    };

    // ─── Hero Message ───────────────────────────────────
    const heroMessage = (() => {
        if (overdueCount > 0) return `Você tem ${overdueCount} fatura(s) em atraso`;
        if (pendingPayments.length > 0) return `${pendingPayments.length} parcela(s) pendente(s)`;
        return 'Tudo em dia! Nenhuma cobrança pendente.';
    })();

    const hasOverdue = overdueCount > 0;

    if (loading && contracts.length === 0) {
        return <PaymentsSkeleton />;
    }

    return (
        <div>
            {/* ─── Hero Banner ─── */}
            <div className={`client-hero ${hasOverdue ? 'client-hero--alert' : 'client-hero--default'} animate-card-enter`}>
                <div className="client-hero__header client-hero__header--standalone">
                    <div className="client-hero__icon-wrapper" style={{
                        background: hasOverdue
                            ? 'linear-gradient(135deg, rgba(239,68,68,0.2), rgba(239,68,68,0.05))'
                            : 'linear-gradient(135deg, rgba(16,185,129,0.2), rgba(16,185,129,0.05))',
                        borderColor: hasOverdue ? 'rgba(239,68,68,0.25)' : 'rgba(16,185,129,0.25)',
                        boxShadow: hasOverdue ? '0 0 20px rgba(239,68,68,0.12)' : '0 0 20px rgba(16,185,129,0.12)',
                        color: hasOverdue ? '#ef4444' : '#10b981',
                    }}>
                        <Landmark size={22} />
                    </div>
                    <div>
                        <h2 className="client-hero__title">Pagamentos</h2>
                        <p className="client-hero__subtitle">{heroMessage}</p>
                    </div>
                </div>
            </div>

            {/* ─── Stat Cards (matches Dashboard grid) ─── */}
            <div className="payments-stats stagger-enter">
                <StatCard
                    icon={Wallet}
                    label="Pendente"
                    value={formatBRL(totalPending)}
                    detail={overdueCount > 0 ? `${overdueCount} em atraso` : pendingPayments.length > 0 ? 'No prazo' : 'Tudo em dia'}
                    accent={overdueCount > 0 ? '#ef4444' : '#10b981'}
                    index={0}
                />
                <StatCard
                    icon={CheckCircle}
                    label="Total Pago"
                    value={formatBRL(totalPaid)}
                    detail={`${paidPayments.length} pagamento(s)`}
                    accent="#2dd4bf"
                    index={1}
                />
            </div>

            {/* ─── Pagamentos Pendentes ─── */}
            <div className="payments-section">
                <h3 className="payments-section__title">
                    <span className="payments-section__icon payments-section__icon--pending">
                        <Zap size={18} />
                    </span>
                    Faturas Pendentes
                </h3>

                {pendingPayments.length === 0 ? (
                    <div className="payments-empty animate-card-enter" style={{ '--i': 0 } as React.CSSProperties}>
                        <CheckCircle size={32} className="payments-empty__icon" />
                        <div className="payments-empty__text">Tudo em dia! Você não tem cobranças pendentes.</div>
                    </div>
                ) : (
                    <div className="pending-grid stagger-enter">
                        {pendingPayments.map((p, i) => {
                            const isOverdue = new Date(p.dueDate).getTime() < Date.now();
                            const isFailed = p.status === 'FAILED';

                            return (
                                <div
                                    key={p.id}
                                    className={`pending-card animate-card-enter ${(isFailed || isOverdue) ? 'pending-card--urgent' : ''}`}
                                    style={{ '--i': i } as React.CSSProperties}
                                    onClick={() => setPayingPayment(p)}
                                >
                                    {(isFailed || isOverdue) && (
                                        <span className="pending-card__badge">
                                            <AlertTriangle size={10} />
                                            {isFailed ? 'Falha no Cartão' : 'Em Atraso'}
                                        </span>
                                    )}
                                    <div className="pending-card__top">
                                        <div>
                                            <div className="pending-card__amount">{formatBRL(p.amount)}</div>
                                            <div className="pending-card__contract">{p.contractName}</div>
                                            <div className="pending-card__due">
                                                {isOverdue ? 'Vencida' : 'Vence'} em {formatDate(p.dueDate)}
                                            </div>
                                        </div>
                                        <StatusBadge status={isOverdue ? 'FAILED' : p.status} label={isOverdue ? 'Atrasada' : undefined} />
                                    </div>
                                    <div className="pending-card__actions">
                                        <button
                                            onClick={(e) => { e.stopPropagation(); setPayingPayment(p); }}
                                            className="pending-card__pay-btn"
                                            aria-label={`Pagar ${formatBRL(p.amount)}`}
                                        >
                                            <CreditCard size={18} />
                                            Pagar Agora
                                        </button>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* ─── Cobrança Automática ─── */}
            {(cards.length > 0 || autoCharge) && (
                <div className={`autocharge-card animate-card-enter ${autoCharge ? 'autocharge-card--active' : ''}`} style={{ '--i': 2 } as React.CSSProperties}>
                    <div className="autocharge-card__info">
                        <h3 className="autocharge-card__title">
                            <Shield size={18} style={{ color: autoCharge ? '#10b981' : 'var(--text-muted)' }} />
                            Cobrança Automática
                        </h3>
                        <p className="autocharge-card__desc">
                            {autoCharge
                                ? 'Parcelas cobradas no cartão padrão no vencimento.'
                                : 'Ative para cobrar parcelas automaticamente.'}
                        </p>
                    </div>
                    <ToggleSwitch
                        checked={autoCharge}
                        onChange={handleToggleAutoCharge}
                        label={autoCharge ? 'Ligado' : 'Desligado'}
                    />
                </div>
            )}

            {/* ─── Histórico de Pagamentos ─── */}
            {paidPayments.length > 0 && (
                <div className="payments-section">
                    <h3 className="payments-section__title">
                        <span className="payments-section__icon payments-section__icon--history">
                            <Clock size={18} />
                        </span>
                        Histórico de Pagamentos
                    </h3>
                    <div className="history-list">
                        {paidPayments.slice(0, showAllHistory ? undefined : 5).map(p => (
                            <div key={p.id} className="history-item">
                                <div className="history-item__info">
                                    <div className="history-item__name">{p.contractName}</div>
                                    <div className="history-item__date">Pago em {formatDate(p.dueDate)}</div>
                                </div>
                                <div className="history-item__right">
                                    <span className="history-item__amount">{formatBRL(p.amount)}</span>
                                    <StatusBadge status="PAID" label={p.provider === 'STRIPE' ? 'Automático' : 'Pago'} />
                                </div>
                            </div>
                        ))}
                    </div>
                    {paidPayments.length > 5 && !showAllHistory && (
                        <button onClick={() => setShowAllHistory(true)} className="payments-show-all">
                            Ver todos ({paidPayments.length})
                        </button>
                    )}
                </div>
            )}

            {/* ─── Cartões Salvos ─── */}
            <div className="payments-section">
                <h3 className="payments-section__title">
                    <span className="payments-section__icon payments-section__icon--cards">
                        <CreditCard size={18} />
                    </span>
                    Cartões Salvos
                </h3>

                <div className="wallet-grid stagger-enter">
                    {cards.map((card, i) => (
                        <div key={card.id} className={`wallet-card animate-card-enter ${card.isDefault ? 'wallet-card--default' : ''}`} style={{ '--i': i } as React.CSSProperties}>
                            {card.isDefault && (
                                <div className="wallet-card__badge">
                                    <Shield size={10} fill="#10b981" />
                                    CARTÃO PADRÃO
                                </div>
                            )}
                            <div className="wallet-card__body">
                                <div className="wallet-card__icon">
                                    <CreditCard size={22} style={{ color: card.isDefault ? '#10b981' : 'var(--text-secondary)' }} />
                                </div>
                                <div>
                                    <div className="wallet-card__brand">
                                        {BRAND_LABELS[card.brand] || card.brand}{' '}
                                        <span className="wallet-card__last4">•••• {card.last4}</span>
                                    </div>
                                    <div className={`wallet-card__meta ${card.isDefault ? 'wallet-card__meta--active' : ''}`}>
                                        {card.isDefault ? '✓ Cobrança automática ativa' : `Vence ${card.expMonth.toString().padStart(2, '0')}/${card.expYear}`}
                                    </div>
                                </div>
                            </div>
                            <div className="wallet-card__actions">
                                {!card.isDefault && (
                                    <button
                                        onClick={() => handleSetDefault(card)}
                                        disabled={settingDefaultId === card.id}
                                        className="wallet-card__action-btn wallet-card__action-btn--default"
                                    >
                                        {settingDefaultId === card.id ? '...' : 'Tornar Padrão'}
                                    </button>
                                )}
                                {card.isDefault && (
                                    <div className="wallet-card__action-btn wallet-card__action-btn--active-exp">
                                        Vence {card.expMonth.toString().padStart(2, '0')}/{card.expYear}
                                    </div>
                                )}
                                <button
                                    onClick={() => handleRemoveCard(card)}
                                    disabled={removingId === card.id}
                                    aria-label="Remover Cartão"
                                    className="wallet-card__action-btn wallet-card__action-btn--remove"
                                >
                                    {removingId === card.id ? <div className="spinner" style={{ width: 14, height: 14 }} /> : <Trash2 size={16} />}
                                </button>
                            </div>
                        </div>
                    ))}

                    <button onClick={handleAddCard} className="wallet-add-btn animate-card-enter" style={{ '--i': cards.length } as React.CSSProperties}>
                        <Plus size={24} />
                        <span className="wallet-add-btn__label">Adicionar Cartão</span>
                    </button>
                </div>
            </div>

            {/* ─── MODALS ─── */}

            {/* Add Card Modal */}
            <AddCardModal
                isOpen={showAddCard && !!setupSecret}
                clientSecret={setupSecret || ''}
                onClose={() => setShowAddCard(false)}
                onSuccess={handleCardSaved}
                onError={(msg) => showToast({ message: msg, type: 'error' })}
            />

            {/* Payment Modal */}
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

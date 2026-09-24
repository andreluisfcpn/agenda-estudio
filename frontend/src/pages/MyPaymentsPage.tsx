import { getErrorMessage } from '../utils/errors';
import HeroAmbient from '../components/client/HeroAmbient';
import { useState, useEffect, useCallback } from 'react';
import { stripeApi, contractsApi, paymentsApi, SavedCard, ContractWithStats, PaymentSummary } from '../api/client';
import StripeCardForm from '../components/StripeCardForm';
import { useUI } from '../context/UIContext';
import { useAuth } from '../context/AuthContext';
import { useLocation, useNavigate } from 'react-router-dom';
import {
    CreditCard, Trash2, Shield, Plus, Zap, Clock,
    CheckCircle, XCircle, AlertTriangle, Wallet, ArrowRight, Landmark, CalendarClock,
} from 'lucide-react';
import AddCardModal from '../components/AddCardModal';
import PaymentModal from '../components/PaymentModal';
import { getClientPaymentMethods } from '../constants/paymentMethods';
import ToggleSwitch from '../components/ui/ToggleSwitch';
import StatCard from '../components/ui/StatCard';
import StatusBadge from '../components/ui/StatusBadge';
import { formatBRL, formatDate } from '../utils/format';
import { paidChargedAmount } from '../utils/clientHealth';
import { useCountdown } from '../hooks/useCountdown';
import { PaymentsSkeleton } from '../components/ui/SkeletonLoader';
import '../styles/my-payments.css';

const BRAND_LABELS: Record<string, string> = {
    visa: 'Visa', mastercard: 'Mastercard', elo: 'Elo',
    amex: 'Amex', hipercard: 'Hipercard', unknown: 'Cartão',
};

// A payment aggregated from its contract, carrying the contract context needed to label it
// (type/installment position) and to drive the checkout (duration/boleto/deadline).
type AggregatedPayment = PaymentSummary & {
    contractName: string;
    contractType?: string;
    contractDuration: number;
    paymentDeadline?: string | null;
    /** Status do contrato — o prazo só vale enquanto AWAITING_PAYMENT. */
    contractStatus?: ContractWithStats['status'];
    boletoAllowed?: boolean;
    /** Forma de pagamento do contrato — o checkout abre nessa aba (um PIX abre no PIX). */
    contractPaymentMethod?: ContractWithStats['paymentMethod'];
    installmentOrdinal?: number;
    installmentTotal?: number;
};

// Short human label for a contract type (used on cards + the payment modal).
const CONTRACT_TYPE_LABEL: Record<string, string> = {
    FIXO: 'Plano Fixo', FLEX: 'Plano Flex', CUSTOM: 'Personalizado',
    SERVICO: 'Serviço mensal', AVULSO: 'Avulso',
};

// "Nome · Tipo — Parcela N/Total" — what the user is actually paying (shown in the modal).
function describePayment(p: AggregatedPayment): string {
    const typeLabel = (p.contractType && CONTRACT_TYPE_LABEL[p.contractType]) || 'Contrato';
    const pos = (p.installmentTotal && p.installmentTotal > 1)
        ? ` — Parcela ${p.installmentOrdinal}/${p.installmentTotal}`
        : '';
    return `${p.contractName} · ${typeLabel}${pos}`;
}

// ─── Pending Payment Card with live timer ──────────────
interface PendingPaymentCardProps {
    payment: AggregatedPayment;
    index: number;
    isOverdue: boolean;
    isFailed: boolean;
    onPay: () => void;
    onExpired: () => void;
}

function PendingPaymentCard({ payment: p, index: i, isOverdue, isFailed, onPay, onExpired }: PendingPaymentCardProps) {
    const deadline = p.paymentDeadline ? new Date(p.paymentDeadline).getTime() : null;
    const hasTimer = !!deadline && deadline > Date.now();

    const [fading, setFading] = useState(false);
    // useCountdown guarda o onExpire em ref — o interval não recicla quando o
    // pai re-renderiza e recria a prop onExpired.
    const remaining = useCountdown(deadline, () => {
        setFading(true);
        setTimeout(() => onExpired(), 800);
    }) ?? -1;

    if (fading) {
        return (
            <div className="pending-card animate-card-enter pending-card--fading" style={{ '--i': i } as React.CSSProperties}>
                <div style={{ textAlign: 'center', padding: '24px 16px', color: 'var(--text-muted)' }}>
                    ⏰ Tempo esgotado — removendo...
                </div>
            </div>
        );
    }

    // Prazo de pagamento da contratação: 10 min (avulso/serviço/personalizado) ou 3 dias (renovação)
    // → hh:mm:ss acima de 1h (antes virava "4318:49").
    const hours = Math.floor(remaining / 3600);
    const mins = Math.floor((remaining % 3600) / 60);
    const secs = remaining % 60;
    const clock = `${hours > 0 ? `${String(hours).padStart(2, '0')}:` : ''}${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    const timerColor = remaining <= 60 ? 'var(--danger)' : remaining <= 180 ? 'var(--warning)' : 'var(--success)';

    return (
        <div
            className={`pending-card animate-card-enter ${(isFailed || isOverdue) ? 'pending-card--urgent' : ''}`}
            style={{ '--i': i } as React.CSSProperties}
            onClick={onPay}
        >
            {(isFailed || isOverdue) && (
                <span className="pending-card__badge">
                    <AlertTriangle size={10} />
                    {/* L12: só é "cartão" quando o provedor é o Stripe. PIX/boleto (Sicoob/Cora) que falharam
                        mostravam "Falha no Cartão" mesmo sem cartão — rótulo genérico para esses. */}
                    {isFailed ? (p.provider === 'STRIPE' ? 'Falha no cartão' : 'Cobrança falhou') : 'Em Atraso'}
                </span>
            )}
            <div className="pending-card__top">
                <div>
                    <div className="pending-card__amount">{formatBRL(p.amount)}</div>
                    <div className="pending-card__contract">
                        {p.contractName}
                        {p.contractType && <span className="pending-card__type">{CONTRACT_TYPE_LABEL[p.contractType] || 'Contrato'}</span>}
                    </div>
                    <div className="pending-card__due">
                        {isOverdue ? 'Vencida' : 'Vence'} em {formatDate(p.dueDate)}
                        {(p.installmentTotal && p.installmentTotal > 1) ? ` · Parcela ${p.installmentOrdinal}/${p.installmentTotal}` : ''}
                    </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
                    <StatusBadge status={isOverdue ? 'FAILED' : p.status} label={isOverdue ? 'Atrasada' : undefined} />
                    {hasTimer && remaining > 0 && (
                        <div className="pending-card__timer" style={{ color: timerColor }} role="timer" aria-label={`Prazo para pagar: ${clock}`}>
                            <Clock size={12} aria-hidden="true" />
                            <span>{clock}</span>
                        </div>
                    )}
                </div>
            </div>
            <div className="pending-card__actions">
                <button
                    onClick={(e) => { e.stopPropagation(); onPay(); }}
                    className="pending-card__pay-btn"
                    aria-label={`Pagar ${formatBRL(p.amount)}`}
                >
                    <CreditCard size={18} />
                    Pagar Agora
                </button>
            </div>
        </div>
    );
}

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
    const [loadError, setLoadError] = useState(false);

    const [showAddCard, setShowAddCard] = useState(false);
    const [setupSecret, setSetupSecret] = useState<string | null>(null);
    const [removingId, setRemovingId] = useState<string | null>(null);
    const [settingDefaultId, setSettingDefaultId] = useState<string | null>(null);

    // Payment flow
    const [payingPayment, setPayingPayment] = useState<AggregatedPayment | null>(null);
    const [showAllHistory, setShowAllHistory] = useState(false);
    // Segmented view (matches the other client tabs). Stat cards stay above the tabs.
    const [tab, setTab] = useState<'open' | 'paid' | 'plan' | 'wallet'>('open');

    // ─── Data Loading ─────────────────────────────────────
    const loadData = useCallback(async () => {
        setLoadError(false);
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
            // Marca erro persistente: sem isto a página mostrava "Tudo em dia" (lista vazia por falha)
            // mesmo com faturas em aberto — o cliente poderia deixar de pagar uma cobrança vencida.
            setLoadError(true);
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
                    contractType: targetContract.type,
                    contractDuration: targetContract.durationMonths || 1,
                    boletoAllowed: targetContract.boletoAllowed,
                    // Contratação aguardando pagamento (ex.: "Pagar Agora" do serviço/avulso): o modal
                    // mostra o prazo e fecha quando ele acaba. Só enquanto o contrato AINDA aguarda
                    // pagamento — um prazo que ficou gravado num contrato já ativo não vale (regressoes-4).
                    paymentDeadline: targetContract.status === 'AWAITING_PAYMENT' ? targetContract.paymentDeadline : null,
                    contractStatus: targetContract.status,
                    contractPaymentMethod: targetContract.paymentMethod,
                });
                navigate('.', { replace: true, state: {} });
            }
        }
    }, [contracts, location.state, payingPayment, navigate]);

    // ─── Aggregating Payments ─────────────────────────────
    // Carry the contract context (type + installment position within the contract) so cards and
    // the checkout modal can say WHAT is being paid. Ordinal is computed from the contract's
    // payments sorted by due-date (same order as the Plano tab) so the two never disagree.
    const allPayments: AggregatedPayment[] = [];
    contracts.forEach(c => {
        const sorted = [...(c.payments || [])].sort((a, b) =>
            (a.dueDate ? new Date(a.dueDate).getTime() : 0) - (b.dueDate ? new Date(b.dueDate).getTime() : 0)
        );
        const total = sorted.length;
        sorted.forEach((p, idx) => {
            allPayments.push({
                ...p,
                contractName: c.name,
                contractType: c.type,
                contractDuration: c.durationMonths,
                // regressoes-4: prazo só de contratação AINDA aguardando pagamento.
                paymentDeadline: c.status === 'AWAITING_PAYMENT' ? c.paymentDeadline : null,
                contractStatus: c.status,
                boletoAllowed: c.boletoAllowed,
                contractPaymentMethod: c.paymentMethod,
                installmentOrdinal: idx + 1,
                installmentTotal: total,
            });
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
    // Pago = valor EFETIVAMENTE cobrado (no cartão, o do PaymentIntent: sem o desconto PIX do à vista e com
    // os juros quando parcelado) — mesmo critério do fechamento financeiro. Pendente = o valor da cobrança.
    const totalPaid = paidPayments.reduce((acc, p) => acc + paidChargedAmount(p), 0);
    const overdueCount = pendingPayments.filter(p => p.dueDate && new Date(p.dueDate) < now).length;

    // ─── Payment Plan (per active contract) ───────────────
    // COMPLETED (D6: gravações acabaram) continua aqui: parcelas pendentes seguem sendo cobradas.
    const planContracts = contracts.filter(c =>
        (c.status === 'ACTIVE' || c.status === 'COMPLETED' || c.status === 'PENDING_CANCELLATION' || c.status === 'PAUSED')
        && (c.payments?.length || 0) > 0
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
        stripeApi.invalidateCache();
        loadData();
    };

    // D3: remover cartão é irreversível (danger). O backend desvincula o cartão no Stripe e apaga o
    // registro; a cobrança automática usa o cartão padrão ou, sem ele, o salvo mais recente.
    // Sem try/catch no onConfirm: com tone, o erro aparece dentro do diálogo.
    const handleRemoveCard = (card: SavedCard) => {
        const label = `${BRAND_LABELS[card.brand] || card.brand} •••• ${card.last4}`;
        const others = cards.filter(c => c.id !== card.id).length;
        const autoChargeImpact = !autoCharge
            ? []
            : others === 0
                ? ['A cobrança automática fica sem cartão: as próximas parcelas terão de ser pagas por você (PIX ou cartão na hora).']
                : card.isDefault
                    ? ['A cobrança automática passa a usar outro cartão salvo (o mais recente) até você escolher um novo padrão.']
                    : [];
        showConfirm({
            tone: 'danger',
            icon: Trash2,
            title: 'Remover este cartão?',
            message: `${label}${card.isDefault ? ' — cartão padrão' : ''}`,
            consequences: [
                'O cartão é apagado da sua carteira e não poderá mais ser usado nos pagamentos.',
                ...autoChargeImpact,
                'Pagamentos já feitos com ele não mudam. Para usá-lo de novo, será preciso cadastrá-lo outra vez.',
            ],
            confirmLabel: 'Remover cartão',
            onConfirm: async () => {
                setRemovingId(card.id);
                try {
                    await stripeApi.removePaymentMethod(card.id);
                } finally {
                    setRemovingId(null);
                }
                showToast('Cartão removido.');
                loadData();
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

    if (loadError && contracts.length === 0) {
        return (
            <div style={{ textAlign: 'center', padding: '48px 20px', color: 'var(--text-secondary)' }}>
                <p style={{ marginBottom: 16 }}>Não foi possível carregar seus pagamentos. Verifique sua conexão.</p>
                <button className="btn btn-primary" onClick={() => { setLoading(true); loadData(); }}>Tentar novamente</button>
            </div>
        );
    }

    return (
        <div>
            {/* ─── Hero Banner (same convention as Contratos/Agenda) ─── */}
            <div className={`client-hero ${hasOverdue ? 'client-hero--alert' : 'client-hero--default'} animate-card-enter`}>
                <HeroAmbient variant="pagar" />
                <div className="client-hero__header" style={{ marginBottom: '16px' }}>
                    <div className={`client-hero__icon-wrapper ${hasOverdue ? 'client-hero__icon-wrapper--danger' : 'client-hero__icon-wrapper--success'}`}>
                        <Landmark size={22} />
                    </div>
                    <div>
                        <h2 className="client-hero__greeting">Pagamentos</h2>
                        <p className="client-hero__message">{heroMessage}</p>
                    </div>
                </div>
                <div className="client-cta-stack">
                    {pendingPayments.length > 0 && (
                        <button className="btn btn-primary" onClick={() => { setTab('open'); setPayingPayment(pendingPayments[0]); }}>
                            <CreditCard size={16} /> Pagar agora
                        </button>
                    )}
                    <button className="btn btn-secondary" onClick={handleAddCard}>
                        <Plus size={16} /> Adicionar cartão
                    </button>
                </div>
            </div>

            {/* ─── Stat Cards ─── */}
            <div className="client-stats-grid stagger-enter">
                <StatCard
                    icon={Wallet}
                    label="Pendente"
                    value={formatBRL(totalPending)}
                    detail={overdueCount > 0 ? `${overdueCount} em atraso` : pendingPayments.length > 0 ? 'No prazo' : 'Tudo em dia'}
                    accent={overdueCount > 0 ? 'var(--danger)' : 'var(--success)'}
                    index={0}
                />
                <StatCard
                    icon={CheckCircle}
                    label="Total Pago"
                    value={formatBRL(totalPaid)}
                    detail={`${paidPayments.length} pagamento(s)`}
                    accent="var(--client-accent-teal)"
                    index={1}
                />
            </div>

            {/* ─── Segmented Tabs (Em aberto · Pagas · Plano · Carteira) ─── */}
            <div className="payments-tabs" role="tablist">
                {([
                    ['open', 'Em aberto', pendingPayments.length],
                    ['paid', 'Pagas', paidPayments.length],
                    ['plan', 'Plano', planContracts.length],
                    ['wallet', 'Carteira', cards.length],
                ] as const).map(([key, label, count]) => (
                    <button
                        key={key}
                        role="tab"
                        aria-selected={tab === key}
                        className={`payments-tab ${tab === key ? 'payments-tab--active' : ''}`}
                        onClick={() => setTab(key)}
                    >
                        <span className="payments-tab__count">{count}</span>
                        <span className="payments-tab__label">{label}</span>
                    </button>
                ))}
            </div>

            {/* ─── TAB: Em aberto ─── */}
            {tab === 'open' && (
                pendingPayments.length === 0 ? (
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
                                <PendingPaymentCard
                                    key={p.id}
                                    payment={p}
                                    index={i}
                                    isOverdue={isOverdue}
                                    isFailed={isFailed}
                                    onPay={() => setPayingPayment(p)}
                                    onExpired={loadData}
                                />
                            );
                        })}
                    </div>
                )
            )}

            {/* ─── TAB: Carteira — cobrança automática ─── */}
            {tab === 'wallet' && (cards.length > 0 || autoCharge) && (
                <div className={`autocharge-card animate-card-enter ${autoCharge ? 'autocharge-card--active' : ''}`} style={{ '--i': 0 } as React.CSSProperties}>
                    <div className="autocharge-card__info">
                        <h3 className="autocharge-card__title">
                            <Shield size={18} style={{ color: autoCharge ? 'var(--success)' : 'var(--text-muted)' }} />
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

            {/* ─── TAB: Pagas (histórico) ─── */}
            {tab === 'paid' && (
                paidPayments.length === 0 ? (
                    <div className="payments-empty animate-card-enter" style={{ '--i': 0 } as React.CSSProperties}>
                        <Clock size={32} className="payments-empty__icon" />
                        <div className="payments-empty__text">Nenhum pagamento concluído ainda.</div>
                    </div>
                ) : (
                    <>
                        <div className="history-list">
                            {paidPayments.slice(0, showAllHistory ? undefined : 5).map(p => (
                                <div key={p.id} className="history-item">
                                    <div className="history-item__info">
                                        <div className="history-item__name">{p.contractName}</div>
                                        <div className="history-item__date">Pago em {formatDate(p.dueDate)}</div>
                                    </div>
                                    <div className="history-item__right">
                                        <span className="history-item__amount">{formatBRL(paidChargedAmount(p))}</span>
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
                    </>
                )
            )}

            {/* ─── TAB: Plano de Pagamento ─── */}
            {tab === 'plan' && (
                planContracts.length === 0 ? (
                    <div className="payments-empty animate-card-enter" style={{ '--i': 0 } as React.CSSProperties}>
                        <CalendarClock size={32} className="payments-empty__icon" />
                        <div className="payments-empty__text">Nenhum plano de pagamento ativo.</div>
                    </div>
                ) : (
                    <div className="payment-plans stagger-enter">
                        {planContracts.map((c, ci) => {
                            const isFull = c.paymentPlan === 'FULL';
                            const isServico = c.type === 'SERVICO';
                            // D1: serviço mensal parcelado no cartão = FULL + CARTÃO (total cobrado de uma vez,
                            // em até N× sem juros) — não é "quitado à vista".
                            const cardInstallments = Math.max(0, ...(c.payments || []).map(p => p.installments ?? 0));
                            const fullTag = isServico && c.paymentMethod === 'CARTAO'
                                ? (cardInstallments > 1 ? `Parcelado no cartão (${cardInstallments}x)` : 'Total no cartão')
                                : 'Quitado à vista';
                            const installments = [...(c.payments || [])].sort((a, b) =>
                                (a.dueDate ? new Date(a.dueDate).getTime() : 0) - (b.dueDate ? new Date(b.dueDate).getTime() : 0)
                            );
                            const total = installments.length;
                            const fullPayment = installments.find(p => p.status === 'PAID') || installments[0];
                            // Earliest still-pending installment → highlighted as the next charge.
                            const nextDueId = installments.find(p => p.status === 'PENDING')?.id;
                            return (
                                <div key={c.id} className="payment-plan-card animate-card-enter" style={{ '--i': ci } as React.CSSProperties}>
                                    <div className="payment-plan-card__head">
                                        <div className="payment-plan-card__name">{c.name || c.type}</div>
                                        <span className={`payment-plan-card__tag ${isFull ? 'payment-plan-card__tag--full' : isServico ? 'payment-plan-card__tag--servico' : ''}`}>
                                            {isFull ? fullTag : isServico ? 'Serviço mensal' : 'Mensal'}
                                        </span>
                                    </div>
                                    {!isFull && (
                                        <div className="payment-plan-card__cadence">
                                            {isServico ? 'Cobrança mensal · mês calendário' : 'Cobrança mensal · ciclo de 28 dias'}
                                        </div>
                                    )}
                                    {isFull ? (
                                        <div className="payment-plan-card__full">
                                            <span className="payment-plan-card__full-label">Valor pago</span>
                                            <span className="payment-plan-card__full-amount">
                                                {formatBRL(fullPayment?.amount ?? 0)}
                                            </span>
                                            <StatusBadge status={fullPayment?.status === 'PAID' ? 'PAID' : 'PENDING'} />
                                        </div>
                                    ) : (
                                        <div className="payment-plan-schedule">
                                            {installments.map((p, idx) => {
                                                const isOverdue = p.status === 'PENDING' && p.dueDate && new Date(p.dueDate) < now;
                                                const isNext = p.id === nextDueId;
                                                return (
                                                    <div key={p.id} className={`payment-plan-row ${isNext ? 'payment-plan-row--next' : ''}`}>
                                                        <div className="payment-plan-row__left">
                                                            <span className="payment-plan-row__num">{idx + 1}/{total}</span>
                                                            <span className="payment-plan-row__date">{formatDate(p.dueDate)}</span>
                                                        </div>
                                                        <div className="payment-plan-row__right">
                                                            <span className="payment-plan-row__amount">{formatBRL(p.amount)}</span>
                                                            <StatusBadge
                                                                status={isOverdue ? 'FAILED' : p.status}
                                                                label={isOverdue ? 'Atrasada' : p.status === 'PAID' ? 'Paga' : p.status === 'PENDING' ? (isNext ? 'Próxima' : 'Pendente') : undefined}
                                                            />
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )
            )}

            {/* ─── TAB: Carteira — cartões salvos ─── */}
            {tab === 'wallet' && (
            <div className="payments-section">
                <h3 className="payments-section__title">
                    <span className="payments-section__icon payments-section__icon--cards">
                        <CreditCard size={18} />
                    </span>
                    Cartões Salvos
                </h3>

                {cards.length === 0 && (
                    <div className="info-box info-box--neutral" style={{ marginBottom: 12 }}>
                        Adicione um cartão para ativar a cobrança automática e pagar mais rápido. Você também pode pagar via PIX ou cartão novo na hora.
                    </div>
                )}

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
                                    <CreditCard size={22} style={{ color: card.isDefault ? 'var(--success)' : 'var(--text-secondary)' }} />
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
                                    aria-label={`Remover cartão ${BRAND_LABELS[card.brand] || card.brand} final ${card.last4}`}
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
            )}

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
                    title="Pagar"
                    amount={payingPayment.amount}
                    paymentId={payingPayment.id}
                    description={describePayment(payingPayment)}
                    contractDuration={payingPayment.contractDuration}
                    allowedMethods={payingPayment.boletoAllowed ? ['CARTAO', 'PIX', 'BOLETO'] : ['CARTAO', 'PIX']}
                    initialMethod={payingPayment.contractPaymentMethod}
                    allowBoleto={!!payingPayment.boletoAllowed}
                    paymentDeadline={payingPayment.paymentDeadline}
                    contractStatus={payingPayment.contractStatus}
                    onDeadline={async () => {
                        // Prazo da contratação acabou com o modal aberto: a varredura desfaz a contratação
                        // (conciliando antes um PIX pago no limite). Confere uma vez antes de avisar.
                        const target = payingPayment;
                        let paid = false;
                        try { paid = (await paymentsApi.getStatus(target.id)).status === 'PAID'; } catch { /* sem rede */ }
                        setPayingPayment(null);
                        if (paid) {
                            showToast('Pagamento confirmado!');
                        } else {
                            showToast({
                                type: 'error',
                                message: target.contractType === 'AVULSO'
                                    ? 'Tempo esgotado. O horário foi liberado.'
                                    : `Tempo esgotado. A contratação de ${target.contractName} não foi concluída.`,
                            });
                        }
                        loadData();
                    }}
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

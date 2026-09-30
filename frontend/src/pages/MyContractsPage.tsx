import { getErrorMessage } from '../utils/errors';
import HeroAmbient from '../components/client/HeroAmbient';
import { useState, useEffect } from 'react';
import { contractsApi, ContractWithStats, ContractBooking, pricingApi, PricingConfig, stripeApi, AutoChargeState, PaymentSummary, AddOnConfig } from '../api/client';
import ContractWizard from '../components/ContractWizard';
import CustomContractWizard from '../components/CustomContractWizard';
import BulkBookingModal from '../components/BulkBookingModal';
import BookingDetailModal from '../components/BookingDetailModal';
import PaymentModal from '../components/PaymentModal';
import CancelContractModal from '../components/CancelContractModal';
import ServiceContractWizard from '../components/ServiceContractWizard';
import AutoChargeModal from '../components/SubscribeModal';
import RenewContractModal from '../components/RenewContractModal';
import { useLocation, useNavigate } from 'react-router-dom';
import { useUI } from '../context/UIContext';
import { FileText, Sparkles, Plus, Pencil } from 'lucide-react';
import ContractCard from '../components/client/ContractCard';
import { renderServiceIcon } from '../utils/serviceIcons';
import { formatBRL } from '../utils/format';
import { isAvulsoContract, isContractCurrent } from '../utils/contractStatus';
import { chargeLabel, installmentPositions, isBlockedByPendingCancellation, isCancellationFine } from '../utils/paymentLabels';
import { getStatusLabel } from '../constants/adminMeta';
import { ContractsSkeleton } from '../components/ui/SkeletonLoader';
import Tooltip from '../components/ui/Tooltip';
import '../styles/my-contracts.css';

export default function MyContractsPage() {
    const location = useLocation();
    const navigate = useNavigate();
    const [contracts, setContracts] = useState<ContractWithStats[]>([]);
    const [pricing, setPricing] = useState<PricingConfig[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState(false);
    const [tab, setTab] = useState<'active' | 'archived' | 'cancelled'>('active');
    const [expandedId, setExpandedId] = useState<string | null>(location.state?.expandContractId || null);
    
    const { showToast } = useUI();

    // Service Addons (two families via `monthly`: per-episode add-ons + monthly services)
    const [allAddons, setAllAddons] = useState<AddOnConfig[]>([]);
    // Monthly service the client is contracting/renewing inline (opens the wizard).
    const [wizardAddon, setWizardAddon] = useState<AddOnConfig | null>(null);
    const [wizardMode, setWizardMode] = useState<'hire' | 'renew'>('hire');

    // Booking detail modal (o BookingDetailModal cuida do próprio estado de edição/remarcação)
    const [detailBooking, setDetailBooking] = useState<ContractBooking | null>(null);

    // Contract Wizard
    const [showWizard, setShowWizard] = useState(false);
    const [showCustomWizard, setShowCustomWizard] = useState(false);

    // Bulk Booking
    const [showBulkModalFor, setShowBulkModalFor] = useState<ContractWithStats | null>(null);

    // Cancel Modal
    const [showCancelModalFor, setShowCancelModalFor] = useState<{ id: string } | null>(null);

    // Renew Modal
    const [showRenewModalFor, setShowRenewModalFor] = useState<ContractWithStats | null>(null);

    // Cobrança automática (E9): por CLIENTE — o mesmo estado vale para todos os cards.
    const [showAutoChargeFor, setShowAutoChargeFor] = useState<ContractWithStats | null>(null);
    const [autoCharge, setAutoCharge] = useState<AutoChargeState | null>(null);

    // Pay a pending contract installment inline (no navigation to /meus-pagamentos)
    const [payingInstallment, setPayingInstallment] = useState<{ payment: PaymentSummary; contract: ContractWithStats } | null>(null);



    useEffect(() => { loadData(); }, []);

    // `silent`: recarrega sem o esqueleto — o esqueleto desmonta a página inteira, inclusive um modal que
    // ainda está aberto (detalhe da gravação avisando `onChanged`, checkout fechado no cancelar).
    const loadData = async (silent = false) => {
        if (!silent) {
            setLoading(true);
            setLoadError(false);
        }
        try {
            const [contractsRes, pricingRes, addonsRes, autoChargeRes] = await Promise.all([
                contractsApi.getMy(),
                pricingApi.get(),
                pricingApi.getAddons(),
                // Estado desconhecido (falha) → o card mostra "Ativar…" e o modal consulta de novo ao abrir.
                stripeApi.getAutoCharge().catch(() => null),
            ]);
            setContracts(contractsRes.contracts);
            setPricing(pricingRes.pricing);
            setAllAddons(addonsRes.addons);
            setAutoCharge(autoChargeRes);
        } catch (err) {
            console.error('Failed to load contracts:', err);
            // Recarga silenciosa que falha: a lista que já está na tela continua valendo.
            if (!silent) setLoadError(true);
        }
        finally { if (!silent) setLoading(false); }
    };

    const handleRenew = async (durationMonths: 3 | 6 | 12, paymentMethod: 'PIX' | 'CARTAO') => {
        if (!showRenewModalFor) return;
        try {
            await contractsApi.clientRenew(showRenewModalFor.id, { durationMonths, paymentMethod });
            showToast({ message: 'Renovação iniciada! Conclua o pagamento.', type: 'success' });
            setShowRenewModalFor(null);
            loadData();
        } catch (err: unknown) {
            showToast({ message: getErrorMessage(err) || 'Erro ao renovar contrato.', type: 'error' });
        }
    };

    // O modal de cobrança automática avisa que algo mudou: atualiza SÓ o estado dela, sem o esqueleto de
    // carregamento (que desmontaria a página e o modal, ainda aberto mostrando o resultado).
    const refreshAutoCharge = async () => {
        try { setAutoCharge(await stripeApi.getAutoCharge()); } catch { /* fica o último estado conhecido */ }
    };

    // Regra compartilhada com o KPI do dashboard (utils/contractStatus.ts).
    const activeContracts = contracts.filter(isContractCurrent);

    // Aba "Finalizados": Concluído (D6) e Expirado sempre; Ativo/Pausado só quando tudo foi
    // consumido e NÃO conta como atual (ex.: avulso com remarcação aberta fica em "Ativos").
    // A mesma regra decide o `isArchived` do card, então um contrato nunca aparece em duas abas.
    const isContractArchived = (c: ContractWithStats) => {
        if (c.status === 'COMPLETED' || c.status === 'EXPIRED') return true;
        if (c.status !== 'ACTIVE' && c.status !== 'PAUSED') return false;
        if (isContractCurrent(c)) return false;

        const bookings = c.bookings || [];
        const total = c.type === 'FIXO' ? c.durationMonths * 4 : c.totalBookings;
        const used = c.type === 'FIXO' ? bookings.filter(b => b.status !== 'NAO_REALIZADO' && b.status !== 'CANCELLED').length : (c.flexCreditsTotal || 0) - (c.flexCreditsRemaining || 0);
        const hasPending = bookings.some(b => {
            if (b.status === 'CANCELLED' || b.status === 'NAO_REALIZADO') return false;
            const dt = new Date(`${b.date.split('T')[0]}T${b.startTime}:00`);
            return dt >= new Date() && (b.status === 'RESERVED' || b.status === 'CONFIRMED');
        });
        return !hasPending && total > 0 && used >= total;
    };

    const archivedContracts = contracts.filter(isContractArchived);

    const cancelledContracts = contracts.filter(c => {
        if (c.status !== 'CANCELLED') return false;
        
        // Hide abandoned checkout avulsos
        const isAvulso = c.type === 'AVULSO' || (c.type === 'FLEX' && c.durationMonths === 1);
        if (isAvulso) {
            const hasNonCancelledBooking = c.bookings?.some(b => b.status !== 'CANCELLED');
            if (!hasNonCancelledBooking) return false;
        }
        return true;
    });

    const contractsToDisplay = tab === 'active' ? activeContracts : tab === 'archived' ? archivedContracts : cancelledContracts;

    const getPlanConfig = (tier: string) => pricing.find(p => p.tier === tier);

    const openBookingDetail = (b: ContractBooking) => setDetailBooking(b);

    const canModifyBooking = (b: ContractBooking): boolean => {
        if (b.status !== 'RESERVED' && b.status !== 'CONFIRMED') return false;
        const dateStr = b.date.split('T')[0];
        const bookingDateTime = new Date(`${dateStr}T${b.startTime}:00`);
        return (bookingDateTime.getTime() - Date.now()) / (1000 * 60 * 60) >= 24;
    };

    const handleRequestCancel = (id: string) => {
        setShowCancelModalFor({ id });
    };

    // D3: o CancelContractModal (DangerConfirmDialog) aguarda esta promise e mostra o erro dentro
    // dele — por isso sem try/catch aqui. No sucesso o próprio diálogo fecha (onClose).
    const confirmCancelContract = async () => {
        if (!showCancelModalFor) return;
        const res = await contractsApi.requestCancellation(showCancelModalFor.id);
        showToast(res.message || 'Cancelamento solicitado. O estúdio vai analisar o pedido.');
        loadData();
    };

    // Monthly subscription services (family `monthly`) the client can self-hire inline.
    const monthlyServices = allAddons.filter(a => a.monthly && a.active !== false);
    const hasActiveService = (key: string) =>
        contracts.some(c => c.type === 'SERVICO' && c.status === 'ACTIVE' && c.addOns?.includes(key));
    // "Renovar Serviço" é uma contratação NOVA do mesmo serviço (o backend não liga uma à outra): o serviço
    // já foi renovado quando existe outra contratação dele em vigor que termina DEPOIS desta.
    const serviceAlreadyRenewed = (c: ContractWithStats) => c.type === 'SERVICO' && contracts.some(o =>
        o.id !== c.id && o.type === 'SERVICO' && (o.status === 'ACTIVE' || o.status === 'PAUSED')
        && (o.addOns || [])[0] === (c.addOns || [])[0]
        && new Date(o.endDate).getTime() > new Date(c.endDate).getTime());

    const statusLabel = (s: string) => {
        switch (s) {
            case 'COMPLETED': return 'Concluído';
            case 'CONFIRMED': return 'Confirmado';
            case 'RESERVED': return '⏳ Reservado';
            case 'FALTA': return 'Falta';
            case 'NAO_REALIZADO': return 'Não Realizado';
            case 'PAUSED': return 'Pausado';
            // Demais (HELD "Em espera", CANCELLED…) pelo mapa único; desconhecido → '—' (nunca "Cancelado").
            default: return getStatusLabel(s);
        }
    };

    // O que está sendo pago no modal "Pagar parcela": "Parcela 2/3", "Multa de cancelamento (20%)", "Extra de gravação".
    const describeInstallment = (payment: PaymentSummary, contract: ContractWithStats) => {
        const what = chargeLabel(payment, {
            isAvulso: isAvulsoContract(contract),
            finePct: (contract.cancellationFine?.id === payment.id ? contract.cancellationFine.finePct : null) ?? contract.finePct,
            position: installmentPositions(contract.payments || []).get(payment.id),
        });
        return {
            title: isCancellationFine(payment) ? 'Pagar multa' : 'Pagar parcela',
            description: `${contract.name} — ${what ?? 'parcela'}`,
        };
    };

    const openInstallmentPayment = (payment: PaymentSummary, contract: ContractWithStats) => {
        // E13: com o cancelamento em análise, as parcelas do plano ficam suspensas (o backend devolve 409).
        if (isBlockedByPendingCancellation(contract.status, payment)) {
            showToast({ type: 'error', message: 'Este contrato está com o cancelamento em análise. Aguarde a decisão do estúdio.' });
            return;
        }
        setPayingInstallment({ payment, contract });
    };

    // "Pagar Agora" do banner de contrato AGUARDANDO PAGAMENTO.
    const payAwaitingContract = async (c: ContractWithStats) => {
        // A 1ª cobrança a vencer (menor vencimento) — no personalizado do cliente TODAS as parcelas
        // nascem PENDING, e a que se paga agora é a 1ª (contratos-2).
        const byDue = [...(c.payments || [])].sort((a, b) =>
            (a.dueDate ? new Date(a.dueDate).getTime() : Infinity) - (b.dueDate ? new Date(b.dueDate).getTime() : Infinity));
        const pending = byDue.find(p => p.status === 'PENDING');
        // AVULSO é pago pelo pagamento do PRÓPRIO agendamento (o backend rejeita /contracts/:id/pay,
        // que cobraria mês×faixa) e o SERVIÇO já nasce com a 1ª cobrança criada (D2): o /pay forçaria
        // cartão e aposentaria o QR PIX. Os dois vão direto ao pagamento pendente — ou à cobrança que
        // FALHOU (cartão recusado): o checkout reabre a FAILED com uma cobrança nova (pagamentos-11).
        if (c.type === 'AVULSO' || c.type === 'SERVICO') {
            const payable = pending ?? byDue.find(p => p.status === 'FAILED');
            if (payable) {
                navigate('/meus-pagamentos', { state: { autoOpenPaymentId: payable.id } });
            } else {
                showToast({
                    type: 'error',
                    message: c.type === 'AVULSO'
                        ? 'Pagamento do agendamento não encontrado. Abra "Minhas Reservas" para pagar.'
                        : 'Pagamento da contratação não encontrado. Atualize a página ou contrate o serviço de novo.',
                });
            }
            return;
        }
        // Demais (renovação, personalizado): /pay com a forma de pagamento DO CONTRATO — o padrão do
        // backend é CARTÃO e aposentaria um PIX vivo (e daria 503 com o Stripe desligado). Boleto não
        // passa pelo /pay: com a cobrança já criada, vai direto ao checkout (que gera o boleto).
        if (c.paymentMethod === 'BOLETO' && pending) {
            navigate('/meus-pagamentos', { state: { autoOpenPaymentId: pending.id } });
            return;
        }
        try {
            const res = await contractsApi.pay(c.id, { paymentMethod: c.paymentMethod === 'PIX' ? 'PIX' : 'CARTAO' });
            if (res.alreadyPaid) {
                showToast({ type: 'success', message: res.message || 'Pagamento já confirmado.' });
                loadData();
                return;
            }
            showToast({ type: 'success', message: 'Abrindo pagamento...' });
            // FE-H1 FIX: Never expose clientSecret in URL — use navigate state instead
            // MyPaymentsPage already handles location.state.autoOpenPaymentId
            // contratos-2: abre EXATAMENTE a linha em que o backend gerou a cobrança.
            navigate('/meus-pagamentos', {
                state: { autoOpenPaymentId: res.paymentId || pending?.id }
            });
        } catch (err: unknown) {
            // Cobrança já existente (ex.: PIX sem CPF no perfil): o checkout resolve (pede o CPF).
            if (pending) {
                navigate('/meus-pagamentos', { state: { autoOpenPaymentId: pending.id } });
                return;
            }
            showToast({ type: 'error', message: getErrorMessage(err) || 'Erro ao iniciar pagamento' });
        }
    };

    // Prazo de pagamento esgotado com a tela aberta (a varredura do backend apaga a contratação).
    const expireAwaitingContract = (c: ContractWithStats) => {
        setContracts(prev => prev.filter(ct => ct.id !== c.id));
        if (c.type === 'SERVICO') {
            const svcName = allAddons.find(a => a.key === (c.addOns || [])[0])?.name || c.name;
            showToast(`Tempo esgotado. A contratação de ${svcName} não foi concluída.`);
            return;
        }
        if (c.type === 'AVULSO') {
            showToast('⏰ Tempo esgotado. O horário foi liberado.');
            return;
        }
        // Personalizado do cliente: as sessões RESERVADAS voltam para a agenda junto com a contratação.
        const holdsSlots = (c.bookings || []).some(b => b.status === 'RESERVED' || b.status === 'HELD');
        showToast(holdsSlots
            ? `Tempo esgotado. A contratação de ${c.name} não foi concluída e os horários foram liberados.`
            : `Tempo esgotado. A contratação de ${c.name} não foi concluída.`);
    };

    if (loading) return <ContractsSkeleton />;

    return (
        <div>
            {/* ─── Hero Banner ─── */}
            <div className="client-hero client-hero--default animate-card-enter">
                <HeroAmbient variant="contratos" />
                <div className="client-hero__header" style={{ marginBottom: '16px' }}>
                    <div className="client-hero__icon-wrapper client-hero__icon-wrapper--teal">
                        <Pencil size={22} />
                    </div>
                    <div>
                        <h2 className="client-hero__greeting">Meus Contratos</h2>
                        <p className="client-hero__message">
                            {activeContracts.length > 0
                                ? `${activeContracts.length} ativo(s) · Acompanhe consumo e regras`
                                : 'Acompanhe seus planos, consumo e regras'}
                        </p>
                    </div>
                </div>
                <div className="client-cta-stack">
                    <button className="btn btn-primary" onClick={() => setShowWizard(true)}>
                        <Plus size={16} /> Novo Contrato
                    </button>
                    <button className="btn btn-secondary" onClick={() => setShowCustomWizard(true)}>
                        <Sparkles size={16} /> Monte Seu Plano
                    </button>
                </div>

                {/* Compact monthly-service offers — integrated in the hero (scrolls on mobile).
                    Benefits/description live in the wizard's first step, keeping this slim. */}
                {monthlyServices.length > 0 && (
                    <div className="contracts-offers">
                        {monthlyServices.map(svc => {
                            const active = hasActiveService(svc.key);
                            return (
                                <Tooltip key={svc.key} content={active ? `Renovar ou adicionar ${svc.name}` : `Contratar ${svc.name}`}>
                                    <button type="button" className="contracts-offer" onClick={() => { setWizardMode('hire'); setWizardAddon(svc); }}>
                                        <span className="contracts-offer__icon">{renderServiceIcon(svc.icon, 18)}</span>
                                        <span className="contracts-offer__body">
                                            <span className="contracts-offer__name">{svc.name}</span>
                                            <span className="contracts-offer__meta">
                                                {active ? 'Renovar · ' : 'A partir de '}{formatBRL(svc.price)}<span>/mês</span>
                                            </span>
                                        </span>
                                        <span className="contracts-offer__cta">{active ? 'Contratar+' : 'Contratar'}</span>
                                    </button>
                                </Tooltip>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* ─── Tab Filters (Segmented Control) ─── */}
            <div className="contracts-tabs">
                {[
                    { key: 'active' as const, label: 'Ativos', count: activeContracts.length },
                    { key: 'archived' as const, label: 'Finalizados', count: archivedContracts.length },
                    { key: 'cancelled' as const, label: 'Cancelados', count: cancelledContracts.length },
                ].map(t => (
                    <button
                        key={t.key}
                        className={`contracts-tab ${tab === t.key ? 'contracts-tab--active' : ''}`}
                        onClick={() => setTab(t.key)}
                    >
                        <span className="contracts-tab__count">{t.count}</span>
                        <span className="contracts-tab__label">{t.label}</span>
                    </button>
                ))}
            </div>

            {/* ─── Contract List ─── */}
            {loadError && contracts.length === 0 ? (
                <div className="contracts-empty animate-card-enter" style={{ '--i': 0 } as React.CSSProperties}>
                    <FileText size={32} className="contracts-empty__icon" />
                    <div className="contracts-empty__text">Não foi possível carregar seus contratos.</div>
                    <button className="btn btn-primary btn-sm" style={{ marginTop: 10 }} onClick={() => loadData()}>Tentar novamente</button>
                </div>
            ) : contractsToDisplay.length === 0 ? (
                <div className="contracts-empty animate-card-enter" style={{ '--i': 0 } as React.CSSProperties}>
                    <FileText size={32} className="contracts-empty__icon" />
                    <div className="contracts-empty__text">
                        Nenhum contrato {tab === 'active' ? 'ativo' : tab === 'archived' ? 'finalizado' : 'cancelado'}
                    </div>
                </div>
            ) : (
                <div className="contracts-grid stagger-enter">
                    {contractsToDisplay.map((c, i) => (
                        <div key={c.id} className="animate-card-enter" style={{ '--i': i } as React.CSSProperties}>
                            <ContractCard contract={c} planConfig={getPlanConfig(c.tier)} allAddons={allAddons}
                                expanded={expandedId === c.id} onToggle={() => setExpandedId(expandedId === c.id ? null : c.id)}
                                onBookingClick={openBookingDetail} statusLabel={statusLabel} canModify={canModifyBooking}
                                onRequestCancel={c.status === 'ACTIVE' && !isContractArchived(c) ? handleRequestCancel : undefined}
                                onBulkBooking={c.status === 'ACTIVE' && !isContractArchived(c) ? () => setShowBulkModalFor(c) : undefined}
                                isArchived={isContractArchived(c)}
                                isCancelled={c.status === 'CANCELLED'}
                                onRenewContract={serviceAlreadyRenewed(c) ? undefined : () => {
                                    // Services renew through the same self-serve wizard (service pricing,
                                    // plan, cadence) — not the recordings-oriented RenewContractModal.
                                    if (c.type === 'SERVICO') {
                                        const svc = allAddons.find(a => a.key === (c.addOns || [])[0]);
                                        if (svc) { setWizardMode('renew'); setWizardAddon(svc); return; }
                                    }
                                    setShowRenewModalFor(c);
                                }}
                                onAutoCharge={() => setShowAutoChargeFor(c)}
                                autoCharge={autoCharge
                                    ? { enabled: autoCharge.autoChargeEnabled && !!autoCharge.defaultCard, last4: autoCharge.defaultCard?.last4 }
                                    : null}
                                onPayInstallment={(payment) => openInstallmentPayment(payment, c)}
                                onPayContract={c.status === 'AWAITING_PAYMENT' ? () => { void payAwaitingContract(c); } : undefined}
                                onExpireContract={c.status === 'AWAITING_PAYMENT' ? () => expireAwaitingContract(c) : undefined} />
                        </div>
                    ))}
                </div>
            )}

            {/* Booking Detail Modal — só o cabeçalho (data, horário, faixa, status); o modal re-hidrata o resto
                por GET /bookings/:id (recado do estúdio, episódio, redes, métricas). */}
            {detailBooking && (
                <BookingDetailModal
                    booking={{
                        id: detailBooking.id,
                        date: detailBooking.date,
                        startTime: detailBooking.startTime,
                        endTime: detailBooking.endTime,
                        tierApplied: detailBooking.tierApplied,
                        status: detailBooking.status,
                        price: detailBooking.price,
                    }}
                    onClose={() => setDetailBooking(null)}
                    onSaved={() => { setDetailBooking(null); loadData(); }}
                    // Mudou no servidor com o modal aberto (capa enviada, gravação finalizada): recarga silenciosa.
                    onChanged={() => { void loadData(true); }}
                    allAddons={allAddons}
                    contractDiscountPct={(() => {
                        const parent = contracts.find(c => c.bookings?.some(b => b.id === detailBooking.id));
                        return parent?.discountPct || 0;
                    })()}
                    contractAddOns={(() => {
                        const parent = contracts.find(c => c.bookings?.some(b => b.id === detailBooking.id));
                        return parent?.addOns || [];
                    })()}
                />
            )}

            {/* Contract Wizard Modal */}
            {showWizard && (
                <ContractWizard
                    pricing={pricing}
                    onClose={() => setShowWizard(false)}
                    onComplete={() => { loadData(); setShowWizard(false); showToast('Novo contrato criado!'); }}
                    onOpenCustom={() => {
                        setShowWizard(false);
                        setShowCustomWizard(true);
                    }}
                />
            )}

            {showBulkModalFor && (
                <BulkBookingModal
                    contract={{
                        id: showBulkModalFor.id,
                        tier: showBulkModalFor.tier,
                        flexCreditsRemaining: showBulkModalFor.flexCreditsRemaining || 0,
                        endDate: showBulkModalFor.endDate,
                    }}
                    onClose={() => setShowBulkModalFor(null)}
                    onComplete={() => {
                        setShowBulkModalFor(null);
                        loadData();
                        showToast('Lote agendado com sucesso!');
                    }}
                />
            )}

            {/* Cancel Contract Modal */}
            <CancelContractModal
                isOpen={!!showCancelModalFor}
                contract={contracts.find(c => c.id === showCancelModalFor?.id) ?? null}
                onClose={() => setShowCancelModalFor(null)}
                onConfirm={confirmCancelContract}
            />

            {/* Monthly service self-hire wizard (multi-step, inline payment) */}
            {wizardAddon && (
                <ServiceContractWizard
                    isOpen={!!wizardAddon}
                    addon={wizardAddon}
                    mode={wizardMode}
                    onClose={() => setWizardAddon(null)}
                    onSuccess={() => { showToast('Serviço contratado! Ativando assim que o pagamento for confirmado.'); loadData(); }}
                    // Saiu sem pagar (fica "Aguardando pagamento" por 10 min) ou 409: recarrega a lista.
                    onPending={() => loadData()}
                />
            )}

            {/* Custom Contract Wizard Modal */}
            {showCustomWizard && (
                <CustomContractWizard
                    pricing={pricing}
                    onClose={() => setShowCustomWizard(false)}
                    onComplete={() => loadData()}
                />
            )}

            {/* Cobrança automática (E9): ativar com cartão salvo ou novo, trocar o cartão, desligar */}
            <AutoChargeModal
                isOpen={!!showAutoChargeFor}
                contract={showAutoChargeFor}
                onClose={() => setShowAutoChargeFor(null)}
                onChanged={refreshAutoCharge}
            />

            {/* Renew Modal */}
            <RenewContractModal
                isOpen={!!showRenewModalFor}
                tier={showRenewModalFor?.tier || ''}
                onClose={() => setShowRenewModalFor(null)}
                onConfirm={handleRenew}
            />

            {/* Pay a pending installment inline (PIX/cartão), without leaving the contract. */}
            {payingInstallment && (
                <PaymentModal
                    {...describeInstallment(payingInstallment.payment, payingInstallment.contract)}
                    amount={payingInstallment.payment.amount}
                    paymentId={payingInstallment.payment.id}
                    contractDuration={1}
                    allowedMethods={['CARTAO', 'PIX']}
                    // E3: o boleto é decidido pelo PaymentModal (chave-mestra + Cora; nunca com o contrato aguardando pagamento).
                    contractStatus={payingInstallment.contract.status}
                    onSuccess={() => { setPayingInstallment(null); showToast('Pagamento confirmado!'); loadData(); }}
                    onError={(msg) => showToast({ type: 'error', message: msg })}
                    // E2: emitir o PIX pode mudar o valor da cobrança — recarrega (sem esqueleto) também ao cancelar.
                    onClose={() => { setPayingInstallment(null); void loadData(true); }}
                />
            )}

        </div>
    );
}


import { getErrorMessage } from '../utils/errors';
import { useState, useEffect } from 'react';
import { contractsApi, bookingsApi, ContractWithStats, ContractBooking, pricingApi, PricingConfig, stripeApi, SavedCard } from '../api/client';
import ContractWizard from '../components/ContractWizard';
import CustomContractWizard from '../components/CustomContractWizard';
import BulkBookingModal from '../components/BulkBookingModal';
import BookingDetailModal from '../components/BookingDetailModal';
import ModalOverlay from '../components/ModalOverlay';
import { useLocation } from 'react-router-dom';
import { useBusinessConfig } from '../hooks/useBusinessConfig';
import { useUI } from '../context/UIContext';
import StatusBadge from '../components/ui/StatusBadge';
import { FileText, Sparkles, Palette, Rocket, CheckCircle, XCircle, AlertTriangle, CreditCard, Pause, RefreshCw, CalendarDays, Clock, BarChart3, Pencil, Loader2 } from 'lucide-react';
import { getClientPaymentMethods, type PaymentMethodKey } from '../constants/paymentMethods';

const DAY_NAMES = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const PLATFORMS = [
    { key: 'YOUTUBE', label: 'YouTube', color: '#FF0000' },
    { key: 'TIKTOK', label: 'TikTok', color: '#00F2EA' },
    { key: 'INSTAGRAM', label: 'Instagram', color: '#E1306C' },
    { key: 'FACEBOOK', label: 'Facebook', color: '#1877F2' },
];

function formatBRL(cents: number): string {
    return `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;
}

export default function MyContractsPage() {
    const location = useLocation();
    const [contracts, setContracts] = useState<ContractWithStats[]>([]);
    const [pricing, setPricing] = useState<PricingConfig[]>([]);
    const [loading, setLoading] = useState(true);
    const [tab, setTab] = useState<'active' | 'archived' | 'cancelled'>('active');
    const [expandedId, setExpandedId] = useState<string | null>(location.state?.expandContractId || null);
    
    const { showAlert, showToast } = useUI();

    // Service Addons
    interface Addon { key: string; name: string; price: number; description?: string | null; monthly?: boolean; }
    const [allAddons, setAllAddons] = useState<Addon[]>([]);
    const [socialAddon, setSocialAddon] = useState<Addon | null>(null);
    const [showSocialModal, setShowSocialModal] = useState(false);
    const [socialPayment, setSocialPayment] = useState<PaymentMethodKey | null>(null);
    const [socialDuration, setSocialDuration] = useState<3 | 6>(3);
    const [subscribingSocial, setSubscribingSocial] = useState(false);

    // Booking detail modal state
    const [detailBooking, setDetailBooking] = useState<ContractBooking | null>(null);
    const [detailTab, setDetailTab] = useState<'preparativos' | 'metricas' | 'servicos'>('preparativos');
    const [clientNotes, setClientNotes] = useState('');
    const [platforms, setPlatforms] = useState<string[]>([]);
    const [platformLinks, setPlatformLinks] = useState<Record<string, string>>({});
    const [saving, setSaving] = useState(false);


    // Reschedule
    const [showReschedule, setShowReschedule] = useState(false);
    const [rescheduleDate, setRescheduleDate] = useState('');
    const [rescheduleTime, setRescheduleTime] = useState('');
    const [rescheduleError, setRescheduleError] = useState('');
    const [rescheduling, setRescheduling] = useState(false);

    // Contract Wizard
    const [showWizard, setShowWizard] = useState(false);
    const [showCustomWizard, setShowCustomWizard] = useState(false);

    // Bulk Booking
    const [showBulkModalFor, setShowBulkModalFor] = useState<ContractWithStats | null>(null);

    // Cancel Modal
    const [showCancelModalFor, setShowCancelModalFor] = useState<{ id: string, feeNote: string } | null>(null);
    const [cancellingContract, setCancellingContract] = useState(false);

    // Renew Modal
    const [showRenewModalFor, setShowRenewModalFor] = useState<ContractWithStats | null>(null);
    const [renewDuration, setRenewDuration] = useState<3 | 6 | 12>(3);
    const [renewMethod, setRenewMethod] = useState<'PIX' | 'CARTAO'>('PIX');
    const [renewLoading, setRenewLoading] = useState(false);

    // Subscribe (Recurring) Modal
    const [showSubscribeModalFor, setShowSubscribeModalFor] = useState<ContractWithStats | null>(null);
    const [savedCards, setSavedCards] = useState<SavedCard[]>([]);
    const [selectedCardId, setSelectedCardId] = useState<string>('');
    const [subscribeLoading, setSubscribeLoading] = useState(false);

    const { get: getRule } = useBusinessConfig();

    useEffect(() => { loadData(); }, []);

    const loadData = async () => {
        setLoading(true);
        try {
            const [contractsRes, pricingRes, addonsRes, cardsRes] = await Promise.all([
                contractsApi.getMy(), 
                pricingApi.get(),
                pricingApi.getAddons(),
                stripeApi.listPaymentMethods().catch(() => ({ paymentMethods: [], autoChargeEnabled: false }))
            ]);
            setContracts(contractsRes.contracts);
            setPricing(pricingRes.pricing);
            setAllAddons(addonsRes.addons);
            setSavedCards(cardsRes.paymentMethods);
            if (cardsRes.paymentMethods.length > 0) {
                const defaultCard = cardsRes.paymentMethods.find((c: any) => c.isDefault) || cardsRes.paymentMethods[0];
                setSelectedCardId(defaultCard.id);
            }
            setSocialAddon(addonsRes.addons.find((a: any) => a.key === 'GESTAO_SOCIAL') || null);
        } catch (err) { console.error('Failed to load contracts:', err); }
        finally { setLoading(false); }
    };

    const handleRenew = async () => {
        if (!showRenewModalFor) return;
        setRenewLoading(true);
        try {
            await contractsApi.clientRenew(showRenewModalFor.id, { durationMonths: renewDuration, paymentMethod: renewMethod });
            showToast({ message: 'Renovação iniciada! Conclua o pagamento.', type: 'success' });
            setShowRenewModalFor(null);
            loadData();
        } catch (err: unknown) {
            showToast({ message: getErrorMessage(err) || 'Erro ao renovar contrato.', type: 'error' });
        } finally {
            setRenewLoading(false);
        }
    };

    const handleSubscribe = async () => {
        if (!showSubscribeModalFor || !selectedCardId) return;
        setSubscribeLoading(true);
        try {
            await contractsApi.subscribe(showSubscribeModalFor.id, { paymentMethodId: selectedCardId });
            showToast({ message: 'Cobrança automática ativada com sucesso.', type: 'success' });
            setShowSubscribeModalFor(null);
            loadData();
        } catch (err: unknown) {
            showToast({ message: getErrorMessage(err) || 'Erro ao ativar cobrança automática.', type: 'error' });
        } finally {
            setSubscribeLoading(false);
        }
    };

    const activeContracts = contracts.filter(c => {
        if (c.status === 'CANCELLED' || c.status === 'EXPIRED') return false;
        
        // Optimistically filter out expired pending contracts before the cleanup cron job runs
        if (c.status === 'AWAITING_PAYMENT' && c.paymentDeadline && new Date(c.paymentDeadline).getTime() <= Date.now()) return false;

        if (c.status !== 'ACTIVE' && c.status !== 'PENDING_CANCELLATION' && c.status !== 'PAUSED' && c.status !== 'AWAITING_PAYMENT') return false;
        if (c.status === 'AWAITING_PAYMENT') return true;

        const bookings = c.bookings || [];
        const totalBookings = c.type === 'FIXO' ? c.durationMonths * 4 : c.totalBookings;
        const usedBookingsCount = c.type === 'FIXO' ? bookings.filter(b => b.status !== 'NAO_REALIZADO' && b.status !== 'CANCELLED').length : (c.flexCreditsTotal || 0) - (c.flexCreditsRemaining || 0);

        const now = new Date();
        const hasPending = bookings.some(b => {
            if (b.status === 'CANCELLED' || b.status === 'NAO_REALIZADO') return false;
            const bookingDateTime = new Date(`${b.date.split('T')[0]}T${b.startTime}:00`);
            return bookingDateTime >= now && (b.status === 'RESERVED' || b.status === 'CONFIRMED');
        });

        if (hasPending) return true;
        if (c.status === 'PENDING_CANCELLATION') return true;

        return totalBookings === 0 || usedBookingsCount < totalBookings;
    });

    const archivedContracts = contracts.filter(c => {
        if (c.status === 'CANCELLED' || c.status === 'PENDING_CANCELLATION' || c.status === 'EXPIRED' || c.status === 'AWAITING_PAYMENT') return false;

        const bookings = c.bookings || [];
        const totalBookings = c.type === 'FIXO' ? c.durationMonths * 4 : c.totalBookings;
        const usedBookingsCount = c.type === 'FIXO' ? bookings.filter(b => b.status !== 'NAO_REALIZADO' && b.status !== 'CANCELLED').length : (c.flexCreditsTotal || 0) - (c.flexCreditsRemaining || 0);

        const now = new Date();
        const hasPending = bookings.some(b => {
            if (b.status === 'CANCELLED' || b.status === 'NAO_REALIZADO') return false;
            const bookingDateTime = new Date(`${b.date.split('T')[0]}T${b.startTime}:00`);
            return bookingDateTime >= now && (b.status === 'RESERVED' || b.status === 'CONFIRMED');
        });

        if (hasPending) return false;

        return totalBookings > 0 && usedBookingsCount >= totalBookings;
    });

    const cancelledContracts = contracts.filter(c => {
        if (c.status !== 'CANCELLED') return false;
        
        // Hide abandoned checkout avulsos
        const isAvulso = c.type === 'FLEX' && c.durationMonths === 1;
        if (isAvulso) {
            const hasNonCancelledBooking = c.bookings?.some(b => b.status !== 'CANCELLED');
            if (!hasNonCancelledBooking) return false;
        }
        return true;
    });

    const contractsToDisplay = tab === 'active' ? activeContracts : tab === 'archived' ? archivedContracts : cancelledContracts;

    const isContractArchived = (c: ContractWithStats) => {
        if (c.status === 'EXPIRED') return true;
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

    const getPlanConfig = (tier: string) => pricing.find(p => p.tier === tier);

    const openBookingDetail = (b: ContractBooking) => {
        setDetailBooking(b);
        setDetailTab('preparativos');
        setClientNotes(b.clientNotes || '');
        try { setPlatforms(b.platforms ? JSON.parse(b.platforms) : []); } catch { setPlatforms([]); }
        try { setPlatformLinks(b.platformLinks ? JSON.parse(b.platformLinks) : {}); } catch { setPlatformLinks({}); }
        setShowReschedule(false);
        setRescheduleError('');
    };

    const togglePlatform = (key: string) => {
        setPlatforms(prev => prev.includes(key) ? prev.filter(p => p !== key) : [...prev, key]);
    };

    const canModifyBooking = (b: ContractBooking): boolean => {
        if (b.status !== 'RESERVED' && b.status !== 'CONFIRMED') return false;
        const dateStr = b.date.split('T')[0];
        const bookingDateTime = new Date(`${dateStr}T${b.startTime}:00`);
        return (bookingDateTime.getTime() - Date.now()) / (1000 * 60 * 60) >= 24;
    };

    const handleSaveDetail = async () => {
        if (!detailBooking) return;
        setSaving(true);
        try {
            await bookingsApi.clientUpdate(detailBooking.id, {
                clientNotes, platforms: JSON.stringify(platforms), platformLinks: JSON.stringify(platformLinks),
            });
            showToast('Gravação atualizada!');
            setDetailBooking(null);
            loadData();
        } catch (err: unknown) { showAlert({ message: getErrorMessage(err), type: 'error' }); }
        finally { setSaving(false); }
    };

    const handleRequestCancel = async (id: string, feeNote: string) => {
        setShowCancelModalFor({ id, feeNote });
    };

    const confirmCancelContract = async () => {
        if (!showCancelModalFor) return;
        setCancellingContract(true);
        try {
            await contractsApi.requestCancellation(showCancelModalFor.id);
            showToast('Cancelamento solicitado com sucesso. Os agendamentos futuros foram liberados.');
            loadData();
            setShowCancelModalFor(null);
        } catch (err: unknown) {
            showAlert({ message: 'Erro ao solicitar cancelamento: ' + getErrorMessage(err), type: 'error' });
        } finally {
            setCancellingContract(false);
        }
    };

    const handlePurchaseAddon = async (bookingId: string, addonKey: string) => {
        setSaving(true);
        try {
            const res = await bookingsApi.purchaseAddon(bookingId, addonKey);
            showToast(res.message);
            // Re-fetch contracts data to sync updated booking
            await loadData();
            // Optimistically update detailBooking state
            setDetailBooking(prev => prev && prev.id === bookingId ? { ...prev, addOns: [...(prev.addOns || []), addonKey] } : prev);
        } catch (err: unknown) { showAlert({ message: getErrorMessage(err), type: 'error' }); }
        finally { setSaving(false); }
    };

    const handleReschedule = async () => {
        if (!detailBooking) return;
        setRescheduling(true); setRescheduleError('');
        try {
            await bookingsApi.reschedule(detailBooking.id, { date: rescheduleDate, startTime: rescheduleTime });
            showToast('Reagendado com sucesso!');
            setDetailBooking(null);
            loadData();
        } catch (err: unknown) { setRescheduleError(getErrorMessage(err)); }
        finally { setRescheduling(false); }
    };

    const handleSubscribeSocial = async () => {
        if (!socialAddon || !socialPayment) return;
        setSubscribingSocial(true);
        try {
            const res = await contractsApi.createService({ serviceKey: socialAddon.key, paymentMethod: socialPayment as any, durationMonths: socialDuration });
            showToast('Serviço contratado com sucesso!');
            setShowSocialModal(false);
            if (res.clientSecret) {
                showToast('Acesse "Pagamentos" para completar o pagamento com cartão.');
            }
            setTimeout(() => loadData(), 1000);
        } catch (err: unknown) {
            showAlert({ message: getErrorMessage(err) || 'Erro ao contratar serviço.', type: 'error' });
        } finally {
            setSubscribingSocial(false);
        }
    };



    const statusLabel = (s: string) => {
        switch (s) {
            case 'COMPLETED': return 'Concluído';
            case 'CONFIRMED': return 'Confirmado';
            case 'RESERVED': return '⏳ Reservado';
            case 'FALTA': return 'Falta';
            case 'NAO_REALIZADO': return 'Não Realizado';
            case 'PAUSED': return 'Pausado';
            default: return 'Cancelado';
        }
    };

    if (loading) return <div className="loading-spinner"><div className="spinner" /></div>;

    return (
        <div>
            <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '16px' }}>
                <div>
                    <h1 className="page-title">Meus Contratos & Serviços</h1>
                    <p className="page-subtitle">Acompanhe seus contratos, consumo e regras dos planos</p>
                </div>
                <div style={{ display: 'flex', gap: '8px' }}>
                    <button className="btn btn-primary" onClick={() => setShowWizard(true)}>
                        Novo Contrato
                    </button>
                    <button className="btn" onClick={() => setShowCustomWizard(true)}
                        style={{ background: 'linear-gradient(135deg, var(--accent-primary), #22c55e)', color: '#fff', border: 'none', fontWeight: 700, padding: '10px 16px' }}>
                        Monte Seu Plano
                    </button>
                </div>
            </div>



            {/* Gestao de Rede Social Banner */}
            {socialAddon && !contracts.some(c => c.type === 'SERVICO' && c.status === 'ACTIVE' && c.addOns?.includes('GESTAO_SOCIAL')) && (
                <div style={{
                    background: 'linear-gradient(135deg, rgba(139, 92, 246, 0.15) 0%, rgba(34, 197, 94, 0.1) 100%)',
                    border: '1px solid var(--accent-primary)', borderRadius: 'var(--radius-lg)',
                    padding: '24px', marginBottom: '32px', display: 'flex', flexWrap: 'wrap', gap: '24px', alignItems: 'center', justifyContent: 'space-between',
                }}>
                    <div style={{ flex: '1 1 300px' }}>
                        <div style={{ display: 'inline-block', padding: '4px 8px', background: 'var(--accent-primary)', color: '#fff', fontSize: '0.6875rem', fontWeight: 800, borderRadius: '4px', textTransform: 'uppercase', marginBottom: '12px', letterSpacing: '0.05em' }}>
                            Novo Serviço Especializado
                        </div>
                        <h3 style={{ fontSize: '1.5rem', fontWeight: 800, marginBottom: '8px', color: 'var(--text-primary)' }}>
                            {socialAddon.name}
                        </h3>
                        <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', lineHeight: 1.6, maxWidth: 500 }}>
                            {socialAddon.description || 'Deixe a publicação, análise de métricas e SEO dos seus cortes com nosso time de especialistas. Assinatura mensal avulsa independente de planos do estúdio.'}
                        </p>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', minWidth: 200 }}>
                        <div style={{ fontSize: '1.25rem', fontWeight: 800, color: 'var(--accent-primary)', textAlign: 'center' }}>
                            {formatBRL(socialAddon.price)}<span style={{ fontSize: '0.875rem', color: 'var(--text-muted)', fontWeight: 600 }}>/mês</span>
                        </div>
                        <button className="btn btn-primary" onClick={() => setShowSocialModal(true)} style={{ width: '100%', padding: '12px 20px' }}>
                            Assinar Agora
                        </button>
                    </div>
                </div>
            )}

            <div className="stats-row" style={{ marginBottom: '24px' }}>
                <div className={`stat-card ${tab === 'active' ? 'active' : ''}`} onClick={() => setTab('active')} style={{ cursor: 'pointer', border: tab === 'active' ? '2px solid var(--accent-primary)' : undefined }}>
                    <div className="stat-label">Ativos</div>
                    <div className="stat-value">{activeContracts.length}</div>
                </div>
                <div className={`stat-card ${tab === 'archived' ? 'active' : ''}`} onClick={() => setTab('archived')} style={{ cursor: 'pointer', border: tab === 'archived' ? '2px solid var(--accent-primary)' : undefined }}>
                    <div className="stat-label">Finalizados</div>
                    <div className="stat-value">{archivedContracts.length}</div>
                </div>
                <div className={`stat-card ${tab === 'cancelled' ? 'active' : ''}`} onClick={() => setTab('cancelled')} style={{ cursor: 'pointer', border: tab === 'cancelled' ? '2px solid var(--accent-primary)' : undefined }}>
                    <div className="stat-label">Cancelados</div>
                    <div className="stat-value">{cancelledContracts.length}</div>
                </div>
            </div>

            {contractsToDisplay.length === 0 ? (
                <div className="card"><div className="empty-state">
                    <div className="empty-state-icon"><FileText size={32} /></div>
                    <div className="empty-state-text">Nenhum contrato {tab === 'active' ? 'ativo' : tab === 'archived' ? 'finalizado' : 'cancelado'}</div>
                </div></div>
            ) : (
                <div style={{ display: 'grid', gap: '16px' }}>
                    {contractsToDisplay.map(c => (
                        <ContractCard key={c.id} contract={c} planConfig={getPlanConfig(c.tier)} allAddons={allAddons}
                            expanded={expandedId === c.id} onToggle={() => setExpandedId(expandedId === c.id ? null : c.id)}
                            onBookingClick={openBookingDetail} statusLabel={statusLabel} canModify={canModifyBooking}
                            onRequestCancel={c.status === 'ACTIVE' && !isContractArchived(c) ? handleRequestCancel : undefined}
                            onBulkBooking={c.status === 'ACTIVE' && !isContractArchived(c) ? () => setShowBulkModalFor(c) : undefined}
                            isArchived={isContractArchived(c)}
                            isCancelled={c.status === 'CANCELLED'}
                            onRenewContract={() => setShowRenewModalFor(c)}
                            onSubscribeContract={() => setShowSubscribeModalFor(c)}
                            onPayContract={c.status === 'AWAITING_PAYMENT' ? async () => {
                                try {
                                    const res = await contractsApi.pay(c.id);
                                    showToast({ type: 'success', message: 'Abrindo pagamento...' });
                                    window.location.href = `/meus-pagamentos?pay=${c.id}&secret=${res.clientSecret}`;
                                } catch (err: unknown) {
                                    showToast({ type: 'error', message: getErrorMessage(err) || 'Erro ao iniciar pagamento' });
                                }
                            } : undefined}
                            onExpireContract={c.status === 'AWAITING_PAYMENT' ? () => {
                                setContracts(prev => prev.filter(ct => ct.id !== c.id));
                                showToast('⏰ Tempo esgotado. O horário foi liberado.');
                            } : undefined} />
                    ))}
                </div>
            )}

            {/* Booking Detail Modal */}
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
                        clientNotes: detailBooking.clientNotes,
                        adminNotes: detailBooking.adminNotes,
                        platforms: detailBooking.platforms,
                        platformLinks: detailBooking.platformLinks,
                        addOns: detailBooking.addOns,
                        durationMinutes: detailBooking.durationMinutes,
                        peakViewers: detailBooking.peakViewers,
                        chatMessages: detailBooking.chatMessages,
                        audienceOrigin: detailBooking.audienceOrigin,
                    }}
                    onClose={() => setDetailBooking(null)}
                    onSaved={() => { setDetailBooking(null); loadData(); }}
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
                        type: showBulkModalFor.type,
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
            {showCancelModalFor && (
                <ModalOverlay onClose={() => setShowCancelModalFor(null)} preventClose={cancellingContract}>
                    <div className="modal" style={{ maxWidth: 400 }}>
                        <div style={{ textAlign: 'center', marginBottom: '20px' }}>
                            <AlertTriangle size={48} style={{ color: '#f59e0b', marginBottom: '10px' }} />
                            <h2 style={{ fontSize: '1.25rem', fontWeight: 700 }}>Solicitar Cancelamento</h2>
                        </div>
                        <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginBottom: '16px', lineHeight: 1.5, textAlign: 'center' }}>
                            Tem certeza que deseja solicitar o cancelamento antecipado deste contrato?
                        </p>
                        <div style={{ background: '#FFF0F0', border: '1px solid #FFCDD2', padding: '12px 16px', borderRadius: 'var(--radius-md)', color: '#D32F2F', fontSize: '0.8125rem', marginBottom: '24px', fontWeight: 500, lineHeight: 1.4 }}>
                            <strong>Atenção:</strong> O cancelamento implica uma respectiva multa de {showCancelModalFor.feeNote} Todos os seus horários futuros atrelados a este contrato serão libertados e cancelados de imediato.
                        </div>
                        <div className="modal-actions">
                            <button className="btn btn-secondary" onClick={() => setShowCancelModalFor(null)} disabled={cancellingContract} style={{ flex: 1 }}>
                                Voltar
                            </button>
                            <button className="btn btn-danger" onClick={confirmCancelContract} disabled={cancellingContract} style={{ flex: 1 }}>
                                {cancellingContract ? 'Aguarde...' : 'Confirmar Cancelamento'}
                            </button>
                        </div>
                    </div>
                </ModalOverlay>
            )}

            {/* Social Service Checkout Modal */}
            {showSocialModal && socialAddon && (
                <ModalOverlay onClose={() => setShowSocialModal(false)} preventClose={subscribingSocial}>
                    <div className="modal" style={{ maxWidth: 460 }}>
                        <div style={{ textAlign: 'center', marginBottom: '20px' }}>
                            <Rocket size={48} style={{ color: 'var(--accent-primary)', marginBottom: '10px' }} />
                            <h2 style={{ fontSize: '1.5rem', fontWeight: 800 }}>Assinar {socialAddon.name}</h2>
                        </div>
                        
                        <div style={{ fontWeight: 700, fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: '10px' }}>
                            1. Escolha sua Fidelidade
                        </div>

                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '24px' }}>
                            {[3, 6].map((dur) => {
                                const isSel = socialDuration === dur;
                                const discountPct = dur === 6 ? getRule('service_discount_6months') : getRule('service_discount_3months');
                                return (
                                    <div key={dur} onClick={() => setSocialDuration(dur as 3 | 6)} style={{
                                        border: `2px solid ${isSel ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                                        background: isSel ? 'rgba(139, 92, 246, 0.08)' : 'var(--bg-secondary)',
                                        borderRadius: 'var(--radius-md)', padding: '16px', cursor: 'pointer', textAlign: 'center', transition: 'all 0.2s',
                                        position: 'relative', overflow: 'hidden'
                                    }}>
                                        <div style={{ fontSize: '1.25rem', fontWeight: 800, color: isSel ? 'var(--accent-primary)' : 'var(--text-primary)' }}>{dur} Meses</div>
                                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '4px' }}>Desconto de {discountPct}%</div>
                                        {dur === 6 && (
                                            <div style={{ position: 'absolute', top: 12, right: -24, background: '#22c55e', color: '#fff', fontSize: '0.625rem', fontWeight: 800, padding: '2px 24px', transform: 'rotate(45deg)' }}>
                                                MELHOR
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                        
                        {(() => {
                            const monthlyBase = socialAddon.price;
                            const discountPct = socialDuration === 6 ? getRule('service_discount_6months') : getRule('service_discount_3months');
                            const monthlyDiscounted = Math.round(monthlyBase * (1 - discountPct / 100));
                            const subtotal = monthlyDiscounted * socialDuration;
                            
                            const pixExtra = getRule('pix_extra_discount_pct');
                            const card3xFee = getRule('card_fee_3x_pct');
                            const card6xFee = getRule('card_fee_6x_pct');
                            const pixTotal = Math.round(subtotal * (1 - pixExtra / 100));
                            const cardRate = socialDuration === 3 ? (1 + card3xFee / 100) : (1 + card6xFee / 100);
                            const cardTotal = Math.round(subtotal * cardRate);

                            return (
                                <>
                                    <div style={{
                                        padding: '16px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)', marginBottom: '24px',
                                    }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px', fontSize: '0.875rem' }}>
                                            <span style={{ color: 'var(--text-secondary)' }}>Valor Original ({socialDuration}x {formatBRL(monthlyBase)})</span>
                                            <span style={{ textDecoration: 'line-through', color: 'var(--text-muted)' }}>{formatBRL(monthlyBase * socialDuration)}</span>
                                        </div>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '1rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                                            <span>Subtotal com {discountPct}% OFF</span>
                                            <span>{formatBRL(subtotal)}</span>
                                        </div>
                                    </div>

                                    <div style={{ fontWeight: 700, fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: '10px' }}>
                                        2. Forma de Pagamento Única
                                    </div>

                                    {/* Payment Method Cards */}
                                    {getClientPaymentMethods().map(pm => {
                                        const isSelected = socialPayment === pm.key;
                                        return (
                                            <div key={pm.key} onClick={() => setSocialPayment(pm.key as PaymentMethodKey)}
                                                style={{
                                                    padding: '12px 14px', borderRadius: 'var(--radius-sm)', marginBottom: '10px', cursor: 'pointer',
                                                    background: isSelected ? pm.bgActive : pm.bgInactive,
                                                    border: `2px solid ${isSelected ? pm.borderActive : pm.borderInactive}`,
                                                    transition: 'all 0.2s ease',
                                                }}>
                                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                                    <div>
                                                        <div style={{ fontWeight: 700, fontSize: '0.875rem' }}>{pm.emoji} {pm.key === 'PIX' ? `${pm.label} (-${pixExtra}% Extra)` : `${pm.label} em até ${socialDuration}x`}</div>
                                                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{pm.key === 'PIX' ? 'Pagamento à vista' : `+ ${Math.round((cardRate - 1) * 100)}% Tx. de Parcelamento`}</div>
                                                    </div>
                                                    <div style={{ textAlign: 'right' }}>
                                                        {pm.key === 'PIX' ? (
                                                            <div style={{ fontSize: '1.125rem', fontWeight: 800, color: pm.color }}>{formatBRL(pixTotal)}</div>
                                                        ) : (
                                                            <div style={{ fontSize: '1.125rem', fontWeight: 800, color: 'var(--text-primary)' }}>
                                                                {socialDuration}x de {formatBRL(Math.round(cardTotal / socialDuration))}<span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: 600 }}>/mês</span>
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </>
                            );
                        })()}

                        <div className="modal-actions">
                            <button className="btn btn-secondary" onClick={() => setShowSocialModal(false)} disabled={subscribingSocial} style={{ flex: 1 }}>
                                Cancelar
                            </button>
                            <button className="btn btn-primary" onClick={handleSubscribeSocial} disabled={subscribingSocial || !socialPayment} style={{ flex: 1 }}>
                                {subscribingSocial ? 'Processando...' : 'Confirmar Assinatura'}
                            </button>
                        </div>
                    </div>
                </ModalOverlay>
            )}
            {/* Custom Contract Wizard Modal */}
            {showCustomWizard && (
                <CustomContractWizard
                    pricing={pricing}
                    onClose={() => setShowCustomWizard(false)}
                    onComplete={loadData}
                />
            )}

            {/* Subscribe (Recurring) Modal */}
            {showSubscribeModalFor && (
                <ModalOverlay onClose={() => !subscribeLoading && setShowSubscribeModalFor(null)}>
                    <div className="modal-content" style={{ maxWidth: '450px' }}>
                        <div className="modal-header">
                            <h2 style={{ fontSize: '1.25rem', fontWeight: 800 }}>Ativar Cobrança Automática</h2>
                            <button className="btn-close" onClick={() => setShowSubscribeModalFor(null)} disabled={subscribeLoading}>×</button>
                        </div>
                        <div style={{ padding: '20px' }}>
                            <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginBottom: '16px' }}>
                                O plano <strong>{showSubscribeModalFor.name} ({showSubscribeModalFor.tier})</strong> será cobrado mensalmente no seu cartão salvo de forma automática.
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
                                <button className="btn btn-secondary" onClick={() => setShowSubscribeModalFor(null)} disabled={subscribeLoading} style={{ flex: 1 }}>
                                    Cancelar
                                </button>
                                <button className="btn btn-primary" onClick={handleSubscribe} disabled={subscribeLoading || savedCards.length === 0 || !selectedCardId} style={{ flex: 1 }}>
                                    {subscribeLoading ? 'Processando...' : 'Assinar Automaticamente'}
                                </button>
                            </div>
                        </div>
                    </div>
                </ModalOverlay>
            )}

            {/* Renew Modal */}
            {showRenewModalFor && (
                <ModalOverlay onClose={() => !renewLoading && setShowRenewModalFor(null)}>
                    <div className="modal-content" style={{ maxWidth: '400px' }}>
                        <div className="modal-header">
                            <h2 style={{ fontSize: '1.25rem', fontWeight: 800 }}>Renovar Contrato</h2>
                            <button className="btn-close" onClick={() => setShowRenewModalFor(null)} disabled={renewLoading}>×</button>
                        </div>
                        <div style={{ padding: '20px' }}>
                            <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginBottom: '20px' }}>
                                Renove seu plano <strong>{showRenewModalFor.tier}</strong> agora para garantir seu horário e preço.
                            </p>

                            <div className="form-group">
                                <label className="form-label">Duração (Meses)</label>
                                <select className="form-input" value={renewDuration} onChange={e => setRenewDuration(Number(e.target.value) as any)}>
                                    <option value={3}>3 Meses</option>
                                    <option value={6}>6 Meses</option>
                                    <option value={12}>12 Meses</option>
                                </select>
                            </div>

                            <div className="form-group" style={{ marginTop: '16px' }}>
                                <label className="form-label">Método de Pagamento da Fatura</label>
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px' }}>
                                    {getClientPaymentMethods().map(pm => (
                                        <button key={pm.key} onClick={() => setRenewMethod(pm.key as 'PIX'|'CARTAO')}
                                            style={{
                                                padding: '10px 0', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)',
                                                background: renewMethod === pm.key ? 'var(--bg-card)' : 'transparent', fontWeight: 600, fontSize: '0.8125rem',
                                                borderColor: renewMethod === pm.key ? pm.color : 'var(--border-subtle)',
                                                color: renewMethod === pm.key ? pm.color : 'var(--text-secondary)'
                                            }}>
                                            {pm.emoji} {pm.label}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            <div className="modal-actions" style={{ marginTop: '24px' }}>
                                <button className="btn btn-secondary" onClick={() => setShowRenewModalFor(null)} disabled={renewLoading} style={{ flex: 1 }}>Voltar</button>
                                <button className="btn btn-primary" onClick={handleRenew} disabled={renewLoading} style={{ flex: 1 }}>
                                    {renewLoading ? 'Gerando...' : 'Confirmar'}
                                </button>
                            </div>
                        </div>
                    </div>
                </ModalOverlay>
            )}

        </div>
    );
}

function AwaitingPaymentBanner({ paymentDeadline, onPay, onExpire }: {
    paymentDeadline: string | null;
    onPay: () => void;
    onExpire?: () => void;
}) {
    const [remaining, setRemaining] = useState(() => {
        if (!paymentDeadline) return 600;
        const diff = new Date(paymentDeadline).getTime() - Date.now();
        return Math.max(0, Math.floor(diff / 1000));
    });

    useEffect(() => {
        if (!paymentDeadline) return;
        const timer = setInterval(() => {
            const diff = new Date(paymentDeadline).getTime() - Date.now();
            const secs = Math.max(0, Math.floor(diff / 1000));
            setRemaining(secs);
            if (secs <= 0) {
                clearInterval(timer);
                onExpire?.();
            }
        }, 1000);
        return () => clearInterval(timer);
    }, [paymentDeadline, onExpire]);

    const mins = Math.floor(remaining / 60);
    const secs = remaining % 60;
    const totalDuration = 600; // 10 min
    const pct = Math.max(0, (remaining / totalDuration) * 100);
    const timerColor = remaining <= 60 ? '#ef4444' : remaining <= 180 ? '#f59e0b' : '#d97706';

    return (
        <div style={{
            background: 'rgba(217, 119, 6, 0.1)', border: '1px solid rgba(217, 119, 6, 0.2)',
            borderLeft: '3px solid #d97706', padding: '16px', margin: '0 24px 16px 24px',
            borderRadius: 'var(--radius-sm)',
        }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
                <div style={{ flex: 1 }}>
                    <h4 style={{ fontSize: '0.875rem', fontWeight: 700, color: '#d97706', marginBottom: '4px' }}>
                        Pagamento Necessário
                    </h4>
                    <p style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)', marginBottom: 0 }}>
                        Complete o pagamento para ativar. O horário será liberado quando o tempo esgotar.
                    </p>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <div style={{
                        display: 'flex', alignItems: 'baseline', gap: '2px',
                        fontSize: '1.5rem', fontWeight: 800, fontVariantNumeric: 'tabular-nums',
                        color: timerColor, minWidth: '65px', justifyContent: 'center',
                    }}>
                        <span>{String(mins).padStart(2, '0')}</span>
                        <span style={{ opacity: 0.5, fontSize: '1.25rem' }}>:</span>
                        <span>{String(secs).padStart(2, '0')}</span>
                    </div>
                    <button className="btn btn-primary btn-sm"
                        onClick={(e) => { e.stopPropagation(); onPay(); }}
                        style={{ whiteSpace: 'nowrap', minWidth: '130px', background: '#d97706', borderColor: '#d97706' }}>
                        Pagar Agora
                    </button>
                </div>
            </div>
            {/* Progress bar */}
            <div style={{
                height: 4, borderRadius: 2, background: 'var(--bg-elevated)',
                marginTop: '10px', overflow: 'hidden',
            }}>
                <div style={{
                    height: '100%', borderRadius: 2,
                    background: timerColor,
                    width: `${pct}%`,
                    transition: 'width 1s linear, background 0.3s ease',
                }} />
            </div>
        </div>
    );
}

function ContractCard({ contract: c, planConfig, allAddons, expanded, onToggle, onBookingClick, statusLabel, canModify, onRequestCancel, onBulkBooking, isArchived, isCancelled, onPayContract, onRenewContract, onSubscribeContract, onExpireContract }: {
    contract: ContractWithStats; planConfig?: PricingConfig; allAddons: { key: string, name: string }[]; expanded: boolean; onToggle: () => void;
    onBookingClick: (b: ContractBooking) => void; statusLabel: (s: string) => string; canModify: (b: ContractBooking) => boolean;
    onRequestCancel?: (id: string, feeNote: string) => void;
    onBulkBooking?: () => void;
    isArchived?: boolean;
    isCancelled?: boolean;
    onPayContract?: () => void;
    onRenewContract?: () => void;
    onSubscribeContract?: () => void;
    onExpireContract?: () => void;
}) {
    const bookings: ContractBooking[] = c.bookings || [];
    const totalBookings = c.type === 'FIXO' ? c.durationMonths * 4 : c.totalBookings;
    const usedBookingsCount = c.type === 'FIXO' ? bookings.filter(b => b.status !== 'NAO_REALIZADO' && b.status !== 'CANCELLED').length : (c.flexCreditsTotal || 0) - (c.flexCreditsRemaining || 0);
    const usedPct = totalBookings > 0 ? Math.round((usedBookingsCount / totalBookings) * 100) : 0;
    const now = new Date();

    const pendingBookings = bookings.filter(b => {
        if (b.status === 'CANCELLED' || b.status === 'NAO_REALIZADO') return false;
        const bookingDateTime = new Date(`${b.date.split('T')[0]}T${b.startTime}:00`);
        return bookingDateTime >= now && (b.status === 'RESERVED' || b.status === 'CONFIRMED');
    });
    const completedBookings = bookings.filter(b => {
        if (b.status === 'CANCELLED' || b.status === 'NAO_REALIZADO') return false;
        if (b.status === 'COMPLETED' || b.status === 'FALTA') return true;
        const bookingDateTime = new Date(`${b.date.split('T')[0]}T${b.startTime}:00`);
        return bookingDateTime < now && (b.status === 'RESERVED' || b.status === 'CONFIRMED');
    });

    const isAvulso = c.type === 'FLEX' && c.durationMonths === 1;

    const daysLeft = Math.ceil((new Date(c.endDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
    const isExpiring = c.status === 'ACTIVE' && !isAvulso && daysLeft >= 0 && daysLeft <= 15;

    return (
        <div className="card" style={{ position: 'relative', overflow: 'hidden', padding: 0 }}>
            <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3, background: c.type === 'FIXO' ? 'var(--tier-sabado)' : isAvulso ? 'var(--tier-comercial)' : 'var(--tier-audiencia)' }} />

            {/* Clickable header */}
            <div style={{ padding: '20px 24px', cursor: 'pointer', transition: 'background 0.15s' }}
                onClick={onToggle}
                onMouseOver={e => e.currentTarget.style.background = 'var(--bg-card-hover)'}
                onMouseOut={e => e.currentTarget.style.background = 'transparent'}>

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '12px', marginBottom: '16px' }}>
                    <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                            {isAvulso ? (
                                <span className="badge badge-active">AVULSO</span>
                            ) : (
                                <span className={`badge ${c.type === 'FIXO' ? 'badge-confirmed' : c.type === 'CUSTOM' ? 'badge-reserved' : 'badge-reserved'}`}>
                                    {c.type === 'FIXO' ? 'Plano Fixo' : c.type === 'CUSTOM' ? 'Personalizado' : 'Plano Flex'}
                                </span>
                            )}
                            <span className={`badge badge-${c.tier.toLowerCase()}`}>{c.tier}</span>
                            {c.status === 'ACTIVE' ? (
                                isArchived ? (
                                    <span className="badge" style={{ background: 'var(--bg-elevated)', color: 'var(--text-secondary)', border: '1px solid var(--border-default)' }}>FINALIZADO</span>
                                ) : (
                                    <>
                                        <span className="badge badge-active">ATIVO</span>
                                        {isExpiring && <span className="badge" style={{ background: 'rgba(217,119,6,0.1)', color: '#f59e0b', border: '1px solid rgba(217,119,6,0.2)' }}>VENCE EM {daysLeft} DIAS</span>}
                                    </>
                                )
                            ) : c.status === 'AWAITING_PAYMENT' ? (
                                <span className="badge" style={{ background: 'rgba(217,119,6,0.1)', color: '#f59e0b', border: '1px solid rgba(217,119,6,0.2)', animation: 'pulse 2s infinite' }}>AGUARDANDO PAGAMENTO</span>
                            ) : c.status === 'PENDING_CANCELLATION' ? (
                                <span className="badge" style={{ background: '#FFF8E1', color: '#F57F17', border: '1px solid #FFE082' }}>AGUARDANDO CANCELAMENTO</span>
                            ) : c.status === 'PAUSED' ? (
                                <span className="badge badge-paused">PAUSADO</span>
                            ) : (
                                <span className="badge badge-cancelled">{c.status === 'EXPIRED' ? 'EXPIRADO' : 'CANCELADO'}</span>
                            )}
                        </div>
                        <div style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
                            {isAvulso ? (
                                <>
                                    {new Date(c.startDate).toLocaleDateString('pt-BR', { timeZone: 'UTC' })}
                                    {' · '}<strong>uma gravação</strong>
                                    {c.bookings?.[0]?.addOns && c.bookings[0].addOns.length > 0 && (
                                        <>
                                            {' · '}
                                            <span style={{ color: 'var(--accent-primary)', fontWeight: 600 }}>
                                                Inclusos: {c.bookings[0].addOns.map(ak => allAddons.find(a => a.key === ak)?.name || ak).join(', ')}
                                            </span>
                                        </>
                                    )}
                                </>
                            ) : (
                                <>
                                    {new Date(c.startDate).toLocaleDateString('pt-BR', { timeZone: 'UTC' })} — {new Date(c.endDate).toLocaleDateString('pt-BR', { timeZone: 'UTC' })}
                                    {' · '}{c.durationMonths} meses · Desconto <strong style={{ color: 'var(--tier-comercial)' }}>{c.discountPct}%</strong>
                                </>
                            )}
                        </div>
                        {c.type === 'FIXO' && (
                            <div style={{ marginTop: '6px', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                Dia fixo: <strong>{c.fixedDayOfWeek !== null && c.fixedDayOfWeek !== undefined ? DAY_NAMES[c.fixedDayOfWeek] : '—'}</strong>
                                {c.fixedTime && <> · Horário: <strong>{c.fixedTime}</strong></>}
                            </div>
                        )}
                        {c.type === 'FLEX' && !isAvulso && (
                            <div style={{ marginTop: '6px', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                Créditos: <strong>{c.flexCreditsRemaining ?? 0}</strong> restantes de <strong>{c.flexCreditsTotal ?? 0}</strong>
                            </div>
                        )}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        {c.contractUrl && (
                            <a href={c.contractUrl} target="_blank" rel="noopener noreferrer" className="btn btn-secondary btn-sm"
                                onClick={e => e.stopPropagation()}>Ver Contrato</a>
                        )}
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>▼</span>
                    </div>
                </div>

                {/* Awaiting Payment Banner */}
                {c.status === 'AWAITING_PAYMENT' && onPayContract && (
                    <AwaitingPaymentBanner
                        paymentDeadline={c.paymentDeadline || null}
                        onPay={onPayContract}
                        onExpire={onExpireContract}
                    />
                )}

                {/* Paused Banner */}
                {c.status === 'PAUSED' && (
                    <div style={{ background: 'rgba(217, 119, 6, 0.1)', border: '1px solid rgba(217, 119, 6, 0.2)', borderLeft: '3px solid #d97706', padding: '12px 16px', margin: '0 24px 16px 24px', borderRadius: 'var(--radius-sm)' }}>
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
                            <Pause size={20} style={{ color: '#f59e0b' }} />
                            <div>
                                <h4 style={{ fontSize: '0.875rem', fontWeight: 700, color: '#d97706', marginBottom: '4px' }}>Contrato Pausado</h4>
                                <p style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
                                    <strong>Motivo:</strong> {c.pauseReason || 'Não informado'}<br/>
                                    <strong>Retorno Previsto:</strong> {c.resumeDate ? new Date(c.resumeDate).toLocaleDateString('pt-BR', { timeZone: 'UTC' }) : 'Indefinido'}
                                </p>
                                <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '8px', fontStyle: 'italic' }}>
                                    Durante a pausa, novos agendamentos estão bloqueados. Retornaremos sua vigência acrescida dos dias parados.
                                </p>
                            </div>
                        </div>
                    </div>
                )}

                {/* Consumption bar or Cancelled Stats */}
                {isCancelled ? (
                    <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', padding: '12px', marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '6px' }}><div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--tier-sabado)' }} /> Gravações Realizadas</span>
                            <span style={{ fontSize: '0.875rem', fontWeight: 700 }}>{completedBookings.length}</span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '6px' }}><div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--text-muted)' }} /> Gravações Canceladas</span>
                            <span style={{ fontSize: '0.875rem', fontWeight: 700 }}>{totalBookings - completedBookings.length}</span>
                        </div>
                        <div style={{ marginTop: '4px', paddingTop: '8px', borderTop: '1px dashed var(--border-subtle)', fontSize: '0.7rem', color: 'var(--text-muted)', textAlign: 'right' }}>
                            Encerrado em: <strong>{new Date(c.endDate).toLocaleDateString('pt-BR')}</strong>
                        </div>
                    </div>
                ) : !isArchived ? (
                    <div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                            <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-secondary)' }}>Gravações</span>
                            <span style={{ fontSize: '0.75rem', fontWeight: 700 }}>{usedBookingsCount} / {totalBookings} episódios</span>
                        </div>
                        <div style={{ height: 8, borderRadius: 4, background: 'var(--bg-elevated)', overflow: 'hidden' }}>
                            <div style={{
                                height: '100%', borderRadius: 4,
                                background: usedPct >= 100 ? 'var(--status-blocked)' : 'var(--status-available)',
                                width: `${Math.min(usedPct, 100)}%`, transition: 'width 0.5s ease',
                            }} />
                        </div>
                        <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                            {totalBookings - usedBookingsCount} restantes · {usedPct}% utilizado
                        </div>
                        
                        {/* Custom Contract Addon Progress Bars */}
                        {c.addonUsage && Object.entries(c.addonUsage).map(([addonKey, usage]) => {
                            const addonName = allAddons.find(a => a.key === addonKey)?.name || addonKey;
                            const usedAddonPct = usage.limit > 0 ? Math.round((usage.used / usage.limit) * 100) : 0;
                            return (
                                <div key={addonKey} style={{ marginTop: '14px' }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                                        <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-secondary)' }}>{addonName}</span>
                                        <span style={{ fontSize: '0.75rem', fontWeight: 700 }}>{usage.used} / {usage.limit} entregues (Ciclo Atual)</span>
                                    </div>
                                    <div style={{ height: 6, borderRadius: 3, background: 'var(--bg-elevated)', overflow: 'hidden' }}>
                                        <div style={{
                                            height: '100%', borderRadius: 3,
                                            background: usedAddonPct >= 100 ? 'var(--tier-audiencia)' : 'var(--accent-primary)',
                                            width: `${Math.min(usedAddonPct, 100)}%`, transition: 'width 0.5s ease',
                                        }} />
                                    </div>
                                </div>
                            );
                        })}

                        {/* Legacy Fixed/Flex Addons */}
                        {!c.addonUsage && c.addOns?.filter(key => key !== 'GESTAO_SOCIAL').map(addonKey => {
                            const addonName = allAddons.find(a => a.key === addonKey)?.name || addonKey;
                            const usedAddonCount = bookings.filter(b => b.status !== 'NAO_REALIZADO' && b.status !== 'CANCELLED' && b.addOns?.includes(addonKey)).length;
                            const usedAddonPct = totalBookings > 0 ? Math.round((usedAddonCount / totalBookings) * 100) : 0;
                            return (
                                <div key={addonKey} style={{ marginTop: '14px' }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                                        <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-secondary)' }}>{addonName}</span>
                                        <span style={{ fontSize: '0.75rem', fontWeight: 700 }}>{usedAddonCount} / {totalBookings} entregues</span>
                                    </div>
                                    <div style={{ height: 6, borderRadius: 3, background: 'var(--bg-elevated)', overflow: 'hidden' }}>
                                        <div style={{
                                            height: '100%', borderRadius: 3,
                                            background: usedAddonPct >= 100 ? 'var(--status-blocked)' : 'var(--accent-primary)',
                                            width: `${Math.min(usedAddonPct, 100)}%`, transition: 'width 0.5s ease',
                                        }} />
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                ) : (
                    <div style={{ display: 'flex', justifyContent: 'flex-start', alignItems: 'center', marginTop: '4px' }}>
                        <span style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 500 }}>
                            Todas as gravações realizadas
                        </span>
                    </div>
                )}
            </div>

            {/* Expanded */}
            {expanded && (
                <div style={{ borderTop: '1px solid var(--border-subtle)', padding: '20px 24px', background: 'var(--bg-secondary)' }}>
                    {planConfig?.description && (
                        <div style={{ padding: '12px 16px', borderRadius: 'var(--radius-md)', background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', fontSize: '0.8125rem', color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', marginBottom: '16px' }}>
                            <div style={{ fontWeight: 700, fontSize: '0.75rem', marginBottom: '4px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Regras do Plano</div>
                            {planConfig.description}
                        </div>
                    )}

                    {/* Pending */}
                    {!isCancelled && (
                        <div style={{ marginBottom: '16px' }}>
                            <h4 style={{ fontSize: '0.8125rem', fontWeight: 700, marginBottom: '10px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                Agendamentos Realizados <span className="badge badge-reserved" style={{ fontSize: '0.65rem' }}>{pendingBookings.length}</span>
                            </h4>
                            {pendingBookings.length === 0 ? (
                                <div style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', padding: '8px 0' }}>Nenhum agendamento pendente.</div>
                            ) : (
                                <div style={{ display: 'grid', gap: '6px' }}>
                                    {pendingBookings.map(b => (
                                        <div key={b.id}
                                            onClick={() => onBookingClick(b)}
                                            style={{
                                                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                                                padding: '10px 14px', background: 'var(--bg-card)',
                                                borderRadius: 'var(--radius-md)', border: '1px solid var(--border-subtle)',
                                                fontSize: '0.8125rem', cursor: 'pointer', transition: 'border-color 0.15s',
                                            }}
                                            onMouseOver={e => e.currentTarget.style.borderColor = 'var(--tier-comercial)'}
                                            onMouseOut={e => e.currentTarget.style.borderColor = 'var(--border-subtle)'}
                                        >
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                                <span style={{ fontWeight: 700 }}>
                                                    {new Date(b.date).toLocaleDateString('pt-BR', { timeZone: 'UTC', weekday: 'short', day: '2-digit', month: '2-digit' })}
                                                </span>
                                                <span style={{ color: 'var(--text-secondary)' }}>{b.startTime} — {b.endTime}</span>
                                            </div>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                                {canModify(b) && c.status !== 'PAUSED' && <span style={{ fontSize: '0.65rem', color: 'var(--tier-audiencia)' }}>Gerenciar</span>}
                                                <span style={{ fontSize: '0.75rem' }}>{statusLabel(b.status)}</span>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}

                    {/* Completed */}
                    <div>
                        <h4 style={{ fontSize: '0.8125rem', fontWeight: 700, marginBottom: '10px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                            Gravações Realizadas <span className="badge badge-confirmed" style={{ fontSize: '0.65rem' }}>{completedBookings.length}</span>
                        </h4>
                        {completedBookings.length === 0 ? (
                            <div style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', padding: '8px 0' }}>Nenhuma gravação realizada ainda.</div>
                        ) : (
                            <div style={{ display: 'grid', gap: '6px' }}>
                                {completedBookings.map(b => (
                                    <div key={b.id}
                                        onClick={() => onBookingClick(b)}
                                        style={{
                                            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                                            padding: '10px 14px', background: 'var(--bg-card)',
                                            borderRadius: 'var(--radius-md)', border: '1px solid var(--border-subtle)',
                                            fontSize: '0.8125rem', opacity: 0.85, cursor: 'pointer',
                                        }}
                                        onMouseOver={e => e.currentTarget.style.borderColor = 'var(--tier-comercial)'}
                                        onMouseOut={e => e.currentTarget.style.borderColor = 'var(--border-subtle)'}
                                    >
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                            <span style={{ fontWeight: 700 }}>
                                                {new Date(b.date).toLocaleDateString('pt-BR', { timeZone: 'UTC', weekday: 'short', day: '2-digit', month: '2-digit' })}
                                            </span>
                                            <span style={{ color: 'var(--text-secondary)' }}>{b.startTime} — {b.endTime}</span>
                                        </div>
                                        <span style={{ fontSize: '0.75rem' }}>{statusLabel(b.status)}</span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>

                    {c.status === 'ACTIVE' && (
                        <div style={{ marginTop: '24px', paddingTop: '16px', borderTop: '1px solid var(--border-subtle)', display: 'flex', justifyContent: 'flex-end', gap: '8px', flexWrap: 'wrap' }}>
                            {isExpiring && onRenewContract && (
                                <button className="btn btn-primary" style={{ fontSize: '0.75rem', padding: '6px 12px', background: 'var(--tier-comercial)', borderColor: 'var(--tier-comercial)', boxShadow: '0 4px 12px rgba(109, 40, 217, 0.3)' }}
                                    onClick={(e) => { e.stopPropagation(); onRenewContract(); }}>
                                    Renovar Contrato
                                </button>
                            )}
                            {!isAvulso && c.status === 'ACTIVE' && onSubscribeContract && (
                                <button className="btn btn-secondary" style={{ fontSize: '0.75rem', padding: '6px 12px' }}
                                    onClick={(e) => { e.stopPropagation(); onSubscribeContract(); }}>
                                    Ativar Recorrência (Stripe)
                                </button>
                            )}
                            {c.type === 'FLEX' && (c.flexCreditsRemaining || 0) > 0 && onBulkBooking && (
                                <button className="btn btn-primary" style={{ fontSize: '0.75rem', padding: '6px 12px' }}
                                    onClick={(e) => { e.stopPropagation(); onBulkBooking(); }}>
                                    Agendar Gravações Pendentes
                                </button>
                            )}
                            {onRequestCancel && (
                                <button className="btn" style={{ background: '#FFF0F0', color: '#D32F2F', border: '1px solid #FFCDD2', fontSize: '0.75rem', padding: '6px 12px' }}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onRequestCancel(c.id, c.type === 'FIXO' ? '20% do valor correspondente aos meses/agendamentos que faltavam realizar.' : '20% do valor correspondente aos créditos não utilizados.');
                                    }}>
                                    Solicitar Cancelamento
                                </button>
                            )}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

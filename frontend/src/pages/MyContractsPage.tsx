import { getErrorMessage } from '../utils/errors';
import { useState, useEffect } from 'react';
import { contractsApi, bookingsApi, ContractWithStats, ContractBooking, pricingApi, PricingConfig, stripeApi, SavedCard } from '../api/client';
import ContractWizard from '../components/ContractWizard';
import CustomContractWizard from '../components/CustomContractWizard';
import BulkBookingModal from '../components/BulkBookingModal';
import BookingDetailModal from '../components/BookingDetailModal';
import CancelContractModal from '../components/CancelContractModal';
import SocialServiceModal from '../components/SocialServiceModal';
import SubscribeModal from '../components/SubscribeModal';
import RenewContractModal from '../components/RenewContractModal';
import { useLocation } from 'react-router-dom';
import { useUI } from '../context/UIContext';
import { FileText, Sparkles, Rocket, Plus, Pencil } from 'lucide-react';
import ContractCard from '../components/client/ContractCard';
import { formatBRL } from '../utils/format';
import { ContractsSkeleton } from '../components/ui/SkeletonLoader';
import '../styles/my-contracts.css';

const PLATFORMS = [
    { key: 'YOUTUBE', label: 'YouTube', color: '#FF0000' },
    { key: 'TIKTOK', label: 'TikTok', color: '#00F2EA' },
    { key: 'INSTAGRAM', label: 'Instagram', color: '#E1306C' },
    { key: 'FACEBOOK', label: 'Facebook', color: '#1877F2' },
];


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

    // Renew Modal
    const [showRenewModalFor, setShowRenewModalFor] = useState<ContractWithStats | null>(null);

    // Subscribe (Recurring) Modal
    const [showSubscribeModalFor, setShowSubscribeModalFor] = useState<ContractWithStats | null>(null);
    const [savedCards, setSavedCards] = useState<SavedCard[]>([]);



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
            setSocialAddon(addonsRes.addons.find((a: any) => a.key === 'GESTAO_SOCIAL') || null);
        } catch (err) { console.error('Failed to load contracts:', err); }
        finally { setLoading(false); }
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

    const handleSubscribe = async (paymentMethodId: string) => {
        if (!showSubscribeModalFor) return;
        try {
            await contractsApi.subscribe(showSubscribeModalFor.id, { paymentMethodId });
            showToast({ message: 'Cobrança automática ativada com sucesso.', type: 'success' });
            setShowSubscribeModalFor(null);
            loadData();
        } catch (err: unknown) {
            showToast({ message: getErrorMessage(err) || 'Erro ao ativar cobrança automática.', type: 'error' });
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
        try {
            await contractsApi.requestCancellation(showCancelModalFor.id);
            showToast('Cancelamento solicitado com sucesso. Os agendamentos futuros foram liberados.');
            loadData();
            setShowCancelModalFor(null);
        } catch (err: unknown) {
            showAlert({ message: 'Erro ao solicitar cancelamento: ' + getErrorMessage(err), type: 'error' });
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

    const handleSubscribeSocial = async (paymentMethod: string, durationMonths: 3 | 6) => {
        if (!socialAddon) return;
        try {
            const res = await contractsApi.createService({ serviceKey: socialAddon.key, paymentMethod: paymentMethod as any, durationMonths });
            showToast('Serviço contratado com sucesso!');
            setShowSocialModal(false);
            if (res.clientSecret) {
                showToast('Acesse "Pagamentos" para completar o pagamento com cartão.');
            }
            setTimeout(() => loadData(), 1000);
        } catch (err: unknown) {
            showAlert({ message: getErrorMessage(err) || 'Erro ao contratar serviço.', type: 'error' });
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

    if (loading) return <ContractsSkeleton />;

    return (
        <div>
            {/* ─── Hero Banner ─── */}
            <div className="client-hero client-hero--default animate-card-enter">
                <div className="client-hero__header" style={{ marginBottom: '16px' }}>
                    <div className="client-hero__icon-wrapper" style={{
                        background: 'linear-gradient(135deg, rgba(17,129,155,0.22), rgba(17,129,155,0.06))',
                        borderColor: 'rgba(17,129,155,0.25)',
                        boxShadow: '0 0 20px rgba(17,129,155,0.15)',
                        color: 'var(--accent-primary)',
                    }}>
                        <Pencil size={22} />
                    </div>
                    <div>
                        <h2 className="client-hero__greeting" style={{ margin: 0 }}>Meus Contratos</h2>
                        <p className="client-hero__message" style={{ margin: '4px 0 0 0' }}>
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
            </div>

            {/* ─── Social Service Upsell Banner ─── */}
            {socialAddon && !contracts.some(c => c.type === 'SERVICO' && c.status === 'ACTIVE' && c.addOns?.includes('GESTAO_SOCIAL')) && (
                <div className="contracts-upsell animate-card-enter" style={{ '--i': 1 } as React.CSSProperties}>
                    <div style={{ flex: '1 1 0', minWidth: 0 }}>
                        <span className="contracts-upsell__badge">Novo Serviço</span>
                        <h3 className="contracts-upsell__title">{socialAddon.name}</h3>
                        <p className="contracts-upsell__desc">
                            {socialAddon.description || 'Deixe a publicação, análise de métricas e SEO dos seus cortes com nosso time de especialistas.'}
                        </p>
                    </div>
                    <div className="contracts-upsell__cta">
                        <div className="contracts-upsell__price">
                            {formatBRL(socialAddon.price)}<span>/mês</span>
                        </div>
                        <button className="contracts-upsell__subscribe-btn" onClick={() => setShowSocialModal(true)}>
                            <Rocket size={16} /> Assinar Agora
                        </button>
                    </div>
                </div>
            )}

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
            {contractsToDisplay.length === 0 ? (
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
                        </div>
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
            <CancelContractModal
                isOpen={!!showCancelModalFor}
                feeNote={showCancelModalFor?.feeNote || ''}
                onClose={() => setShowCancelModalFor(null)}
                onConfirm={confirmCancelContract}
            />

            {/* Social Service Checkout Modal */}
            {socialAddon && (
                <SocialServiceModal
                    isOpen={showSocialModal}
                    addon={socialAddon}
                    onClose={() => setShowSocialModal(false)}
                    onConfirm={handleSubscribeSocial}
                />
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
            <SubscribeModal
                isOpen={!!showSubscribeModalFor}
                contractName={showSubscribeModalFor?.name || ''}
                contractTier={showSubscribeModalFor?.tier || ''}
                savedCards={savedCards}
                onClose={() => setShowSubscribeModalFor(null)}
                onConfirm={handleSubscribe}
            />

            {/* Renew Modal */}
            <RenewContractModal
                isOpen={!!showRenewModalFor}
                tier={showRenewModalFor?.tier || ''}
                onClose={() => setShowRenewModalFor(null)}
                onConfirm={handleRenew}
            />

        </div>
    );
}


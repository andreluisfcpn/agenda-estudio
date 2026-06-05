import { getErrorMessage } from '../utils/errors';
import { useState, useEffect, useCallback } from 'react';
import { bookingsApi, AddOnConfig } from '../api/client';
import { useUI } from '../context/UIContext';
import { useBusinessConfig } from '../hooks/useBusinessConfig';
import BottomSheetModal from './BottomSheetModal';
import PaymentModal from './PaymentModal';
import { ArrowLeft, CalendarDays, Clock, Tag, Youtube, FileText, Sparkles, Plus, Check, ChevronLeft, RefreshCw } from 'lucide-react';

function formatBRL(cents: number): string {
    return `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;
}

export interface BookingDetailData {
    id: string;
    date: string;
    startTime: string;
    endTime: string;
    tierApplied: string;
    status: string;
    price: number;
    clientNotes?: string | null;
    adminNotes?: string | null;
    platforms?: string | null;
    platformLinks?: string | null;
    addOns?: string[];
    durationMinutes?: number | null;
    peakViewers?: number | null;
    chatMessages?: number | null;
    audienceOrigin?: string | null;
    holdExpiresAt?: string | null;
}

interface BookingDetailModalProps {
    isOpen?: boolean;
    booking: BookingDetailData;
    onClose: () => void;
    onSaved: () => void;
    allAddons?: AddOnConfig[];
    contractDiscountPct?: number;
    contractAddOns?: string[];
}

function HoldBanner({ expiresAt, onExpire }: { expiresAt: string; onExpire: () => void }) {
    const [remaining, setRemaining] = useState(() => {
        const diff = new Date(expiresAt).getTime() - Date.now();
        return Math.max(0, Math.floor(diff / 1000));
    });

    useEffect(() => {
        const timer = setInterval(() => {
            const diff = new Date(expiresAt).getTime() - Date.now();
            const secs = Math.max(0, Math.floor(diff / 1000));
            setRemaining(secs);
            if (secs <= 0) { clearInterval(timer); onExpire(); }
        }, 1000);
        return () => clearInterval(timer);
    }, [expiresAt, onExpire]);

    const mins = Math.floor(remaining / 60);
    const secs = remaining % 60;
    const pct = Math.max(0, (remaining / 600) * 100);
    const color = remaining <= 60 ? '#ef4444' : remaining <= 180 ? '#f59e0b' : '#d97706';

    return (
        <div className="hold-banner">
            <div className="hold-banner__content">
                <div style={{ flex: 1 }}>
                    <div className="hold-banner__title">Aguardando Pagamento</div>
                    <p className="hold-banner__desc">
                        Complete o pagamento para confirmar. Se o tempo esgotar, o horário volta a ficar disponível.
                    </p>
                </div>
                <div className="hold-banner__timer" style={{ color }}>
                    <span>{String(mins).padStart(2, '0')}</span>
                    <span className="hold-banner__timer-sep">:</span>
                    <span>{String(secs).padStart(2, '0')}</span>
                </div>
            </div>
            <div className="hold-banner__progress">
                <div className="hold-banner__progress-fill" style={{ width: `${pct}%`, background: color }} />
            </div>
        </div>
    );
}

const ADDON_ICONS: Record<string, string> = {
    EDICAO_VIDEO: '🎬',
    CORTES_REELS: '📱',
    CAPA_YOUTUBE: '🖼️',
    GESTAO_SOCIAL: '📊',
};

function getStatusClass(s: string) {
    if (s === 'CONFIRMED' || s === 'COMPLETED') return 'confirmed';
    if (s === 'RESERVED') return 'reserved';
    if (s === 'CANCELLED') return 'cancelled';
    return 'cancelled';
}

function getStatusLabel(s: string) {
    switch (s) {
        case 'COMPLETED': return 'Concluído';
        case 'CONFIRMED': return 'Confirmado';
        case 'RESERVED': return 'Reservado';
        case 'FALTA': return 'Falta';
        case 'NAO_REALIZADO': return 'Não Realizado';
        default: return 'Cancelado';
    }
}

export default function BookingDetailModal({
    isOpen = true,
    booking,
    onClose,
    onSaved,
    allAddons = [],
    contractDiscountPct = 0,
    contractAddOns = [],
}: BookingDetailModalProps) {
    const { showAlert, showToast } = useUI();
    const { get: getRule } = useBusinessConfig();

    const [clientNotes, setClientNotes] = useState(booking.clientNotes || '');
    const [youtubeLink, setYoutubeLink] = useState(() => {
        try {
            const links = booking.platformLinks ? JSON.parse(booking.platformLinks) : {};
            return links.YOUTUBE || '';
        } catch { return ''; }
    });
    const [saving, setSaving] = useState(false);
    const [localAddOns, setLocalAddOns] = useState<string[]>(booking.addOns || []);

    // Reschedule
    const [showReschedule, setShowReschedule] = useState(false);
    const [rescheduleDate, setRescheduleDate] = useState('');
    const [rescheduleTime, setRescheduleTime] = useState('');
    const [rescheduleError, setRescheduleError] = useState('');
    const [rescheduling, setRescheduling] = useState(false);

    // Services sheet
    const [showServicesSheet, setShowServicesSheet] = useState(false);
    const [servicesStep, setServicesStep] = useState<1 | 2>(1);
    const [selectedNewAddons, setSelectedNewAddons] = useState<string[]>([]);

    // Payment
    const [payingAddon, setPayingAddon] = useState<{ paymentId: string; amount: number; description: string; addonKeys: string[] } | null>(null);

    const dateStr = booking.date.split('T')[0];

    const canModify = useCallback((): boolean => {
        if (booking.status !== 'RESERVED' && booking.status !== 'CONFIRMED') return false;
        const bookingDateTime = new Date(`${dateStr}T${booking.startTime}:00`);
        return (bookingDateTime.getTime() - Date.now()) / (1000 * 60 * 60) >= 24;
    }, [booking.status, dateStr, booking.startTime]);

    const handleSave = async () => {
        setSaving(true);
        try {
            const platforms = youtubeLink.trim() ? '["YOUTUBE"]' : '[]';
            const platformLinks = youtubeLink.trim() ? JSON.stringify({ YOUTUBE: youtubeLink.trim() }) : '{}';
            await bookingsApi.clientUpdate(booking.id, { clientNotes, platforms, platformLinks });
            showToast('Gravação atualizada!');
            onSaved();
        } catch (err: unknown) {
            showAlert({ message: getErrorMessage(err), type: 'error' });
        } finally {
            setSaving(false);
        }
    };

    const handleReschedule = async () => {
        setRescheduling(true);
        setRescheduleError('');
        try {
            await bookingsApi.reschedule(booking.id, { date: rescheduleDate, startTime: rescheduleTime });
            showToast('Reagendado com sucesso!');
            onSaved();
        } catch (err: unknown) {
            setRescheduleError(getErrorMessage(err));
        } finally {
            setRescheduling(false);
        }
    };

    // Purchase addon(s) → single batch request → open PaymentModal if needed
    const handleConfirmAddons = async () => {
        setSaving(true);
        try {
            // Send ALL selected addons in one request
            // Backend splits contract (free) vs paid and creates ONE combined payment
            const res = await bookingsApi.purchaseAddon(booking.id, selectedNewAddons);

            // Activate contract addons locally (already activated on backend)
            if (res.activatedKeys?.length > 0) {
                setLocalAddOns(prev => [...prev, ...res.activatedKeys]);
            }

            if (res.paymentId && res.amount > 0) {
                // Has paid addons → open PaymentModal
                setPayingAddon({
                    paymentId: res.paymentId,
                    amount: res.amount,
                    description: `${res.pendingKeys.length} serviço${res.pendingKeys.length > 1 ? 's' : ''} — ${formatBRL(res.amount)}`,
                    addonKeys: res.pendingKeys,
                });
            } else {
                // All were contract addons (free)
                showToast('Serviços ativados com sucesso!');
                onSaved();
            }

            setShowServicesSheet(false);
            setServicesStep(1);
            setSelectedNewAddons([]);
        } catch (err: unknown) {
            showAlert({ message: getErrorMessage(err), type: 'error' });
        } finally {
            setSaving(false);
        }
    };

    const displayDate = (() => {
        const d = new Date(dateStr + 'T12:00:00');
        return d.toLocaleDateString('pt-BR', { timeZone: 'UTC', day: '2-digit', month: 'long', year: 'numeric' });
    })();

    const episodeAddons = allAddons.filter(a => !a.monthly && a.key !== 'GESTAO_SOCIAL');
    const activeAddons = episodeAddons.filter(a => localAddOns.includes(a.key) || contractAddOns.includes(a.key));
    const availableForPurchase = episodeAddons.filter(a => !localAddOns.includes(a.key) && !contractAddOns.includes(a.key));
    const contractAvailable = episodeAddons.filter(a => contractAddOns.includes(a.key) && !localAddOns.includes(a.key));

    // Step 2 calculations
    const selectedContractItems = selectedNewAddons.filter(k => contractAddOns.includes(k));
    const selectedPaidItems = selectedNewAddons.filter(k => !contractAddOns.includes(k));
    const totalPaid = selectedPaidItems.reduce((sum, key) => {
        const addon = episodeAddons.find(a => a.key === key);
        if (!addon) return sum;
        return sum + Math.round(addon.price * (1 - contractDiscountPct / 100));
    }, 0);
    const totalSavings = selectedPaidItems.reduce((sum, key) => {
        const addon = episodeAddons.find(a => a.key === key);
        if (!addon) return sum;
        return sum + (addon.price - Math.round(addon.price * (1 - contractDiscountPct / 100)));
    }, 0);

    if (!isOpen) return null;

    return (
        <>
            {/* ═══ FULLSCREEN OVERLAY ═══ */}
            <div className="booking-fullscreen-overlay">
                <div className="bfs-container">
                    {/* Header */}
                    <div className="bfs-header">
                        <button className="bfs-header__back" onClick={onClose} aria-label="Voltar">
                            <ArrowLeft size={20} />
                        </button>
                        <h2 className="bfs-header__title">Meu Agendamento</h2>
                        <span className={`bfs-header__status bfs-header__status--${getStatusClass(booking.status)}`}>
                            {getStatusLabel(booking.status)}
                        </span>
                    </div>

                    {/* Scrollable Body */}
                    <div className="bfs-body">
                        {/* Hold Banner */}
                        {booking.holdExpiresAt && new Date(booking.holdExpiresAt).getTime() > Date.now() && (
                            <HoldBanner expiresAt={booking.holdExpiresAt} onExpire={onSaved} />
                        )}

                        {/* Info Card */}
                        <div className="bfs-info-card">
                            <div className="bfs-info-card__row">
                                <div className="bfs-info-card__icon">
                                    <CalendarDays size={20} />
                                </div>
                                <div>
                                    <div className="bfs-info-card__label">Data</div>
                                    <div className="bfs-info-card__value">{displayDate}</div>
                                </div>
                            </div>
                            <div className="bfs-info-card__divider" />
                            <div className="bfs-info-card__meta">
                                <div className="bfs-info-card__meta-item">
                                    <span className="bfs-info-card__label"><Clock size={12} style={{ display: 'inline', marginRight: 4 }} />Horário</span>
                                    <span className="bfs-info-card__value">{booking.startTime} — {booking.endTime}</span>
                                </div>
                                <div className="bfs-info-card__meta-item">
                                    <span className="bfs-info-card__label"><Tag size={12} style={{ display: 'inline', marginRight: 4 }} />Faixa</span>
                                    <span className="bfs-info-card__value">{booking.tierApplied}</span>
                                </div>
                            </div>
                        </div>

                        {/* Observação */}
                        <div className="bfs-section">
                            <div className="bfs-section__title">
                                <span className="bfs-section__title-icon" style={{ background: 'rgba(59,130,246,0.12)', color: '#60a5fa' }}>
                                    <FileText size={14} />
                                </span>
                                Observação
                            </div>
                            <textarea
                                className="form-input"
                                rows={3}
                                value={clientNotes}
                                onChange={e => setClientNotes(e.target.value)}
                                placeholder="Anotações pessoais sobre esta sessão..."
                                style={{ resize: 'vertical', borderRadius: '12px' }}
                            />
                        </div>

                        {/* Admin Notes (read-only) */}
                        {booking.adminNotes && (
                            <div className="bfs-section">
                                <div className="bfs-section__title" style={{ color: 'var(--text-muted)' }}>
                                    Observação do Estúdio
                                </div>
                                <div className="booking-modal__admin-note" style={{ borderRadius: '12px', padding: '12px 14px' }}>
                                    {booking.adminNotes}
                                </div>
                            </div>
                        )}

                        {/* YouTube Link */}
                        <div className="bfs-section">
                            <div className="bfs-section__title">
                                <span className="bfs-section__title-icon" style={{ background: 'rgba(255,0,0,0.1)', color: '#ff4444' }}>
                                    <Youtube size={14} />
                                </span>
                                Link do YouTube
                            </div>
                            <div className="bfs-youtube-input">
                                <div className="bfs-youtube-input__icon">
                                    <Youtube size={16} />
                                </div>
                                <input
                                    value={youtubeLink}
                                    onChange={e => setYoutubeLink(e.target.value)}
                                    placeholder="https://youtube.com/watch?v=..."
                                />
                            </div>
                        </div>

                        {/* Serviços */}
                        <div className="bfs-section">
                            <div className="bfs-section__title">
                                <span className="bfs-section__title-icon" style={{ background: 'rgba(16,185,129,0.12)', color: '#34d399' }}>
                                    <Sparkles size={14} />
                                </span>
                                Serviços
                            </div>

                            <div className="bfs-services-summary">
                                {activeAddons.length > 0 ? (
                                    activeAddons.map(addon => {
                                        const isContract = contractAddOns.includes(addon.key);
                                        return (
                                            <div key={addon.key} className="bfs-services-summary__item">
                                                <div className={`bfs-services-summary__icon ${isContract ? 'bfs-services-summary__icon--contract' : 'bfs-services-summary__icon--purchased'}`}>
                                                    {ADDON_ICONS[addon.key] || <Sparkles size={14} />}
                                                </div>
                                                <span className="bfs-services-summary__name">{addon.name}</span>
                                                <span className={`bfs-services-summary__badge ${isContract ? 'bfs-services-summary__badge--contract' : 'bfs-services-summary__badge--purchased'}`}>
                                                    {isContract ? 'Plano' : 'Ativo'}
                                                </span>
                                            </div>
                                        );
                                    })
                                ) : (
                                    <div className="bfs-services-summary__item" style={{ color: 'var(--text-muted)', fontSize: '0.875rem', justifyContent: 'center' }}>
                                        Nenhum serviço ativo
                                    </div>
                                )}

                                {(availableForPurchase.length > 0 || contractAvailable.length > 0) && canModify() && (
                                    <button className="bfs-services-add-btn" onClick={() => { setShowServicesSheet(true); setServicesStep(1); setSelectedNewAddons([]); }}>
                                        <Plus size={16} />
                                        Adicionar serviço
                                    </button>
                                )}
                            </div>
                        </div>

                        {/* Reschedule Panel */}
                        {showReschedule && booking.status === 'CONFIRMED' && (
                            <div className="bfs-reschedule">
                                <h4 className="bfs-reschedule__title">Reagendar</h4>
                                <p className="bfs-reschedule__note">
                                    Máx. {getRule('reschedule_max_days') || '7'} dias · Mesma faixa ({booking.tierApplied})
                                </p>
                                <div className="bfs-reschedule__form">
                                    <input type="date" className="form-input" value={rescheduleDate}
                                        onChange={e => setRescheduleDate(e.target.value)}
                                        min={new Date().toISOString().split('T')[0]}
                                        max={new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0]} />
                                    <input type="time" className="form-input" value={rescheduleTime}
                                        onChange={e => setRescheduleTime(e.target.value)} step={3600} style={{ width: 120 }} />
                                </div>
                                <button className="btn btn-primary btn-sm" onClick={handleReschedule}
                                    disabled={rescheduling || !rescheduleDate || !rescheduleTime}
                                    style={{ minHeight: 44, borderRadius: 12 }}>
                                    {rescheduling ? 'Aguarde...' : 'Confirmar Reagendamento'}
                                </button>
                                {rescheduleError && <div className="error-message">{rescheduleError}</div>}
                            </div>
                        )}
                    </div>

                    {/* Footer */}
                    <div className="bfs-footer">
                        {booking.status === 'RESERVED' && booking.holdExpiresAt && new Date(booking.holdExpiresAt).getTime() > Date.now() ? (
                            /* Awaiting payment → show pay button */
                            <button className="btn btn-primary" style={{ flex: 1 }} onClick={() => {
                                // Navigate to payment — use onSaved to trigger parent reload + payment flow
                                onClose();
                                window.location.href = `/meus-pagamentos`;
                            }}>
                                💳 Pagar Agora
                            </button>
                        ) : (
                            <>
                                {booking.status === 'CONFIRMED' && canModify() && (
                                    <button className="btn btn-secondary" onClick={() => setShowReschedule(!showReschedule)}>
                                        <RefreshCw size={16} /> Reagendar
                                    </button>
                                )}
                                <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
                                    {saving ? 'Salvando...' : 'Salvar'}
                                </button>
                            </>
                        )}
                    </div>
                </div>
            </div>

            {/* ═══ SERVICES BOTTOM SHEET ═══ */}
            <BottomSheetModal
                isOpen={showServicesSheet}
                onClose={() => { setShowServicesSheet(false); setServicesStep(1); setSelectedNewAddons([]); }}
                title={servicesStep === 1 ? 'Serviços para este Episódio' : 'Confirmação'}
                zIndex={1100}
            >
                {servicesStep === 1 ? (
                    <div className="svc-catalog">
                        {/* Contract addons */}
                        {contractAvailable.length > 0 && (
                            <>
                                <p className="svc-catalog__group-title">Inclusos no seu plano</p>
                                <div className="svc-catalog__list">
                                    {contractAvailable.map(addon => {
                                        const isSelected = selectedNewAddons.includes(addon.key);
                                        return (
                                            <div key={addon.key}
                                                className={`svc-card svc-card--contract ${isSelected ? 'svc-card--selected' : ''}`}
                                                onClick={() => setSelectedNewAddons(prev => prev.includes(addon.key) ? prev.filter(k => k !== addon.key) : [...prev, addon.key])}
                                            >
                                                <div className="svc-card__header">
                                                    <div className="svc-card__icon">{ADDON_ICONS[addon.key] || '✨'}</div>
                                                    <div className="svc-card__info">
                                                        <p className="svc-card__name">{addon.name}</p>
                                                        {addon.description && <p className="svc-card__desc">{addon.description}</p>}
                                                    </div>
                                                    <div className="svc-card__check"><Check size={14} /></div>
                                                </div>
                                                <div className="svc-card__footer">
                                                    <span className="svc-card__contract-badge">Disponível — Incluso no plano</span>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </>
                        )}

                        {/* Paid addons */}
                        {availableForPurchase.length > 0 && (
                            <>
                                <p className="svc-catalog__group-title">Serviços avulsos</p>
                                <div className="svc-catalog__list">
                                    {availableForPurchase.map(addon => {
                                        const isSelected = selectedNewAddons.includes(addon.key);
                                        const finalPrice = Math.round(addon.price * (1 - contractDiscountPct / 100));
                                        const hasDiscount = contractDiscountPct > 0;

                                        return (
                                            <div key={addon.key}
                                                className={`svc-card ${isSelected ? 'svc-card--selected' : ''}`}
                                                onClick={() => setSelectedNewAddons(prev => prev.includes(addon.key) ? prev.filter(k => k !== addon.key) : [...prev, addon.key])}
                                            >
                                                <div className="svc-card__header">
                                                    <div className="svc-card__icon">{ADDON_ICONS[addon.key] || '✨'}</div>
                                                    <div className="svc-card__info">
                                                        <p className="svc-card__name">{addon.name}</p>
                                                        {addon.description && <p className="svc-card__desc">{addon.description}</p>}
                                                    </div>
                                                    <div className="svc-card__check"><Check size={14} /></div>
                                                </div>
                                                <div className="svc-card__footer">
                                                    <div className="svc-card__price">
                                                        {hasDiscount && <span className="svc-card__price-original">{formatBRL(addon.price)}</span>}
                                                        <span className="svc-card__price-final">{formatBRL(finalPrice)}</span>
                                                        {hasDiscount && <span className="svc-card__price-discount">{contractDiscountPct}% desc.</span>}
                                                    </div>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </>
                        )}

                        {/* CTA */}
                        {selectedNewAddons.length > 0 && (
                            <div className="svc-catalog__cta">
                                <button className="btn btn-primary" onClick={() => setServicesStep(2)}>
                                    Continuar ({selectedNewAddons.length} selecionado{selectedNewAddons.length > 1 ? 's' : ''})
                                </button>
                            </div>
                        )}
                    </div>
                ) : (
                    /* ═══ STEP 2: SUMMARY ═══ */
                    <div className="svc-summary">
                        <div className="svc-summary__list">
                            {selectedNewAddons.map(key => {
                                const addon = episodeAddons.find(a => a.key === key);
                                if (!addon) return null;
                                const isContract = contractAddOns.includes(key);
                                const finalPrice = isContract ? 0 : Math.round(addon.price * (1 - contractDiscountPct / 100));
                                return (
                                    <div key={key} className="svc-summary__item">
                                        <span className="svc-summary__item-name">
                                            {ADDON_ICONS[key] || '✨'} {addon.name}
                                        </span>
                                        <span className={`svc-summary__item-price ${isContract ? 'svc-summary__item-price--free' : ''}`}>
                                            {isContract ? 'Incluso' : formatBRL(finalPrice)}
                                        </span>
                                    </div>
                                );
                            })}
                        </div>

                        {totalPaid > 0 && (
                            <div className="svc-summary__total">
                                <span className="svc-summary__total-label">Total a pagar</span>
                                <span className="svc-summary__total-value">{formatBRL(totalPaid)}</span>
                            </div>
                        )}

                        {totalSavings > 0 && (
                            <div className="svc-summary__savings">
                                Economia de {formatBRL(totalSavings)} com desconto do contrato
                            </div>
                        )}

                        <div className="svc-summary__actions">
                            <button className="btn btn-primary" onClick={handleConfirmAddons} disabled={saving}>
                                {saving ? 'Processando...' : totalPaid > 0 ? `Pagar ${formatBRL(totalPaid)}` : 'Confirmar Ativação'}
                            </button>
                            <button className="btn btn-secondary" onClick={() => setServicesStep(1)}>
                                <ChevronLeft size={16} /> Voltar ao catálogo
                            </button>
                        </div>
                    </div>
                )}
            </BottomSheetModal>

            {/* ═══ PAYMENT MODAL ═══ */}
            {payingAddon && (
                <PaymentModal
                    title="Pagar Serviço"
                    amount={payingAddon.amount}
                    paymentId={payingAddon.paymentId}
                    description={payingAddon.description}
                    allowedMethods={['CARTAO', 'PIX']}
                    onSuccess={() => {
                        // Payment confirmed! Add addons to local state
                        if (payingAddon.addonKeys) {
                            setLocalAddOns(prev => [...prev, ...payingAddon.addonKeys]);
                        }
                        setPayingAddon(null);
                        showToast('Serviço pago e ativado com sucesso!');
                        onSaved();
                    }}
                    onError={(msg) => showAlert({ message: msg, type: 'error' })}
                    onClose={() => {
                        setPayingAddon(null);
                        showToast('Pagamento não concluído. O serviço só será ativado após a confirmação do pagamento.');
                    }}
                />
            )}
        </>
    );
}

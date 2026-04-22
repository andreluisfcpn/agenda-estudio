import { getErrorMessage } from '../utils/errors';
import { useState, useEffect, useCallback } from 'react';
import { bookingsApi, AddOnConfig } from '../api/client';
import { useUI } from '../context/UIContext';
import { useBusinessConfig } from '../hooks/useBusinessConfig';
import BottomSheetModal from './BottomSheetModal';
import { CalendarDays } from 'lucide-react';

const PLATFORMS = [
    { key: 'YOUTUBE', label: '▶️ YouTube', color: '#FF0000' },
    { key: 'TIKTOK', label: '🎵 TikTok', color: '#00F2EA' },
    { key: 'INSTAGRAM', label: '📸 Instagram', color: '#E1306C' },
    { key: 'FACEBOOK', label: '📘 Facebook', color: '#1877F2' },
];

function formatBRL(cents: number): string {
    return `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;
}

/** Normalized booking shape accepted by this modal. */
export interface BookingDetailData {
    id: string;
    date: string;          // ISO string or "YYYY-MM-DD"
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
    // Metrics
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
    /** Available add-on services to display in the Serviços tab */
    allAddons?: AddOnConfig[];
    /** Discount percentage from the parent contract (for addon pricing) */
    contractDiscountPct?: number;
    /** Add-ons included at the contract level */
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
                    <div className="hold-banner__title">⏳ Aguardando Pagamento</div>
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

    // Tabs
    const [detailTab, setDetailTab] = useState<'preparativos' | 'metricas' | 'servicos'>('preparativos');

    // Editable fields
    const [clientNotes, setClientNotes] = useState(booking.clientNotes || '');
    const [platforms, setPlatforms] = useState<string[]>(() => {
        try { return booking.platforms ? JSON.parse(booking.platforms) : []; } catch { return []; }
    });
    const [platformLinks, setPlatformLinks] = useState<Record<string, string>>(() => {
        try { return booking.platformLinks ? JSON.parse(booking.platformLinks) : {}; } catch { return {}; }
    });
    const [saving, setSaving] = useState(false);

    // Reschedule
    const [showReschedule, setShowReschedule] = useState(false);
    const [rescheduleDate, setRescheduleDate] = useState('');
    const [rescheduleTime, setRescheduleTime] = useState('');
    const [rescheduleError, setRescheduleError] = useState('');
    const [rescheduling, setRescheduling] = useState(false);

    // Local optimistic addOns state
    const [localAddOns, setLocalAddOns] = useState<string[]>(booking.addOns || []);

    const togglePlatform = (key: string) => {
        setPlatforms(prev => prev.includes(key) ? prev.filter(p => p !== key) : [...prev, key]);
    };

    const dateStr = booking.date.split('T')[0];

    const canModify = useCallback((): boolean => {
        if (booking.status !== 'RESERVED' && booking.status !== 'CONFIRMED') return false;
        const bookingDateTime = new Date(`${dateStr}T${booking.startTime}:00`);
        return (bookingDateTime.getTime() - Date.now()) / (1000 * 60 * 60) >= 24;
    }, [booking.status, dateStr, booking.startTime]);

    const statusLabel = (s: string) => {
        switch (s) {
            case 'COMPLETED': return '✅ Concluído';
            case 'CONFIRMED': return '✅ Confirmado';
            case 'RESERVED': return '⏳ Reservado';
            case 'FALTA': return '❌ Falta';
            case 'NAO_REALIZADO': return '🔄 Não Realizado';
            default: return '❌ Cancelado';
        }
    };

    const handleSave = async () => {
        setSaving(true);
        try {
            await bookingsApi.clientUpdate(booking.id, {
                clientNotes,
                platforms: JSON.stringify(platforms),
                platformLinks: JSON.stringify(platformLinks),
            });
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

    const handlePurchaseAddon = async (addonKey: string) => {
        setSaving(true);
        try {
            const res = await bookingsApi.purchaseAddon(booking.id, addonKey);
            showToast(res.message);
            setLocalAddOns(prev => [...prev, addonKey]);
            onSaved();
        } catch (err: unknown) {
            showAlert({ message: getErrorMessage(err), type: 'error' });
        } finally {
            setSaving(false);
        }
    };

    const displayDate = dateStr.split('-').reverse().join('/');

    return (
        <BottomSheetModal isOpen={isOpen} onClose={onClose} title="Detalhes do Agendamento">
            <div className="booking-modal-content" style={{ padding: '0 20px 20px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
                {/* Info summary */}
                <div className="booking-modal__date" style={{ fontSize: '1.125rem', fontWeight: 700, color: 'var(--text-color)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <CalendarDays size={18} style={{ color: 'var(--primary-color)' }} />
                    {displayDate} às {booking.startTime}
                </div>
                <div className="booking-modal__info" style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                    <span className={`badge badge-${booking.tierApplied.toLowerCase()}`}>{booking.tierApplied}</span>
                    <span className="booking-modal__meta" style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>· {booking.startTime} — {booking.endTime}</span>
                    <span className="booking-modal__meta" style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>·</span>
                    <span className="booking-modal__status" style={{ fontSize: '0.875rem', fontWeight: 600 }}>{statusLabel(booking.status)}</span>
                </div>

                {/* Hold countdown banner for avulso bookings awaiting payment */}
                {booking.holdExpiresAt && new Date(booking.holdExpiresAt).getTime() > Date.now() && (
                    <HoldBanner expiresAt={booking.holdExpiresAt} onExpire={onSaved} />
                )}

                {/* TABS */}
                <div className="modal-tabs">
                    <button className={`modal-tab ${detailTab === 'preparativos' ? 'modal-tab--active' : ''}`}
                        onClick={() => setDetailTab('preparativos')}>
                        ⚙️ Preparativos
                    </button>
                    <button className={`modal-tab ${detailTab === 'metricas' ? 'modal-tab--active' : ''}`}
                        onClick={() => setDetailTab('metricas')}>
                        📊 Métricas
                    </button>
                    <button className={`modal-tab ${detailTab === 'servicos' ? 'modal-tab--active' : ''}`}
                        onClick={() => setDetailTab('servicos')}>
                        ✨ Serviços
                    </button>
                </div>

                {/* TAB: PREPARATIVOS */}
                {detailTab === 'preparativos' && (
                    <>
                        <div className="modal-section">
                            <h3 className="modal-section__title">Preparativos da Sessão</h3>
                            <p className="modal-section__desc">
                                Configure sua gravação livremente. Os dados são mantidos caso haja reagendamento.
                            </p>
                        </div>

                        <div className="form-group">
                            <label className="form-label">📝 Minha Observação</label>
                            <textarea className="form-input" rows={3} value={clientNotes}
                                onChange={e => setClientNotes(e.target.value)}
                                placeholder="Anotações pessoais..." style={{ resize: 'vertical' }} />
                        </div>

                        {booking.adminNotes && (
                            <div className="form-group">
                                <label className="form-label">🔒 Observação do Admin</label>
                                <div className="booking-modal__admin-note">
                                    {booking.adminNotes}
                                </div>
                            </div>
                        )}

                        <div className="form-group">
                            <label className="form-label">📡 Distribuição</label>
                            <div className="booking-modal__platforms">
                                {PLATFORMS.map(p => (
                                    <label key={p.key}
                                        className={`platform-toggle ${platforms.includes(p.key) ? 'platform-toggle--active' : ''}`}
                                        style={{
                                            '--platform-color': p.color,
                                            '--platform-bg': `${p.color}15`,
                                        } as React.CSSProperties}>
                                        <input type="checkbox" checked={platforms.includes(p.key)}
                                            onChange={() => togglePlatform(p.key)} style={{ accentColor: p.color }} />
                                        {p.label}
                                    </label>
                                ))}
                            </div>
                        </div>

                        {platforms.length > 0 && (
                            <div className="booking-modal__links">
                                {platforms.map(pk => {
                                    const plat = PLATFORMS.find(p => p.key === pk);
                                    return (
                                        <div key={pk} className="form-group" style={{ marginBottom: 0 }}>
                                            <label className="form-label">{plat?.label || pk} — Link</label>
                                            <input className="form-input" value={platformLinks[pk] || ''}
                                                onChange={e => setPlatformLinks(prev => ({ ...prev, [pk]: e.target.value }))}
                                                placeholder={`https://${pk.toLowerCase()}.com/...`} />
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </>
                )}

                {/* TAB: MÉTRICAS */}
                {detailTab === 'metricas' && (
                    <>
                        <div className="modal-section">
                            <h3 className="modal-section__title">Métricas de Audiência</h3>
                            <p className="modal-section__desc">
                                Visualize os resultados alcançados pelo seu episódio após a gravação.
                            </p>
                        </div>

                        {(() => {
                            const eventDate = new Date(`${dateStr}T${booking.endTime}:00`);
                            const isPast = eventDate.getTime() < Date.now();

                            if (!isPast) {
                                return (
                                    <div className="info-box info-box--neutral">
                                        🔒 As métricas não estão disponíveis pois o evento ainda não aconteceu.
                                    </div>
                                );
                            }

                            if (booking.status !== 'COMPLETED') {
                                return (
                                    <div className="info-box info-box--neutral">
                                        🔒 Métricas disponíveis para edição e visualização apenas após o status ser alterado para REALIZADA (COMPLETED).
                                    </div>
                                );
                            }

                            return (
                                <div className="metrics-grid">
                                    <div className="metric-card">
                                        <div className="metric-card__label">Duração Real</div>
                                        <div className="metric-card__value">{booking.durationMinutes ? `${booking.durationMinutes} min` : '--'}</div>
                                    </div>
                                    <div className="metric-card">
                                        <div className="metric-card__label">Pico ao Vivo</div>
                                        <div className="metric-card__value">{booking.peakViewers ? `${booking.peakViewers}` : '--'}</div>
                                    </div>
                                    <div className="metric-card">
                                        <div className="metric-card__label">Chat</div>
                                        <div className="metric-card__value">{booking.chatMessages ? `${booking.chatMessages}` : '--'}</div>
                                    </div>
                                    <div className="metric-card">
                                        <div className="metric-card__label">Origem</div>
                                        <div className="metric-card__value" style={{ fontSize: '1rem' }}>{booking.audienceOrigin || '--'}</div>
                                    </div>
                                </div>
                            );
                        })()}
                    </>
                )}

                {/* TAB: SERVIÇOS EXTRAS */}
                {detailTab === 'servicos' && (
                    <>
                        <div className="modal-section">
                            <h3 className="modal-section__title">Serviços Extras (Episódio)</h3>
                            <p className="modal-section__desc">
                                Melhore a entrega e distribuição deste episódio com nossos serviços especializados.
                            </p>
                        </div>

                        <div className="booking-modal__addons">
                            {allAddons.filter(a => !a.monthly && a.key !== 'GESTAO_SOCIAL').map(addon => {
                                const isInContract = contractAddOns.includes(addon.key);
                                const isInBooking = localAddOns.includes(addon.key);
                                const isActive = isInContract || isInBooking;
                                const finalPrice = Math.round(addon.price * (1 - contractDiscountPct / 100));

                                return (
                                    <div key={addon.key} className={`addon-card ${isActive ? 'addon-card--active' : ''}`}>
                                        <div>
                                            <div className="addon-card__name">{addon.name}</div>
                                            <div className="addon-card__desc">
                                                {isActive && isInContract
                                                    ? '✅ Incluso no seu Plano'
                                                    : isActive
                                                        ? '✅ Ativado neste Episódio'
                                                        : addon.description}
                                            </div>
                                        </div>
                                        {isActive ? (
                                            <span className="addon-card__badge">ATIVO</span>
                                        ) : (
                                            <button className="btn btn-sm btn-secondary"
                                                onClick={() => handlePurchaseAddon(addon.key)}
                                                style={{ whiteSpace: 'nowrap' }}>
                                                Adicionar por {formatBRL(finalPrice)}
                                            </button>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    </>
                )}

                {/* Reschedule Panel */}
                {showReschedule && (
                    <div className="reschedule-panel">
                        <h4 className="reschedule-panel__title">🔄 Reagendar</h4>
                        <p className="reschedule-panel__note">
                            Máx. {getRule('reschedule_max_days') || '7'} dias · Mesma faixa ({booking.tierApplied})
                        </p>
                        <div className="reschedule-panel__form">
                            <input type="date" className="form-input" value={rescheduleDate}
                                onChange={e => setRescheduleDate(e.target.value)}
                                min={new Date().toISOString().split('T')[0]}
                                max={new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0]}
                                style={{ flex: 1 }} />
                            <input type="time" className="form-input" value={rescheduleTime}
                                onChange={e => setRescheduleTime(e.target.value)} step={3600} style={{ width: 120 }} />
                            <button className="btn btn-primary btn-sm" onClick={handleReschedule}
                                disabled={rescheduling || !rescheduleDate || !rescheduleTime}>
                                {rescheduling ? '⏳' : '✅'} Confirmar
                            </button>
                        </div>
                        {rescheduleError && <div className="error-message" style={{ marginTop: 8 }}>{rescheduleError}</div>}
                    </div>
                )}

                {/* Actions */}
                <div className="modal-footer">
                    <div className="modal-footer__secondary">
                        {canModify() && (
                            <button className="btn btn-secondary btn-sm" onClick={() => setShowReschedule(!showReschedule)}>
                                🔄 Reagendar
                            </button>
                        )}
                    </div>
                    <div className="modal-footer__primary">
                        <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
                            {saving ? '⏳ Salvando...' : '💾 Salvar'}
                        </button>
                    </div>
                </div>
            </div>
        </BottomSheetModal>
    );
}

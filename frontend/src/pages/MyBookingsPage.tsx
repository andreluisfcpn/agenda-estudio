import { getErrorMessage } from '../utils/errors';
import { useState, useEffect } from 'react';
import { bookingsApi, Booking } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useUI } from '../context/UIContext';
import { Clapperboard, ChevronDown } from 'lucide-react';
import { DashboardSkeleton } from '../components/ui/SkeletonLoader';

const PLATFORMS = [
    { key: 'YOUTUBE', label: 'YouTube', color: '#FF0000' },
    { key: 'TIKTOK', label: 'TikTok', color: '#00F2EA' },
    { key: 'INSTAGRAM', label: 'Instagram', color: '#E1306C' },
    { key: 'FACEBOOK', label: 'Facebook', color: '#1877F2' },
];

export default function MyBookingsPage() {
    const { user } = useAuth();
    const [bookings, setBookings] = useState<Booking[]>([]);
    const [loading, setLoading] = useState(true);
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    
    const { showAlert, showToast } = useUI();

    // Detail state
    const [clientNotes, setClientNotes] = useState('');
    const [platforms, setPlatforms] = useState<string[]>([]);
    const [platformLinks, setPlatformLinks] = useState<Record<string, string>>({});

    // Reschedule state
    const [rescheduleId, setRescheduleId] = useState<string | null>(null);
    const [rescheduleDate, setRescheduleDate] = useState('');
    const [rescheduleTime, setRescheduleTime] = useState('');
    const [rescheduleError, setRescheduleError] = useState('');
    const [rescheduling, setRescheduling] = useState(false);

    useEffect(() => { loadBookings(); }, []);

    const loadBookings = async () => {
        setLoading(true);
        try {
            const { bookings } = await bookingsApi.getMy();
            setBookings(bookings);
        } catch (err) { console.error('Failed to load bookings:', err); }
        finally { setLoading(false); }
    };

    const expandBooking = (b: Booking) => {
        if (expandedId === b.id) {
            setExpandedId(null);
            return;
        }
        setExpandedId(b.id);
        setClientNotes(b.clientNotes || '');
        try {
            setPlatforms(b.platforms ? JSON.parse(b.platforms) : []);
        } catch { setPlatforms([]); }
        try {
            setPlatformLinks(b.platformLinks ? JSON.parse(b.platformLinks) : {});
        } catch { setPlatformLinks({}); }
    };

    const togglePlatform = (key: string) => {
        setPlatforms(prev => prev.includes(key) ? prev.filter(p => p !== key) : [...prev, key]);
    };

    const handleSave = async (bookingId: string) => {
        setSaving(true);
        try {
            await bookingsApi.clientUpdate(bookingId, {
                clientNotes,
                platforms: JSON.stringify(platforms),
                platformLinks: JSON.stringify(platformLinks),
            });
            showToast('Gravação atualizada com sucesso!');
            await loadBookings();
        } catch (err: unknown) { showAlert({ message: getErrorMessage(err), type: 'error' }); }
        finally { setSaving(false); }
    };

    const canReschedule = (b: Booking) => {
        if (b.status !== 'RESERVED' && b.status !== 'CONFIRMED') return false;
        const bookingDate = new Date(b.date);
        const [h, m] = b.startTime.split(':').map(Number);
        bookingDate.setUTCHours(h, m, 0, 0);
        const hoursUntil = (bookingDate.getTime() - Date.now()) / (1000 * 60 * 60);
        return hoursUntil >= 24;
    };

    const handleReschedule = async (bookingId: string) => {
        setRescheduling(true); setRescheduleError('');
        try {
            await bookingsApi.reschedule(bookingId, { date: rescheduleDate, startTime: rescheduleTime });
            showToast('Reagendado com sucesso!');
            setRescheduleId(null);
            await loadBookings();
        } catch (err: unknown) { setRescheduleError(getErrorMessage(err)); }
        finally { setRescheduling(false); }
    };

    const statusLabel = (status: string) => {
        switch (status) {
            case 'COMPLETED': return 'Concluído';
            case 'CONFIRMED': return 'Confirmado';
            case 'RESERVED': return '⏳ Reservado';
            case 'FALTA': return 'Falta';
            case 'NAO_REALIZADO': return 'Não Realizado';
            default: return 'Cancelado';
        }
    };

    const statusColor = (status: string) => {
        switch (status) {
            case 'COMPLETED': return 'var(--tier-comercial)';
            case 'CONFIRMED': return 'var(--tier-sabado)';
            case 'RESERVED': return 'var(--tier-audiencia)';
            default: return 'var(--text-muted)';
        }
    };

    if (loading) {
        return <DashboardSkeleton />;
    }

    const now = Date.now();
    const finalized = bookings.filter(b => {
        if (b.status !== 'COMPLETED' && b.status !== 'FALTA') return false;
        const dateStr = b.date.split('T')[0];
        const endDateTime = new Date(`${dateStr}T${b.endTime}:00`).getTime();
        return endDateTime <= now;
    });

    return (
        <div>
            {/* Hero */}
            <div className="client-hero client-hero--default animate-card-enter">
                <div className="client-hero__header client-hero__header--standalone">
                    <div className="client-hero__icon-wrapper" style={{
                        background: 'linear-gradient(135deg, rgba(59,130,246,0.2), rgba(59,130,246,0.05))',
                        borderColor: 'rgba(59,130,246,0.25)',
                        boxShadow: '0 0 20px rgba(59,130,246,0.12)',
                        color: '#3b82f6',
                    }}>
                        <Clapperboard size={22} />
                    </div>
                    <div>
                        <h1 className="client-hero__title">Minhas Gravações</h1>
                        <p className="client-hero__subtitle">Histórico de sessões · Gerencie plataformas e links</p>
                    </div>
                </div>
            </div>

            {finalized.length === 0 ? (
                <div className="bookings-list">
                    <div className="card">
                        <div className="empty-state">
                            <div className="empty-state-icon"><Clapperboard size={32} /></div>
                            <div className="empty-state-text">Nenhuma gravação realizada ainda</div>
                            <p className="booking-section-header__desc" style={{ marginTop: 8 }}>
                                Suas sessões aparecerão aqui após serem concluídas.
                            </p>
                        </div>
                    </div>
                </div>
            ) : (
                <div className="bookings-list">
                    {finalized.map((b, i) => (
                        <div key={b.id} className="card booking-card animate-card-enter" style={{ '--i': i } as React.CSSProperties}>
                            {/* Main row */}
                            <div className="booking-card__row" onClick={() => expandBooking(b)}>
                                <div className="booking-card__left">
                                    <div
                                        className="booking-card__icon"
                                        style={{ background: `var(--tier-${b.tierApplied.toLowerCase()}-bg)` }}
                                    >
                                        <Clapperboard size={20} style={{ color: `var(--tier-${b.tierApplied.toLowerCase()})` }} />
                                    </div>
                                    <div>
                                        <div className="booking-card__date">
                                            {new Date(b.date).toLocaleDateString('pt-BR', { timeZone: 'UTC', weekday: 'long', day: '2-digit', month: 'long' })}
                                        </div>
                                        <div className="booking-card__time">
                                            {b.startTime} — {b.endTime} · <span className={`badge badge-${b.tierApplied.toLowerCase()}`}>{b.tierApplied}</span>
                                        </div>
                                    </div>
                                </div>
                                <div className="booking-card__right">
                                    <span className="booking-card__status" style={{ color: statusColor(b.status) }}>
                                        {statusLabel(b.status)}
                                    </span>
                                    <ChevronDown
                                        size={16}
                                        className={`booking-card__chevron ${expandedId === b.id ? 'booking-card__chevron--open' : ''}`}
                                    />
                                </div>
                            </div>

                            {/* Expanded detail */}
                            {expandedId === b.id && (
                                <div className="booking-card__detail">
                                    {/* FASE 1 — Preparativos */}
                                    <div className="booking-section-header">
                                        <h3 className="booking-section-header__title">
                                            <span className="booking-section-header__badge">Fase 1</span>
                                            Preparativos
                                        </h3>
                                        <p className="booking-section-header__desc">Configure sua gravação livremente. Os dados são mantidos caso haja reagendamento.</p>
                                    </div>

                                    {/* Client Notes */}
                                    <div className="form-group">
                                        <label className="form-label">Minha Observação</label>
                                        <textarea
                                            className="form-input"
                                            rows={3}
                                            value={clientNotes}
                                            onChange={e => setClientNotes(e.target.value)}
                                            placeholder="Anotações pessoais sobre esta gravação..."
                                            style={{ resize: 'vertical' }}
                                        />
                                    </div>

                                    {/* Admin Notes (read-only) */}
                                    {b.adminNotes && (
                                        <div className="form-group">
                                            <label className="form-label">Observação do Admin</label>
                                            <div className="booking-modal__admin-note">
                                                {b.adminNotes}
                                            </div>
                                        </div>
                                    )}

                                    {/* Distribution - Platforms */}
                                    <div className="form-group">
                                        <label className="form-label">Distribuição</label>
                                        <div className="booking-modal__platforms">
                                            {PLATFORMS.map(p => (
                                                <label key={p.key}
                                                    className={`platform-toggle ${platforms.includes(p.key) ? 'platform-toggle--active' : ''}`}
                                                    style={{
                                                        '--platform-color': p.color,
                                                        '--platform-bg': `${p.color}15`,
                                                    } as React.CSSProperties}>
                                                    <input
                                                        type="checkbox"
                                                        checked={platforms.includes(p.key)}
                                                        onChange={() => togglePlatform(p.key)}
                                                        style={{ accentColor: p.color }}
                                                    />
                                                    {p.label}
                                                </label>
                                            ))}
                                        </div>
                                    </div>

                                    {/* Platform Links */}
                                    {platforms.length > 0 && (
                                        <div className="booking-modal__links">
                                            {platforms.map(pk => {
                                                const plat = PLATFORMS.find(p => p.key === pk);
                                                return (
                                                    <div key={pk} className="form-group" style={{ marginBottom: 0 }}>
                                                        <label className="form-label">{plat?.label || pk} — Link</label>
                                                        <input
                                                            className="form-input"
                                                            value={platformLinks[pk] || ''}
                                                            onChange={e => setPlatformLinks(prev => ({ ...prev, [pk]: e.target.value }))}
                                                            placeholder={`https://${pk.toLowerCase()}.com/...`}
                                                        />
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    )}

                                    {/* FASE 2 — Métricas */}
                                    <div className="booking-section-header">
                                        <h3 className="booking-section-header__title">
                                            <span className="booking-section-header__badge">Fase 2</span>
                                            Métricas de Audiência
                                        </h3>
                                    </div>

                                    {b.status !== 'COMPLETED' ? (
                                        <div className="info-box info-box--neutral">
                                            Métricas disponíveis apenas para gravações finalizadas (COMPLETED).
                                        </div>
                                    ) : (
                                        <div className="metrics-grid">
                                            <div className="metric-card">
                                                <div className="metric-card__label">Duração Real</div>
                                                <div className="metric-card__value">{b.durationMinutes ? `${b.durationMinutes} min` : '--'}</div>
                                            </div>
                                            <div className="metric-card">
                                                <div className="metric-card__label">Pico ao Vivo</div>
                                                <div className="metric-card__value">{b.peakViewers ? `${b.peakViewers}` : '--'}</div>
                                            </div>
                                            <div className="metric-card">
                                                <div className="metric-card__label">Chat</div>
                                                <div className="metric-card__value">{b.chatMessages ? `${b.chatMessages}` : '--'}</div>
                                            </div>
                                            <div className="metric-card">
                                                <div className="metric-card__label">Origem</div>
                                                <div className="metric-card__value" style={{ fontSize: '1rem' }}>{b.audienceOrigin || '--'}</div>
                                            </div>
                                        </div>
                                    )}

                                    {/* Actions */}
                                    <div className="booking-card__actions">
                                        <div>
                                            {canReschedule(b) && (
                                                <button className="btn btn-secondary btn-sm" onClick={(e) => { e.preventDefault(); e.stopPropagation(); setRescheduleId(rescheduleId === b.id ? null : b.id); setRescheduleError(''); }}>
                                                    Reagendar
                                                </button>
                                            )}
                                        </div>
                                        <button className="btn btn-primary btn-sm" onClick={() => handleSave(b.id)} disabled={saving}>
                                            {saving ? 'Salvando...' : 'Salvar'}
                                        </button>
                                    </div>

                                    {/* Reschedule Panel */}
                                    {rescheduleId === b.id && (
                                        <div className="reschedule-panel" style={{ marginTop: 16 }}>
                                            <h4 className="reschedule-panel__title">Reagendar Gravação</h4>
                                            <p className="reschedule-panel__note">
                                                Máximo 7 dias à frente · Mesma faixa ({b.tierApplied})
                                            </p>
                                            <div className="reschedule-panel__form">
                                                <input type="date" className="form-input" value={rescheduleDate}
                                                    onChange={e => setRescheduleDate(e.target.value)}
                                                    min={new Date().toISOString().split('T')[0]}
                                                    max={new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0]}
                                                    style={{ flex: 1 }} />
                                                <input type="time" className="form-input" value={rescheduleTime}
                                                    onChange={e => setRescheduleTime(e.target.value)} step={3600} style={{ width: 120 }} />
                                                <button className="btn btn-primary btn-sm" onClick={() => handleReschedule(b.id)}
                                                    disabled={rescheduling || !rescheduleDate || !rescheduleTime}>
                                                    Confirmar
                                                </button>
                                            </div>
                                            {rescheduleError && <div className="error-message" style={{ marginTop: 8 }}>{rescheduleError}</div>}
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

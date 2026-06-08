import { getErrorMessage } from '../utils/errors';
import HeroAmbient from '../components/client/HeroAmbient';
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { bookingsApi, pricingApi, Booking } from '../api/client';
import { useUI } from '../context/UIContext';
import { Clapperboard, ChevronDown, Sparkles, Radio, ExternalLink, CalendarDays, Eye, TrendingUp, Clock } from 'lucide-react';
import StatCard from '../components/ui/StatCard';
import Skeleton from '../components/ui/SkeletonLoader';
import StreamMetricsChart from '../components/client/StreamMetricsChart';
import { studioSlotDate } from '../utils/time';
import { PLATFORMS, PLATFORM_BY_KEY, parseStreamMetrics, parsePlatforms, parsePlatformLinks } from '../constants/platforms';

type RecTab = 'proximas' | 'realizadas';

export default function MyBookingsPage() {
    const navigate = useNavigate();
    const [bookings, setBookings] = useState<Booking[]>([]);
    const [addonNames, setAddonNames] = useState<Record<string, string>>({});
    const [loading, setLoading] = useState(true);
    const [tab, setTab] = useState<RecTab>('realizadas');
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
    useEffect(() => {
        pricingApi.getAddons()
            .then(r => setAddonNames(Object.fromEntries(r.addons.map(a => [a.key, a.name]))))
            .catch(() => {});
    }, []);

    const loadBookings = async () => {
        setLoading(true);
        try {
            const { bookings } = await bookingsApi.getMy();
            setBookings(bookings);
        } catch (err) { console.error('Failed to load bookings:', err); }
        finally { setLoading(false); }
    };

    const expandBooking = (b: Booking) => {
        if (expandedId === b.id) { setExpandedId(null); return; }
        setExpandedId(b.id);
        setRescheduleId(null);
        setClientNotes(b.clientNotes || '');
        try { setPlatforms(b.platforms ? JSON.parse(b.platforms) : []); } catch { setPlatforms([]); }
        try { setPlatformLinks(b.platformLinks ? JSON.parse(b.platformLinks) : {}); } catch { setPlatformLinks({}); }
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
        const hoursUntil = (studioSlotDate(b.date.split('T')[0], b.startTime).getTime() - Date.now()) / (1000 * 60 * 60);
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
            case 'COMPLETED': return 'Concluída';
            case 'CONFIRMED': return 'Confirmada';
            case 'RESERVED': return 'Reservada';
            case 'FALTA': return 'Falta';
            case 'NAO_REALIZADO': return 'Não realizada';
            default: return 'Cancelada';
        }
    };

    const statusColor = (status: string) => {
        switch (status) {
            case 'COMPLETED': return '#10b981';
            case 'CONFIRMED': return '#2dd4bf';
            case 'RESERVED': return '#f59e0b';
            default: return 'var(--text-muted)';
        }
    };

    // ── Split into upcoming vs finalized ──
    const nowMs = Date.now();
    const upcoming = bookings
        .filter(b => (b.status === 'RESERVED' || b.status === 'CONFIRMED')
            && studioSlotDate(b.date.split('T')[0], b.endTime).getTime() > nowMs)
        .sort((a, b) => studioSlotDate(a.date.split('T')[0], a.startTime).getTime() - studioSlotDate(b.date.split('T')[0], b.startTime).getTime());
    const finalized = bookings
        .filter(b => b.status === 'COMPLETED' || b.status === 'FALTA')
        .sort((a, b) => studioSlotDate(b.date.split('T')[0], b.startTime).getTime() - studioSlotDate(a.date.split('T')[0], a.startTime).getTime());

    // Aggregate livestream stats across completed recordings.
    const completedRecs = finalized.filter(b => b.status === 'COMPLETED');
    const agg = completedRecs.reduce((acc, b) => {
        const m = parseStreamMetrics(b.streamMetrics);
        for (const pm of Object.values(m)) {
            acc.views += Number(pm.views) || 0;
            acc.likes += Number(pm.likes) || 0;
            acc.peak = Math.max(acc.peak, Number(pm.peak) || 0);
        }
        return acc;
    }, { views: 0, likes: 0, peak: 0 });
    const fmtNum = (n: number) => n.toLocaleString('pt-BR');

    const list = tab === 'proximas' ? upcoming : finalized;

    // ── Shared recording card (used by both tabs) ──
    const renderCard = (b: Booking, i: number) => {
        const tierKey = b.tierApplied.toLowerCase();
        const isOpen = expandedId === b.id;
        const recPlatforms = parsePlatforms(b.platforms);
        return (
            <div key={b.id} className={`card booking-card animate-card-enter${isOpen ? ' booking-card--open' : ''}`} style={{ '--i': i } as React.CSSProperties}>
                {/* Main row */}
                <div className="booking-card__row" onClick={() => expandBooking(b)}>
                    <div className="booking-card__left">
                        <div className="booking-card__icon" style={{ background: `var(--tier-${tierKey}-bg)` }}>
                            <Clapperboard size={20} style={{ color: `var(--tier-${tierKey})` }} />
                        </div>
                        <div style={{ minWidth: 0 }}>
                            <div className="booking-card__date">
                                {new Date(b.date).toLocaleDateString('pt-BR', { timeZone: 'UTC', weekday: 'short', day: '2-digit', month: 'short' })}
                            </div>
                            <div className="booking-card__time">
                                {b.startTime} — {b.endTime} · <span className={`badge badge-${tierKey}`}>{b.tierApplied}</span>
                            </div>
                            {(recPlatforms.length > 0 || b.isLivestream || (b.addOns && b.addOns.length > 0)) && (
                                <div className="rec-chips">
                                    {b.isLivestream && (
                                        <span className="rec-chip rec-chip--live"><Radio size={10} /> AO VIVO</span>
                                    )}
                                    {recPlatforms.map(k => (
                                        <span key={k} className="rec-chip rec-chip--platform" style={{ background: PLATFORM_BY_KEY[k]?.color || 'var(--accent-primary)' }}>
                                            {PLATFORM_BY_KEY[k]?.label || k}
                                        </span>
                                    ))}
                                    {(b.addOns || []).map(k => (
                                        <span key={k} className="rec-chip rec-chip--addon"><Sparkles size={10} /> {addonNames[k] || k}</span>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                    <div className="booking-card__right">
                        <span className="booking-card__status" style={{ color: statusColor(b.status) }}>
                            {statusLabel(b.status)}
                        </span>
                        <ChevronDown size={16} className={`booking-card__chevron ${isOpen ? 'booking-card__chevron--open' : ''}`} />
                    </div>
                </div>

                {/* Expanded detail */}
                {isOpen && (
                    <div className="booking-card__detail">
                        {/* FASE 1 — Preparativos */}
                        <div className="booking-section-header">
                            <h3 className="booking-section-header__title">
                                <span className="booking-section-header__badge">Fase 1</span>
                                Preparativos
                            </h3>
                            <p className="booking-section-header__desc">Configure a distribuição e suas anotações. Mantidos mesmo se houver reagendamento.</p>
                        </div>

                        <div className="form-group">
                            <label className="form-label">Minha Observação</label>
                            <textarea className="form-input" rows={3} value={clientNotes}
                                onChange={e => setClientNotes(e.target.value)}
                                placeholder="Anotações pessoais sobre esta gravação..." style={{ resize: 'vertical' }} />
                        </div>

                        {b.adminNotes && (
                            <div className="form-group">
                                <label className="form-label">Observação do Admin</label>
                                <div className="booking-modal__admin-note">{b.adminNotes}</div>
                            </div>
                        )}

                        <div className="form-group">
                            <label className="form-label">Distribuição</label>
                            <div className="booking-modal__platforms">
                                {PLATFORMS.map(p => (
                                    <label key={p.key}
                                        className={`platform-toggle ${platforms.includes(p.key) ? 'platform-toggle--active' : ''}`}
                                        style={{ '--platform-color': p.color, '--platform-bg': `${p.color}15` } as React.CSSProperties}>
                                        <input type="checkbox" checked={platforms.includes(p.key)} onChange={() => togglePlatform(p.key)} style={{ accentColor: p.color }} />
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

                        {/* FASE 2 — Métricas */}
                        <div className="booking-section-header">
                            <h3 className="booking-section-header__title">
                                <span className="booking-section-header__badge">Fase 2</span>
                                Métricas de Audiência
                            </h3>
                        </div>

                        {b.status !== 'COMPLETED' ? (
                            <div className="info-box info-box--neutral">
                                As métricas aparecem aqui após a gravação ser finalizada pelo estúdio.
                            </div>
                        ) : (
                            <>
                                <div className="metrics-grid">
                                    <div className="metric-card">
                                        <div className="metric-card__label">Duração Real</div>
                                        <div className="metric-card__value">{b.durationMinutes ? `${b.durationMinutes} min` : '--'}</div>
                                    </div>
                                    <div className="metric-card">
                                        <div className="metric-card__label">Pico ao Vivo</div>
                                        <div className="metric-card__value">{b.peakViewers ? fmtNum(b.peakViewers) : '--'}</div>
                                    </div>
                                    <div className="metric-card">
                                        <div className="metric-card__label">Chat</div>
                                        <div className="metric-card__value">{b.chatMessages ? fmtNum(b.chatMessages) : '--'}</div>
                                    </div>
                                    <div className="metric-card">
                                        <div className="metric-card__label">Origem</div>
                                        <div className="metric-card__value" style={{ fontSize: '1rem' }}>{b.audienceOrigin || '--'}</div>
                                    </div>
                                </div>

                                {Object.keys(parseStreamMetrics(b.streamMetrics)).length > 0 && (
                                    <div style={{ marginTop: 18 }}>
                                        <div className="booking-section-header">
                                            <h3 className="booking-section-header__title">
                                                <Radio size={14} style={{ color: '#ef4444', marginRight: 6 }} /> Desempenho por rede
                                            </h3>
                                        </div>
                                        {(() => {
                                            const links = parsePlatformLinks(b.platformLinks);
                                            const keys = Object.keys(links).filter(k => links[k]);
                                            return keys.length > 0 ? (
                                                <div className="rec-links">
                                                    {keys.map(k => (
                                                        <a key={k} href={links[k]} target="_blank" rel="noopener noreferrer"
                                                            className="rec-link" style={{ background: PLATFORM_BY_KEY[k]?.color || 'var(--accent-primary)' }}>
                                                            {PLATFORM_BY_KEY[k]?.label || k} <ExternalLink size={12} />
                                                        </a>
                                                    ))}
                                                </div>
                                            ) : null;
                                        })()}
                                        <StreamMetricsChart streamMetrics={b.streamMetrics} />
                                    </div>
                                )}
                            </>
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
                                <p className="reschedule-panel__note">Máximo 7 dias à frente · Mesma faixa ({b.tierApplied})</p>
                                <div className="reschedule-panel__form">
                                    <input type="date" className="form-input" value={rescheduleDate}
                                        onChange={e => setRescheduleDate(e.target.value)}
                                        min={new Date().toISOString().split('T')[0]}
                                        max={new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0]} style={{ flex: 1 }} />
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
        );
    };

    return (
        <div>
            {/* Hero */}
            <div className="client-hero client-hero--default animate-card-enter">
                <HeroAmbient variant="gravacoes" />
                <div className="client-hero__header" style={{ marginBottom: '16px' }}>
                    <div className="client-hero__icon-wrapper" style={{
                        background: 'linear-gradient(135deg, rgba(139,92,246,0.2), rgba(139,92,246,0.05))',
                        borderColor: 'rgba(139,92,246,0.25)',
                        boxShadow: '0 0 20px rgba(139,92,246,0.12)',
                        color: '#8b5cf6',
                    }}>
                        <Clapperboard size={22} />
                    </div>
                    <div>
                        <h2 className="client-hero__greeting" style={{ margin: 0 }}>Minhas Gravações</h2>
                        <p className="client-hero__message" style={{ margin: '4px 0 0 0' }}>
                            {loading ? 'Carregando suas sessões…'
                                : `${finalized.length} realizada${finalized.length !== 1 ? 's' : ''} · ${upcoming.length} próxima${upcoming.length !== 1 ? 's' : ''}`}
                        </p>
                    </div>
                </div>
                <div className="client-cta-stack">
                    <button className="btn btn-primary" onClick={() => navigate('/calendar')}>
                        <CalendarDays size={16} /> Agendar gravação
                    </button>
                </div>
            </div>

            {/* Stats */}
            {!loading && (
                <div className="client-stats-grid stagger-enter">
                    <StatCard icon={Clapperboard} label="Realizadas" value={fmtNum(completedRecs.length)} accent="#8b5cf6" index={0} />
                    <StatCard icon={Clock} label="Próximas" value={fmtNum(upcoming.length)} accent="#2dd4bf" index={1} />
                    <StatCard icon={Eye} label="Visualizações" value={fmtNum(agg.views)} accent="#3b82f6" index={2} />
                    <StatCard icon={TrendingUp} label="Pico ao vivo" value={fmtNum(agg.peak)} accent="#ef4444" index={3} />
                </div>
            )}

            {/* Sub-tabs */}
            <div className="recordings-tabs" role="tablist">
                {([
                    ['proximas', 'Próximas', upcoming.length],
                    ['realizadas', 'Realizadas', finalized.length],
                ] as const).map(([key, label, count]) => (
                    <button key={key} role="tab" aria-selected={tab === key}
                        className={`recordings-tab ${tab === key ? 'recordings-tab--active' : ''}`}
                        onClick={() => { setTab(key); setExpandedId(null); }}>
                        <span className="recordings-tab__count">{count}</span>
                        <span className="recordings-tab__label">{label}</span>
                    </button>
                ))}
            </div>

            {/* Content */}
            {loading ? (
                <div className="bookings-list">
                    {[0, 1, 2].map(i => (
                        <div key={i} className="card booking-card">
                            <div className="booking-card__row" style={{ cursor: 'default' }}>
                                <div className="booking-card__left">
                                    <Skeleton variant="rounded" width={44} height={44} />
                                    <div>
                                        <Skeleton width={150} height={14} style={{ marginBottom: 6 }} />
                                        <Skeleton width={110} height={12} />
                                    </div>
                                </div>
                                <Skeleton variant="rounded" width={72} height={20} />
                            </div>
                        </div>
                    ))}
                </div>
            ) : list.length === 0 ? (
                <div className="client-empty animate-card-enter">
                    {tab === 'proximas' ? (
                        <>
                            <CalendarDays size={32} className="client-empty__icon" />
                            <div className="client-empty__text">Você não tem gravações futuras.</div>
                            <button className="btn btn-primary btn-sm" style={{ marginTop: 14 }} onClick={() => navigate('/calendar')}>
                                <CalendarDays size={15} /> Agendar agora
                            </button>
                        </>
                    ) : (
                        <>
                            <Clapperboard size={32} className="client-empty__icon" />
                            <div className="client-empty__text">Nenhuma gravação realizada ainda.</div>
                            <p className="booking-section-header__desc" style={{ marginTop: 6 }}>
                                Suas sessões aparecerão aqui com métricas após serem concluídas.
                            </p>
                        </>
                    )}
                </div>
            ) : (
                <div className="bookings-list">
                    {list.map((b, i) => renderCard(b, i))}
                </div>
            )}
        </div>
    );
}

import { useState, useEffect } from 'react';
import { bookingsApi, Booking } from '../api/client';
import { useAuth } from '../context/AuthContext';

const PLATFORMS = [
    { key: 'YOUTUBE', label: '▶️ YouTube', color: '#FF0000' },
    { key: 'TIKTOK', label: '🎵 TikTok', color: '#00F2EA' },
    { key: 'INSTAGRAM', label: '📸 Instagram', color: '#E1306C' },
    { key: 'FACEBOOK', label: '📘 Facebook', color: '#1877F2' },
];

function formatBRL(cents: number): string {
    return `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;
}

export default function MyBookingsPage() {
    const { user } = useAuth();
    const isAdmin = user?.role === 'ADMIN';
    const [bookings, setBookings] = useState<Booking[]>([]);
    const [loading, setLoading] = useState(true);
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [toast, setToast] = useState('');

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
            setToast('Gravação atualizada com sucesso!');
            setTimeout(() => setToast(''), 3000);
            await loadBookings();
        } catch (err: any) { alert(err.message); }
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
            setToast('Reagendado com sucesso!');
            setRescheduleId(null);
            setTimeout(() => setToast(''), 3000);
            await loadBookings();
        } catch (err: any) { setRescheduleError(err.message); }
        finally { setRescheduling(false); }
    };

    const statusLabel = (status: string) => {
        switch (status) {
            case 'COMPLETED': return '✅ Concluído';
            case 'CONFIRMED': return '✅ Confirmado';
            case 'RESERVED': return '⏳ Reservado';
            case 'FALTA': return '❌ Falta';
            case 'NAO_REALIZADO': return '🔄 Não Realizado';
            default: return '❌ Cancelado';
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
        return <div className="loading-spinner"><div className="spinner" /></div>;
    }

    return (
        <div>
            <div className="page-header">
                <h1 className="page-title">🎬 Minhas Gravações</h1>
                <p className="page-subtitle">Histórico de sessões finalizadas — gerencie plataformas e links</p>
            </div>

            {toast && (
                <div style={{
                    position: 'fixed', top: 24, right: 24, zIndex: 9999,
                    padding: '12px 20px', borderRadius: 'var(--radius-md)',
                    background: 'var(--tier-comercial)', color: '#fff',
                    fontWeight: 600, fontSize: '0.875rem',
                    boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
                    animation: 'slideIn 0.3s ease-out',
                }}>
                    ✅ {toast}
                </div>
            )}

            {(() => {
                const now = Date.now();
                const finalized = bookings.filter(b => {
                    // Only COMPLETED and FALTA — NAO_REALIZADO excluded (credit returned, no media)
                    if (b.status !== 'COMPLETED' && b.status !== 'FALTA') return false;
                    // Only show if session end time has passed
                    const dateStr = b.date.split('T')[0];
                    const endDateTime = new Date(`${dateStr}T${b.endTime}:00`).getTime();
                    return endDateTime <= now;
                });
                return finalized.length === 0 ? (
                    <div className="card">
                        <div className="empty-state">
                            <div className="empty-state-icon">🎤</div>
                            <div className="empty-state-text">Nenhuma gravação realizada ainda</div>
                            <p style={{ color: 'var(--text-muted)', marginTop: '8px', fontSize: '0.8125rem' }}>
                                Suas sessões aparecerão aqui após serem concluídas.
                            </p>
                        </div>
                    </div>
                ) : (
                    <div style={{ display: 'grid', gap: '12px' }}>
                        {finalized.map(b => (
                            <div key={b.id} className="card" style={{ padding: 0, overflow: 'hidden' }}>
                                {/* Main row */}
                                <div
                                    style={{
                                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                                        flexWrap: 'wrap', gap: '12px', padding: '16px 24px', cursor: 'pointer',
                                        transition: 'background 0.15s',
                                    }}
                                    onClick={() => expandBooking(b)}
                                    onMouseOver={e => e.currentTarget.style.background = 'var(--bg-card-hover)'}
                                    onMouseOut={e => e.currentTarget.style.background = 'transparent'}
                                >
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                                        <div style={{
                                            width: 48, height: 48,
                                            borderRadius: 'var(--radius-md)',
                                            background: `var(--tier-${b.tierApplied.toLowerCase()}-bg)`,
                                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                                            fontSize: '1.25rem',
                                        }}>
                                            {b.tierApplied === 'COMERCIAL' ? '🏢' : b.tierApplied === 'AUDIENCIA' ? '🎤' : '🌟'}
                                        </div>
                                        <div>
                                            <div style={{ fontWeight: 700, fontSize: '0.9375rem' }}>
                                                {new Date(b.date).toLocaleDateString('pt-BR', { timeZone: 'UTC', weekday: 'long', day: '2-digit', month: 'long' })}
                                            </div>
                                            <div style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>
                                                {b.startTime} — {b.endTime} · <span className={`badge badge-${b.tierApplied.toLowerCase()}`}>{b.tierApplied}</span>
                                            </div>
                                        </div>
                                    </div>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                                        <span style={{ fontWeight: 700, color: statusColor(b.status), fontSize: '0.8125rem' }}>
                                            {statusLabel(b.status)}
                                        </span>
                                        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', transform: expandedId === b.id ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>
                                            ▼
                                        </span>
                                    </div>
                                </div>

                                {/* Expanded detail */}
                                {expandedId === b.id && (
                                    <div style={{
                                        borderTop: '1px solid var(--border-subtle)',
                                        padding: '20px 24px',
                                        background: 'var(--bg-secondary)',
                                        animation: 'fadeIn 0.2s ease',
                                    }}>
                                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                                            {/* FASE 1 */}
                                            <div style={{ gridColumn: '1 / -1', borderBottom: '1px solid var(--border-subtle)', paddingBottom: '12px', marginBottom: '4px' }}>
                                                <h3 style={{ fontSize: '1rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '8px' }}>
                                                    <span style={{ background: 'var(--bg-elevated)', padding: '2px 8px', borderRadius: '4px', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Fase 1</span>
                                                    Preparativos
                                                </h3>
                                                <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>Configure sua gravação livremente. Os dados são mantidos caso haja reagendamento.</p>
                                            </div>

                                            {/* Client Notes */}
                                            <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                                                <label className="form-label">📝 Minha Observação</label>
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
                                                <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                                                    <label className="form-label">🔒 Observação do Admin</label>
                                                    <div style={{
                                                        padding: '10px 14px', background: 'var(--bg-elevated)',
                                                        border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)',
                                                        fontSize: '0.875rem', color: 'var(--text-secondary)',
                                                        whiteSpace: 'pre-wrap',
                                                    }}>
                                                        {b.adminNotes}
                                                    </div>
                                                </div>
                                            )}

                                            {/* Distribution - Platforms */}
                                            <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                                                <label className="form-label">📡 Distribuição</label>
                                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '4px' }}>
                                                    {PLATFORMS.map(p => (
                                                        <label
                                                            key={p.key}
                                                            style={{
                                                                display: 'flex', alignItems: 'center', gap: '6px',
                                                                padding: '6px 12px', borderRadius: 'var(--radius-md)',
                                                                border: `1px solid ${platforms.includes(p.key) ? p.color : 'var(--border-default)'}`,
                                                                background: platforms.includes(p.key) ? `${p.color}15` : 'var(--bg-card)',
                                                                cursor: 'pointer', fontSize: '0.8125rem', fontWeight: 600,
                                                                transition: 'all 0.15s',
                                                            }}
                                                        >
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
                                                <div style={{ gridColumn: '1 / -1', display: 'grid', gap: '10px' }}>
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

                                            {/* FASE 2 */}
                                            <div style={{ gridColumn: '1 / -1', borderBottom: '1px solid var(--border-subtle)', paddingBottom: '12px', marginTop: '12px', marginBottom: '4px' }}>
                                                <h3 style={{ fontSize: '1rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '8px' }}>
                                                    <span style={{ background: 'var(--bg-elevated)', padding: '2px 8px', borderRadius: '4px', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Fase 2</span>
                                                    Métricas de Audiência
                                                </h3>
                                            </div>

                                            {b.status !== 'COMPLETED' ? (
                                                <div style={{ gridColumn: '1 / -1', padding: '16px', background: 'var(--bg-elevated)', borderRadius: 'var(--radius-md)', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.875rem', marginBottom: '16px' }}>
                                                    🔒 Métricas disponíveis apenas para gravações finalizadas (COMPLETED).
                                                </div>
                                            ) : (
                                                <div style={{ gridColumn: '1 / -1', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '12px', marginBottom: '16px' }}>
                                                    <div className="card" style={{ background: 'var(--bg-card)', padding: '12px', border: '1px solid var(--border-default)' }}>
                                                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Duração Real</div>
                                                        <div style={{ fontSize: '1.25rem', fontWeight: 700 }}>{b.durationMinutes ? `${b.durationMinutes} min` : '--'}</div>
                                                    </div>
                                                    <div className="card" style={{ background: 'var(--bg-card)', padding: '12px', border: '1px solid var(--border-default)' }}>
                                                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Pico ao Vivo</div>
                                                        <div style={{ fontSize: '1.25rem', fontWeight: 700 }}>{b.peakViewers ? `${b.peakViewers}` : '--'}</div>
                                                    </div>
                                                    <div className="card" style={{ background: 'var(--bg-card)', padding: '12px', border: '1px solid var(--border-default)' }}>
                                                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Chat</div>
                                                        <div style={{ fontSize: '1.25rem', fontWeight: 700 }}>{b.chatMessages ? `${b.chatMessages}` : '--'}</div>
                                                    </div>
                                                    <div className="card" style={{ background: 'var(--bg-card)', padding: '12px', border: '1px solid var(--border-default)' }}>
                                                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Origem</div>
                                                        <div style={{ fontSize: '1rem', fontWeight: 700, marginTop: '4px' }}>{b.audienceOrigin || '--'}</div>
                                                    </div>
                                                </div>
                                            )}
                                        </div>

                                        {/* Actions */}
                                        <div style={{ display: 'flex', gap: '10px', marginTop: '16px', justifyContent: 'space-between', flexWrap: 'wrap' }}>
                                            <div style={{ display: 'flex', gap: '10px' }}>
                                                {canReschedule(b) && (
                                                    <button className="btn btn-secondary btn-sm" onClick={(e) => { e.preventDefault(); e.stopPropagation(); setRescheduleId(rescheduleId === b.id ? null : b.id); setRescheduleError(''); }}>
                                                        🔄 Reagendar
                                                    </button>
                                                )}
                                            </div>
                                            <button className="btn btn-primary btn-sm" onClick={() => handleSave(b.id)} disabled={saving}>
                                                {saving ? '⏳ Salvando...' : '💾 Salvar'}
                                            </button>
                                        </div>

                                        {/* Reschedule Panel */}
                                        {rescheduleId === b.id && (
                                            <div style={{
                                                marginTop: '16px', padding: '16px',
                                                background: 'var(--bg-card)', borderRadius: 'var(--radius-md)',
                                                border: '1px solid var(--border-default)',
                                            }}>
                                                <h4 style={{ fontSize: '0.875rem', fontWeight: 700, marginBottom: '12px' }}>🔄 Reagendar Gravação</h4>
                                                <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '12px' }}>
                                                    Máximo 7 dias à frente · Mesma faixa ({b.tierApplied})
                                                </p>
                                                <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                                                    <input
                                                        type="date"
                                                        className="form-input"
                                                        value={rescheduleDate}
                                                        onChange={e => setRescheduleDate(e.target.value)}
                                                        min={new Date().toISOString().split('T')[0]}
                                                        max={new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]}
                                                        style={{ flex: 1 }}
                                                    />
                                                    <input
                                                        type="time"
                                                        className="form-input"
                                                        value={rescheduleTime}
                                                        onChange={e => setRescheduleTime(e.target.value)}
                                                        step={3600}
                                                        style={{ width: 120 }}
                                                    />
                                                    <button
                                                        className="btn btn-primary btn-sm"
                                                        onClick={() => handleReschedule(b.id)}
                                                        disabled={rescheduling || !rescheduleDate || !rescheduleTime}
                                                    >
                                                        {rescheduling ? '⏳' : '✅'} Confirmar
                                                    </button>
                                                </div>
                                                {rescheduleError && (
                                                    <div className="error-message" style={{ marginTop: '8px' }}>{rescheduleError}</div>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                )
            })()}
        </div>
    );
}

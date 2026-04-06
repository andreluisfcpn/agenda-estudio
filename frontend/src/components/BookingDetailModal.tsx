import { useState, useCallback } from 'react';
import { bookingsApi, AddOnConfig } from '../api/client';
import { useUI } from '../context/UIContext';
import { useBusinessConfig } from '../hooks/useBusinessConfig';
import ModalOverlay from './ModalOverlay';

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
}

interface BookingDetailModalProps {
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

export default function BookingDetailModal({
    booking, onClose, onSaved,
    allAddons = [], contractDiscountPct = 0, contractAddOns = [],
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
        } catch (err: any) {
            showAlert({ message: err.message, type: 'error' });
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
        } catch (err: any) {
            setRescheduleError(err.message);
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
        } catch (err: any) {
            showAlert({ message: err.message, type: 'error' });
        } finally {
            setSaving(false);
        }
    };

    const displayDate = dateStr.split('-').reverse().join('/');

    return (
        <ModalOverlay onClose={onClose}>
            <div className="modal" style={{ maxWidth: 540 }}>
                <h2 className="modal-title">📌 Detalhes do Agendamento</h2>

                {/* Summary rows */}
                <div style={{ display: 'grid', gap: '10px', marginBottom: '16px' }}>
                    {[
                        ['📅 Data', displayDate],
                        ['🕐 Horário', `${booking.startTime} — ${booking.endTime}`],
                    ].map(([label, val]) => (
                        <div key={label} style={{
                            display: 'flex', justifyContent: 'space-between', padding: '10px 14px',
                            background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)',
                        }}>
                            <span style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>{label}</span>
                            <span style={{ fontWeight: 600 }}>{val}</span>
                        </div>
                    ))}
                    <div style={{
                        display: 'flex', justifyContent: 'space-between', padding: '10px 14px',
                        background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)',
                    }}>
                        <span style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>🏷️ Faixa</span>
                        <span className={`badge badge-${booking.tierApplied.toLowerCase()}`}>{booking.tierApplied}</span>
                    </div>
                    <div style={{
                        display: 'flex', justifyContent: 'space-between', padding: '10px 14px',
                        background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)',
                    }}>
                        <span style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>📊 Status</span>
                        <span style={{ fontWeight: 600, fontSize: '0.8125rem' }}>{statusLabel(booking.status)}</span>
                    </div>
                </div>

                {/* TABS */}
                <div style={{ display: 'flex', gap: '8px', marginBottom: '20px', borderBottom: '1px solid var(--border-subtle)', paddingBottom: '12px' }}>
                    <button className={`btn btn-sm ${detailTab === 'preparativos' ? 'btn-primary' : 'btn-secondary'}`}
                        onClick={() => setDetailTab('preparativos')} style={{ flex: 1 }}>
                        ⚙️ Preparativos
                    </button>
                    <button className={`btn btn-sm ${detailTab === 'metricas' ? 'btn-primary' : 'btn-secondary'}`}
                        onClick={() => setDetailTab('metricas')} style={{ flex: 1 }}>
                        📊 Métricas
                    </button>
                    <button className={`btn btn-sm ${detailTab === 'servicos' ? 'btn-primary' : 'btn-secondary'}`}
                        onClick={() => setDetailTab('servicos')} style={{ flex: 1 }}>
                        ✨ Serviços
                    </button>
                </div>

                {/* TAB: PREPARATIVOS */}
                {detailTab === 'preparativos' && (
                    <>
                        <div style={{ marginBottom: '16px' }}>
                            <h3 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: '4px' }}>Preparativos da Sessão</h3>
                            <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
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
                                <div style={{
                                    padding: '10px 14px', background: 'var(--bg-elevated)',
                                    border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)',
                                    fontSize: '0.875rem', color: 'var(--text-secondary)', whiteSpace: 'pre-wrap',
                                }}>
                                    {booking.adminNotes}
                                </div>
                            </div>
                        )}

                        <div className="form-group">
                            <label className="form-label">📡 Distribuição</label>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '4px' }}>
                                {PLATFORMS.map(p => (
                                    <label key={p.key} style={{
                                        display: 'flex', alignItems: 'center', gap: '6px',
                                        padding: '6px 12px', borderRadius: 'var(--radius-md)',
                                        border: `1px solid ${platforms.includes(p.key) ? p.color : 'var(--border-default)'}`,
                                        background: platforms.includes(p.key) ? `${p.color}15` : 'var(--bg-card)',
                                        cursor: 'pointer', fontSize: '0.8125rem', fontWeight: 600,
                                    }}>
                                        <input type="checkbox" checked={platforms.includes(p.key)}
                                            onChange={() => togglePlatform(p.key)} style={{ accentColor: p.color }} />
                                        {p.label}
                                    </label>
                                ))}
                            </div>
                        </div>

                        {platforms.length > 0 && (
                            <div style={{ display: 'grid', gap: '10px', marginBottom: '16px' }}>
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
                        <div style={{ marginBottom: '16px' }}>
                            <h3 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: '4px' }}>Métricas de Audiência</h3>
                            <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
                                Visualize os resultados alcançados pelo seu episódio após a gravação.
                            </p>
                        </div>

                        {(() => {
                            const eventDate = new Date(`${dateStr}T${booking.endTime}:00`);
                            const isPast = eventDate.getTime() < Date.now();

                            if (!isPast) {
                                return (
                                    <div style={{
                                        padding: '16px', background: 'var(--bg-secondary)',
                                        border: '1px dashed var(--border-subtle)', borderRadius: 'var(--radius-md)',
                                        textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.875rem', marginBottom: '16px',
                                    }}>
                                        🔒 As métricas não estão disponíveis pois o evento ainda não aconteceu.
                                    </div>
                                );
                            }

                            if (booking.status !== 'COMPLETED') {
                                return (
                                    <div style={{
                                        padding: '16px', background: 'var(--bg-secondary)',
                                        border: '1px dashed var(--border-subtle)', borderRadius: 'var(--radius-md)',
                                        textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.875rem', marginBottom: '16px',
                                    }}>
                                        🔒 Métricas disponíveis para edição e visualização apenas após o status ser alterado para REALIZADA (COMPLETED).
                                    </div>
                                );
                            }

                            return (
                                <div style={{
                                    display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
                                    gap: '12px', marginBottom: '16px',
                                }}>
                                    <div className="card" style={{ background: 'var(--bg-card)', padding: '12px', border: '1px solid var(--border-default)' }}>
                                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Duração Real</div>
                                        <div style={{ fontSize: '1.25rem', fontWeight: 700 }}>{booking.durationMinutes ? `${booking.durationMinutes} min` : '--'}</div>
                                    </div>
                                    <div className="card" style={{ background: 'var(--bg-card)', padding: '12px', border: '1px solid var(--border-default)' }}>
                                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Pico ao Vivo</div>
                                        <div style={{ fontSize: '1.25rem', fontWeight: 700 }}>{booking.peakViewers ? `${booking.peakViewers}` : '--'}</div>
                                    </div>
                                    <div className="card" style={{ background: 'var(--bg-card)', padding: '12px', border: '1px solid var(--border-default)' }}>
                                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Chat</div>
                                        <div style={{ fontSize: '1.25rem', fontWeight: 700 }}>{booking.chatMessages ? `${booking.chatMessages}` : '--'}</div>
                                    </div>
                                    <div className="card" style={{ background: 'var(--bg-card)', padding: '12px', border: '1px solid var(--border-default)' }}>
                                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Origem</div>
                                        <div style={{ fontSize: '1rem', fontWeight: 700, marginTop: '4px' }}>{booking.audienceOrigin || '--'}</div>
                                    </div>
                                </div>
                            );
                        })()}
                    </>
                )}

                {/* TAB: SERVIÇOS EXTRAS */}
                {detailTab === 'servicos' && (
                    <>
                        <div style={{ marginBottom: '16px' }}>
                            <h3 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: '4px' }}>Serviços Extras (Episódio)</h3>
                            <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
                                Melhore a entrega e distribuição deste episódio com nossos serviços especializados.
                            </p>
                        </div>

                        <div style={{ display: 'grid', gap: '12px', marginBottom: '16px' }}>
                            {allAddons.filter(a => !a.monthly && a.key !== 'GESTAO_SOCIAL').map(addon => {
                                const isInContract = contractAddOns.includes(addon.key);
                                const isInBooking = localAddOns.includes(addon.key);
                                const isActive = isInContract || isInBooking;
                                const finalPrice = Math.round(addon.price * (1 - contractDiscountPct / 100));

                                return (
                                    <div key={addon.key} style={{
                                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                                        padding: '12px 14px', borderRadius: 'var(--radius-md)',
                                        border: `2px solid ${isActive ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                                        background: isActive ? 'rgba(139, 92, 246, 0.08)' : 'var(--bg-secondary)',
                                    }}>
                                        <div>
                                            <div style={{
                                                fontWeight: 700, fontSize: '0.875rem',
                                                color: isActive ? 'var(--accent-primary)' : 'var(--text-primary)',
                                            }}>
                                                {addon.name}
                                            </div>
                                            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                                                {isActive && isInContract
                                                    ? '✅ Incluso no seu Plano'
                                                    : isActive
                                                        ? '✅ Ativado neste Episódio'
                                                        : addon.description}
                                            </div>
                                        </div>
                                        {isActive ? (
                                            <span style={{
                                                fontSize: '0.8125rem', fontWeight: 700, color: 'var(--accent-primary)',
                                                padding: '4px 8px', background: 'rgba(139, 92, 246, 0.15)', borderRadius: '4px',
                                            }}>ATIVO</span>
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
                    <div style={{
                        padding: '14px', background: 'var(--bg-elevated)', borderRadius: 'var(--radius-md)',
                        border: '1px solid var(--border-default)', marginBottom: '16px',
                    }}>
                        <h4 style={{ fontSize: '0.875rem', fontWeight: 700, marginBottom: '10px' }}>🔄 Reagendar</h4>
                        <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '12px' }}>
                            Máx. {getRule('reschedule_max_days') || '7'} dias · Mesma faixa ({booking.tierApplied})
                        </p>
                        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
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
                        {rescheduleError && <div className="error-message" style={{ marginTop: '8px' }}>{rescheduleError}</div>}
                    </div>
                )}

                {/* Actions */}
                <div className="modal-actions" style={{ justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', gap: '8px' }}>
                        {canModify() && (
                            <button className="btn btn-secondary btn-sm" onClick={() => setShowReschedule(!showReschedule)}>
                                🔄 Reagendar
                            </button>
                        )}
                    </div>
                    <div style={{ display: 'flex', gap: '8px' }}>
                        <button className="btn btn-secondary" onClick={onClose}>Fechar</button>
                        <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
                            {saving ? '⏳ Salvando...' : '💾 Salvar'}
                        </button>
                    </div>
                </div>
            </div>
        </ModalOverlay>
    );
}

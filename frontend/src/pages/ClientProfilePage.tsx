import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { usersApi, bookingsApi, UserDetail, Booking, Contract } from '../api/client';
import { useBusinessConfig } from '../hooks/useBusinessConfig';
import { HeroSkeleton, TableSkeleton } from '../components/ui/SkeletonLoader';
import StatusBadge from '../components/ui/StatusBadge';
import SavedCardItem from '../components/ui/SavedCardItem';
import ProfileHeader from '../components/admin/clients/ProfileHeader';
import ClientDataCard from '../components/admin/clients/ClientDataCard';
import ClientHealthCards from '../components/admin/clients/ClientHealthCards';
import { TIER_META, BOOKING_STATUS_META, CONTRACT_STATUS_META, CONTRACT_TYPE_META, getMeta } from '../constants/adminMeta';

import { formatBRL } from '../utils/format';

export default function ClientProfilePage() {
    const { id } = useParams<{ id: string }>();
    const navigate = useNavigate();
    const [user, setUser] = useState<UserDetail | null>(null);
    const [loading, setLoading] = useState(true);
    const [notes, setNotes] = useState('');
    const [notesSaving, setNotesSaving] = useState(false);
    const [notesSaved, setNotesSaved] = useState(false);
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const { get: getRule } = useBusinessConfig();

    // Expandable booking notes
    const [expandedBookingId, setExpandedBookingId] = useState<string | null>(null);
    const [bookingAdminNotes, setBookingAdminNotes] = useState('');
    const [bookingClientNotes, setBookingClientNotes] = useState('');
    const [bookingDuration, setBookingDuration] = useState<number | ''>('');
    const [bookingPeak, setBookingPeak] = useState<number | ''>('');
    const [bookingChat, setBookingChat] = useState<number | ''>('');
    const [bookingOrigin, setBookingOrigin] = useState('');
    const [bookingNotesSaving, setBookingNotesSaving] = useState(false);
    const [bookingNotesSaved, setBookingNotesSaved] = useState(false);

    // Admin payment overview: auto-charge, saved cards, upcoming installments.
    const [payOverview, setPayOverview] = useState<Awaited<ReturnType<typeof usersApi.paymentOverview>> | null>(null);
    const [autoSaving, setAutoSaving] = useState(false);
    useEffect(() => { if (id) loadUser(); }, [id]);

    const handleAutoCharge = async (enabled: boolean) => {
        setAutoSaving(true);
        try {
            const r = await usersApi.setAutoCharge(id!, enabled);
            setPayOverview(p => (p ? { ...p, autoChargeEnabled: r.autoChargeEnabled } : p));
        } catch (err) { console.error(err); }
        finally { setAutoSaving(false); }
    };

    const loadUser = async () => {
        setLoading(true);
        try {
            const res = await usersApi.getById(id!);
            setUser(res.user);
            setNotes(res.user.notes || '');
            usersApi.paymentOverview(id!).then(setPayOverview).catch(() => setPayOverview(null));
        } catch (err) { console.error(err); }
        finally { setLoading(false); }
    };

    const handleNotesChange = (value: string) => {
        setNotes(value);
        setNotesSaved(false);
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(async () => {
            setNotesSaving(true);
            try {
                await usersApi.update(id!, { notes: value });
                setNotesSaved(true);
                setTimeout(() => setNotesSaved(false), 2000);
            } catch (err) { console.error(err); }
            finally { setNotesSaving(false); }
        }, 1000);
    };

    const toggleBookingNotes = (b: Booking) => {
        if (expandedBookingId === b.id) {
            setExpandedBookingId(null);
        } else {
            setExpandedBookingId(b.id);
            setBookingAdminNotes(b.adminNotes || '');
            setBookingClientNotes(b.clientNotes || '');
            setBookingDuration(b.durationMinutes || '');
            setBookingPeak(b.peakViewers || '');
            setBookingChat(b.chatMessages || '');
            setBookingOrigin(b.audienceOrigin || '');
            setBookingNotesSaved(false);
        }
    };

    const saveBookingNotes = async (bookingId: string) => {
        setBookingNotesSaving(true);
        try {
            const updatePayload = {
                adminNotes: bookingAdminNotes,
                clientNotes: bookingClientNotes,
                durationMinutes: bookingDuration === '' ? null : Number(bookingDuration),
                peakViewers: bookingPeak === '' ? null : Number(bookingPeak),
                chatMessages: bookingChat === '' ? null : Number(bookingChat),
                audienceOrigin: bookingOrigin || null,
            };
            await bookingsApi.update(bookingId, updatePayload);
            // Update local state
            if (user) {
                setUser({
                    ...user,
                    bookings: user.bookings.map(b => b.id === bookingId ? { ...b, ...updatePayload } : b),
                });
            }
            setBookingNotesSaved(true);
            setTimeout(() => setBookingNotesSaved(false), 2000);
        } catch (err) { console.error(err); }
        finally { setBookingNotesSaving(false); }
    };

    if (loading) return <div><HeroSkeleton /><TableSkeleton rows={4} cols={3} /></div>;
    if (!user) return <div className="card"><div className="empty-state"><div className="empty-state-text">Usuário não encontrado</div></div></div>;

    const contractBookings = user.bookings.filter(b => b.contractId);
    const avulsoBookings = user.bookings.filter(b => !b.contractId);

    const renderBookingRow = (b: Booking) => (
        <React.Fragment key={b.id}>
            <tr style={{ cursor: 'pointer' }} onClick={() => toggleBookingNotes(b)}
                tabIndex={0} role="button" aria-expanded={expandedBookingId === b.id}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleBookingNotes(b); } }}>
                <td className="admin-card-title">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span aria-hidden="true" style={{ fontSize: '0.75rem', transform: expandedBookingId === b.id ? 'rotate(90deg)' : 'none', transition: 'transform 0.2s', display: 'inline-block' }}>▶</span>
                        {new Date(b.date).toLocaleDateString('pt-BR', { timeZone: 'UTC', weekday: 'short', day: '2-digit', month: '2-digit', year: '2-digit' })}
                    </div>
                </td>
                <td data-label="Horário" style={{ fontWeight: 600 }}>{b.startTime}–{b.endTime}</td>
                <td data-label="Faixa"><StatusBadge meta={getMeta(TIER_META, b.tierApplied)} /></td>
                <td data-label="Valor">{formatBRL(b.price)}</td>
                <td data-label="Status">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <StatusBadge meta={getMeta(BOOKING_STATUS_META, b.status)} />
                        {(b.adminNotes || b.clientNotes) && <span style={{ fontSize: '0.7rem' }} title="Possui observações">📝</span>}
                    </div>
                </td>
            </tr>
            {expandedBookingId === b.id && (
                <tr>
                    <td colSpan={5} style={{ padding: 0 }}>
                        <div style={{
                            padding: '16px', background: 'var(--bg-secondary)',
                            borderTop: '1px solid var(--border-color)', borderBottom: '1px solid var(--border-color)',
                        }}>
                            <div className="admin-grid-2" style={{ gap: '12px' }}>
                                <div>
                                    <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 700, color: 'var(--accent-text)', marginBottom: '6px' }}>
                                        🔒 Observação do Admin (somente admin)
                                    </label>
                                    <textarea
                                        className="form-input"
                                        style={{ minHeight: 80, resize: 'vertical', fontFamily: 'inherit', fontSize: '0.8125rem' }}
                                        placeholder="Anotações internas sobre esta sessão..."
                                        value={bookingAdminNotes}
                                        onChange={e => { setBookingAdminNotes(e.target.value); setBookingNotesSaved(false); }}
                                    />
                                </div>
                                <div>
                                    <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 700, color: 'var(--accent-primary)', marginBottom: '6px' }}>
                                        👁️ Observação para o Cliente (visível ao cliente)
                                    </label>
                                    <textarea
                                        className="form-input"
                                        style={{ minHeight: 80, resize: 'vertical', fontFamily: 'inherit', fontSize: '0.8125rem' }}
                                        placeholder="Feedback ou observações para o cliente ver..."
                                        value={bookingClientNotes}
                                        onChange={e => { setBookingClientNotes(e.target.value); setBookingNotesSaved(false); }}
                                    />
                                </div>
                            </div>

                            {/* NEW METRICS SECTION */}
                            {b.status === 'COMPLETED' && (
                                <div style={{ marginTop: '16px', borderTop: '1px solid var(--border-color)', paddingTop: '16px' }}>
                                    <h4 style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '12px' }}>📊 Métricas Pós-Gravação</h4>
                                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '12px' }}>
                                        <div className="form-group" style={{ marginBottom: 0 }}>
                                            <label className="form-label" style={{ fontSize: '0.75rem' }}>Duração (minutos)</label>
                                            <input type="number" className="form-input" placeholder="Ex: 120" value={bookingDuration} onChange={e => { setBookingDuration(e.target.value === '' ? '' : Number(e.target.value)); setBookingNotesSaved(false); }} />
                                        </div>
                                        <div className="form-group" style={{ marginBottom: 0 }}>
                                            <label className="form-label" style={{ fontSize: '0.75rem' }}>Pico Simultâneo</label>
                                            <input type="number" className="form-input" placeholder="Ex: 1530" value={bookingPeak} onChange={e => { setBookingPeak(e.target.value === '' ? '' : Number(e.target.value)); setBookingNotesSaved(false); }} />
                                        </div>
                                        <div className="form-group" style={{ marginBottom: 0 }}>
                                            <label className="form-label" style={{ fontSize: '0.75rem' }}>Mensagens no Chat</label>
                                            <input type="number" className="form-input" placeholder="Ex: 2400" value={bookingChat} onChange={e => { setBookingChat(e.target.value === '' ? '' : Number(e.target.value)); setBookingNotesSaved(false); }} />
                                        </div>
                                        <div className="form-group" style={{ marginBottom: 0 }}>
                                            <label className="form-label" style={{ fontSize: '0.75rem' }}>Origem de Audiência</label>
                                            <input type="text" className="form-input" placeholder="Ex: Tráfego Pago SP" value={bookingOrigin} onChange={e => { setBookingOrigin(e.target.value); setBookingNotesSaved(false); }} />
                                        </div>
                                    </div>
                                </div>
                            )}

                            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '16px', alignItems: 'center' }}>
                                {bookingNotesSaved && <span style={{ fontSize: '0.75rem', color: 'var(--tier-comercial)' }}>✓ Salvo</span>}
                                <button className="btn btn-primary btn-sm" onClick={() => saveBookingNotes(b.id)} disabled={bookingNotesSaving}>
                                    {bookingNotesSaving ? '⏳' : '💾'} Salvar Observações
                                </button>
                            </div>
                        </div>
                    </td>
                </tr>
            )}
        </React.Fragment>
    );

    return (
        <div>
            <div style={{ marginBottom: '16px' }}>
                <button className="btn btn-ghost btn-sm" onClick={() => navigate('/admin/clients')}>← Voltar para Clientes</button>
            </div>

            <ProfileHeader user={user} />

            <ClientDataCard user={user} onSaved={loadUser} />

            <ClientHealthCards user={user} />

            {/* Payment: auto-charge + saved cards + upcoming installments (admin view) */}
            {payOverview && (
                <div className="card" style={{ padding: '20px', marginBottom: '16px' }}>
                    <h2 style={{ fontSize: '1.0625rem', fontWeight: 700, marginBottom: '16px' }}>💳 Pagamento</h2>
                    <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', padding: '12px 14px', borderRadius: 'var(--radius-md)', background: payOverview.autoChargeEnabled ? 'rgba(16,185,129,0.06)' : 'var(--bg-elevated)', border: `1px solid ${payOverview.autoChargeEnabled ? 'rgba(16,185,129,0.25)' : 'var(--border-default)'}`, cursor: payOverview.hasSavedCard ? 'pointer' : 'not-allowed', opacity: payOverview.hasSavedCard ? 1 : 0.6 }}>
                        <div>
                            <div style={{ fontSize: '0.875rem', fontWeight: 600 }}>🔁 Cobrança automática</div>
                            <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', marginTop: '2px' }}>{payOverview.hasSavedCard ? 'Cobra o cartão salvo na data de vencimento.' : 'Requer um cartão salvo do cliente.'}</div>
                        </div>
                        <input type="checkbox" checked={payOverview.autoChargeEnabled} disabled={!payOverview.hasSavedCard || autoSaving} onChange={e => handleAutoCharge(e.target.checked)} style={{ width: 20, height: 20, accentColor: 'var(--success)', cursor: payOverview.hasSavedCard ? 'pointer' : 'not-allowed' }} />
                    </label>

                    <div style={{ marginTop: '14px' }}>
                        <div style={{ fontSize: '0.6875rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '8px' }}>Cartões salvos</div>
                        {payOverview.cards.length === 0 ? (
                            <div style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>Nenhum cartão salvo</div>
                        ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                {payOverview.cards.map(c => (
                                    <SavedCardItem key={c.id} card={c} />
                                ))}
                            </div>
                        )}
                    </div>

                    <div style={{ marginTop: '14px' }}>
                        <div style={{ fontSize: '0.6875rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '8px' }}>Parcelas a vencer ({payOverview.duePayments.length})</div>
                        {payOverview.duePayments.length === 0 ? (
                            <div style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>Nenhuma parcela pendente</div>
                        ) : payOverview.duePayments.slice(0, 8).map(p => (
                            <div key={p.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', padding: '8px 12px', borderRadius: 'var(--radius-sm)', background: p.overdue ? 'rgba(220,38,38,0.06)' : 'var(--bg-elevated)', border: p.overdue ? '1px solid rgba(220,38,38,0.2)' : '1px solid transparent', marginBottom: '6px' }}>
                                <div style={{ minWidth: 0 }}>
                                    <div style={{ fontSize: '0.8125rem', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.contractName}</div>
                                    <div style={{ fontSize: '0.6875rem', color: p.overdue ? 'var(--danger)' : 'var(--text-muted)' }}>{p.overdue ? '⚠️ Vencida · ' : ''}{p.dueDate ? new Date(p.dueDate).toLocaleDateString('pt-BR', { timeZone: 'UTC' }) : '—'}</div>
                                </div>
                                <span style={{ fontSize: '0.875rem', fontWeight: 700, color: p.overdue ? 'var(--danger)' : 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{formatBRL(p.amount)}</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Contracts */}
            <div className="card" style={{ padding: '20px', marginBottom: '16px' }}>
                <h2 style={{ fontSize: '1.0625rem', fontWeight: 700, marginBottom: '16px' }}>📋 Contratos ({user.contracts.length})</h2>
                {user.contracts.length === 0 ? (
                    <div style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>Nenhum contrato</div>
                ) : (
                    <div style={{ display: 'grid', gap: '12px', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
                        {user.contracts.map((c: Contract) => (
                            <div key={c.id} style={{
                                padding: '12px', borderRadius: 'var(--radius-sm)',
                                background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
                            }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                                    <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                                        <StatusBadge meta={getMeta(CONTRACT_TYPE_META, c.type)} />
                                        <StatusBadge meta={getMeta(TIER_META, c.tier)} />
                                    </div>
                                    <StatusBadge meta={getMeta(CONTRACT_STATUS_META, c.status)} />
                                </div>
                                <div style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
                                    <div>{c.durationMonths}m · {c.discountPct}% desconto · {c.durationMonths === 3 ? getRule('episodes_3months') : getRule('episodes_6months')} gravações</div>
                                    <div>{new Date(c.startDate).toLocaleDateString('pt-BR', { timeZone: 'UTC' })} → {new Date(c.endDate).toLocaleDateString('pt-BR', { timeZone: 'UTC' })}</div>
                                    {c.type === 'FLEX' && c.flexCreditsRemaining != null && (
                                        <div style={{ marginTop: '4px', fontWeight: 600, color: 'var(--accent-primary)' }}>
                                            Créditos restantes: {c.flexCreditsRemaining}/{c.flexCreditsTotal}
                                        </div>
                                    )}
                                </div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '8px', flexWrap: 'wrap' }}>
                                    <button onClick={() => navigate(`/admin/contracts/${c.id}`)}
                                        style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: '0.8125rem', fontWeight: 600, color: 'var(--accent-text)' }}>
                                        📂 Abrir contrato →
                                    </button>
                                    {c.contractUrl && (
                                        <a href={c.contractUrl} target="_blank" rel="noopener noreferrer"
                                            style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '0.8125rem', color: 'var(--accent-text)', textDecoration: 'none' }}>
                                            📄 Ver contrato digital ↗
                                        </a>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* Notes — Full Width */}
            <div className="card" style={{ padding: '20px', marginBottom: '16px' }}>
                <h2 style={{ fontSize: '1.0625rem', fontWeight: 700, marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                    📝 Observações do Cliente
                    {notesSaving && <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Salvando...</span>}
                    {notesSaved && <span style={{ fontSize: '0.75rem', color: 'var(--tier-comercial)' }}>✓ Salvo</span>}
                </h2>
                <textarea
                    className="form-input"
                    style={{ minHeight: 120, resize: 'vertical', fontFamily: 'inherit', width: '100%', boxSizing: 'border-box' }}
                    placeholder="Anotações internas sobre o cliente..."
                    value={notes}
                    onChange={e => handleNotesChange(e.target.value)}
                />
            </div>

            {/* Booking History */}
            <div>
                <h2 style={{ fontSize: '1.0625rem', fontWeight: 700, marginBottom: '16px' }}>🎵 Histórico de Agendamentos ({user.bookings.length} total)</h2>
                <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', marginBottom: '12px' }}>
                    Clique em uma sessão para adicionar observações do admin ou para o cliente.
                </p>

                {/* Contract bookings */}
                {contractBookings.length > 0 && (
                    <div className="card" style={{ marginBottom: '16px' }}>
                        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-color)', fontWeight: 600, fontSize: '0.875rem', color: 'var(--accent-primary)' }}>
                            📋 Vinculados a Contrato ({contractBookings.length})
                        </div>
                        <div className="table-container">
                            <div className="admin-table-wrap">
                                <table className="admin-table--cards">
                                    <thead><tr><th>Data</th><th>Horário</th><th>Faixa</th><th>Valor</th><th>Status</th></tr></thead>
                                    <tbody>{contractBookings.map(renderBookingRow)}</tbody>
                                </table>
                            </div>
                        </div>
                    </div>
                )}

                {/* Avulso bookings */}
                {avulsoBookings.length > 0 && (
                    <div className="card">
                        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-color)', fontWeight: 600, fontSize: '0.875rem', color: 'var(--tier-audiencia)' }}>
                            👤 Avulsos ({avulsoBookings.length})
                        </div>
                        <div className="table-container">
                            <div className="admin-table-wrap">
                                <table className="admin-table--cards">
                                    <thead><tr><th>Data</th><th>Horário</th><th>Faixa</th><th>Valor</th><th>Status</th></tr></thead>
                                    <tbody>{avulsoBookings.map(renderBookingRow)}</tbody>
                                </table>
                            </div>
                        </div>
                    </div>
                )}

                {user.bookings.length === 0 && (
                    <div className="card"><div className="empty-state"><div className="empty-state-icon">🎵</div><div className="empty-state-text">Nenhum agendamento</div></div></div>
                )}
            </div>
        </div>
    );
}

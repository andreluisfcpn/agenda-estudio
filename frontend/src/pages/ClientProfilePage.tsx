import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { usersApi, bookingsApi, UserDetail, Booking, Contract } from '../api/client';

function formatBRL(cents: number): string {
    return `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;
}

const TIER_EMOJI: Record<string, string> = { COMERCIAL: '🏢', AUDIENCIA: '🎤', SABADO: '🌟' };
const STATUS_LABELS: Record<string, string> = { COMPLETED: '✅ Concluído', CONFIRMED: '✅ Confirmado', RESERVED: '⏳ Reservado', CANCELLED: '❌ Cancelado', FALTA: '❌ Falta', NAO_REALIZADO: '🔄 Não Realizado' };

export default function ClientProfilePage() {
    const { id } = useParams<{ id: string }>();
    const navigate = useNavigate();
    const [user, setUser] = useState<UserDetail | null>(null);
    const [loading, setLoading] = useState(true);
    const [notes, setNotes] = useState('');
    const [notesSaving, setNotesSaving] = useState(false);
    const [notesSaved, setNotesSaved] = useState(false);
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

    useEffect(() => { if (id) loadUser(); }, [id]);

    const loadUser = async () => {
        setLoading(true);
        try {
            const res = await usersApi.getById(id!);
            setUser(res.user);
            setNotes(res.user.notes || '');
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

    if (loading) return <div className="loading-spinner"><div className="spinner" /></div>;
    if (!user) return <div className="card"><div className="empty-state"><div className="empty-state-text">Usuário não encontrado</div></div></div>;

    const contractBookings = user.bookings.filter(b => b.contractId);
    const avulsoBookings = user.bookings.filter(b => !b.contractId);

    const ROLE_LABELS: Record<string, string> = { ADMIN: '🛡️ Administrador', CLIENTE: '👤 Cliente' };

    const renderBookingRow = (b: Booking) => (
        <React.Fragment key={b.id}>
            <tr style={{ cursor: 'pointer' }} onClick={() => toggleBookingNotes(b)}>
                <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span style={{ fontSize: '0.75rem', transform: expandedBookingId === b.id ? 'rotate(90deg)' : 'none', transition: 'transform 0.2s' }}>▶</span>
                        {new Date(b.date).toLocaleDateString('pt-BR', { timeZone: 'UTC', weekday: 'short', day: '2-digit', month: '2-digit', year: '2-digit' })}
                    </div>
                </td>
                <td style={{ fontWeight: 600 }}>{b.startTime}–{b.endTime}</td>
                <td><span className={`badge badge-${b.tierApplied.toLowerCase()}`}>{TIER_EMOJI[b.tierApplied]} {b.tierApplied}</span></td>
                <td>{formatBRL(b.price)}</td>
                <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span className={`badge badge-${b.status.toLowerCase()}`}>{STATUS_LABELS[b.status]}</span>
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
                            <div style={{ display: 'grid', gap: '12px', gridTemplateColumns: '1fr 1fr' }}>
                                <div>
                                    <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 700, color: 'var(--tier-audiencia)', marginBottom: '6px' }}>
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

            {/* Header */}
            <div className="card" style={{ padding: '24px', marginBottom: '16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
                    <div style={{
                        width: 64, height: 64, borderRadius: '50%',
                        background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-secondary))',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: '1.5rem', fontWeight: 700, color: '#fff',
                    }}>
                        {user.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()}
                    </div>
                    <div style={{ flex: 1 }}>
                        <h1 style={{ fontSize: '1.5rem', fontWeight: 700, margin: 0 }}>{user.name}</h1>
                        <div style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginTop: '4px' }}>
                            {user.email} · {user.phone || 'Sem telefone'}
                        </div>
                        <div style={{ marginTop: '8px' }}>
                            <span className={`badge ${user.role === 'ADMIN' ? 'badge-sabado' : 'badge-comercial'}`}>
                                {ROLE_LABELS[user.role]}
                            </span>
                            <span style={{ marginLeft: '8px', color: 'var(--text-muted)', fontSize: '0.75rem' }}>
                                Cadastro: {new Date(user.createdAt).toLocaleDateString('pt-BR', { timeZone: 'UTC' })}
                            </span>
                        </div>
                    </div>
                </div>
            </div>

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
                                        <span className={`badge ${c.type === 'FIXO' ? 'badge-confirmed' : 'badge-reserved'}`}>{c.type === 'FIXO' ? '📌 Fixo' : '🔄 Flex'}</span>
                                        <span className={`badge badge-${c.tier.toLowerCase()}`}>{TIER_EMOJI[c.tier]} {c.tier}</span>
                                    </div>
                                    <span className={`badge badge-${c.status.toLowerCase()}`}>{c.status}</span>
                                </div>
                                <div style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
                                    <div>{c.durationMonths}m · {c.discountPct}% desconto · {c.durationMonths === 3 ? '12' : '24'} gravações</div>
                                    <div>{new Date(c.startDate).toLocaleDateString('pt-BR', { timeZone: 'UTC' })} → {new Date(c.endDate).toLocaleDateString('pt-BR', { timeZone: 'UTC' })}</div>
                                    {c.type === 'FLEX' && c.flexCreditsRemaining != null && (
                                        <div style={{ marginTop: '4px', fontWeight: 600, color: 'var(--accent-primary)' }}>
                                            Créditos restantes: {c.flexCreditsRemaining}/{c.flexCreditsTotal}
                                        </div>
                                    )}
                                </div>
                                {c.contractUrl && (
                                    <a href={c.contractUrl} target="_blank" rel="noopener noreferrer"
                                        style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', marginTop: '8px', fontSize: '0.8125rem', color: 'var(--accent-primary)', textDecoration: 'none' }}>
                                        📄 Ver contrato digital ↗
                                    </a>
                                )}
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
                            <table>
                                <thead><tr><th>Data</th><th>Horário</th><th>Faixa</th><th>Valor</th><th>Status</th></tr></thead>
                                <tbody>{contractBookings.map(renderBookingRow)}</tbody>
                            </table>
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
                            <table>
                                <thead><tr><th>Data</th><th>Horário</th><th>Faixa</th><th>Valor</th><th>Status</th></tr></thead>
                                <tbody>{avulsoBookings.map(renderBookingRow)}</tbody>
                            </table>
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

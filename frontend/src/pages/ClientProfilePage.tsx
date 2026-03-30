import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { usersApi, bookingsApi, UserDetail, Booking, Contract } from '../api/client';
import { useBusinessConfig } from '../hooks/useBusinessConfig';

function formatBRL(cents: number): string {
    return `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;
}

const TIER_EMOJI: Record<string, string> = { COMERCIAL: '🏢', AUDIENCIA: '🎤', SABADO: '🌟' };
const STATUS_LABELS: Record<string, string> = { COMPLETED: '✅ Concluído', CONFIRMED: '✅ Confirmado', RESERVED: '⏳ Reservado', CANCELLED: '❌ Cancelado', FALTA: '❌ Falta', NAO_REALIZADO: '🔄 Não Realizado' };

// ── Inline-edit field ───────────────────────────────
function FieldItem({ label, value, field, userId, onSaved }: { label: string; value: string | null; field: string; userId: string; onSaved: () => void }) {
    const [editing, setEditing] = useState(false);
    const [val, setVal] = useState(value || '');
    useEffect(() => setVal(value || ''), [value]);
    const save = async () => {
        setEditing(false);
        if (val !== (value || '')) { try { await usersApi.update(userId, { [field]: val || null } as any); onSaved(); } catch {} }
    };
    return (
        <div>
            <div style={{ fontSize: '0.6875rem', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: '4px' }}>{label}</div>
            {editing ? (
                <input className="form-input" value={val} onChange={e => setVal(e.target.value)} onBlur={save} onKeyDown={e => e.key === 'Enter' && save()} autoFocus
                    style={{ fontSize: '0.8125rem', padding: '6px 8px' }} />
            ) : (
                <div onClick={() => setEditing(true)} style={{ cursor: 'pointer', fontSize: '0.8125rem', padding: '6px 8px', borderRadius: 'var(--radius-sm)', border: '1px dashed var(--border-color)', minHeight: '32px', color: val ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                    {val || 'Clique para editar'}
                </div>
            )}
        </div>
    );
}

// ── Tags editor ─────────────────────────────────────
function TagsEditor({ tags, userId, onSaved }: { tags: string[]; userId: string; onSaved: () => void }) {
    const [newTag, setNewTag] = useState('');
    const addTag = async () => {
        const t = newTag.trim().toLowerCase();
        if (!t || tags.includes(t)) { setNewTag(''); return; }
        try { await usersApi.update(userId, { tags: [...tags, t] } as any); setNewTag(''); onSaved(); } catch {}
    };
    const removeTag = async (tag: string) => {
        try { await usersApi.update(userId, { tags: tags.filter(t => t !== tag) } as any); onSaved(); } catch {}
    };
    return (
        <div>
            <div style={{ fontSize: '0.6875rem', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: '4px' }}>Tags</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', alignItems: 'center' }}>
                {tags.map(t => (
                    <span key={t} style={{ fontSize: '0.6875rem', padding: '2px 8px', borderRadius: '999px', background: 'rgba(99,102,241,0.15)', color: '#818cf8', display: 'flex', alignItems: 'center', gap: '4px' }}>
                        #{t} <span onClick={() => removeTag(t)} style={{ cursor: 'pointer', opacity: 0.6 }}>✕</span>
                    </span>
                ))}
                <input placeholder="+ tag" value={newTag} onChange={e => setNewTag(e.target.value)} onKeyDown={e => e.key === 'Enter' && addTag()} onBlur={addTag}
                    style={{ width: '70px', background: 'transparent', border: 'none', outline: 'none', color: 'var(--text-primary)', fontSize: '0.75rem' }} />
            </div>
        </div>
    );
}

// ── Social links editor ─────────────────────────────
function SocialLinksEditor({ socialLinks, userId, onSaved }: { socialLinks: string | null; userId: string; onSaved: () => void }) {
    const parsed: Record<string, string> = socialLinks ? (function() { try { return JSON.parse(socialLinks); } catch { return {}; } })() : {};
    const [editing, setEditing] = useState(false);
    const [links, setLinks] = useState(parsed);
    useEffect(() => { setLinks(socialLinks ? (function() { try { return JSON.parse(socialLinks); } catch { return {}; } })() : {}); }, [socialLinks]);
    const save = async () => {
        setEditing(false);
        const clean = Object.fromEntries(Object.entries(links).filter(([, v]) => v.trim()));
        try { await usersApi.update(userId, { socialLinks: Object.keys(clean).length ? JSON.stringify(clean) : null } as any); onSaved(); } catch {}
    };
    const socials = [{ key: 'youtube', label: 'YouTube', icon: '📺' }, { key: 'instagram', label: 'Instagram', icon: '📷' }, { key: 'spotify', label: 'Spotify', icon: '🎧' }, { key: 'website', label: 'Site', icon: '🌐' }];
    return (
        <div style={{ gridColumn: 'span 2' }}>
            <div style={{ fontSize: '0.6875rem', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: '4px' }}>Redes Sociais</div>
            {editing ? (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '6px' }}>
                    {socials.map(s => (
                        <input key={s.key} className="form-input" placeholder={`${s.icon} ${s.label}`} value={links[s.key] || ''}
                            onChange={e => setLinks({ ...links, [s.key]: e.target.value })}
                            style={{ fontSize: '0.75rem', padding: '6px 8px' }} />
                    ))}
                    <div style={{ display: 'flex', gap: '6px' }}>
                        <button className="btn btn-primary btn-sm" onClick={save}>Salvar</button>
                        <button className="btn btn-ghost btn-sm" onClick={() => { setEditing(false); setLinks(parsed); }}>Cancelar</button>
                    </div>
                </div>
            ) : (
                <div onClick={() => setEditing(true)} style={{ cursor: 'pointer', display: 'flex', flexWrap: 'wrap', gap: '8px', minHeight: '32px', alignItems: 'center', padding: '6px 8px', borderRadius: 'var(--radius-sm)', border: '1px dashed var(--border-color)' }}>
                    {Object.entries(parsed).length > 0 ? Object.entries(parsed).map(([k, v]) => (
                        <a key={k} href={v} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} style={{ fontSize: '0.75rem', color: 'var(--accent-primary)', textDecoration: 'underline' }}>
                            {socials.find(s => s.key === k)?.icon} {socials.find(s => s.key === k)?.label || k}
                        </a>
                    )) : <span style={{ color: 'var(--text-muted)', fontSize: '0.8125rem' }}>Clique para adicionar</span>}
                </div>
            )}
        </div>
    );
}

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
                    {user.photoUrl ? (
                        <img src={user.photoUrl} alt={user.name} style={{
                            width: 64, height: 64, borderRadius: '50%', objectFit: 'cover',
                            border: '2px solid var(--accent-primary)',
                        }} />
                    ) : (
                    <div style={{
                        width: 64, height: 64, borderRadius: '50%',
                        background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-secondary))',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: '1.5rem', fontWeight: 700, color: '#fff',
                    }}>
                        {user.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()}
                    </div>
                    )}
                    <div style={{ flex: 1 }}>
                        <h1 style={{ fontSize: '1.5rem', fontWeight: 700, margin: 0 }}>{user.name}</h1>
                        <div style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginTop: '4px' }}>
                            {user.email} · {user.phone || 'Sem telefone'}
                            {user.cpfCnpj && <> · <span style={{ fontFamily: 'monospace' }}>{user.cpfCnpj}</span></>}
                        </div>
                        <div style={{ marginTop: '8px', display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
                            <span className={`badge ${user.role === 'ADMIN' ? 'badge-sabado' : 'badge-comercial'}`}>
                                {ROLE_LABELS[user.role]}
                            </span>
                            <span className="badge" style={{
                                background: user.clientStatus === 'ACTIVE' ? 'rgba(16,185,129,0.15)' : user.clientStatus === 'BLOCKED' ? 'rgba(220,38,38,0.15)' : 'rgba(107,114,128,0.15)',
                                color: user.clientStatus === 'ACTIVE' ? '#10b981' : user.clientStatus === 'BLOCKED' ? '#dc2626' : '#6b7280',
                            }}>
                                {user.clientStatus === 'ACTIVE' ? '● Ativo' : user.clientStatus === 'BLOCKED' ? '● Bloqueado' : '● Inativo'}
                            </span>
                            {user.tags?.map((t: string) => (
                                <span key={t} style={{
                                    fontSize: '0.6875rem', padding: '2px 8px', borderRadius: '999px',
                                    background: 'rgba(99,102,241,0.15)', color: '#818cf8',
                                }}>#{t}</span>
                            ))}
                            <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>
                                Cadastro: {new Date(user.createdAt).toLocaleDateString('pt-BR', { timeZone: 'UTC' })}
                            </span>
                        </div>
                    </div>
                </div>
            </div>

            {/* Client Data Section */}
            <div className="card" style={{ padding: '20px', marginBottom: '16px' }}>
                <h2 style={{ fontSize: '1.0625rem', fontWeight: 700, marginBottom: '16px' }}>📇 Dados do Cliente</h2>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '12px' }}>
                    <FieldItem label="CPF/CNPJ" value={user.cpfCnpj} field="cpfCnpj" userId={user.id} onSaved={loadUser} />
                    <FieldItem label="Endereço" value={user.address} field="address" userId={user.id} onSaved={loadUser} />
                    <FieldItem label="Cidade" value={user.city} field="city" userId={user.id} onSaved={loadUser} />
                    <FieldItem label="Estado" value={user.state} field="state" userId={user.id} onSaved={loadUser} />
                    <div>
                        <div style={{ fontSize: '0.6875rem', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: '4px' }}>Status</div>
                        <select className="form-select" value={user.clientStatus} onChange={async (e) => {
                            try { await usersApi.update(user.id, { clientStatus: e.target.value } as any); loadUser(); } catch {}
                        }} style={{ fontSize: '0.8125rem', padding: '6px 8px' }}>
                            <option value="ACTIVE">● Ativo</option>
                            <option value="INACTIVE">● Inativo</option>
                            <option value="BLOCKED">● Bloqueado</option>
                        </select>
                    </div>
                    <TagsEditor tags={user.tags || []} userId={user.id} onSaved={loadUser} />
                    <SocialLinksEditor socialLinks={user.socialLinks} userId={user.id} onSaved={loadUser} />
                </div>
            </div>

            {/* Financial Summary & Health Score — side by side */}
            {(() => {
                const payments = user.payments || [];
                const paid = payments.filter(p => p.status === 'PAID').reduce((s, p) => s + p.amount, 0);
                const pending = payments.filter(p => p.status === 'PENDING').reduce((s, p) => s + p.amount, 0);
                const now = new Date();
                const overdue = payments.filter(p => p.status === 'PENDING' && p.dueDate && new Date(p.dueDate) < now).reduce((s, p) => s + p.amount, 0);

                // Health Score (0-100)
                const bookings = user.bookings || [];
                const completed = bookings.filter(b => b.status === 'COMPLETED').length;
                const total = bookings.length;
                const faltas = bookings.filter(b => b.status === 'FALTA' || b.status === 'NAO_REALIZADO').length;
                const attendanceRate = total > 0 ? ((completed / total) * 100) : 100;
                const paymentScore = payments.length > 0 ? (payments.filter(p => p.status === 'PAID').length / payments.length) * 100 : 100;
                const hasActiveContract = user.contracts.some(c => c.status === 'ACTIVE');
                const contractScore = hasActiveContract ? 100 : user.contracts.length > 0 ? 40 : 20;
                const lastBooking = bookings[0];
                const daysSinceLast = lastBooking ? Math.floor((now.getTime() - new Date(lastBooking.date).getTime()) / 86400000) : 999;
                const recencyScore = daysSinceLast <= 7 ? 100 : daysSinceLast <= 30 ? 70 : daysSinceLast <= 90 ? 40 : 10;
                const healthScore = Math.round((attendanceRate * 0.3) + (paymentScore * 0.35) + (contractScore * 0.2) + (recencyScore * 0.15));
                const healthColor = healthScore >= 80 ? '#10b981' : healthScore >= 50 ? '#d97706' : '#dc2626';
                const healthLabel = healthScore >= 80 ? 'Excelente' : healthScore >= 60 ? 'Bom' : healthScore >= 40 ? 'Atenção' : 'Crítico';

                return (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '16px', marginBottom: '16px' }}>
                        {/* Financial Summary */}
                        <div className="card" style={{ padding: '20px' }}>
                            <h2 style={{ fontSize: '1.0625rem', fontWeight: 700, marginBottom: '16px' }}>💰 Resumo Financeiro</h2>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                                <div style={{ padding: '12px', background: 'rgba(16,185,129,0.08)', borderRadius: 'var(--radius-sm)', textAlign: 'center' }}>
                                    <div style={{ fontSize: '0.6875rem', textTransform: 'uppercase', color: 'var(--text-muted)' }}>Total Pago</div>
                                    <div style={{ fontSize: '1.25rem', fontWeight: 800, color: '#10b981', marginTop: '4px' }}>{formatBRL(paid)}</div>
                                </div>
                                <div style={{ padding: '12px', background: 'rgba(217,119,6,0.08)', borderRadius: 'var(--radius-sm)', textAlign: 'center' }}>
                                    <div style={{ fontSize: '0.6875rem', textTransform: 'uppercase', color: 'var(--text-muted)' }}>Pendente</div>
                                    <div style={{ fontSize: '1.25rem', fontWeight: 800, color: '#d97706', marginTop: '4px' }}>{formatBRL(pending)}</div>
                                </div>
                                {overdue > 0 && (
                                    <div style={{ padding: '12px', background: 'rgba(220,38,38,0.08)', borderRadius: 'var(--radius-sm)', textAlign: 'center', gridColumn: 'span 2' }}>
                                        <div style={{ fontSize: '0.6875rem', textTransform: 'uppercase', color: 'var(--text-muted)' }}>⚠️ Vencido</div>
                                        <div style={{ fontSize: '1.25rem', fontWeight: 800, color: '#dc2626', marginTop: '4px' }}>{formatBRL(overdue)}</div>
                                    </div>
                                )}
                            </div>
                            <div style={{ marginTop: '12px', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                {payments.length} pagamento{payments.length !== 1 ? 's' : ''} registrado{payments.length !== 1 ? 's' : ''}
                                {total > 0 && <> · {completed} sessão{completed !== 1 ? 'ões' : ''} concluída{completed !== 1 ? 's' : ''} de {total}</>}
                            </div>
                        </div>

                        {/* Health Score */}
                        <div className="card" style={{ padding: '20px' }}>
                            <h2 style={{ fontSize: '1.0625rem', fontWeight: 700, marginBottom: '16px' }}>🏥 Health Score</h2>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
                                {/* Circular gauge */}
                                <div style={{ position: 'relative', width: 80, height: 80, flexShrink: 0 }}>
                                    <svg viewBox="0 0 36 36" style={{ width: 80, height: 80, transform: 'rotate(-90deg)' }}>
                                        <circle cx="18" cy="18" r="15.5" fill="none" stroke="var(--border-color)" strokeWidth="3" />
                                        <circle cx="18" cy="18" r="15.5" fill="none" stroke={healthColor} strokeWidth="3"
                                            strokeDasharray={`${healthScore * 0.97} 100`} strokeLinecap="round" />
                                    </svg>
                                    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.125rem', fontWeight: 800, color: healthColor }}>
                                        {healthScore}
                                    </div>
                                </div>
                                <div style={{ flex: 1, fontSize: '0.75rem' }}>
                                    <div style={{ fontWeight: 700, fontSize: '0.875rem', color: healthColor, marginBottom: '8px' }}>{healthLabel}</div>
                                    <div style={{ display: 'grid', gap: '4px' }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                            <span style={{ color: 'var(--text-muted)' }}>Pagamentos</span>
                                            <span style={{ fontWeight: 600 }}>{Math.round(paymentScore)}%</span>
                                        </div>
                                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                            <span style={{ color: 'var(--text-muted)' }}>Presença</span>
                                            <span style={{ fontWeight: 600 }}>{Math.round(attendanceRate)}%</span>
                                        </div>
                                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                            <span style={{ color: 'var(--text-muted)' }}>Contrato</span>
                                            <span style={{ fontWeight: 600 }}>{contractScore}%</span>
                                        </div>
                                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                            <span style={{ color: 'var(--text-muted)' }}>Recência</span>
                                            <span style={{ fontWeight: 600 }}>{recencyScore}%</span>
                                        </div>
                                        {faltas > 0 && <div style={{ color: '#dc2626', marginTop: '4px' }}>⚠ {faltas} falta{faltas > 1 ? 's' : ''}</div>}
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                );
            })()}

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
                                    <div>{c.durationMonths}m · {c.discountPct}% desconto · {c.durationMonths === 3 ? getRule('episodes_3months') : getRule('episodes_6months')} gravações</div>
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

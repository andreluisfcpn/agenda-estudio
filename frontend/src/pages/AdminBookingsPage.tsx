import React, { useState, useEffect } from 'react';
import { bookingsApi, usersApi, BookingWithUser, UserSummary } from '../api/client';
import { useNavigate } from 'react-router-dom';

function formatBRL(cents: number): string {
    return `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;
}

const TIER_EMOJI: Record<string, string> = { COMERCIAL: '🏢', AUDIENCIA: '🎤', SABADO: '🌟' };
const STATUS_LABELS: Record<string, string> = { COMPLETED: '✅ Concluído', CONFIRMED: '✅ Confirmado', RESERVED: '⏳ Reservado', CANCELLED: '❌ Cancelado', FALTA: '❌ Falta', NAO_REALIZADO: '🔄 Não Realizado' };

export default function AdminBookingsPage() {
    const navigate = useNavigate();
    const [bookings, setBookings] = useState<BookingWithUser[]>([]);
    const [users, setUsers] = useState<UserSummary[]>([]);
    const [loading, setLoading] = useState(true);
    const [dateFilter, setDateFilter] = useState('');
    const [statusFilter, setStatusFilter] = useState('');
    const [searchQuery, setSearchQuery] = useState('');

    // Create modal
    const [showCreate, setShowCreate] = useState(false);
    const [createForm, setCreateForm] = useState({ userId: '', date: '', startTime: '09:00', status: 'CONFIRMED' });
    const [createError, setCreateError] = useState('');

    // Edit modal
    const [editBooking, setEditBooking] = useState<BookingWithUser | null>(null);
    const [editForm, setEditForm] = useState({ date: '', startTime: '', status: '' });
    const [editError, setEditError] = useState('');

    useEffect(() => { loadData(); }, [dateFilter, statusFilter]);

    const loadData = async () => {
        setLoading(true);
        try {
            const [bRes, uRes] = await Promise.all([
                bookingsApi.getAll(dateFilter || undefined, statusFilter || undefined),
                usersApi.getAll(),
            ]);
            setBookings(bRes.bookings);
            setUsers(uRes.users);
        } catch (err) { console.error(err); }
        finally { setLoading(false); }
    };

    const handleCreate = async () => {
        setCreateError('');
        try {
            await bookingsApi.adminCreate(createForm);
            setShowCreate(false);
            setCreateForm({ userId: '', date: '', startTime: '09:00', status: 'CONFIRMED' });
            await loadData();
        } catch (err: any) { setCreateError(err.message); }
    };

    const handleEdit = async () => {
        if (!editBooking) return;
        setEditError('');
        try {
            const data: any = {};
            if (editForm.date) data.date = editForm.date;
            if (editForm.startTime) data.startTime = editForm.startTime;
            if (editForm.status) data.status = editForm.status;
            await bookingsApi.update(editBooking.id, data);
            setEditBooking(null);
            await loadData();
        } catch (err: any) { setEditError(err.message); }
    };

    const handleCancel = async (id: string) => {
        if (!confirm('Cancelar este agendamento?')) return;
        try { await bookingsApi.cancel(id); await loadData(); } catch (err: any) { alert(err.message); }
    };

    // Client-side search filter
    const filtered = searchQuery
        ? bookings.filter(b => b.user.name.toLowerCase().includes(searchQuery.toLowerCase()) || b.user.email.toLowerCase().includes(searchQuery.toLowerCase()))
        : bookings;

    return (
        <div>
            <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '12px' }}>
                <div>
                    <h1 className="page-title">📅 Agendamentos</h1>
                    <p className="page-subtitle">Gerencie todos os agendamentos do estúdio</p>
                </div>
                <button className="btn btn-primary" onClick={() => setShowCreate(true)}>+ Novo Agendamento</button>
            </div>

            {/* Filters + Search */}
            <div className="card" style={{ padding: '16px', marginBottom: '16px', display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
                <div style={{ position: 'relative', flex: '1 1 220px', minWidth: 200 }}>
                    <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', fontSize: '1rem' }}>🔍</span>
                    <input
                        className="form-input"
                        style={{ paddingLeft: 32 }}
                        placeholder="Buscar por nome ou e-mail..."
                        value={searchQuery}
                        onChange={e => setSearchQuery(e.target.value)}
                    />
                </div>
                <input type="date" className="form-input" style={{ maxWidth: 180 }} value={dateFilter} onChange={e => setDateFilter(e.target.value)} />
                <select className="form-select" style={{ maxWidth: 180 }} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
                    <option value="">Todos os status</option>
                    <option value="COMPLETED">Concluídos</option>
                    <option value="CONFIRMED">Confirmados</option>
                    <option value="RESERVED">Reservados</option>
                    <option value="CANCELLED">Cancelados</option>
                    <option value="FALTA">Falta</option>
                    <option value="NAO_REALIZADO">Não Realizado</option>
                </select>
                {(dateFilter || statusFilter || searchQuery) && (
                    <button className="btn btn-ghost btn-sm" onClick={() => { setDateFilter(''); setStatusFilter(''); setSearchQuery(''); }}>Limpar</button>
                )}
                <span style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontSize: '0.8125rem' }}>{filtered.length} resultado(s)</span>
            </div>

            {loading ? (
                <div className="loading-spinner"><div className="spinner" /></div>
            ) : filtered.length === 0 ? (
                <div className="card"><div className="empty-state"><div className="empty-state-icon">📅</div><div className="empty-state-text">Nenhum agendamento encontrado</div></div></div>
            ) : (
                <div className="card">
                    <div className="table-container">
                        <table>
                            <thead>
                                <tr><th>Cliente</th><th>Data</th><th>Horário</th><th>Faixa</th><th>Valor</th><th>Status</th><th>Ações</th></tr>
                            </thead>
                            <tbody>
                                {filtered.map(b => (
                                    <tr key={b.id}>
                                        <td>
                                            <div style={{ fontWeight: 600, cursor: 'pointer', color: 'var(--accent-primary)' }} onClick={() => navigate(`/admin/clients/${b.user.id}`)}>{b.user.name}</div>
                                            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{b.user.email}</div>
                                        </td>
                                        <td>{new Date(b.date).toLocaleDateString('pt-BR', { timeZone: 'UTC', weekday: 'short', day: '2-digit', month: '2-digit' })}</td>
                                        <td style={{ fontWeight: 600 }}>{b.startTime}–{b.endTime}</td>
                                        <td><span className={`badge badge-${b.tierApplied.toLowerCase()}`}>{TIER_EMOJI[b.tierApplied]} {b.tierApplied}</span></td>
                                        <td style={{ fontWeight: 600 }}>{formatBRL(b.price)}</td>
                                        <td><span className={`badge badge-${b.status.toLowerCase()}`}>{STATUS_LABELS[b.status]}</span></td>
                                        <td style={{ display: 'flex', gap: '6px' }}>
                                            <button className="btn btn-ghost btn-sm" onClick={() => { setEditBooking(b); setEditForm({ date: b.date.split('T')[0], startTime: b.startTime, status: b.status }); setEditError(''); }}>✏️</button>
                                            {b.status !== 'CANCELLED' && <button className="btn btn-danger btn-sm" onClick={() => handleCancel(b.id)}>✕</button>}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            {/* Create Modal */}
            {showCreate && (
                <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setShowCreate(false)}>
                    <div className="modal">
                        <h2 className="modal-title">Novo Agendamento</h2>
                        {createError && <div className="error-message">{createError}</div>}
                        <div className="form-group"><label className="form-label">Cliente</label>
                            <select className="form-select" value={createForm.userId} onChange={e => setCreateForm({ ...createForm, userId: e.target.value })}>
                                <option value="">Selecione um cliente</option>
                                {users.filter(u => u.role !== 'ADMIN').map(u => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)}
                            </select>
                        </div>
                        <div className="form-group"><label className="form-label">Data</label><input type="date" className="form-input" value={createForm.date} onChange={e => setCreateForm({ ...createForm, date: e.target.value })} /></div>
                        <div className="form-group"><label className="form-label">Horário de Início</label><input type="time" className="form-input" step="1800" value={createForm.startTime} onChange={e => setCreateForm({ ...createForm, startTime: e.target.value })} /></div>
                        <div className="form-group"><label className="form-label">Status</label>
                            <select className="form-select" value={createForm.status} onChange={e => setCreateForm({ ...createForm, status: e.target.value })}>
                                <option value="CONFIRMED">✅ Confirmado</option><option value="RESERVED">⏳ Reservado</option>
                            </select>
                        </div>
                        <div className="modal-actions">
                            <button className="btn btn-secondary" onClick={() => setShowCreate(false)}>Cancelar</button>
                            <button className="btn btn-primary" onClick={handleCreate} disabled={!createForm.userId || !createForm.date}>🚀 Criar</button>
                        </div>
                    </div>
                </div>
            )}

            {/* Edit Modal */}
            {editBooking && (
                <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setEditBooking(null)}>
                    <div className="modal">
                        <h2 className="modal-title">Editar Agendamento</h2>
                        <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginBottom: '16px' }}>Cliente: <strong>{editBooking.user.name}</strong></p>
                        {editError && <div className="error-message">{editError}</div>}
                        <div className="form-group"><label className="form-label">Data</label><input type="date" className="form-input" value={editForm.date} onChange={e => setEditForm({ ...editForm, date: e.target.value })} /></div>
                        <div className="form-group"><label className="form-label">Horário de Início</label><input type="time" className="form-input" step="1800" value={editForm.startTime} onChange={e => setEditForm({ ...editForm, startTime: e.target.value })} /></div>
                        <div className="form-group"><label className="form-label">Status</label>
                            <select className="form-select" value={editForm.status} onChange={e => setEditForm({ ...editForm, status: e.target.value })}>
                                <option value="RESERVED">⏳ Reservado</option><option value="CONFIRMED">✅ Confirmado</option><option value="COMPLETED">✅ Concluído</option><option value="FALTA">❌ Falta</option><option value="NAO_REALIZADO">🔄 Não Realizado</option><option value="CANCELLED">❌ Cancelado</option>
                            </select>
                        </div>
                        <div className="modal-actions">
                            <button className="btn btn-secondary" onClick={() => setEditBooking(null)}>Cancelar</button>
                            <button className="btn btn-primary" onClick={handleEdit}>💾 Salvar</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { bookingsApi, usersApi, contractsApi, BookingWithUser, UserSummary, Contract, Slot } from '../api/client';
import { useNavigate } from 'react-router-dom';
import { useUI } from '../context/UIContext';
import ModalOverlay from '../components/ModalOverlay';

function formatBRL(cents: number): string {
    return `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;
}

const TIER_EMOJI: Record<string, string> = { COMERCIAL: '🏢', AUDIENCIA: '🎤', SABADO: '🌟' };
const TIER_COLORS: Record<string, { color: string; bg: string }> = {
    COMERCIAL: { color: '#10b981', bg: 'rgba(16,185,129,0.12)' },
    AUDIENCIA: { color: '#2dd4bf', bg: 'rgba(45,212,191,0.12)' },
    SABADO: { color: '#fbbf24', bg: 'rgba(245,158,11,0.12)' },
};

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string; icon: string }> = {
    COMPLETED:     { label: 'Concluído',      color: '#10b981', bg: 'rgba(16,185,129,0.12)',  icon: '✓' },
    CONFIRMED:     { label: 'Confirmado',     color: '#3b82f6', bg: 'rgba(59,130,246,0.12)',  icon: '✓' },
    RESERVED:      { label: 'Reservado',      color: '#f59e0b', bg: 'rgba(245,158,11,0.12)',  icon: '⏳' },
    CANCELLED:     { label: 'Cancelado',      color: '#ef4444', bg: 'rgba(239,68,68,0.12)',   icon: '✕' },
    FALTA:         { label: 'Falta',          color: '#ef4444', bg: 'rgba(239,68,68,0.12)',   icon: '✕' },
    NAO_REALIZADO: { label: 'Não Realizado',  color: '#14b8a6', bg: 'rgba(45,212,191,0.12)',  icon: '↩' },
};

export default function AdminBookingsPage() {
    const navigate = useNavigate();
    const { showAlert, showConfirm, showToast } = useUI();
    const [bookings, setBookings] = useState<BookingWithUser[]>([]);
    const [users, setUsers] = useState<UserSummary[]>([]);
    const [loading, setLoading] = useState(true);
    const [dateFilter, setDateFilter] = useState('');
    const [statusFilter, setStatusFilter] = useState('');
    const [searchQuery, setSearchQuery] = useState('');

    const [showCreate, setShowCreate] = useState(false);
    const [createStep, setCreateStep] = useState(1);
    const [createForm, setCreateForm] = useState({ userId: '', contractId: '', date: '', startTime: '', status: 'CONFIRMED', adminNotes: '' });
    const [createError, setCreateError] = useState('');
    const [createSearch, setCreateSearch] = useState('');
    const [clientContracts, setClientContracts] = useState<Contract[]>([]);
    const [daySlots, setDaySlots] = useState<Slot[]>([]);
    const [slotsLoading, setSlotsLoading] = useState(false);
    const [creating, setCreating] = useState(false);
    const [customPrice, setCustomPrice] = useState<number | null>(null);
    const [priceDisplay, setPriceDisplay] = useState('');

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
        setCreating(true);
        try {
            const payload: any = { userId: createForm.userId, date: createForm.date, startTime: createForm.startTime, status: createForm.status };
            if (createForm.contractId) payload.contractId = createForm.contractId;
            if (createForm.adminNotes.trim()) payload.adminNotes = createForm.adminNotes;
            if (!createForm.contractId && customPrice != null) payload.customPrice = customPrice;
            await bookingsApi.adminCreate(payload);
            resetCreateModal();
            showToast('Agendamento criado com sucesso!');
            await loadData();
        } catch (err: any) { setCreateError(err.message); }
        finally { setCreating(false); }
    };

    const resetCreateModal = () => {
        setShowCreate(false);
        setCreateStep(1);
        setCreateForm({ userId: '', contractId: '', date: '', startTime: '', status: 'CONFIRMED', adminNotes: '' });
        setCreateError('');
        setCreateSearch('');
        setClientContracts([]);
        setDaySlots([]);
        setCustomPrice(null);
        setPriceDisplay('');
    };

    // Load contracts when client is selected
    const loadClientContracts = useCallback(async (userId: string) => {
        try {
            const res = await contractsApi.getAll();
            setClientContracts(res.contracts.filter(c => c.user?.id === userId && c.status === 'ACTIVE'));
        } catch { setClientContracts([]); }
    }, []);

    // Load slot availability when date changes
    const loadDaySlots = useCallback(async (date: string) => {
        setSlotsLoading(true);
        try {
            const res = await bookingsApi.getAvailability(date);
            setDaySlots(res.slots || []);
        } catch { setDaySlots([]); }
        finally { setSlotsLoading(false); }
    }, []);

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

    const handleHardDelete = async (b: BookingWithUser) => {
        const hasContract = b.contractId && b.contract;
        const creditWarning = hasContract && b.status !== 'CANCELLED'
            ? `\n\n⚠️ O crédito consumido do contrato "${b.contract?.name}" será devolvido.`
            : '';
        showConfirm({
            title: '🗑️ Excluir Agendamento Permanentemente',
            message: `Tem certeza que deseja excluir este agendamento?\n\nCliente: ${b.user.name}\nData: ${new Date(b.date).toLocaleDateString('pt-BR', { timeZone: 'UTC' })}\nHorário: ${b.startTime}\n\nEsta ação é irreversível — o agendamento será removido como se nunca tivesse existido.${creditWarning}`,
            onConfirm: async () => {
                try {
                    const res = await bookingsApi.hardDelete(b.id);
                    showToast(res.message);
                    await loadData();
                } catch (err: any) { showAlert({ message: err.message, type: 'error' }); }
            }
        });
    };

    const handleInlineStatusChange = async (id: string, newStatus: string) => {
        try {
            await bookingsApi.update(id, { status: newStatus });
            setBookings(prev => prev.map(b => b.id === id ? { ...b, status: newStatus as any } : b));
        } catch (err: any) { showAlert({ message: err.message, type: 'error' }); }
    };

    const filtered = useMemo(() => {
        if (!searchQuery) return bookings;
        const q = searchQuery.toLowerCase();
        return bookings.filter(b =>
            b.user.name.toLowerCase().includes(q) || b.user.email.toLowerCase().includes(q)
        );
    }, [bookings, searchQuery]);

    // KPIs
    const kpis = useMemo(() => {
        const confirmed = bookings.filter(b => b.status === 'CONFIRMED' || b.status === 'RESERVED').length;
        const completed = bookings.filter(b => b.status === 'COMPLETED').length;
        const cancelled = bookings.filter(b => b.status === 'CANCELLED' || b.status === 'FALTA').length;
        const revenue = bookings.filter(b => b.status === 'COMPLETED' || b.status === 'CONFIRMED').reduce((s, b) => s + b.price, 0);
        return { total: bookings.length, confirmed, completed, cancelled, revenue };
    }, [bookings]);

    return (
        <div>
            {/* ─── HEADER ─── */}
            <div style={{ marginBottom: '28px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '16px' }}>
                <div>
                    <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <span style={{ fontSize: '1.75rem' }}>📅</span> Agendamentos
                    </h1>
                    <p className="page-subtitle" style={{ marginTop: '4px' }}>
                        Gerencie todos os agendamentos do estúdio
                    </p>
                </div>
                <button className="btn btn-primary" onClick={() => setShowCreate(true)}
                    style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '12px 24px', borderRadius: '12px', fontWeight: 700 }}>
                    <span style={{ fontSize: '1.1rem' }}>+</span> Novo Agendamento
                </button>
            </div>

            {/* ─── KPI CARDS ─── */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '14px', marginBottom: '24px' }}>
                <div style={{
                    padding: '20px', borderRadius: '14px',
                    background: 'linear-gradient(135deg, rgba(99,102,241,0.08), rgba(67,56,202,0.04))',
                    border: '1px solid rgba(99,102,241,0.2)',
                }}>
                    <div style={{ fontSize: '0.6875rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '6px' }}>Total</div>
                    <div style={{ fontSize: '2rem', fontWeight: 800, color: 'var(--text-primary)' }}>{kpis.total}</div>
                    <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', marginTop: '4px' }}>agendamentos</div>
                </div>
                <div style={{
                    padding: '20px', borderRadius: '14px',
                    background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
                }}>
                    <div style={{ fontSize: '0.6875rem', fontWeight: 700, color: '#3b82f6', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '6px' }}>Confirmados</div>
                    <div style={{ fontSize: '2rem', fontWeight: 800, color: 'var(--text-primary)' }}>{kpis.confirmed}</div>
                    <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', marginTop: '4px' }}>a realizar</div>
                </div>
                <div style={{
                    padding: '20px', borderRadius: '14px',
                    background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
                }}>
                    <div style={{ fontSize: '0.6875rem', fontWeight: 700, color: '#10b981', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '6px' }}>Concluídos</div>
                    <div style={{ fontSize: '2rem', fontWeight: 800, color: 'var(--text-primary)' }}>{kpis.completed}</div>
                    <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', marginTop: '4px' }}>realizados</div>
                </div>
                <div style={{
                    padding: '20px', borderRadius: '14px',
                    background: kpis.cancelled > 0 ? 'linear-gradient(135deg, rgba(239,68,68,0.06), rgba(220,38,38,0.04))' : 'var(--bg-secondary)',
                    border: kpis.cancelled > 0 ? '1px solid rgba(239,68,68,0.2)' : '1px solid var(--border-color)',
                }}>
                    <div style={{ fontSize: '0.6875rem', fontWeight: 700, color: '#ef4444', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '6px' }}>Cancelados</div>
                    <div style={{ fontSize: '2rem', fontWeight: 800, color: kpis.cancelled > 0 ? '#ef4444' : 'var(--text-primary)' }}>{kpis.cancelled}</div>
                    <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', marginTop: '4px' }}>cancelados + faltas</div>
                </div>
                <div style={{
                    padding: '20px', borderRadius: '14px',
                    background: 'linear-gradient(135deg, rgba(16,185,129,0.08), rgba(6,78,59,0.04))',
                    border: '1px solid rgba(16,185,129,0.2)',
                }}>
                    <div style={{ fontSize: '0.6875rem', fontWeight: 700, color: '#10b981', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '6px' }}>Receita</div>
                    <div style={{ fontSize: '1.5rem', fontWeight: 800, color: 'var(--text-primary)' }}>{formatBRL(kpis.revenue)}</div>
                    <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', marginTop: '4px' }}>confirmados + concluídos</div>
                </div>
            </div>

            {/* ─── SEARCH + FILTERS ─── */}
            <div style={{
                padding: '12px 16px', borderRadius: '12px', marginBottom: '16px',
                background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
                display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap'
            }}>
                <div style={{ position: 'relative', flex: 1, minWidth: '200px' }}>
                    <input
                        type="text" placeholder="Buscar por nome ou e-mail..."
                        value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
                        style={{
                            width: '100%', padding: '8px 12px 8px 32px', borderRadius: '8px', fontSize: '0.8125rem',
                            background: 'var(--bg-elevated)', border: '1px solid var(--border-color)',
                            color: 'var(--text-primary)', outline: 'none', transition: 'border-color 0.2s'
                        }}
                        onFocus={e => (e.currentTarget.style.borderColor = '#10b981')}
                        onBlur={e => (e.currentTarget.style.borderColor = 'var(--border-color)')}
                    />
                    <span style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', fontSize: '0.75rem', opacity: 0.5 }}>🔍</span>
                </div>

                {/* Date filter */}
                <input type="date" value={dateFilter} onChange={e => setDateFilter(e.target.value)}
                    style={{
                        padding: '8px 12px', borderRadius: '8px', fontSize: '0.8125rem', maxWidth: '160px',
                        background: 'var(--bg-elevated)', border: '1px solid var(--border-color)',
                        color: 'var(--text-primary)', outline: 'none'
                    }}
                />

                {/* Status filter pills */}
                <div style={{ display: 'flex', gap: '2px', padding: '3px', background: 'var(--bg-elevated)', borderRadius: '10px' }}>
                    {[
                        { key: '', label: 'Todos' },
                        { key: 'CONFIRMED', label: 'Confirmados' },
                        { key: 'COMPLETED', label: 'Concluídos' },
                        { key: 'RESERVED', label: 'Reservados' },
                        { key: 'CANCELLED', label: 'Cancelados' },
                    ].map(s => (
                        <button key={s.key}
                            onClick={() => setStatusFilter(s.key)}
                            style={{
                                padding: '5px 10px', borderRadius: '8px', fontSize: '0.6875rem',
                                fontWeight: statusFilter === s.key ? 700 : 500, border: 'none', cursor: 'pointer',
                                background: statusFilter === s.key ? 'var(--bg-secondary)' : 'transparent',
                                color: statusFilter === s.key ? 'var(--text-primary)' : 'var(--text-muted)',
                                boxShadow: statusFilter === s.key ? '0 1px 3px rgba(0,0,0,0.2)' : 'none',
                                transition: 'all 0.2s'
                            }}
                        >
                            {s.label}
                        </button>
                    ))}
                </div>

                {(dateFilter || statusFilter || searchQuery) && (
                    <button onClick={() => { setDateFilter(''); setStatusFilter(''); setSearchQuery(''); }}
                        style={{
                            background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.15)',
                            color: '#ef4444', padding: '6px 12px', borderRadius: '8px', cursor: 'pointer',
                            fontSize: '0.6875rem', fontWeight: 600
                        }}>
                        ✕ Limpar
                    </button>
                )}

                <span style={{
                    marginLeft: 'auto', fontSize: '0.75rem', color: 'var(--text-muted)',
                    padding: '4px 10px', background: 'var(--bg-elevated)', borderRadius: '8px'
                }}>
                    {filtered.length} resultado{filtered.length !== 1 ? 's' : ''}
                </span>
            </div>

            {/* ─── BOOKINGS TABLE ─── */}
            {loading ? (
                <div className="loading-spinner"><div className="spinner" /></div>
            ) : (
                <div style={{ borderRadius: '16px', border: '1px solid var(--border-color)', background: 'var(--bg-secondary)', overflow: 'hidden' }}>
                    {filtered.length === 0 ? (
                        <div style={{ padding: '48px 20px', textAlign: 'center', color: 'var(--text-muted)' }}>
                            <div style={{ fontSize: '2.5rem', marginBottom: '12px', opacity: 0.4 }}>📅</div>
                            <div style={{ fontWeight: 600 }}>Nenhum agendamento encontrado</div>
                            <div style={{ fontSize: '0.8125rem', marginTop: '4px' }}>Tente ajustar os filtros ou período</div>
                        </div>
                    ) : (
                        <div className="table-container" style={{ margin: 0 }}>
                            <table>
                                <thead>
                                    <tr>
                                        <th style={{ paddingLeft: '20px' }}>Cliente</th>
                                        <th>Data / Horário</th>
                                        <th>Contrato</th>
                                        <th>Agendado em</th>
                                        <th style={{ textAlign: 'right' }}>Valor</th>
                                        <th style={{ textAlign: 'center' }}>Status</th>
                                        <th style={{ textAlign: 'center' }}>Ações</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {filtered.map((b, i) => {
                                        const sc = STATUS_CONFIG[b.status] || STATUS_CONFIG.RESERVED;
                                        const dateObj = new Date(b.date);
                                        const dayStr = dateObj.toLocaleDateString('pt-BR', { timeZone: 'UTC', weekday: 'short', day: '2-digit', month: '2-digit' });
                                        const createdStr = b.createdAt ? new Date(b.createdAt).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
                                        return (
                                            <tr key={b.id}
                                                style={{
                                                    background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)',
                                                    transition: 'background 0.15s'
                                                }}
                                                onMouseEnter={e => (e.currentTarget.style.background = 'rgba(16,185,129,0.04)')}
                                                onMouseLeave={e => (e.currentTarget.style.background = i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)')}
                                            >
                                                {/* Client */}
                                                <td style={{ paddingLeft: '20px' }}>
                                                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                                        <div style={{
                                                            width: '36px', height: '36px', borderRadius: '10px',
                                                            background: sc.bg,
                                                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                            fontSize: '0.875rem', flexShrink: 0, fontWeight: 700, color: sc.color
                                                        }}>
                                                            {b.user.name.charAt(0).toUpperCase()}
                                                        </div>
                                                        <div>
                                                            <div style={{ fontWeight: 600, fontSize: '0.875rem', cursor: 'pointer', color: 'var(--accent-primary)' }}
                                                                onClick={() => navigate(`/admin/clients/${b.user.id}`)}>
                                                                {b.user.name}
                                                            </div>
                                                            <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', marginTop: '1px' }}>
                                                                {b.user.email}
                                                            </div>
                                                        </div>
                                                    </div>
                                                </td>

                                                {/* Date + Time */}
                                                <td>
                                                    <div style={{ fontWeight: 600, fontSize: '0.875rem' }}>{dayStr}</div>
                                                    <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '2px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                                                        <span style={{ fontSize: '0.6875rem' }}>🕐</span>
                                                        {b.startTime} – {b.endTime}
                                                    </div>
                                                </td>

                                                {/* Contract */}
                                                <td>
                                                    {b.contract ? (
                                                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                                            <span style={{
                                                                display: 'inline-flex', alignItems: 'center', gap: '4px',
                                                                padding: '3px 8px', borderRadius: '6px', fontSize: '0.6875rem', fontWeight: 600,
                                                                background: TIER_COLORS[b.contract.tier]?.bg || 'var(--bg-elevated)',
                                                                color: TIER_COLORS[b.contract.tier]?.color || 'var(--text-muted)',
                                                            }}>
                                                                {TIER_EMOJI[b.contract.tier]} {b.contract.name}
                                                            </span>
                                                        </div>
                                                    ) : (
                                                        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>—</span>
                                                    )}
                                                </td>

                                                {/* Created at */}
                                                <td>
                                                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{createdStr}</div>
                                                </td>

                                                {/* Valor */}
                                                <td style={{ textAlign: 'right', fontWeight: 700, fontSize: '0.875rem', fontVariantNumeric: 'tabular-nums', color: '#10b981' }}>
                                                    {formatBRL(b.price)}
                                                </td>

                                                {/* Status - premium inline select */}
                                                <td style={{ textAlign: 'center' }}>
                                                    <div style={{ display: 'inline-flex', alignItems: 'center', position: 'relative' }}>
                                                        {/* Animated dot */}
                                                        <span style={{
                                                            width: 6, height: 6, borderRadius: '50%', background: sc.color,
                                                            position: 'absolute', left: '11px', top: '50%', transform: 'translateY(-50%)',
                                                            pointerEvents: 'none', zIndex: 1,
                                                            boxShadow: `0 0 6px ${sc.color}66`,
                                                        }} />
                                                        <select
                                                            value={b.status}
                                                            onChange={e => handleInlineStatusChange(b.id, e.target.value)}
                                                            style={{
                                                                padding: '6px 30px 6px 24px', borderRadius: '10px', fontSize: '0.75rem', fontWeight: 700,
                                                                letterSpacing: '0.01em',
                                                                background: 'rgba(255,255,255,0.04)', color: sc.color,
                                                                border: `1px solid rgba(255,255,255,0.08)`,
                                                                cursor: 'pointer', outline: 'none', WebkitAppearance: 'none', MozAppearance: 'none',
                                                                appearance: 'none', fontFamily: 'inherit',
                                                                backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='5' viewBox='0 0 8 5'%3E%3Cpath d='M.7.7 4 4l3.3-3.3' stroke='rgba(255,255,255,0.3)' stroke-width='1.2' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")`,
                                                                backgroundRepeat: 'no-repeat', backgroundPosition: 'right 10px center',
                                                                transition: 'all 0.2s ease',
                                                                backdropFilter: 'blur(8px)',
                                                            }}
                                                            onMouseEnter={e => {
                                                                e.currentTarget.style.background = `rgba(255,255,255,0.07)`;
                                                                e.currentTarget.style.borderColor = `${sc.color}44`;
                                                            }}
                                                            onMouseLeave={e => {
                                                                e.currentTarget.style.background = `rgba(255,255,255,0.04)`;
                                                                e.currentTarget.style.borderColor = `rgba(255,255,255,0.08)`;
                                                            }}
                                                        >
                                                            {Object.entries(STATUS_CONFIG).map(([key, cfg]) => (
                                                                <option key={key} value={key} style={{ background: '#0a1a1f', color: cfg.color, padding: '6px' }}>{cfg.icon} {cfg.label}</option>
                                                            ))}
                                                        </select>
                                                    </div>
                                                </td>

                                                {/* Actions */}
                                                <td style={{ textAlign: 'center' }}>
                                                    <div style={{ display: 'flex', gap: '4px', justifyContent: 'center' }}>
                                                        <button style={{
                                                            background: 'var(--bg-elevated)', border: '1px solid var(--border-color)',
                                                            color: 'var(--text-secondary)', padding: '6px 10px', borderRadius: '8px',
                                                            cursor: 'pointer', fontSize: '0.8125rem', transition: 'all 0.2s'
                                                        }}
                                                        onMouseEnter={e => { e.currentTarget.style.borderColor = '#10b981'; e.currentTarget.style.color = '#10b981'; }}
                                                        onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border-color)'; e.currentTarget.style.color = 'var(--text-secondary)'; }}
                                                        title="Editar"
                                                        onClick={() => { setEditBooking(b); setEditForm({ date: b.date.split('T')[0], startTime: b.startTime, status: b.status }); setEditError(''); }}>
                                                            ✏️
                                                        </button>

                                                        <button style={{
                                                            background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.15)',
                                                            color: '#ef4444', padding: '6px 10px', borderRadius: '8px',
                                                            cursor: 'pointer', fontSize: '0.8125rem', transition: 'all 0.2s', opacity: 0.7
                                                        }}
                                                        onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
                                                        onMouseLeave={e => (e.currentTarget.style.opacity = '0.7')}
                                                        title="Excluir permanentemente"
                                                        onClick={() => handleHardDelete(b)}>
                                                            🗑️
                                                        </button>
                                                    </div>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            )}

            {/* ═══════════════════════════════════════════════════════
               MODALS (preserved from original)
            ═══════════════════════════════════════════════════════ */}

            {/* Create Modal */}
            {showCreate && (() => {
                const selectedUser = users.find(u => u.id === createForm.userId);
                const selectedSlot = daySlots.find(s => s.time === createForm.startTime);
                const selectedContract = clientContracts.find(c => c.id === createForm.contractId);
                const filteredClients = users.filter(u => u.role !== 'ADMIN').filter(u => {
                    if (!createSearch) return true;
                    const q = createSearch.toLowerCase();
                    return u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q);
                });
                const tc = (tier: string) => TIER_COLORS[tier] || TIER_COLORS.COMERCIAL;

                const stepLabels = ['Cliente', 'Horário', 'Confirmar'];

                return (
                    <ModalOverlay onClose={resetCreateModal}>
                        <div className="modal" style={{ maxWidth: 580, maxHeight: '92vh', overflowY: 'auto', padding: 0 }}>
                            {/* ─── HEADER ─── */}
                            <div style={{ padding: '28px 32px 0', borderBottom: 'none' }}>
                                <h2 style={{ fontSize: '1.25rem', fontWeight: 800, margin: 0, display: 'flex', alignItems: 'center', gap: '10px' }}>
                                    <span style={{
                                        width: 36, height: 36, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center',
                                        background: 'linear-gradient(135deg, #10b981, #11819B)', fontSize: '1rem'
                                    }}>📅</span>
                                    Novo Agendamento
                                </h2>

                                {/* Step indicator */}
                                <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginTop: '20px', padding: '0 4px' }}>
                                    {stepLabels.map((label, i) => {
                                        const step = i + 1;
                                        const isActive = createStep === step;
                                        const isDone = createStep > step;
                                        return (
                                            <React.Fragment key={step}>
                                                {i > 0 && <div style={{ flex: 1, height: 2, background: isDone ? '#10b981' : 'var(--border-default)', borderRadius: 1, transition: 'background 0.3s' }} />}
                                                <div style={{
                                                    display: 'flex', alignItems: 'center', gap: '6px', cursor: isDone ? 'pointer' : 'default',
                                                }} onClick={() => isDone && setCreateStep(step)}>
                                                    <div style={{
                                                        width: 26, height: 26, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                        fontSize: '0.6875rem', fontWeight: 700,
                                                        background: isActive ? '#10b981' : isDone ? 'rgba(16,185,129,0.15)' : 'var(--bg-elevated)',
                                                        color: isActive ? '#fff' : isDone ? '#10b981' : 'var(--text-muted)',
                                                        border: `2px solid ${isActive ? '#10b981' : isDone ? 'rgba(16,185,129,0.3)' : 'var(--border-default)'}`,
                                                        transition: 'all 0.3s',
                                                    }}>
                                                        {isDone ? '✓' : step}
                                                    </div>
                                                    <span style={{
                                                        fontSize: '0.6875rem', fontWeight: isActive ? 700 : 500,
                                                        color: isActive ? 'var(--text-primary)' : 'var(--text-muted)',
                                                    }}>{label}</span>
                                                </div>
                                            </React.Fragment>
                                        );
                                    })}
                                </div>
                            </div>

                            <div style={{ padding: '20px 32px 28px' }}>
                                {createError && <div className="error-message" style={{ marginBottom: '16px', padding: '10px 14px', borderRadius: '10px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.15)', color: '#ef4444', fontSize: '0.8125rem', fontWeight: 600 }}>{createError}</div>}

                                {/* ════════ STEP 1: Select Client ════════ */}
                                {createStep === 1 && (
                                    <div>
                                        <div style={{ position: 'relative', marginBottom: '14px' }}>
                                            <input
                                                type="text" placeholder="Buscar cliente por nome ou e-mail..."
                                                value={createSearch} onChange={e => setCreateSearch(e.target.value)} autoFocus
                                                style={{
                                                    width: '100%', padding: '10px 14px 10px 36px', borderRadius: '10px', fontSize: '0.8125rem',
                                                    background: 'var(--bg-elevated)', border: '1px solid var(--border-default)',
                                                    color: 'var(--text-primary)', outline: 'none',
                                                }}
                                                onFocus={e => (e.currentTarget.style.borderColor = '#10b981')}
                                                onBlur={e => (e.currentTarget.style.borderColor = 'var(--border-default)')}
                                            />
                                            <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: '0.8125rem', opacity: 0.5 }}>🔍</span>
                                        </div>

                                        <div style={{ maxHeight: '340px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                            {filteredClients.length === 0 ? (
                                                <div style={{ padding: '32px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.8125rem' }}>
                                                    Nenhum cliente encontrado
                                                </div>
                                            ) : filteredClients.map(u => {
                                                const isSelected = createForm.userId === u.id;
                                                return (
                                                    <div key={u.id}
                                                        onClick={() => {
                                                            setCreateForm({ ...createForm, userId: u.id, contractId: '' });
                                                            loadClientContracts(u.id);
                                                        }}
                                                        style={{
                                                            padding: '10px 14px', borderRadius: '10px', cursor: 'pointer',
                                                            display: 'flex', alignItems: 'center', gap: '12px',
                                                            background: isSelected ? 'rgba(16,185,129,0.08)' : 'transparent',
                                                            border: `1px solid ${isSelected ? 'rgba(16,185,129,0.3)' : 'transparent'}`,
                                                            transition: 'all 0.15s',
                                                        }}
                                                        onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; }}
                                                        onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}
                                                    >
                                                        <div style={{
                                                            width: 36, height: 36, borderRadius: '50%',
                                                            background: isSelected ? 'linear-gradient(135deg, #10b981, #11819B)' : 'var(--bg-elevated)',
                                                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                            fontSize: '0.8125rem', fontWeight: 700, color: isSelected ? '#fff' : 'var(--text-muted)',
                                                            flexShrink: 0,
                                                        }}>
                                                            {u.name.charAt(0).toUpperCase()}
                                                        </div>
                                                        <div style={{ flex: 1, minWidth: 0 }}>
                                                            <div style={{ fontWeight: 600, fontSize: '0.8125rem', color: isSelected ? '#10b981' : 'var(--text-primary)' }}>{u.name}</div>
                                                            <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.email}</div>
                                                        </div>
                                                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                                            {u._count.contracts > 0 && (
                                                                <span style={{
                                                                    padding: '2px 8px', borderRadius: '6px', fontSize: '0.625rem', fontWeight: 700,
                                                                    background: 'rgba(16,185,129,0.12)', color: '#10b981',
                                                                }}>{u._count.contracts} contrato{u._count.contracts > 1 ? 's' : ''}</span>
                                                            )}
                                                            {isSelected && <span style={{ color: '#10b981', fontSize: '1rem' }}>✓</span>}
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                        </div>

                                        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '18px', gap: '10px' }}>
                                            <button onClick={resetCreateModal}
                                                style={{ padding: '9px 18px', borderRadius: '10px', background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-secondary)', fontSize: '0.8125rem', fontWeight: 600, cursor: 'pointer' }}>
                                                Cancelar
                                            </button>
                                            <button disabled={!createForm.userId}
                                                onClick={() => setCreateStep(2)}
                                                style={{
                                                    padding: '9px 22px', borderRadius: '10px', border: 'none', fontSize: '0.8125rem', fontWeight: 700, cursor: 'pointer',
                                                    background: createForm.userId ? 'linear-gradient(135deg, #10b981, #11819B)' : 'var(--bg-elevated)',
                                                    color: createForm.userId ? '#fff' : 'var(--text-muted)',
                                                    opacity: createForm.userId ? 1 : 0.5,
                                                }}>
                                                Próximo →
                                            </button>
                                        </div>
                                    </div>
                                )}

                                {/* ════════ STEP 2: Contract, Date, Slot ════════ */}
                                {createStep === 2 && (() => {
                                    const TIER_LABEL: Record<string, string> = { COMERCIAL: 'Comercial', AUDIENCIA: 'Audiência', SABADO: 'Sábado' };
                                    const DAY_NAMES = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

                                    // Determine selected contract and its tier for slot filtering
                                    const activeContract = clientContracts.find(c => c.id === createForm.contractId);
                                    const filterTier = activeContract?.tier || null; // null = avulso, show all

                                    // Check day compatibility for FIXO contracts
                                    const selectedDateDOW = createForm.date ? new Date(createForm.date + 'T12:00:00').getDay() : null;
                                    const isFixoDayMismatch = activeContract?.type === 'FIXO' && activeContract.fixedDayOfWeek != null && selectedDateDOW !== null && selectedDateDOW !== activeContract.fixedDayOfWeek;

                                    // Filter slots by contract tier
                                    const filteredSlots = filterTier
                                        ? daySlots.filter(s => s.tier === filterTier || !s.available)
                                        : daySlots;

                                    return (
                                    <div>
                                        {/* ── Contract Selector (always shown) ── */}
                                        <div style={{ marginBottom: '20px' }}>
                                            <label style={{ fontSize: '0.6875rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '10px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                                📋 Vincular a Contrato
                                                {clientContracts.length > 0 && <span style={{ fontSize: '0.5625rem', fontWeight: 600, padding: '1px 6px', borderRadius: '4px', background: 'rgba(16,185,129,0.1)', color: '#10b981' }}>{clientContracts.length} ativo{clientContracts.length > 1 ? 's' : ''}</span>}
                                            </label>
                                            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                                {/* Avulso card */}
                                                <div
                                                    onClick={() => setCreateForm({ ...createForm, contractId: '', startTime: '' })}
                                                    style={{
                                                        padding: '14px 16px', borderRadius: '12px', cursor: 'pointer',
                                                        display: 'flex', alignItems: 'center', gap: '14px',
                                                        background: !createForm.contractId
                                                            ? 'linear-gradient(135deg, rgba(99,102,241,0.08), rgba(67,56,202,0.04))'
                                                            : 'var(--bg-elevated)',
                                                        border: `1px solid ${!createForm.contractId ? 'rgba(99,102,241,0.35)' : 'var(--border-default)'}`,
                                                        transition: 'all 0.2s',
                                                    }}
                                                >
                                                    <div style={{
                                                        width: 40, height: 40, borderRadius: '10px', flexShrink: 0,
                                                        background: !createForm.contractId ? 'linear-gradient(135deg, #6366f1, #4f46e5)' : 'var(--bg-secondary)',
                                                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                        fontSize: '1.1rem',
                                                    }}>
                                                        🎯
                                                    </div>
                                                    <div style={{ flex: 1, minWidth: 0 }}>
                                                        <div style={{ fontWeight: 700, fontSize: '0.8125rem', color: !createForm.contractId ? '#818cf8' : 'var(--text-primary)' }}>Agendamento Avulso</div>
                                                        <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', marginTop: '2px' }}>Cria contrato automático · Todos os horários</div>
                                                    </div>
                                                    {!createForm.contractId && <span style={{ color: '#818cf8', fontSize: '1.1rem', fontWeight: 700 }}>✓</span>}
                                                </div>

                                                {/* Active contract cards */}
                                                {clientContracts.map(c => {
                                                    const isSelected = createForm.contractId === c.id;
                                                    const ct = tc(c.tier);
                                                    const hasCredits = c.type === 'FLEX' ? (c.flexCreditsRemaining ?? 0) > 0 : true;
                                                    const compat = true; // day compat checked after date selection

                                                    return (
                                                        <div key={c.id}
                                                            onClick={() => {
                                                                if (!hasCredits) return;
                                                                setCreateForm({ ...createForm, contractId: c.id, startTime: '' });
                                                            }}
                                                            style={{
                                                                padding: '14px 16px', borderRadius: '12px',
                                                                cursor: hasCredits ? 'pointer' : 'not-allowed',
                                                                display: 'flex', alignItems: 'center', gap: '14px',
                                                                background: isSelected
                                                                    ? `linear-gradient(135deg, ${ct.bg}, rgba(0,0,0,0))`
                                                                    : !hasCredits ? 'rgba(255,255,255,0.01)' : 'var(--bg-elevated)',
                                                                border: `1px solid ${isSelected ? ct.color + '55' : 'var(--border-default)'}`,
                                                                opacity: hasCredits ? 1 : 0.4,
                                                                transition: 'all 0.2s',
                                                            }}
                                                        >
                                                            {/* Tier icon */}
                                                            <div style={{
                                                                width: 40, height: 40, borderRadius: '10px', flexShrink: 0,
                                                                background: isSelected ? `linear-gradient(135deg, ${ct.color}, ${ct.color}88)` : ct.bg,
                                                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                                fontSize: '1.1rem', border: `1px solid ${ct.color}33`,
                                                            }}>
                                                                {TIER_EMOJI[c.tier]}
                                                            </div>

                                                            {/* Contract info */}
                                                            <div style={{ flex: 1, minWidth: 0 }}>
                                                                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                                                                    <span style={{ fontWeight: 700, fontSize: '0.8125rem', color: isSelected ? ct.color : 'var(--text-primary)' }}>{c.name}</span>
                                                                    <span style={{
                                                                        fontSize: '0.5625rem', fontWeight: 700, padding: '1px 6px', borderRadius: '4px',
                                                                        background: ct.bg, color: ct.color,
                                                                    }}>{TIER_LABEL[c.tier] || c.tier}</span>
                                                                    <span style={{
                                                                        fontSize: '0.5625rem', fontWeight: 600, padding: '1px 6px', borderRadius: '4px',
                                                                        background: c.type === 'FIXO' ? 'rgba(245,158,11,0.1)' : 'rgba(59,130,246,0.1)',
                                                                        color: c.type === 'FIXO' ? '#f59e0b' : '#3b82f6',
                                                                    }}>{c.type === 'FIXO' ? '📌 Fixo' : '🔄 Flex'}</span>
                                                                </div>
                                                                <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', marginTop: '3px', display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                                                                    {c.type === 'FIXO' && c.fixedDayOfWeek != null && (
                                                                        <span>📅 {DAY_NAMES[c.fixedDayOfWeek]} {c.fixedTime ? `às ${c.fixedTime}` : ''}</span>
                                                                    )}
                                                                    {c.type === 'FLEX' && c.flexCreditsRemaining != null && (
                                                                        <span style={{ color: c.flexCreditsRemaining > 0 ? '#10b981' : '#ef4444', fontWeight: 600 }}>
                                                                            {c.flexCreditsRemaining > 0 ? `✓ ${c.flexCreditsRemaining} crédito${c.flexCreditsRemaining > 1 ? 's' : ''} restante${c.flexCreditsRemaining > 1 ? 's' : ''}` : '✕ Sem créditos'}
                                                                        </span>
                                                                    )}
                                                                    {!hasCredits && <span style={{ color: '#ef4444', fontWeight: 600 }}>Créditos esgotados</span>}
                                                                </div>
                                                            </div>

                                                            {isSelected && <span style={{ color: ct.color, fontSize: '1.1rem', fontWeight: 700 }}>✓</span>}
                                                        </div>
                                                    );
                                                })}

                                                {clientContracts.length === 0 && (
                                                    <div style={{
                                                        padding: '16px', borderRadius: '10px', textAlign: 'center',
                                                        background: 'rgba(245,158,11,0.05)', border: '1px solid rgba(245,158,11,0.15)',
                                                        color: '#f59e0b', fontSize: '0.8125rem', fontWeight: 600,
                                                    }}>
                                                        ⚠️ Cliente sem contratos ativos · Será criado contrato avulso
                                                    </div>
                                                )}
                                            </div>
                                        </div>

                                        {/* ── Date ── */}
                                        <div style={{ marginBottom: '18px' }}>
                                            <label style={{ fontSize: '0.6875rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '8px', display: 'block' }}>
                                                📆 Data da gravação
                                            </label>
                                            <input type="date" value={createForm.date}
                                                min={new Date().toISOString().split('T')[0]}
                                                onChange={e => {
                                                    const newDate = e.target.value;
                                                    setCreateForm({ ...createForm, date: newDate, startTime: '' });
                                                    if (newDate) loadDaySlots(newDate);
                                                }}
                                                style={{
                                                    width: '100%', padding: '10px 14px', borderRadius: '10px', fontSize: '0.875rem', fontWeight: 600,
                                                    background: 'var(--bg-elevated)', border: '1px solid var(--border-default)',
                                                    color: 'var(--text-primary)', outline: 'none',
                                                }}
                                            />
                                            {/* FIXO day mismatch warning */}
                                            {isFixoDayMismatch && (
                                                <div style={{
                                                    marginTop: '8px', padding: '8px 12px', borderRadius: '8px',
                                                    background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)',
                                                    fontSize: '0.75rem', color: '#f59e0b', fontWeight: 600,
                                                    display: 'flex', alignItems: 'center', gap: '6px',
                                                }}>
                                                    ⚠️ Contrato {activeContract?.name} é fixo em <strong>{DAY_NAMES[activeContract!.fixedDayOfWeek!]}</strong>. A data selecionada é {DAY_NAMES[selectedDateDOW!]}.
                                                </div>
                                            )}
                                        </div>

                                        {/* ── Filtered Slot Grid ── */}
                                        {createForm.date && (
                                            <div>
                                                <label style={{ fontSize: '0.6875rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '10px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                                    🕐 Horário disponível
                                                    {filterTier && (
                                                        <span style={{
                                                            fontSize: '0.5625rem', fontWeight: 700, padding: '1px 8px', borderRadius: '4px',
                                                            background: tc(filterTier).bg, color: tc(filterTier).color,
                                                        }}>
                                                            {TIER_EMOJI[filterTier]} Filtrado: {TIER_LABEL[filterTier]}
                                                        </span>
                                                    )}
                                                </label>
                                                {slotsLoading ? (
                                                    <div style={{ padding: '24px', textAlign: 'center' }}><div className="spinner" style={{ width: 24, height: 24, margin: '0 auto' }} /></div>
                                                ) : filteredSlots.filter(s => s.available).length === 0 ? (
                                                    <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.8125rem', background: 'var(--bg-elevated)', borderRadius: 10 }}>
                                                        {filterTier
                                                            ? `Nenhum horário ${TIER_LABEL[filterTier]} disponível nesta data`
                                                            : 'Nenhum horário disponível nesta data'}
                                                    </div>
                                                ) : (
                                                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: '6px' }}>
                                                        {filteredSlots.map(slot => {
                                                            const isSelected = createForm.startTime === slot.time;
                                                            const slotTc = tc(slot.tier || 'COMERCIAL');
                                                            return (
                                                                <button key={slot.time}
                                                                    disabled={!slot.available}
                                                                    onClick={() => { setCreateForm({ ...createForm, startTime: slot.time }); if (!createForm.contractId && slot.price != null) { setCustomPrice(slot.price); setPriceDisplay((slot.price / 100).toFixed(2).replace('.', ',')); } }}
                                                                    style={{
                                                                        padding: '10px 8px', borderRadius: '10px', cursor: slot.available ? 'pointer' : 'not-allowed',
                                                                        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px',
                                                                        background: isSelected ? slotTc.bg : !slot.available ? 'rgba(255,255,255,0.02)' : 'var(--bg-elevated)',
                                                                        border: `1px solid ${isSelected ? slotTc.color + '55' : 'var(--border-default)'}`,
                                                                        opacity: slot.available ? 1 : 0.35,
                                                                        transition: 'all 0.15s',
                                                                    }}
                                                                >
                                                                    <span style={{ fontSize: '0.875rem', fontWeight: 700, color: isSelected ? slotTc.color : 'var(--text-primary)' }}>
                                                                        {slot.time}
                                                                    </span>
                                                                    <span style={{
                                                                        fontSize: '0.5625rem', fontWeight: 600, padding: '1px 6px', borderRadius: '4px',
                                                                        background: slot.available ? slotTc.bg : 'rgba(255,255,255,0.05)',
                                                                        color: slot.available ? slotTc.color : 'var(--text-muted)',
                                                                    }}>
                                                                        {slot.available ? `${TIER_EMOJI[slot.tier || 'COMERCIAL']} ${slot.tier}` : 'Ocupado'}
                                                                    </span>
                                                                </button>
                                                            );
                                                        })}
                                                    </div>
                                                )}
                                            </div>
                                        )}

                                        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '20px' }}>
                                            <button onClick={() => setCreateStep(1)}
                                                style={{ padding: '9px 18px', borderRadius: '10px', background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-secondary)', fontSize: '0.8125rem', fontWeight: 600, cursor: 'pointer' }}>
                                                ← Voltar
                                            </button>
                                            <button disabled={!createForm.date || !createForm.startTime}
                                                onClick={() => setCreateStep(3)}
                                                style={{
                                                    padding: '9px 22px', borderRadius: '10px', border: 'none', fontSize: '0.8125rem', fontWeight: 700, cursor: 'pointer',
                                                    background: createForm.date && createForm.startTime ? 'linear-gradient(135deg, #10b981, #11819B)' : 'var(--bg-elevated)',
                                                    color: createForm.date && createForm.startTime ? '#fff' : 'var(--text-muted)',
                                                    opacity: createForm.date && createForm.startTime ? 1 : 0.5,
                                                }}>
                                                Próximo →
                                            </button>
                                        </div>
                                    </div>
                                    );
                                })()}

                                {/* ════════ STEP 3: Confirm ════════ */}
                                {createStep === 3 && (
                                    <div>
                                        {/* Summary card */}
                                        <div style={{
                                            padding: '18px', borderRadius: '14px', marginBottom: '18px',
                                            background: 'var(--bg-elevated)', border: '1px solid rgba(16,185,129,0.15)',
                                        }}>
                                            <div style={{ fontSize: '0.625rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '14px' }}>
                                                Resumo do Agendamento
                                            </div>

                                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 20px' }}>
                                                <div>
                                                    <div style={{ fontSize: '0.625rem', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '3px' }}>Cliente</div>
                                                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                                        <div style={{
                                                            width: 28, height: 28, borderRadius: '50%', background: 'linear-gradient(135deg, #10b981, #11819B)',
                                                            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.6875rem', fontWeight: 700, color: '#fff',
                                                        }}>{selectedUser?.name?.charAt(0).toUpperCase()}</div>
                                                        <span style={{ fontWeight: 600, fontSize: '0.8125rem' }}>{selectedUser?.name}</span>
                                                    </div>
                                                </div>
                                                <div>
                                                    <div style={{ fontSize: '0.625rem', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '3px' }}>Data</div>
                                                    <div style={{ fontWeight: 700, fontSize: '0.875rem' }}>
                                                        {createForm.date ? new Date(createForm.date + 'T12:00:00').toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' }) : '—'}
                                                    </div>
                                                </div>
                                                <div>
                                                    <div style={{ fontSize: '0.625rem', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '3px' }}>Horário</div>
                                                    <div style={{ fontWeight: 700, fontSize: '1rem' }}>{createForm.startTime || '—'}</div>
                                                </div>
                                                <div>
                                                    <div style={{ fontSize: '0.625rem', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '3px' }}>Faixa</div>
                                                    {selectedSlot?.tier ? (
                                                        <span style={{
                                                            display: 'inline-flex', alignItems: 'center', gap: '4px',
                                                            padding: '2px 10px', borderRadius: '6px', fontSize: '0.6875rem', fontWeight: 700,
                                                            background: tc(selectedSlot.tier).bg, color: tc(selectedSlot.tier).color,
                                                        }}>
                                                            {TIER_EMOJI[selectedSlot.tier]} {selectedSlot.tier}
                                                        </span>
                                                    ) : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                                                </div>
                                                <div style={{ gridColumn: '1 / -1' }}>
                                                    <div style={{ fontSize: '0.625rem', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '3px' }}>Contrato</div>
                                                    <div style={{ fontWeight: 600, fontSize: '0.8125rem' }}>
                                                        {selectedContract ? `${TIER_EMOJI[selectedContract.tier]} ${selectedContract.name}` : '📋 Avulso (contrato automático)'}
                                                    </div>
                                                </div>
                                                {/* Editable price for Avulso */}
                                                {!createForm.contractId && (
                                                    <div style={{ gridColumn: '1 / -1', marginTop: '4px' }}>
                                                        <div style={{ fontSize: '0.625rem', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '6px' }}>💰 Valor do Agendamento</div>
                                                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                                            <div style={{ position: 'relative', flex: 1, maxWidth: '200px' }}>
                                                                <span style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', fontSize: '0.8125rem', fontWeight: 700, color: '#10b981' }}>R$</span>
                                                                <input
                                                                    type="text"
                                                                    value={priceDisplay}
                                                                    onChange={e => setPriceDisplay(e.target.value.replace(/[^\d,]/g, ''))}
                                                                    style={{
                                                                        width: '100%', padding: '8px 12px 8px 38px', borderRadius: '10px',
                                                                        fontSize: '1.125rem', fontWeight: 800, fontVariantNumeric: 'tabular-nums',
                                                                        background: 'var(--bg-elevated)', border: '1px solid rgba(16,185,129,0.3)',
                                                                        color: '#10b981', outline: 'none', fontFamily: 'inherit',
                                                                    }}
                                                                    onFocus={e => (e.currentTarget.style.borderColor = '#10b981')}
                                                                    onBlur={e => {
                                                                        e.currentTarget.style.borderColor = 'rgba(16,185,129,0.3)';
                                                                        const num = parseFloat(priceDisplay.replace(',', '.'));
                                                                        if (!isNaN(num) && num >= 0) {
                                                                            setCustomPrice(Math.round(num * 100));
                                                                            setPriceDisplay(num.toFixed(2).replace('.', ','));
                                                                        } else {
                                                                            setCustomPrice(0);
                                                                            setPriceDisplay('0,00');
                                                                        }
                                                                    }}
                                                                />
                                                            </div>
                                                            <span style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                                                                Editável · Apenas para este agendamento
                                                            </span>
                                                        </div>
                                                    </div>
                                                )}
                                            </div>
                                        </div>

                                        {/* Status */}
                                        <div style={{ marginBottom: '14px' }}>
                                            <label style={{ fontSize: '0.6875rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '8px', display: 'block' }}>Status inicial</label>
                                            <div style={{ display: 'flex', gap: '6px' }}>
                                                {[{ key: 'CONFIRMED', label: '✅ Confirmado' }, { key: 'RESERVED', label: '⏳ Reservado' }].map(s => (
                                                    <button key={s.key}
                                                        onClick={() => setCreateForm({ ...createForm, status: s.key })}
                                                        style={{
                                                            padding: '8px 16px', borderRadius: '8px', fontSize: '0.8125rem', fontWeight: 600, cursor: 'pointer',
                                                            background: createForm.status === s.key ? 'rgba(16,185,129,0.12)' : 'var(--bg-elevated)',
                                                            border: `1px solid ${createForm.status === s.key ? 'rgba(16,185,129,0.3)' : 'var(--border-default)'}`,
                                                            color: createForm.status === s.key ? '#10b981' : 'var(--text-secondary)',
                                                        }}>
                                                        {s.label}
                                                    </button>
                                                ))}
                                            </div>
                                        </div>

                                        {/* Admin notes */}
                                        <div style={{ marginBottom: '14px' }}>
                                            <label style={{ fontSize: '0.6875rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '8px', display: 'block' }}>
                                                📝 Notas internas (opcional)
                                            </label>
                                            <textarea
                                                value={createForm.adminNotes}
                                                onChange={e => setCreateForm({ ...createForm, adminNotes: e.target.value })}
                                                placeholder="Observações internas sobre esta gravação..."
                                                rows={3}
                                                style={{
                                                    width: '100%', padding: '10px 14px', borderRadius: '10px', fontSize: '0.8125rem',
                                                    background: 'var(--bg-elevated)', border: '1px solid var(--border-default)',
                                                    color: 'var(--text-primary)', outline: 'none', resize: 'vertical', fontFamily: 'inherit',
                                                }}
                                            />
                                        </div>

                                        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '20px' }}>
                                            <button onClick={() => setCreateStep(2)}
                                                style={{ padding: '9px 18px', borderRadius: '10px', background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-secondary)', fontSize: '0.8125rem', fontWeight: 600, cursor: 'pointer' }}>
                                                ← Voltar
                                            </button>
                                            <button onClick={handleCreate} disabled={creating}
                                                style={{
                                                    padding: '10px 28px', borderRadius: '10px', border: 'none', fontSize: '0.875rem', fontWeight: 700, cursor: 'pointer',
                                                    background: 'linear-gradient(135deg, #10b981, #11819B)', color: '#fff',
                                                    opacity: creating ? 0.6 : 1, display: 'flex', alignItems: 'center', gap: '8px',
                                                }}>
                                                {creating ? '⏳ Criando...' : '🚀 Agendar'}
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    </ModalOverlay>
                );
            })()}

            {/* Edit Modal — Redesigned */}
            {editBooking && (
                <ModalOverlay onClose={() => setEditBooking(null)}>
                    <div className="modal" style={{ maxWidth: 520, padding: 0, overflow: 'hidden' }}>
                        {/* Header */}
                        <div style={{ padding: '24px 28px 0' }}>
                            <h2 style={{ fontSize: '1.125rem', fontWeight: 800, margin: 0, display: 'flex', alignItems: 'center', gap: '10px' }}>
                                <span style={{
                                    width: 34, height: 34, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    background: 'linear-gradient(135deg, #10b981, #11819B)', fontSize: '0.9rem'
                                }}>✏️</span>
                                Editar Agendamento
                            </h2>
                            {/* Client info bar */}
                            <div style={{
                                display: 'flex', alignItems: 'center', gap: '10px', marginTop: '16px',
                                padding: '10px 14px', borderRadius: '10px',
                                background: 'var(--bg-elevated)', border: '1px solid var(--border-default)',
                            }}>
                                <div style={{
                                    width: 30, height: 30, borderRadius: '50%',
                                    background: 'linear-gradient(135deg, #10b981, #11819B)',
                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    fontSize: '0.75rem', fontWeight: 700, color: '#fff', flexShrink: 0,
                                }}>{editBooking.user.name.charAt(0).toUpperCase()}</div>
                                <div>
                                    <div style={{ fontWeight: 700, fontSize: '0.8125rem' }}>{editBooking.user.name}</div>
                                    <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)' }}>{editBooking.user.email}</div>
                                </div>
                                {editBooking.contract && (
                                    <span style={{
                                        marginLeft: 'auto', fontSize: '0.625rem', fontWeight: 700,
                                        padding: '2px 8px', borderRadius: '6px',
                                        background: TIER_COLORS[editBooking.contract.tier]?.bg || 'var(--bg-elevated)',
                                        color: TIER_COLORS[editBooking.contract.tier]?.color || 'var(--text-muted)',
                                    }}>
                                        {TIER_EMOJI[editBooking.contract.tier]} {editBooking.contract.name}
                                    </span>
                                )}
                            </div>
                        </div>

                        {/* Form */}
                        <div style={{ padding: '20px 28px 24px' }}>
                            {editError && <div style={{ marginBottom: '14px', padding: '10px 14px', borderRadius: '10px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.15)', color: '#ef4444', fontSize: '0.8125rem', fontWeight: 600 }}>{editError}</div>}

                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px', marginBottom: '16px' }}>
                                {/* Date */}
                                <div>
                                    <label style={{ fontSize: '0.6875rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '6px', display: 'block' }}>📆 Data</label>
                                    <input type="date" value={editForm.date}
                                        min={new Date().toISOString().split('T')[0]}
                                        onChange={e => setEditForm({ ...editForm, date: e.target.value })}
                                        style={{
                                            width: '100%', padding: '9px 12px', borderRadius: '10px', fontSize: '0.8125rem', fontWeight: 600,
                                            background: 'var(--bg-elevated)', border: '1px solid var(--border-default)',
                                            color: 'var(--text-primary)', outline: 'none',
                                        }}
                                    />
                                </div>
                                {/* Time */}
                                <div>
                                    <label style={{ fontSize: '0.6875rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '6px', display: 'block' }}>🕐 Horário</label>
                                    <input type="time" step="1800" value={editForm.startTime}
                                        onChange={e => setEditForm({ ...editForm, startTime: e.target.value })}
                                        style={{
                                            width: '100%', padding: '9px 12px', borderRadius: '10px', fontSize: '0.8125rem', fontWeight: 600,
                                            background: 'var(--bg-elevated)', border: '1px solid var(--border-default)',
                                            color: 'var(--text-primary)', outline: 'none',
                                        }}
                                    />
                                </div>
                            </div>

                            {/* Status */}
                            <div style={{ marginBottom: '16px' }}>
                                <label style={{ fontSize: '0.6875rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '8px', display: 'block' }}>Status</label>
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                                    {Object.entries(STATUS_CONFIG).map(([key, cfg]) => (
                                        <button key={key}
                                            onClick={() => setEditForm({ ...editForm, status: key })}
                                            style={{
                                                padding: '6px 12px', borderRadius: '8px', fontSize: '0.6875rem', fontWeight: 600, cursor: 'pointer',
                                                background: editForm.status === key ? cfg.bg : 'var(--bg-elevated)',
                                                border: `1px solid ${editForm.status === key ? cfg.color + '44' : 'var(--border-default)'}`,
                                                color: editForm.status === key ? cfg.color : 'var(--text-muted)',
                                                transition: 'all 0.15s',
                                            }}
                                        >
                                            {cfg.icon} {cfg.label}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {/* Info summary */}
                            <div style={{
                                padding: '10px 14px', borderRadius: '10px', marginBottom: '16px',
                                background: 'rgba(16,185,129,0.04)', border: '1px solid rgba(16,185,129,0.1)',
                                fontSize: '0.75rem', color: 'var(--text-muted)',
                                display: 'flex', justifyContent: 'space-between',
                            }}>
                                <span>💰 Valor: <strong style={{ color: '#10b981' }}>{formatBRL(editBooking.price)}</strong></span>
                                <span>{TIER_EMOJI[editBooking.tierApplied]} {editBooking.tierApplied}</span>
                            </div>

                            {/* Actions */}
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px' }}>
                                <button onClick={() => setEditBooking(null)}
                                    style={{ padding: '9px 18px', borderRadius: '10px', background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-secondary)', fontSize: '0.8125rem', fontWeight: 600, cursor: 'pointer' }}>
                                    Cancelar
                                </button>
                                <button onClick={handleEdit}
                                    style={{
                                        padding: '10px 24px', borderRadius: '10px', border: 'none', fontSize: '0.875rem', fontWeight: 700, cursor: 'pointer',
                                        background: 'linear-gradient(135deg, #10b981, #11819B)', color: '#fff',
                                        display: 'flex', alignItems: 'center', gap: '8px',
                                    }}>
                                    💾 Salvar Alterações
                                </button>
                            </div>
                        </div>
                    </div>
                </ModalOverlay>
            )}
        </div>
    );
}

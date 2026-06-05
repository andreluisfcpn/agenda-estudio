import { getErrorMessage } from '../utils/errors';
import { useState, useMemo } from 'react';
import { bookingsApi, BookingWithUser } from '../api/client';
import { useNavigate } from 'react-router-dom';
import { useUI } from '../context/UIContext';
import { ClipboardList } from 'lucide-react';
import AdminPageHeader from '../components/admin/AdminPageHeader';
import { HeroSkeleton, TableSkeleton } from '../components/ui/SkeletonLoader';
import StatusBadge from '../components/ui/StatusBadge';
import { TIER_META, BOOKING_STATUS_META, getMeta } from '../constants/adminMeta';
import { formatBRL } from '../utils/format';
import { useAdminBookings } from '../hooks/useAdminBookings';
import CreateBookingModal from '../components/admin/bookings/CreateBookingModal';
import EditBookingModal from '../components/admin/bookings/EditBookingModal';

export default function AdminBookingsPage() {
    const navigate = useNavigate();
    const { showAlert, showConfirm, showToast } = useUI();
    const { bookings, setBookings, users, loading, dateFilter, setDateFilter, statusFilter, setStatusFilter, reload } = useAdminBookings();
    const [searchQuery, setSearchQuery] = useState('');

    const [showCreate, setShowCreate] = useState(false);
    const [editBooking, setEditBooking] = useState<BookingWithUser | null>(null);

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
                    await reload();
                } catch (err: unknown) { showAlert({ message: getErrorMessage(err), type: 'error' }); }
            }
        });
    };

    const handleInlineStatusChange = async (id: string, newStatus: string) => {
        try {
            await bookingsApi.update(id, { status: newStatus });
            // Optimistic local patch (no refetch) — keeps the row visible even
            // under an active status filter and avoids a full table reload flash.
            setBookings(prev => prev.map(b => b.id === id ? { ...b, status: newStatus as any } : b));
        } catch (err: unknown) { showAlert({ message: getErrorMessage(err), type: 'error' }); }
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
            {/* --- HEADER --- */}
            <AdminPageHeader
                icon={ClipboardList}
                title="Agendamentos"
                subtitle="Gerencie todos os agendamentos do estúdio"
                actions={
                    <button className="btn btn-primary" onClick={() => setShowCreate(true)}
                        style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '12px 24px', borderRadius: '12px', fontWeight: 700 }}>
                        <span style={{ fontSize: '1.1rem' }}>+</span> Novo Agendamento
                    </button>
                }
            />

            {/* --- KPI CARDS --- */}
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

            {/* --- SEARCH + FILTERS --- */}
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
                    <span style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', fontSize: '0.75rem', opacity: 0.5 }}>🔎</span>
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
                        🧹 Limpar
                    </button>
                )}

                <span style={{
                    marginLeft: 'auto', fontSize: '0.75rem', color: 'var(--text-muted)',
                    padding: '4px 10px', background: 'var(--bg-elevated)', borderRadius: '8px'
                }}>
                    {filtered.length} resultado{filtered.length !== 1 ? 's' : ''}
                </span>
            </div>

            {/* --- BOOKINGS TABLE --- */}
            {loading ? (
                <div><HeroSkeleton /><TableSkeleton rows={6} cols={7} /></div>
            ) : (
                <div style={{ borderRadius: '16px', border: '1px solid var(--border-color)', background: 'var(--bg-secondary)', overflow: 'hidden' }}>
                    {filtered.length === 0 ? (
                        <div style={{ padding: '48px 20px', textAlign: 'center', color: 'var(--text-muted)' }}>
                            <div style={{ fontSize: '2.5rem', marginBottom: '12px', opacity: 0.4 }}>😴</div>
                            <div style={{ fontWeight: 600 }}>Nenhum agendamento encontrado</div>
                            <div style={{ fontSize: '0.8125rem', marginTop: '4px' }}>Tente ajustar os filtros ou período</div>
                        </div>
                    ) : (
                        <div className="table-container" style={{ margin: 0 }}>
                            <div className="admin-table-wrap">
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
                                        const sc = getMeta(BOOKING_STATUS_META, b.status);
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
                                                        <span style={{ fontSize: '0.6875rem' }}>⏰</span>
                                                        {b.startTime} – {b.endTime}
                                                    </div>
                                                </td>

                                                {/* Contract */}
                                                <td>
                                                    {b.contract ? (
                                                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                                            <StatusBadge meta={getMeta(TIER_META, b.contract.tier)} label={b.contract.name} />
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
                                                            {Object.entries(BOOKING_STATUS_META).filter(([key]) => key !== 'HELD').map(([key, cfg]) => (
                                                                <option key={key} value={key} style={{ background: '#0a1a1f', color: cfg.color, padding: '6px' }}>{cfg.label}</option>
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
                                                        onClick={() => setEditBooking(b)}>
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
                        </div>
                    )}
                </div>
            )}

            {/* -------------------------------------------------------
               MODALS (preserved from original)
            ------------------------------------------------------- */}

            {showCreate && (
                <CreateBookingModal
                    isOpen
                    onClose={() => setShowCreate(false)}
                    users={users}
                    onCreated={reload}
                />
            )}

            <EditBookingModal
                booking={editBooking}
                onClose={() => setEditBooking(null)}
                onSaved={reload}
            />
        </div>
    );
}

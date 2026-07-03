import { getErrorMessage } from '../utils/errors';
import { useState, useMemo } from 'react';
import { bookingsApi, BookingWithUser } from '../api/client';
import { useNavigate } from 'react-router-dom';
import { useUI } from '../context/UIContext';
import { ClipboardList, Search, FilterX, Pencil, Trash2, Clock, Moon } from 'lucide-react';
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
            title: 'Excluir Agendamento Permanentemente',
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
                    <button className="btn-admin-go" onClick={() => setShowCreate(true)}>
                        <span style={{ fontSize: '1.1rem' }} aria-hidden="true">+</span> Novo Agendamento
                    </button>
                }
            />

            {/* --- KPI CARDS --- */}
            <div className="admin-kpi-grid">
                <div className="admin-kpi-card admin-kpi-card--accent">
                    <div className="admin-kpi-card__label">Total</div>
                    <div className="admin-kpi-card__value">{kpis.total}</div>
                    <div className="admin-kpi-card__caption">agendamentos</div>
                </div>
                <div className="admin-kpi-card">
                    <div className="admin-kpi-card__label" style={{ color: 'var(--info)' }}>Confirmados</div>
                    <div className="admin-kpi-card__value">{kpis.confirmed}</div>
                    <div className="admin-kpi-card__caption">a realizar</div>
                </div>
                <div className="admin-kpi-card">
                    <div className="admin-kpi-card__label" style={{ color: 'var(--success)' }}>Concluídos</div>
                    <div className="admin-kpi-card__value">{kpis.completed}</div>
                    <div className="admin-kpi-card__caption">realizados</div>
                </div>
                <div className={`admin-kpi-card${kpis.cancelled > 0 ? ' admin-kpi-card--danger' : ''}`}>
                    <div className="admin-kpi-card__label" style={{ color: 'var(--danger)' }}>Cancelados</div>
                    <div className="admin-kpi-card__value" style={kpis.cancelled > 0 ? { color: 'var(--danger)' } : undefined}>{kpis.cancelled}</div>
                    <div className="admin-kpi-card__caption">cancelados + faltas</div>
                </div>
                <div className="admin-kpi-card admin-kpi-card--success">
                    <div className="admin-kpi-card__label" style={{ color: 'var(--success)' }}>Receita</div>
                    <div className="admin-kpi-card__value admin-kpi-card__value--sm">{formatBRL(kpis.revenue)}</div>
                    <div className="admin-kpi-card__caption">confirmados + concluídos</div>
                </div>
            </div>

            {/* --- SEARCH + FILTERS --- */}
            <div className="admin-filter-bar admin-filter-bar--panel">
                <div className="admin-search">
                    <input
                        type="text" placeholder="Buscar por nome ou e-mail..."
                        aria-label="Buscar por nome ou e-mail"
                        value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
                    />
                    <Search size={14} className="admin-search__icon" aria-hidden="true" />
                </div>

                {/* Date filter */}
                <input type="date" value={dateFilter} onChange={e => setDateFilter(e.target.value)}
                    aria-label="Filtrar por data"
                    className="form-input form-input--raised"
                    style={{ maxWidth: '160px', fontSize: '0.8125rem' }}
                />

                {/* Status filter pills */}
                <div className="admin-segmented" role="group" aria-label="Filtrar por status">
                    {[
                        { key: '', label: 'Todos' },
                        { key: 'CONFIRMED', label: 'Confirmados' },
                        { key: 'COMPLETED', label: 'Concluídos' },
                        { key: 'RESERVED', label: 'Reservados' },
                        { key: 'CANCELLED', label: 'Cancelados' },
                    ].map(s => (
                        <button key={s.key}
                            onClick={() => setStatusFilter(s.key)}
                            aria-pressed={statusFilter === s.key}
                            className={`admin-segmented__btn${statusFilter === s.key ? ' admin-segmented__btn--active' : ''}`}
                        >
                            {s.label}
                        </button>
                    ))}
                </div>

                {(dateFilter || statusFilter || searchQuery) && (
                    <button className="admin-filter-clear" onClick={() => { setDateFilter(''); setStatusFilter(''); setSearchQuery(''); }}>
                        <FilterX size={14} aria-hidden="true" /> Limpar
                    </button>
                )}

                <span style={{
                    marginLeft: 'auto', fontSize: '0.75rem', color: 'var(--text-muted)',
                    padding: '4px 10px', background: 'var(--bg-elevated)', borderRadius: '8px'
                }} aria-live="polite">
                    {filtered.length} resultado{filtered.length !== 1 ? 's' : ''}
                </span>
            </div>

            {/* --- BOOKINGS TABLE --- */}
            {loading ? (
                <div><HeroSkeleton /><TableSkeleton rows={6} cols={7} /></div>
            ) : (
                <div style={{ borderRadius: '16px', border: '1px solid var(--border-color)', background: 'var(--bg-secondary)', overflow: 'hidden' }}>
                    {filtered.length === 0 ? (
                        <div className="admin-empty">
                            <Moon size={44} className="admin-empty__icon" aria-hidden="true" />
                            <div className="admin-empty__title">Nenhum agendamento encontrado</div>
                            <div className="admin-empty__hint">Tente ajustar os filtros ou período</div>
                        </div>
                    ) : (
                        <div className="table-container" style={{ margin: 0 }}>
                            <div className="admin-table-wrap">
                            <table className="admin-table--cards">
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
                                    {filtered.map((b) => {
                                        const sc = getMeta(BOOKING_STATUS_META, b.status);
                                        const dateObj = new Date(b.date);
                                        const dayStr = dateObj.toLocaleDateString('pt-BR', { timeZone: 'UTC', weekday: 'short', day: '2-digit', month: '2-digit' });
                                        const createdStr = b.createdAt ? new Date(b.createdAt).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
                                        return (
                                            <tr key={b.id} className="admin-zebra-row">
                                                {/* Client */}
                                                <td className="admin-card-title" style={{ paddingLeft: '20px' }}>
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
                                                            <button
                                                                style={{ fontWeight: 600, fontSize: '0.875rem', cursor: 'pointer', color: 'var(--accent-text)', background: 'none', border: 'none', padding: 0, fontFamily: 'inherit', textAlign: 'left' }}
                                                                title={`Abrir perfil de ${b.user.name}`}
                                                                onClick={() => navigate(`/admin/clients/${b.user.id}`)}>
                                                                {b.user.name}
                                                            </button>
                                                            <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', marginTop: '1px' }}>
                                                                {b.user.email}
                                                            </div>
                                                        </div>
                                                    </div>
                                                </td>

                                                {/* Date + Time */}
                                                <td data-label="Quando">
                                                    <div style={{ fontWeight: 600, fontSize: '0.875rem' }}>{dayStr}</div>
                                                    <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '2px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                                                        <Clock size={12} aria-hidden="true" />
                                                        {b.startTime} – {b.endTime}
                                                    </div>
                                                </td>

                                                {/* Contract */}
                                                <td data-label="Contrato">
                                                    {b.contract ? (
                                                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                                            <StatusBadge meta={getMeta(TIER_META, b.contract.tier)} label={b.contract.name} />
                                                        </div>
                                                    ) : (
                                                        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>—</span>
                                                    )}
                                                </td>

                                                {/* Created at */}
                                                <td data-label="Agendado">
                                                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{createdStr}</div>
                                                </td>

                                                {/* Valor */}
                                                <td data-label="Valor" style={{ textAlign: 'right', fontWeight: 700, fontSize: '0.875rem', fontVariantNumeric: 'tabular-nums', color: 'var(--success)' }}>
                                                    {formatBRL(b.price)}
                                                </td>

                                                {/* Status - premium inline select */}
                                                <td data-label="Status" style={{ textAlign: 'center' }}>
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
                                                            aria-label={`Status do agendamento de ${b.user.name}`}
                                                            className="admin-status-select"
                                                            style={{ color: sc.color }}
                                                        >
                                                            {Object.entries(BOOKING_STATUS_META).filter(([key]) => key !== 'HELD').map(([key, cfg]) => (
                                                                <option key={key} value={key} style={{ background: 'var(--sheet-bg)', color: cfg.color, padding: '6px' }}>{cfg.label}</option>
                                                            ))}
                                                        </select>
                                                    </div>
                                                </td>

                                                {/* Actions */}
                                                <td data-label="" style={{ textAlign: 'center' }}>
                                                    <div style={{ display: 'flex', gap: '4px', justifyContent: 'center' }}>
                                                        <button className="admin-icon-btn admin-icon-btn--success"
                                                            aria-label={`Editar agendamento de ${b.user.name}`}
                                                            onClick={() => setEditBooking(b)}>
                                                            <Pencil size={16} aria-hidden="true" />
                                                        </button>
                                                        <button className="admin-icon-btn admin-icon-btn--danger"
                                                            aria-label={`Excluir permanentemente agendamento de ${b.user.name}`}
                                                            onClick={() => handleHardDelete(b)}>
                                                            <Trash2 size={16} aria-hidden="true" />
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

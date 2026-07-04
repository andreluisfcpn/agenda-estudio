import { getErrorMessage } from '../../../utils/errors';
import { useState, useEffect } from 'react';
import { bookingsApi, contractsApi, usersApi, BookingWithUser, Contract, UserSummary } from '../../../api/client';
import { useUI } from '../../../context/UIContext';
import { useNavigate } from 'react-router-dom';
import StatusBadge from '../../ui/StatusBadge';
import AdminPageHeader from '../AdminPageHeader';
import { DashboardSkeleton } from '../../ui/SkeletonLoader';
import {
    CalendarDays, LayoutDashboard, Flag, XCircle, ClipboardCheck, AlertTriangle,
    AlertCircle, Clock, CheckCircle2, TrendingUp, CalendarClock, Target, Moon,
} from 'lucide-react';
import { TIER_META, BOOKING_STATUS_META, getMeta } from '../../../constants/adminMeta';
import { formatBRL, DAY_NAMES, getInitials } from '../../../utils/format';
import { todayStrSaoPaulo } from '../../../utils/time';
import { STUDIO_SLOTS } from '../../../constants/slots';


function getMonthRange(): { start: Date; end: Date } {
    const now = new Date();
    return {
        start: new Date(now.getFullYear(), now.getMonth(), 1),
        end: new Date(now.getFullYear(), now.getMonth() + 1, 0),
    };
}

function getWeekDates(): Date[] {
    const d = new Date();
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    const start = new Date(d);
    start.setDate(diff);
    const dates: Date[] = [];
    for (let i = 0; i < 6; i++) {
        dates.push(new Date(start));
        start.setDate(start.getDate() + 1);
    }
    return dates;
}

function daysUntil(dateStr: string): number {
    const target = new Date(dateStr.split('T')[0] + 'T12:00:00');
    const now = new Date();
    return Math.ceil((target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}

// ─── Admin Dashboard ──────────────────────────────────────

export default function AdminDashboard() {
    const navigate = useNavigate();
    const { showToast } = useUI();
    const [allBookings, setAllBookings] = useState<BookingWithUser[]>([]);
    const [allContracts, setAllContracts] = useState<Contract[]>([]);
    const [allUsers, setAllUsers] = useState<UserSummary[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => { loadAll(); }, []);

    const loadAll = async () => {
        setLoading(true);
        try {
            const [bRes, cRes, uRes] = await Promise.all([
                bookingsApi.getAll(),
                contractsApi.getAll(),
                usersApi.getAll(),
            ]);
            setAllBookings(bRes.bookings);
            setAllContracts(cRes.contracts);
            setAllUsers(uRes.users);
        } catch (err) { console.error(err); }
        finally { setLoading(false); }
    };

    const handleQuickAction = async (id: string, action: 'checkin' | 'complete' | 'falta') => {
        try {
            let res;
            if (action === 'checkin') res = await bookingsApi.checkIn(id);
            else if (action === 'complete') res = await bookingsApi.complete(id);
            else res = await bookingsApi.markFalta(id);
            showToast(res.message);
            await loadAll();
        } catch (err: unknown) { showToast(getErrorMessage(err) || 'Erro ao atualizar.'); }
    };

    if (loading) return <DashboardSkeleton />;

    const today = todayStrSaoPaulo();
    const now = new Date();
    const { start: monthStart, end: monthEnd } = getMonthRange();
    const weekDates = getWeekDates();

    // ── Computations ──
    const todaysBookings = allBookings.filter(b => b.date.split('T')[0] === today && b.status !== 'CANCELLED');
    const isSunday = new Date().getDay() === 0;

    const monthBookings = allBookings.filter(b => {
        const d = new Date(b.date.split('T')[0]);
        return d >= monthStart && d <= monthEnd && b.status !== 'CANCELLED';
    });
    const monthRevenue = monthBookings.filter(b => b.status === 'CONFIRMED' || b.status === 'COMPLETED').reduce((s, b) => s + b.price, 0);

    const completedThisMonth = monthBookings.filter(b => b.status === 'COMPLETED').length;
    const noShowsThisMonth = monthBookings.filter(b => b.status === 'FALTA' || b.status === 'NAO_REALIZADO').length;
    const attendanceRate = completedThisMonth + noShowsThisMonth > 0 ? Math.round((completedThisMonth / (completedThisMonth + noShowsThisMonth)) * 100) : 100;

    const activeContracts = allContracts.filter(c => c.status === 'ACTIVE');
    const pendingCancellations = allContracts.filter(c => c.status === 'PENDING_CANCELLATION');
    const expiringContracts = activeContracts.filter(c => daysUntil(c.endDate) <= 7 && daysUntil(c.endDate) >= 0);
    const unconfirmedToday = todaysBookings.filter(b => b.status === 'RESERVED');

    // Week occupancy
    const weekOccupancy = weekDates.map(d => {
        const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const dayOfWeek = d.getDay();
        if (dayOfWeek === 0) return { date: ds, day: DAY_NAMES[dayOfWeek], pct: 0, count: 0, total: 0, closed: true };
        const count = allBookings.filter(b => b.date.split('T')[0] === ds && b.status !== 'CANCELLED').length;
        return { date: ds, day: DAY_NAMES[dayOfWeek], pct: Math.round((count / 5) * 100), count, total: 5, closed: false };
    });

    // Next 5 upcoming bookings
    const futureBookings = allBookings
        .filter(b => {
            const dt = new Date(`${b.date.split('T')[0]}T${b.startTime}:00`);
            return dt > now && (b.status === 'RESERVED' || b.status === 'CONFIRMED');
        })
        .sort((a, b) => new Date(`${a.date.split('T')[0]}T${a.startTime}`).getTime() - new Date(`${b.date.split('T')[0]}T${b.startTime}`).getTime())
        .slice(0, 5);

    // Churn risk: active contract clients who haven't booked in 14 days
    const clientsWithActiveContracts = new Set(activeContracts.map(c => c.user?.id).filter(Boolean));
    const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
    const churnRisk = allUsers
        .filter(u => clientsWithActiveContracts.has(u.id))
        .filter(u => {
            const userBookings = allBookings.filter(b => b.user?.id === u.id && b.status !== 'CANCELLED');
            if (userBookings.length === 0) return true;
            const lastBooking = userBookings.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())[0];
            return new Date(lastBooking.date) < fourteenDaysAgo;
        });

    const totalAlerts = expiringContracts.length + pendingCancellations.length + unconfirmedToday.length;

    // ── Slot enrichment for today ──
    const todaySlots = STUDIO_SLOTS.map(slot => {
        const booking = todaysBookings.find(b => b.startTime === slot.time);
        return { ...slot, booking: booking || null };
    });

    return (
        <div aria-label="Painel principal">
            {/* ─── HEADER (padrão AdminPageHeader) ─── */}
            <AdminPageHeader
                icon={LayoutDashboard}
                title="Centro de Comando"
                subtitle={new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' })}
            />
            {/* ── SECTION 1: Agenda do Dia (Hero) ────────────────── */}
            <div className="admin-card admin-card--lg dash-agenda-card">
                <div className="dash-card-head">
                    <div className="dash-card-head__title">
                        <h2 className="dash-panel__title dash-panel__title--lg">
                            <CalendarDays size={18} style={{ color: 'var(--accent-primary)' }} aria-hidden="true" /> Agenda de Hoje
                        </h2>
                        <p className="dash-panel__sub">
                            {todaysBookings.length} de 5 slots ocupados
                        </p>
                    </div>
                    <button onClick={() => navigate('/calendar')} className="dash-card-head__action btn-admin-ghost btn-admin-ghost--compact">
                        Ver Agenda Completa →
                    </button>
                </div>

                {isSunday ? (
                    <div className="admin-empty">
                        <Moon size={40} className="admin-empty__icon" aria-hidden="true" />
                        <div className="admin-empty__title">Estúdio fechado aos domingos</div>
                    </div>
                ) : (
                    <div className="dash-panel__list">
                        {todaySlots.map(slot => {
                            const b = slot.booking;
                            const isPast = new Date(`${today}T${slot.end}:00`) < now;
                            return (
                                <div key={slot.time} className={`dash-slot${b ? ' dash-slot--filled' : ''}${isPast && !b ? ' dash-slot--past' : ''}`}>
                                    {/* Time column */}
                                    <div className="dash-slot__time">{slot.label}</div>

                                    {/* Divider */}
                                    <div className="dash-slot__bar" />

                                    {/* Content */}
                                    <div className="dash-slot__main">
                                        {b ? (
                                            <>
                                                <button className="dash-name-btn"
                                                    title={`Abrir perfil de ${b.user.name}`}
                                                    onClick={() => navigate(`/admin/clients/${b.user.id}`)}>
                                                    {b.user.name}
                                                </button>
                                                <StatusBadge meta={getMeta(TIER_META, b.tierApplied)} />
                                                <StatusBadge meta={getMeta(BOOKING_STATUS_META, b.status)} />
                                                <span className="dash-slot__price">{formatBRL(b.price)}</span>
                                            </>
                                        ) : (
                                            <span className="dash-slot__free">
                                                {isPast ? 'Horário encerrado' : '— Disponível —'}
                                            </span>
                                        )}
                                    </div>

                                    {/* Quick Actions */}
                                    {b && b.status === 'RESERVED' && !isPast && (
                                        <div className="dash-slot__actions">
                                            <button className="today-action-btn today-action-btn--info" title="Check-in (Confirmar Presença)"
                                                onClick={() => handleQuickAction(b.id, 'checkin')}>
                                                <ClipboardCheck size={14} aria-hidden="true" /> Check-in
                                            </button>
                                            <button className="today-action-btn today-action-btn--danger" title="Registrar Falta"
                                                aria-label="Registrar falta"
                                                onClick={() => handleQuickAction(b.id, 'falta')}>
                                                <XCircle size={15} aria-hidden="true" />
                                            </button>
                                        </div>
                                    )}
                                    {b && b.status === 'CONFIRMED' && !isPast && (
                                        <div className="dash-slot__actions">
                                            <button className="today-action-btn today-action-btn--success" title="Finalizar Sessão"
                                                onClick={() => handleQuickAction(b.id, 'complete')}>
                                                <Flag size={14} aria-hidden="true" /> Finalizar
                                            </button>
                                            <button className="today-action-btn today-action-btn--danger" title="Registrar Falta"
                                                aria-label="Registrar falta"
                                                onClick={() => handleQuickAction(b.id, 'falta')}>
                                                <XCircle size={15} aria-hidden="true" />
                                            </button>
                                        </div>
                                    )}

                                    {b && b.status === 'COMPLETED' && (
                                        <span className="dash-status-chip dash-status-chip--success"><Flag size={13} aria-hidden="true" /> Concluído</span>
                                    )}
                                    {b && b.status === 'FALTA' && (
                                        <span className="dash-status-chip dash-status-chip--danger"><XCircle size={13} aria-hidden="true" /> Falta</span>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* ── SECTION 2: KPIs (2 colunas mobile · 4 desktop; padrão .admin-kpi-card) ─── */}
            <div className="dash-kpi-grid">
                {[
                    { label: 'Receita do Mês', value: formatBRL(monthRevenue), sub: `${monthBookings.length} agendamentos`, mod: ' admin-kpi-card--success' },
                    { label: 'Ocupação Hoje', value: isSunday ? '—' : `${todaysBookings.length}/5`, sub: isSunday ? 'Fechado' : `${Math.round((todaysBookings.length / 5) * 100)}% dos slots`, mod: '' },
                    { label: 'Taxa de Presença', value: `${attendanceRate}%`, sub: `${completedThisMonth} concluídas, ${noShowsThisMonth} faltas`, mod: attendanceRate >= 80 ? ' admin-kpi-card--success' : ' admin-kpi-card--danger' },
                    { label: 'Contratos Ativos', value: `${activeContracts.length}`, sub: `${allUsers.filter(u => u.role !== 'ADMIN').length} clientes cadastrados`, mod: ' admin-kpi-card--accent' },
                ].map((kpi, i) => (
                    <div key={i} className={`admin-kpi-card${kpi.mod}`}>
                        <div className="admin-kpi-card__label">{kpi.label}</div>
                        <div className="admin-kpi-card__value admin-kpi-card__value--sm">{kpi.value}</div>
                        <div className="admin-kpi-card__caption">{kpi.sub}</div>
                    </div>
                ))}
            </div>

            {/* ── SECTION 3: Alertas + Ocupação Semanal ────────── */}
            <div className="admin-grid-2" style={{ marginBottom: '24px' }}>

                {/* Alerts */}
                <div className="admin-card dash-panel">
                    <h3 className="dash-panel__title">
                        <AlertTriangle size={18} style={{ color: 'var(--danger)' }} aria-hidden="true" /> Alertas
                        {totalAlerts > 0 && (
                            <span className="dash-count-badge dash-count-badge--danger">{totalAlerts}</span>
                        )}
                    </h3>

                    {totalAlerts === 0 ? (
                        <div className="admin-empty">
                            <CheckCircle2 size={36} className="admin-empty__icon" aria-hidden="true" />
                            <div className="admin-empty__title">Tudo em ordem!</div>
                        </div>
                    ) : (
                        <div className="dash-panel__list dash-panel__list--lg">
                            {expiringContracts.map(c => (
                                <div key={c.id} className="dash-alert dash-alert--danger">
                                    <AlertCircle size={18} className="dash-alert__icon" aria-hidden="true" />
                                    <div className="dash-alert__body">
                                        <div className="dash-alert__title">
                                            Contrato de <button type="button" className="dash-inline-link" onClick={() => c.user?.id && navigate(`/admin/clients/${c.user.id}`)}>{c.user?.name}</button> expira em {daysUntil(c.endDate)} dia(s)
                                        </div>
                                        <div className="dash-alert__sub">{c.type} · {c.tier}</div>
                                    </div>
                                </div>
                            ))}

                            {pendingCancellations.map(c => (
                                <div key={c.id} className="dash-alert dash-alert--warning">
                                    <AlertTriangle size={18} className="dash-alert__icon" aria-hidden="true" />
                                    <div className="dash-alert__body">
                                        <div className="dash-alert__title">
                                            Cancelamento pendente: <button type="button" className="dash-inline-link" onClick={() => navigate('/admin/contracts')}>{c.user?.name}</button>
                                        </div>
                                        <div className="dash-alert__sub">Aguardando resolução (multa ou isenção)</div>
                                    </div>
                                </div>
                            ))}

                            {unconfirmedToday.map(b => (
                                <div key={b.id} className="dash-alert dash-alert--warning">
                                    <Clock size={18} className="dash-alert__icon" aria-hidden="true" />
                                    <div className="dash-alert__body">
                                        <div className="dash-alert__title">
                                            {b.user.name} às {b.startTime} — ainda sem confirmação
                                        </div>
                                    </div>
                                    <button className="today-action-btn today-action-btn--success"
                                        onClick={() => handleQuickAction(b.id, 'checkin')}>
                                        Confirmar
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* Weekly Occupancy */}
                <div className="admin-card dash-panel">
                    <h3 className="dash-panel__title"><TrendingUp size={18} style={{ color: 'var(--accent-text)' }} aria-hidden="true" /> Ocupação da Semana</h3>
                    <div className="dash-panel__list dash-panel__list--lg">
                        {weekOccupancy.map(d => (
                            <div key={d.date} className="dash-occ">
                                <span className={`dash-occ__day${d.date === today ? ' dash-occ__day--today' : ''}`}>
                                    {d.day}
                                </span>
                                <div className="dash-occ__track">
                                    {!d.closed && (
                                        <div
                                            className={`dash-occ__fill ${d.pct > 80 ? 'dash-occ__fill--high' : d.pct > 60 ? 'dash-occ__fill--mid' : 'dash-occ__fill--low'}`}
                                            style={{ width: `${d.pct}%` }}
                                        />
                                    )}
                                </div>
                                <span className={`dash-occ__count${d.closed ? ' dash-occ__count--closed' : ''}`}>
                                    {d.closed ? 'Fech.' : `${d.count}/${d.total}`}
                                </span>
                            </div>
                        ))}
                    </div>
                </div>
            </div>

            {/* ── SECTION 4: Próximos Agendamentos + Churn Risk ── */}
            <div className="admin-grid-2">

                {/* Next Bookings */}
                <div className="admin-card dash-panel">
                    <h3 className="dash-panel__title"><CalendarClock size={18} style={{ color: 'var(--accent-text)' }} aria-hidden="true" /> Próximos Agendamentos</h3>
                    {futureBookings.length === 0 ? (
                        <div className="admin-empty">
                            <CalendarDays size={36} className="admin-empty__icon" aria-hidden="true" />
                            <div className="admin-empty__title">Nenhum agendamento futuro</div>
                            <button className="btn-admin-ghost btn-admin-ghost--compact" onClick={() => navigate('/calendar')}>
                                Abrir agenda
                            </button>
                        </div>
                    ) : (
                        <div className="dash-panel__list">
                            {futureBookings.map(b => (
                                <div key={b.id} className="dash-row">
                                    <div className="dash-row__date">
                                        {new Date(b.date).toLocaleDateString('pt-BR', { timeZone: 'UTC', day: '2-digit', month: '2-digit' })}
                                    </div>
                                    <div className="dash-row__time">{b.startTime}</div>
                                    <div className="dash-row__body">
                                        <button className="dash-name-btn dash-name-btn--sm dash-name-btn--ellipsis"
                                            title={`Abrir perfil de ${b.user.name}`}
                                            onClick={() => navigate(`/admin/clients/${b.user.id}`)}>
                                            {b.user.name}
                                        </button>
                                    </div>
                                    <StatusBadge meta={getMeta(TIER_META, b.tierApplied)} size="sm" />
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* Churn Risk */}
                <div className="admin-card dash-panel">
                    <h3 className="dash-panel__title">
                        <AlertTriangle size={18} style={{ color: 'var(--warning)' }} aria-hidden="true" /> Clientes em Risco
                        {churnRisk.length > 0 && (
                            <span className="dash-count-badge dash-count-badge--warning">{churnRisk.length}</span>
                        )}
                    </h3>
                    {churnRisk.length === 0 ? (
                        <div className="admin-empty">
                            <Target size={36} className="admin-empty__icon" aria-hidden="true" />
                            <div className="admin-empty__title">Todos os clientes engajados!</div>
                        </div>
                    ) : (
                        <div className="dash-panel__list">
                            {churnRisk.slice(0, 5).map(u => {
                                const userContract = activeContracts.find(c => c.user?.id === u.id);
                                const userBookings = allBookings.filter(b => b.user?.id === u.id && b.status !== 'CANCELLED').sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
                                const lastDate = userBookings[0] ? new Date(userBookings[0].date).toLocaleDateString('pt-BR', { timeZone: 'UTC', day: '2-digit', month: '2-digit' }) : 'Nunca agendou';

                                return (
                                    <div key={u.id} className="dash-row dash-row--warning">
                                        <div className="admin-avatar">{getInitials(u.name)}</div>
                                        <div className="dash-row__body">
                                            <button className="dash-name-btn dash-name-btn--sm"
                                                onClick={() => navigate(`/admin/clients/${u.id}`)}>
                                                {u.name}
                                            </button>
                                            <div className="dash-row__sub">
                                                Último agendamento: {lastDate} · {userContract?.type || '—'}
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

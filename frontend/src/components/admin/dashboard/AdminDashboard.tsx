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
            <div style={{ height: 24 }} />

            {/* ── SECTION 1: Agenda do Dia (Hero) ────────────────── */}
            <div className="admin-card admin-card--lg" style={{ marginBottom: '24px', borderTop: '3px solid var(--accent-primary)' }}>
                <div className="dash-card-head">
                    <div className="dash-card-head__title">
                        <h2 style={{ fontSize: '1.125rem', fontWeight: 700, margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <CalendarDays size={18} style={{ color: 'var(--accent-primary)' }} aria-hidden="true" /> Agenda de Hoje
                        </h2>
                        <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                            {todaysBookings.length} de 5 slots ocupados
                        </p>
                    </div>
                    <button onClick={() => navigate('/calendar')} className="dash-card-head__action btn-admin-ghost" style={{ minHeight: 38, padding: '8px 16px', fontSize: '0.75rem' }}>
                        Ver Agenda Completa →
                    </button>
                </div>

                {isSunday ? (
                    <div className="admin-empty" style={{ padding: '32px 20px' }}>
                        <Moon size={40} className="admin-empty__icon" aria-hidden="true" />
                        <div className="admin-empty__title">Estúdio fechado aos domingos</div>
                    </div>
                ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        {todaySlots.map(slot => {
                            const b = slot.booking;
                            const isPast = new Date(`${today}T${slot.end}:00`) < now;
                            return (
                                <div key={slot.time} style={{
                                    display: 'flex', alignItems: 'center', gap: '12px',
                                    padding: '12px 16px', borderRadius: '12px',
                                    background: b ? 'rgba(255,255,255,0.03)' : 'transparent',
                                    border: `1px solid ${b ? 'var(--border-color)' : 'var(--border-subtle)'}`,
                                    opacity: isPast && !b ? 0.4 : 1,
                                    transition: 'background 0.2s ease, border-color 0.2s ease',
                                }}>
                                    {/* Time column */}
                                    <div style={{ minWidth: 110, fontWeight: 700, fontSize: '0.9375rem', fontFamily: 'monospace', color: 'var(--text-secondary)' }}>
                                        {slot.label}
                                    </div>

                                    {/* Divider */}
                                    <div style={{ width: 3, height: 32, borderRadius: 2, background: b ? 'var(--accent-primary)' : 'var(--border-subtle)' }} />

                                    {/* Content */}
                                    <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                                        {b ? (
                                            <>
                                                <button style={{ fontWeight: 600, cursor: 'pointer', color: 'var(--text-primary)', background: 'none', border: 'none', padding: 0, fontFamily: 'inherit', fontSize: '0.875rem', textAlign: 'left' }}
                                                    title={`Abrir perfil de ${b.user.name}`}
                                                    onClick={() => navigate(`/admin/clients/${b.user.id}`)}>
                                                    {b.user.name}
                                                </button>
                                                <StatusBadge meta={getMeta(TIER_META, b.tierApplied)} />
                                                <StatusBadge meta={getMeta(BOOKING_STATUS_META, b.status)} />
                                                <span style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', marginLeft: 'auto', fontVariantNumeric: 'tabular-nums' }}>
                                                    {formatBRL(b.price)}
                                                </span>
                                            </>
                                        ) : (
                                            <span style={{ color: 'var(--text-muted)', fontSize: '0.8125rem', fontStyle: 'italic' }}>
                                                {isPast ? 'Horário encerrado' : '— Disponível —'}
                                            </span>
                                        )}
                                    </div>

                                    {/* Quick Actions */}
                                    {b && b.status === 'RESERVED' && !isPast && (
                                        <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                                            <button className="btn btn-sm" title="Check-in (Confirmar Presença)"
                                                style={{ background: 'var(--info-bg)', color: 'var(--info)', border: 'none', padding: '6px 12px', minHeight: 34, borderRadius: '6px', fontWeight: 700, fontSize: '0.75rem', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}
                                                onClick={() => handleQuickAction(b.id, 'checkin')}>
                                                <ClipboardCheck size={14} aria-hidden="true" /> Check-in
                                            </button>
                                            <button className="btn btn-sm" title="Registrar Falta"
                                                style={{ background: 'var(--danger-bg)', color: 'var(--danger)', border: 'none', padding: '6px 12px', minHeight: 34, borderRadius: '6px', fontWeight: 700, fontSize: '0.75rem', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}
                                                aria-label="Registrar falta"
                                                onClick={() => handleQuickAction(b.id, 'falta')}>
                                                <XCircle size={15} aria-hidden="true" />
                                            </button>
                                        </div>
                                    )}
                                    {b && b.status === 'CONFIRMED' && !isPast && (
                                        <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                                            <button className="btn btn-sm" title="Finalizar Sessão"
                                                style={{ background: 'var(--success-bg)', color: 'var(--success)', border: 'none', padding: '6px 12px', minHeight: 34, borderRadius: '6px', fontWeight: 700, fontSize: '0.75rem', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}
                                                onClick={() => handleQuickAction(b.id, 'complete')}>
                                                <Flag size={14} aria-hidden="true" /> Finalizar
                                            </button>
                                            <button className="btn btn-sm" title="Registrar Falta"
                                                style={{ background: 'var(--danger-bg)', color: 'var(--danger)', border: 'none', padding: '6px 12px', minHeight: 34, borderRadius: '6px', fontWeight: 700, fontSize: '0.75rem', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}
                                                aria-label="Registrar falta"
                                                onClick={() => handleQuickAction(b.id, 'falta')}>
                                                <XCircle size={15} aria-hidden="true" />
                                            </button>
                                        </div>
                                    )}

                                    {b && b.status === 'COMPLETED' && (
                                        <span style={{ fontSize: '0.75rem', color: 'var(--success)', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}><Flag size={13} aria-hidden="true" /> Concluído</span>
                                    )}
                                    {b && b.status === 'FALTA' && (
                                        <span style={{ fontSize: '0.75rem', color: 'var(--danger)', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}><XCircle size={13} aria-hidden="true" /> Falta</span>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* ── SECTION 2: KPIs (2 colunas mobile · 4 desktop) ─── */}
            <div className="dash-kpi-grid">
                {[
                    { label: 'RECEITA DO MÊS', value: formatBRL(monthRevenue), sub: `${monthBookings.length} agendamentos`, accent: 'var(--success)', bg: 'var(--success-bg)', border: 'rgba(16,185,129,0.2)' },
                    { label: 'OCUPAÇÃO HOJE', value: isSunday ? '—' : `${todaysBookings.length}/5`, sub: isSunday ? 'Fechado' : `${Math.round((todaysBookings.length / 5) * 100)}% dos slots`, accent: todaysBookings.length >= 4 ? 'var(--success)' : todaysBookings.length >= 2 ? 'var(--warning)' : 'var(--text-secondary)', bg: 'var(--info-bg)', border: 'rgba(59,130,246,0.2)' },
                    { label: 'TAXA DE PRESENÇA', value: `${attendanceRate}%`, sub: `${completedThisMonth} concluídas, ${noShowsThisMonth} faltas`, accent: attendanceRate >= 80 ? 'var(--success)' : attendanceRate >= 60 ? 'var(--warning)' : 'var(--danger)', bg: attendanceRate >= 80 ? 'var(--success-bg)' : 'var(--danger-bg)', border: attendanceRate >= 80 ? 'rgba(16,185,129,0.2)' : 'rgba(239,68,68,0.2)' },
                    { label: 'CONTRATOS ATIVOS', value: `${activeContracts.length}`, sub: `${allUsers.filter(u => u.role !== 'ADMIN').length} clientes cadastrados`, accent: 'var(--accent-text)', bg: 'rgba(17,129,155,0.08)', border: 'rgba(17,129,155,0.2)' },
                ].map((kpi, i) => (
                    <div key={i} className="dash-kpi-card" style={{ '--card-bg': kpi.bg, '--card-border': kpi.border, '--card-accent': kpi.accent } as React.CSSProperties}>
                        <div className="dash-kpi-card__label">{kpi.label}</div>
                        <div className="dash-kpi-card__value">{kpi.value}</div>
                        <div className="dash-kpi-card__sub">{kpi.sub}</div>
                    </div>
                ))}
            </div>

            {/* ── SECTION 3: Alertas + Ocupação Semanal ────────── */}
            <div className="admin-grid-2" style={{ marginBottom: '24px' }}>

                {/* Alerts */}
                <div className="admin-card">
                    <h3 style={{ fontSize: '0.9375rem', fontWeight: 700, marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <AlertTriangle size={18} style={{ color: 'var(--danger)' }} aria-hidden="true" /> Alertas
                        {totalAlerts > 0 && (
                            <span style={{ background: 'var(--danger)', color: '#fff', fontSize: '0.7rem', fontWeight: 700, padding: '2px 8px', borderRadius: '10px', minWidth: 20, textAlign: 'center' }}>
                                {totalAlerts}
                            </span>
                        )}
                    </h3>

                    {totalAlerts === 0 ? (
                        <div className="admin-empty" style={{ padding: '20px' }}>
                            <CheckCircle2 size={36} className="admin-empty__icon" aria-hidden="true" />
                            <div className="admin-empty__title">Tudo em ordem!</div>
                        </div>
                    ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                            {expiringContracts.map(c => (
                                <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', borderRadius: '10px', background: 'var(--danger-bg)', border: '1px solid rgba(239, 68, 68, 0.2)' }}>
                                    <AlertCircle size={18} style={{ color: 'var(--danger)', flexShrink: 0 }} aria-hidden="true" />
                                    <div style={{ flex: 1 }}>
                                        <div style={{ fontSize: '0.8125rem', fontWeight: 600 }}>
                                            Contrato de <span style={{ cursor: 'pointer', color: 'var(--accent-text)' }} onClick={() => c.user?.id && navigate(`/admin/clients/${c.user.id}`)}>{c.user?.name}</span> expira em {daysUntil(c.endDate)} dia(s)
                                        </div>
                                        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{c.type} · {c.tier}</div>
                                    </div>
                                </div>
                            ))}

                            {pendingCancellations.map(c => (
                                <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', borderRadius: '10px', background: 'var(--warning-bg)', border: '1px solid rgba(245, 158, 11, 0.2)' }}>
                                    <AlertTriangle size={18} style={{ color: 'var(--warning)', flexShrink: 0 }} aria-hidden="true" />
                                    <div style={{ flex: 1 }}>
                                        <div style={{ fontSize: '0.8125rem', fontWeight: 600 }}>
                                            Cancelamento pendente: <span style={{ cursor: 'pointer', color: 'var(--accent-text)' }} onClick={() => navigate('/admin/contracts')}>{c.user?.name}</span>
                                        </div>
                                        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Aguardando resolução (multa ou isenção)</div>
                                    </div>
                                </div>
                            ))}

                            {unconfirmedToday.map(b => (
                                <div key={b.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', borderRadius: '10px', background: 'var(--warning-bg)', border: '1px solid rgba(245, 158, 11, 0.15)' }}>
                                    <Clock size={18} style={{ color: 'var(--warning)', flexShrink: 0 }} aria-hidden="true" />
                                    <div style={{ flex: 1 }}>
                                        <div style={{ fontSize: '0.8125rem', fontWeight: 600 }}>
                                            {b.user.name} às {b.startTime} — ainda sem confirmação
                                        </div>
                                    </div>
                                    <button className="btn btn-sm" style={{ background: 'var(--success-bg)', color: 'var(--success)', border: 'none', padding: '6px 12px', minHeight: 34, borderRadius: '6px', fontWeight: 700, fontSize: '0.7rem', cursor: 'pointer' }}
                                        onClick={() => handleQuickAction(b.id, 'checkin')}>
                                        Confirmar
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* Weekly Occupancy */}
                <div className="admin-card">
                    <h3 style={{ fontSize: '0.9375rem', fontWeight: 700, marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}><TrendingUp size={18} style={{ color: 'var(--accent-text)' }} aria-hidden="true" /> Ocupação da Semana</h3>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                        {weekOccupancy.map(d => (
                            <div key={d.date} style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                <span style={{ minWidth: 32, fontWeight: 600, fontSize: '0.8125rem', color: d.date === today ? 'var(--accent-primary)' : 'var(--text-secondary)' }}>
                                    {d.day}
                                </span>
                                <div style={{ flex: 1, height: 20, borderRadius: 10, background: 'var(--bg-elevated)', overflow: 'hidden', position: 'relative' }}>
                                    {!d.closed && (
                                        <div style={{
                                            width: `${d.pct}%`, height: '100%', borderRadius: 10,
                                            background: d.pct > 80 ? 'linear-gradient(90deg, #dc2626, var(--danger))' : d.pct > 60 ? 'linear-gradient(90deg, #d97706, var(--warning))' : 'linear-gradient(90deg, #10b981, #34d399)',
                                            transition: 'width 0.3s ease',
                                        }} />
                                    )}
                                </div>
                                <span style={{ minWidth: 45, textAlign: 'right', fontSize: '0.75rem', fontWeight: 700, color: d.closed ? 'var(--text-muted)' : 'var(--text-secondary)' }}>
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
                <div className="admin-card">
                    <h3 style={{ fontSize: '0.9375rem', fontWeight: 700, marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}><CalendarClock size={18} style={{ color: 'var(--accent-text)' }} aria-hidden="true" /> Próximos Agendamentos</h3>
                    {futureBookings.length === 0 ? (
                        <div className="admin-empty" style={{ padding: '20px' }}>
                            <CalendarDays size={36} className="admin-empty__icon" aria-hidden="true" />
                            <div className="admin-empty__title">Nenhum agendamento futuro</div>
                            <button className="btn-admin-ghost" style={{ minHeight: 36, padding: '6px 14px', fontSize: '0.75rem' }} onClick={() => navigate('/calendar')}>
                                Abrir agenda
                            </button>
                        </div>
                    ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                            {futureBookings.map(b => (
                                <div key={b.id} style={{
                                    display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px',
                                    borderRadius: '10px', background: 'rgba(255,255,255,0.02)',
                                    border: '1px solid var(--border-color)',
                                }}>
                                    <div style={{ minWidth: 55, fontSize: '0.75rem', color: 'var(--text-muted)', fontFamily: 'monospace' }}>
                                        {new Date(b.date).toLocaleDateString('pt-BR', { timeZone: 'UTC', day: '2-digit', month: '2-digit' })}
                                    </div>
                                    <div style={{ fontWeight: 700, fontSize: '0.8125rem', minWidth: 42 }}>{b.startTime}</div>
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                        <button style={{ fontWeight: 600, fontSize: '0.8125rem', cursor: 'pointer', color: 'var(--text-primary)', background: 'none', border: 'none', padding: 0, fontFamily: 'inherit', textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}
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
                <div className="admin-card">
                    <h3 style={{ fontSize: '0.9375rem', fontWeight: 700, marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <AlertTriangle size={18} style={{ color: 'var(--warning)' }} aria-hidden="true" /> Clientes em Risco
                        {churnRisk.length > 0 && (
                            <span style={{ background: 'var(--warning)', color: '#fff', fontSize: '0.7rem', fontWeight: 700, padding: '2px 8px', borderRadius: '10px' }}>
                                {churnRisk.length}
                            </span>
                        )}
                    </h3>
                    {churnRisk.length === 0 ? (
                        <div className="admin-empty" style={{ padding: '20px' }}>
                            <Target size={36} className="admin-empty__icon" aria-hidden="true" />
                            <div className="admin-empty__title">Todos os clientes engajados!</div>
                        </div>
                    ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                            {churnRisk.slice(0, 5).map(u => {
                                const userContract = activeContracts.find(c => c.user?.id === u.id);
                                const userBookings = allBookings.filter(b => b.user?.id === u.id && b.status !== 'CANCELLED').sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
                                const lastDate = userBookings[0] ? new Date(userBookings[0].date).toLocaleDateString('pt-BR', { timeZone: 'UTC', day: '2-digit', month: '2-digit' }) : 'Nunca agendou';

                                return (
                                    <div key={u.id} style={{
                                        display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px',
                                        borderRadius: '10px', background: 'var(--warning-bg)',
                                        border: '1px solid rgba(245, 158, 11, 0.15)',
                                    }}>
                                        <div className="admin-avatar">{getInitials(u.name)}</div>
                                        <div style={{ flex: 1 }}>
                                            <div style={{ fontWeight: 600, fontSize: '0.8125rem', cursor: 'pointer', color: 'var(--text-primary)' }}
                                                onClick={() => navigate(`/admin/clients/${u.id}`)}>
                                                {u.name}
                                            </div>
                                            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
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

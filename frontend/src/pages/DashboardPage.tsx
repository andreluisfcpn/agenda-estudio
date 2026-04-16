import { getErrorMessage } from '../utils/errors';
import { useState, useEffect } from 'react';
import { bookingsApi, contractsApi, usersApi, Booking, BookingWithUser, Contract, UserSummary, PaymentSummary } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useUI } from '../context/UIContext';
import { useNavigate } from 'react-router-dom';
import ModalOverlay from '../components/ModalOverlay';
import PaymentModal from '../components/PaymentModal';
import StatCard from '../components/ui/StatCard';
import StatusBadge from '../components/ui/StatusBadge';
import NotificationBanner from '../components/NotificationBanner';
import { Wallet, CalendarDays, Clapperboard, FileText, Package, AlertTriangle, ArrowRight, XCircle, Clock, CheckCircle } from 'lucide-react';

function formatBRL(cents: number): string {
    return `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;
}

function formatContractOrigin(booking: Booking): string {
    if (!booking.contract) return 'Avulso';
    if (booking.contract.name) return booking.contract.name;
    if (booking.contract.type === 'AVULSO') return `Avulso — ${booking.contract.tier}`;
    return `Plano ${booking.contract.type === 'FIXO' ? 'Fixo' : 'Flex'} — ${booking.contract.tier}`;
}

const TIER_EMOJI: Record<string, string> = { COMERCIAL: '🏢', AUDIENCIA: '🎤', SABADO: '🌟' };
const DAY_LABELS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

const SLOT_GRID = [
    { time: '10:00', end: '12:00', label: '10h — 12h' },
    { time: '13:00', end: '15:00', label: '13h — 15h' },
    { time: '15:30', end: '17:30', label: '15h30 — 17h30' },
    { time: '18:00', end: '20:00', label: '18h — 20h' },
    { time: '20:30', end: '22:30', label: '20h30 — 22h30' },
];

function getToday(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

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

function AdminDashboard() {
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

    if (loading) return <div className="loading-spinner"><div className="spinner" /></div>;

    const today = getToday();
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
        if (dayOfWeek === 0) return { date: ds, day: DAY_LABELS[dayOfWeek], pct: 0, count: 0, total: 0, closed: true };
        const count = allBookings.filter(b => b.date.split('T')[0] === ds && b.status !== 'CANCELLED').length;
        return { date: ds, day: DAY_LABELS[dayOfWeek], pct: Math.round((count / 5) * 100), count, total: 5, closed: false };
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
    const todaySlots = SLOT_GRID.map(slot => {
        const booking = todaysBookings.find(b => b.startTime === slot.time);
        return { ...slot, booking: booking || null };
    });

    return (
        <div aria-label="Painel principal">
            {/* ─── HEADER ─── */}
            <div style={{ marginBottom: '28px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '16px' }}>
                <div>
                    <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <span style={{ fontSize: '1.75rem' }}>📊</span> Centro de Comando
                    </h1>
                    <p className="page-subtitle" style={{ marginTop: '4px', textTransform: 'capitalize' }}>
                        {new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' })}
                    </p>
                </div>
            </div>

            {/* ── SECTION 1: Agenda do Dia (Hero) ────────────────── */}
            <div style={{ padding: '24px', marginBottom: '24px', borderRadius: '16px', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderTop: '3px solid var(--accent-primary)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                    <div>
                        <h2 style={{ fontSize: '1.125rem', fontWeight: 700, margin: 0 }}>📅 Agenda de Hoje</h2>
                        <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                            {todaysBookings.length} de 5 slots ocupados
                        </p>
                    </div>
                    <button onClick={() => navigate('/calendar')} style={{ padding: '6px 14px', borderRadius: '8px', fontSize: '0.6875rem', fontWeight: 700, background: 'var(--bg-elevated)', border: '1px solid var(--border-color)', color: 'var(--text-secondary)', cursor: 'pointer', transition: 'all 0.2s' }}>Ver Agenda Completa →</button>
                </div>

                {isSunday ? (
                    <div style={{ textAlign: 'center', padding: '32px', color: 'var(--text-muted)' }}>
                        <div style={{ fontSize: '2.5rem', marginBottom: '8px' }}>🏖️</div>
                        <div style={{ fontWeight: 600 }}>Estúdio fechado aos domingos</div>
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
                                    transition: 'all 0.2s',
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
                                                <span style={{ fontWeight: 600, cursor: 'pointer', color: 'var(--text-primary)' }}
                                                    onClick={() => navigate(`/admin/clients/${b.user.id}`)}>
                                                    {b.user.name}
                                                </span>
                                                <span className={`badge badge-${b.tierApplied.toLowerCase()}`} style={{ fontSize: '0.7rem' }}>
                                                    {TIER_EMOJI[b.tierApplied]} {b.tierApplied}
                                                </span>
                                                <span className={`badge badge-${b.status.toLowerCase()}`} style={{ fontSize: '0.7rem' }}>
                                                    {b.status === 'CONFIRMED' ? '✅' : b.status === 'COMPLETED' ? '🏁' : b.status === 'RESERVED' ? '⏳' : b.status === 'FALTA' ? '❌' : '🔄'} {b.status}
                                                </span>
                                                <span style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', marginLeft: 'auto' }}>
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
                                                style={{ background: 'rgba(59, 130, 246, 0.15)', color: '#3b82f6', border: 'none', padding: '4px 10px', borderRadius: '6px', fontWeight: 700, fontSize: '0.75rem', cursor: 'pointer' }}
                                                onClick={() => handleQuickAction(b.id, 'checkin')}>
                                                📋 Check-in
                                            </button>
                                            <button className="btn btn-sm" title="Registrar Falta"
                                                style={{ background: 'rgba(220, 38, 38, 0.12)', color: '#dc2626', border: 'none', padding: '4px 10px', borderRadius: '6px', fontWeight: 700, fontSize: '0.75rem', cursor: 'pointer' }}
                                                onClick={() => handleQuickAction(b.id, 'falta')}>
                                                ❌
                                            </button>
                                        </div>
                                    )}
                                    {b && b.status === 'CONFIRMED' && !isPast && (
                                        <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                                            <button className="btn btn-sm" title="Finalizar Sessão"
                                                style={{ background: 'rgba(16, 185, 129, 0.15)', color: '#10b981', border: 'none', padding: '4px 10px', borderRadius: '6px', fontWeight: 700, fontSize: '0.75rem', cursor: 'pointer' }}
                                                onClick={() => handleQuickAction(b.id, 'complete')}>
                                                🏁 Finalizar
                                            </button>
                                            <button className="btn btn-sm" title="Registrar Falta"
                                                style={{ background: 'rgba(220, 38, 38, 0.12)', color: '#dc2626', border: 'none', padding: '4px 10px', borderRadius: '6px', fontWeight: 700, fontSize: '0.75rem', cursor: 'pointer' }}
                                                onClick={() => handleQuickAction(b.id, 'falta')}>
                                                ❌
                                            </button>
                                        </div>
                                    )}

                                    {b && b.status === 'COMPLETED' && (
                                        <span style={{ fontSize: '0.75rem', color: 'var(--tier-comercial)', fontWeight: 600 }}>🏁 Concluído</span>
                                    )}
                                    {b && b.status === 'FALTA' && (
                                        <span style={{ fontSize: '0.75rem', color: '#dc2626', fontWeight: 600 }}>❌ Falta</span>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* ── SECTION 2: KPIs ──────────────────────────────── */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '16px', marginBottom: '24px' }}>
                {[
                    { label: 'RECEITA DO MÊS', value: formatBRL(monthRevenue), sub: `${monthBookings.length} agendamentos`, color: '#10b981', bg: 'rgba(16,185,129,0.08)', border: 'rgba(16,185,129,0.2)' },
                    { label: 'OCUPAÇÃO HOJE', value: isSunday ? '—' : `${todaysBookings.length}/5`, sub: isSunday ? 'Fechado' : `${Math.round((todaysBookings.length / 5) * 100)}% dos slots`, color: todaysBookings.length >= 4 ? '#10b981' : todaysBookings.length >= 2 ? '#f59e0b' : 'var(--text-muted)', bg: 'rgba(59,130,246,0.08)', border: 'rgba(59,130,246,0.2)' },
                    { label: 'TAXA DE PRESENÇA', value: `${attendanceRate}%`, sub: `${completedThisMonth} concluídas, ${noShowsThisMonth} faltas`, color: attendanceRate >= 80 ? '#10b981' : attendanceRate >= 60 ? '#f59e0b' : '#ef4444', bg: attendanceRate >= 80 ? 'rgba(16,185,129,0.08)' : 'rgba(239,68,68,0.08)', border: attendanceRate >= 80 ? 'rgba(16,185,129,0.2)' : 'rgba(239,68,68,0.2)' },
                    { label: 'CONTRATOS ATIVOS', value: `${activeContracts.length}`, sub: `${allUsers.filter(u => u.role !== 'ADMIN').length} clientes cadastrados`, color: '#2dd4bf', bg: 'rgba(45,212,191,0.08)', border: 'rgba(45,212,191,0.2)' },
                ].map((kpi, i) => (
                    <div key={i} style={{ padding: '20px', borderRadius: '14px', background: kpi.bg, border: `1px solid ${kpi.border}`, textAlign: 'center' }}>
                        <div style={{ fontSize: '0.5625rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: kpi.color, marginBottom: '8px' }}>{kpi.label}</div>
                        <div style={{ fontSize: '1.5rem', fontWeight: 800, color: kpi.color }}>{kpi.value}</div>
                        <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', marginTop: '6px' }}>{kpi.sub}</div>
                    </div>
                ))}
            </div>

            {/* ── SECTION 3: Alertas + Ocupação Semanal ────────── */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '24px' }}>

                {/* Alerts */}
                <div style={{ padding: '20px', borderRadius: '16px', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)' }}>
                    <h3 style={{ fontSize: '0.9375rem', fontWeight: 700, marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                        🚨 Alertas
                        {totalAlerts > 0 && (
                            <span style={{ background: '#dc2626', color: '#fff', fontSize: '0.7rem', fontWeight: 700, padding: '2px 8px', borderRadius: '10px', minWidth: 20, textAlign: 'center' }}>
                                {totalAlerts}
                            </span>
                        )}
                    </h3>

                    {totalAlerts === 0 ? (
                        <div style={{ textAlign: 'center', padding: '20px', color: 'var(--text-muted)' }}>
                            <div style={{ fontSize: '1.5rem', marginBottom: '8px' }}>✅</div>
                            <div style={{ fontSize: '0.875rem' }}>Tudo em ordem!</div>
                        </div>
                    ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                            {expiringContracts.map(c => (
                                <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', borderRadius: '10px', background: 'rgba(220, 38, 38, 0.08)', border: '1px solid rgba(220, 38, 38, 0.2)' }}>
                                    <span style={{ fontSize: '1.25rem' }}>🔴</span>
                                    <div style={{ flex: 1 }}>
                                        <div style={{ fontSize: '0.8125rem', fontWeight: 600 }}>
                                            Contrato de <span style={{ cursor: 'pointer', color: 'var(--accent-primary)' }} onClick={() => c.user?.id && navigate(`/admin/clients/${c.user.id}`)}>{c.user?.name}</span> expira em {daysUntil(c.endDate)} dia(s)
                                        </div>
                                        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{c.type} · {c.tier}</div>
                                    </div>
                                </div>
                            ))}

                            {pendingCancellations.map(c => (
                                <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', borderRadius: '10px', background: 'rgba(217, 119, 6, 0.08)', border: '1px solid rgba(217, 119, 6, 0.2)' }}>
                                    <span style={{ fontSize: '1.25rem' }}>🟠</span>
                                    <div style={{ flex: 1 }}>
                                        <div style={{ fontSize: '0.8125rem', fontWeight: 600 }}>
                                            Cancelamento pendente: <span style={{ cursor: 'pointer', color: 'var(--accent-primary)' }} onClick={() => navigate('/admin/contracts')}>{c.user?.name}</span>
                                        </div>
                                        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Aguardando resolução (multa ou isenção)</div>
                                    </div>
                                </div>
                            ))}

                            {unconfirmedToday.map(b => (
                                <div key={b.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', borderRadius: '10px', background: 'rgba(217, 119, 6, 0.08)', border: '1px solid rgba(217, 119, 6, 0.15)' }}>
                                    <span style={{ fontSize: '1.25rem' }}>🟡</span>
                                    <div style={{ flex: 1 }}>
                                        <div style={{ fontSize: '0.8125rem', fontWeight: 600 }}>
                                            {b.user.name} às {b.startTime} — ainda sem confirmação
                                        </div>
                                    </div>
                                    <button className="btn btn-sm" style={{ background: 'rgba(16,185,129,0.15)', color: '#10b981', border: 'none', padding: '4px 10px', borderRadius: '6px', fontWeight: 700, fontSize: '0.7rem', cursor: 'pointer' }}
                                        onClick={() => handleQuickAction(b.id, 'checkin')}>
                                        Confirmar
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* Weekly Occupancy */}
                <div style={{ padding: '20px', borderRadius: '16px', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)' }}>
                    <h3 style={{ fontSize: '0.9375rem', fontWeight: 700, marginBottom: '16px' }}>📈 Ocupação da Semana</h3>
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
                                            background: d.pct > 80 ? 'linear-gradient(90deg, #dc2626, #ef4444)' : d.pct > 60 ? 'linear-gradient(90deg, #d97706, #f59e0b)' : 'linear-gradient(90deg, #10b981, #34d399)',
                                            transition: 'width 0.5s ease',
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
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>

                {/* Next Bookings */}
                <div style={{ padding: '20px', borderRadius: '16px', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)' }}>
                    <h3 style={{ fontSize: '0.9375rem', fontWeight: 700, marginBottom: '16px' }}>🔜 Próximos Agendamentos</h3>
                    {futureBookings.length === 0 ? (
                        <div style={{ textAlign: 'center', padding: '20px', color: 'var(--text-muted)' }}>
                            <div style={{ fontSize: '1.5rem', marginBottom: '8px' }}>📅</div>
                            <div style={{ fontSize: '0.875rem' }}>Nenhum agendamento futuro</div>
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
                                    <div style={{ flex: 1 }}>
                                        <span style={{ fontWeight: 600, fontSize: '0.8125rem', cursor: 'pointer', color: 'var(--text-primary)' }}
                                            onClick={() => navigate(`/admin/clients/${b.user.id}`)}>
                                            {b.user.name}
                                        </span>
                                    </div>
                                    <span className={`badge badge-${b.tierApplied.toLowerCase()}`} style={{ fontSize: '0.65rem' }}>
                                        {TIER_EMOJI[b.tierApplied]}
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* Churn Risk */}
                <div style={{ padding: '20px', borderRadius: '16px', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)' }}>
                    <h3 style={{ fontSize: '0.9375rem', fontWeight: 700, marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                        ⚠️ Clientes em Risco
                        {churnRisk.length > 0 && (
                            <span style={{ background: '#d97706', color: '#fff', fontSize: '0.7rem', fontWeight: 700, padding: '2px 8px', borderRadius: '10px' }}>
                                {churnRisk.length}
                            </span>
                        )}
                    </h3>
                    {churnRisk.length === 0 ? (
                        <div style={{ textAlign: 'center', padding: '20px', color: 'var(--text-muted)' }}>
                            <div style={{ fontSize: '1.5rem', marginBottom: '8px' }}>🎯</div>
                            <div style={{ fontSize: '0.875rem' }}>Todos os clientes engajados!</div>
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
                                        borderRadius: '10px', background: 'rgba(217, 119, 6, 0.06)',
                                        border: '1px solid rgba(217, 119, 6, 0.15)',
                                    }}>
                                        <div style={{
                                            width: 32, height: 32, borderRadius: '50%',
                                            background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-secondary))',
                                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                                            fontSize: '0.7rem', fontWeight: 700, color: '#fff', flexShrink: 0,
                                        }}>
                                            {u.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()}
                                        </div>
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

// ─── Client Dashboard ─────────────────────────────────────
// Extracted to components/client/ClientDashboard.tsx
import ClientDashboard from '../components/client/ClientDashboard';

// ─── Main Export ───────────────────────────────────────────

export default function DashboardPage() {
    const { user } = useAuth();
    return user?.role === 'ADMIN' ? <AdminDashboard /> : <ClientDashboard />;
}

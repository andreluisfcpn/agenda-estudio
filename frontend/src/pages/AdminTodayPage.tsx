import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { bookingsApi, BookingWithUser } from '../api/client';
import { useUI } from '../context/UIContext';
import { useNavigate } from 'react-router-dom';

function formatBRL(cents: number): string {
    return `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;
}

const TIER_META: Record<string, { emoji: string; color: string; bg: string; label: string }> = {
    COMERCIAL: { emoji: '🏢', color: '#10b981', bg: 'rgba(16,185,129,0.10)', label: 'Comercial' },
    AUDIENCIA: { emoji: '🎤', color: '#2dd4bf', bg: 'rgba(45,212,191,0.10)', label: 'Audiência' },
    SABADO:    { emoji: '🌟', color: '#fbbf24', bg: 'rgba(245,158,11,0.10)', label: 'Sábado' },
};

const STATUS_META: Record<string, { icon: string; label: string; color: string; bg: string }> = {
    RESERVED:      { icon: '⏳', label: 'Reservado',     color: '#d97706', bg: 'rgba(217,119,6,0.12)' },
    CONFIRMED:     { icon: '✓',  label: 'Confirmado',    color: '#3b82f6', bg: 'rgba(59,130,246,0.12)' },
    COMPLETED:     { icon: '✓',  label: 'Concluído',     color: '#10b981', bg: 'rgba(16,185,129,0.12)' },
    FALTA:         { icon: '✕',  label: 'Falta',         color: '#ef4444', bg: 'rgba(239,68,68,0.12)' },
    NAO_REALIZADO: { icon: '↩',  label: 'Não Realizado', color: '#14b8a6', bg: 'rgba(45,212,191,0.12)' },
    CANCELLED:     { icon: '✕',  label: 'Cancelado',     color: '#6b7280', bg: 'rgba(107,114,128,0.12)' },
};

interface SlotDef {
    id: string;
    type: 'SLOT' | 'BREAK';
    time: string;
    timeEnd: string;
    label: string;
    breakLabel?: string;
    breakIcon?: string;
}

const TIMELINE: SlotDef[] = [
    { id: 'S1', type: 'SLOT',  time: '10:00', timeEnd: '12:00', label: '10h — 12h' },
    { id: 'T1', type: 'BREAK', time: '12:00', timeEnd: '13:00', label: '12:00 — 13:00', breakLabel: 'Intervalo para Almoço', breakIcon: '☕' },
    { id: 'S2', type: 'SLOT',  time: '13:00', timeEnd: '15:00', label: '13h — 15h' },
    { id: 'T2', type: 'BREAK', time: '15:00', timeEnd: '15:30', label: '15:00 — 15:30', breakLabel: 'Higienização', breakIcon: '🧹' },
    { id: 'S3', type: 'SLOT',  time: '15:30', timeEnd: '17:30', label: '15h30 — 17h30' },
    { id: 'T3', type: 'BREAK', time: '17:30', timeEnd: '18:00', label: '17:30 — 18:00', breakLabel: 'Higienização', breakIcon: '🧹' },
    { id: 'S4', type: 'SLOT',  time: '18:00', timeEnd: '20:00', label: '18h — 20h' },
    { id: 'T4', type: 'BREAK', time: '20:00', timeEnd: '20:30', label: '20:00 — 20:30', breakLabel: 'Higienização', breakIcon: '🧹' },
    { id: 'S5', type: 'SLOT',  time: '20:30', timeEnd: '22:30', label: '20h30 — 22h30' },
];

function getToday(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getInitials(name: string): string {
    return name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
}

// ─── CSS Keyframes (injected once) ──────────────────────
const styleId = 'admin-today-styles';
if (typeof document !== 'undefined' && !document.getElementById(styleId)) {
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
        @keyframes today-pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.4; }
        }
        @keyframes today-glow {
            0%, 100% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.4); }
            50% { box-shadow: 0 0 0 8px rgba(16, 185, 129, 0); }
        }
        @keyframes today-slide-down {
            from { opacity: 0; max-height: 0; }
            to { opacity: 1; max-height: 700px; }
        }
        .today-slot-card {
            transition: all 0.25s ease;
        }
        .today-slot-card:hover {
            border-color: rgba(16,185,129,0.3) !important;
            transform: translateX(2px);
        }
        .today-action-btn {
            border: none; padding: 6px 14px; border-radius: 8px;
            font-weight: 600; font-size: 0.8rem; cursor: pointer;
            display: inline-flex; align-items: center; gap: 6px;
            transition: all 0.2s ease; font-family: inherit;
        }
        .today-action-btn:hover { transform: translateY(-1px); filter: brightness(1.15); }
        .today-action-btn:active { transform: translateY(0); }
    `;
    document.head.appendChild(style);
}

export default function AdminTodayPage() {
    const navigate = useNavigate();
    const { showToast, showConfirm } = useUI();
    const [bookings, setBookings] = useState<BookingWithUser[]>([]);
    const [loading, setLoading] = useState(true);
    const [expandedSlot, setExpandedSlot] = useState<string | null>(null);

    const [adminNotes, setAdminNotes] = useState('');
    const [clientNotes, setClientNotes] = useState('');
    const [durationMin, setDurationMin] = useState<number | ''>('');
    const [peakViewers, setPeakViewers] = useState<number | ''>('');
    const [chatMessages, setChatMessages] = useState<number | ''>('');
    const [audienceOrigin, setAudienceOrigin] = useState('');
    const [saving, setSaving] = useState(false);

    const today = getToday();
    const isSunday = new Date().getDay() === 0;

    const loadData = useCallback(async () => {
        setLoading(true);
        try {
            const res = await bookingsApi.getAll(today);
            setBookings(res.bookings.filter(b => b.status !== 'CANCELLED'));
        } catch (err) { console.error(err); }
        finally { setLoading(false); }
    }, [today]);

    useEffect(() => { loadData(); }, [loadData]);

    const bookingForSlot = (time: string): BookingWithUser | undefined =>
        bookings.find(b => b.startTime === time);

    const handleStatusChange = async (bookingId: string, newStatus: string, label: string) => {
        try {
            await bookingsApi.update(bookingId, { status: newStatus });
            showToast(`${label} registrado com sucesso!`);
            await loadData();
        } catch (err: any) { console.error(err); }
    };

    const handleCancel = (bookingId: string, clientName: string) => {
        showConfirm({
            title: '⚠️ Cancelar Agendamento',
            message: `Tem certeza que deseja cancelar a sessão de ${clientName}?`,
            onConfirm: async () => {
                try {
                    await bookingsApi.cancel(bookingId);
                    showToast('Agendamento cancelado.');
                    await loadData();
                } catch (err: any) { console.error(err); }
            }
        });
    };

    const openSlotDetails = (booking: BookingWithUser) => {
        setExpandedSlot(prev => prev === booking.id ? null : booking.id);
        setAdminNotes(booking.adminNotes || '');
        setClientNotes(booking.clientNotes || '');
        setDurationMin(booking.durationMinutes || '');
        setPeakViewers(booking.peakViewers || '');
        setChatMessages(booking.chatMessages || '');
        setAudienceOrigin(booking.audienceOrigin || '');
    };

    const handleSaveMetrics = async (bookingId: string) => {
        setSaving(true);
        try {
            await bookingsApi.update(bookingId, {
                adminNotes,
                clientNotes,
                durationMinutes: durationMin === '' ? null : Number(durationMin),
                peakViewers: peakViewers === '' ? null : Number(peakViewers),
                chatMessages: chatMessages === '' ? null : Number(chatMessages),
                audienceOrigin: audienceOrigin || null,
            });
            showToast('Métricas salvas com sucesso! ✨');
            await loadData();
        } catch (err: any) { console.error(err); }
        finally { setSaving(false); }
    };

    // ─── KPI Computations ───
    const kpis = useMemo(() => {
        const total = bookings.length;
        const completed = bookings.filter(b => b.status === 'COMPLETED').length;
        const confirmed = bookings.filter(b => b.status === 'CONFIRMED' || b.status === 'RESERVED').length;
        const falta = bookings.filter(b => b.status === 'FALTA' || b.status === 'NAO_REALIZADO').length;
        const resolved = completed + falta;
        const progressPct = total > 0 ? Math.round((resolved / total) * 100) : 0;
        const revenue = bookings.filter(b => b.status === 'CONFIRMED' || b.status === 'COMPLETED').reduce((s, b) => s + b.price, 0);
        return { total, completed, confirmed, falta, resolved, progressPct, revenue };
    }, [bookings]);

    const [now, setNow] = useState(new Date());
    useEffect(() => {
        const timer = setInterval(() => setNow(new Date()), 1000);
        return () => clearInterval(timer);
    }, []);
    const nowTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    if (loading) return <div className="loading-spinner"><div className="spinner" /></div>;

    return (
        <div>
            {/* ─── HEADER ─── */}
            <div style={{ marginBottom: '28px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '16px' }}>
                <div>
                    <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <span style={{ fontSize: '1.75rem' }}>📍</span> Visão do Dia
                    </h1>
                    <p className="page-subtitle" style={{ marginTop: '4px', display: 'flex', alignItems: 'center', gap: '10px' }}>
                        {now.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' })}
                        <span style={{
                            fontSize: '0.75rem', fontWeight: 700, color: '#10b981',
                            background: 'rgba(16,185,129,0.1)', padding: '2px 8px', borderRadius: '6px',
                            animation: 'today-pulse 2s infinite'
                        }}>
                            🕐 {nowTime}:{String(now.getSeconds()).padStart(2, '0')}
                        </span>
                    </p>
                </div>
            </div>

            {/* ─── KPI CARDS ─── */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '14px', marginBottom: '24px' }}>
                <div style={{
                    padding: '20px', borderRadius: '14px',
                    background: 'linear-gradient(135deg, rgba(99,102,241,0.08), rgba(67,56,202,0.04))',
                    border: '1px solid rgba(99,102,241,0.2)',
                }}>
                    <div style={{ fontSize: '0.6875rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '6px' }}>Sessões</div>
                    <div style={{ fontSize: '2rem', fontWeight: 800, color: 'var(--text-primary)' }}>{kpis.total}</div>
                    <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', marginTop: '4px' }}>agendadas hoje</div>
                </div>
                <div style={{
                    padding: '20px', borderRadius: '14px',
                    background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
                }}>
                    <div style={{ fontSize: '0.6875rem', fontWeight: 700, color: '#3b82f6', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '6px' }}>Pendentes</div>
                    <div style={{ fontSize: '2rem', fontWeight: 800, color: 'var(--text-primary)' }}>{kpis.confirmed}</div>
                    <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', marginTop: '4px' }}>a realizar</div>
                </div>
                <div style={{
                    padding: '20px', borderRadius: '14px',
                    background: kpis.completed > 0 ? 'linear-gradient(135deg, rgba(16,185,129,0.08), rgba(6,78,59,0.04))' : 'var(--bg-secondary)',
                    border: kpis.completed > 0 ? '1px solid rgba(16,185,129,0.2)' : '1px solid var(--border-color)',
                }}>
                    <div style={{ fontSize: '0.6875rem', fontWeight: 700, color: '#10b981', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '6px' }}>Concluídas</div>
                    <div style={{ fontSize: '2rem', fontWeight: 800, color: 'var(--text-primary)' }}>{kpis.completed}</div>
                    <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', marginTop: '4px' }}>finalizadas</div>
                </div>
                <div style={{
                    padding: '20px', borderRadius: '14px',
                    background: kpis.falta > 0 ? 'linear-gradient(135deg, rgba(239,68,68,0.06), rgba(220,38,38,0.04))' : 'var(--bg-secondary)',
                    border: kpis.falta > 0 ? '1px solid rgba(239,68,68,0.2)' : '1px solid var(--border-color)',
                }}>
                    <div style={{ fontSize: '0.6875rem', fontWeight: 700, color: kpis.falta > 0 ? '#ef4444' : 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '6px' }}>Faltas</div>
                    <div style={{ fontSize: '2rem', fontWeight: 800, color: kpis.falta > 0 ? '#ef4444' : 'var(--text-primary)' }}>{kpis.falta}</div>
                    <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', marginTop: '4px' }}>não compareceram</div>
                </div>
                <div style={{
                    padding: '20px', borderRadius: '14px',
                    background: 'linear-gradient(135deg, rgba(16,185,129,0.10), rgba(6,78,59,0.06))',
                    border: '1px solid rgba(16,185,129,0.25)',
                }}>
                    <div style={{ fontSize: '0.6875rem', fontWeight: 700, color: '#10b981', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '6px' }}>Receita</div>
                    <div style={{ fontSize: '1.5rem', fontWeight: 800, color: '#10b981' }}>{formatBRL(kpis.revenue)}</div>
                    <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', marginTop: '4px' }}>confirmado + concluído</div>
                </div>
            </div>

            {/* ─── PROGRESS BAR ─── */}
            {kpis.total > 0 && (
                <div style={{
                    padding: '14px 20px', borderRadius: '12px', marginBottom: '24px',
                    background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
                }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                            <span style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
                                {kpis.resolved} de {kpis.total} sessões finalizadas
                            </span>
                            {kpis.completed > 0 && <span style={{ fontSize: '0.6875rem', color: '#10b981', fontWeight: 700, background: 'rgba(16,185,129,0.1)', padding: '2px 8px', borderRadius: '6px' }}>✓ {kpis.completed}</span>}
                            {kpis.falta > 0 && <span style={{ fontSize: '0.6875rem', color: '#ef4444', fontWeight: 700, background: 'rgba(239,68,68,0.1)', padding: '2px 8px', borderRadius: '6px' }}>✕ {kpis.falta}</span>}
                        </div>
                        <span style={{ fontSize: '0.875rem', fontWeight: 800, color: kpis.progressPct === 100 ? '#10b981' : 'var(--text-primary)' }}>{kpis.progressPct}%</span>
                    </div>
                    <div style={{ height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.04)', overflow: 'hidden' }}>
                        <div style={{
                            height: '100%', borderRadius: 3,
                            width: `${kpis.progressPct}%`,
                            background: kpis.progressPct === 100
                                ? 'linear-gradient(90deg, #10b981, #34d399)'
                                : 'linear-gradient(90deg, #3b82f6, #10b981)',
                            transition: 'width 0.6s cubic-bezier(0.4, 0, 0.2, 1)',
                        }} />
                    </div>
                </div>
            )}

            {/* ─── SUNDAY ─── */}
            {isSunday ? (
                <div style={{
                    padding: '64px 24px', textAlign: 'center', borderRadius: '16px',
                    background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
                }}>
                    <div style={{ fontSize: '4rem', marginBottom: '16px' }}>🏖️</div>
                    <div style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--text-primary)' }}>Estúdio fechado aos domingos</div>
                    <p style={{ color: 'var(--text-muted)', marginTop: '8px', fontSize: '0.9375rem' }}>Descanse bem. A semana começa amanhã! 💪</p>
                </div>
            ) : (
                /* ─── TIMELINE ─── */
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0' }}>
                    {TIMELINE.map((item, index) => {
                        if (item.type === 'BREAK') {
                            const isBreakNow = nowTime >= item.time && nowTime <= item.timeEnd;
                            return (
                                <div key={item.id} style={{
                                    display: 'flex', alignItems: 'center', gap: '16px',
                                    padding: '6px 0', margin: '0 0 0 20px',
                                }}>
                                    <div style={{
                                        width: 6, height: 6, borderRadius: '50%',
                                        background: isBreakNow ? '#10b981' : 'var(--border-color)',
                                        flexShrink: 0,
                                    }} />
                                    <div style={{
                                        fontSize: '0.75rem', color: 'var(--text-muted)',
                                        display: 'flex', alignItems: 'center', gap: '8px',
                                        padding: '4px 12px',
                                        background: isBreakNow ? 'rgba(16,185,129,0.06)' : 'transparent',
                                        borderRadius: '8px',
                                        borderLeft: `2px solid ${isBreakNow ? '#10b981' : 'transparent'}`,
                                    }}>
                                        <span style={{ fontSize: '0.875rem' }}>{item.breakIcon}</span>
                                        <span>{item.breakLabel}</span>
                                        {isBreakNow && (
                                            <span style={{
                                                fontSize: '0.6rem', fontWeight: 800, color: '#10b981',
                                                textTransform: 'uppercase', letterSpacing: '0.1em',
                                                animation: 'today-pulse 2s infinite',
                                                background: 'rgba(16,185,129,0.12)',
                                                padding: '1px 6px', borderRadius: '4px',
                                            }}>agora</span>
                                        )}
                                    </div>
                                </div>
                            );
                        }

                        const booking = bookingForSlot(item.time);
                        const isPast = nowTime > item.timeEnd;
                        const isNow = nowTime >= item.time && nowTime <= item.timeEnd;
                        const isExpanded = booking && expandedSlot === booking.id;
                        const statusInfo = booking ? STATUS_META[booking.status] : null;
                        const tierInfo = booking ? TIER_META[booking.tierApplied] : null;

                        return (
                            <div key={item.id} style={{
                                display: 'flex', gap: '16px',
                                padding: '4px 0',
                                opacity: isPast && !booking ? 0.3 : 1,
                                transition: 'opacity 0.3s',
                            }}>
                                {/* ── Left: Dot + Connector ── */}
                                <div style={{
                                    display: 'flex', flexDirection: 'column', alignItems: 'center',
                                    minWidth: 44, paddingTop: '18px',
                                }}>
                                    <div style={{
                                        width: isNow ? 18 : 12, height: isNow ? 18 : 12,
                                        borderRadius: '50%',
                                        border: `2px solid ${
                                            isNow ? '#10b981'
                                            : booking ? (booking.status === 'COMPLETED' ? '#10b981' : booking.status === 'FALTA' ? '#ef4444' : '#3b82f6')
                                            : 'var(--border-color)'
                                        }`,
                                        background: booking
                                            ? (booking.status === 'COMPLETED' ? '#10b981' : booking.status === 'FALTA' ? '#ef4444' : booking.status === 'CONFIRMED' ? '#3b82f6' : 'transparent')
                                            : 'transparent',
                                        transition: 'all 0.3s ease',
                                        animation: isNow ? 'today-glow 2s infinite' : 'none',
                                        flexShrink: 0,
                                    }} />

                                    {isNow && (
                                        <div style={{
                                            marginTop: '6px', fontSize: '0.55rem', fontWeight: 800,
                                            color: '#10b981', textTransform: 'uppercase', letterSpacing: '0.12em',
                                            animation: 'today-pulse 2s infinite',
                                            background: 'rgba(16,185,129,0.12)',
                                            padding: '2px 6px', borderRadius: '4px',
                                        }}>AGORA</div>
                                    )}

                                    {index < TIMELINE.length - 1 && (
                                        <div style={{
                                            width: 2, flex: 1, marginTop: 4,
                                            background: isNow
                                                ? 'linear-gradient(to bottom, #10b981, var(--border-color))'
                                                : 'var(--border-color)',
                                        }} />
                                    )}
                                </div>

                                {/* ── Right: Slot Card ── */}
                                <div className="today-slot-card" style={{
                                    flex: 1,
                                    border: `1px solid ${isNow ? 'rgba(16,185,129,0.4)' : booking ? 'var(--border-color)' : 'rgba(255,255,255,0.04)'}`,
                                    borderRadius: '14px',
                                    background: booking ? 'var(--bg-secondary)' : 'rgba(255,255,255,0.01)',
                                    overflow: 'hidden',
                                    boxShadow: isNow ? '0 0 24px rgba(16,185,129,0.08)' : 'none',
                                    marginBottom: '4px',
                                }}>
                                    {/* Card Header */}
                                    <div
                                        style={{
                                            display: 'flex', alignItems: 'center', gap: '14px',
                                            padding: booking ? '16px 20px' : '12px 20px',
                                            cursor: booking ? 'pointer' : 'default',
                                        }}
                                        onClick={() => booking && openSlotDetails(booking)}
                                    >
                                        {/* Time badge */}
                                        <div style={{
                                            padding: '6px 12px', borderRadius: '8px',
                                            background: isNow ? 'rgba(16,185,129,0.12)' : 'rgba(255,255,255,0.03)',
                                            fontWeight: 700, fontSize: '0.8125rem',
                                            fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                                            color: isNow ? '#10b981' : 'var(--text-secondary)',
                                            whiteSpace: 'nowrap',
                                            minWidth: 100, textAlign: 'center',
                                        }}>
                                            {item.label}
                                        </div>

                                        {/* Content */}
                                        <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 }}>
                                            {booking && tierInfo ? (
                                                <>
                                                    {/* Avatar */}
                                                    <div style={{
                                                        width: 38, height: 38, borderRadius: '10px', flexShrink: 0,
                                                        background: `linear-gradient(135deg, ${tierInfo.color}, ${tierInfo.color}66)`,
                                                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                        fontSize: '0.7rem', fontWeight: 800, color: '#fff',
                                                        border: `1px solid ${tierInfo.color}33`,
                                                    }}>
                                                        {getInitials(booking.user.name)}
                                                    </div>

                                                    <div style={{ minWidth: 0 }}>
                                                        <div style={{
                                                            fontWeight: 600, fontSize: '0.875rem',
                                                            color: 'var(--accent-primary)',
                                                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                                            cursor: 'pointer',
                                                        }}
                                                            onClick={(e) => { e.stopPropagation(); navigate(`/admin/clients/${booking.user.id}`); }}>
                                                            {booking.user.name}
                                                        </div>
                                                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '2px' }}>
                                                            <span style={{
                                                                fontSize: '0.625rem', color: tierInfo.color, fontWeight: 700,
                                                                background: tierInfo.bg, padding: '1px 6px', borderRadius: '4px',
                                                            }}>
                                                                {tierInfo.emoji} {tierInfo.label}
                                                            </span>
                                                            <span style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', fontWeight: 600 }}>{formatBRL(booking.price)}</span>
                                                        </div>
                                                    </div>
                                                </>
                                            ) : (
                                                <span style={{ color: 'var(--text-muted)', fontSize: '0.8125rem' }}>
                                                    {isPast ? '— Encerrado —' : '🟢 Horário disponível'}
                                                </span>
                                            )}
                                        </div>

                                        {/* Right side: Status + Quick Actions */}
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
                                            {booking && statusInfo && (
                                                <span style={{
                                                    fontSize: '0.6875rem', fontWeight: 700, padding: '4px 10px',
                                                    borderRadius: '20px', color: statusInfo.color,
                                                    background: statusInfo.bg, letterSpacing: '0.02em',
                                                }}>
                                                    {statusInfo.icon} {statusInfo.label}
                                                </span>
                                            )}

                                            {booking && !isExpanded && (booking.status === 'CONFIRMED' || booking.status === 'RESERVED') && !isPast && (
                                                <div style={{ display: 'flex', gap: '3px' }}>
                                                    {booking.status === 'RESERVED' && (
                                                        <button className="today-action-btn" title="Confirmar"
                                                            style={{ background: 'rgba(59,130,246,0.12)', color: '#3b82f6', padding: '4px 10px', fontSize: '0.6875rem' }}
                                                            onClick={(e) => { e.stopPropagation(); handleStatusChange(booking.id, 'CONFIRMED', '✅ Confirmação'); }}>
                                                            Confirmar
                                                        </button>
                                                    )}
                                                    <button className="today-action-btn" title="Concluir"
                                                        style={{ background: 'rgba(16,185,129,0.12)', color: '#10b981', padding: '4px 8px', fontSize: '0.75rem' }}
                                                        onClick={(e) => { e.stopPropagation(); handleStatusChange(booking.id, 'COMPLETED', '🏁 Conclusão'); }}>
                                                        ✓
                                                    </button>
                                                    <button className="today-action-btn" title="Falta"
                                                        style={{ background: 'rgba(239,68,68,0.08)', color: '#ef4444', padding: '4px 8px', fontSize: '0.75rem' }}
                                                        onClick={(e) => { e.stopPropagation(); handleStatusChange(booking.id, 'FALTA', '❌ Falta'); }}>
                                                        ✕
                                                    </button>
                                                </div>
                                            )}

                                            {booking && (
                                                <span style={{
                                                    fontSize: '0.75rem', color: 'var(--text-muted)',
                                                    transform: isExpanded ? 'rotate(90deg)' : 'none',
                                                    transition: 'transform 0.25s ease',
                                                    display: 'inline-block', marginLeft: '2px',
                                                }}>▸</span>
                                            )}
                                        </div>
                                    </div>

                                    {/* ── Expanded Panel ── */}
                                    {booking && isExpanded && (
                                        <div style={{
                                            borderTop: '1px solid var(--border-color)',
                                            padding: '24px',
                                            background: 'linear-gradient(180deg, rgba(0,0,0,0.1) 0%, transparent 100%)',
                                            animation: 'today-slide-down 0.3s ease',
                                        }}>
                                            {/* Action buttons row */}
                                            {(booking.status === 'CONFIRMED' || booking.status === 'RESERVED') && !isPast && (
                                                <div style={{
                                                    display: 'flex', gap: '8px', marginBottom: '24px', flexWrap: 'wrap',
                                                    padding: '14px', borderRadius: '12px',
                                                    background: 'rgba(255,255,255,0.02)',
                                                    border: '1px solid var(--border-color)',
                                                }}>
                                                    {booking.status === 'RESERVED' && (
                                                        <button className="today-action-btn"
                                                            style={{ background: 'rgba(59,130,246,0.12)', color: '#3b82f6' }}
                                                            onClick={() => handleStatusChange(booking.id, 'CONFIRMED', '✅ Confirmação')}>
                                                            ✅ Confirmar Presença
                                                        </button>
                                                    )}
                                                    <button className="today-action-btn"
                                                        style={{ background: 'rgba(16,185,129,0.12)', color: '#10b981' }}
                                                        onClick={() => handleStatusChange(booking.id, 'COMPLETED', '🏁 Conclusão')}>
                                                        🏁 Concluída
                                                    </button>
                                                    <button className="today-action-btn"
                                                        style={{ background: 'rgba(239,68,68,0.08)', color: '#ef4444' }}
                                                        onClick={() => handleStatusChange(booking.id, 'FALTA', '❌ Falta')}>
                                                        ❌ Falta
                                                    </button>
                                                    <button className="today-action-btn"
                                                        style={{ background: 'rgba(45,212,191,0.08)', color: '#14b8a6' }}
                                                        onClick={() => handleStatusChange(booking.id, 'NAO_REALIZADO', '🔄 Não Realizado')}>
                                                        🔄 Não Realizado
                                                    </button>
                                                    <div style={{ flex: 1 }} />
                                                    <button className="today-action-btn"
                                                        style={{ background: 'rgba(239,68,68,0.06)', color: '#ef4444' }}
                                                        onClick={() => handleCancel(booking.id, booking.user.name)}>
                                                        🚫 Cancelar
                                                    </button>
                                                </div>
                                            )}

                                            {/* Metrics grid (COMPLETED) */}
                                            {booking.status === 'COMPLETED' && (
                                                <div style={{ marginBottom: '24px' }}>
                                                    <div style={{
                                                        fontSize: '0.6875rem', fontWeight: 700, color: '#10b981',
                                                        textTransform: 'uppercase', letterSpacing: '0.1em',
                                                        marginBottom: '14px', display: 'flex', alignItems: 'center', gap: '8px',
                                                    }}>
                                                        <span style={{ width: 20, height: 2, background: '#10b981', borderRadius: 1 }} />
                                                        Métricas Pós-Gravação
                                                    </div>
                                                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px' }}>
                                                        {[
                                                            { label: '⏱️ Duração (min)', value: durationMin, onChange: (v: string) => setDurationMin(v === '' ? '' : Number(v)), type: 'number', ph: 'Ex: 120' },
                                                            { label: '👁️ Pico Viewers', value: peakViewers, onChange: (v: string) => setPeakViewers(v === '' ? '' : Number(v)), type: 'number', ph: 'Ex: 1530' },
                                                            { label: '💬 Mensagens', value: chatMessages, onChange: (v: string) => setChatMessages(v === '' ? '' : Number(v)), type: 'number', ph: 'Ex: 2400' },
                                                            { label: '📍 Origem', value: audienceOrigin, onChange: setAudienceOrigin, type: 'text', ph: 'Ex: SP Capital' },
                                                        ].map(f => (
                                                            <div key={f.label}>
                                                                <label style={{ display: 'block', fontSize: '0.6875rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '6px' }}>{f.label}</label>
                                                                <input type={f.type} className="form-input" placeholder={f.ph}
                                                                    style={{ fontSize: '0.8125rem', background: 'var(--bg-elevated)' }}
                                                                    value={f.value} onChange={e => f.onChange(e.target.value)} />
                                                            </div>
                                                        ))}
                                                    </div>
                                                </div>
                                            )}

                                            {/* Notes */}
                                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '20px' }}>
                                                <div>
                                                    <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.6875rem', fontWeight: 700, color: '#2dd4bf', marginBottom: '8px' }}>
                                                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#2dd4bf' }} />
                                                        Observação Interna (Admin)
                                                    </label>
                                                    <textarea className="form-input"
                                                        style={{ minHeight: 80, resize: 'vertical', fontFamily: 'inherit', fontSize: '0.8125rem', background: 'var(--bg-elevated)' }}
                                                        placeholder="Notas privadas sobre a sessão..."
                                                        value={adminNotes}
                                                        onChange={e => setAdminNotes(e.target.value)} />
                                                </div>
                                                <div>
                                                    <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.6875rem', fontWeight: 700, color: '#10b981', marginBottom: '8px' }}>
                                                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#10b981' }} />
                                                        Feedback para o Cliente
                                                    </label>
                                                    <textarea className="form-input"
                                                        style={{ minHeight: 80, resize: 'vertical', fontFamily: 'inherit', fontSize: '0.8125rem', background: 'var(--bg-elevated)' }}
                                                        placeholder="Visível no painel do cliente..."
                                                        value={clientNotes}
                                                        onChange={e => setClientNotes(e.target.value)} />
                                                </div>
                                            </div>

                                            {/* Footer actions */}
                                            <div style={{
                                                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                                                paddingTop: '16px', borderTop: '1px solid var(--border-color)',
                                            }}>
                                                <button className="today-action-btn"
                                                    style={{ background: 'var(--bg-elevated)', color: 'var(--text-secondary)', border: '1px solid var(--border-color)' }}
                                                    onClick={() => navigate(`/admin/clients/${booking.user.id}`)}>
                                                    👤 Ver Perfil
                                                </button>
                                                <button className="today-action-btn"
                                                    style={{ background: 'linear-gradient(135deg, #10b981, #059669)', color: '#fff', fontWeight: 700, padding: '8px 20px' }}
                                                    onClick={() => handleSaveMetrics(booking.id)}
                                                    disabled={saving}>
                                                    {saving ? '⏳ Salvando...' : '💾 Salvar Alterações'}
                                                </button>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

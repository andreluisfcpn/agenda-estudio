import { getErrorMessage } from '../utils/errors';
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Clapperboard, CheckCircle2, ChevronRight, CalendarDays } from 'lucide-react';
import { bookingsApi, BookingWithUser } from '../api/client';
import { useUI } from '../context/UIContext';
import { useNavigate } from 'react-router-dom';
import { HeroSkeleton } from '../components/ui/SkeletonLoader';
import LoadingSpinner from '../components/ui/LoadingSpinner';
import StatusBadge from '../components/ui/StatusBadge';
import FinalizeRecordingModal from '../components/admin/bookings/FinalizeRecordingModal';
import { TIER_META, BOOKING_STATUS_META, getMeta } from '../constants/adminMeta';

import { formatBRL } from '../utils/format';

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
    { id: 'T1', type: 'BREAK', time: '12:00', timeEnd: '13:00', label: '12:00 — 13:00', breakLabel: 'Intervalo para Almoço', breakIcon: '🍽️' },
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

// --- CSS Keyframes (injected once) ----------------------
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

        /* --- Live hero clock --- */
        .today-hero {
            position: relative;
            overflow: hidden;
            border-radius: var(--radius-xl);
            padding: 26px 28px;
            margin-bottom: 24px;
            background:
                radial-gradient(circle at 0% 0%, rgba(17,129,155,0.20), transparent 55%),
                radial-gradient(circle at 100% 100%, rgba(16,185,129,0.10), transparent 50%),
                linear-gradient(135deg, var(--bg-card), var(--bg-secondary));
            border: 1px solid rgba(17,129,155,0.22);
        }
        .today-live-badge {
            display: inline-flex; align-items: center; gap: 7px;
            font-size: 0.6875rem; font-weight: 800; letter-spacing: 0.14em;
            text-transform: uppercase; color: #10b981;
            margin-bottom: 12px;
        }
        .today-live-dot {
            width: 8px; height: 8px; border-radius: 50%; background: #10b981;
            animation: today-livedot 1.6s infinite;
        }
        @keyframes today-livedot {
            0% { box-shadow: 0 0 0 0 rgba(16,185,129,0.5); }
            70% { box-shadow: 0 0 0 7px rgba(16,185,129,0); }
            100% { box-shadow: 0 0 0 0 rgba(16,185,129,0); }
        }
        .today-clock {
            display: flex; align-items: baseline; gap: 8px;
            font-family: 'JetBrains Mono', 'Fira Code', monospace;
            line-height: 1;
        }
        .today-clock-time {
            font-size: clamp(2.75rem, 10vw, 4rem); font-weight: 800;
            color: var(--text-primary); letter-spacing: -0.02em;
            font-variant-numeric: tabular-nums;
        }
        .today-clock-colon { animation: today-blink 1s step-end infinite; color: var(--accent-primary); }
        @keyframes today-blink { 50% { opacity: 0.25; } }
        .today-clock-secs {
            font-size: clamp(1.1rem, 3.5vw, 1.5rem); font-weight: 700;
            color: var(--accent-primary); font-variant-numeric: tabular-nums;
        }
        .today-date {
            font-size: 0.9375rem; color: var(--text-secondary);
            margin-top: 8px; text-transform: capitalize;
        }
        .today-summary {
            display: flex; flex-wrap: wrap; gap: 14px 22px; align-items: center;
            margin-top: 18px; padding-top: 16px;
            border-top: 1px solid var(--border-color);
        }
        .today-summary-item { display: flex; align-items: center; gap: 8px; font-size: 0.8125rem; color: var(--text-muted); }
        .today-summary-num { font-size: 1.125rem; font-weight: 800; color: var(--text-primary); }
        .today-next {
            margin-left: auto; display: inline-flex; align-items: center; gap: 10px;
            padding: 8px 14px; border-radius: 10px;
            background: rgba(17,129,155,0.10); border: 1px solid rgba(17,129,155,0.22);
            font-size: 0.8125rem; color: var(--text-secondary); max-width: 100%;
        }
        .today-next--now { background: rgba(16,185,129,0.12); border-color: rgba(16,185,129,0.3); }
        @media (max-width: 600px) {
            .today-next { margin-left: 0; width: 100%; }
        }
    `;
    document.head.appendChild(style);
}

export default function AdminTodayPage() {
    const navigate = useNavigate();
    const { showToast, showConfirm } = useUI();
    const [bookings, setBookings] = useState<BookingWithUser[]>([]);
    const [loading, setLoading] = useState(true);
    const [expandedSlot, setExpandedSlot] = useState<string | null>(null);
    const [finalizeBooking, setFinalizeBooking] = useState<BookingWithUser | null>(null);

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
        } catch (err: unknown) { console.error(err); }
    };

    const handleCancel = (bookingId: string, clientName: string) => {
        showConfirm({
            title: '🚫 Cancelar Agendamento',
            message: `Tem certeza que deseja cancelar a sessão de ${clientName}?`,
            onConfirm: async () => {
                try {
                    await bookingsApi.cancel(bookingId);
                    showToast('Agendamento cancelado.');
                    await loadData();
                } catch (err: unknown) { console.error(err); }
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
            showToast('Métricas salvas com sucesso! ✅');
            await loadData();
        } catch (err: unknown) { console.error(err); }
        finally { setSaving(false); }
    };

    const [now, setNow] = useState(new Date());
    useEffect(() => {
        const timer = setInterval(() => setNow(new Date()), 1000);
        return () => clearInterval(timer);
    }, []);
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    const nowTime = `${hh}:${mm}`;

    // --- Lean day summary (clean, no KPI cards) ---
    const dayStats = useMemo(() => {
        const recordings = bookings.length;
        const completed = bookings.filter(b => b.status === 'COMPLETED').length;
        const isPending = (b: BookingWithUser) => b.status !== 'COMPLETED' && b.status !== 'FALTA' && b.status !== 'NAO_REALIZADO';
        // Session whose slot is happening right now.
        const nowSlot = TIMELINE.find(s => s.type === 'SLOT' && nowTime >= s.time && nowTime <= s.timeEnd);
        const nowSession = nowSlot ? bookings.find(b => b.startTime === nowSlot.time && isPending(b)) : undefined;
        // Next upcoming pending session.
        const next = bookings
            .filter(b => b.startTime > nowTime && isPending(b))
            .sort((a, b) => a.startTime.localeCompare(b.startTime))[0];
        return { recordings, completed, nowSession, next };
    }, [bookings, nowTime]);

    if (loading) return <div><HeroSkeleton /><LoadingSpinner /></div>;

    return (
        <div>
            {/* --- LIVE HERO (real-time clock + lean day summary) --- */}
            <div className="today-hero">
                <div className="today-live-badge">
                    <span className="today-live-dot" /> Ao vivo · Visão do dia
                </div>
                <div className="today-clock" aria-label={`Agora são ${hh}:${mm}:${ss}`}>
                    <span className="today-clock-time">{hh}<span className="today-clock-colon">:</span>{mm}</span>
                    <span className="today-clock-secs">{ss}</span>
                </div>
                <div className="today-date">
                    {now.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' })}
                </div>

                {!isSunday && (
                    <div className="today-summary">
                        <span className="today-summary-item">
                            <Clapperboard size={16} style={{ color: 'var(--accent-primary)' }} />
                            <span className="today-summary-num">{dayStats.recordings}</span>&nbsp;gravações hoje
                        </span>
                        <span className="today-summary-item">
                            <CheckCircle2 size={16} style={{ color: '#10b981' }} />
                            <span className="today-summary-num">{dayStats.completed}</span>&nbsp;concluídas
                        </span>

                        {dayStats.nowSession ? (
                            <span className="today-next today-next--now">
                                <span className="today-live-dot" />
                                <span><strong style={{ color: '#10b981' }}>Gravando agora:</strong> {dayStats.nowSession.user.name}</span>
                            </span>
                        ) : dayStats.next ? (
                            <span className="today-next">
                                <ChevronRight size={15} style={{ color: 'var(--accent-primary)', flexShrink: 0 }} />
                                <span>Próxima às <strong style={{ color: 'var(--text-primary)' }}>{dayStats.next.startTime}</strong> · {dayStats.next.user.name}</span>
                            </span>
                        ) : dayStats.recordings > 0 ? (
                            <span className="today-next"><CheckCircle2 size={15} style={{ color: '#10b981', flexShrink: 0 }} /> Tudo concluído por hoje</span>
                        ) : (
                            <button className="today-next" style={{ cursor: 'pointer', fontFamily: 'inherit', color: 'var(--text-secondary)' }}
                                onClick={() => navigate('/calendar')}>
                                <CalendarDays size={15} style={{ color: 'var(--accent-primary)', flexShrink: 0 }} />
                                <span>Nenhuma gravação hoje — abrir agenda</span>
                            </button>
                        )}
                    </div>
                )}
            </div>

            {/* --- SUNDAY --- */}
            {isSunday ? (
                <div style={{
                    padding: '64px 24px', textAlign: 'center', borderRadius: '16px',
                    background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
                }}>
                    <div style={{ fontSize: '4rem', marginBottom: '16px' }}>😴</div>
                    <div style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--text-primary)' }}>Estúdio fechado aos domingos</div>
                    <p style={{ color: 'var(--text-muted)', marginTop: '8px', fontSize: '0.9375rem' }}>Descanse bem. A semana começa amanhã! 🎉</p>
                </div>
            ) : (
                /* --- TIMELINE --- */
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
                        const tierInfo = booking ? getMeta(TIER_META, booking.tierApplied) : null;
                        const TierIcon = tierInfo ? tierInfo.icon : null;

                        return (
                            <div key={item.id} style={{
                                display: 'flex', gap: '16px',
                                padding: '4px 0',
                                opacity: isPast && !booking ? 0.3 : 1,
                                transition: 'opacity 0.3s',
                            }}>
                                {/* -- Left: Dot + Connector -- */}
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

                                {/* -- Right: Slot Card -- */}
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
                                                                display: 'inline-flex', alignItems: 'center', gap: '4px',
                                                            }}>
                                                                {TierIcon && <TierIcon size={11} />} {tierInfo.label}
                                                            </span>
                                                            <span style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', fontWeight: 600 }}>{formatBRL(booking.price)}</span>
                                                        </div>
                                                    </div>
                                                </>
                                            ) : (
                                                <span style={{ color: 'var(--text-muted)', fontSize: '0.8125rem' }}>
                                                    {isPast ? '— Encerrado —' : '🔓 Horário disponível'}
                                                </span>
                                            )}
                                        </div>

                                        {/* Right side: Status + Quick Actions */}
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
                                            {booking && (
                                                <StatusBadge meta={getMeta(BOOKING_STATUS_META, booking.status)} size="md" />
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
                                                    <button className="today-action-btn" title="Finalizar gravação"
                                                        style={{ background: 'rgba(16,185,129,0.12)', color: '#10b981', padding: '4px 8px', fontSize: '0.75rem' }}
                                                        onClick={(e) => { e.stopPropagation(); setFinalizeBooking(booking); }}>
                                                        🏁
                                                    </button>
                                                    <button className="today-action-btn" title="Falta"
                                                        style={{ background: 'rgba(239,68,68,0.08)', color: '#ef4444', padding: '4px 8px', fontSize: '0.75rem' }}
                                                        onClick={(e) => { e.stopPropagation(); handleStatusChange(booking.id, 'FALTA', '❌ Falta'); }}>
                                                        ❌
                                                    </button>
                                                </div>
                                            )}

                                            {booking && (
                                                <span style={{
                                                    fontSize: '0.75rem', color: 'var(--text-muted)',
                                                    transform: isExpanded ? 'rotate(90deg)' : 'none',
                                                    transition: 'transform 0.25s ease',
                                                    display: 'inline-block', marginLeft: '2px',
                                                }}>▶</span>
                                            )}
                                        </div>
                                    </div>

                                    {/* -- Expanded Panel -- */}
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
                                                        onClick={() => setFinalizeBooking(booking)}>
                                                        🏁 Finalizar gravação
                                                    </button>
                                                    <button className="today-action-btn"
                                                        style={{ background: 'rgba(239,68,68,0.08)', color: '#ef4444' }}
                                                        onClick={() => handleStatusChange(booking.id, 'FALTA', '❌ Falta')}>
                                                        ❌ Falta
                                                    </button>
                                                    <button className="today-action-btn"
                                                        style={{ background: 'rgba(45,212,191,0.08)', color: '#14b8a6' }}
                                                        onClick={() => handleStatusChange(booking.id, 'NAO_REALIZADO', '❌ Não Realizado')}>
                                                        ❌ Não Realizado
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
                                                    <button className="today-action-btn" style={{ background: 'rgba(239,68,68,0.08)', color: '#ef4444', marginBottom: '14px' }}
                                                        onClick={() => setFinalizeBooking(booking)}>
                                                        🔴 Dados da transmissão (redes, links e métricas por rede)
                                                    </button>
                                                    <div className="admin-kpi-grid">
                                                        {[
                                                            { label: '⏱️ Duração (min)', value: durationMin, onChange: (v: string) => setDurationMin(v === '' ? '' : Number(v)), type: 'number', ph: 'Ex: 120' },
                                                            { label: '👁️ Pico Viewers', value: peakViewers, onChange: (v: string) => setPeakViewers(v === '' ? '' : Number(v)), type: 'number', ph: 'Ex: 1530' },
                                                            { label: '💬 Mensagens', value: chatMessages, onChange: (v: string) => setChatMessages(v === '' ? '' : Number(v)), type: 'number', ph: 'Ex: 2400' },
                                                            { label: '🌎 Origem', value: audienceOrigin, onChange: setAudienceOrigin, type: 'text', ph: 'Ex: SP Capital' },
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

                                            {/* Notes — `admin-grid-2` collapses to 1 column on ≤640px (mobile). */}
                                            <div className="admin-grid-2" style={{ marginBottom: '20px' }}>
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

            <FinalizeRecordingModal
                isOpen={!!finalizeBooking}
                booking={finalizeBooking}
                onClose={() => setFinalizeBooking(null)}
                onSaved={() => { setFinalizeBooking(null); loadData(); }}
            />
        </div>
    );
}

import React, { useState, useEffect, useCallback } from 'react';
import { bookingsApi, blockedSlotsApi, pricingApi, Slot, BookingWithUser, MyBookingSlot, PricingConfig } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useUI } from '../context/UIContext';
import { useNavigate, useLocation } from 'react-router-dom';
import ModalOverlay from '../components/ModalOverlay';
import BookingModal from '../components/BookingModal';
import ContractWizard from '../components/ContractWizard';
import CustomContractWizard from '../components/CustomContractWizard';

const DAYS = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const PLATFORMS = [
    { key: 'YOUTUBE', label: '▶️ YouTube', color: '#FF0000' },
    { key: 'TIKTOK', label: '🎵 TikTok', color: '#00F2EA' },
    { key: 'INSTAGRAM', label: '📸 Instagram', color: '#E1306C' },
    { key: 'FACEBOOK', label: '📘 Facebook', color: '#1877F2' },
];

const TIER_COLORS: Record<string, { color: string; bg: string; label: string; emoji: string }> = {
    comercial: { color: '#10b981', bg: 'rgba(16,185,129,0.10)', label: 'Comercial', emoji: '🏢' },
    audiencia: { color: '#a78bfa', bg: 'rgba(139,92,246,0.10)', label: 'Audiência', emoji: '🎤' },
    sabado:    { color: '#fbbf24', bg: 'rgba(245,158,11,0.10)', label: 'Sábado', emoji: '🌟' },
};

function getWeekDates(baseDate: Date): Date[] {
    const dates: Date[] = [];
    const d = new Date(baseDate);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    d.setDate(diff);
    for (let i = 0; i < 6; i++) {
        dates.push(new Date(d));
        d.setDate(d.getDate() + 1);
    }
    return dates;
}

function formatDate(d: Date): string {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}
function formatDateShort(d: Date): string { return `${d.getDate().toString().padStart(2, '0')}/${(d.getMonth() + 1).toString().padStart(2, '0')}`; }

const GRID_ROWS = [
    { id: 'S1', type: 'SLOT', time: '10:00', timeEnd: '12:00', label: '10:00 - 12:00', height: 80 },
    { id: 'T1', type: 'TRANSITION', time: '12:00', timeEnd: '13:00', label: 'Intervalo para Almoço', height: 40 },
    { id: 'S2', type: 'SLOT', time: '13:00', timeEnd: '15:00', label: '13:00 - 15:00', height: 80 },
    { id: 'T2', type: 'TRANSITION', time: '15:00', timeEnd: '15:30', label: 'Higienização e Acomodação do próximo cliente', height: 30 },
    { id: 'S3', type: 'SLOT', time: '15:30', timeEnd: '17:30', label: '15:30 - 17:30', height: 80 },
    { id: 'T3', type: 'TRANSITION', time: '17:30', timeEnd: '18:00', label: 'Higienização', height: 30 },
    { id: 'S4', type: 'SLOT', time: '18:00', timeEnd: '20:00', label: '18:00 - 20:00', height: 80 },
    { id: 'T4', type: 'TRANSITION', time: '20:00', timeEnd: '20:30', label: 'Higienização', height: 30 },
    { id: 'S5', type: 'SLOT', time: '20:30', timeEnd: '22:30', label: '20:30 - 22:30', height: 80 },
];

export default function CalendarPage() {
    const { user } = useAuth();
    const navigate = useNavigate();
    const location = useLocation();
    const isAdmin = user?.role === 'ADMIN';
    const [currentWeek, setCurrentWeek] = useState(new Date());
    const [weekDates, setWeekDates] = useState<Date[]>(getWeekDates(new Date()));
    const [slotsMap, setSlotsMap] = useState<Record<string, Slot[]>>({});
    const [bookingsMap, setBookingsMap] = useState<Record<string, BookingWithUser[]>>({});
    const [myBookingsMap, setMyBookingsMap] = useState<Record<string, MyBookingSlot[]>>({});
    const [loading, setLoading] = useState(true);
    const [selectedSlot, setSelectedSlot] = useState<{ date: string; time: string; tier: string; price: number } | null>(null);

    const [showWizard, setShowWizard] = useState(false);
    const [showCustomWizard, setShowCustomWizard] = useState(false);
    const [pricing, setPricing] = useState<PricingConfig[]>([]);

    const [detailBooking, setDetailBooking] = useState<{ booking: MyBookingSlot; date: string } | null>(null);
    const [clientNotes, setClientNotes] = useState('');
    const [platforms, setPlatforms] = useState<string[]>([]);
    const [platformLinks, setPlatformLinks] = useState<Record<string, string>>({});
    const [saving, setSaving] = useState(false);
    const { showAlert, showToast } = useUI();

    const [showReschedule, setShowReschedule] = useState(false);
    const [rescheduleDate, setRescheduleDate] = useState('');
    const [rescheduleTime, setRescheduleTime] = useState('');
    const [rescheduleError, setRescheduleError] = useState('');
    const [rescheduling, setRescheduling] = useState(false);

    const loadWeekData = useCallback(async (dates: Date[]) => {
        setLoading(true);
        try {
            const results = await Promise.all(
                dates.map(d => bookingsApi.getAvailability(formatDate(d)))
            );
            const newSlotsMap: Record<string, Slot[]> = {};
            const newMyBookings: Record<string, MyBookingSlot[]> = {};
            results.forEach((res, i) => {
                const dateKey = formatDate(dates[i]);
                newSlotsMap[dateKey] = res.slots;
                newMyBookings[dateKey] = res.myBookings || [];
            });
            setSlotsMap(newSlotsMap);
            setMyBookingsMap(newMyBookings);

            if (isAdmin) {
                const bookingResults = await Promise.all(
                    dates.map(d => bookingsApi.getAll(formatDate(d)))
                );
                const newBookingsMap: Record<string, BookingWithUser[]> = {};
                bookingResults.forEach((res, i) => {
                    newBookingsMap[formatDate(dates[i])] = res.bookings;
                });
                setBookingsMap(newBookingsMap);
            }
        } catch (err) { console.error('Failed to load calendar data:', err); }
        finally { setLoading(false); }
    }, [isAdmin]);

    useEffect(() => {
        const dates = getWeekDates(currentWeek);
        setWeekDates(dates);
        loadWeekData(dates);
    }, [currentWeek, loadWeekData]);

    useEffect(() => {
        if (location.state?.preSelectedDate && location.state?.preSelectedTime && Object.keys(slotsMap).length > 0) {
            const preDate = location.state.preSelectedDate;
            const preTime = location.state.preSelectedTime;
            const daySlots = slotsMap[preDate];
            if (daySlots) {
                const targetSlot = daySlots.find(s => s.time === preTime && s.available);
                if (targetSlot && targetSlot.tier && targetSlot.price) {
                    setSelectedSlot({ date: preDate, time: preTime, tier: targetSlot.tier, price: targetSlot.price });
                    window.history.replaceState({}, document.title);
                }
            }
        }
    }, [location.state, slotsMap]);

    useEffect(() => {
        pricingApi.get().then(res => setPricing(res.pricing)).catch(err => console.error(err));
    }, []);

    const navigateWeek = (direction: number) => {
        const d = new Date(currentWeek);
        d.setDate(d.getDate() + direction * 7);
        setCurrentWeek(d);
    };
    const goToday = () => setCurrentWeek(new Date());

    const today = formatDate(new Date());

    const buildBookingLookup = (date: string): Record<string, { label: string; tier: string; isMine: boolean; myBooking?: MyBookingSlot }> => {
        const map: Record<string, { label: string; tier: string; isMine: boolean; myBooking?: MyBookingSlot }> = {};
        const myBookings = myBookingsMap[date] || [];
        for (const b of myBookings) {
            map[b.startTime] = { label: `📌 ${user?.name?.split(' ')[0] || 'Eu'}`, tier: b.tierApplied.toLowerCase(), isMine: true, myBooking: b };
        }
        if (isAdmin && bookingsMap[date]) {
            for (const b of bookingsMap[date]) {
                if (!map[b.startTime]) map[b.startTime] = { label: b.user.name, tier: b.tierApplied.toLowerCase(), isMine: false };
            }
        }
        return map;
    };

    const handleSlotClick = (date: string, time: string, slot: Slot, info?: { isMine: boolean; myBooking?: MyBookingSlot }) => {
        if (info?.isMine && info.myBooking) { openDetailModal(info.myBooking, date); return; }
        if (!slot.available || !slot.tier || !slot.price) return;
        setSelectedSlot({ date, time, tier: slot.tier, price: slot.price });
    };

    const openDetailModal = (b: MyBookingSlot, date: string) => {
        setDetailBooking({ booking: b, date });
        setClientNotes(b.clientNotes || '');
        try { setPlatforms(b.platforms ? JSON.parse(b.platforms) : []); } catch { setPlatforms([]); }
        try { setPlatformLinks(b.platformLinks ? JSON.parse(b.platformLinks) : {}); } catch { setPlatformLinks({}); }
        setShowReschedule(false);
        setRescheduleError('');
    };

    const togglePlatform = (key: string) => {
        setPlatforms(prev => prev.includes(key) ? prev.filter(p => p !== key) : [...prev, key]);
    };

    const handleSaveDetail = async () => {
        if (!detailBooking) return;
        setSaving(true);
        try {
            await bookingsApi.clientUpdate(detailBooking.booking.id, {
                clientNotes, platforms: JSON.stringify(platforms), platformLinks: JSON.stringify(platformLinks),
            });
            showToast('Gravação atualizada!');
            setDetailBooking(null);
            loadWeekData(weekDates);
        } catch (err: any) { showAlert({ message: err.message, type: 'error' }); }
        finally { setSaving(false); }
    };

    const canModifyBooking = (b: MyBookingSlot, date: string): boolean => {
        if (b.status !== 'RESERVED' && b.status !== 'CONFIRMED') return false;
        const bookingDateTime = new Date(`${date}T${b.startTime}:00`);
        return (bookingDateTime.getTime() - Date.now()) / (1000 * 60 * 60) >= 24;
    };

    const handleReschedule = async () => {
        if (!detailBooking) return;
        setRescheduling(true); setRescheduleError('');
        try {
            await bookingsApi.reschedule(detailBooking.booking.id, { date: rescheduleDate, startTime: rescheduleTime });
            showToast('Reagendado com sucesso!');
            setDetailBooking(null);
            loadWeekData(weekDates);
        } catch (err: any) { setRescheduleError(err.message); }
        finally { setRescheduling(false); }
    };

    const statusLabel = (s: string) => {
        switch (s) {
            case 'COMPLETED': return '✅ Concluído';
            case 'CONFIRMED': return '✅ Confirmado';
            case 'RESERVED': return '⏳ Reservado';
            case 'FALTA': return '❌ Falta';
            case 'NAO_REALIZADO': return '🔄 Não Realizado';
            default: return '❌ Cancelado';
        }
    };

    // Compute weekly summary
    const weekSummary = (() => {
        let booked = 0, available = 0, total = 0;
        const now = new Date();
        const cutoff = new Date(now.getTime() + 30 * 60 * 1000); // 30 min from now
        weekDates.forEach(d => {
            const dateStr = formatDate(d);
            const slots = slotsMap[dateStr] || [];
            const dayBookings = buildBookingLookup(dateStr);
            slots.forEach(s => {
                if (s.tier) {
                    total++;
                    if (dayBookings[s.time]) {
                        booked++;
                    } else if (s.available) {
                        // Only count as available if slot starts >= 30min from now
                        const slotStart = new Date(`${dateStr}T${s.time}:00`);
                        if (slotStart >= cutoff) available++;
                    }
                }
            });
        });
        return { booked, available, total, pct: total > 0 ? Math.round((booked / total) * 100) : 0 };
    })();

    // Current month/year for display
    const displayMonth = weekDates.length > 0
        ? weekDates[Math.floor(weekDates.length / 2)].toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })
        : '';

    return (
        <div>
            {/* ─── HEADER ─── */}
            <div style={{ marginBottom: '24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '16px' }}>
                <div>
                    <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <span style={{ fontSize: '1.75rem' }}>📅</span> Agenda
                    </h1>
                    <p className="page-subtitle" style={{ marginTop: '4px' }}>
                        {isAdmin ? 'Visão completa da agenda do estúdio' : 'Visualize e agende suas sessões'}
                    </p>
                </div>
                {/* mini KPIs */}
                {isAdmin && (
                <div style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
                    <div style={{ textAlign: 'center' }}>
                        <div style={{ fontSize: '1.25rem', fontWeight: 800, color: '#10b981' }}>{weekSummary.booked}</div>
                        <div style={{ fontSize: '0.5625rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Agendados</div>
                    </div>
                    <div style={{ width: 1, height: 28, background: 'var(--border-color)' }} />
                    <div style={{ textAlign: 'center' }}>
                        <div style={{ fontSize: '1.25rem', fontWeight: 800, color: '#3b82f6' }}>{weekSummary.available}</div>
                        <div style={{ fontSize: '0.5625rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Disponíveis</div>
                    </div>
                    <div style={{ width: 1, height: 28, background: 'var(--border-color)' }} />
                    <div style={{ textAlign: 'center' }}>
                        <div style={{ fontSize: '1.25rem', fontWeight: 800, color: weekSummary.pct >= 70 ? '#10b981' : weekSummary.pct >= 30 ? '#f59e0b' : 'var(--text-muted)' }}>{weekSummary.pct}%</div>
                        <div style={{ fontSize: '0.5625rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Ocupação</div>
                    </div>
                </div>
                )}
            </div>

            {/* ─── CALENDAR CONTAINER ─── */}
            <div className="calendar-container" style={{ borderRadius: '16px', overflow: 'hidden' }}>
                {/* Navigation Bar */}
                <div className="calendar-header" style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '12px 20px', background: 'var(--bg-secondary)',
                    borderBottom: '1px solid var(--border-color)',
                }}>
                    <button className="btn btn-ghost" onClick={goToday}
                        style={{
                            fontSize: '0.6875rem', fontWeight: 700, padding: '5px 12px', borderRadius: '8px',
                            background: 'var(--bg-elevated)', border: '1px solid var(--border-color)',
                        }}>
                        Hoje
                    </button>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                        <button onClick={() => navigateWeek(-1)} style={{
                            width: 30, height: 30, border: '1px solid var(--border-color)', borderRadius: '8px',
                            background: 'var(--bg-elevated)', color: 'var(--text-secondary)',
                            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                            fontSize: '0.75rem', transition: 'all 0.2s',
                        }}>◀</button>

                        <div style={{ textAlign: 'center', minWidth: 180 }}>
                            <div style={{ fontSize: '0.9375rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                                {weekDates.length > 0 && `${formatDateShort(weekDates[0])} — ${formatDateShort(weekDates[5])}`}
                            </div>
                            <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', textTransform: 'capitalize' }}>{displayMonth}</div>
                        </div>

                        <button onClick={() => navigateWeek(1)} style={{
                            width: 30, height: 30, border: '1px solid var(--border-color)', borderRadius: '8px',
                            background: 'var(--bg-elevated)', color: 'var(--text-secondary)',
                            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                            fontSize: '0.75rem', transition: 'all 0.2s',
                        }}>▶</button>
                    </div>
                    {/* Spacer to balance */}
                    <div style={{ width: 60 }} />
                </div>

                {loading ? (
                    <div className="loading-spinner"><div className="spinner" /></div>
                ) : (
                    <div className="calendar-grid" style={{ maxHeight: '70vh', overflowY: 'auto' }}>
                        <div className="calendar-day-header" style={{ position: 'sticky', top: 0, zIndex: 2 }}></div>
                        {weekDates.map((d, i) => (
                            <div key={i} className={`calendar-day-header ${formatDate(d) === today ? 'today' : ''}`}
                                style={{ position: 'sticky', top: 0, zIndex: 2 }}>
                                <span style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', fontWeight: 600 }}>{DAYS[i]}</span>
                                <br />
                                <span style={{ fontSize: '1rem', fontWeight: 800, color: formatDate(d) === today ? '#10b981' : 'var(--text-primary)' }}>
                                    {d.getDate()}
                                </span>
                            </div>
                        ))}

                        {GRID_ROWS.map(row => (
                            <React.Fragment key={row.id}>
                                <div className="calendar-time-label" style={{
                                    height: row.height,
                                    fontSize: '0.75rem',
                                    color: 'var(--text-primary)',
                                    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                                    textAlign: 'center',
                                    opacity: row.type === 'TRANSITION' ? 0 : 1
                                }}>
                                    {row.type === 'SLOT' && (
                                        <>
                                            <span style={{ fontWeight: 600 }}>{row.time}</span>
                                            <span style={{ fontSize: '0.65rem', opacity: 0.6, marginTop: -2 }}>até {row.timeEnd}</span>
                                        </>
                                    )}
                                </div>
                                {weekDates.map((d) => {
                                    const dateStr = formatDate(d);

                                    if (row.type === 'TRANSITION') {
                                        return (
                                            <div key={`${dateStr}-${row.id}`} style={{
                                                background: 'repeating-linear-gradient(45deg, var(--bg-hover), var(--bg-hover) 10px, transparent 10px, transparent 20px)',
                                                borderRight: '1px solid var(--border-subtle)',
                                                borderBottom: '1px solid var(--border-subtle)',
                                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                height: row.height,
                                                opacity: 0.6,
                                                cursor: 'help'
                                            }} title={`${row.time} - ${row.timeEnd}: ${row.label}`}>
                                            </div>
                                        );
                                    }

                                    const slots = slotsMap[dateStr] || [];
                                    const slot = slots.find(s => s.time === row.time);
                                    const isAvailable = slot?.available && slot?.tier;
                                    const lookup = buildBookingLookup(dateStr);
                                    const info = lookup[row.time];

                                    if (info) {
                                        return (
                                            <div
                                                key={`${dateStr}-${row.id}`}
                                                className="calendar-cell occupied"
                                                onClick={() => slot && handleSlotClick(dateStr, row.time, slot, info)}
                                                style={{
                                                    height: row.height, padding: '4px',
                                                    background: info.isMine
                                                        ? 'linear-gradient(135deg, rgba(52,211,153,0.25), rgba(16,185,129,0.15))'
                                                        : undefined,
                                                    border: info.isMine ? '1px solid var(--tier-comercial)' : undefined,
                                                    cursor: info.isMine ? 'pointer' : 'default',
                                                }}
                                            >
                                                <div className={`calendar-slot tier-${info.tier}`}
                                                    style={{ height: '100%', fontWeight: info.isMine ? 800 : 600, fontSize: '0.75rem', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                                                    <div>{info.label}</div>
                                                    <div style={{ fontSize: '0.65rem', fontWeight: 400, opacity: 0.8 }}>{row.label}</div>
                                                </div>
                                            </div>
                                        );
                                    }

                                    const slotNotAvailable = slot && !slot.available;
                                    const slotDateTime = new Date(`${dateStr}T${row.time}:00`);
                                    const isPast = (slotDateTime.getTime() - Date.now()) / (1000 * 60) < 30;

                                    const tierKey = slot?.tier?.toLowerCase() || '';
                                    const tierMeta = TIER_COLORS[tierKey];

                                    return (
                                        <div
                                            key={`${dateStr}-${row.id}`}
                                            className={`calendar-cell ${(slotNotAvailable || isPast) ? 'occupied' : ''}`}
                                            onClick={() => {
                                                if (isPast) {
                                                    showAlert({ message: 'Não é possível agendar um horário no passado (antecedência mínima de 30 minutos).', type: 'warning' });
                                                    return;
                                                }
                                                if (slot && isAvailable) handleSlotClick(dateStr, row.time, slot);
                                            }}
                                            title={!slot?.tier ? 'Fora da Grade' : isPast ? 'Indisponível' : `${tierMeta?.label || ''} — ${row.label}`}
                                            style={{
                                                height: row.height, padding: '4px',
                                                background: (isAvailable && !isPast && tierMeta)
                                                    ? tierMeta.bg
                                                    : undefined,
                                                borderLeft: (isAvailable && !isPast && tierMeta)
                                                    ? `3px solid ${tierMeta.color}`
                                                    : undefined,
                                                opacity: !slot?.tier ? 0.3 : isPast ? 0.5 : 1,
                                                cursor: (isAvailable && !isPast) ? 'pointer' : isPast ? 'not-allowed' : 'default',
                                                transition: 'background 0.2s',
                                            }}
                                        >
                                            {(slotNotAvailable || isPast) && !info ? (
                                                <div className={`calendar-slot tier-${slot?.tier?.toLowerCase() || 'blocked'}`}
                                                    style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', filter: isPast ? 'grayscale(100%) opacity(0.8)' : 'none' }}>
                                                    {isPast ? 'Indisponível' : 'Ocupado'}
                                                </div>
                                            ) : (
                                                (isAvailable && !isPast && !info) && (
                                                    <div style={{
                                                        height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                                                        gap: '2px',
                                                    }}>
                                                        <span style={{ fontWeight: 700, fontSize: '0.8125rem', color: tierMeta?.color || 'var(--text-primary)' }}>
                                                            Disponível
                                                        </span>
                                                        {tierMeta && (
                                                            <span style={{ fontSize: '0.625rem', color: tierMeta.color, opacity: 0.8, fontWeight: 600 }}>
                                                                {tierMeta.emoji} {tierMeta.label}
                                                            </span>
                                                        )}
                                                    </div>
                                                )
                                            )}
                                        </div>
                                    );
                                })}
                            </React.Fragment>
                        ))}
                    </div>
                )}
            </div>

            {/* ─── LEGEND ─── */}
            <div style={{
                display: 'flex', gap: '16px', marginTop: '16px', flexWrap: 'wrap',
                padding: '12px 16px', borderRadius: '12px',
                background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
            }}>
                {Object.entries(TIER_COLORS).map(([key, meta]) => (
                    <div key={key} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.6875rem', fontWeight: 600 }}>
                        <span style={{ width: 10, height: 10, borderRadius: 3, background: meta.color, display: 'inline-block' }} />
                        <span style={{ color: meta.color }}>{meta.emoji} {meta.label}</span>
                    </div>
                ))}
                {!isAdmin && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.6875rem', fontWeight: 600 }}>
                        <span style={{ width: 10, height: 10, borderRadius: 3, border: '2px solid #10b981', background: 'rgba(52,211,153,0.2)', display: 'inline-block' }} />
                        <span style={{ color: '#10b981' }}>📌 Meu Agendamento</span>
                    </div>
                )}
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.6875rem', fontWeight: 600 }}>
                    <span style={{ width: 10, height: 10, borderRadius: 3, background: 'var(--status-blocked)', display: 'inline-block' }} />
                    <span style={{ color: 'var(--text-muted)' }}>Bloqueado / Ocupado</span>
                </div>
            </div>

            {selectedSlot && (
                <BookingModal date={selectedSlot.date} time={selectedSlot.time} tier={selectedSlot.tier}
                    price={selectedSlot.price} onClose={() => setSelectedSlot(null)}
                    onBooked={() => { setSelectedSlot(null); loadWeekData(weekDates); }}
                    onNewContract={() => setShowWizard(true)} />
            )}

            {showWizard && (
                <ContractWizard
                    pricing={pricing}
                    onClose={() => setShowWizard(false)}
                    onComplete={() => navigate('/my-contracts')}
                    onOpenCustom={() => {
                        setShowWizard(false);
                        setShowCustomWizard(true);
                    }}
                />
            )}

            {showCustomWizard && (
                <CustomContractWizard
                    pricing={pricing}
                    onClose={() => setShowCustomWizard(false)}
                    onComplete={() => navigate('/my-contracts')}
                />
            )}

            {/* ─── DETAIL MODAL ─── */}
            {detailBooking && (
                <ModalOverlay onClose={() => setDetailBooking(null)}>
                    <div className="modal" style={{ maxWidth: 540, borderRadius: '16px' }}>
                        <h2 className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <span style={{ fontSize: '1.25rem' }}>📌</span> Meu Agendamento
                        </h2>

                        <div style={{ display: 'grid', gap: '8px', marginBottom: '20px' }}>
                            {[
                                ['📅 Data', detailBooking.date.split('-').reverse().join('/')],
                                ['🕐 Horário', `${detailBooking.booking.startTime} — ${detailBooking.booking.endTime}`],
                            ].map(([label, val]) => (
                                <div key={label} style={{
                                    display: 'flex', justifyContent: 'space-between', padding: '10px 14px',
                                    background: 'var(--bg-secondary)', borderRadius: '10px',
                                    border: '1px solid var(--border-color)',
                                }}>
                                    <span style={{ color: 'var(--text-muted)', fontSize: '0.8125rem' }}>{label}</span>
                                    <span style={{ fontWeight: 600, fontSize: '0.875rem' }}>{val}</span>
                                </div>
                            ))}
                            <div style={{
                                display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px',
                                background: 'var(--bg-secondary)', borderRadius: '10px',
                                border: '1px solid var(--border-color)',
                            }}>
                                <span style={{ color: 'var(--text-muted)', fontSize: '0.8125rem' }}>🏷️ Faixa</span>
                                <span className={`badge badge-${detailBooking.booking.tierApplied.toLowerCase()}`}>{detailBooking.booking.tierApplied}</span>
                            </div>
                            <div style={{
                                display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px',
                                background: 'var(--bg-secondary)', borderRadius: '10px',
                                border: '1px solid var(--border-color)',
                            }}>
                                <span style={{ color: 'var(--text-muted)', fontSize: '0.8125rem' }}>📊 Status</span>
                                <span style={{ fontWeight: 600, fontSize: '0.8125rem' }}>{statusLabel(detailBooking.booking.status)}</span>
                            </div>
                        </div>

                        <div className="form-group">
                            <label className="form-label">📝 Minha Observação</label>
                            <textarea className="form-input" rows={3} value={clientNotes}
                                onChange={e => setClientNotes(e.target.value)}
                                placeholder="Anotações pessoais sobre esta gravação..." style={{ resize: 'vertical' }} />
                        </div>

                        {detailBooking.booking.adminNotes && (
                            <div className="form-group">
                                <label className="form-label">🔒 Observação do Admin</label>
                                <div style={{
                                    padding: '10px 14px', background: 'var(--bg-secondary)', borderRadius: '10px',
                                    border: '1px solid var(--border-color)', fontSize: '0.875rem',
                                    color: 'var(--text-secondary)', whiteSpace: 'pre-wrap',
                                }}>
                                    {detailBooking.booking.adminNotes}
                                </div>
                            </div>
                        )}

                        <div className="form-group">
                            <label className="form-label">📡 Distribuição</label>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '4px' }}>
                                {PLATFORMS.map(p => (
                                    <label key={p.key} style={{
                                        display: 'flex', alignItems: 'center', gap: '6px',
                                        padding: '6px 12px', borderRadius: '10px',
                                        border: `1px solid ${platforms.includes(p.key) ? p.color : 'var(--border-color)'}`,
                                        background: platforms.includes(p.key) ? `${p.color}15` : 'var(--bg-secondary)',
                                        cursor: 'pointer', fontSize: '0.8125rem', fontWeight: 600,
                                        transition: 'all 0.2s',
                                    }}>
                                        <input type="checkbox" checked={platforms.includes(p.key)}
                                            onChange={() => togglePlatform(p.key)} style={{ accentColor: p.color }} />
                                        {p.label}
                                    </label>
                                ))}
                            </div>
                        </div>

                        {platforms.length > 0 && (
                            <div style={{ display: 'grid', gap: '10px', marginBottom: '16px' }}>
                                {platforms.map(pk => {
                                    const plat = PLATFORMS.find(p => p.key === pk);
                                    return (
                                        <div key={pk} className="form-group" style={{ marginBottom: 0 }}>
                                            <label className="form-label">{plat?.label || pk} — Link</label>
                                            <input className="form-input" value={platformLinks[pk] || ''}
                                                onChange={e => setPlatformLinks(prev => ({ ...prev, [pk]: e.target.value }))}
                                                placeholder={`https://${pk.toLowerCase()}.com/...`} />
                                        </div>
                                    );
                                })}
                            </div>
                        )}

                        {showReschedule && (
                            <div style={{
                                padding: '14px', background: 'var(--bg-secondary)', borderRadius: '12px',
                                border: '1px solid var(--border-color)', marginBottom: '16px',
                            }}>
                                <h4 style={{ fontSize: '0.875rem', fontWeight: 700, marginBottom: '10px', display: 'flex', alignItems: 'center', gap: '6px' }}>🔄 Reagendar</h4>
                                <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '10px' }}>Máx. 7 dias · Mesma faixa ({detailBooking.booking.tierApplied})</p>
                                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                                    <input type="date" className="form-input" value={rescheduleDate}
                                        onChange={e => setRescheduleDate(e.target.value)}
                                        min={new Date().toISOString().split('T')[0]}
                                        max={new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0]}
                                        style={{ flex: 1 }} />
                                    <input type="time" className="form-input" value={rescheduleTime}
                                        onChange={e => setRescheduleTime(e.target.value)} step={3600} style={{ width: 120 }} />
                                    <button className="btn btn-primary btn-sm" onClick={handleReschedule}
                                        disabled={rescheduling || !rescheduleDate || !rescheduleTime}
                                        style={{ borderRadius: '10px' }}>
                                        {rescheduling ? '⏳' : '✅'} Confirmar
                                    </button>
                                </div>
                                {rescheduleError && <div className="error-message" style={{ marginTop: '8px' }}>{rescheduleError}</div>}
                            </div>
                        )}

                        <div className="modal-actions" style={{ justifyContent: 'space-between' }}>
                            <div style={{ display: 'flex', gap: '8px' }}>
                                {canModifyBooking(detailBooking.booking, detailBooking.date) && (
                                    <button className="btn btn-secondary btn-sm" onClick={() => setShowReschedule(!showReschedule)}
                                        style={{ borderRadius: '10px' }}>
                                        🔄 Reagendar
                                    </button>
                                )}
                            </div>
                            <div style={{ display: 'flex', gap: '8px' }}>
                                <button className="btn btn-secondary" onClick={() => setDetailBooking(null)} style={{ borderRadius: '10px' }}>Fechar</button>
                                <button className="btn btn-primary" onClick={handleSaveDetail} disabled={saving}
                                    style={{ borderRadius: '10px' }}>
                                    {saving ? '⏳ Salvando...' : '💾 Salvar'}
                                </button>
                            </div>
                        </div>
                    </div>
                </ModalOverlay>
            )}
        </div>
    );
}

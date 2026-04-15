import React, { useState, useEffect, useCallback, useRef } from 'react';
import { bookingsApi, blockedSlotsApi, pricingApi, contractsApi, Slot, BookingWithUser, MyBookingSlot, PricingConfig, AddOnConfig, ContractWithStats } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useUI } from '../context/UIContext';
import { useNavigate, useLocation } from 'react-router-dom';
import ModalOverlay from '../components/ModalOverlay';
import BookingDetailModal from '../components/BookingDetailModal';
import BookingModal from '../components/BookingModal';
import ContractWizard from '../components/ContractWizard';
import CustomContractWizard from '../components/CustomContractWizard';
import { CalendarDays, MapPin, ChevronLeft, ChevronRight } from 'lucide-react';

function useIsMobile(breakpoint = 768) {
    const [isMobile, setIsMobile] = useState(() => window.innerWidth <= breakpoint);
    useEffect(() => {
        const mq = window.matchMedia(`(max-width: ${breakpoint}px)`);
        const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
        mq.addEventListener('change', handler);
        return () => mq.removeEventListener('change', handler);
    }, [breakpoint]);
    return isMobile;
}

const DAYS = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

const TIER_COLORS: Record<string, { color: string; bg: string; label: string; emoji: string }> = {
    comercial: { color: '#10b981', bg: 'rgba(16,185,129,0.10)', label: 'Comercial', emoji: '' },
    audiencia: { color: '#2dd4bf', bg: 'rgba(45,212,191,0.10)', label: 'Audiência', emoji: '' },
    sabado:    { color: '#fbbf24', bg: 'rgba(245,158,11,0.10)', label: 'Sábado', emoji: '' },
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

/** Tiny countdown label for calendar cells with an active payment hold */
function HoldCountdownCell({ expiresAt, label, tier, rowLabel, onExpire, onClick }: {
    expiresAt: string; label: string; tier: string; rowLabel: string;
    onExpire: () => void; onClick: () => void;
}) {
    const [remaining, setRemaining] = useState(() => {
        const diff = new Date(expiresAt).getTime() - Date.now();
        return Math.max(0, Math.floor(diff / 1000));
    });

    useEffect(() => {
        const timer = setInterval(() => {
            const diff = new Date(expiresAt).getTime() - Date.now();
            const secs = Math.max(0, Math.floor(diff / 1000));
            setRemaining(secs);
            if (secs <= 0) { clearInterval(timer); onExpire(); }
        }, 1000);
        return () => clearInterval(timer);
    }, [expiresAt, onExpire]);

    const mins = Math.floor(remaining / 60);
    const secs = remaining % 60;
    const color = remaining <= 60 ? '#ef4444' : remaining <= 180 ? '#f59e0b' : '#d97706';

    return (
        <div
            className="calendar-cell occupied"
            onClick={onClick}
            style={{
                height: 80, padding: '4px',
                background: 'linear-gradient(135deg, rgba(217,119,6,0.18), rgba(245,158,11,0.10))',
                border: `1px solid ${color}`,
                cursor: 'pointer',
                animation: remaining <= 120 ? 'pulse 2s infinite' : undefined,
            }}
        >
            <div className={`calendar-slot tier-${tier}`}
                style={{ height: '100%', fontWeight: 800, fontSize: '0.7rem', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', gap: '2px' }}>
                <div style={{ fontSize: '0.65rem', opacity: 0.85 }}>{label}</div>
                <div style={{
                    fontSize: '0.875rem', fontWeight: 800, fontVariantNumeric: 'tabular-nums', color,
                }}>
                    ⏱ {String(mins).padStart(2, '0')}:{String(secs).padStart(2, '0')}
                </div>
                <div style={{ fontSize: '0.55rem', fontWeight: 600, color, opacity: 0.9 }}>Aguardando Pgto</div>
            </div>
        </div>
    );
}

export default function CalendarPage() {
    const { user } = useAuth();
    const navigate = useNavigate();
    const location = useLocation();
    const isAdmin = user?.role === 'ADMIN';
    const isMobile = useIsMobile();
    const [currentWeek, setCurrentWeek] = useState(new Date());
    const [weekDates, setWeekDates] = useState<Date[]>(getWeekDates(new Date()));
    const [selectedDayIndex, setSelectedDayIndex] = useState(() => {
        const today = new Date().getDay();
        return today === 0 ? 5 : today - 1; // Mon=0 ... Sat=5
    });
    const [slotsMap, setSlotsMap] = useState<Record<string, Slot[]>>({});
    const [bookingsMap, setBookingsMap] = useState<Record<string, BookingWithUser[]>>({});
    const [myBookingsMap, setMyBookingsMap] = useState<Record<string, MyBookingSlot[]>>({});
    const [loading, setLoading] = useState(true);
    const [selectedSlot, setSelectedSlot] = useState<{ date: string; time: string; tier: string; price: number } | null>(null);

    const [showWizard, setShowWizard] = useState(false);
    const [showCustomWizard, setShowCustomWizard] = useState(false);
    const [pricing, setPricing] = useState<PricingConfig[]>([]);

    const [detailBooking, setDetailBooking] = useState<{ booking: MyBookingSlot; date: string } | null>(null);
    const [allAddons, setAllAddons] = useState<AddOnConfig[]>([]);
    const [contracts, setContracts] = useState<ContractWithStats[]>([]);
    const { showAlert, showToast } = useUI();

    // Load addons and contracts once on mount so the detail modal has full context
    useEffect(() => {
        pricingApi.getAddons().then(res => setAllAddons(res.addons)).catch(() => {});
        if (!isAdmin) {
            contractsApi.getMy().then(res => setContracts(res.contracts)).catch(() => {});
        }
    }, [isAdmin]);

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

    const preSelectHandled = useRef(false);
    useEffect(() => {
        if (preSelectHandled.current) return;
        if (location.state?.preSelectedDate && location.state?.preSelectedTime && Object.keys(slotsMap).length > 0) {
            const preDate = location.state.preSelectedDate;
            const preTime = location.state.preSelectedTime;
            const daySlots = slotsMap[preDate];
            if (daySlots) {
                const targetSlot = daySlots.find(s => s.time === preTime && s.available);
                if (targetSlot && targetSlot.tier && targetSlot.price) {
                    preSelectHandled.current = true;
                    setSelectedSlot({ date: preDate, time: preTime, tier: targetSlot.tier, price: targetSlot.price });
                    // Clear React Router state so this effect won't re-fire
                    navigate(location.pathname, { replace: true, state: {} });
                }
            }
        }
    }, [location.state, slotsMap, navigate, location.pathname]);

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
            if (b.status === 'RESERVED' && b.holdExpiresAt && new Date(b.holdExpiresAt).getTime() <= Date.now()) {
                continue;
            }
            map[b.startTime] = { label: `${user?.name?.split(' ')[0] || 'Eu'}`, tier: b.tierApplied.toLowerCase(), isMine: true, myBooking: b };
        }
        if (isAdmin && bookingsMap[date]) {
            for (const b of bookingsMap[date]) {
                if (b.status === 'RESERVED' && b.holdExpiresAt && new Date(b.holdExpiresAt).getTime() <= Date.now()) {
                    continue;
                }
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

    // Selected day for mobile
    const selectedDate = weekDates[selectedDayIndex] || weekDates[0];
    const selectedDateStr = selectedDate ? formatDate(selectedDate) : '';

    return (
        <div>
            {/* ─── HEADER ─── */}
            <div style={{ marginBottom: isMobile ? '16px' : '24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '16px' }}>
                <div>
                    <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        Agenda
                    </h1>
                    <p className="page-subtitle" style={{ marginTop: '4px' }}>
                        {isAdmin ? 'Visão completa da agenda do estúdio' : 'Visualize e agende suas sessões'}
                    </p>
                </div>
                {/* mini KPIs — only on desktop for admin */}
                {isAdmin && !isMobile && (
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

            {/* ─── MOBILE DAY VIEW ─── */}
            {isMobile ? (
                <div className="calendar-mobile">
                    {/* Week Navigation */}
                    <div className="calendar-mobile-nav">
                        <button className="calendar-mobile-nav-btn" onClick={() => navigateWeek(-1)} aria-label="Semana anterior">
                            <ChevronLeft size={20} />
                        </button>
                        <div style={{ textAlign: 'center', flex: 1 }}>
                            <div style={{ fontSize: '0.9375rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                                {weekDates.length > 0 && `${formatDateShort(weekDates[0])} — ${formatDateShort(weekDates[5])}`}
                            </div>
                            <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', textTransform: 'capitalize' }}>{displayMonth}</div>
                        </div>
                        <button className="calendar-mobile-nav-btn" onClick={() => navigateWeek(1)} aria-label="Próxima semana">
                            <ChevronRight size={20} />
                        </button>
                    </div>

                    {/* Day Picker Pills */}
                    <div className="calendar-day-pills">
                        {weekDates.map((d, i) => {
                            const isToday = formatDate(d) === today;
                            const isSelected = i === selectedDayIndex;
                            return (
                                <button
                                    key={i}
                                    className={`calendar-day-pill ${isSelected ? 'calendar-day-pill--selected' : ''} ${isToday ? 'calendar-day-pill--today' : ''}`}
                                    onClick={() => setSelectedDayIndex(i)}
                                >
                                    <span className="calendar-day-pill-name">{DAYS[i]}</span>
                                    <span className="calendar-day-pill-number">{d.getDate()}</span>
                                    {isToday && <span className="calendar-day-pill-dot" />}
                                </button>
                            );
                        })}
                    </div>

                    {/* Today Button */}
                    <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '16px' }}>
                        <button className="btn btn-ghost" onClick={() => { goToday(); setSelectedDayIndex(new Date().getDay() === 0 ? 5 : new Date().getDay() - 1); }}
                            style={{ fontSize: '0.75rem', fontWeight: 700, padding: '8px 20px', borderRadius: '8px', background: 'var(--bg-elevated)', border: '1px solid var(--border-color)', minHeight: '36px' }}>
                            Ir para Hoje
                        </button>
                    </div>

                    {/* Slot Cards */}
                    {loading ? (
                        <div className="loading-spinner"><div className="spinner" /></div>
                    ) : (
                        <div className="calendar-mobile-slots">
                            {GRID_ROWS.map(row => {
                                if (row.type === 'TRANSITION') {
                                    return (
                                        <div key={row.id} className="calendar-mobile-transition">
                                            <span>{row.label}</span>
                                        </div>
                                    );
                                }

                                const slots = slotsMap[selectedDateStr] || [];
                                const slot = slots.find(s => s.time === row.time);
                                const isAvailable = slot?.available && slot?.tier;
                                const lookup = buildBookingLookup(selectedDateStr);
                                const info = lookup[row.time];
                                const slotDateTime = new Date(`${selectedDateStr}T${row.time}:00`);
                                const isPast = (slotDateTime.getTime() - Date.now()) / (1000 * 60) < 30;
                                const tierKey = slot?.tier?.toLowerCase() || '';
                                const tierMeta = TIER_COLORS[tierKey];

                                // Hold countdown
                                const hasActiveHold = info?.isMine && info.myBooking?.holdExpiresAt
                                    && new Date(info.myBooking.holdExpiresAt).getTime() > Date.now();

                                let statusLabel = '';
                                let statusColor = 'var(--text-muted)';
                                let cardBg = 'var(--bg-card)';
                                let borderColor = 'var(--border-subtle)';
                                let clickable = false;

                                if (hasActiveHold) {
                                    statusLabel = 'Aguardando Pagamento';
                                    statusColor = '#f59e0b';
                                    cardBg = 'rgba(245,158,11,0.06)';
                                    borderColor = '#f59e0b';
                                    clickable = true;
                                } else if (info) {
                                    statusLabel = info.isMine ? 'Meu Agendamento' : 'Ocupado';
                                    statusColor = info.isMine ? '#10b981' : 'var(--text-muted)';
                                    cardBg = info.isMine ? 'rgba(16,185,129,0.06)' : 'var(--bg-secondary)';
                                    borderColor = info.isMine ? '#10b981' : 'var(--border-subtle)';
                                    clickable = info.isMine;
                                } else if (isPast || !isAvailable) {
                                    statusLabel = isPast ? 'Indisponível' : (!slot?.tier ? 'Fora da Grade' : 'Bloqueado');
                                    statusColor = 'var(--text-muted)';
                                    cardBg = 'var(--bg-secondary)';
                                } else {
                                    statusLabel = 'Disponível';
                                    statusColor = tierMeta?.color || 'var(--accent-primary)';
                                    cardBg = tierMeta?.bg || 'var(--bg-card)';
                                    borderColor = tierMeta?.color || 'var(--accent-primary)';
                                    clickable = true;
                                }

                                return (
                                    <div
                                        key={row.id}
                                        className={`calendar-mobile-slot ${clickable ? 'calendar-mobile-slot--clickable' : ''}`}
                                        style={{ background: cardBg, borderLeft: `3px solid ${borderColor}` }}
                                        onClick={() => {
                                            if (hasActiveHold && info?.myBooking && slot) {
                                                handleSlotClick(selectedDateStr, row.time, slot, info);
                                            } else if (info?.isMine && info.myBooking) {
                                                openDetailModal(info.myBooking, selectedDateStr);
                                            } else if (clickable && slot && isAvailable && !isPast) {
                                                handleSlotClick(selectedDateStr, row.time, slot);
                                            } else if (isPast) {
                                                showAlert({ message: 'Não é possível agendar um horário no passado (antecedência mínima de 30 minutos).', type: 'warning' });
                                            }
                                        }}
                                    >
                                        <div className="calendar-mobile-slot-time">
                                            <span className="calendar-mobile-slot-start">{row.time}</span>
                                            <span className="calendar-mobile-slot-end">até {row.timeEnd}</span>
                                        </div>
                                        <div className="calendar-mobile-slot-info">
                                            <span className="calendar-mobile-slot-status" style={{ color: statusColor }}>
                                                {info?.isMine ? info.label : statusLabel}
                                            </span>
                                            {tierMeta && isAvailable && !isPast && !info && (
                                                <span className="calendar-mobile-slot-tier" style={{ color: tierMeta.color }}>
                                                    {tierMeta.label}
                                                </span>
                                            )}
                                            {info && (
                                                <span className="calendar-mobile-slot-detail">{row.label}</span>
                                            )}
                                        </div>
                                        {clickable && (
                                            <ChevronRight size={18} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            ) : (
            /* ─── DESKTOP GRID VIEW ─── */
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
                            minHeight: '44px',
                        }}>
                        Hoje
                    </button>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                        <button onClick={() => navigateWeek(-1)} style={{
                            width: 44, height: 44, border: '1px solid var(--border-color)', borderRadius: '10px',
                            background: 'var(--bg-elevated)', color: 'var(--text-secondary)',
                            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                            fontSize: '0.875rem', transition: 'all 0.2s',
                        }}><ChevronLeft size={18} /></button>

                        <div style={{ textAlign: 'center', minWidth: 180 }}>
                            <div style={{ fontSize: '0.9375rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                                {weekDates.length > 0 && `${formatDateShort(weekDates[0])} — ${formatDateShort(weekDates[5])}`}
                            </div>
                            <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', textTransform: 'capitalize' }}>{displayMonth}</div>
                        </div>

                        <button onClick={() => navigateWeek(1)} style={{
                            width: 44, height: 44, border: '1px solid var(--border-color)', borderRadius: '10px',
                            background: 'var(--bg-elevated)', color: 'var(--text-secondary)',
                            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                            fontSize: '0.875rem', transition: 'all 0.2s',
                        }}><ChevronRight size={18} /></button>
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
                                        // Check if this is an avulso booking with active hold timer
                                        const hasActiveHold = info.isMine && info.myBooking?.holdExpiresAt
                                            && new Date(info.myBooking.holdExpiresAt).getTime() > Date.now();

                                        if (hasActiveHold && info.myBooking) {
                                            return (
                                                <HoldCountdownCell
                                                    key={`${dateStr}-${row.id}`}
                                                    expiresAt={info.myBooking.holdExpiresAt!}
                                                    label={`${user?.name?.split(' ')[0] || 'Eu'}`}
                                                    tier={info.tier}
                                                    rowLabel={row.label}
                                                    onExpire={() => loadWeekData(weekDates)}
                                                    onClick={() => slot && handleSlotClick(dateStr, row.time, slot, info)}
                                                />
                                            );
                                        }

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
                                                    style={{ height: '100%', fontWeight: info.isMine ? 800 : 600, fontSize: '0.75rem', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', textAlign: 'center' }}>
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
            )}

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
                        <span style={{ color: '#10b981' }}>Meu Agendamento</span>
                    </div>
                )}
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.6875rem', fontWeight: 600 }}>
                    <span style={{ width: 10, height: 10, borderRadius: 3, background: 'var(--status-blocked)', display: 'inline-block' }} />
                    <span style={{ color: 'var(--text-muted)' }}>Bloqueado / Ocupado</span>
                </div>
            </div>

            {selectedSlot && (
                <BookingModal date={selectedSlot.date} time={selectedSlot.time} tier={selectedSlot.tier}
                    price={selectedSlot.price}
                    onClose={() => { setSelectedSlot(null); loadWeekData(weekDates); }}
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
                <BookingDetailModal
                    booking={{
                        id: detailBooking.booking.id,
                        date: detailBooking.date,
                        startTime: detailBooking.booking.startTime,
                        endTime: detailBooking.booking.endTime,
                        tierApplied: detailBooking.booking.tierApplied,
                        status: detailBooking.booking.status,
                        price: detailBooking.booking.price,
                        clientNotes: detailBooking.booking.clientNotes,
                        adminNotes: detailBooking.booking.adminNotes,
                        platforms: detailBooking.booking.platforms,
                        platformLinks: detailBooking.booking.platformLinks,
                        addOns: detailBooking.booking.addOns,
                        holdExpiresAt: detailBooking.booking.holdExpiresAt,
                    }}
                    onClose={() => setDetailBooking(null)}
                    onSaved={() => { setDetailBooking(null); loadWeekData(weekDates); }}
                    allAddons={allAddons}
                    contractDiscountPct={(() => {
                        const parent = contracts.find(c => c.bookings?.some(b => b.id === detailBooking.booking.id));
                        return parent?.discountPct || 0;
                    })()}
                    contractAddOns={(() => {
                        const parent = contracts.find(c => c.bookings?.some(b => b.id === detailBooking.booking.id));
                        return parent?.addOns || [];
                    })()}
                />
            )}
        </div>
    );
}

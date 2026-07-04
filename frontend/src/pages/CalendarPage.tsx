import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import HeroAmbient from '../components/client/HeroAmbient';
import { bookingsApi, blockedSlotsApi, pricingApi, contractsApi, Slot, BookingWithUser, MyBookingSlot, PricingConfig, AddOnConfig, ContractWithStats } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useUI } from '../context/UIContext';
import { useNavigate, useLocation } from 'react-router-dom';
import BookingDetailModal from '../components/BookingDetailModal';
import BookingModal from '../components/BookingModal';
import ContractWizard from '../components/ContractWizard';
import CustomContractWizard from '../components/CustomContractWizard';
import BottomSheetModal from '../components/BottomSheetModal';
import { PosterGallery, PosterCard } from '../components/client/PosterGallery';
import Skeleton from '../components/ui/SkeletonLoader';
import AdminPageHeader from '../components/admin/AdminPageHeader';
import { useBusinessConfig } from '../hooks/useBusinessConfig';
import { useIsMobile } from '../hooks/useIsMobile';
import { studioSlotDate, todayStrSaoPaulo } from '../utils/time';
import { CalendarDays, Mic, Clock, List } from 'lucide-react';
import CalendarMobileView from '../components/calendar/CalendarMobileView';
import CalendarDesktopView from '../components/calendar/CalendarDesktopView';
import { TIER_COLORS, getWeekDates, formatDate } from '../components/calendar/calendarShared';

export default function CalendarPage() {
    const { user } = useAuth();
    const navigate = useNavigate();
    const location = useLocation();
    const isAdmin = user?.role === 'ADMIN';
    const isMobile = useIsMobile();
    const { get: getConfigNum } = useBusinessConfig();
    // Minimum advance notice for clients (admin books any time). Slots closer than this
    // are greyed out to match the backend rule.
    const minAdvanceHours = getConfigNum('booking_min_advance_hours') || 12;
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
    const [isFetchingWeek, setIsFetchingWeek] = useState(false);
    // Crossfade state for slot cards (4-phase: visible → out → out_done → in)
    const [slotsPhase, setSlotsPhase] = useState<'visible' | 'out' | 'out_done' | 'in'>('visible');
    const [showPastSlotAlert, setShowPastSlotAlert] = useState(false);
    const [displayDateStr, setDisplayDateStr] = useState(() => {
        const initialDates = getWeekDates(new Date());
        const todayIdx = new Date().getDay();
        const initIdx = todayIdx === 0 ? 5 : todayIdx - 1;
        const d = initialDates[initIdx] || initialDates[0];
        return d ? formatDate(d) : '';
    });
    const slotsFadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    
    const getStartOfWeek = (d: Date) => {
        const date = new Date(d);
        const day = date.getDay();
        const diff = date.getDate() - day + (day === 0 ? -6 : 1);
        return new Date(date.setDate(diff));
    };

    const [currentDate, setCurrentDate] = useState(() => getStartOfWeek(new Date()));
    const [selectedSlot, setSelectedSlot] = useState<{ date: string, time: string, tier: string, price: number } | null>(null);
    const lastSelectedSlot = useRef<{ date: string, time: string, tier: string, price: number } | null>(null);
    if (selectedSlot) lastSelectedSlot.current = selectedSlot;

    const [detailBooking, setDetailBooking] = useState<{ date: string, booking: MyBookingSlot } | null>(null);
    const lastDetailBooking = useRef<{ date: string, booking: MyBookingSlot } | null>(null);
    if (detailBooking) lastDetailBooking.current = detailBooking;

    const [activeTab, setActiveTab] = useState<'agendar' | 'agendados'>('agendar');
    const [allMyBookings, setAllMyBookings] = useState<any[]>([]);

    const [showWizard, setShowWizard] = useState(false);
    const [showCustomWizard, setShowCustomWizard] = useState(false);
    const [pricing, setPricing] = useState<PricingConfig[]>([]);
    const [allAddons, setAllAddons] = useState<AddOnConfig[]>([]);
    const [contracts, setContracts] = useState<ContractWithStats[]>([]);
    const { showAlert, showToast } = useUI();

    const prevWeekDates = useMemo(() => {
        const d = new Date(currentWeek);
        d.setDate(d.getDate() - 7);
        return getWeekDates(d);
    }, [currentWeek]);
    const nextWeekDates = useMemo(() => {
        const d = new Date(currentWeek);
        d.setDate(d.getDate() + 7);
        return getWeekDates(d);
    }, [currentWeek]);

    const bookingsSectionRef = useRef<HTMLDivElement>(null);


    // Load addons and contracts once on mount so the detail modal has full context
    useEffect(() => {
        pricingApi.getAddons().then(res => setAllAddons(res.addons)).catch(() => {});
        if (!isAdmin) {
            contractsApi.getMy().then(res => setContracts(res.contracts)).catch(() => {});
        }
    }, [isAdmin]);

    const loadWeekData = useCallback(async (dates: Date[]) => {
        setIsFetchingWeek(true);
        try {
            const results = await Promise.all(
                dates.map(d => bookingsApi.getAvailability(formatDate(d)))
            );
            const newSlotsMap: Record<string, Slot[]> = {};
            const newMyBookingsMap: Record<string, MyBookingSlot[]> = {};
            results.forEach((res, i) => {
                const dateKey = formatDate(dates[i]);
                newSlotsMap[dateKey] = res.slots;
                newMyBookingsMap[dateKey] = res.myBookings || [];
            });
            setSlotsMap(prev => ({ ...prev, ...newSlotsMap }));
            setMyBookingsMap(prev => ({ ...prev, ...newMyBookingsMap }));

            if (isAdmin) {
                const bookingResults = await Promise.all(
                    dates.map(d => bookingsApi.getAll(formatDate(d)))
                );
                const newBookingsMap: Record<string, BookingWithUser[]> = {};
                bookingResults.forEach((res, i) => {
                    newBookingsMap[formatDate(dates[i])] = res.bookings;
                });
                setBookingsMap(prev => ({ ...prev, ...newBookingsMap }));
            }
        } catch (err) { console.error('Failed to load calendar data:', err); }
        finally { 
            setLoading(false); 
            setIsFetchingWeek(false);
        }
    }, [isAdmin]);

    useEffect(() => {
        const dates = getWeekDates(currentWeek);
        setWeekDates(dates);
        loadWeekData(dates);
        // (o reset do carrossel de pills vive na CalendarMobileView, que observa weekDates)
    }, [currentWeek, loadWeekData]);

    // Refetch calendar data when user returns to this tab (e.g. after paying)
    useEffect(() => {
        const handleVisibility = () => {
            if (document.visibilityState === 'visible') {
                const dates = getWeekDates(currentWeek);
                loadWeekData(dates);
                if (!isAdmin) {
                    bookingsApi.getMy()
                        .then(res => setAllMyBookings(res.bookings))
                        .catch(() => {});
                }
            }
        };
        document.addEventListener('visibilitychange', handleVisibility);
        return () => document.removeEventListener('visibilitychange', handleVisibility);
    }, [currentWeek, loadWeekData, isAdmin]);

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
    const goToday = () => {
        const now = new Date();
        setCurrentWeek(now);
        setSelectedDayIndex(now.getDay() === 0 ? 5 : now.getDay() - 1);
    };

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
        // Clients must respect the minimum advance notice; admin can book any time.
        const cutoffMs = Date.now() + (isAdmin ? 0 : minAdvanceHours * 60 * 60 * 1000);
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
                        // Only count as available if the slot starts after the cutoff (São Paulo)
                        const slotStart = studioSlotDate(dateStr, s.time);
                        if (slotStart.getTime() >= cutoffMs) available++;
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

    // 4-phase crossfade: fade-out → wait for fetch → swap content → fade-in
    useEffect(() => {
        if (!selectedDateStr || loading || selectedDateStr === displayDateStr) return;
        
        if (slotsFadeTimer.current) clearTimeout(slotsFadeTimer.current);
        // Phase 1: fade out (150ms)
        setSlotsPhase('out');
        slotsFadeTimer.current = setTimeout(() => {
            // Phase 2: wait for data
            setSlotsPhase('out_done');
        }, 150);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedDateStr, loading, displayDateStr]);

    useEffect(() => {
        if (slotsPhase === 'out_done' && !isFetchingWeek) {
            // Phase 3: swap content while invisible, then fade in (260ms)
            setDisplayDateStr(selectedDateStr);
            setSlotsPhase('in');
            if (slotsFadeTimer.current) clearTimeout(slotsFadeTimer.current);
            slotsFadeTimer.current = setTimeout(() => setSlotsPhase('visible'), 260);
        }
    }, [slotsPhase, isFetchingWeek, selectedDateStr]);

    // Fetch all user bookings on mount so the Agendados carrousel has the complete list
    useEffect(() => {
        if (!isAdmin && user?.role !== 'ADMIN') {
            bookingsApi.getMy()
                .then(res => setAllMyBookings(res.bookings))
                .catch(err => console.error("Failed to fetch all bookings", err));
        }
    }, [isAdmin, user]);

    // ─── Derive upcoming bookings from allMyBookings + myBookingsMap ───
    const DAY_NAMES_FULL = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
    const upcomingBookings = useMemo(() => {
        const now = new Date();
        const map = new Map<string, { booking: any; date: string; dateObj: Date }>();

        // 1. Add all globally fetched bookings
        allMyBookings.forEach(b => {
            if (b.status === 'RESERVED' && b.holdExpiresAt && new Date(b.holdExpiresAt).getTime() <= Date.now()) return;
            const dateStr = b.date.split('T')[0];
            const slotDatetime = studioSlotDate(dateStr, b.startTime);
            if (slotDatetime >= now && (b.status === 'RESERVED' || b.status === 'CONFIRMED')) {
                map.set(b.id, { booking: b, date: dateStr, dateObj: slotDatetime });
            }
        });

        // 2. Merge/Overwrite with freshly fetched data from the week view
        for (const [dateStr, bookings] of Object.entries(myBookingsMap)) {
            for (const b of bookings) {
                if (b.status === 'RESERVED' && b.holdExpiresAt && new Date(b.holdExpiresAt).getTime() <= Date.now()) continue;
                const slotDatetime = studioSlotDate(dateStr, b.startTime);
                if (slotDatetime >= now && (b.status === 'RESERVED' || b.status === 'CONFIRMED')) {
                    map.set(b.id, { booking: b, date: dateStr, dateObj: slotDatetime });
                }
            }
        }

        const list = Array.from(map.values());
        list.sort((a, b) => a.dateObj.getTime() - b.dateObj.getTime());
        return list;
    }, [myBookingsMap, allMyBookings]);

    return (
        <div>
            {/* ─── CLIENT HERO ─── */}
            {!isAdmin && (
                <div className="client-hero client-hero--default animate-card-enter">
                    <HeroAmbient variant="agenda" />
                    <div className="client-hero__header" style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '20px' }}>
                        <div className="client-hero__icon-wrapper">
                            <CalendarDays size={24} />
                        </div>
                        <div>
                            <h2 className="client-hero__greeting" style={{ margin: 0 }}>Agenda</h2>
                            <p className="client-hero__message" style={{ margin: '4px 0 0 0' }}>
                                {upcomingBookings.length > 0 
                                    ? `Você tem ${upcomingBookings.length} sessão(ões) agendada(s)`
                                    : 'Acompanhe seus horários de gravação'}
                            </p>
                        </div>
                    </div>
                    <div className="client-cta-stack">
                        <button 
                            className={`btn ${activeTab === 'agendar' ? 'btn-primary' : 'btn-secondary'}`}
                            onClick={() => setActiveTab('agendar')}
                        >
                            <CalendarDays size={18} /> Agendar
                        </button>
                        <button 
                            className={`btn ${activeTab === 'agendados' ? 'btn-primary' : 'btn-secondary'}`}
                            onClick={() => setActiveTab('agendados')}
                        >
                            <List size={18} /> Agendados
                            {upcomingBookings.length > 0 && (
                                <span style={{ 
                                    background: activeTab === 'agendados' ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.08)',
                                    color: '#fff',
                                    borderRadius: '10px', padding: '2px 8px', fontSize: '0.7rem', fontWeight: 700,
                                    lineHeight: '1.2'
                                }}>
                                    {upcomingBookings.length}
                                </span>
                            )}
                        </button>
                    </div>
                </div>
            )}
            
            {isAdmin && (
                <AdminPageHeader
                    icon={CalendarDays}
                    title="Agenda"
                    subtitle="Visão completa da agenda do estúdio"
                    actions={
                        <div className="agenda-hero-stats" role="group" aria-label="Resumo da semana">
                            <div className="agenda-hero-stat">
                                <div className="agenda-hero-stat__value agenda-hero-stat__value--success">{weekSummary.booked}</div>
                                <div className="agenda-hero-stat__label">Agendados</div>
                            </div>
                            <div className="agenda-hero-stat">
                                <div className="agenda-hero-stat__value agenda-hero-stat__value--info">{weekSummary.available}</div>
                                <div className="agenda-hero-stat__label">Disponíveis</div>
                            </div>
                            <div className="agenda-hero-stat">
                                <div className={`agenda-hero-stat__value agenda-hero-stat__value--${weekSummary.pct >= 70 ? 'success' : weekSummary.pct >= 30 ? 'warning' : 'muted'}`}>{weekSummary.pct}%</div>
                                <div className="agenda-hero-stat__label">Ocupação</div>
                            </div>
                        </div>
                    }
                />
            )}

            {/* ─── TAB CONTENT WRAPPER ─── */}
            <div className="view-transition-wrapper">
                {(!isAdmin && activeTab === 'agendados') ? (
                    // ─── UPCOMING BOOKINGS TAB (client only) ───
                    <div key="agendados" className="fade-in-view">
                        {!loading && upcomingBookings.length === 0 ? (
                            <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-muted)' }}>
                                <CalendarDays size={48} style={{ opacity: 0.2, margin: '0 auto 16px' }} />
                                <p>Você não possui agendamentos futuros.</p>
                            </div>
                        ) : (
                            <div ref={bookingsSectionRef} className="client-section" style={{ marginBottom: '20px' }}>
                                <div className="client-section__header-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                                    <h3 className="client-section__heading" style={{ marginBottom: 0 }}>
                                        <span className="client-section__heading-icon client-section__heading-icon--accent">
                                            <CalendarDays size={16} />
                                        </span>
                                        Seus Agendamentos
                                    </h3>
                                </div>
                                <PosterGallery
                                    revision={loading ? 'loading' : upcomingBookings.length}
                                    busy={loading}
                                    label="Seus agendamentos"
                                >
                                    {loading
                                        ? [0, 1, 2].map(i => (
                                            <div key={i} className="poster-card poster-card--skel">
                                                <Skeleton variant="rounded" width="100%" height="100%" />
                                            </div>
                                        ))
                                        : upcomingBookings.map((item, i) => {
                                            const dayLabel = DAY_NAMES_FULL[item.dateObj.getUTCDay()];
                                            const dateLabel = item.dateObj.toLocaleDateString('pt-BR', { timeZone: 'UTC', day: '2-digit', month: '2-digit' });
                                            const isToday = item.date === todayStrSaoPaulo();
                                            const b = item.booking as { coverImageUrl?: string | null; episodeTitle?: string | null; contract?: { name?: string } | null; tierApplied: string; startTime: string; endTime: string };
                                            const title = b.episodeTitle || b.contract?.name || b.tierApplied;
                                            return (
                                                <PosterCard
                                                    key={`${item.date}-${item.booking.startTime}`}
                                                    index={i}
                                                    tone="teal"
                                                    highlight={isToday}
                                                    coverUrl={b.coverImageUrl}
                                                    placeholder={<Mic size={46} strokeWidth={1.25} />}
                                                    badgeTopRight={isToday ? <span className="poster-chip poster-chip--today">Hoje</span> : undefined}
                                                    eyebrow={`${dayLabel}, ${dateLabel}`}
                                                    title={title}
                                                    footer={<span className="poster-card__time">{b.startTime} — {b.endTime}</span>}
                                                    ariaLabel={`${title}, ${isToday ? 'hoje, ' : ''}${dayLabel} ${dateLabel}, ${b.startTime} às ${b.endTime}`}
                                                    onClick={() => setDetailBooking({ booking: item.booking, date: item.date })}
                                                />
                                            );
                                        })}
                                </PosterGallery>
                            </div>
                        )}
                    </div>
                ) : (
                    // ─── AGENDAR TAB (Calendar Grid) ───
                    <div key="agendar" className="fade-in-view">
            {isMobile ? (
                <CalendarMobileView
                    isAdmin={isAdmin}
                    minAdvanceHours={minAdvanceHours}
                    loading={loading}
                    weekDates={weekDates}
                    prevWeekDates={prevWeekDates}
                    nextWeekDates={nextWeekDates}
                    selectedDayIndex={selectedDayIndex}
                    onSelectDay={setSelectedDayIndex}
                    navigateWeek={navigateWeek}
                    goToday={goToday}
                    today={today}
                    displayMonth={displayMonth}
                    slotsPhase={slotsPhase}
                    displayDateStr={displayDateStr}
                    selectedDateStr={selectedDateStr}
                    slotsMap={slotsMap}
                    buildBookingLookup={buildBookingLookup}
                    onSlotClick={handleSlotClick}
                    onOpenDetail={openDetailModal}
                    onPastSlot={() => setShowPastSlotAlert(true)}
                />
            ) : (
                <CalendarDesktopView
                    isAdmin={isAdmin}
                    userFirstName={user?.name?.split(' ')[0] || 'Eu'}
                    minAdvanceHours={minAdvanceHours}
                    loading={loading}
                    weekDates={weekDates}
                    displayMonth={displayMonth}
                    today={today}
                    slotsMap={slotsMap}
                    buildBookingLookup={buildBookingLookup}
                    onSlotClick={handleSlotClick}
                    onPastSlot={() => setShowPastSlotAlert(true)}
                    onHoldExpire={() => loadWeekData(weekDates)}
                    goToday={goToday}
                    navigateWeek={navigateWeek}
                />
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
                        <span style={{ color: meta.color }}>{meta.label}</span>
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
            </div>
            )}
        </div>

            {/* ─── MODALS ─── */}
            {(selectedSlot || lastSelectedSlot.current) && (
                <BookingModal 
                    isOpen={!!selectedSlot}
                    date={(selectedSlot || lastSelectedSlot.current)?.date || ''}
                    time={(selectedSlot || lastSelectedSlot.current)?.time || ''}
                    tier={(selectedSlot || lastSelectedSlot.current)?.tier || ''}
                    price={(selectedSlot || lastSelectedSlot.current)?.price || 0}
                    onClose={() => { setSelectedSlot(null); loadWeekData(weekDates); }}
                    onBooked={() => { setSelectedSlot(null); loadWeekData(weekDates); }}
                    onNewContract={() => setShowWizard(true)} 
                />
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
            {(detailBooking || lastDetailBooking.current) && (
                <BookingDetailModal
                    isOpen={!!detailBooking}
                    booking={detailBooking ? {
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
                    } : {
                        id: lastDetailBooking.current!.booking.id,
                        date: lastDetailBooking.current!.date,
                        startTime: lastDetailBooking.current!.booking.startTime,
                        endTime: lastDetailBooking.current!.booking.endTime,
                        tierApplied: lastDetailBooking.current!.booking.tierApplied,
                        status: lastDetailBooking.current!.booking.status,
                        price: lastDetailBooking.current!.booking.price,
                        clientNotes: lastDetailBooking.current!.booking.clientNotes,
                        adminNotes: lastDetailBooking.current!.booking.adminNotes,
                        platforms: lastDetailBooking.current!.booking.platforms,
                        platformLinks: lastDetailBooking.current!.booking.platformLinks,
                        addOns: lastDetailBooking.current!.booking.addOns,
                        holdExpiresAt: lastDetailBooking.current!.booking.holdExpiresAt,
                    }}
                    onClose={() => setDetailBooking(null)}
                    onSaved={() => { setDetailBooking(null); loadWeekData(weekDates); }}
                    allAddons={allAddons}
                    contractDiscountPct={(() => {
                        const parent = contracts.find(c => c.bookings?.some(b => b.id === (detailBooking || lastDetailBooking.current)?.booking.id));
                        return parent?.discountPct || 0;
                    })()}
                    contractAddOns={(() => {
                        const parent = contracts.find(c => c.bookings?.some(b => b.id === (detailBooking || lastDetailBooking.current)?.booking.id));
                        return parent?.addOns || [];
                    })()}
                />
            )}

            <BottomSheetModal isOpen={showPastSlotAlert} onClose={() => setShowPastSlotAlert(false)} title="Ação Indisponível">
                <div style={{ padding: '0 20px 30px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                    <div style={{ margin: '10px 0 20px', color: 'var(--text-muted)' }}>
                        <Clock size={48} strokeWidth={1.5} />
                    </div>
                    <p style={{ color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: '10px', fontSize: '0.9375rem', maxWidth: '300px' }}>
                        Não é possível agendar um horário no passado, ou com antecedência inferior a 30 minutos.
                    </p>
                </div>
            </BottomSheetModal>
        </div>
    );
}

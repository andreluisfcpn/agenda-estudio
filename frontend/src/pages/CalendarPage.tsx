import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { bookingsApi, blockedSlotsApi, pricingApi, contractsApi, Slot, BookingWithUser, MyBookingSlot, PricingConfig, AddOnConfig, ContractWithStats } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useUI } from '../context/UIContext';
import { useNavigate, useLocation } from 'react-router-dom';
import BookingDetailModal from '../components/BookingDetailModal';
import BookingModal from '../components/BookingModal';
import ContractWizard from '../components/ContractWizard';
import CustomContractWizard from '../components/CustomContractWizard';
import BottomSheetModal from '../components/BottomSheetModal';
import { CalendarDays, ChevronLeft, ChevronRight, Mic, Clock, List } from 'lucide-react';

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

    // ─── Pills carousel (3-panel: prev | current | next) ───
    const pillsCarouselRef = useRef<HTMLDivElement>(null);
    const pillsDragStartX = useRef(0);
    const pillsDragDelta = useRef(0);
    const pillsDragging = useRef(false);
    const pillsTransitioning = useRef(false);
    const pillsDragStartY = useRef(0);
    const pillsIsHorizontal = useRef<boolean | null>(null);

    const slotListRef = useRef<HTMLDivElement>(null);
    const swipeTouchStartX = useRef(0);
    const swipeTouchStartY = useRef(0);

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

    const setPillsTransform = (px: number, withTransition = false) => {
        const el = pillsCarouselRef.current;
        if (!el) return;
        el.style.transition = withTransition ? 'transform 0.35s cubic-bezier(0.22, 1, 0.36, 1)' : 'none';
        el.style.transform = `translateX(calc(-33.333% + ${px}px))`;
    };

    const finishPillsSnap = (direction: number) => {
        pillsTransitioning.current = true;
        const el = pillsCarouselRef.current;
        // Animate to target panel
        if (direction === 0) {
            setPillsTransform(0, true); // snap back
        } else {
            // direction 1 = next (slide left to -200%), direction -1 = prev (slide right to 0%)
            if (el) {
                el.style.transition = 'transform 0.35s cubic-bezier(0.22, 1, 0.36, 1)';
                el.style.transform = direction > 0 ? 'translateX(-66.666%)' : 'translateX(0%)';
            }
        }
        setTimeout(() => {
            pillsTransitioning.current = false;
            if (direction !== 0) {
                navigateWeek(direction);
                // Reset to center without animation
                requestAnimationFrame(() => {
                    if (el) {
                        el.style.transition = 'none';
                        el.style.transform = 'translateX(-33.333%)';
                    }
                });
            }
        }, 360);
    };

    const handlePillsDragStart = (clientX: number, clientY: number) => {
        if (pillsTransitioning.current) return;
        pillsDragging.current = true;
        pillsDragStartX.current = clientX;
        pillsDragStartY.current = clientY;
        pillsDragDelta.current = 0;
        pillsIsHorizontal.current = null;
    };
    const handlePillsDragMove = (clientX: number, clientY: number) => {
        if (!pillsDragging.current) return;
        const dx = clientX - pillsDragStartX.current;
        const dy = clientY - pillsDragStartY.current;
        // Lock direction on first significant move
        if (pillsIsHorizontal.current === null && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
            pillsIsHorizontal.current = Math.abs(dx) > Math.abs(dy);
        }
        if (pillsIsHorizontal.current === false) return; // vertical scroll, ignore
        if (pillsIsHorizontal.current === true) {
            // Prevent page scroll during horizontal drag
            pillsDragDelta.current = dx;
            setPillsTransform(dx);
        }
    };
    const handlePillsDragEnd = () => {
        if (!pillsDragging.current) return;
        pillsDragging.current = false;
        const dx = pillsDragDelta.current;
        const THRESHOLD = 60;
        if (dx < -THRESHOLD) {
            finishPillsSnap(1); // next week
        } else if (dx > THRESHOLD) {
            finishPillsSnap(-1); // prev week
        } else {
            finishPillsSnap(0); // snap back
        }
        pillsDragDelta.current = 0;
    };

    // ─── Carousel refs (same momentum pattern as dashboard) ───
    const carouselRef = useRef<HTMLDivElement>(null);
    const carouselDragging = useRef(false);
    const carouselStartX = useRef(0);
    const carouselScrollLeft = useRef(0);
    const carouselVelocity = useRef(0);
    const carouselLastX = useRef(0);
    const carouselAnimRef = useRef<number | null>(null);
    const bookingsSectionRef = useRef<HTMLDivElement>(null);
    const calendarSectionRef = useRef<HTMLDivElement>(null);

    const stopCarouselMomentum = () => {
        if (carouselAnimRef.current !== null) {
            cancelAnimationFrame(carouselAnimRef.current);
            carouselAnimRef.current = null;
        }
    };
    const applyCarouselMomentum = () => {
        if (!carouselRef.current) return;
        carouselVelocity.current *= 0.92;
        if (Math.abs(carouselVelocity.current) < 0.5) {
            carouselRef.current.style.scrollSnapType = 'x mandatory';
            return;
        }
        carouselRef.current.scrollLeft += carouselVelocity.current;
        carouselAnimRef.current = requestAnimationFrame(applyCarouselMomentum);
    };


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
        // Double-rAF ensures the carousel resets after React's DOM commit
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                const el = pillsCarouselRef.current;
                if (el) {
                    el.style.transition = 'none';
                    el.style.transform = 'translateX(-33.333%)';
                }
            });
        });
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
            const slotDatetime = new Date(`${dateStr}T${b.startTime}:00`);
            if (slotDatetime >= now && (b.status === 'RESERVED' || b.status === 'CONFIRMED')) {
                map.set(b.id, { booking: b, date: dateStr, dateObj: slotDatetime });
            }
        });

        // 2. Merge/Overwrite with freshly fetched data from the week view
        for (const [dateStr, bookings] of Object.entries(myBookingsMap)) {
            for (const b of bookings) {
                if (b.status === 'RESERVED' && b.holdExpiresAt && new Date(b.holdExpiresAt).getTime() <= Date.now()) continue;
                const slotDatetime = new Date(`${dateStr}T${b.startTime}:00`);
                if (slotDatetime >= now && (b.status === 'RESERVED' || b.status === 'CONFIRMED')) {
                    map.set(b.id, { booking: b, date: dateStr, dateObj: slotDatetime });
                }
            }
        }

        const list = Array.from(map.values());
        list.sort((a, b) => a.dateObj.getTime() - b.dateObj.getTime());
        return list;
    }, [myBookingsMap, allMyBookings]);

    const nextBooking = upcomingBookings.length > 0 ? upcomingBookings[0] : null;

    // Bounce hint for carousel on load
    useEffect(() => {
        if (!loading && upcomingBookings.length > 0 && carouselRef.current) {
            const t1 = setTimeout(() => {
                if (carouselRef.current) carouselRef.current.scrollBy({ left: 40, behavior: 'smooth' });
                const t2 = setTimeout(() => {
                    if (carouselRef.current) carouselRef.current.scrollBy({ left: -40, behavior: 'smooth' });
                }, 400);
                return () => clearTimeout(t2);
            }, 1200);
            return () => clearTimeout(t1);
        }
    }, [loading, upcomingBookings.length]);

    return (
        <div>
            {/* ─── CLIENT HERO ─── */}
            {!isAdmin && (
                <div className="client-hero client-hero--default animate-card-enter">
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
                <div style={{ marginBottom: '20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '16px' }}>
                    <div>
                        <h1 className="page-title">Agenda</h1>
                        <p className="page-subtitle">Visão completa da agenda do estúdio</p>
                    </div>
                    {!isMobile && (
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
            )}

            {/* ─── TAB CONTENT WRAPPER ─── */}
            <div className="view-transition-wrapper">
                {(!isAdmin && activeTab === 'agendados') ? (
                    // ─── UPCOMING BOOKINGS TAB (client only) ───
                    <div key="agendados" className="fade-in-view">
                        {upcomingBookings.length > 0 ? (
                            <div ref={bookingsSectionRef} className="client-section" style={{ marginBottom: '20px' }}>
                                <div className="client-section__header-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                                    <h3 className="client-section__heading" style={{ marginBottom: 0 }}>
                                        <span className="client-section__heading-icon client-section__heading-icon--accent">
                                            <CalendarDays size={16} />
                                        </span>
                                        Seus Agendamentos
                                    </h3>
                                </div>
                                <div
                                    ref={carouselRef}
                                    className="client-scroll-section stagger-enter"
                                    onMouseDown={(e) => {
                                        if (!carouselRef.current) return;
                                        stopCarouselMomentum();
                                        carouselDragging.current = true;
                                        carouselStartX.current = e.pageX;
                                        carouselScrollLeft.current = carouselRef.current.scrollLeft;
                                        carouselLastX.current = e.pageX;
                                        carouselVelocity.current = 0;
                                        carouselRef.current.style.cursor = 'grabbing';
                                        carouselRef.current.style.scrollSnapType = 'none';
                                        carouselRef.current.style.userSelect = 'none';
                                    }}
                                    onMouseMove={(e) => {
                                        if (!carouselDragging.current || !carouselRef.current) return;
                                        const dx = e.pageX - carouselStartX.current;
                                        carouselRef.current.scrollLeft = carouselScrollLeft.current - dx;
                                        carouselVelocity.current = (e.pageX - carouselLastX.current) * -1;
                                        carouselLastX.current = e.pageX;
                                    }}
                                    onMouseUp={() => {
                                        if (!carouselDragging.current || !carouselRef.current) return;
                                        carouselDragging.current = false;
                                        carouselRef.current.style.cursor = 'grab';
                                        carouselRef.current.style.userSelect = '';
                                        carouselAnimRef.current = requestAnimationFrame(applyCarouselMomentum);
                                    }}
                                    onMouseLeave={() => {
                                        if (!carouselDragging.current || !carouselRef.current) return;
                                        carouselDragging.current = false;
                                        carouselRef.current.style.cursor = 'grab';
                                        carouselRef.current.style.userSelect = '';
                                        carouselAnimRef.current = requestAnimationFrame(applyCarouselMomentum);
                                    }}
                                    style={{ cursor: 'grab' }}
                                >
                                    {upcomingBookings.map((item, i) => {
                                        const dayLabel = DAY_NAMES_FULL[item.dateObj.getUTCDay()];
                                        const dateLabel = item.dateObj.toLocaleDateString('pt-BR', { timeZone: 'UTC', day: '2-digit', month: '2-digit' });
                                        const now = new Date();
                                        const isToday = formatDate(item.dateObj) === formatDate(now);
                                        return (
                                            <div key={`${item.date}-${item.booking.startTime}`}
                                                className={`client-booking-card client-booking-card--scroll animate-card-enter ${isToday ? 'client-booking-card--today' : ''}`}
                                                style={{ '--i': i } as React.CSSProperties}
                                                onClick={() => setDetailBooking({ booking: item.booking, date: item.date })}>
                                                <span className="client-booking-card__watermark" aria-hidden="true">
                                                    <Mic size={96} strokeWidth={1.25} />
                                                </span>
                                                <div className="client-booking-card__date-badge">
                                                    <div className="client-booking-card__day-name">{dayLabel}</div>
                                                    <div className={`client-booking-card__day-number ${isToday ? 'client-booking-card__day-number--today' : ''}`}>{dateLabel}</div>
                                                </div>
                                                <div className="client-booking-card__info">
                                                    <div className="client-booking-card__contract-name">{item.booking.contract?.name || item.booking.tierApplied}</div>
                                                    <div className="client-booking-card__time">{item.booking.startTime} — {item.booking.endTime}</div>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        ) : (
                            <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-muted)' }}>
                                <CalendarDays size={48} style={{ opacity: 0.2, margin: '0 auto 16px' }} />
                                <p>Você não possui agendamentos futuros.</p>
                            </div>
                        )}
                    </div>
                ) : (
                    // ─── AGENDAR TAB (Calendar Grid) ───
                    <div key="agendar" className="fade-in-view">
            {isMobile ? (
                <div ref={calendarSectionRef} className="calendar-mobile">
                    {/* Month/Year Header + Today Button */}
                    <div className="calendar-mobile-month">
                        <span className="calendar-mobile-month__text">{displayMonth}</span>
                        <button className="calendar-mobile-today-btn" onClick={goToday}>
                            Hoje
                        </button>
                    </div>

                    {/* Day Picker Pills Carousel — drag to navigate weeks */}
                    <div className="pills-carousel-viewport">
                        <div
                            key={weekDates[0]?.getTime()}
                            ref={pillsCarouselRef}
                            className="pills-carousel-track"
                            style={{ transform: 'translateX(-33.333%)' }}
                            onTouchStart={(e) => handlePillsDragStart(e.touches[0].clientX, e.touches[0].clientY)}
                            onTouchMove={(e) => {
                                handlePillsDragMove(e.touches[0].clientX, e.touches[0].clientY);
                                if (pillsIsHorizontal.current === true) e.preventDefault();
                            }}
                            onTouchEnd={() => handlePillsDragEnd()}
                            onMouseDown={(e) => { handlePillsDragStart(e.clientX, e.clientY); e.preventDefault(); }}
                            onMouseMove={(e) => handlePillsDragMove(e.clientX, e.clientY)}
                            onMouseUp={() => handlePillsDragEnd()}
                            onMouseLeave={() => { if (pillsDragging.current) handlePillsDragEnd(); }}
                        >
                            {/* Previous Week */}
                            <div className="pills-carousel-panel">
                                {prevWeekDates.map((d, i) => (
                                    <div key={`prev-${i}`} className="calendar-day-pill">
                                        <span className="calendar-day-pill-name">{DAYS[i]}</span>
                                        <span className="calendar-day-pill-number">{d.getDate()}</span>
                                    </div>
                                ))}
                            </div>
                            {/* Current Week */}
                            <div className="pills-carousel-panel">
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
                            {/* Next Week */}
                            <div className="pills-carousel-panel">
                                {nextWeekDates.map((d, i) => (
                                    <div key={`next-${i}`} className="calendar-day-pill">
                                        <span className="calendar-day-pill-name">{DAYS[i]}</span>
                                        <span className="calendar-day-pill-number">{d.getDate()}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>



                    {/* Slot Cards — crossfade on date change */}
                    {loading ? (
                        <div className="loading-spinner"><div className="spinner" /></div>
                    ) : (
                    <div className={`calendar-slots-crossfade slots-phase-${slotsPhase}`}>
                        <div
                            ref={slotListRef}
                            className="calendar-mobile-slots"
                            onTouchStart={(e) => {
                                swipeTouchStartX.current = e.touches[0].clientX;
                                swipeTouchStartY.current = e.touches[0].clientY;
                            }}
                            onTouchEnd={(e) => {
                                const dx = e.changedTouches[0].clientX - swipeTouchStartX.current;
                                const dy = e.changedTouches[0].clientY - swipeTouchStartY.current;
                                // Only trigger if horizontal swipe dominates
                                if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
                                    if (dx < 0) {
                                        // Swipe left = next day / next week on last day
                                        if (selectedDayIndex < 5) setSelectedDayIndex(selectedDayIndex + 1);
                                        else navigateWeek(1);
                                    } else {
                                        // Swipe right = prev day / prev week on first day
                                        if (selectedDayIndex > 0) setSelectedDayIndex(selectedDayIndex - 1);
                                        else navigateWeek(-1);
                                    }
                                }
                            }}
                        >
                            {GRID_ROWS.filter(row => row.type !== 'TRANSITION').map(row => {
                                const slots = slotsMap[displayDateStr] || [];
                                const slot = slots.find(s => s.time === row.time);
                                const isAvailable = slot?.available && slot?.tier;
                                const lookup = buildBookingLookup(displayDateStr);
                                const info = lookup[row.time];
                                const slotDateTime = new Date(`${displayDateStr}T${row.time}:00`);
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
                                    // Skip "Fora da Grade" rows — no slot data for this timeslot
                                    if (!slot?.tier) return null;
                                    statusLabel = isPast ? 'Indisponível' : 'Bloqueado';
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
                                                setShowPastSlotAlert(true);
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
                                                    setShowPastSlotAlert(true);
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

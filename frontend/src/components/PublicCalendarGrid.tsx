import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronLeft, ChevronRight, Clock, Loader2, Ban } from 'lucide-react';
import { publicApi, PublicDayAvailability, PublicSlot } from '../api/client';

const COLORS = {
    primary: '#006C89',
    secondary: '#00485C',
    accent: '#E0F2F1',
    bgDark: '#001a1f',
    white: '#FFFFFF'
};

const DAY_NAMES = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const MONTH_NAMES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

function formatDate(iso: string): string {
    const d = new Date(iso + 'T00:00:00');
    return `${d.getUTCDate()}`;
}

function getMonthLabel(iso: string): string {
    const d = new Date(iso + 'T00:00:00');
    return `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function toISODate(d: Date): string {
    return d.toISOString().split('T')[0];
}

function todayISO(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function addSlotEnd(time: string): string {
    const [h, m] = time.split(':').map(Number);
    const endMinutes = h * 60 + m + 120;
    const eh = Math.floor(endMinutes / 60);
    const em = endMinutes % 60;
    return `${String(eh).padStart(2, '0')}:${String(em).padStart(2, '0')}`;
}

const TIER_LABELS: Record<string, string> = {
    COMERCIAL: 'Comercial',
    AUDIENCIA: 'Audiência',
    SABADO: 'Sábado',
};

export default function PublicCalendarGrid({ onSlotSelect }: { onSlotSelect?: (date: string, slot: PublicSlot) => void }) {
    const [weekStart, setWeekStart] = useState(todayISO());
    const [days, setDays] = useState<PublicDayAvailability[]>([]);
    const [selectedIdx, setSelectedIdx] = useState(0);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const fetchData = useCallback(async (start: string) => {
        setLoading(true);
        setError(null);
        try {
            const res = await publicApi.getWeekAvailability(start, 7);
            setDays(res.days);

            // Find the first day that has open slots
            let firstAvailIdx = 0;
            const now = Date.now();
            for (let i = 0; i < res.days.length; i++) {
                const d = res.days[i];
                if (!d.closed && d.slots) {
                    const hasValidSlot = d.slots.some((s: PublicSlot) => {
                        const slotDateTime = new Date(`${d.date}T${s.time}:00`);
                        const isPast = (slotDateTime.getTime() - now) / (1000 * 60) < 30;
                        return s.available && !isPast;
                    });
                    if (hasValidSlot) {
                        firstAvailIdx = i;
                        break;
                    }
                }
            }
            setSelectedIdx(firstAvailIdx);
        } catch (err: any) {
            setError(err.message || 'Erro ao carregar disponibilidade');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchData(weekStart);
        const interval = setInterval(() => fetchData(weekStart), 60_000);
        return () => clearInterval(interval);
    }, [weekStart, fetchData]);

    const shiftWeek = (dir: number) => {
        const d = new Date(weekStart + 'T00:00:00');
        d.setUTCDate(d.getUTCDate() + dir * 7);
        // Don't go before today
        const today = todayISO();
        if (toISODate(d) < today) return;
        setWeekStart(toISODate(d));
    };

    const selectedDay = days[selectedIdx] || null;

    return (
        <div style={{
            background: 'rgba(255,255,255,0.02)',
            borderRadius: '32px',
            padding: '40px',
            border: '1px solid rgba(255,255,255,0.05)',
            position: 'relative',
            minHeight: '380px',
        }}>
            {/* Header: month + arrows */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '28px' }}>
                <div style={{ fontWeight: 700, fontSize: '1.2rem' }}>
                    {days.length > 0 ? getMonthLabel(days[0].date) : '...'}
                </div>
                <div style={{ display: 'flex', gap: '8px' }}>
                    <button onClick={() => shiftWeek(-1)} aria-label="Semana anterior" style={navBtnStyle}>
                        <ChevronLeft size={18} />
                    </button>
                    <button onClick={() => shiftWeek(1)} aria-label="Próxima semana" style={navBtnStyle}>
                        <ChevronRight size={18} />
                    </button>
                </div>
            </div>

            {/* Week strip */}
            <div style={{ display: 'flex', gap: '8px', marginBottom: '28px', overflowX: 'auto', paddingBottom: '4px' }}>
                {days.map((day, i) => {
                    const isSelected = i === selectedIdx;
                    const isClosed = day.closed;
                    const d = new Date(day.date + 'T00:00:00');
                    return (
                        <button
                            key={day.date}
                            onClick={() => !isClosed && setSelectedIdx(i)}
                            style={{
                                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px',
                                padding: '10px 14px', borderRadius: '14px', border: 'none', cursor: isClosed ? 'default' : 'pointer',
                                background: isSelected ? COLORS.primary : 'rgba(255,255,255,0.04)',
                                color: isClosed ? 'rgba(255,255,255,0.2)' : isSelected ? '#fff' : 'rgba(255,255,255,0.7)',
                                fontFamily: 'inherit', transition: 'all 0.2s', flexShrink: 0, minWidth: '52px',
                            }}
                        >
                            <span style={{ fontSize: '0.7rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                                {DAY_NAMES[d.getUTCDay()]}
                            </span>
                            <span style={{ fontSize: '1.1rem', fontWeight: 800 }}>{formatDate(day.date)}</span>
                        </button>
                    );
                })}
            </div>

            {/* Loading */}
            {loading && (
                <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '200px' }}>
                    <Loader2 size={28} color={COLORS.primary} style={{ animation: 'spin 1s linear infinite' }} />
                    <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
                </div>
            )}

            {/* Error */}
            {!loading && error && (
                <div style={{ textAlign: 'center', padding: '40px 20px', color: 'rgba(255,255,255,0.4)' }}>
                    {error}
                </div>
            )}

            {/* Closed day */}
            {!loading && !error && selectedDay?.closed && (
                <div style={{ textAlign: 'center', padding: '50px 20px', color: 'rgba(255,255,255,0.3)' }}>
                    <Ban size={36} style={{ marginBottom: '12px', opacity: 0.4 }} />
                    <div style={{ fontWeight: 700, fontSize: '1.1rem' }}>Fechado aos domingos</div>
                </div>
            )}

            {/* Slots */}
            {!loading && !error && selectedDay && !selectedDay.closed && (
                <AnimatePresence mode="wait">
                    <motion.div
                        key={selectedDay.date}
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -8 }}
                        transition={{ duration: 0.2 }}
                        style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}
                    >
                        {selectedDay.slots.map((slot: PublicSlot) => {
                            const slotDateTime = new Date(`${selectedDay.date}T${slot.time}:00`);
                            const isPast = (slotDateTime.getTime() - Date.now()) / (1000 * 60) < 30;
                            const isActuallyAvailable = slot.available && !isPast;

                            return (
                                <motion.div
                                    key={slot.time}
                                    whileHover={isActuallyAvailable ? { x: 6, background: 'rgba(0,108,137,0.12)' } : {}}
                                    style={{
                                        padding: '18px 22px',
                                        borderRadius: '18px',
                                        background: isActuallyAvailable ? 'rgba(0,108,137,0.06)' : 'rgba(255,255,255,0.015)',
                                        border: '1px solid',
                                        borderColor: isActuallyAvailable ? 'rgba(0,108,137,0.25)' : 'rgba(255,255,255,0.04)',
                                        display: 'flex',
                                        justifyContent: 'space-between',
                                        alignItems: 'center',
                                        opacity: isActuallyAvailable ? 1 : 0.35,
                                        cursor: isActuallyAvailable ? 'pointer' : 'default',
                                        transition: 'all 0.2s',
                                    }}
                                    onClick={() => isActuallyAvailable && onSlotSelect && onSlotSelect(selectedDay.date, slot)}
                                >
                                    <div style={{ display: 'flex', gap: '14px', alignItems: 'center' }}>
                                        <Clock size={18} color={isActuallyAvailable ? COLORS.primary : 'rgba(255,255,255,0.4)'} />
                                        <div>
                                            <div style={{ fontWeight: 700, fontSize: '0.95rem' }}>
                                                {slot.time} – {addSlotEnd(slot.time)}
                                            </div>
                                            {slot.tier && (
                                                <div style={{ fontSize: '0.72rem', opacity: 0.5, marginTop: '2px' }}>
                                                    {TIER_LABELS[slot.tier] || slot.tier}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                    <div style={{ fontSize: '0.75rem', fontWeight: 700, color: isActuallyAvailable ? COLORS.primary : 'rgba(255,255,255,0.3)' }}>
                                        {isActuallyAvailable ? 'RESERVAR →' : (isPast ? 'INDISPONÍVEL' : 'OCUPADO')}
                                    </div>
                                </motion.div>
                            )
                        })}
                    </motion.div>
                </AnimatePresence>
            )}
        </div>
    );
}

const navBtnStyle: React.CSSProperties = {
    width: '36px', height: '36px', borderRadius: '10px',
    background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)',
    color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
    cursor: 'pointer', fontFamily: 'inherit', transition: 'background 0.2s',
};

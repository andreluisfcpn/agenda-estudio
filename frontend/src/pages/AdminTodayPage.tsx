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

// Estilos .today-* vivem em styles/admin-area.css (seção AdminTodayPage).

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
                            <CheckCircle2 size={16} style={{ color: 'var(--success)' }} />
                            <span className="today-summary-num">{dayStats.completed}</span>&nbsp;concluídas
                        </span>

                        {dayStats.nowSession ? (
                            <span className="today-next today-next--now">
                                <span className="today-live-dot" />
                                <span><strong style={{ color: 'var(--success)' }}>Gravando agora:</strong> {dayStats.nowSession.user.name}</span>
                            </span>
                        ) : dayStats.next ? (
                            <span className="today-next">
                                <ChevronRight size={15} style={{ color: 'var(--accent-primary)', flexShrink: 0 }} />
                                <span>Próxima às <strong style={{ color: 'var(--text-primary)' }}>{dayStats.next.startTime}</strong> · {dayStats.next.user.name}</span>
                            </span>
                        ) : dayStats.recordings > 0 ? (
                            <span className="today-next"><CheckCircle2 size={15} style={{ color: 'var(--success)', flexShrink: 0 }} /> Tudo concluído por hoje</span>
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
                <div className="today-timeline">
                    {TIMELINE.map((item, index) => {
                        if (item.type === 'BREAK') {
                            const isBreakNow = nowTime >= item.time && nowTime <= item.timeEnd;
                            return (
                                <div key={item.id} className="today-break-row">
                                    <div className={`today-break-dot${isBreakNow ? ' today-break-dot--now' : ''}`} />
                                    <div className={`today-break-chip${isBreakNow ? ' today-break-chip--now' : ''}`}>
                                        <span style={{ fontSize: '0.875rem' }}>{item.breakIcon}</span>
                                        <span>{item.breakLabel}</span>
                                        {isBreakNow && <span className="today-now-chip">agora</span>}
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
                            <div key={item.id} className="today-slot-row" style={{ opacity: isPast && !booking ? 0.3 : 1 }}>
                                {/* -- Left: Dot + Connector -- */}
                                <div className="today-rail">
                                    <div className={`today-dot${isNow ? ' today-dot--now' : ''}`} style={{
                                        width: isNow ? 18 : 12, height: isNow ? 18 : 12,
                                        borderRadius: '50%',
                                        border: `2px solid ${
                                            isNow ? 'var(--success)'
                                            : booking ? (booking.status === 'COMPLETED' ? 'var(--success)' : booking.status === 'FALTA' ? 'var(--danger)' : 'var(--info)')
                                            : 'var(--border-color)'
                                        }`,
                                        background: booking
                                            ? (booking.status === 'COMPLETED' ? 'var(--success)' : booking.status === 'FALTA' ? 'var(--danger)' : booking.status === 'CONFIRMED' ? 'var(--info)' : 'transparent')
                                            : 'transparent',
                                        transition: 'border-color 0.3s ease, background 0.3s ease',
                                        flexShrink: 0,
                                    }} />

                                    {isNow && (
                                        <div className="today-now-chip" style={{ marginTop: '6px' }}>AGORA</div>
                                    )}

                                    {index < TIMELINE.length - 1 && (
                                        <div className={`today-connector${isNow ? ' today-connector--now' : ''}`} />
                                    )}
                                </div>

                                {/* -- Right: Slot Card -- */}
                                <div className={`today-slot-card${booking ? ' today-slot-card--filled' : ''}${isNow ? ' today-slot-card--now' : ''}`}>
                                    {/* Card Header */}
                                    <div
                                        className={`today-slot-head${booking ? ' today-slot-head--clickable' : ''}`}
                                        role={booking ? 'button' : undefined}
                                        tabIndex={booking ? 0 : undefined}
                                        aria-expanded={booking ? !!isExpanded : undefined}
                                        onClick={() => booking && openSlotDetails(booking)}
                                        onKeyDown={(e) => {
                                            if (booking && (e.key === 'Enter' || e.key === ' ')) {
                                                e.preventDefault();
                                                openSlotDetails(booking);
                                            }
                                        }}
                                    >
                                        {/* Time badge */}
                                        <div className={`today-time-badge${isNow ? ' today-time-badge--now' : ''}`}>
                                            {item.label}
                                        </div>

                                        {/* Content */}
                                        <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 }}>
                                            {booking && tierInfo ? (
                                                <>
                                                    {/* Avatar — gradient dinâmico do tier (inline permitido) */}
                                                    <div className="today-avatar" style={{
                                                        background: `linear-gradient(135deg, ${tierInfo.color}, ${tierInfo.color}66)`,
                                                        border: `1px solid ${tierInfo.color}33`,
                                                    }}>
                                                        {getInitials(booking.user.name)}
                                                    </div>

                                                    <div style={{ minWidth: 0 }}>
                                                        <div style={{
                                                            fontWeight: 600, fontSize: '0.875rem',
                                                            color: 'var(--accent-text)',
                                                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                                            cursor: 'pointer',
                                                        }}
                                                            title={`Abrir perfil de ${booking.user.name}`}
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
                                                        <button className="today-action-btn today-action-btn--info"
                                                            aria-label="Confirmar presença"
                                                            style={{ padding: '4px 10px', fontSize: '0.6875rem' }}
                                                            onClick={(e) => { e.stopPropagation(); handleStatusChange(booking.id, 'CONFIRMED', '✅ Confirmação'); }}>
                                                            Confirmar
                                                        </button>
                                                    )}
                                                    <button className="today-action-btn today-action-btn--success"
                                                        aria-label="Finalizar gravação"
                                                        style={{ padding: '4px 10px', fontSize: '0.75rem' }}
                                                        onClick={(e) => { e.stopPropagation(); setFinalizeBooking(booking); }}>
                                                        🏁
                                                    </button>
                                                    <button className="today-action-btn today-action-btn--danger"
                                                        aria-label="Registrar falta"
                                                        style={{ padding: '4px 10px', fontSize: '0.75rem' }}
                                                        onClick={(e) => { e.stopPropagation(); handleStatusChange(booking.id, 'FALTA', '❌ Falta'); }}>
                                                        ❌
                                                    </button>
                                                </div>
                                            )}

                                            {booking && (
                                                <ChevronRight size={14} aria-hidden="true"
                                                    className={`today-chevron${isExpanded ? ' today-chevron--open' : ''}`} />
                                            )}
                                        </div>
                                    </div>

                                    {/* -- Expanded Panel -- */}
                                    {booking && isExpanded && (
                                        <div className="today-expand-panel">
                                            {/* Action buttons row */}
                                            {(booking.status === 'CONFIRMED' || booking.status === 'RESERVED') && !isPast && (
                                                <div className="today-actions-bar">
                                                    {booking.status === 'RESERVED' && (
                                                        <button className="today-action-btn today-action-btn--info"
                                                            onClick={() => handleStatusChange(booking.id, 'CONFIRMED', '✅ Confirmação')}>
                                                            ✅ Confirmar Presença
                                                        </button>
                                                    )}
                                                    <button className="today-action-btn today-action-btn--success"
                                                        onClick={() => setFinalizeBooking(booking)}>
                                                        🏁 Finalizar gravação
                                                    </button>
                                                    <button className="today-action-btn today-action-btn--danger"
                                                        onClick={() => handleStatusChange(booking.id, 'FALTA', '❌ Falta')}>
                                                        ❌ Falta
                                                    </button>
                                                    <button className="today-action-btn today-action-btn--teal"
                                                        onClick={() => handleStatusChange(booking.id, 'NAO_REALIZADO', '❌ Não Realizado')}>
                                                        ❌ Não Realizado
                                                    </button>
                                                    <div style={{ flex: 1 }} />
                                                    <button className="today-action-btn today-action-btn--danger"
                                                        onClick={() => handleCancel(booking.id, booking.user.name)}>
                                                        🚫 Cancelar
                                                    </button>
                                                </div>
                                            )}

                                            {/* Metrics grid (COMPLETED) */}
                                            {booking.status === 'COMPLETED' && (
                                                <div style={{ marginBottom: '24px' }}>
                                                    <div style={{
                                                        fontSize: '0.6875rem', fontWeight: 700, color: 'var(--success)',
                                                        textTransform: 'uppercase', letterSpacing: '0.1em',
                                                        marginBottom: '14px', display: 'flex', alignItems: 'center', gap: '8px',
                                                    }}>
                                                        <span style={{ width: 20, height: 2, background: 'var(--success)', borderRadius: 1 }} />
                                                        Métricas Pós-Gravação
                                                    </div>
                                                    <button className="today-action-btn today-action-btn--danger" style={{ marginBottom: '14px' }}
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
                                                            <div key={f.label} className="admin-field">
                                                                <label className="admin-field__label">{f.label}</label>
                                                                <input type={f.type} className="form-input form-input--raised" placeholder={f.ph}
                                                                    style={{ fontSize: '0.8125rem' }}
                                                                    value={f.value} onChange={e => f.onChange(e.target.value)} />
                                                            </div>
                                                        ))}
                                                    </div>
                                                </div>
                                            )}

                                            {/* Notes — `admin-grid-2` collapses to 1 column on ≤640px (mobile). */}
                                            <div className="admin-grid-2" style={{ marginBottom: '20px' }}>
                                                <div>
                                                    <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.6875rem', fontWeight: 700, color: 'var(--accent-text)', marginBottom: '8px' }}>
                                                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--accent-text)' }} />
                                                        Observação Interna (Admin)
                                                    </label>
                                                    <textarea className="form-input form-input--raised"
                                                        style={{ minHeight: 80, resize: 'vertical', fontFamily: 'inherit', fontSize: '0.8125rem' }}
                                                        placeholder="Notas privadas sobre a sessão..."
                                                        value={adminNotes}
                                                        onChange={e => setAdminNotes(e.target.value)} />
                                                </div>
                                                <div>
                                                    <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.6875rem', fontWeight: 700, color: 'var(--success)', marginBottom: '8px' }}>
                                                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--success)' }} />
                                                        Feedback para o Cliente
                                                    </label>
                                                    <textarea className="form-input form-input--raised"
                                                        style={{ minHeight: 80, resize: 'vertical', fontFamily: 'inherit', fontSize: '0.8125rem' }}
                                                        placeholder="Visível no painel do cliente..."
                                                        value={clientNotes}
                                                        onChange={e => setClientNotes(e.target.value)} />
                                                </div>
                                            </div>

                                            {/* Footer actions */}
                                            <div style={{
                                                display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap',
                                                paddingTop: '16px', borderTop: '1px solid var(--border-color)',
                                            }}>
                                                <button className="today-action-btn today-action-btn--neutral"
                                                    onClick={() => navigate(`/admin/clients/${booking.user.id}`)}>
                                                    👤 Ver Perfil
                                                </button>
                                                <button className="btn-admin-go"
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

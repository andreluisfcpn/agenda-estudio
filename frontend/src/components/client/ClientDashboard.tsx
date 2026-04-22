import { getErrorMessage } from '../../utils/errors';
import { useState, useEffect, useRef, useCallback } from 'react';
import { bookingsApi, contractsApi, Booking, Contract, PaymentSummary } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { useUI } from '../../context/UIContext';
import { useNavigate } from 'react-router-dom';
import PaymentModal from '../PaymentModal';
import StatCard from '../ui/StatCard';
import StatusBadge from '../ui/StatusBadge';
import NotificationBanner from '../NotificationBanner';
import { DashboardSkeleton } from '../ui/SkeletonLoader';
import { formatBRL, daysUntil, DAY_NAMES } from '../../utils/format';
import {
    Wallet, CalendarDays, Clapperboard, FileText,
    Package, AlertTriangle, ArrowRight,
    Clock, Mic,
} from 'lucide-react';

function formatContractOrigin(booking: Booking): string {
    if (!booking.contract) return 'Avulso';
    if (booking.contract.name) return booking.contract.name;
    if (booking.contract.type === 'AVULSO') return `Avulso — ${booking.contract.tier}`;
    return `Plano ${booking.contract.type === 'FIXO' ? 'Fixo' : 'Flex'} — ${booking.contract.tier}`;
}

function getAddonName(key: string): string {
    switch (key) {
        case 'CORTES_REELS': return 'Cortes p/ Reels';
        case 'CAPA_YOUTUBE': return 'Capas (Thumbnails)';
        case 'GESTAO_SOCIAL': return 'Gestão de Redes';
        default: return key.replace(/_/g, ' ');
    }
}

export default function ClientDashboard() {
    const { user } = useAuth();
    const { showToast } = useUI();
    const navigate = useNavigate();
    const [stats, setStats] = useState({ bookings: 0, completedBookings: 0, contracts: 0, pausedContracts: 0, openPaymentsValue: 0, overdueCount: 0 });
    const [recentBookings, setRecentBookings] = useState<Booking[]>([]);
    const [upcomingBookings, setUpcomingBookings] = useState<Booking[]>([]);
    const [openPayments, setOpenPayments] = useState<PaymentSummary[]>([]);
    const [myContracts, setMyContracts] = useState<Contract[]>([]);
    const [loading, setLoading] = useState(true);

    const [payingInvoice, setPayingInvoice] = useState<PaymentSummary | null>(null);

    // Pull-to-refresh state
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [pullDistance, setPullDistance] = useState(0);
    const containerRef = useRef<HTMLDivElement>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const touchStartY = useRef(0);
    const isPulling = useRef(false);
    const PULL_THRESHOLD = 64;

    // Momentum drag scroll refs
    const isDragging = useRef(false);
    const dragStartX = useRef(0);
    const dragScrollLeft = useRef(0);
    const velocity = useRef(0);
    const lastX = useRef(0);
    const animFrameRef = useRef<number | null>(null);

    const stopMomentum = () => {
        if (animFrameRef.current !== null) {
            cancelAnimationFrame(animFrameRef.current);
            animFrameRef.current = null;
        }
    };

    const applyMomentum = () => {
        if (!scrollRef.current) return;
        velocity.current *= 0.92; // friction coefficient
        if (Math.abs(velocity.current) < 0.5) {
            // Re-enable snap after momentum settles
            scrollRef.current.style.scrollSnapType = 'x mandatory';
            return;
        }
        scrollRef.current.scrollLeft += velocity.current;
        animFrameRef.current = requestAnimationFrame(applyMomentum);
    };
    const loadData = useCallback(async () => {
        setLoading(true);
        try {
            const [bookingsRes, contractsRes] = await Promise.all([
                bookingsApi.getMy(),
                contractsApi.getMy(),
            ]);
            const historyStatuses = ['COMPLETED', 'FALTA', 'NAO_REALIZADO', 'CANCELLED'];
            const completedBookings = bookingsRes.bookings.filter(b => historyStatuses.includes(b.status));
            const futureBookings = bookingsRes.bookings.filter(b => b.status === 'RESERVED' || b.status === 'CONFIRMED');

            setRecentBookings(completedBookings.slice(0, 10));
            setUpcomingBookings(futureBookings.slice(0, 10));
            setMyContracts(contractsRes.contracts);
            const now = new Date();
            const activeBookings = bookingsRes.bookings.filter(b => {
                const bookingDateTime = new Date(`${b.date.split('T')[0]}T${b.startTime}:00`);
                return bookingDateTime >= now && (b.status === 'RESERVED' || b.status === 'CONFIRMED');
            });

            const allPayments = contractsRes.contracts.flatMap(c => c.payments || []);
            const pendingOpenPayments = allPayments.filter(p => p.status === 'PENDING' || p.status === 'FAILED');
            pendingOpenPayments.sort((a,b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime());
            setOpenPayments(pendingOpenPayments);
            
            const totalDebt = pendingOpenPayments.reduce((acc, p) => acc + p.amount, 0);
            const overdueCount = pendingOpenPayments.filter(p => p.dueDate && new Date(p.dueDate) < now).length;

            setStats({
                bookings: activeBookings.length,
                completedBookings: completedBookings.length,
                contracts: contractsRes.contracts.length,
                pausedContracts: contractsRes.contracts.filter(c => c.status === 'PAUSED').length,
                openPaymentsValue: totalDebt,
                overdueCount,
            });
        } catch (err) { console.error('Failed to load dashboard:', err); }
        finally { setLoading(false); }
    }, []);

    useEffect(() => { loadData(); }, [loadData]);

    // Perform the bounce scroll hint on load when bookings exist
    useEffect(() => {
        if (!loading && upcomingBookings.length > 0 && scrollRef.current) {
            const timer1 = setTimeout(() => {
                if (scrollRef.current) scrollRef.current.scrollBy({ left: 40, behavior: 'smooth' });
                const timer2 = setTimeout(() => {
                    if (scrollRef.current) scrollRef.current.scrollBy({ left: -40, behavior: 'smooth' });
                }, 400);
                return () => clearTimeout(timer2);
            }, 1200);
            return () => clearTimeout(timer1);
        }
    }, [loading, upcomingBookings.length]);

    // Pull-to-refresh handlers
    const handleTouchStart = useCallback((e: React.TouchEvent) => {
        const el = containerRef.current;
        if (!el || el.scrollTop > 0) return;
        touchStartY.current = e.touches[0].clientY;
        isPulling.current = true;
    }, []);

    const handleTouchMove = useCallback((e: React.TouchEvent) => {
        if (!isPulling.current || isRefreshing) return;
        const diff = e.touches[0].clientY - touchStartY.current;
        if (diff > 0) {
            setPullDistance(Math.min(diff * 0.5, PULL_THRESHOLD * 1.5));
        }
    }, [isRefreshing]);

    const handleTouchEnd = useCallback(async () => {
        if (!isPulling.current) return;
        isPulling.current = false;
        if (pullDistance >= PULL_THRESHOLD && !isRefreshing) {
            setIsRefreshing(true);
            setPullDistance(PULL_THRESHOLD);
            try {
                if (navigator.vibrate) navigator.vibrate(15);
                await loadData();
            } finally {
                setIsRefreshing(false);
                setPullDistance(0);
            }
        } else {
            setPullDistance(0);
        }
    }, [pullDistance, isRefreshing, loadData]);

    if (loading) return <DashboardSkeleton />;

    const nextBooking = upcomingBookings[0];
    const heroMessage = (() => {
        if (stats.overdueCount > 0) return `Você tem ${stats.overdueCount} fatura(s) em atraso`;
        if (nextBooking) {
            const bookingDate = new Date(nextBooking.date);
            const today = new Date();
            const diffDays = Math.ceil((bookingDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
            if (diffDays === 0) return `Sua sessão é hoje às ${nextBooking.startTime}`;
            if (diffDays === 1) return `Sua próxima sessão é amanhã às ${nextBooking.startTime}`;
            return `Próxima sessão em ${diffDays} dias — ${bookingDate.toLocaleDateString('pt-BR', { timeZone: 'UTC', day: '2-digit', month: 'short' })} às ${nextBooking.startTime}`;
        }
        if (stats.openPaymentsValue > 0) return 'Você tem pagamentos pendentes';
        return 'Tudo em dia! Agende sua próxima sessão';
    })();

    const greeting = (() => {
        const h = new Date().getHours();
        if (h < 12) return 'Bom dia';
        if (h < 18) return 'Boa tarde';
        return 'Boa noite';
    })();

    const heroClass = stats.overdueCount > 0 ? 'client-hero client-hero--alert' : 'client-hero client-hero--default';

    return (
        <div
            ref={containerRef}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
        >
            <div className={`ptr-indicator ${pullDistance > 0 ? 'ptr-indicator--active' : ''}`}
                style={{ height: pullDistance > 0 ? `${pullDistance}px` : undefined }}>
                {isRefreshing ? (
                    <div className="ptr-indicator__spinner" />
                ) : (
                    <svg
                        className={`ptr-indicator__arrow ${pullDistance >= PULL_THRESHOLD ? 'ptr-indicator__arrow--ready' : ''}`}
                        viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                    >
                        <line x1="12" y1="5" x2="12" y2="19" />
                        <polyline points="19 12 12 19 5 12" />
                    </svg>
                )}
            </div>

            <div className={`${heroClass} animate-card-enter`}>
                <div className="client-hero__header" style={{ marginBottom: '16px' }}>
                    <div className="client-hero__icon-wrapper" style={{
                        background: stats.overdueCount > 0
                            ? 'linear-gradient(135deg, rgba(239,68,68,0.2), rgba(239,68,68,0.05))'
                            : 'linear-gradient(135deg, rgba(16,185,129,0.2), rgba(16,185,129,0.05))',
                        borderColor: stats.overdueCount > 0 ? 'rgba(239,68,68,0.25)' : 'rgba(16,185,129,0.25)',
                        boxShadow: stats.overdueCount > 0 ? '0 0 20px rgba(239,68,68,0.12)' : '0 0 20px rgba(16,185,129,0.12)',
                        color: stats.overdueCount > 0 ? '#ef4444' : '#10b981',
                    }}>
                        <Mic size={22} />
                    </div>
                    <div>
                        <h2 className="client-hero__greeting" style={{ margin: 0 }}>
                            {greeting}, {user?.name?.split(' ')[0]}
                        </h2>
                        <p className="client-hero__message" style={{ margin: '4px 0 0 0' }}>
                            {heroMessage}
                        </p>
                    </div>
                </div>
                <div className="client-cta-stack">
                    <button className="btn btn-primary" onClick={() => navigate('/calendar')}>
                        <CalendarDays size={18} /> Ver Agenda
                    </button>
                    <button className="btn btn-secondary" onClick={() => navigate('/my-bookings')}>
                        <Clapperboard size={18} /> Suas Gravações
                    </button>
                </div>
            </div>

            <NotificationBanner />

            <div className="client-stats-grid stagger-enter">
                <StatCard icon={Wallet} label="Faturas Abertas" value={formatBRL(stats.openPaymentsValue)}
                    detail={stats.overdueCount > 0 ? `${stats.overdueCount} fatura(s) atrasada(s)` : stats.openPaymentsValue > 0 ? 'No prazo' : 'Tudo em dia'}
                    accent={stats.overdueCount > 0 ? '#ef4444' : '#10b981'} index={0} onClick={() => navigate('/meus-pagamentos')} />
                <StatCard icon={CalendarDays} label="Agendamentos Ativos" value={stats.bookings}
                    detail="próximas sessões" accent="var(--accent-primary)" index={1} onClick={() => navigate('/calendar')} />
                <StatCard icon={Clapperboard} label="Gravações" value={stats.completedBookings}
                    detail="sessões concluídas" accent="#2dd4bf" index={2} onClick={() => navigate('/my-bookings')} />
                <StatCard icon={FileText} label="Contratos" value={stats.contracts}
                    detail={stats.pausedContracts > 0 ? `${stats.pausedContracts} pausado(s)` : 'Fixo e Flex'}
                    accent="#f59e0b" index={3} onClick={() => navigate('/my-contracts')} />
            </div>

            {myContracts.filter(c => c.status === 'ACTIVE' && c.addonUsage && Object.keys(c.addonUsage).length > 0).map(c => (
                <div key={c.id} className="card client-addon-card animate-card-enter client-addon-section" style={{ '--i': 4 } as React.CSSProperties}>
                    <div className="card-header">
                        <h3 className="card-title client-addon-card__title">
                            <Package size={18} style={{ color: 'var(--accent-primary)' }} /> Consumo de Pacotes ({c.tier})
                        </h3>
                    </div>
                    <div className="client-addon-card__body">
                        {Object.entries(c.addonUsage!).map(([addonKey, usage]) => {
                            const usedPct = usage.limit > 0 ? Math.round((usage.used / usage.limit) * 100) : 0;
                            return (
                                <div key={addonKey} className="client-addon-item">
                                    <div className="client-addon-item__header">
                                        <span className="client-addon-item__name">{getAddonName(addonKey)}</span>
                                        <span className="client-addon-item__count">{usage.used} / {usage.limit}</span>
                                    </div>
                                    <div className="client-progress-bar">
                                        <div
                                            className={`client-progress-bar__fill ${usedPct >= 100 ? 'client-progress-bar__fill--exceeded' : 'client-progress-bar__fill--normal'}`}
                                            style={{ width: `${Math.min(usedPct, 100)}%` }}
                                        />
                                    </div>
                                    <div className="client-addon-item__cycle">Ciclo atual</div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            ))}

            {openPayments.length > 0 && (
                <div className="client-section">
                    <h3 className="client-section__heading">
                        <span className="client-section__heading-icon client-section__heading-icon--warning">
                            <AlertTriangle size={16} />
                        </span>
                        Faturas em Aberto
                    </h3>
                    <div className="stagger-enter" style={{ display: 'grid', gap: '12px' }}>
                        {openPayments.map((p, i) => {
                            const isOverdue = new Date(p.dueDate) < new Date();
                            return (
                                <div key={p.id}
                                    className={`client-invoice-card animate-card-enter ${isOverdue ? 'client-invoice-card--overdue' : ''}`}
                                    style={{ '--i': i } as React.CSSProperties}
                                    onClick={() => setPayingInvoice(p)}>
                                    <div className="client-invoice-card__row">
                                        <div>
                                            <div className="client-invoice-card__amount">{formatBRL(p.amount)}</div>
                                            <div className="client-invoice-card__due">
                                                {isOverdue ? 'Vencida' : 'Vence'} em {new Date(p.dueDate).toLocaleDateString('pt-BR', { timeZone: 'UTC', day: '2-digit', month: 'short' })}
                                            </div>
                                        </div>
                                        <div className="client-invoice-card__right">
                                            <StatusBadge status={isOverdue ? 'FAILED' : p.status} label={isOverdue ? 'Atrasada' : undefined} />
                                            <ArrowRight size={16} style={{ color: 'var(--text-muted)' }} />
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            <div className="client-section">
                <div className="client-section__header-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                    <h3 className="client-section__heading" style={{ marginBottom: 0 }}>
                        <span className="client-section__heading-icon client-section__heading-icon--accent">
                            <CalendarDays size={16} />
                        </span>
                        Próximos Agendamentos
                    </h3>
                </div>
                {upcomingBookings.length === 0 ? (
                    <div className="client-empty">
                        <CalendarDays size={32} className="client-empty__icon" />
                        <div className="client-empty__text">Nenhum agendamento futuro</div>
                        <button className="btn btn-primary" onClick={() => navigate('/calendar')}
                            style={{ marginTop: '14px', minHeight: '48px', padding: '12px 24px' }}>
                            Agendar Sessão
                        </button>
                    </div>
                ) : (
                    <div 
                        ref={scrollRef}
                        className="client-scroll-section stagger-enter"
                        onMouseDown={(e) => {
                            if (!scrollRef.current) return;
                            stopMomentum();
                            isDragging.current = true;
                            dragStartX.current = e.pageX;
                            dragScrollLeft.current = scrollRef.current.scrollLeft;
                            lastX.current = e.pageX;
                            velocity.current = 0;
                            scrollRef.current.style.cursor = 'grabbing';
                            scrollRef.current.style.scrollSnapType = 'none';
                            scrollRef.current.style.userSelect = 'none';
                        }}
                        onMouseMove={(e) => {
                            if (!isDragging.current || !scrollRef.current) return;
                            const dx = e.pageX - dragStartX.current;
                            scrollRef.current.scrollLeft = dragScrollLeft.current - dx;
                            velocity.current = (e.pageX - lastX.current) * -1;
                            lastX.current = e.pageX;
                        }}
                        onMouseUp={() => {
                            if (!isDragging.current || !scrollRef.current) return;
                            isDragging.current = false;
                            scrollRef.current.style.cursor = 'grab';
                            scrollRef.current.style.userSelect = '';
                            // Launch momentum animation
                            animFrameRef.current = requestAnimationFrame(applyMomentum);
                        }}
                        onMouseLeave={() => {
                            if (!isDragging.current || !scrollRef.current) return;
                            isDragging.current = false;
                            scrollRef.current.style.cursor = 'grab';
                            scrollRef.current.style.userSelect = '';
                            animFrameRef.current = requestAnimationFrame(applyMomentum);
                        }}
                        style={{ cursor: 'grab' }}
                    >
                        {upcomingBookings.slice(0, 5).map((b, i) => {
                            const bookingDate = new Date(b.date);
                            const dayLabel = DAY_NAMES[bookingDate.getUTCDay()];
                            const dateLabel = bookingDate.toLocaleDateString('pt-BR', { timeZone: 'UTC', day: '2-digit', month: '2-digit' });
                            const d = daysUntil(b.date);
                            const isToday = d <= 0;
                            return (
                                <div key={b.id}
                                    className={`client-booking-card client-booking-card--scroll animate-card-enter ${isToday ? 'client-booking-card--today' : ''}`}
                                    style={{ '--i': i } as React.CSSProperties}>
                                    {/* Decorative watermark mic */}
                                    <span className="client-booking-card__watermark" aria-hidden="true">
                                        <Mic size={96} strokeWidth={1.25} />
                                    </span>
                                    <div className="client-booking-card__date-badge">
                                        <div className="client-booking-card__day-name">{dayLabel}</div>
                                        <div className={`client-booking-card__day-number ${isToday ? 'client-booking-card__day-number--today' : ''}`}>{dateLabel}</div>
                                    </div>
                                    <div className="client-booking-card__info">
                                        <div className="client-booking-card__contract-name">{formatContractOrigin(b)}</div>
                                        <div className="client-booking-card__time">{b.startTime} — {b.endTime}</div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* ─── Últimas Gravações ─── */}
            <div className="client-section">
                <h3 className="client-section__heading">
                    <span className="client-section__heading-icon client-section__heading-icon--muted">
                        <Clock size={16} />
                    </span>
                    Últimas Gravações
                </h3>
                {recentBookings.length === 0 ? (
                    <div className="client-empty">
                        <Clapperboard size={32} className="client-empty__icon" />
                        <div className="client-empty__text">Nenhum histórico encontrado</div>
                    </div>
                ) : (
                    <div className="stagger-enter" style={{ display: 'grid', gap: '10px' }}>
                        {recentBookings.slice(0, 5).map((b, i) => {
                            const bookingDate = new Date(b.date);
                            const dayLabel = DAY_NAMES[bookingDate.getUTCDay()];
                            const dateLabel = bookingDate.toLocaleDateString('pt-BR', { timeZone: 'UTC', day: '2-digit', month: '2-digit' });
                            return (
                                <div key={b.id} className="client-booking-card animate-card-enter"
                                    style={{ '--i': i } as React.CSSProperties}>
                                    <div className="client-booking-card__date-badge">
                                        <div className="client-booking-card__day-name">{dayLabel}</div>
                                        <div className="client-booking-card__day-number">{dateLabel}</div>
                                    </div>
                                    <div className="client-booking-card__info">
                                        <div className="client-booking-card__time">{b.startTime} — {b.endTime}</div>
                                        <div className="client-booking-card__origin">{formatContractOrigin(b)}</div>
                                    </div>
                                    <div className="client-booking-card__actions">
                                        <StatusBadge status={b.status} />
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* ─── Checkout Modal ─── */}
            {payingInvoice && (
                <PaymentModal
                    title="Pagar Fatura"
                    amount={payingInvoice.amount}
                    paymentId={payingInvoice.id}
                    description={`Fatura — ${formatBRL(payingInvoice.amount)}`}
                    allowedMethods={['CARTAO', 'PIX']}
                    onSuccess={() => { setPayingInvoice(null); showToast('Pagamento realizado com sucesso!'); loadData(); }}
                    onError={(msg) => showToast({ message: msg, type: 'error' })}
                    onClose={() => setPayingInvoice(null)}
                />
            )}
        </div>
    );
}

import { getErrorMessage } from '../../utils/errors';
import HeroAmbient from './HeroAmbient';
import { useState, useEffect, useRef, useCallback } from 'react';
import { bookingsApi, contractsApi, Booking, ContractWithStats, PaymentSummary } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { useUI } from '../../context/UIContext';
import { useNavigate } from 'react-router-dom';
import PaymentModal from '../PaymentModal';
import StatCard from '../ui/StatCard';
import StatusBadge from '../ui/StatusBadge';
import NotificationBanner from '../NotificationBanner';
import { DashboardSkeleton } from '../ui/SkeletonLoader';
import { formatBRL, daysUntil, DAY_NAMES } from '../../utils/format';
import { computeFlexState } from '../../utils/flexCredits';
import { isContractCurrent, isBookingMakeupOpen, isAvulsoContract } from '../../utils/contractStatus';
import {
    chargeLabel, dueDateTimeZone, installmentPositions, isBlockedByPendingCancellation, isCancellationFine, isFineOverdue,
} from '../../utils/paymentLabels';
import { TIER_META, getMeta } from '../../constants/adminMeta';
import { calendarYmd, ddmmOfYmd, makeupDeadlineDdmm, makeupDaysLeft } from '../../utils/avulsoMakeup';
import { LIVE_BADGE_LABEL, LIVE_STATUS_LABEL, hasOpenSessionToday, isRecordingLive, useRecordingWatch } from '../../utils/recording';
import {
    Wallet, CalendarDays, Clapperboard, FileText,
    Package, AlertTriangle, ArrowRight,
    Clock, Mic, CalendarClock, Radio, Hourglass,
} from 'lucide-react';

/**
 * Fatura em aberto com o contexto do contrato — mesmos rótulos e regras de Meus Pagamentos
 * (utils/paymentLabels): "Parcela N/Total", "Multa de cancelamento (N%)", "Extra de gravação".
 */
type OpenInvoice = PaymentSummary & {
    contractName: string;
    contractType?: string;
    contractDuration: number;
    contractStatus?: ContractWithStats['status'];
    /** O que é a cobrança — null quando não há o que dizer (cobrança única, reserva avulsa). */
    chargeLabel: string | null;
    /** Cancelamento em análise (E13): parcela do plano suspensa — o cliente não paga até o estúdio decidir. */
    blockedByCancellation: boolean;
};

const CONTRACT_TYPE_LABEL: Record<string, string> = {
    FIXO: 'Plano Fixo', FLEX: 'Plano Flex', CUSTOM: 'Personalizado',
    SERVICO: 'Serviço mensal', AVULSO: 'Avulso',
};

/** "Nome · Tipo — Parcela N/Total" (sem valor: ele pode mudar ao emitir o PIX do à vista — E2). */
function describeInvoice(p: OpenInvoice): string {
    const typeLabel = (p.contractType && CONTRACT_TYPE_LABEL[p.contractType]) || 'Contrato';
    return `${p.contractName} · ${typeLabel}${p.chargeLabel ? ` — ${p.chargeLabel}` : ''}`;
}

/** Em atraso? A multa vence no instante da decisão do estúdio: só atrasa a partir do dia seguinte. */
const isInvoiceOverdue = (p: PaymentSummary, now: Date = new Date()) =>
    isCancellationFine(p) ? isFineOverdue(p.dueDate, now) : !!p.dueDate && new Date(p.dueDate) < now;

function formatContractOrigin(booking: Booking): string {
    if (!booking.contract) return 'Avulso';
    if (booking.contract.name) return booking.contract.name;
    // Rótulo legível da faixa ("Audiência", "Sábado") — nunca a chave crua (AUDIENCIA/SABADO).
    const tierLabel = getMeta(TIER_META, booking.contract.tier).label;
    if (booking.contract.type === 'AVULSO') return `Avulso — ${tierLabel}`;
    return `Plano ${booking.contract.type === 'FIXO' ? 'Fixo' : 'Flex'} — ${tierLabel}`;
}

/** Aviso de remarcação sem novo pagamento (falta justificada / não realizada no avulso — D4/D5). */
interface MakeupNudge {
    bookingId: string;
    status: 'FALTA' | 'NAO_REALIZADO';
    missedDdmm: string;
    lastDdmm: string;
    daysLeft: number;
    /** Quantas gravações estão com a remarcação em aberto (mostra a de prazo mais curto). */
    count: number;
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
    const [openPayments, setOpenPayments] = useState<OpenInvoice[]>([]);
    const [myContracts, setMyContracts] = useState<ContractWithStats[]>([]);
    const [makeupNudge, setMakeupNudge] = useState<MakeupNudge | null>(null);
    const [loading, setLoading] = useState(true);
    // Há sessão de hoje em aberto (reservada, confirmada ou já em gravação)? Liga o recarregamento periódico.
    const [watchToday, setWatchToday] = useState(false);

    const [payingInvoice, setPayingInvoice] = useState<OpenInvoice | null>(null);

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
    // O gesto com o mouse ARRASTOU a faixa? Então o clique que o navegador dispara ao soltar não abre o card.
    const dragMoved = useRef(false);

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
    // `silent`: recarrega sem o esqueleto (acompanhamento da gravação em andamento — E11).
    const loadData = useCallback(async (silent = false) => {
        if (!silent) setLoading(true);
        try {
            const [bookingsRes, contractsRes] = await Promise.all([
                bookingsApi.getMy(),
                contractsApi.getMy(),
            ]);
            const historyStatuses = ['COMPLETED', 'FALTA', 'NAO_REALIZADO', 'CANCELLED'];
            const bookingTs = (b: Booking) => new Date(`${b.date.split('T')[0]}T${b.startTime}:00`).getTime();
            const nowTs = new Date();
            // History = past/closed sessions, most recent first
            const completedBookings = bookingsRes.bookings
                .filter(b => historyStatuses.includes(b.status))
                .sort((a, b) => bookingTs(b) - bookingTs(a));
            // Upcoming = active status AND in the future, soonest first (fixes past
            // CONFIRMED sessions showing as "próximos" with negative day counts).
            // E11: a sessão que está sendo gravada AGORA continua na lista (com o selo "AO VIVO") até o
            // estúdio finalizar — antes ela sumia do Início no minuto em que começava.
            const futureBookings = bookingsRes.bookings
                .filter(b => (b.status === 'RESERVED' || b.status === 'CONFIRMED') && (bookingTs(b) >= nowTs.getTime() || isRecordingLive(b)))
                .sort((a, b) => bookingTs(a) - bookingTs(b));
            setWatchToday(hasOpenSessionToday(bookingsRes.bookings));

            setRecentBookings(completedBookings.slice(0, 10));
            setUpcomingBookings(futureBookings.slice(0, 10));
            setMyContracts(contractsRes.contracts);

            // Remarcação sem novo pagamento em aberto (D4/D5): a de prazo mais curto vira o aviso.
            const openMakeups = bookingsRes.bookings
                .filter(b => (b.status === 'FALTA' || b.status === 'NAO_REALIZADO') && isBookingMakeupOpen(b) && !!b.makeupDeadline)
                .sort((a, b) => new Date(a.makeupDeadline!).getTime() - new Date(b.makeupDeadline!).getTime());
            const nextMakeup = openMakeups[0];
            setMakeupNudge(nextMakeup ? {
                bookingId: nextMakeup.id,
                status: nextMakeup.status as 'FALTA' | 'NAO_REALIZADO',
                missedDdmm: ddmmOfYmd(calendarYmd(nextMakeup.missedDate || nextMakeup.date)),
                lastDdmm: makeupDeadlineDdmm(nextMakeup.makeupDeadline!),
                daysLeft: makeupDaysLeft(nextMakeup.makeupDeadline!),
                count: openMakeups.length,
            } : null);
            const now = new Date();
            const activeBookings = bookingsRes.bookings.filter(b => {
                const bookingDateTime = new Date(`${b.date.split('T')[0]}T${b.startTime}:00`);
                return bookingDateTime >= now && (b.status === 'RESERVED' || b.status === 'CONFIRMED');
            });

            // Mesmos rótulos e contagem de Meus Pagamentos: multa, extras e anuladas ficam fora de "Parcela N/Total".
            const allPayments: OpenInvoice[] = contractsRes.contracts.flatMap(c => {
                const positions = installmentPositions(c.payments || []);
                return (c.payments || []).map(p => ({
                    ...p,
                    contractName: c.name || c.type,
                    contractType: c.type,
                    contractDuration: c.durationMonths || 1,
                    contractStatus: c.status,
                    chargeLabel: chargeLabel(p, {
                        isAvulso: isAvulsoContract(c),
                        finePct: (c.cancellationFine?.id === p.id ? c.cancellationFine.finePct : null) ?? c.finePct,
                        position: positions.get(p.id),
                    }),
                    blockedByCancellation: isBlockedByPendingCancellation(c.status, p),
                }));
            });
            const pendingOpenPayments = allPayments.filter(p => p.status === 'PENDING' || p.status === 'FAILED');
            // Suspensas pelo cancelamento em análise vão para o fim: não há o que fazer com elas agora.
            pendingOpenPayments.sort((a, b) => {
                if (a.blockedByCancellation !== b.blockedByCancellation) return a.blockedByCancellation ? 1 : -1;
                return (a.dueDate ? new Date(a.dueDate).getTime() : 0) - (b.dueDate ? new Date(b.dueDate).getTime() : 0);
            });
            setOpenPayments(pendingOpenPayments);

            // E13: parcela de contrato com o cancelamento em análise fica suspensa — fora do total e do atraso.
            const payablePayments = pendingOpenPayments.filter(p => !p.blockedByCancellation);
            const totalDebt = payablePayments.reduce((acc, p) => acc + p.amount, 0);
            const overdueCount = payablePayments.filter(p => isInvoiceOverdue(p, now)).length;

            setStats({
                bookings: activeBookings.length,
                // A20: o KPI "Gravações / sessões concluídas" deve contar SÓ COMPLETED. A lista
                // `completedBookings` (histórico) é ampla de propósito (inclui FALTA/NAO_REALIZADO/CANCELLED),
                // então contá-la aqui inflava o card com faltas/canceladas como se fossem gravações.
                completedBookings: completedBookings.filter(b => b.status === 'COMPLETED').length,
                // Mesma regra da aba "Ativos" de MyContractsPage — contar todos os
                // contratos fazia o KPI mostrar "8" para um cliente com 0 ativos.
                contracts: contractsRes.contracts.filter(isContractCurrent).length,
                pausedContracts: contractsRes.contracts.filter(c => c.status === 'PAUSED').length,
                openPaymentsValue: totalDebt,
                overdueCount,
            });
        } catch (err) { console.error('Failed to load dashboard:', err); }
        finally { if (!silent) setLoading(false); }
    }, []);

    useEffect(() => { loadData(); }, [loadData]);

    // E11: com sessão de hoje em aberto, relê os dados de tempos em tempos (e ao voltar para a aba) para o
    // "AO VIVO" ligar quando o estúdio inicia a gravação e sumir quando ele finaliza.
    useRecordingWatch(watchToday, () => { void loadData(true); });

    // Perform the bounce scroll hint on load when bookings exist
    useEffect(() => {
        if (!loading && upcomingBookings.length > 0 && scrollRef.current) {
            // timer2 fica no escopo do EFFECT (o cleanup retornado de dentro do
            // setTimeout era código morto — o timer aninhado vazava no unmount).
            let timer2: number | undefined;
            const timer1 = setTimeout(() => {
                if (scrollRef.current) scrollRef.current.scrollBy({ left: 40, behavior: 'smooth' });
                timer2 = window.setTimeout(() => {
                    if (scrollRef.current) scrollRef.current.scrollBy({ left: -40, behavior: 'smooth' });
                }, 400);
            }, 1200);
            return () => { clearTimeout(timer1); if (timer2 !== undefined) clearTimeout(timer2); };
        }
    }, [loading, upcomingBookings.length]);

    // Momentum do carrossel: cancela o requestAnimationFrame pendente no unmount.
    useEffect(() => stopMomentum, []);

    // Abre o detalhe da gravação (editor do episódio ou métricas): Minhas Gravações procura o id na lista
    // completa do cliente e abre o modal — o mesmo caminho do aviso de remarcação.
    const openBookingDetail = useCallback((bookingId: string) => {
        navigate('/minhas-gravacoes', { state: { openBookingId: bookingId } });
    }, [navigate]);
    const onCardKeyDown = (bookingId: string) => (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openBookingDetail(bookingId); }
    };

    // Pull-to-refresh handlers
    const handleTouchStart = useCallback((e: React.TouchEvent) => {
        const el = containerRef.current;
        // Toque que não nasceu DENTRO do container no DOM (modal/sheet em portal: os eventos do React sobem
        // pela árvore React até aqui) não é puxar-para-atualizar — senão derrubava o checkout aberto.
        if (!el || !el.contains(e.target as Node) || el.scrollTop > 0) return;
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
                // Silenciosa: o gesto já tem o próprio indicador; o esqueleto desmontaria a página inteira.
                await loadData(true);
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
        if (nextBooking && isRecordingLive(nextBooking)) return 'Sua gravação está acontecendo agora';
        if (nextBooking) {
            // B7: ancorar ao meio-dia LOCAL de cada data-calendário (a data da reserva é 00:00Z). Antes,
            // subtrair o instante atual de 00:00Z rotulava a sessão de AMANHÃ como "hoje" entre 21h–24h SP.
            const bookingAnchor = new Date(nextBooking.date.split('T')[0] + 'T12:00:00');
            const now = new Date();
            const todayAnchor = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0);
            const diffDays = Math.round((bookingAnchor.getTime() - todayAnchor.getTime()) / (1000 * 60 * 60 * 24));
            if (diffDays === 0) return `Sua sessão é hoje às ${nextBooking.startTime}`;
            if (diffDays === 1) return `Sua próxima sessão é amanhã às ${nextBooking.startTime}`;
            return `Próxima sessão em ${diffDays} dias — ${new Date(nextBooking.date).toLocaleDateString('pt-BR', { timeZone: 'UTC', day: '2-digit', month: 'short' })} às ${nextBooking.startTime}`;
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

    // FLEX "record this week" nudge: pick the ACTIVE FLEX contract whose current
    // window is open, has no recording yet, and has credits left — the one closest
    // to forfeiting (smallest daysLeftInWindow) wins. Display-only.
    const flexNudge = (() => {
        const nowDate = new Date();
        let best: { daysLeft: number } | null = null;
        for (const c of myContracts) {
            const isAvulso = c.type === 'AVULSO' || (c.type === 'FLEX' && c.durationMonths === 1);
            if (c.type !== 'FLEX' || isAvulso || c.status !== 'ACTIVE') continue;
            const s = computeFlexState({
                total: c.flexCreditsTotal ?? 0,
                cycleStart: c.flexCycleStart ? new Date(c.flexCycleStart) : null,
                // Anchor-aware (originalDate): espelha o job — remarcação dentro do direito não vira "semana perdida".
                bookingDates: (c.bookings || []).map(b => new Date(`${((b as { originalDate?: string | null }).originalDate || b.date).split('T')[0]}T${b.startTime || '00:00'}:00`)),
                now: nowDate,
            });
            const remaining = c.flexCreditsRemaining ?? 0;
            if (s.started && s.currentWindowIndex != null && !s.recordedThisWindow && remaining > 0 && s.daysLeftInWindow != null) {
                if (!best || s.daysLeftInWindow < best.daysLeft) best = { daysLeft: s.daysLeftInWindow };
            }
        }
        return best;
    })();

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
                <HeroAmbient variant="inicio" />
                <div className="client-hero__header" style={{ marginBottom: '16px' }}>
                    <div className={`client-hero__icon-wrapper ${stats.overdueCount > 0 ? 'client-hero__icon-wrapper--danger' : 'client-hero__icon-wrapper--success'}`}>
                        <Mic size={22} />
                    </div>
                    <div>
                        <h2 className="client-hero__greeting">
                            {greeting}, {user?.name?.split(' ')[0]}
                        </h2>
                        <p className="client-hero__message">
                            {heroMessage}
                        </p>
                    </div>
                </div>
                <div className="client-cta-stack">
                    <button className="btn btn-primary" onClick={() => navigate('/calendar')}>
                        <CalendarDays size={18} /> Ver Agenda
                    </button>
                    <button className="btn btn-secondary" onClick={() => navigate('/minhas-gravacoes')}>
                        <Clapperboard size={18} /> Suas Gravações
                    </button>
                </div>
            </div>

            {flexNudge && (
                <div
                    className={`flex-nudge animate-card-enter ${flexNudge.daysLeft <= 2 ? 'flex-nudge--urgent' : ''}`}
                    role="status"
                >
                    <div className="flex-nudge__body">
                        <span className="flex-nudge__icon" aria-hidden="true"><Mic size={18} /></span>
                        <p className="flex-nudge__text">
                            Agende sua gravação desta semana — falta{flexNudge.daysLeft === 1 ? '' : 'm'}{' '}
                            <strong>{flexNudge.daysLeft} dia{flexNudge.daysLeft === 1 ? '' : 's'}</strong>{' '}
                            para não perder 1 crédito.
                        </p>
                    </div>
                    <button className="btn btn-primary btn-sm flex-nudge__cta" onClick={() => navigate('/calendar')}>
                        <CalendarDays size={16} /> Agendar
                    </button>
                </div>
            )}

            {makeupNudge && (
                <div
                    className={`flex-nudge animate-card-enter ${makeupNudge.daysLeft <= 2 ? 'flex-nudge--urgent' : ''}`}
                    role="status"
                >
                    <div className="flex-nudge__body">
                        <span className="flex-nudge__icon" aria-hidden="true"><CalendarClock size={18} /></span>
                        <p className="flex-nudge__text">
                            {makeupNudge.status === 'FALTA'
                                ? <>Remarque sua gravação de {makeupNudge.missedDdmm} até <strong>{makeupNudge.lastDdmm}</strong> — sem novo pagamento.</>
                                : <>O estúdio não pôde realizar sua gravação de {makeupNudge.missedDdmm}. Remarque sem custo até <strong>{makeupNudge.lastDdmm}</strong>.</>}
                            {makeupNudge.daysLeft <= 2 && (
                                <> {makeupNudge.daysLeft <= 1 ? 'Hoje é o último dia.' : 'Amanhã é o último dia.'}</>
                            )}
                            {makeupNudge.count > 1 && <> Você tem {makeupNudge.count} gravações para remarcar.</>}
                        </p>
                    </div>
                    <button className="btn btn-primary btn-sm flex-nudge__cta"
                        onClick={() => navigate('/minhas-gravacoes', { state: { openBookingId: makeupNudge.bookingId } })}>
                        <CalendarClock size={16} /> Remarcar
                    </button>
                </div>
            )}

            <NotificationBanner />

            <div className="client-stats-grid stagger-enter">
                <StatCard icon={Wallet} label="Faturas Abertas" value={formatBRL(stats.openPaymentsValue)}
                    detail={stats.overdueCount > 0 ? `${stats.overdueCount} fatura(s) atrasada(s)` : stats.openPaymentsValue > 0 ? 'Em aberto' : 'Tudo em dia'}
                    accent={stats.overdueCount > 0 ? 'var(--danger)' : 'var(--success)'} index={0} onClick={() => navigate('/meus-pagamentos')} />
                <StatCard icon={CalendarDays} label="Agendamentos Ativos" value={stats.bookings}
                    detail="próximas sessões" accent="var(--accent-primary)" index={1} onClick={() => navigate('/calendar')} />
                <StatCard icon={Clapperboard} label="Gravações" value={stats.completedBookings}
                    detail="sessões concluídas" accent="var(--client-accent-teal)" index={2} onClick={() => navigate('/minhas-gravacoes')} />
                <StatCard icon={FileText} label="Contratos" value={stats.contracts}
                    detail={stats.pausedContracts > 0 ? `${stats.pausedContracts} pausado(s)` : 'ativos'}
                    accent="var(--warning)" index={3} onClick={() => navigate('/meus-contratos')} />
            </div>

            {myContracts.filter(c => c.status === 'ACTIVE' && c.addonUsage && Object.keys(c.addonUsage).length > 0).map(c => (
                <div key={c.id} className="card client-addon-card animate-card-enter client-addon-section" style={{ '--i': 4 } as React.CSSProperties}>
                    <div className="card-header">
                        <h3 className="card-title client-addon-card__title">
                            <Package size={18} style={{ color: 'var(--accent-primary)' }} /> Consumo de Pacotes ({getMeta(TIER_META, c.tier).label})
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
                    <div className="stagger-enter client-invoice-list">
                        {openPayments.map((p, i) => {
                            // A multa vence num INSTANTE (a decisão do estúdio): dia de São Paulo, como em Meus Contratos.
                            const dueLabel = new Date(p.dueDate).toLocaleDateString('pt-BR', { timeZone: dueDateTimeZone(p), day: '2-digit', month: 'short' });
                            // E13: cancelamento em análise — a parcela do plano fica suspensa (sem pagar, sem selo de atraso).
                            if (p.blockedByCancellation) {
                                return (
                                    <div key={p.id}
                                        className="client-invoice-card animate-card-enter"
                                        style={{ '--i': i, cursor: 'default' } as React.CSSProperties}>
                                        <div className="client-invoice-card__row">
                                            <div>
                                                <div className="client-invoice-card__amount">{formatBRL(p.amount)}</div>
                                                <div className="client-invoice-card__due">
                                                    Vencimento {dueLabel}{p.chargeLabel ? ` · ${p.chargeLabel}` : ''}
                                                </div>
                                            </div>
                                            <div className="client-invoice-card__right">
                                                <StatusBadge status="PENDING" label="Suspensa" />
                                            </div>
                                        </div>
                                        <div className="info-box info-box--warning" style={{ margin: '12px 0 0', display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                                            <Hourglass size={16} aria-hidden="true" style={{ flexShrink: 0, marginTop: 1 }} />
                                            <span>Cancelamento em análise: esta parcela não pode ser paga até a decisão do estúdio.</span>
                                        </div>
                                    </div>
                                );
                            }
                            const isOverdue = isInvoiceOverdue(p);
                            return (
                                <div key={p.id}
                                    className={`client-invoice-card animate-card-enter ${isOverdue ? 'client-invoice-card--overdue' : ''}`}
                                    style={{ '--i': i } as React.CSSProperties}
                                    onClick={() => setPayingInvoice(p)}>
                                    <div className="client-invoice-card__row">
                                        <div>
                                            <div className="client-invoice-card__amount">{formatBRL(p.amount)}</div>
                                            <div className="client-invoice-card__due">
                                                {isOverdue ? 'Vencida' : 'Vence'} em {dueLabel}
                                                {p.chargeLabel ? ` · ${p.chargeLabel}` : ''}
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
                        <button className="btn btn-primary client-empty__cta" onClick={() => navigate('/calendar')}>
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
                            dragMoved.current = false;
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
                            if (Math.abs(dx) > 4) dragMoved.current = true;
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
                            const live = isRecordingLive(b);
                            return (
                                <div key={b.id}
                                    className={`client-booking-card client-booking-card--scroll animate-card-enter ${isToday ? 'client-booking-card--today' : ''}`}
                                    style={{ '--i': i, cursor: 'pointer' } as React.CSSProperties}
                                    role="button"
                                    tabIndex={0}
                                    aria-label={`Abrir o agendamento de ${dayLabel}, ${dateLabel}, ${b.startTime}${live ? ` — ${LIVE_STATUS_LABEL.toLowerCase()}` : ''}`}
                                    // Clique que encerra um arraste da faixa (mouse) não abre o detalhe.
                                    onClick={() => { if (dragMoved.current) { dragMoved.current = false; return; } openBookingDetail(b.id); }}
                                    onKeyDown={onCardKeyDown(b.id)}>
                                    {/* Decorative watermark mic */}
                                    <span className="client-booking-card__watermark" aria-hidden="true">
                                        <Mic size={96} strokeWidth={1.25} />
                                    </span>
                                    <div className="client-booking-card__date-badge">
                                        <div className="client-booking-card__day-name">{dayLabel}</div>
                                        <div className={`client-booking-card__day-number ${isToday ? 'client-booking-card__day-number--today' : ''}`}>{dateLabel}</div>
                                    </div>
                                    <div className="client-booking-card__info">
                                        {/* "AO VIVO" só enquanto o estúdio está gravando (isRecordingNow) */}
                                        {live && (
                                            <span className="poster-chip poster-chip--live" style={{ alignSelf: 'flex-start', marginBottom: 4 }}>
                                                <Radio size={10} aria-hidden="true" /> {LIVE_BADGE_LABEL}
                                            </span>
                                        )}
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
                    <div className="stagger-enter client-history-list">
                        {recentBookings.slice(0, 5).map((b, i) => {
                            const bookingDate = new Date(b.date);
                            const dayLabel = DAY_NAMES[bookingDate.getUTCDay()];
                            const dateLabel = bookingDate.toLocaleDateString('pt-BR', { timeZone: 'UTC', day: '2-digit', month: '2-digit' });
                            return (
                                <div key={b.id} className="client-booking-card animate-card-enter"
                                    style={{ '--i': i, cursor: 'pointer' } as React.CSSProperties}
                                    role="button"
                                    tabIndex={0}
                                    aria-label={`Abrir a gravação de ${dayLabel}, ${dateLabel}, ${b.startTime}`}
                                    onClick={() => openBookingDetail(b.id)}
                                    onKeyDown={onCardKeyDown(b.id)}>
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
                    title={isCancellationFine(payingInvoice) ? 'Pagar multa' : 'Pagar Fatura'}
                    amount={payingInvoice.amount}
                    paymentId={payingInvoice.id}
                    description={describeInvoice(payingInvoice)}
                    contractDuration={payingInvoice.contractDuration}
                    // E3: o boleto é decidido pelo PaymentModal (chave-mestra + Cora; nunca com o contrato aguardando pagamento).
                    allowedMethods={['CARTAO', 'PIX']}
                    contractStatus={payingInvoice.contractStatus}
                    onSuccess={() => { setPayingInvoice(null); showToast('Pagamento realizado com sucesso!'); loadData(); }}
                    onError={(msg) => showToast({ message: msg, type: 'error' })}
                    // E2: emitir o PIX pode mudar o valor da cobrança — recarrega (sem esqueleto) também ao cancelar.
                    onClose={() => { setPayingInvoice(null); void loadData(true); }}
                />
            )}
        </div>
    );
}

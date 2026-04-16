import { getErrorMessage } from '../../utils/errors';
import { useState, useEffect } from 'react';
import { bookingsApi, contractsApi, Booking, Contract, PaymentSummary } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { useUI } from '../../context/UIContext';
import { useNavigate } from 'react-router-dom';
import ModalOverlay from '../ModalOverlay';
import PaymentModal from '../PaymentModal';
import StatCard from '../ui/StatCard';
import StatusBadge from '../ui/StatusBadge';
import NotificationBanner from '../NotificationBanner';
import { DashboardSkeleton } from '../ui/SkeletonLoader';
import { formatBRL, daysUntil, DAY_NAMES } from '../../utils/format';
import {
    Wallet, CalendarDays, Clapperboard, FileText,
    Package, AlertTriangle, ArrowRight, XCircle,
    Clock, CheckCircle,
} from 'lucide-react';

function formatContractOrigin(booking: Booking): string {
    if (!booking.contract) return 'Avulso';
    if (booking.contract.name) return booking.contract.name;
    if (booking.contract.type === 'AVULSO') return `Avulso — ${booking.contract.tier}`;
    return `Plano ${booking.contract.type === 'FIXO' ? 'Fixo' : 'Flex'} — ${booking.contract.tier}`;
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

    const [cancelingBooking, setCancelingBooking] = useState<Booking | null>(null);
    const [isCanceling, setIsCanceling] = useState(false);
    const [payingInvoice, setPayingInvoice] = useState<PaymentSummary | null>(null);

    const handleCancelSubmit = async () => {
        if (!cancelingBooking) return;
        setIsCanceling(true);
        try {
            const res = await bookingsApi.clientCancel(cancelingBooking.id);
            showToast(res.message);
            setCancelingBooking(null);
            await loadData();
        } catch (err: unknown) {
            showToast(getErrorMessage(err));
        } finally {
            setIsCanceling(false);
        }
    };

    useEffect(() => { loadData(); }, []);

    const loadData = async () => {
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
    };

    if (loading) return <DashboardSkeleton />;

    // Smart contextual message
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

    return (
        <div>
            {/* ─── Welcome Hero ─── */}
            <div className="animate-card-enter" style={{
                background: stats.overdueCount > 0
                    ? 'linear-gradient(135deg, rgba(239, 68, 68, 0.12), rgba(239, 68, 68, 0.04))'
                    : 'linear-gradient(135deg, rgba(17, 129, 155, 0.12), rgba(16, 185, 129, 0.06))',
                border: `1px solid ${stats.overdueCount > 0 ? 'rgba(239, 68, 68, 0.2)' : 'rgba(17, 129, 155, 0.15)'}`,
                borderRadius: 'var(--radius-lg)',
                padding: '28px 24px',
                marginBottom: '24px',
            }}>
                <h2 style={{ fontSize: '1.5rem', fontWeight: 800, letterSpacing: '-0.02em', marginBottom: '6px', color: 'var(--text-primary)' }}>
                    {greeting}, {user?.name?.split(' ')[0]}
                </h2>
                <p style={{ fontSize: '0.9375rem', color: 'var(--text-secondary)', marginBottom: '20px', lineHeight: 1.5 }}>
                    {heroMessage}
                </p>
                <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                    <button className="btn btn-primary" onClick={() => navigate('/calendar')}
                        style={{ padding: '12px 20px', minHeight: '48px', borderRadius: 'var(--radius-md)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <CalendarDays size={18} /> Ver Agenda
                    </button>
                    <button className="btn btn-secondary" onClick={() => navigate('/my-bookings')}
                        style={{ padding: '12px 20px', minHeight: '48px', borderRadius: 'var(--radius-md)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <Clapperboard size={18} /> Suas Gravações
                    </button>
                </div>
            </div>

            {/* ─── Push Notification Prompt ─── */}
            <NotificationBanner />

            {/* ─── Stat Cards ─── */}
            <div className="stagger-enter" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px', marginBottom: '24px' }}>
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

            {/* ─── Consumo de Pacotes ─── */}
            {myContracts.filter(c => c.status === 'ACTIVE' && c.addonUsage && Object.keys(c.addonUsage).length > 0).map(c => (
                <div key={c.id} className="card animate-card-enter" style={{ marginBottom: '24px', borderLeft: '3px solid var(--accent-primary)', '--i': 4 } as React.CSSProperties}>
                    <div className="card-header" style={{ paddingBottom: '12px' }}>
                        <h3 className="card-title" style={{ fontSize: '0.9375rem', display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <Package size={18} style={{ color: 'var(--accent-primary)' }} /> Consumo de Pacotes ({c.tier})
                        </h3>
                    </div>
                    <div style={{ padding: '0 20px 20px 20px' }}>
                        {Object.entries(c.addonUsage!).map(([addonKey, usage], i, arr) => {
                            const usedPct = usage.limit > 0 ? Math.round((usage.used / usage.limit) * 100) : 0;
                            const addonName = addonKey === 'CORTES_REELS' ? 'Cortes p/ Reels' : addonKey === 'CAPA_YOUTUBE' ? 'Capas (Thumbnails)' : addonKey === 'GESTAO_SOCIAL' ? 'Gestão de Redes' : addonKey.replace(/_/g, ' ');
                            return (
                                <div key={addonKey} style={{ marginBottom: i === arr.length - 1 ? 0 : '16px' }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                                        <span style={{ fontSize: '0.8125rem', fontWeight: 700, color: 'var(--text-primary)' }}>{addonName}</span>
                                        <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>{usage.used} / {usage.limit}</span>
                                    </div>
                                    <div style={{ height: 8, borderRadius: 4, background: 'var(--bg-elevated)', overflow: 'hidden' }}>
                                        <div style={{ height: '100%', borderRadius: 4, background: usedPct >= 100 ? 'var(--tier-audiencia)' : 'linear-gradient(90deg, var(--accent-primary), #2dd4bf)', width: `${Math.min(usedPct, 100)}%`, transition: 'width 0.5s ease' }} />
                                    </div>
                                    <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', marginTop: '4px', textAlign: 'right' }}>Ciclo atual</div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            ))}

            {/* ─── Faturas em Aberto ─── */}
            {openPayments.length > 0 && (
                <div style={{ marginBottom: '24px' }}>
                    <h3 className="section-heading--sm" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <AlertTriangle size={18} style={{ color: '#f59e0b' }} /> Faturas em Aberto
                    </h3>
                    <div className="stagger-enter" style={{ display: 'grid', gap: '12px' }}>
                        {openPayments.map((p, i) => {
                            const isOverdue = new Date(p.dueDate) < new Date();
                            return (
                                <div key={p.id} className="animate-card-enter card-interactive" style={{
                                    background: 'var(--bg-card)', border: `1px solid ${isOverdue ? 'rgba(239, 68, 68, 0.3)' : 'var(--border-subtle)'}`,
                                    borderRadius: 'var(--radius-lg)', padding: '16px 20px',
                                    display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px',
                                    cursor: 'pointer', '--i': i,
                                } as React.CSSProperties} onClick={() => setPayingInvoice(p)}>
                                    <div>
                                        <div style={{ fontWeight: 800, fontSize: '1.125rem', color: 'var(--text-primary)' }}>{formatBRL(p.amount)}</div>
                                        <div style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                                            {isOverdue ? 'Vencida' : 'Vence'} em {new Date(p.dueDate).toLocaleDateString('pt-BR', { timeZone: 'UTC', day: '2-digit', month: 'short' })}
                                        </div>
                                    </div>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                        <StatusBadge status={isOverdue ? 'FAILED' : p.status} label={isOverdue ? 'Atrasada' : undefined} />
                                        <ArrowRight size={16} style={{ color: 'var(--text-muted)' }} />
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* ─── Próximos Agendamentos ─── */}
            <div style={{ marginBottom: '24px' }}>
                <h3 className="section-heading--sm" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <CalendarDays size={18} style={{ color: 'var(--accent-primary)' }} /> Próximos Agendamentos
                </h3>
                {upcomingBookings.length === 0 ? (
                    <div className="empty-state--nice">
                        <CalendarDays size={32} style={{ color: 'var(--text-muted)', marginBottom: '12px' }} />
                        <div style={{ fontSize: '0.875rem', color: 'var(--text-muted)', fontWeight: 500 }}>Nenhum agendamento futuro</div>
                        <button className="btn btn-primary" onClick={() => navigate('/calendar')} style={{ marginTop: '16px', minHeight: '48px', padding: '12px 24px' }}>Agendar Sessão</button>
                    </div>
                ) : (
                    <div className="stagger-enter" style={{ display: 'grid', gap: '10px' }}>
                        {upcomingBookings.slice(0, 5).map((b, i) => {
                            const bookingDate = new Date(b.date);
                            const dayLabel = DAY_NAMES[bookingDate.getUTCDay()];
                            const dateLabel = bookingDate.toLocaleDateString('pt-BR', { timeZone: 'UTC', day: '2-digit', month: '2-digit' });
                            const d = daysUntil(b.date);
                            const isToday = d <= 0;
                            return (
                                <div key={b.id} className="animate-card-enter" style={{
                                    background: isToday ? 'linear-gradient(135deg, rgba(17,129,155,0.1), rgba(16,185,129,0.05))' : 'var(--bg-card)',
                                    border: `1px solid ${isToday ? 'rgba(17,129,155,0.2)' : 'var(--border-subtle)'}`,
                                    borderRadius: 'var(--radius-lg)', padding: '14px 16px',
                                    display: 'flex', alignItems: 'center', gap: '14px', '--i': i,
                                } as React.CSSProperties}>
                                    <div style={{ minWidth: '52px', textAlign: 'center', padding: '8px 4px', background: 'var(--bg-elevated)', borderRadius: 'var(--radius-md)' }}>
                                        <div style={{ fontSize: '0.6875rem', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase' }}>{dayLabel}</div>
                                        <div style={{ fontSize: '0.9375rem', fontWeight: 800, color: isToday ? 'var(--accent-primary)' : 'var(--text-primary)' }}>{dateLabel}</div>
                                    </div>
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                        <div style={{ fontWeight: 700, fontSize: '0.875rem', color: 'var(--text-primary)' }}>{b.startTime} — {b.endTime}</div>
                                        <div style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)', marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{formatContractOrigin(b)}</div>
                                    </div>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                                        <span className={`badge badge-${b.tierApplied.toLowerCase()}`} style={{ fontSize: '0.6875rem' }}>{b.tierApplied}</span>
                                        <button onClick={(e) => { e.stopPropagation(); setCancelingBooking(b); }} aria-label="Cancelar agendamento"
                                            style={{ background: 'rgba(239,68,68,0.08)', border: 'none', borderRadius: '8px', padding: '8px', cursor: 'pointer', color: '#ef4444', display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: '44px', minHeight: '44px' }}>
                                            <XCircle size={16} />
                                        </button>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* ─── Últimas Gravações ─── */}
            <div>
                <h3 className="section-heading--sm" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <Clock size={18} style={{ color: 'var(--text-muted)' }} /> Últimas Gravações
                </h3>
                {recentBookings.length === 0 ? (
                    <div className="empty-state--nice">
                        <Clapperboard size={32} style={{ color: 'var(--text-muted)', marginBottom: '12px' }} />
                        <div style={{ fontSize: '0.875rem', color: 'var(--text-muted)', fontWeight: 500 }}>Nenhum histórico encontrado</div>
                    </div>
                ) : (
                    <div className="stagger-enter" style={{ display: 'grid', gap: '10px' }}>
                        {recentBookings.slice(0, 5).map((b, i) => {
                            const bookingDate = new Date(b.date);
                            const dayLabel = DAY_NAMES[bookingDate.getUTCDay()];
                            const dateLabel = bookingDate.toLocaleDateString('pt-BR', { timeZone: 'UTC', day: '2-digit', month: '2-digit' });
                            return (
                                <div key={b.id} className="animate-card-enter" style={{
                                    background: 'var(--bg-card)',
                                    border: '1px solid var(--border-subtle)',
                                    borderRadius: 'var(--radius-lg)', padding: '14px 16px',
                                    display: 'flex', alignItems: 'center', gap: '14px', '--i': i,
                                } as React.CSSProperties}>
                                    <div style={{ minWidth: '52px', textAlign: 'center', padding: '8px 4px', background: 'var(--bg-elevated)', borderRadius: 'var(--radius-md)' }}>
                                        <div style={{ fontSize: '0.6875rem', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase' }}>{dayLabel}</div>
                                        <div style={{ fontSize: '0.9375rem', fontWeight: 800, color: 'var(--text-primary)' }}>{dateLabel}</div>
                                    </div>
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                        <div style={{ fontWeight: 700, fontSize: '0.875rem', color: 'var(--text-primary)' }}>{b.startTime} — {b.endTime}</div>
                                        <div style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)', marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{formatContractOrigin(b)}</div>
                                    </div>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                                        <StatusBadge status={b.status} />
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* ─── Cancel Modal ─── */}
            {cancelingBooking && (
                <ModalOverlay onClose={() => setCancelingBooking(null)} preventClose={isCanceling}>
                    <div className="modal-content" style={{ maxWidth: 500 }}>
                        <div className="modal-header">
                            <h2 className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <XCircle size={20} style={{ color: '#ef4444' }} /> Cancelar Sessão
                            </h2>
                            <button className="btn-close" onClick={() => !isCanceling && setCancelingBooking(null)} aria-label="Fechar modal">✕</button>
                        </div>
                        <div className="modal-body" style={{ display: 'grid', gap: '16px' }}>
                            {(() => {
                                const now = new Date();
                                const bookingDateTime = new Date(`${cancelingBooking.date.split('T')[0]}T${cancelingBooking.startTime}:00-03:00`);
                                const diffHours = (bookingDateTime.getTime() - now.getTime()) / (1000 * 60 * 60);
                                return (
                                    <>
                                        <div style={{ padding: '16px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-default)' }}>
                                            <div style={{ fontWeight: 700, marginBottom: '8px' }}>
                                                {new Date(cancelingBooking.date).toLocaleDateString('pt-BR', { timeZone: 'UTC', day: '2-digit', month: 'long' })} às {cancelingBooking.startTime}
                                            </div>
                                            <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>{formatContractOrigin(cancelingBooking)}</div>
                                        </div>
                                        {diffHours >= 24 ? (
                                            <div style={{ padding: '16px', background: 'rgba(16,185,129,0.1)', color: '#059669', borderRadius: 'var(--radius-md)', border: '1px solid rgba(16,185,129,0.2)', fontSize: '0.875rem' }}>
                                                <span style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' }}><CheckCircle size={16} /> <strong>Cancelamento Antecipado</strong></span>
                                                <p style={{ lineHeight: 1.5 }}>Como você está cancelando com mais de 24h de antecedência, <strong>seu crédito retornará automaticamente</strong> ao seu plano.</p>
                                            </div>
                                        ) : (
                                            <div style={{ padding: '16px', background: 'rgba(239,68,68,0.1)', color: '#dc2626', borderRadius: 'var(--radius-md)', border: '1px solid rgba(239,68,68,0.2)', fontSize: '0.875rem' }}>
                                                <span style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' }}><AlertTriangle size={16} /> <strong>Cancelamento Tardio</strong></span>
                                                <p style={{ lineHeight: 1.5 }}>Faltam menos de 24h. O horário será liberado, mas <strong>o crédito não será estornado</strong>.</p>
                                            </div>
                                        )}
                                        <p style={{ fontSize: '0.875rem', textAlign: 'center', marginTop: '12px' }}>Tem certeza que deseja desmarcar?</p>
                                    </>
                                );
                            })()}
                        </div>
                        <div className="modal-footer" style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px' }}>
                            <button className="btn btn-secondary" disabled={isCanceling} onClick={() => setCancelingBooking(null)}>Voltar</button>
                            <button className="btn btn-primary" style={{ background: '#ef4444', borderColor: '#b91c1c' }} disabled={isCanceling} onClick={handleCancelSubmit}>
                                {isCanceling ? 'Cancelando...' : 'Confirmar Cancelamento'}
                            </button>
                        </div>
                    </div>
                </ModalOverlay>
            )}

            {/* ─── Checkout Modal ─── */}
            {payingInvoice && (
                <PaymentModal
                    title="Pagar Fatura"
                    amount={payingInvoice.amount}
                    paymentId={payingInvoice.id}
                    description={`Fatura — ${formatBRL(payingInvoice.amount)}`}
                    allowedMethods={['CARTAO', 'PIX', 'BOLETO']}
                    onSuccess={() => { setPayingInvoice(null); showToast('Pagamento realizado com sucesso!'); loadData(); }}
                    onError={(msg) => showToast({ message: msg, type: 'error' })}
                    onClose={() => setPayingInvoice(null)}
                />
            )}
        </div>
    );
}

import { useState, useEffect } from 'react';
import { bookingsApi, contractsApi, usersApi, Booking, Contract, UserSummary } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useNavigate } from 'react-router-dom';

function formatBRL(cents: number): string {
    return `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;
}

function formatContractOrigin(booking: Booking): string {
    if (!booking.contract) return 'Avulso';
    // Se existir nome, retorna o nome do contrato batizado
    if (booking.contract.name) return booking.contract.name;
    // Fallback de segurança para contratos velhos não migrados limpos
    if (booking.contract.type === 'AVULSO') return `Avulso — ${booking.contract.tier}`;
    return `Plano ${booking.contract.type === 'FIXO' ? 'Fixo' : 'Flex'} — ${booking.contract.tier}`;
}

export default function DashboardPage() {
    const { user } = useAuth();
    const navigate = useNavigate();
    const isAdmin = user?.role === 'ADMIN';
    const [stats, setStats] = useState({ bookings: 0, completedBookings: 0, contracts: 0, clients: 0, revenue: 0 });
    const [recentBookings, setRecentBookings] = useState<Booking[]>([]);
    const [upcomingBookings, setUpcomingBookings] = useState<Booking[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        loadData();
    }, []);

    const loadData = async () => {
        setLoading(true);
        try {
            if (isAdmin) {
                const [bookingsRes, contractsRes, usersRes] = await Promise.all([
                    bookingsApi.getAll(),
                    contractsApi.getAll(),
                    usersApi.getAll(),
                ]);
                setRecentBookings(bookingsRes.bookings.slice(0, 10));
                const now = new Date();
                const activeBookings = bookingsRes.bookings.filter((b: Booking) => {
                    const bookingDateTime = new Date(`${b.date.split('T')[0]}T${b.startTime}:00`);
                    return bookingDateTime >= now && (b.status === 'RESERVED' || b.status === 'CONFIRMED');
                });

                setStats({
                    bookings: activeBookings.length,
                    completedBookings: 0,
                    contracts: contractsRes.contracts.length,
                    clients: usersRes.users.filter((u: UserSummary) => u.role !== 'ADMIN').length,
                    revenue: bookingsRes.bookings
                        .filter((b: Booking) => b.status === 'CONFIRMED' || b.status === 'COMPLETED')
                        .reduce((sum: number, b: Booking) => sum + b.price, 0),
                });
            } else {
                const [bookingsRes, contractsRes] = await Promise.all([
                    bookingsApi.getMy(),
                    contractsApi.getMy(),
                ]);
                const historyStatuses = ['COMPLETED', 'FALTA', 'NAO_REALIZADO', 'CANCELLED'];
                const completedBookings = bookingsRes.bookings.filter(b => historyStatuses.includes(b.status));
                const futureBookings = bookingsRes.bookings.filter(b => b.status === 'RESERVED' || b.status === 'CONFIRMED');

                setRecentBookings(completedBookings.slice(0, 10));
                setUpcomingBookings(futureBookings.slice(0, 10));
                const now = new Date();
                const activeBookings = bookingsRes.bookings.filter(b => {
                    const bookingDateTime = new Date(`${b.date.split('T')[0]}T${b.startTime}:00`);
                    return bookingDateTime >= now && (b.status === 'RESERVED' || b.status === 'CONFIRMED');
                });

                setStats({
                    bookings: activeBookings.length,
                    completedBookings: completedBookings.length,
                    contracts: contractsRes.contracts.length, // Soma total de contratos
                    clients: 0,
                    revenue: 0,
                });
            }
        } catch (err) {
            console.error('Failed to load dashboard:', err);
        } finally {
            setLoading(false);
        }
    };

    const statusLabel = (status: string) => {
        switch (status) {
            case 'COMPLETED': return '✅ Concluído';
            case 'CONFIRMED': return '✅ Confirmado';
            case 'RESERVED': return '⏳ Reservado';
            case 'FALTA': return '❌ Falta';
            case 'NAO_REALIZADO': return '🔄 Não Realizado';
            default: return '❌ Cancelado';
        }
    };

    if (loading) {
        return <div className="loading-spinner"><div className="spinner" /></div>;
    }

    return (
        <div>
            <div className="page-header">
                <h1 className="page-title">
                    {isAdmin ? '📊 Dashboard' : `👋 Olá, ${user?.name}`}
                </h1>
                <p className="page-subtitle">
                    {isAdmin ? 'Visão geral do estúdio' : 'Seus agendamentos e gravações'}
                </p>
            </div>

            {/* Stats */}
            <div className="stats-row">
                <div className="stat-card">
                    <div className="stat-label">Agendamentos</div>
                    <div className="stat-value">{stats.bookings}</div>
                    <div className="stat-detail">{isAdmin ? 'ativos no sistema' : 'agendamentos ativos'}</div>
                </div>

                {!isAdmin && (
                    <div className="stat-card">
                        <div className="stat-label">🎬 Gravações Totais</div>
                        <div className="stat-value">{stats.completedBookings}</div>
                        <div className="stat-detail">sessões concluídas</div>
                    </div>
                )}

                <div className="stat-card">
                    <div className="stat-label">{isAdmin ? 'Contratos Ativos' : 'Meus Contratos'}</div>
                    <div className="stat-value">{stats.contracts}</div>
                    <div className="stat-detail">Fixo e Flex</div>
                </div>

                {isAdmin && (
                    <>
                        <div className="stat-card">
                            <div className="stat-label">Clientes</div>
                            <div className="stat-value">{stats.clients}</div>
                            <div className="stat-detail">cadastrados</div>
                        </div>
                        <div className="stat-card">
                            <div className="stat-label">Receita Total</div>
                            <div className="stat-value" style={{ fontSize: '1.25rem' }}>{formatBRL(stats.revenue)}</div>
                            <div className="stat-detail">confirmados</div>
                        </div>
                    </>
                )}
            </div>

            {/* Upcoming Bookings (Client Only) */}
            {!isAdmin && (
                <div className="card" style={{ marginBottom: '24px' }}>
                    <div className="card-header">
                        <h3 className="card-title">🔜 Próximos Agendamentos</h3>
                    </div>
                    {upcomingBookings.length === 0 ? (
                        <div className="empty-state">
                            <div className="empty-state-icon">📅</div>
                            <div className="empty-state-text">Nenhum agendamento futuro encontrado</div>
                        </div>
                    ) : (
                        <div className="table-container">
                            <table>
                                <thead>
                                    <tr>
                                        <th>Data</th>
                                        <th>Horário</th>
                                        <th>Faixa</th>
                                        <th>Origem</th>
                                        <th>Status</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {upcomingBookings.map(b => (
                                        <tr key={b.id}>
                                            <td>{new Date(b.date).toLocaleDateString('pt-BR', { timeZone: 'UTC' })}</td>
                                            <td style={{ fontWeight: 600 }}>{b.startTime} — {b.endTime}</td>
                                            <td><span className={`badge badge-${b.tierApplied.toLowerCase()}`}>{b.tierApplied}</span></td>
                                            <td>
                                                {b.contract ? (
                                                    <span
                                                        style={{ cursor: 'pointer', textDecoration: 'underline', color: 'var(--brand-primary)', fontWeight: 500 }}
                                                        onClick={() => navigate('/my-contracts', { state: { expandContractId: b.contract!.id } })}
                                                    >
                                                        {formatContractOrigin(b)}
                                                    </span>
                                                ) : (
                                                    <span style={{ opacity: 0.6 }}>{formatContractOrigin(b)}</span>
                                                )}
                                            </td>
                                            <td>
                                                <span className={`badge badge-${b.status.toLowerCase()}`}>
                                                    {statusLabel(b.status)}
                                                </span>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            )}

            {/* Recent Bookings */}
            <div className="card">
                <div className="card-header">
                    <h3 className="card-title">🕐 {isAdmin ? 'Agendamentos Recentes' : 'Últimas Gravações'}</h3>
                </div>
                {recentBookings.length === 0 ? (
                    <div className="empty-state">
                        <div className="empty-state-icon">📂</div>
                        <div className="empty-state-text">Nenhum histórico encontrado</div>
                    </div>
                ) : (
                    <div className="table-container">
                        <table>
                            <thead>
                                <tr>
                                    <th>Data</th>
                                    <th>Horário</th>
                                    <th>Faixa</th>
                                    <th>Origem</th>
                                    {isAdmin && <th>Valor</th>}
                                    <th>Status</th>
                                </tr>
                            </thead>
                            <tbody>
                                {recentBookings.map(b => (
                                    <tr key={b.id}>
                                        <td>{new Date(b.date).toLocaleDateString('pt-BR', { timeZone: 'UTC' })}</td>
                                        <td style={{ fontWeight: 600 }}>{b.startTime} — {b.endTime}</td>
                                        <td><span className={`badge badge-${b.tierApplied.toLowerCase()}`}>{b.tierApplied}</span></td>
                                        <td>
                                            {!isAdmin && b.contract ? (
                                                <span
                                                    style={{ cursor: 'pointer', textDecoration: 'underline', color: 'var(--brand-primary)', fontWeight: 500 }}
                                                    onClick={() => navigate('/my-contracts', { state: { expandContractId: b.contract!.id } })}
                                                >
                                                    {formatContractOrigin(b)}
                                                </span>
                                            ) : (
                                                <span style={{ opacity: 0.6 }}>{formatContractOrigin(b)}</span>
                                            )}
                                        </td>
                                        {isAdmin && <td style={{ fontWeight: 600 }}>{formatBRL(b.price)}</td>}
                                        <td>
                                            <span className={`badge badge-${b.status.toLowerCase()}`}>
                                                {statusLabel(b.status)}
                                            </span>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        </div>
    );
}

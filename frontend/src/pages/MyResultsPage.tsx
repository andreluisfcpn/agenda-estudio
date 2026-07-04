import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { bookingsApi, BookingResults } from '../api/client';
import HeroAmbient from '../components/client/HeroAmbient';
import StatCard from '../components/ui/StatCard';
import Skeleton from '../components/ui/SkeletonLoader';
import { ResultsTimeline, ResultsByContract } from '../components/client/ResultsChart';
import { ArrowLeft, BarChart3, Eye, TrendingUp, Heart, MessageCircle, Clapperboard, FolderOpen, Users } from 'lucide-react';

const PERIODS: { key: number; label: string }[] = [
    { key: 7, label: '7 dias' },
    { key: 30, label: '30 dias' },
    { key: 90, label: '90 dias' },
    { key: 365, label: '1 ano' },
];

export default function MyResultsPage() {
    const navigate = useNavigate();
    const [days, setDays] = useState(90);
    const [data, setData] = useState<BookingResults | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let alive = true;
        setLoading(true);
        bookingsApi.getMyResults(days)
            .then(r => { if (alive) setData(r); })
            .catch(() => { if (alive) setData(null); })
            .finally(() => { if (alive) setLoading(false); });
        return () => { alive = false; };
    }, [days]);

    const fmt = (n: number) => n.toLocaleString('pt-BR');
    const overall = data?.overall;
    const byContract = data?.byContract || [];
    const hasData = !!overall && overall.sessions > 0;

    return (
        <div>
            {/* Hero */}
            <div className="client-hero client-hero--default animate-card-enter">
                <HeroAmbient variant="gravacoes" />
                <div className="client-hero__header" style={{ marginBottom: '16px' }}>
                    <button className="results-back" onClick={() => navigate('/my-bookings')} aria-label="Voltar">
                        <ArrowLeft size={18} />
                    </button>
                    <div className="client-hero__icon-wrapper client-hero__icon-wrapper--violet">
                        <BarChart3 size={22} />
                    </div>
                    <div>
                        <h2 className="client-hero__greeting">Resultados</h2>
                        <p className="client-hero__message">Evolução das suas transmissões</p>
                    </div>
                </div>
            </div>

            {/* Period selector */}
            <div className="results-period" role="tablist">
                {PERIODS.map(p => (
                    <button key={p.key} role="tab" aria-selected={days === p.key}
                        className={`results-period__btn ${days === p.key ? 'results-period__btn--active' : ''}`}
                        onClick={() => setDays(p.key)}>
                        {p.label}
                    </button>
                ))}
            </div>

            {loading ? (
                <>
                    <div className="client-stats-grid"><Skeleton variant="rounded" width="100%" height={92} /><Skeleton variant="rounded" width="100%" height={92} /></div>
                    <Skeleton variant="rounded" width="100%" height={240} style={{ marginTop: 16 }} />
                </>
            ) : !hasData ? (
                <div className="client-empty animate-card-enter">
                    <Clapperboard size={32} className="client-empty__icon" />
                    <div className="client-empty__text">Ainda não há resultados neste período.</div>
                    <p className="booking-section-header__desc" style={{ marginTop: 6 }}>
                        Os números aparecem aqui conforme suas gravações são finalizadas com métricas.
                    </p>
                </div>
            ) : (
                <>
                    {/* KPIs */}
                    <div className="client-stats-grid stagger-enter">
                        <StatCard icon={Clapperboard} label="Sessões" value={fmt(overall!.sessions)} accent="var(--client-accent-violet)" index={0} />
                        <StatCard icon={Eye} label="Visualizações" value={fmt(overall!.views)} accent="var(--client-accent-blue)" index={1} />
                        <StatCard icon={TrendingUp} label="Pico médio" value={fmt(overall!.avgPeak)} accent="var(--danger)" index={2} />
                        <StatCard icon={Users} label="Inscritos" value={fmt(overall!.subscribers)} accent="var(--client-accent-purple)" index={3} />
                        <StatCard icon={Heart} label="Curtidas" value={fmt(overall!.likes)} accent="var(--client-accent-pink)" index={4} />
                        <StatCard icon={MessageCircle} label="Comentários" value={fmt(overall!.comments)} accent="var(--success)" index={5} />
                    </div>

                    {/* Evolution chart */}
                    <div className="results-card">
                        <h3 className="results-card__title"><TrendingUp size={16} /> Evolução de visualizações</h3>
                        <ResultsTimeline data={overall!.timeline} />
                    </div>

                    {/* By contract */}
                    {byContract.length > 0 && (
                        <div className="results-card">
                            <h3 className="results-card__title"><FolderOpen size={16} /> Por contrato</h3>
                            <ResultsByContract data={byContract.map(c => ({ name: c.contractName, views: c.views }))} />
                            <div className="results-contract-list">
                                {byContract.map(c => (
                                    <div key={c.contractId} className="results-contract">
                                        <div className="results-contract__name">{c.contractName}</div>
                                        <div className="results-contract__stats">
                                            <span>{fmt(c.sessions)} sessões</span>
                                            <span><Eye size={12} /> {fmt(c.views)}</span>
                                            <span><TrendingUp size={12} /> {fmt(c.avgPeak)}</span>
                                            <span><Heart size={12} /> {fmt(c.likes)}</span>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </>
            )}
        </div>
    );
}

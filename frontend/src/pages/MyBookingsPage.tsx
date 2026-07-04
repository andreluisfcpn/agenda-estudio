import HeroAmbient from '../components/client/HeroAmbient';
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { bookingsApi, pricingApi, Booking, AddOnConfig } from '../api/client';
import { Clapperboard, Radio, BarChart3, Eye, TrendingUp, Heart, Youtube, Instagram, Facebook, Music2, type LucideIcon } from 'lucide-react';
import StatCard from '../components/ui/StatCard';
import Skeleton from '../components/ui/SkeletonLoader';
import BookingDetailModal from '../components/BookingDetailModal';
import { PosterGallery, PosterCard } from '../components/client/PosterGallery';
import { studioSlotDate } from '../utils/time';
import { PLATFORM_BY_KEY, parseStreamMetrics, parsePlatforms } from '../constants/platforms';

const PLATFORM_ICON: Record<string, LucideIcon> = {
    YOUTUBE: Youtube, INSTAGRAM: Instagram, FACEBOOK: Facebook, TIKTOK: Music2,
};

export default function MyBookingsPage() {
    const navigate = useNavigate();
    const [bookings, setBookings] = useState<Booking[]>([]);
    const [addons, setAddons] = useState<AddOnConfig[]>([]);
    const [loading, setLoading] = useState(true);
    const [detail, setDetail] = useState<Booking | null>(null);

    useEffect(() => { loadBookings(); }, []);
    useEffect(() => {
        pricingApi.getAddons().then(r => setAddons(r.addons)).catch(() => {});
    }, []);

    const loadBookings = async () => {
        setLoading(true);
        try {
            const { bookings } = await bookingsApi.getMy();
            setBookings(bookings);
        } catch (err) { console.error('Failed to load bookings:', err); }
        finally { setLoading(false); }
    };

    const statusLabel = (s: string) => {
        switch (s) {
            case 'COMPLETED': return 'Concluída';
            case 'FALTA': return 'Falta';
            default: return s;
        }
    };

    const finalized = bookings
        .filter(b => b.status === 'COMPLETED' || b.status === 'FALTA')
        .sort((a, b) => studioSlotDate(b.date.split('T')[0], b.startTime).getTime() - studioSlotDate(a.date.split('T')[0], a.startTime).getTime());

    const completedRecs = finalized.filter(b => b.status === 'COMPLETED');
    const agg = completedRecs.reduce((acc, b) => {
        const m = parseStreamMetrics(b.streamMetrics);
        for (const pm of Object.values(m)) {
            acc.views += Number(pm.views) || 0;
            acc.likes += Number(pm.likes) || 0;
            acc.peak = Math.max(acc.peak, Number(pm.peak) || 0);
        }
        return acc;
    }, { views: 0, likes: 0, peak: 0 });
    const fmtNum = (n: number) => n.toLocaleString('pt-BR');

    return (
        <div>
            {/* Hero */}
            <div className="client-hero client-hero--default animate-card-enter">
                <HeroAmbient variant="gravacoes" />
                <div className="client-hero__header" style={{ marginBottom: '16px' }}>
                    <div className="client-hero__icon-wrapper client-hero__icon-wrapper--violet">
                        <Clapperboard size={22} />
                    </div>
                    <div>
                        <h2 className="client-hero__greeting">Minhas Gravações</h2>
                        <p className="client-hero__message">
                            {loading ? 'Carregando…' : `${completedRecs.length} ${completedRecs.length === 1 ? 'gravação realizada' : 'gravações realizadas'}`}
                        </p>
                    </div>
                </div>
                <div className="client-cta-stack">
                    <button className="btn btn-primary" onClick={() => navigate('/meus-resultados')}>
                        <BarChart3 size={16} /> Ver resultados
                    </button>
                </div>
            </div>

            {/* Stats */}
            {!loading && (
                <div className="client-stats-grid stagger-enter">
                    <StatCard icon={Clapperboard} label="Realizadas" value={fmtNum(completedRecs.length)} accent="var(--client-accent-violet)" index={0} />
                    <StatCard icon={Eye} label="Visualizações" value={fmtNum(agg.views)} accent="var(--client-accent-blue)" index={1} />
                    <StatCard icon={TrendingUp} label="Pico ao vivo" value={fmtNum(agg.peak)} accent="var(--danger)" index={2} />
                    <StatCard icon={Heart} label="Curtidas" value={fmtNum(agg.likes)} accent="var(--client-accent-pink)" index={3} />
                </div>
            )}

            {/* Recordings — shared draggable poster gallery (finger + mouse) */}
            {!loading && finalized.length === 0 ? (
                <div className="client-empty animate-card-enter">
                    <Clapperboard size={32} className="client-empty__icon" />
                    <div className="client-empty__text">Nenhuma gravação realizada ainda.</div>
                    <p className="booking-section-header__desc" style={{ marginTop: 6 }}>
                        Suas sessões aparecerão aqui com métricas após serem concluídas pelo estúdio.
                    </p>
                </div>
            ) : (
                <PosterGallery
                    revision={loading ? 'loading' : finalized.length}
                    busy={loading}
                    label="Gravações realizadas"
                >
                    {loading
                        ? [0, 1, 2].map(i => (
                            <div key={i} className="poster-card poster-card--skel">
                                <Skeleton variant="rounded" width="100%" height="100%" />
                            </div>
                        ))
                        : finalized.map((b, i) => {
                            const recPlatforms = parsePlatforms(b.platforms);
                            const title = b.episodeTitle || b.contract?.name || 'Gravação';
                            const dateLabel = new Date(b.date)
                                .toLocaleDateString('pt-BR', { timeZone: 'UTC', weekday: 'short', day: '2-digit', month: 'short' })
                                .replace(/\./g, '');
                            const m = parseStreamMetrics(b.streamMetrics);
                            let views = 0, likes = 0, peak = 0;
                            for (const pm of Object.values(m)) {
                                views += Number(pm.views) || 0;
                                likes += Number(pm.likes) || 0;
                                peak = Math.max(peak, Number(pm.peak) || 0);
                            }
                            const hasStats = views > 0 || likes > 0 || peak > 0 || recPlatforms.length > 0;
                            const a11yLabel = `${title}, ${b.isLivestream ? 'ao vivo, ' : ''}${statusLabel(b.status)}, ${dateLabel} às ${b.startTime}`
                                + (views > 0 ? `, ${fmtNum(views)} visualizações` : '')
                                + (likes > 0 ? `, ${fmtNum(likes)} curtidas` : peak > 0 ? `, pico de ${fmtNum(peak)} ao vivo` : '')
                                + (recPlatforms.length > 0 ? `, em ${recPlatforms.map(k => PLATFORM_BY_KEY[k]?.label || k).join(', ')}` : '');
                            return (
                                <PosterCard
                                    key={b.id}
                                    index={i}
                                    tone="violet"
                                    coverUrl={b.coverImageUrl}
                                    placeholder={<Clapperboard size={46} strokeWidth={1.25} />}
                                    badgeTopLeft={b.isLivestream ? <span className="poster-chip poster-chip--live"><Radio size={10} /> AO VIVO</span> : undefined}
                                    badgeTopRight={<span className={`poster-chip poster-chip--status ${b.status === 'COMPLETED' ? 'poster-chip--ok' : 'poster-chip--miss'}`}>{statusLabel(b.status)}</span>}
                                    eyebrow={<><span style={{ textTransform: 'capitalize' }}>{dateLabel}</span> · {b.startTime}</>}
                                    title={title}
                                    ariaLabel={a11yLabel}
                                    onClick={() => setDetail(b)}
                                    footer={hasStats ? (
                                        <>
                                            {views > 0 && <span className="poster-card__stat"><Eye size={13} /> {fmtNum(views)}</span>}
                                            {likes > 0
                                                ? <span className="poster-card__stat"><Heart size={13} /> {fmtNum(likes)}</span>
                                                : peak > 0 ? <span className="poster-card__stat"><TrendingUp size={13} /> {fmtNum(peak)}</span> : null}
                                            {recPlatforms.length > 0 && (
                                                <span className="poster-card__nets">
                                                    {recPlatforms.slice(0, 4).map(k => {
                                                        const Icon = PLATFORM_ICON[k];
                                                        return Icon ? <Icon key={k} size={14} /> : null;
                                                    })}
                                                </span>
                                            )}
                                        </>
                                    ) : undefined}
                                />
                            );
                        })}
                </PosterGallery>
            )}

            {/* Unified detail modal */}
            {detail && (
                <BookingDetailModal
                    booking={detail}
                    onClose={() => setDetail(null)}
                    onSaved={() => { setDetail(null); loadBookings(); }}
                    allAddons={addons}
                />
            )}
        </div>
    );
}

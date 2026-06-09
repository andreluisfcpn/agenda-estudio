import HeroAmbient from '../components/client/HeroAmbient';
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { bookingsApi, pricingApi, Booking, AddOnConfig } from '../api/client';
import { Clapperboard, Radio, BarChart3, Eye, TrendingUp, Heart, Youtube, Instagram, Facebook, Music2, ChevronLeft, ChevronRight, type LucideIcon } from 'lucide-react';
import StatCard from '../components/ui/StatCard';
import Skeleton from '../components/ui/SkeletonLoader';
import BookingDetailModal from '../components/BookingDetailModal';
import { useDragScroll } from '../hooks/useDragScroll';
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
    const [failedCovers, setFailedCovers] = useState<Set<string>>(new Set());
    const { ref: galleryRef, showLeft, showRight, scrollByPage, updateArrows } = useDragScroll<HTMLDivElement>();

    useEffect(() => { loadBookings(); }, []);
    useEffect(() => {
        pricingApi.getAddons().then(r => setAddons(r.addons)).catch(() => {});
    }, []);
    // Recompute the gallery arrows once the cards (and their covers) settle.
    useEffect(() => { const t = setTimeout(updateArrows, 80); return () => clearTimeout(t); }, [bookings, loading, updateArrows]);

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
                    <div className="client-hero__icon-wrapper" style={{
                        background: 'linear-gradient(135deg, rgba(139,92,246,0.2), rgba(139,92,246,0.05))',
                        borderColor: 'rgba(139,92,246,0.25)', boxShadow: '0 0 20px rgba(139,92,246,0.12)', color: '#8b5cf6',
                    }}>
                        <Clapperboard size={22} />
                    </div>
                    <div>
                        <h2 className="client-hero__greeting" style={{ margin: 0 }}>Minhas Gravações</h2>
                        <p className="client-hero__message" style={{ margin: '4px 0 0 0' }}>
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
                    <StatCard icon={Clapperboard} label="Realizadas" value={fmtNum(completedRecs.length)} accent="#8b5cf6" index={0} />
                    <StatCard icon={Eye} label="Visualizações" value={fmtNum(agg.views)} accent="#3b82f6" index={1} />
                    <StatCard icon={TrendingUp} label="Pico ao vivo" value={fmtNum(agg.peak)} accent="#ef4444" index={2} />
                    <StatCard icon={Heart} label="Curtidas" value={fmtNum(agg.likes)} accent="#ec4899" index={3} />
                </div>
            )}

            {/* Recordings — draggable poster gallery (finger + mouse) */}
            {loading ? (
                <div className="rec-gallery" aria-busy="true" aria-label="Carregando gravações">
                    {[0, 1, 2].map(i => (
                        <div key={i} className="rec-poster rec-poster--skel">
                            <Skeleton variant="rounded" width="100%" height="100%" />
                        </div>
                    ))}
                </div>
            ) : finalized.length === 0 ? (
                <div className="client-empty animate-card-enter">
                    <Clapperboard size={32} className="client-empty__icon" />
                    <div className="client-empty__text">Nenhuma gravação realizada ainda.</div>
                    <p className="booking-section-header__desc" style={{ marginTop: 6 }}>
                        Suas sessões aparecerão aqui com métricas após serem concluídas pelo estúdio.
                    </p>
                </div>
            ) : (
                <div className="rec-gallery-wrap scrollrow-wrap">
                    {showLeft && (
                        <button type="button" className="scrollrow-arrow scrollrow-arrow--left" aria-label="Anterior" tabIndex={-1} onClick={() => scrollByPage(-1)}>
                            <ChevronLeft size={16} />
                        </button>
                    )}
                    <div ref={galleryRef} className="rec-gallery scrollrow-track stagger-enter">
                        {finalized.map((b, i) => {
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
                            const hasCover = !!b.coverImageUrl && !failedCovers.has(b.id);
                            const hasStats = views > 0 || likes > 0 || peak > 0 || recPlatforms.length > 0;
                            const a11yLabel = `${title}, ${b.isLivestream ? 'ao vivo, ' : ''}${statusLabel(b.status)}, ${dateLabel} às ${b.startTime}`
                                + (views > 0 ? `, ${fmtNum(views)} visualizações` : '')
                                + (likes > 0 ? `, ${fmtNum(likes)} curtidas` : peak > 0 ? `, pico de ${fmtNum(peak)} ao vivo` : '')
                                + (recPlatforms.length > 0 ? `, em ${recPlatforms.map(k => PLATFORM_BY_KEY[k]?.label || k).join(', ')}` : '');
                            return (
                                <button key={b.id} className="rec-poster animate-card-enter" style={{ '--i': i } as React.CSSProperties} aria-label={a11yLabel} onClick={() => setDetail(b)}>
                                    <div className="rec-poster__media">
                                        <span className="rec-poster__ph" aria-hidden="true"><Clapperboard size={46} strokeWidth={1.25} /></span>
                                        {hasCover && (
                                            <img src={b.coverImageUrl!} alt="" draggable={false} loading="lazy"
                                                onError={() => setFailedCovers(s => new Set(s).add(b.id))} />
                                        )}
                                    </div>
                                    <div className="rec-poster__grad" />
                                    {b.isLivestream && <span className="rec-poster__live"><Radio size={10} /> AO VIVO</span>}
                                    <span className="rec-poster__status" style={{ color: b.status === 'COMPLETED' ? '#34d399' : '#fca5a5' }}>{statusLabel(b.status)}</span>
                                    <div className="rec-poster__info">
                                        <div className="rec-poster__date"><span style={{ textTransform: 'capitalize' }}>{dateLabel}</span> · {b.startTime}</div>
                                        <div className="rec-poster__title">{title}</div>
                                        {hasStats && (
                                            <div className="rec-poster__stats">
                                                {views > 0 && <span className="rec-poster__stat"><Eye size={13} /> {fmtNum(views)}</span>}
                                                {likes > 0
                                                    ? <span className="rec-poster__stat"><Heart size={13} /> {fmtNum(likes)}</span>
                                                    : peak > 0 ? <span className="rec-poster__stat"><TrendingUp size={13} /> {fmtNum(peak)}</span> : null}
                                                {recPlatforms.length > 0 && (
                                                    <span className="rec-poster__nets">
                                                        {recPlatforms.slice(0, 4).map(k => {
                                                            const Icon = PLATFORM_ICON[k];
                                                            return Icon ? <Icon key={k} size={14} /> : null;
                                                        })}
                                                    </span>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                </button>
                            );
                        })}
                    </div>
                    {showRight && (
                        <button type="button" className="scrollrow-arrow scrollrow-arrow--right" aria-label="Próximo" tabIndex={-1} onClick={() => scrollByPage(1)}>
                            <ChevronRight size={16} />
                        </button>
                    )}
                </div>
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

import { getErrorMessage } from '../utils/errors';
import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { bookingsApi, AddOnConfig, Booking } from '../api/client';
import { useUI } from '../context/UIContext';
import { useBusinessConfig } from '../hooks/useBusinessConfig';
import BottomSheetModal from './BottomSheetModal';
import PaymentModal from './PaymentModal';
import { PLATFORMS, PLATFORM_BY_KEY, METRIC_FIELDS, parsePlatforms, parsePlatformLinks, parseStreamMetrics } from '../constants/platforms';
import {
    CalendarDays, Clock, Tag, FileText, Sparkles, Plus, Check, ChevronLeft, RefreshCw,
    ImageIcon, Upload, Youtube, Instagram, Facebook, Music2, FolderOpen, Radio, ExternalLink,
    CreditCard,
    type LucideIcon,
} from 'lucide-react';
import { formatBRL } from '../utils/format';
import { useCountdown } from '../hooks/useCountdown';
import { GRID_ROWS } from './calendar/calendarShared';

// Horários de início da grade do estúdio — o reagendamento só faz sentido neles.
const SLOT_TIMES = GRID_ROWS.filter(r => r.type === 'SLOT').map(r => r.time);

export interface BookingDetailData {
    id: string;
    date: string;
    startTime: string;
    endTime: string;
    tierApplied: string;
    status: string;
    price: number;
    clientNotes?: string | null;
    adminNotes?: string | null;
    platforms?: string | null;
    platformLinks?: string | null;
    episodeTitle?: string | null;
    episodeDescription?: string | null;
    coverImageUrl?: string | null;
    streamMetrics?: string | null;
    isLivestream?: boolean | null;
    addOns?: string[];
    durationMinutes?: number | null;
    peakViewers?: number | null;
    chatMessages?: number | null;
    audienceOrigin?: string | null;
    holdExpiresAt?: string | null;
    contract?: { id: string; name: string; type: string; tier?: string; discountPct?: number; addOns?: string[] } | null;
}

interface BookingDetailModalProps {
    isOpen?: boolean;
    booking: BookingDetailData;
    onClose: () => void;
    onSaved: () => void;
    allAddons?: AddOnConfig[];
    contractDiscountPct?: number;
    contractAddOns?: string[];
}

const PLATFORM_ICON: Record<string, LucideIcon> = {
    YOUTUBE: Youtube, INSTAGRAM: Instagram, FACEBOOK: Facebook, TIKTOK: Music2,
};
const PLATFORM_CFG: Record<string, string> = {
    YOUTUBE: 'platform_youtube_enabled', INSTAGRAM: 'platform_instagram_enabled',
    FACEBOOK: 'platform_facebook_enabled', TIKTOK: 'platform_tiktok_enabled',
};
const ADDON_ICONS: Record<string, string> = {
    EDICAO_VIDEO: '🎬', CORTES_REELS: '📱', CAPA_YOUTUBE: '🖼️', GESTAO_SOCIAL: '📊',
};
const CONTRACT_TYPE_LABEL: Record<string, string> = {
    FIXO: 'Plano Fixo', FLEX: 'Plano Flex', AVULSO: 'Avulso', SERVICO: 'Serviço', CUSTOM: 'Personalizado',
};

function statusLabel(s: string) {
    switch (s) {
        case 'COMPLETED': return 'Concluída';
        case 'CONFIRMED': return 'Confirmada';
        case 'RESERVED': return 'Reservada';
        case 'FALTA': return 'Falta';
        case 'NAO_REALIZADO': return 'Não realizada';
        default: return 'Cancelada';
    }
}
function statusColor(s: string) {
    if (s === 'COMPLETED') return 'var(--success)';
    if (s === 'CONFIRMED') return 'var(--client-accent-teal)';
    if (s === 'RESERVED') return 'var(--warning)';
    return 'var(--text-muted)';
}

function HoldBanner({ expiresAt, onExpire }: { expiresAt: string; onExpire: () => void }) {
    const remaining = useCountdown(expiresAt, onExpire) ?? 0;
    const mins = Math.floor(remaining / 60), secs = remaining % 60;
    const color = remaining <= 60 ? 'var(--danger)' : remaining <= 180 ? 'var(--warning)' : 'var(--warning-strong)';
    return (
        <div className="info-box info-box--warning" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
            <span>Aguardando pagamento — conclua para confirmar.</span>
            <strong style={{ color, fontVariantNumeric: 'tabular-nums' }}>{String(mins).padStart(2, '0')}:{String(secs).padStart(2, '0')}</strong>
        </div>
    );
}

export default function BookingDetailModal({
    isOpen = true, booking, onClose, onSaved,
    allAddons = [], contractDiscountPct = 0, contractAddOns = [],
}: BookingDetailModalProps) {
    const { showAlert, showToast } = useUI();
    const { get: getRule, getBool } = useBusinessConfig();
    const navigate = useNavigate();

    // Hydrate full booking (contract/cover/episode/metrics) regardless of caller's data.
    const [full, setFull] = useState<Booking | null>(null);
    const src = (full || booking) as BookingDetailData;

    const [episodeTitle, setEpisodeTitle] = useState(booking.episodeTitle || '');
    const [episodeDescription, setEpisodeDescription] = useState(booking.episodeDescription || '');
    const [platforms, setPlatforms] = useState<string[]>(parsePlatforms(booking.platforms));
    const [coverUrl, setCoverUrl] = useState(booking.coverImageUrl || '');
    const [localAddOns, setLocalAddOns] = useState<string[]>(booking.addOns || []);
    const [saving, setSaving] = useState(false);
    const [uploadingCover, setUploadingCover] = useState(false);
    const fileRef = useRef<HTMLInputElement>(null);

    // Reschedule
    const [showReschedule, setShowReschedule] = useState(false);
    const [rescheduleDate, setRescheduleDate] = useState('');
    const [rescheduleTime, setRescheduleTime] = useState('');
    const [rescheduleError, setRescheduleError] = useState('');
    const [rescheduling, setRescheduling] = useState(false);

    // Services sheet + payment
    const [showServicesSheet, setShowServicesSheet] = useState(false);
    const [servicesStep, setServicesStep] = useState<1 | 2>(1);
    const [selectedNewAddons, setSelectedNewAddons] = useState<string[]>([]);
    const [payingAddon, setPayingAddon] = useState<{ paymentId: string; amount: number; description: string; addonKeys: string[] } | null>(null);

    useEffect(() => {
        let alive = true;
        bookingsApi.getOne(booking.id).then(r => {
            if (!alive) return;
            setFull(r.booking);
            setEpisodeTitle(r.booking.episodeTitle || '');
            setEpisodeDescription(r.booking.episodeDescription || '');
            setPlatforms(parsePlatforms(r.booking.platforms));
            setCoverUrl(r.booking.coverImageUrl || '');
            setLocalAddOns(r.booking.addOns || []);
        }).catch(() => {});
        return () => { alive = false; };
    }, [booking.id]);

    const dateStr = src.date.split('T')[0];
    const isCompleted = src.status === 'COMPLETED';
    const contract = full?.contract || booking.contract || null;
    const discountPct = contract?.discountPct ?? contractDiscountPct ?? 0;
    const ctrAddOns = contract?.addOns ?? contractAddOns ?? [];

    const canReschedule = useCallback((): boolean => {
        if (src.status !== 'RESERVED' && src.status !== 'CONFIRMED') return false;
        const dt = new Date(`${dateStr}T${src.startTime}:00-03:00`);
        return (dt.getTime() - Date.now()) / (1000 * 60 * 60) >= 24;
    }, [src.status, dateStr, src.startTime]);

    const togglePlatform = (key: string) => setPlatforms(prev => prev.includes(key) ? prev.filter(p => p !== key) : [...prev, key]);

    const handleCoverFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        setUploadingCover(true);
        try {
            const r = await bookingsApi.uploadCover(booking.id, file);
            setCoverUrl(r.coverImageUrl);
            showToast('Capa atualizada!');
        } catch (err: unknown) {
            showAlert({ message: getErrorMessage(err), type: 'error' });
        } finally {
            setUploadingCover(false);
            if (fileRef.current) fileRef.current.value = '';
        }
    };

    const handleSave = async () => {
        setSaving(true);
        try {
            await bookingsApi.clientUpdate(booking.id, {
                episodeTitle: episodeTitle.trim(),
                episodeDescription: episodeDescription.trim(),
                platforms: JSON.stringify(platforms),
            });
            showToast('Gravação atualizada!');
            onSaved();
        } catch (err: unknown) {
            showAlert({ message: getErrorMessage(err), type: 'error' });
        } finally { setSaving(false); }
    };

    const handleReschedule = async () => {
        setRescheduling(true); setRescheduleError('');
        try {
            await bookingsApi.reschedule(booking.id, { date: rescheduleDate, startTime: rescheduleTime });
            showToast('Reagendado com sucesso!');
            onSaved();
        } catch (err: unknown) { setRescheduleError(getErrorMessage(err)); }
        finally { setRescheduling(false); }
    };

    const handleConfirmAddons = async () => {
        setSaving(true);
        try {
            const res = await bookingsApi.purchaseAddon(booking.id, selectedNewAddons);
            if (res.activatedKeys?.length > 0) setLocalAddOns(prev => [...prev, ...res.activatedKeys]);
            if (res.paymentId && res.amount > 0) {
                setPayingAddon({ paymentId: res.paymentId, amount: res.amount, description: `${res.pendingKeys.length} serviço(s) — ${formatBRL(res.amount)}`, addonKeys: res.pendingKeys });
            } else {
                showToast('Serviços ativados com sucesso!');
                onSaved();
            }
            setShowServicesSheet(false); setServicesStep(1); setSelectedNewAddons([]);
        } catch (err: unknown) {
            showAlert({ message: getErrorMessage(err), type: 'error' });
        } finally { setSaving(false); }
    };

    const displayDate = (() => {
        const d = new Date(dateStr + 'T12:00:00');
        return d.toLocaleDateString('pt-BR', { timeZone: 'UTC', weekday: 'long', day: '2-digit', month: 'long' });
    })();

    const episodeAddons = allAddons.filter(a => !a.monthly);
    const activeAddons = episodeAddons.filter(a => localAddOns.includes(a.key) || ctrAddOns.includes(a.key));
    const availableForPurchase = episodeAddons.filter(a => !localAddOns.includes(a.key) && !ctrAddOns.includes(a.key));
    const contractAvailable = episodeAddons.filter(a => ctrAddOns.includes(a.key) && !localAddOns.includes(a.key));

    const totalPaid = selectedNewAddons.filter(k => !ctrAddOns.includes(k)).reduce((s, k) => {
        const a = episodeAddons.find(x => x.key === k); return a ? s + Math.round(a.price * (1 - discountPct / 100)) : s;
    }, 0);

    // Platforms shown: admin-enabled ∪ already-selected.
    const visiblePlatforms = PLATFORMS.filter(p => getBool(PLATFORM_CFG[p.key], true) || platforms.includes(p.key));
    const liveLinks = parsePlatformLinks(src.platformLinks);

    // Snapshot do encerramento (calculado do streamMetrics por rede).
    const isLive = !!src.isLivestream;
    const sm = parseStreamMetrics(src.streamMetrics);
    const networks = Object.keys(sm);
    const totals = networks.reduce((a, k) => {
        const m = sm[k] || {};
        a.views += Number(m.views) || 0;
        a.peak = Math.max(a.peak, Number(m.peak) || 0);
        a.subscribers += Number(m.subscribers) || 0;
        a.likes += Number(m.likes) || 0;
        a.comments += Number(m.comments) || 0;
        return a;
    }, { views: 0, peak: 0, subscribers: 0, likes: 0, comments: 0 });
    const recordingLink = liveLinks.GRAVACAO || '';
    const fmtN = (n: number) => n.toLocaleString('pt-BR');

    if (!isOpen) return null;

    return (
        <>
            <BottomSheetModal isOpen={isOpen} onClose={onClose} title="Detalhes da Gravação" maxWidth="560px" preventClose={saving || rescheduling || uploadingCover}>
                <div className="bdm">
                    {/* Hold banner */}
                    {src.holdExpiresAt && new Date(src.holdExpiresAt).getTime() > Date.now() && (
                        <HoldBanner expiresAt={src.holdExpiresAt} onExpire={onSaved} />
                    )}

                    {/* Contract origin + status */}
                    <div className="bdm-top">
                        <div className="bdm-contract">
                            <span className="bdm-contract__icon"><FolderOpen size={14} /></span>
                            <div>
                                <div className="bdm-contract__name">{contract?.name || 'Avulso'}</div>
                                <div className="bdm-contract__type">{CONTRACT_TYPE_LABEL[contract?.type || 'AVULSO'] || contract?.type}</div>
                            </div>
                        </div>
                        <span className="bdm-status" style={{ color: statusColor(src.status), background: `${statusColor(src.status)}1f` }}>
                            {statusLabel(src.status)}
                        </span>
                    </div>

                    {/* Date / time / tier */}
                    <div className="bdm-meta">
                        <div className="bdm-meta__item"><CalendarDays size={14} /><span style={{ textTransform: 'capitalize' }}>{displayDate}</span></div>
                        <div className="bdm-meta__item"><Clock size={14} />{src.startTime} — {src.endTime}</div>
                        <div className="bdm-meta__item"><Tag size={14} />{src.tierApplied}</div>
                    </div>

                    {/* Cover */}
                    <div className="bdm-section">
                        <div className="bdm-section__title"><ImageIcon size={14} /> Capa do episódio</div>
                        <div className={`bdm-cover ${coverUrl ? 'bdm-cover--has' : ''}`}>
                            {coverUrl ? <img className="bdm-cover__img" src={coverUrl} alt="Capa do episódio" onError={() => setCoverUrl('')} /> : (
                                <div className="bdm-cover__placeholder"><ImageIcon size={28} /><span>Sem capa</span></div>
                            )}
                            <button className="bdm-cover__btn" onClick={() => fileRef.current?.click()} disabled={uploadingCover}>
                                <Upload size={14} /> {uploadingCover ? 'Enviando...' : coverUrl ? 'Trocar capa' : 'Enviar capa'}
                            </button>
                            <input ref={fileRef} type="file" accept="image/*" hidden onChange={handleCoverFile} />
                        </div>
                    </div>

                    {/* Episode title + description */}
                    <div className="bdm-section">
                        <div className="bdm-section__title"><FileText size={14} /> Episódio</div>
                        <input className="form-input" value={episodeTitle} maxLength={140}
                            onChange={e => setEpisodeTitle(e.target.value)} placeholder="Título do episódio" />
                        <textarea className="form-input" rows={3} value={episodeDescription}
                            onChange={e => setEpisodeDescription(e.target.value)} placeholder="Descrição do episódio..."
                            style={{ resize: 'vertical', marginTop: 8 }} />
                    </div>

                    {/* Admin notes (read-only) */}
                    {src.adminNotes && (
                        <div className="bdm-section">
                            <div className="bdm-section__title" style={{ color: 'var(--text-muted)' }}>Observação do estúdio</div>
                            <div className="booking-modal__admin-note">{src.adminNotes}</div>
                        </div>
                    )}

                    {/* Planned broadcast platforms (subdued icons, no links). Hidden once completed —
                        the "Resultados da transmissão" block below shows the real links/metrics. */}
                    {!isCompleted && (
                        <div className="bdm-section">
                            <div className="bdm-section__title"><Radio size={14} /> Onde vai transmitir</div>
                            <div className="bdm-platforms">
                                {visiblePlatforms.map(p => {
                                    const Icon = PLATFORM_ICON[p.key] || Radio;
                                    const active = platforms.includes(p.key);
                                    return (
                                        <button key={p.key} type="button" className={`bdm-plat ${active ? 'bdm-plat--active' : ''}`} onClick={() => togglePlatform(p.key)}>
                                            <Icon size={16} /> {p.label}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    {/* Services */}
                    <div className="bdm-section">
                        <div className="bdm-section__title"><Sparkles size={14} /> Serviços</div>
                        <div className="bdm-services">
                            {activeAddons.length > 0 ? activeAddons.map(a => {
                                const isContract = ctrAddOns.includes(a.key);
                                return (
                                    <div key={a.key} className="bdm-service">
                                        <span className="bdm-service__icon">{ADDON_ICONS[a.key] || <Sparkles size={13} />}</span>
                                        <span className="bdm-service__name">{a.name}</span>
                                        <span className={`bdm-service__tag ${isContract ? 'bdm-service__tag--plan' : ''}`}>{isContract ? 'Plano' : 'Ativo'}</span>
                                    </div>
                                );
                            }) : <div className="bdm-service bdm-service--empty">Nenhum serviço ativo</div>}

                            {(availableForPurchase.length > 0 || contractAvailable.length > 0) && ['RESERVED', 'CONFIRMED', 'COMPLETED'].includes(src.status) && (
                                <button className="bdm-service-add" onClick={() => { setShowServicesSheet(true); setServicesStep(1); setSelectedNewAddons([]); }}>
                                    <Plus size={15} /> Adicionar serviço
                                </button>
                            )}
                        </div>
                    </div>

                    {/* Metrics (completed) — read-only */}
                    {isCompleted && isLive && (
                        <div className="bdm-section">
                            <div className="bdm-section__title"><Radio size={14} style={{ color: 'var(--danger)' }} /> Resultados da transmissão</div>
                            <p className="bdm-snapshot-note">Números registrados no encerramento da transmissão.</p>
                            {/* Totais */}
                            <div className="metrics-grid">
                                <div className="metric-card"><div className="metric-card__label">Duração</div><div className="metric-card__value">{src.durationMinutes ? `${src.durationMinutes} min` : '--'}</div></div>
                                <div className="metric-card"><div className="metric-card__label">Visualizações</div><div className="metric-card__value">{totals.views ? fmtN(totals.views) : '--'}</div></div>
                                <div className="metric-card"><div className="metric-card__label">Pico ao vivo</div><div className="metric-card__value">{totals.peak ? fmtN(totals.peak) : '--'}</div></div>
                                <div className="metric-card"><div className="metric-card__label">Inscritos</div><div className="metric-card__value">{totals.subscribers ? fmtN(totals.subscribers) : '--'}</div></div>
                                <div className="metric-card"><div className="metric-card__label">Curtidas</div><div className="metric-card__value">{totals.likes ? fmtN(totals.likes) : '--'}</div></div>
                                <div className="metric-card"><div className="metric-card__label">Comentários</div><div className="metric-card__value">{totals.comments ? fmtN(totals.comments) : '--'}</div></div>
                            </div>
                            {/* Detalhe por rede (sem gráfico) */}
                            {networks.length > 0 && (
                                <div className="bdm-net-list">
                                    {networks.map(k => {
                                        const Icon = PLATFORM_ICON[k] || Radio;
                                        const m = sm[k] || {};
                                        const link = liveLinks[k];
                                        return (
                                            <div key={k} className="bdm-net">
                                                <div className="bdm-net__head">
                                                    <span className="bdm-net__name"><Icon size={14} style={{ color: PLATFORM_BY_KEY[k]?.color }} /> {PLATFORM_BY_KEY[k]?.label || k}</span>
                                                    {link && <a href={link} target="_blank" rel="noopener noreferrer" className="bdm-net__link" aria-label="Abrir"><ExternalLink size={13} /></a>}
                                                </div>
                                                <div className="bdm-net__stats">
                                                    {METRIC_FIELDS.map(f => (
                                                        <span key={f.key} className="bdm-net__stat"><b>{fmtN(Number(m[f.key]) || 0)}</b>{f.short}</span>
                                                    ))}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                            {src.audienceOrigin && <div className="bdm-origin">Origem do público: <strong>{src.audienceOrigin}</strong></div>}
                        </div>
                    )}

                    {isCompleted && !isLive && (
                        <div className="bdm-section">
                            <div className="bdm-section__title"><Radio size={14} /> Gravação</div>
                            <div className="metrics-grid">
                                <div className="metric-card"><div className="metric-card__label">Duração</div><div className="metric-card__value">{src.durationMinutes ? `${src.durationMinutes} min` : '--'}</div></div>
                            </div>
                            {recordingLink && (
                                <a href={recordingLink} target="_blank" rel="noopener noreferrer" className="btn btn-secondary" style={{ marginTop: 10 }}>
                                    <ExternalLink size={15} /> Assistir gravação
                                </a>
                            )}
                        </div>
                    )}

                    {/* Reschedule */}
                    {showReschedule && canReschedule() && (
                        <div className="reschedule-panel" style={{ marginTop: 4 }}>
                            <h4 className="reschedule-panel__title">Reagendar</h4>
                            <p className="reschedule-panel__note">Máx. {getRule('reschedule_max_days') || 7} dias · Mesma faixa ({src.tierApplied})</p>
                            <div className="reschedule-panel__form">
                                <input type="date" className="form-input" value={rescheduleDate} onChange={e => setRescheduleDate(e.target.value)}
                                    min={new Date().toISOString().split('T')[0]} max={new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0]} style={{ flex: 1 }} />
                                {/* Select com os horários REAIS da grade: o input time com step 3600
                                    travava os minutos em :00 — 15:30 e 20:30 eram inescolhíveis. */}
                                <select className="form-input" value={rescheduleTime} onChange={e => setRescheduleTime(e.target.value)} style={{ width: 120 }}>
                                    <option value="">Horário…</option>
                                    {SLOT_TIMES.map(t => <option key={t} value={t}>{t}</option>)}
                                </select>
                                <button className="btn btn-primary btn-sm" onClick={handleReschedule} disabled={rescheduling || !rescheduleDate || !rescheduleTime}>Confirmar</button>
                            </div>
                            {rescheduleError && <div className="error-message" style={{ marginTop: 8 }}>{rescheduleError}</div>}
                        </div>
                    )}

                    {/* Footer */}
                    <div className="bdm-footer">
                        {src.status === 'RESERVED' && src.holdExpiresAt && new Date(src.holdExpiresAt).getTime() > Date.now() ? (
                            <button className="btn btn-primary" onClick={() => { onClose(); navigate('/meus-pagamentos'); }}><CreditCard size={15} /> Pagar agora</button>
                        ) : (
                            <>
                                {canReschedule() && (
                                    <button className="btn btn-secondary" onClick={() => setShowReschedule(v => !v)}><RefreshCw size={15} /> Reagendar</button>
                                )}
                                <button className="btn btn-primary" onClick={handleSave} disabled={saving}>{saving ? 'Salvando...' : 'Salvar'}</button>
                            </>
                        )}
                    </div>
                </div>
            </BottomSheetModal>

            {/* Services bottom sheet */}
            <BottomSheetModal isOpen={showServicesSheet} onClose={() => { setShowServicesSheet(false); setServicesStep(1); setSelectedNewAddons([]); }}
                title={servicesStep === 1 ? 'Serviços para este episódio' : 'Confirmação'} zIndex={1100}>
                {servicesStep === 1 ? (
                    <div className="svc-catalog">
                        {contractAvailable.length > 0 && (
                            <>
                                <p className="svc-catalog__group-title">Inclusos no seu plano</p>
                                <div className="svc-catalog__list">
                                    {contractAvailable.map(a => {
                                        const sel = selectedNewAddons.includes(a.key);
                                        return (
                                            <div key={a.key} className={`svc-card svc-card--contract ${sel ? 'svc-card--selected' : ''}`} onClick={() => setSelectedNewAddons(p => p.includes(a.key) ? p.filter(k => k !== a.key) : [...p, a.key])}>
                                                <div className="svc-card__header">
                                                    <div className="svc-card__icon">{ADDON_ICONS[a.key] || '✨'}</div>
                                                    <div className="svc-card__info"><p className="svc-card__name">{a.name}</p>{a.description && <p className="svc-card__desc">{a.description}</p>}</div>
                                                    <div className="svc-card__check"><Check size={14} /></div>
                                                </div>
                                                <div className="svc-card__footer"><span className="svc-card__contract-badge">Incluso no plano</span></div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </>
                        )}
                        {availableForPurchase.length > 0 && (
                            <>
                                <p className="svc-catalog__group-title">Serviços avulsos</p>
                                <div className="svc-catalog__list">
                                    {availableForPurchase.map(a => {
                                        const sel = selectedNewAddons.includes(a.key);
                                        const finalPrice = Math.round(a.price * (1 - discountPct / 100));
                                        return (
                                            <div key={a.key} className={`svc-card ${sel ? 'svc-card--selected' : ''}`} onClick={() => setSelectedNewAddons(p => p.includes(a.key) ? p.filter(k => k !== a.key) : [...p, a.key])}>
                                                <div className="svc-card__header">
                                                    <div className="svc-card__icon">{ADDON_ICONS[a.key] || '✨'}</div>
                                                    <div className="svc-card__info"><p className="svc-card__name">{a.name}</p>{a.description && <p className="svc-card__desc">{a.description}</p>}</div>
                                                    <div className="svc-card__check"><Check size={14} /></div>
                                                </div>
                                                <div className="svc-card__footer">
                                                    <div className="svc-card__price">
                                                        {discountPct > 0 && <span className="svc-card__price-original">{formatBRL(a.price)}</span>}
                                                        <span className="svc-card__price-final">{formatBRL(finalPrice)}</span>
                                                        {discountPct > 0 && <span className="svc-card__price-discount">{discountPct}% desc.</span>}
                                                    </div>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </>
                        )}
                        {selectedNewAddons.length > 0 && (
                            <div className="svc-catalog__cta">
                                <button className="btn btn-primary" onClick={() => setServicesStep(2)}>Continuar ({selectedNewAddons.length})</button>
                            </div>
                        )}
                    </div>
                ) : (
                    <div className="svc-summary">
                        <div className="svc-summary__list">
                            {selectedNewAddons.map(key => {
                                const a = episodeAddons.find(x => x.key === key); if (!a) return null;
                                const isContract = ctrAddOns.includes(key);
                                const finalPrice = isContract ? 0 : Math.round(a.price * (1 - discountPct / 100));
                                return (
                                    <div key={key} className="svc-summary__item">
                                        <span className="svc-summary__item-name">{ADDON_ICONS[key] || '✨'} {a.name}</span>
                                        <span className={`svc-summary__item-price ${isContract ? 'svc-summary__item-price--free' : ''}`}>{isContract ? 'Incluso' : formatBRL(finalPrice)}</span>
                                    </div>
                                );
                            })}
                        </div>
                        {totalPaid > 0 && (
                            <div className="svc-summary__total"><span className="svc-summary__total-label">Total a pagar</span><span className="svc-summary__total-value">{formatBRL(totalPaid)}</span></div>
                        )}
                        <div className="svc-summary__actions">
                            <button className="btn btn-primary" onClick={handleConfirmAddons} disabled={saving}>{saving ? 'Processando...' : totalPaid > 0 ? `Pagar ${formatBRL(totalPaid)}` : 'Confirmar Ativação'}</button>
                            <button className="btn btn-secondary" onClick={() => setServicesStep(1)}><ChevronLeft size={16} /> Voltar</button>
                        </div>
                    </div>
                )}
            </BottomSheetModal>

            {/* Payment */}
            {payingAddon && (
                <PaymentModal
                    title="Pagar Serviço"
                    amount={payingAddon.amount}
                    paymentId={payingAddon.paymentId}
                    description={payingAddon.description}
                    allowedMethods={['CARTAO', 'PIX']}
                    onSuccess={() => { setLocalAddOns(prev => [...prev, ...payingAddon.addonKeys]); setPayingAddon(null); showToast('Serviço pago e ativado!'); onSaved(); }}
                    onError={(msg) => showAlert({ message: msg, type: 'error' })}
                    onClose={() => { setPayingAddon(null); showToast('Pagamento não concluído. O serviço só ativa após o pagamento.'); }}
                />
            )}
        </>
    );
}

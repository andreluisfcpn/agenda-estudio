import { useState, useEffect } from 'react';
import { bookingsApi } from '../../../api/client';
import { useUI } from '../../../context/UIContext';
import { getErrorMessage } from '../../../utils/errors';
import BottomSheetModal from '../../BottomSheetModal';
import { PLATFORMS, METRIC_FIELDS, parsePlatforms, parsePlatformLinks, parseStreamMetrics, type PlatformMetric } from '../../../constants/platforms';

interface FinalizeBooking {
    id: string;
    date?: string;
    startTime?: string;
    status?: string;
    durationMinutes?: number | null;
    isLivestream?: boolean | null;
    platforms?: string | null;
    platformLinks?: string | null;
    streamMetrics?: string | null;
    audienceOrigin?: string | null;
    adminNotes?: string | null;
    clientNotes?: string | null;
}

interface Props {
    isOpen: boolean;
    booking: FinalizeBooking | null;
    onClose: () => void;
    onSaved: () => void;
}

const labelCss: React.CSSProperties = { display: 'block', fontSize: '0.6875rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 };
const inputCss: React.CSSProperties = { width: '100%', padding: '8px 12px', borderRadius: 10, fontSize: '0.8125rem', background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-primary)', outline: 'none', fontFamily: 'inherit' };

export default function FinalizeRecordingModal({ isOpen, booking, onClose, onSaved }: Props) {
    const { showToast } = useUI();
    const [duration, setDuration] = useState('');
    const [isLive, setIsLive] = useState(false);
    const [selected, setSelected] = useState<string[]>([]);
    const [links, setLinks] = useState<Record<string, string>>({});
    const [metrics, setMetrics] = useState<Record<string, Record<string, string>>>({});
    const [audienceOrigin, setAudienceOrigin] = useState('');
    const [adminNotes, setAdminNotes] = useState('');
    const [clientNotes, setClientNotes] = useState('');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');

    // Initialize from the booking each time it opens (pre-fills when editing a finalized one).
    useEffect(() => {
        if (!isOpen || !booking) return;
        setDuration(booking.durationMinutes != null ? String(booking.durationMinutes) : '');
        const sm = parseStreamMetrics(booking.streamMetrics);
        const plats = parsePlatforms(booking.platforms);
        setIsLive(booking.isLivestream ?? (plats.length > 0 || Object.keys(sm).length > 0));
        setSelected(plats.length > 0 ? plats : Object.keys(sm));
        setLinks(parsePlatformLinks(booking.platformLinks));
        const m: Record<string, Record<string, string>> = {};
        for (const [k, v] of Object.entries(sm)) {
            m[k] = Object.fromEntries(METRIC_FIELDS.map(f => [f.key, v[f.key] != null ? String(v[f.key]) : '']));
        }
        setMetrics(m);
        setAudienceOrigin(booking.audienceOrigin || '');
        setAdminNotes(booking.adminNotes || '');
        setClientNotes(booking.clientNotes || '');
        setError('');
    }, [isOpen, booking]);

    if (!isOpen || !booking) return null;

    const togglePlatform = (key: string) => {
        setSelected(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]);
    };
    const setMetric = (pkey: string, field: string, val: string) => {
        setMetrics(prev => ({ ...prev, [pkey]: { ...(prev[pkey] || {}), [field]: val.replace(/[^\d]/g, '') } }));
    };

    const save = async () => {
        setSaving(true); setError('');
        try {
            const usePlatforms = isLive ? selected : [];
            const streamMetricsObj: Record<string, PlatformMetric> = {};
            const linksObj: Record<string, string> = {};
            for (const k of usePlatforms) {
                const mk = metrics[k] || {};
                streamMetricsObj[k] = {
                    views: Number(mk.views) || 0,
                    peak: Number(mk.peak) || 0,
                    likes: Number(mk.likes) || 0,
                    comments: Number(mk.comments) || 0,
                };
                if (links[k]?.trim()) linksObj[k] = links[k].trim();
            }
            await bookingsApi.complete(booking.id, {
                durationMinutes: duration === '' ? null : Number(duration),
                isLivestream: isLive,
                platforms: JSON.stringify(usePlatforms),
                platformLinks: JSON.stringify(linksObj),
                streamMetrics: isLive && usePlatforms.length > 0 ? JSON.stringify(streamMetricsObj) : JSON.stringify({}),
                audienceOrigin: audienceOrigin.trim() || null,
                adminNotes: adminNotes.trim() || null,
                clientNotes: clientNotes.trim() || null,
            });
            showToast('Gravação finalizada com sucesso!');
            onSaved();
            onClose();
        } catch (e) { setError(getErrorMessage(e) || 'Erro ao finalizar.'); }
        finally { setSaving(false); }
    };

    return (
        <BottomSheetModal isOpen onClose={onClose} hideHeader maxWidth="560px" className="admin-sheet" title="Finalizar gravação">
            <div style={{ padding: '24px 28px 28px' }}>
                <h2 style={{ fontSize: '1.125rem', fontWeight: 800, margin: '0 0 4px', display: 'flex', alignItems: 'center', gap: 8 }}>🏁 Finalizar gravação</h2>
                <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: '0 0 18px' }}>
                    Registre os dados da sessão. {booking.date ? `${new Date(booking.date).toLocaleDateString('pt-BR', { timeZone: 'UTC', day: '2-digit', month: 'short' })} ${booking.startTime || ''}` : ''}
                </p>

                {error && <div style={{ marginBottom: 14, padding: '10px 14px', borderRadius: 10, background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.15)', color: '#ef4444', fontSize: '0.8125rem', fontWeight: 600 }}>{error}</div>}

                {/* Duration + origin */}
                <div className="admin-grid-2" style={{ marginBottom: 16 }}>
                    <div>
                        <label style={labelCss}>⏱️ Duração (min)</label>
                        <input type="text" inputMode="numeric" value={duration} placeholder="Ex: 120" style={inputCss}
                            onChange={e => setDuration(e.target.value.replace(/[^\d]/g, ''))} />
                    </div>
                    <div>
                        <label style={labelCss}>🌎 Origem do público</label>
                        <input type="text" value={audienceOrigin} placeholder="Ex: SP Capital" style={inputCss}
                            onChange={e => setAudienceOrigin(e.target.value)} />
                    </div>
                </div>

                {/* Livestream toggle */}
                <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', padding: '12px 14px', borderRadius: 10, marginBottom: 14, background: isLive ? 'rgba(239,68,68,0.06)' : 'var(--bg-elevated)', border: `1px solid ${isLive ? 'rgba(239,68,68,0.3)' : 'var(--border-default)'}` }}>
                    <input type="checkbox" checked={isLive} onChange={e => setIsLive(e.target.checked)} style={{ width: 18, height: 18, accentColor: '#ef4444', cursor: 'pointer' }} />
                    <div>
                        <div style={{ fontSize: '0.8125rem', fontWeight: 700 }}>🔴 Foi transmissão ao vivo?</div>
                        <div style={{ fontSize: '0.625rem', color: 'var(--text-muted)', marginTop: 2 }}>Marque para registrar redes, links e métricas por plataforma.</div>
                    </div>
                </label>

                {isLive && (
                    <>
                        {/* Platform multiselect */}
                        <label style={labelCss}>Redes da transmissão</label>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
                            {PLATFORMS.map(p => {
                                const on = selected.includes(p.key);
                                return (
                                    <button key={p.key} type="button" onClick={() => togglePlatform(p.key)}
                                        style={{
                                            display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 12px', borderRadius: 999, cursor: 'pointer',
                                            fontSize: '0.75rem', fontWeight: 700,
                                            background: on ? `${p.color}1f` : 'var(--bg-elevated)',
                                            border: `1.5px solid ${on ? p.color : 'var(--border-default)'}`,
                                            color: on ? '#fff' : 'var(--text-muted)',
                                        }}>
                                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: p.color }} /> {p.label}
                                    </button>
                                );
                            })}
                        </div>

                        {/* Per-platform link + metrics */}
                        {selected.map(key => {
                            const p = PLATFORMS.find(x => x.key === key);
                            if (!p) return null;
                            return (
                                <div key={key} style={{ marginBottom: 12, padding: 14, borderRadius: 12, background: 'var(--bg-card)', border: `1px solid ${p.color}33` }}>
                                    <div style={{ fontWeight: 700, fontSize: '0.8125rem', color: p.color, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
                                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: p.color }} /> {p.label}
                                    </div>
                                    <div style={{ marginBottom: 10 }}>
                                        <label style={labelCss}>🔗 Link da transmissão</label>
                                        <input type="url" value={links[key] || ''} placeholder="https://..." style={inputCss}
                                            onChange={e => setLinks(prev => ({ ...prev, [key]: e.target.value }))} />
                                    </div>
                                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10 }}>
                                        {METRIC_FIELDS.map(f => (
                                            <div key={f.key}>
                                                <label style={labelCss}>{f.label}</label>
                                                <input type="text" inputMode="numeric" value={metrics[key]?.[f.key] || ''} placeholder="0" style={inputCss}
                                                    onChange={e => setMetric(key, f.key, e.target.value)} />
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            );
                        })}
                    </>
                )}

                {/* Notes */}
                <div className="admin-grid-2" style={{ marginTop: 4, marginBottom: 18 }}>
                    <div>
                        <label style={labelCss}>📝 Nota interna (admin)</label>
                        <textarea value={adminNotes} rows={2} style={{ ...inputCss, resize: 'vertical' }} placeholder="Privado" onChange={e => setAdminNotes(e.target.value)} />
                    </div>
                    <div>
                        <label style={labelCss}>💬 Feedback ao cliente</label>
                        <textarea value={clientNotes} rows={2} style={{ ...inputCss, resize: 'vertical' }} placeholder="Visível ao cliente" onChange={e => setClientNotes(e.target.value)} />
                    </div>
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                    <button onClick={onClose} disabled={saving} style={{ padding: '10px 20px', borderRadius: 10, background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-secondary)', fontSize: '0.8125rem', fontWeight: 600, cursor: 'pointer' }}>Cancelar</button>
                    <button onClick={save} disabled={saving} style={{ padding: '10px 24px', borderRadius: 10, border: 'none', background: 'linear-gradient(135deg, #10b981, #11819B)', color: '#fff', fontSize: '0.875rem', fontWeight: 700, cursor: 'pointer', opacity: saving ? 0.6 : 1 }}>
                        {saving ? 'Salvando…' : '🏁 Finalizar'}
                    </button>
                </div>
            </div>
        </BottomSheetModal>
    );
}

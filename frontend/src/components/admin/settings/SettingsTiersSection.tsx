import { getErrorMessage } from '../../../utils/errors';
import { useState, useEffect } from 'react';
import { pricingApi, PricingConfig, BusinessConfigItem } from '../../../api/client';
import LoadingSpinner from '../../ui/LoadingSpinner';
import SettingsSaveBar, { SettingsMessages } from './SettingsSaveBar';
import { formatBRL } from '../../../utils/format';

const TIER_INFO: Record<string, { emoji: string; desc: string; color: string; bg: string }> = {
    COMERCIAL: { emoji: '🏢', desc: 'Segunda a Sexta, 10h–15:30h', color: '#10b981', bg: 'rgba(16,185,129,0.10)' },
    AUDIENCIA: { emoji: '🎤', desc: 'Segunda a Sexta, 18h–20:30h', color: '#2dd4bf', bg: 'rgba(45,212,191,0.10)' },
    SABADO:    { emoji: '🌟', desc: 'Sábado, qualquer horário',     color: '#fbbf24', bg: 'rgba(245,158,11,0.10)' },
};

/**
 * Self-contained tier-prices editor. Reuses the tier cards from
 * AdminPricingPage's "tiers" tab verbatim. Also loads business config
 * (read-only) so the discount preview matches the legacy behavior exactly.
 */
export default function SettingsTiersSection() {
    const [pricing, setPricing] = useState<PricingConfig[]>([]);
    const [tierEdited, setTierEdited] = useState(false);
    const [configs, setConfigs] = useState<BusinessConfigItem[]>([]);

    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [success, setSuccess] = useState('');
    const [error, setError] = useState('');

    const getCfg = (key: string) => Number(configs.find(c => c.key === key)?.value || 0);

    useEffect(() => { loadAll(); }, []);

    const loadAll = async () => {
        setLoading(true);
        try { const res = await pricingApi.get(); setPricing(res.pricing); } catch (err) { console.error(err); }
        try { const res = await pricingApi.getBusinessConfig(); setConfigs(res.configs); } catch (err) { console.error(err); }
        setTierEdited(false);
        setLoading(false);
    };

    const showMsg = (msg: string) => { setSuccess(msg); setTimeout(() => setSuccess(''), 4000); };

    const handleTierChange = (tier: string, field: string, value: string) => {
        setPricing(prev => prev.map(p => {
            if (p.tier !== tier) return p;
            if (field === 'price') return { ...p, price: Math.round(parseFloat(value.replace(',', '.')) * 100) || 0 };
            return { ...p, [field]: value };
        }));
        setTierEdited(true); setSuccess('');
    };

    const handleSaveTiers = async () => {
        setSaving(true); setError('');
        try { await pricingApi.update(pricing); showMsg('✅ Preços atualizados!'); setTierEdited(false); }
        catch (err: unknown) { setError(getErrorMessage(err)); }
        finally { setSaving(false); }
    };

    if (loading) return <LoadingSpinner />;

    return (
        <div>
            <div style={{ marginBottom: '20px' }}>
                <h2 style={{ fontSize: '1.125rem', fontWeight: 800, marginBottom: '2px' }}>Faixas de Preço</h2>
                <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>Preço base do pacote 2h por faixa de horário.</p>
            </div>

            <SettingsMessages error={error} success={success} />

            <div style={{ display: 'grid', gap: '16px', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
                {pricing.map(p => {
                    const info = TIER_INFO[p.tier];
                    return (
                        <div key={p.tier} style={{
                            padding: '24px', borderRadius: '16px',
                            background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
                            borderTop: `3px solid ${info?.color}`,
                        }}>
                            {/* Tier header */}
                            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' }}>
                                <div style={{
                                    width: 48, height: 48, borderRadius: '12px',
                                    background: info?.bg, display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    fontSize: '1.5rem', border: `1px solid ${info?.color}22`,
                                }}>
                                    {info?.emoji}
                                </div>
                                <div>
                                    <div style={{ fontWeight: 700, fontSize: '1.0625rem' }}>{p.label || p.tier}</div>
                                    <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)' }}>{info?.desc}</div>
                                </div>
                            </div>

                            <div className="form-group">
                                <label className="form-label">Nome da Faixa</label>
                                <input className="form-input" value={p.label} onChange={e => handleTierChange(p.tier, 'label', e.target.value)} />
                            </div>

                            <div className="form-group">
                                <label className="form-label">Preço do Pacote 2h</label>
                                <div style={{ position: 'relative' }}>
                                    <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', fontWeight: 600 }}>R$</span>
                                    <input className="form-input" style={{ paddingLeft: 40, fontSize: '1.25rem', fontWeight: 700 }}
                                        type="text" value={(p.price / 100).toFixed(2).replace('.', ',')}
                                        onChange={e => handleTierChange(p.tier, 'price', e.target.value)} />
                                </div>
                            </div>

                            <div className="form-group">
                                <label className="form-label">Descrição do Plano</label>
                                <textarea className="form-input" style={{ minHeight: 80, resize: 'vertical', fontFamily: 'inherit', fontSize: '0.8125rem' }}
                                    placeholder="Descreva os benefícios deste plano..."
                                    value={p.description || ''} onChange={e => handleTierChange(p.tier, 'description', e.target.value)} />
                            </div>

                            {/* Discount preview */}
                            <div style={{
                                padding: '14px', background: 'rgba(255,255,255,0.02)', borderRadius: '10px',
                                border: '1px solid var(--border-color)', marginTop: '8px',
                            }}>
                                <div style={{ fontSize: '0.625rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '8px' }}>Preços com Desconto</div>
                                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8125rem', marginBottom: '6px' }}>
                                    <span style={{ color: 'var(--text-secondary)' }}>📦 {getCfg('episodes_3months') || 12} ep / 3 meses ({getCfg('discount_3months') || 30}%)</span>
                                    <span style={{ fontWeight: 700, color: info?.color }}>{formatBRL(Math.round(p.price * (1 - ((getCfg('discount_3months') || 30) / 100))))}</span>
                                </div>
                                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8125rem' }}>
                                    <span style={{ color: 'var(--text-secondary)' }}>📦 {getCfg('episodes_6months') || 24} ep / 6 meses ({getCfg('discount_6months') || 40}%)</span>
                                    <span style={{ fontWeight: 700, color: info?.color }}>{formatBRL(Math.round(p.price * (1 - ((getCfg('discount_6months') || 40) / 100))))}</span>
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>

            {tierEdited && (
                <SettingsSaveBar saving={saving} onSave={handleSaveTiers} onDiscard={loadAll} />
            )}
        </div>
    );
}

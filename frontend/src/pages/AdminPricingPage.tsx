import React, { useState, useEffect } from 'react';
import { pricingApi, PricingConfig } from '../api/client';

function formatBRL(cents: number): string {
    return `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;
}

const TIER_INFO: Record<string, { emoji: string; desc: string }> = {
    COMERCIAL: { emoji: '🏢', desc: 'Segunda a Sexta, 09h–18h' },
    AUDIENCIA: { emoji: '🎤', desc: 'Segunda a Sexta, 18h30–23h' },
    SABADO: { emoji: '🌟', desc: 'Sábado, 09h–23h' },
};

export default function AdminPricingPage() {
    const [pricing, setPricing] = useState<PricingConfig[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [success, setSuccess] = useState('');
    const [error, setError] = useState('');
    const [edited, setEdited] = useState(false);

    useEffect(() => { loadPricing(); }, []);

    const loadPricing = async () => {
        setLoading(true);
        try { const res = await pricingApi.get(); setPricing(res.pricing); }
        catch (err) { console.error(err); }
        finally { setLoading(false); }
    };

    const handleFieldChange = (tier: string, field: string, value: string) => {
        setPricing(prev => prev.map(p => {
            if (p.tier !== tier) return p;
            if (field === 'price') {
                const cents = Math.round(parseFloat(value.replace(',', '.')) * 100) || 0;
                return { ...p, price: cents };
            }
            return { ...p, [field]: value };
        }));
        setEdited(true);
        setSuccess('');
    };

    const handleSave = async () => {
        setSaving(true); setError(''); setSuccess('');
        try {
            await pricingApi.update(pricing);
            setSuccess('Preços atualizados com sucesso!');
            setEdited(false);
        } catch (err: any) { setError(err.message); }
        finally { setSaving(false); }
    };

    if (loading) return <div className="loading-spinner"><div className="spinner" /></div>;

    return (
        <div>
            <div className="page-header">
                <h1 className="page-title">💰 Planos & Valores</h1>
                <p className="page-subtitle">Configure os preços e conheça os tipos de plano</p>
            </div>

            {error && <div className="error-message" style={{ marginBottom: '16px' }}>{error}</div>}
            {success && <div className="success-message" style={{ marginBottom: '16px' }}>{success}</div>}

            {/* Plan Types Section */}
            <div style={{ marginBottom: '24px' }}>
                <h2 style={{ fontSize: '1.0625rem', fontWeight: 700, marginBottom: '12px' }}>📦 Tipos de Plano</h2>
                <div style={{ display: 'grid', gap: '16px', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
                    {/* Fixo */}
                    <div className="card" style={{ padding: '20px', borderLeft: '4px solid var(--tier-comercial)' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' }}>
                            <span style={{ fontSize: '1.5rem' }}>📌</span>
                            <div>
                                <div style={{ fontWeight: 700, fontSize: '1.0625rem' }}>Plano Fixo</div>
                                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Recorrente · Dia e horário fixos</div>
                            </div>
                        </div>
                        <div style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                            <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: '4px' }}>Regras de Uso:</div>
                            <div>✅ O cliente escolhe um <strong>dia da semana e horário fixos</strong></div>
                            <div>✅ Agendamentos são gerados <strong>automaticamente</strong> para o período do contrato</div>
                            <div>✅ 1 gravação por semana, sempre no mesmo dia/horário</div>
                            <div>✅ Pacote de 12 gravações (3 meses) ou 24 gravações (6 meses)</div>
                            <div style={{ marginTop: '4px', padding: '8px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)', fontSize: '0.75rem' }}>
                                <strong>Desconto:</strong> 30% para 3 meses · 40% para 6 meses
                            </div>
                        </div>
                    </div>

                    {/* Flex */}
                    <div className="card" style={{ padding: '20px', borderLeft: '4px solid var(--accent-primary)' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' }}>
                            <span style={{ fontSize: '1.5rem' }}>🔄</span>
                            <div>
                                <div style={{ fontWeight: 700, fontSize: '1.0625rem' }}>Plano Flex</div>
                                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Créditos · Horários livres</div>
                            </div>
                        </div>
                        <div style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                            <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: '4px' }}>Regras de Uso:</div>
                            <div>✅ O cliente recebe <strong>créditos de gravação</strong> (12 ou 24 episódios)</div>
                            <div>✅ Horários livres — agenda quando quiser</div>
                            <div>⚠️ Consumo mínimo: <strong>1 gravação por semana</strong> (use ou perca)</div>
                            <div>✅ Adiantamento livre: pode usar todos os créditos de uma vez</div>
                            <div>✅ Gravações adiantadas <strong>compensam semanas futuras</strong></div>
                            <div style={{ marginTop: '4px', padding: '8px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)', fontSize: '0.75rem' }}>
                                <strong>Desconto:</strong> 30% para 12 ep (3 meses) · 40% para 24 ep (6 meses)
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {/* Pricing Tiers */}
            <h2 style={{ fontSize: '1.0625rem', fontWeight: 700, marginBottom: '12px' }}>🎚️ Faixas de Preço (Pacote 2h)</h2>
            <div style={{ display: 'grid', gap: '16px', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
                {pricing.map(p => {
                    const info = TIER_INFO[p.tier];
                    return (
                        <div key={p.tier} className="card" style={{ padding: '24px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' }}>
                                <div style={{
                                    width: 48, height: 48, borderRadius: 'var(--radius-md)',
                                    background: `var(--tier-${p.tier.toLowerCase()}-bg)`,
                                    display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.5rem',
                                }}>{info?.emoji}</div>
                                <div>
                                    <div style={{ fontWeight: 700, fontSize: '1.0625rem' }}>{p.label}</div>
                                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{info?.desc}</div>
                                </div>
                            </div>

                            <div className="form-group">
                                <label className="form-label">Nome da Faixa</label>
                                <input className="form-input" value={p.label} onChange={e => handleFieldChange(p.tier, 'label', e.target.value)} />
                            </div>

                            <div className="form-group">
                                <label className="form-label">Preço do Pacote 2h (R$)</label>
                                <div style={{ position: 'relative' }}>
                                    <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', fontWeight: 600 }}>R$</span>
                                    <input
                                        className="form-input"
                                        style={{ paddingLeft: 40, fontSize: '1.25rem', fontWeight: 700 }}
                                        type="text"
                                        value={(p.price / 100).toFixed(2).replace('.', ',')}
                                        onChange={e => handleFieldChange(p.tier, 'price', e.target.value)}
                                    />
                                </div>
                            </div>

                            <div className="form-group">
                                <label className="form-label">Descrição do Plano</label>
                                <textarea
                                    className="form-input"
                                    style={{ minHeight: 80, resize: 'vertical', fontFamily: 'inherit', fontSize: '0.8125rem' }}
                                    placeholder="Descreva os benefícios deste plano..."
                                    value={p.description || ''}
                                    onChange={e => handleFieldChange(p.tier, 'description', e.target.value)}
                                />
                            </div>

                            <div style={{ padding: '12px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)', marginTop: '8px' }}>
                                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '6px' }}>PREÇOS COM DESCONTO</div>
                                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8125rem' }}>
                                    <span>📦 12 ep / 3 meses (30%):</span>
                                    <span style={{ fontWeight: 700, color: 'var(--tier-comercial)' }}>{formatBRL(Math.round(p.price * 0.7))}</span>
                                </div>
                                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8125rem', marginTop: '4px' }}>
                                    <span>📦 24 ep / 6 meses (40%):</span>
                                    <span style={{ fontWeight: 700, color: 'var(--tier-comercial)' }}>{formatBRL(Math.round(p.price * 0.6))}</span>
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>

            {edited && (
                <div style={{
                    position: 'fixed', bottom: 24, right: 24, left: 264,
                    display: 'flex', justifyContent: 'flex-end', gap: '12px',
                    padding: '16px 24px',
                    background: 'var(--bg-card)', borderRadius: 'var(--radius-lg)',
                    boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
                    border: '1px solid var(--border-color)', zIndex: 100,
                }}>
                    <span style={{ alignSelf: 'center', color: 'var(--accent-primary)', fontSize: '0.875rem', marginRight: 'auto' }}>⚠️ Alterações não salvas</span>
                    <button className="btn btn-secondary" onClick={loadPricing}>Descartar</button>
                    <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
                        {saving ? '⏳ Salvando...' : '💾 Salvar Alterações'}
                    </button>
                </div>
            )}
        </div>
    );
}

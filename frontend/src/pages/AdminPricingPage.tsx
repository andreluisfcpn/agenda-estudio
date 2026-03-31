import React, { useState, useEffect } from 'react';
import { pricingApi, PricingConfig, AddOnConfig, BusinessConfigItem, PaymentMethodConfigItem, integrationsApi, IntegrationSummary } from '../api/client';
import { setPaymentMethods as setCachedPaymentMethods } from '../constants/paymentMethods';

function formatBRL(cents: number): string {
    return `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;
}

const TIER_INFO: Record<string, { emoji: string; desc: string; color: string; bg: string }> = {
    COMERCIAL: { emoji: '🏢', desc: 'Segunda a Sexta, 10h–15:30h', color: '#10b981', bg: 'rgba(16,185,129,0.10)' },
    AUDIENCIA: { emoji: '🎤', desc: 'Segunda a Sexta, 18h–20:30h', color: '#2dd4bf', bg: 'rgba(45,212,191,0.10)' },
    SABADO:    { emoji: '🌟', desc: 'Sábado, qualquer horário',     color: '#fbbf24', bg: 'rgba(245,158,11,0.10)' },
};

const GROUP_LABELS: Record<string, { label: string; emoji: string; desc: string; color: string }> = {
    plans:    { label: 'Planos & Episódios',    emoji: '📦', desc: 'Descontos por fidelidade e contagem de episódios', color: '#2dd4bf' },
    policies: { label: 'Políticas Operacionais', emoji: '📋', desc: 'Janelas de tempo, multas e restrições de agendamento', color: '#f59e0b' },
    payments: { label: 'Taxas & Descontos',      emoji: '💳', desc: 'Descontos PIX, taxas cartão e serviços mensais', color: '#10b981' },
    schedule: { label: 'Horários & Grade',       emoji: '🕐', desc: 'Slots de atendimento, dias de funcionamento e duração dos blocos', color: '#3b82f6' },
    gateway:  { label: 'Taxas de Gateway',       emoji: '🏦', desc: 'Taxas de processamento dos meios de pagamento (Stripe e Cora)', color: '#ef4444' },
    studio:   { label: 'Estúdio & Branding',     emoji: '🏢', desc: 'Nome, logo, e-mail e imagens do estúdio', color: '#f97316' },
};

export default function AdminPricingPage() {
    const [tab, setTab] = useState<'tiers' | 'addons' | 'rules' | 'payments' | 'integrations'>('tiers');

    const [pricing, setPricing] = useState<PricingConfig[]>([]);
    const [tierEdited, setTierEdited] = useState(false);

    const [addons, setAddons] = useState<AddOnConfig[]>([]);
    const [addonEdited, setAddonEdited] = useState(false);

    const [configs, setConfigs] = useState<BusinessConfigItem[]>([]);
    const [configEdited, setConfigEdited] = useState(false);
    const [configGrouped, setConfigGrouped] = useState<Record<string, BusinessConfigItem[]>>({});

    const [paymentMethods, setPaymentMethods] = useState<PaymentMethodConfigItem[]>([]);
    const [pmEdited, setPmEdited] = useState(false);

    const [integrations, setIntegrations] = useState<IntegrationSummary[]>([]);
    const [coraForm, setCoraForm] = useState({ clientId: '', certificatePem: '', privateKeyPem: '', pixKey: '', environment: 'sandbox' });
    const [stripeForm, setStripeForm] = useState({ secretKey: '', publishableKey: '', webhookSecret: '', environment: 'sandbox' });
    const [testingProvider, setTestingProvider] = useState<string | null>(null);

    const getCfg = (key: string) => Number(configs.find(c => c.key === key)?.value || 0);

    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [success, setSuccess] = useState('');
    const [error, setError] = useState('');

    useEffect(() => { loadAll(); }, []);

    const loadAll = async () => {
        setLoading(true);
        try { const res = await pricingApi.get(); setPricing(res.pricing); } catch (err) { console.error(err); }
        try { const res = await pricingApi.getAddons(); setAddons(res.addons); } catch (err) { console.error(err); }
        try {
            const res = await pricingApi.getBusinessConfig();
            setConfigs(res.configs);
            setConfigGrouped(res.grouped);
        } catch (err) {
            console.error(err);
            setError('Não foi possível carregar as regras de negócio.');
        }
        try {
            const res = await pricingApi.getPaymentMethodsAll();
            setPaymentMethods(res.methods);
        } catch (err) {
            console.error(err);
        }
        try {
            const res = await integrationsApi.list();
            setIntegrations(res.integrations);
        } catch (err) {
            console.error(err);
        }
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
        catch (err: any) { setError(err.message); }
        finally { setSaving(false); }
    };

    const handleAddonChange = (key: string, field: string, value: string) => {
        setAddons(prev => prev.map(a => {
            if (a.key !== key) return a;
            if (field === 'price') return { ...a, price: Math.round(parseFloat(value.replace(',', '.')) * 100) || 0 };
            return { ...a, [field]: value };
        }));
        setAddonEdited(true); setSuccess('');
    };

    const handleSaveAddons = async () => {
        setSaving(true); setError('');
        try { await pricingApi.updateAddons(addons); showMsg('✅ Serviços extras atualizados!'); setAddonEdited(false); }
        catch (err: any) { setError(err.message); }
        finally { setSaving(false); }
    };

    const handleConfigChange = (key: string, value: string) => {
        setConfigs(prev => prev.map(c => c.key === key ? { ...c, value } : c));
        setConfigGrouped(prev => {
            const updated: Record<string, BusinessConfigItem[]> = {};
            for (const g in prev) { updated[g] = prev[g].map(c => c.key === key ? { ...c, value } : c); }
            return updated;
        });
        setConfigEdited(true); setSuccess('');
    };

    const handleSaveConfigs = async () => {
        setSaving(true); setError('');
        try {
            await pricingApi.updateBusinessConfig(configs.map(c => ({ key: c.key, value: c.value })));
            showMsg('✅ Regras de negócio atualizadas!');
            setConfigEdited(false);
        } catch (err: any) { setError(err.message); }
        finally { setSaving(false); }
    };

    const handlePmChange = (key: string, field: string, value: any) => {
        setPaymentMethods(prev => prev.map(pm =>
            pm.key === key ? { ...pm, [field]: value } : pm
        ));
        setPmEdited(true); setSuccess('');
    };

    const handleSavePaymentMethods = async () => {
        setSaving(true); setError('');
        try {
            const res = await pricingApi.updatePaymentMethods(paymentMethods);
            showMsg('✅ Métodos de pagamento atualizados!');
            setPmEdited(false);
            // Update the global cache so all components reflect changes immediately
            setCachedPaymentMethods(res.methods);
        } catch (err: any) { setError(err.message); }
        finally { setSaving(false); }
    };

    const isEdited = tab === 'tiers' ? tierEdited : tab === 'addons' ? addonEdited : tab === 'rules' ? configEdited : tab === 'payments' ? pmEdited : false;
    const handleSave = tab === 'tiers' ? handleSaveTiers : tab === 'addons' ? handleSaveAddons : tab === 'rules' ? handleSaveConfigs : handleSavePaymentMethods;

    if (loading) return <div className="loading-spinner"><div className="spinner" /></div>;

    return (
        <div>
            {/* ─── HEADER ─── */}
            <div style={{ marginBottom: '28px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '16px' }}>
                <div>
                    <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <span style={{ fontSize: '1.75rem' }}>💰</span> Planos & Valores
                    </h1>
                    <p className="page-subtitle" style={{ marginTop: '4px' }}>
                        Configure preços, serviços extras e regras de negócio
                    </p>
                </div>
            </div>

            {/* ─── MESSAGES ─── */}
            {error && (
                <div style={{
                    padding: '12px 16px', marginBottom: '16px', borderRadius: '12px',
                    background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)',
                    color: '#ef4444', fontSize: '0.8125rem', fontWeight: 600
                }}>⚠️ {error}</div>
            )}
            {success && (
                <div style={{
                    padding: '12px 16px', marginBottom: '16px', borderRadius: '12px',
                    background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.2)',
                    color: '#10b981', fontSize: '0.8125rem', fontWeight: 600
                }}>{success}</div>
            )}

            {/* ─── TAB PILLS ─── */}
            <div style={{
                display: 'flex', gap: '2px', padding: '3px', marginBottom: '24px',
                background: 'var(--bg-elevated)', borderRadius: '10px', width: 'fit-content',
            }}>
                {([
                    { key: 'tiers' as const, label: '🎚️ Faixas de Preço' },
                    { key: 'addons' as const, label: '✨ Serviços Extras' },
                    { key: 'rules' as const, label: '⚙️ Planos & Regras' },
                    { key: 'payments' as const, label: '💳 Pagamentos' },
                    { key: 'integrations' as const, label: '🔌 Integrações' },
                ]).map(t => (
                    <button key={t.key}
                        onClick={() => { setTab(t.key); setError(''); setSuccess(''); }}
                        style={{
                            padding: '8px 16px', borderRadius: '8px', fontSize: '0.75rem',
                            fontWeight: tab === t.key ? 700 : 500, border: 'none', cursor: 'pointer',
                            background: tab === t.key ? 'var(--bg-secondary)' : 'transparent',
                            color: tab === t.key ? 'var(--text-primary)' : 'var(--text-muted)',
                            boxShadow: tab === t.key ? '0 1px 3px rgba(0,0,0,0.2)' : 'none',
                            transition: 'all 0.2s'
                        }}
                    >
                        {t.label}
                    </button>
                ))}
            </div>

            {/* ═══════════════════════════════════════════
               TAB: FAIXAS DE PREÇO
            ═══════════════════════════════════════════ */}
            {tab === 'tiers' && (
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
                                    <label className="form-label">Preço do Pacote 2h (R$)</label>
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
            )}

            {/* ═══════════════════════════════════════════
               TAB: SERVIÇOS EXTRAS
            ═══════════════════════════════════════════ */}
            {tab === 'addons' && (
                <div style={{ display: 'grid', gap: '16px', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
                    {addons.map(addon => (
                        <div key={addon.key} style={{
                            padding: '24px', borderRadius: '16px',
                            background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
                        }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                                <div>
                                    <div style={{ fontWeight: 700, fontSize: '0.9375rem' }}>{addon.name}</div>
                                    <span style={{
                                        fontSize: '0.625rem', color: 'var(--text-muted)', background: 'var(--bg-elevated)',
                                        padding: '2px 8px', borderRadius: '6px', display: 'inline-block', marginTop: '4px',
                                        fontFamily: "'JetBrains Mono', monospace",
                                    }}>
                                        {addon.key}
                                    </span>
                                </div>
                                {addon.monthly && (
                                    <span style={{
                                        fontSize: '0.625rem', fontWeight: 700, letterSpacing: '0.05em',
                                        background: 'rgba(45,212,191,0.12)', color: '#2dd4bf',
                                        padding: '3px 10px', borderRadius: '20px', textTransform: 'uppercase',
                                    }}>Mensal</span>
                                )}
                            </div>

                            <div className="form-group">
                                <label className="form-label">Nome</label>
                                <input className="form-input" value={addon.name} onChange={e => handleAddonChange(addon.key, 'name', e.target.value)} />
                            </div>

                            <div className="form-group">
                                <label className="form-label">Preço (R$)</label>
                                <div style={{ position: 'relative' }}>
                                    <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', fontWeight: 600 }}>R$</span>
                                    <input className="form-input" style={{ paddingLeft: 40, fontWeight: 700, fontSize: '1.125rem' }}
                                        type="text" value={(addon.price / 100).toFixed(2).replace('.', ',')}
                                        onChange={e => handleAddonChange(addon.key, 'price', e.target.value)} />
                                </div>
                            </div>

                            <div className="form-group">
                                <label className="form-label">Descrição</label>
                                <textarea className="form-input" style={{ minHeight: 60, resize: 'vertical', fontFamily: 'inherit', fontSize: '0.8125rem' }}
                                    value={addon.description || ''} onChange={e => handleAddonChange(addon.key, 'description', e.target.value)} />
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {/* ═══════════════════════════════════════════
               TAB: PLANOS & REGRAS
            ═══════════════════════════════════════════ */}
            {tab === 'rules' && (
                <div style={{ display: 'grid', gap: '20px' }}>
                    {Object.entries(GROUP_LABELS).map(([groupKey, groupMeta]) => {
                        const items = configGrouped[groupKey] || [];
                        if (items.length === 0) return null;
                        return (
                            <div key={groupKey} style={{
                                padding: '24px', borderRadius: '16px',
                                background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
                            }}>
                                {/* Group header */}
                                <div style={{ marginBottom: '20px', paddingBottom: '14px', borderBottom: '1px solid var(--border-color)' }}>
                                    <h3 style={{
                                        fontSize: '0.9375rem', fontWeight: 700, marginBottom: '4px',
                                        display: 'flex', alignItems: 'center', gap: '8px',
                                    }}>
                                        <span style={{
                                            width: 28, height: 28, borderRadius: '8px',
                                            background: `${groupMeta.color}15`, display: 'inline-flex',
                                            alignItems: 'center', justifyContent: 'center', fontSize: '0.9375rem',
                                        }}>
                                            {groupMeta.emoji}
                                        </span>
                                        {groupMeta.label}
                                    </h3>
                                    <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginLeft: '36px' }}>{groupMeta.desc}</p>
                                </div>

                                <div style={{ display: 'grid', gap: '14px', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
                                    {items.map(cfg => (
                                        <div key={cfg.key} className="form-group" style={{ marginBottom: 0 }}>
                                            <label className="form-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                                <span>{cfg.label}</span>
                                                <span style={{
                                                    fontSize: '0.5625rem', color: 'var(--text-muted)', background: 'var(--bg-elevated)',
                                                    padding: '1px 6px', borderRadius: '4px', fontFamily: "'JetBrains Mono', monospace",
                                                    letterSpacing: '0.03em',
                                                }}>
                                                    {cfg.type}
                                                </span>
                                            </label>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                                <input
                                                    className="form-input"
                                                    type={cfg.type === 'string' ? 'text' : 'number'}
                                                    min={cfg.type !== 'string' ? '0' : undefined}
                                                    step="1"
                                                    value={cfg.value}
                                                    onChange={e => handleConfigChange(cfg.key, e.target.value)}
                                                    style={{
                                                        fontWeight: cfg.type === 'string' ? 400 : 700,
                                                        fontSize: cfg.type === 'string' ? '0.8125rem' : '1.125rem',
                                                        flexShrink: 0,
                                                    }}
                                                />
                                                {cfg.type !== 'string' && (
                                                    <span style={{
                                                        fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-secondary)',
                                                        minWidth: 28, textAlign: 'center',
                                                    }}>
                                                        {cfg.type === 'percent' ? '%' : cfg.key.includes('minutes') ? 'min' : cfg.key.includes('hours') ? 'h' : cfg.key.includes('days') ? 'd' : cfg.key.includes('cents') ? '¢' : ''}
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        );
                    })}

                    {/* Info banner */}
                    <div style={{
                        padding: '14px 18px', borderRadius: '12px', fontSize: '0.8125rem',
                        background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.15)',
                        color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '8px',
                    }}>
                        <span style={{ fontSize: '1rem' }}>ℹ️</span>
                        Alterações nestas regras afetam imediatamente a criação de <strong style={{ marginLeft: '4px' }}>novos contratos</strong> e agendamentos. Contratos já existentes não são retroativamente recalculados.
                    </div>
                </div>
            )}

            {/* ═══════════════════════════════════════════
               TAB: PAGAMENTOS
            ═══════════════════════════════════════════ */}
            {tab === 'payments' && (
                <div>
                    {/* Info banner */}
                    <div style={{
                        padding: '14px 18px', borderRadius: '12px', fontSize: '0.8125rem', marginBottom: '20px',
                        background: 'rgba(45,212,191,0.06)', border: '1px solid rgba(45,212,191,0.15)',
                        color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '8px',
                    }}>
                        <span style={{ fontSize: '1rem' }}>💳</span>
                        Gerencie os métodos de pagamento disponíveis em todo o sistema. Desativar um método o remove de todos os wizards e modais.
                    </div>

                    <div style={{ display: 'grid', gap: '16px', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))' }}>
                        {paymentMethods.map((pm, idx) => (
                            <div key={pm.key} style={{
                                padding: '24px', borderRadius: '16px',
                                background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
                                borderTop: `3px solid ${pm.active ? pm.color : 'var(--border-color)'}`,
                                opacity: pm.active ? 1 : 0.6,
                                transition: 'all 0.3s ease',
                            }}>
                                {/* Header with toggle */}
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                                        <div style={{
                                            width: 48, height: 48, borderRadius: '12px',
                                            background: pm.active ? `${pm.color}18` : 'var(--bg-elevated)',
                                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                                            fontSize: '1.5rem', border: `1px solid ${pm.active ? pm.color + '33' : 'var(--border-color)'}`,
                                        }}>
                                            {pm.emoji}
                                        </div>
                                        <div>
                                            <div style={{ fontWeight: 700, fontSize: '1.0625rem' }}>{pm.label}</div>
                                            <span style={{
                                                fontSize: '0.625rem', color: 'var(--text-muted)', background: 'var(--bg-elevated)',
                                                padding: '2px 8px', borderRadius: '6px', fontFamily: "'JetBrains Mono', monospace",
                                            }}>{pm.key}</span>
                                        </div>
                                    </div>

                                    {/* Active Toggle */}
                                    <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                                        <span style={{ fontSize: '0.6875rem', fontWeight: 600, color: pm.active ? '#10b981' : 'var(--text-muted)' }}>
                                            {pm.active ? 'Ativo' : 'Inativo'}
                                        </span>
                                        <div
                                            onClick={() => handlePmChange(pm.key, 'active', !pm.active)}
                                            style={{
                                                width: 44, height: 24, borderRadius: '12px', cursor: 'pointer',
                                                background: pm.active ? '#10b981' : 'var(--bg-elevated)',
                                                border: `1px solid ${pm.active ? '#10b981' : 'var(--border-color)'}`,
                                                position: 'relative', transition: 'all 0.2s ease',
                                            }}
                                        >
                                            <div style={{
                                                width: 18, height: 18, borderRadius: '50%', background: '#fff',
                                                position: 'absolute', top: 2,
                                                left: pm.active ? 22 : 2,
                                                transition: 'left 0.2s ease',
                                                boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
                                            }} />
                                        </div>
                                    </label>
                                </div>

                                {/* Fields */}
                                <div style={{ display: 'grid', gap: '12px', gridTemplateColumns: '1fr 1fr' }}>
                                    <div className="form-group" style={{ marginBottom: 0 }}>
                                        <label className="form-label">Nome Completo</label>
                                        <input className="form-input" value={pm.label}
                                            onChange={e => handlePmChange(pm.key, 'label', e.target.value)} />
                                    </div>
                                    <div className="form-group" style={{ marginBottom: 0 }}>
                                        <label className="form-label">Nome Curto</label>
                                        <input className="form-input" value={pm.shortLabel}
                                            onChange={e => handlePmChange(pm.key, 'shortLabel', e.target.value)} />
                                    </div>
                                </div>

                                <div style={{ display: 'grid', gap: '12px', gridTemplateColumns: '80px 1fr', marginTop: '12px' }}>
                                    <div className="form-group" style={{ marginBottom: 0 }}>
                                        <label className="form-label">Emoji</label>
                                        <input className="form-input" value={pm.emoji}
                                            style={{ textAlign: 'center', fontSize: '1.25rem' }}
                                            onChange={e => handlePmChange(pm.key, 'emoji', e.target.value)} />
                                    </div>
                                    <div className="form-group" style={{ marginBottom: 0 }}>
                                        <label className="form-label">Descrição</label>
                                        <input className="form-input" value={pm.description}
                                            onChange={e => handlePmChange(pm.key, 'description', e.target.value)} />
                                    </div>
                                </div>

                                <div style={{ display: 'grid', gap: '12px', gridTemplateColumns: '1fr 1fr', marginTop: '12px' }}>
                                    <div className="form-group" style={{ marginBottom: 0 }}>
                                        <label className="form-label">Cor</label>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                            <input type="color" value={pm.color.startsWith('#') ? pm.color : '#14b8a6'}
                                                onChange={e => handlePmChange(pm.key, 'color', e.target.value)}
                                                style={{ width: 36, height: 36, border: 'none', borderRadius: '8px', cursor: 'pointer', padding: 0 }} />
                                            <input className="form-input" value={pm.color}
                                                onChange={e => handlePmChange(pm.key, 'color', e.target.value)}
                                                style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '0.75rem' }} />
                                        </div>
                                    </div>
                                    <div className="form-group" style={{ marginBottom: 0 }}>
                                        <label className="form-label">Modo de Acesso</label>
                                        <select className="form-select" value={pm.accessMode}
                                            onChange={e => handlePmChange(pm.key, 'accessMode', e.target.value)}>
                                            <option value="FULL">🟢 Imediato (FULL)</option>
                                            <option value="PROGRESSIVE">🟡 Progressivo (PROGRESSIVE)</option>
                                        </select>
                                    </div>
                                </div>

                                {/* Preview */}
                                <div style={{
                                    marginTop: '16px', padding: '12px 14px', borderRadius: '10px',
                                    background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-color)',
                                }}>
                                    <div style={{ fontSize: '0.625rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '8px' }}>Prévia no Sistema</div>
                                    <div style={{
                                        display: 'inline-flex', alignItems: 'center', gap: '6px',
                                        padding: '8px 14px', borderRadius: '8px',
                                        background: `${pm.color}18`, border: `2px solid ${pm.color}`,
                                    }}>
                                        <span style={{ fontSize: '1rem' }}>{pm.emoji}</span>
                                        <span style={{ fontWeight: 700, fontSize: '0.875rem', color: pm.color }}>{pm.label}</span>
                                    </div>
                                    <div style={{ marginTop: '6px', fontSize: '0.6875rem', color: 'var(--text-muted)' }}>
                                        Badge: <span style={{
                                            display: 'inline-flex', alignItems: 'center', gap: '4px',
                                            padding: '2px 8px', borderRadius: '6px', fontSize: '0.6875rem', fontWeight: 600,
                                            background: 'var(--bg-elevated)', color: 'var(--text-secondary)',
                                        }}>{pm.emoji} {pm.shortLabel}</span>
                                        &nbsp;·&nbsp; Acesso: <strong>{pm.accessMode === 'FULL' ? 'Imediato' : 'Progressivo'}</strong>
                                    </div>
                                </div>

                                {/* Sort order */}
                                <div style={{ marginTop: '12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                                    <span style={{ fontSize: '0.6875rem', color: 'var(--text-muted)' }}>Ordem:</span>
                                    <input type="number" className="form-input" value={pm.sortOrder} min={0}
                                        onChange={e => handlePmChange(pm.key, 'sortOrder', parseInt(e.target.value) || 0)}
                                        style={{ width: 60, textAlign: 'center', fontWeight: 700, fontSize: '0.875rem' }} />
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* ─── FLOATING SAVE BAR ─── */}
            {isEdited && (
                <div style={{
                    position: 'fixed', bottom: 24, right: 24, left: 264,
                    display: 'flex', justifyContent: 'flex-end', gap: '12px',
                    padding: '14px 24px',
                    background: 'var(--bg-secondary)',
                    borderRadius: '14px',
                    boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
                    border: '1px solid rgba(16,185,129,0.3)', zIndex: 100,
                }}>
                    <span style={{
                        alignSelf: 'center', fontSize: '0.8125rem', marginRight: 'auto',
                        color: '#f59e0b', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px',
                    }}>
                        <span style={{
                            width: 8, height: 8, borderRadius: '50%', background: '#f59e0b',
                            animation: 'today-pulse 2s infinite', display: 'inline-block',
                        }} />
                        Alterações não salvas
                    </span>
                    <button className="btn btn-secondary" onClick={loadAll} style={{ borderRadius: '10px' }}>Descartar</button>
                    <button className="btn btn-primary" onClick={handleSave} disabled={saving}
                        style={{ borderRadius: '10px', padding: '8px 20px', fontWeight: 700 }}>
                        {saving ? '⏳ Salvando...' : '💾 Salvar Alterações'}
                    </button>
                </div>
            )}

            {/* ═══════════════════════════════════════════════ */}
            {/* TAB: INTEGRAÇÕES                                */}
            {/* ═══════════════════════════════════════════════ */}
            {tab === 'integrations' && (() => {
                const cora = integrations.find(i => i.provider === 'CORA');
                const stripe = integrations.find(i => i.provider === 'STRIPE');

                const statusBadge = (status: string | null) => {
                    if (status === 'success') return <span style={{ color: '#10b981', fontWeight: 700, fontSize: '0.75rem' }}>🟢 Conectado</span>;
                    if (status === 'error') return <span style={{ color: '#ef4444', fontWeight: 700, fontSize: '0.75rem' }}>🔴 Erro</span>;
                    return <span style={{ color: '#f59e0b', fontWeight: 700, fontSize: '0.75rem' }}>🟡 Não testado</span>;
                };

                const inputStyle: React.CSSProperties = {
                    width: '100%', padding: '10px 14px', borderRadius: '10px',
                    background: 'var(--bg-secondary)', border: '1px solid var(--border-default)',
                    color: 'var(--text-primary)', fontSize: '0.8125rem', fontFamily: 'monospace',
                };

                const labelStyle: React.CSSProperties = {
                    display: 'block', fontSize: '0.6875rem', fontWeight: 700,
                    color: 'var(--text-muted)', textTransform: 'uppercase' as const,
                    letterSpacing: '0.05em', marginBottom: '6px', marginTop: '14px',
                };

                const handleSaveIntegration = async (provider: string) => {
                    setSaving(true); setError(''); setSuccess('');
                    try {
                        const data = provider === 'CORA'
                            ? { environment: coraForm.environment, config: { clientId: coraForm.clientId, certificatePem: coraForm.certificatePem, privateKeyPem: coraForm.privateKeyPem, pixKey: coraForm.pixKey } }
                            : { environment: stripeForm.environment, config: { secretKey: stripeForm.secretKey, publishableKey: stripeForm.publishableKey, webhookSecret: stripeForm.webhookSecret } };
                        const res = await integrationsApi.save(provider, data);
                        setSuccess(res.message);
                        // Reload integrations
                        const listRes = await integrationsApi.list();
                        setIntegrations(listRes.integrations);
                    } catch (e: any) { setError(e.message || 'Erro ao salvar'); } finally { setSaving(false); }
                };

                const handleTest = async (provider: string) => {
                    setTestingProvider(provider); setError(''); setSuccess('');
                    try {
                        const res = await integrationsApi.test(provider);
                        if (res.success) setSuccess(res.message);
                        else setError(res.message);
                        const listRes = await integrationsApi.list();
                        setIntegrations(listRes.integrations);
                    } catch (e: any) { setError(e.message || 'Erro ao testar'); } finally { setTestingProvider(null); }
                };

                const handleToggle = async (provider: string, enabled: boolean) => {
                    try {
                        await integrationsApi.toggle(provider, enabled);
                        const listRes = await integrationsApi.list();
                        setIntegrations(listRes.integrations);
                        setSuccess(`${provider} ${enabled ? 'ativado' : 'desativado'}`);
                    } catch (e: any) { setError(e.message); }
                };

                return (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: '20px' }}>
                        {/* ─── CORA Card ─── */}
                        <div style={{
                            padding: '24px', borderRadius: '16px',
                            background: 'var(--bg-elevated)', border: '1px solid var(--border-default)',
                        }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                    <span style={{ fontSize: '1.75rem' }}>🏦</span>
                                    <div>
                                        <div style={{ fontSize: '1rem', fontWeight: 800, color: 'var(--text-primary)' }}>Cora</div>
                                        <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)' }}>PIX e Boleto Bancário</div>
                                    </div>
                                </div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                    {statusBadge(cora?.testStatus || null)}
                                    <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
                                        <input type="checkbox" checked={cora?.enabled || false}
                                            onChange={e => handleToggle('CORA', e.target.checked)}
                                            style={{ width: '16px', height: '16px', accentColor: '#10b981' }} />
                                        <span style={{ fontSize: '0.6875rem', fontWeight: 600, color: cora?.enabled ? '#10b981' : 'var(--text-muted)' }}>
                                            {cora?.enabled ? 'Ativo' : 'Inativo'}
                                        </span>
                                    </label>
                                </div>
                            </div>

                            <label style={labelStyle}>Client ID</label>
                            <input style={inputStyle} type="text" placeholder="Seu Client ID da Cora"
                                value={coraForm.clientId} onChange={e => setCoraForm(f => ({ ...f, clientId: e.target.value }))} />

                            <label style={labelStyle}>Chave PIX</label>
                            <input style={inputStyle} type="text" placeholder="email@empresa.com ou CPF/CNPJ"
                                value={coraForm.pixKey} onChange={e => setCoraForm(f => ({ ...f, pixKey: e.target.value }))} />

                            <label style={labelStyle}>Certificado (.pem)</label>
                            <textarea style={{ ...inputStyle, minHeight: '80px', resize: 'vertical' as const }}
                                placeholder="Cole o conteúdo do certificado .pem aqui..."
                                value={coraForm.certificatePem}
                                onChange={e => setCoraForm(f => ({ ...f, certificatePem: e.target.value }))} />

                            <label style={labelStyle}>Chave Privada (.key)</label>
                            <textarea style={{ ...inputStyle, minHeight: '80px', resize: 'vertical' as const }}
                                placeholder="Cole o conteúdo da chave privada .key aqui..."
                                value={coraForm.privateKeyPem}
                                onChange={e => setCoraForm(f => ({ ...f, privateKeyPem: e.target.value }))} />

                            <label style={labelStyle}>Ambiente</label>
                            <select style={inputStyle} value={coraForm.environment}
                                onChange={e => setCoraForm(f => ({ ...f, environment: e.target.value }))}>
                                <option value="sandbox">🧪 Sandbox (Testes)</option>
                                <option value="production">🚀 Produção</option>
                            </select>

                            {cora?.webhookUrl && (
                                <div style={{ marginTop: '14px' }}>
                                    <label style={labelStyle}>Webhook URL (cole no painel Cora)</label>
                                    <div style={{
                                        padding: '8px 12px', borderRadius: '8px', fontSize: '0.75rem',
                                        background: 'rgba(16,185,129,0.06)', border: '1px solid rgba(16,185,129,0.15)',
                                        color: '#10b981', fontFamily: 'monospace', wordBreak: 'break-all',
                                    }}>
                                        {cora.webhookUrl}
                                    </div>
                                </div>
                            )}

                            {cora?.lastTestedAt && (
                                <div style={{ marginTop: '8px', fontSize: '0.6875rem', color: 'var(--text-muted)' }}>
                                    Último teste: {new Date(cora.lastTestedAt).toLocaleString('pt-BR')}
                                    {cora.testMessage && <span> — {cora.testMessage}</span>}
                                </div>
                            )}

                            <div style={{ display: 'flex', gap: '8px', marginTop: '18px' }}>
                                <button className="btn btn-primary" style={{ flex: 1, borderRadius: '10px', fontWeight: 700 }}
                                    onClick={() => handleSaveIntegration('CORA')} disabled={saving}>
                                    {saving ? '⏳...' : '💾 Salvar Cora'}
                                </button>
                                <button className="btn btn-secondary" style={{ borderRadius: '10px', fontWeight: 700 }}
                                    onClick={() => handleTest('CORA')} disabled={testingProvider === 'CORA'}>
                                    {testingProvider === 'CORA' ? '⏳ Testando...' : '🧪 Testar'}
                                </button>
                            </div>
                        </div>

                        {/* ─── STRIPE Card ─── */}
                        <div style={{
                            padding: '24px', borderRadius: '16px',
                            background: 'var(--bg-elevated)', border: '1px solid var(--border-default)',
                        }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                    <span style={{ fontSize: '1.75rem' }}>💳</span>
                                    <div>
                                        <div style={{ fontSize: '1rem', fontWeight: 800, color: 'var(--text-primary)' }}>Stripe</div>
                                        <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)' }}>Cartão de Crédito e Débito</div>
                                    </div>
                                </div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                    {statusBadge(stripe?.testStatus || null)}
                                    <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
                                        <input type="checkbox" checked={stripe?.enabled || false}
                                            onChange={e => handleToggle('STRIPE', e.target.checked)}
                                            style={{ width: '16px', height: '16px', accentColor: '#14b8a6' }} />
                                        <span style={{ fontSize: '0.6875rem', fontWeight: 600, color: stripe?.enabled ? '#14b8a6' : 'var(--text-muted)' }}>
                                            {stripe?.enabled ? 'Ativo' : 'Inativo'}
                                        </span>
                                    </label>
                                </div>
                            </div>

                            <label style={labelStyle}>Secret Key</label>
                            <input style={inputStyle} type="password" placeholder="sk_test_xxx ou sk_live_xxx"
                                value={stripeForm.secretKey} onChange={e => setStripeForm(f => ({ ...f, secretKey: e.target.value }))} />

                            <label style={labelStyle}>Publishable Key</label>
                            <input style={inputStyle} type="text" placeholder="pk_test_xxx ou pk_live_xxx"
                                value={stripeForm.publishableKey} onChange={e => setStripeForm(f => ({ ...f, publishableKey: e.target.value }))} />

                            <label style={labelStyle}>Webhook Secret</label>
                            <input style={inputStyle} type="password" placeholder="whsec_xxx"
                                value={stripeForm.webhookSecret} onChange={e => setStripeForm(f => ({ ...f, webhookSecret: e.target.value }))} />

                            <label style={labelStyle}>Ambiente</label>
                            <select style={inputStyle} value={stripeForm.environment}
                                onChange={e => setStripeForm(f => ({ ...f, environment: e.target.value }))}>
                                <option value="sandbox">🧪 Teste (sk_test)</option>
                                <option value="production">🚀 Produção (sk_live)</option>
                            </select>

                            {stripe?.webhookUrl && (
                                <div style={{ marginTop: '14px' }}>
                                    <label style={labelStyle}>Webhook URL (cole no dashboard Stripe)</label>
                                    <div style={{
                                        padding: '8px 12px', borderRadius: '8px', fontSize: '0.75rem',
                                        background: 'rgba(45,212,191,0.06)', border: '1px solid rgba(45,212,191,0.15)',
                                        color: '#14b8a6', fontFamily: 'monospace', wordBreak: 'break-all',
                                    }}>
                                        {stripe.webhookUrl}
                                    </div>
                                </div>
                            )}

                            {stripe?.lastTestedAt && (
                                <div style={{ marginTop: '8px', fontSize: '0.6875rem', color: 'var(--text-muted)' }}>
                                    Último teste: {new Date(stripe.lastTestedAt).toLocaleString('pt-BR')}
                                    {stripe.testMessage && <span> — {stripe.testMessage}</span>}
                                </div>
                            )}

                            <div style={{ display: 'flex', gap: '8px', marginTop: '18px' }}>
                                <button className="btn btn-primary" style={{ flex: 1, borderRadius: '10px', fontWeight: 700 }}
                                    onClick={() => handleSaveIntegration('STRIPE')} disabled={saving}>
                                    {saving ? '⏳...' : '💾 Salvar Stripe'}
                                </button>
                                <button className="btn btn-secondary" style={{ borderRadius: '10px', fontWeight: 700 }}
                                    onClick={() => handleTest('STRIPE')} disabled={testingProvider === 'STRIPE'}>
                                    {testingProvider === 'STRIPE' ? '⏳ Testando...' : '🧪 Testar'}
                                </button>
                            </div>
                        </div>
                    </div>
                );
            })()}
        </div>
    );
}

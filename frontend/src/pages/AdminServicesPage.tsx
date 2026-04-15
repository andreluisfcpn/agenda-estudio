import { getErrorMessage } from '../utils/errors';
import React, { useState, useEffect } from 'react';
import { pricingApi, AddOnConfig } from '../api/client';

function AddonEditorCard({ addon, onUpdate }: { addon: AddOnConfig; onUpdate: (key: string, field: string, value: string) => void }) {
    const [localName, setLocalName] = useState(addon.name);
    const [localPrice, setLocalPrice] = useState((addon.price / 100).toFixed(2).replace('.', ','));
    const [localDesc, setLocalDesc] = useState(addon.description || '');

    // Reset local state if external addon changes (e.g. initial load)
    useEffect(() => {
        setLocalName(addon.name);
        setLocalPrice((addon.price / 100).toFixed(2).replace('.', ','));
        setLocalDesc(addon.description || '');
    }, [addon.name, addon.price, addon.description]);

    const handleBlur = (field: string, localVal: string) => {
        onUpdate(addon.key, field, localVal);
    };

    return (
        <div style={{
            padding: '24px', borderRadius: '16px',
            background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
        }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '16px' }}>
                <div style={{ fontSize: '0.6875rem', fontFamily: "'JetBrains Mono', monospace", color: 'var(--text-muted)', background: 'var(--bg-elevated)', padding: '2px 8px', borderRadius: '4px' }}>
                    {addon.key}
                </div>
            </div>

            <div className="form-group">
                <label className="form-label">Nome Público</label>
                <input className="form-input" 
                    value={localName} 
                    onChange={e => setLocalName(e.target.value)} 
                    onBlur={() => handleBlur('name', localName)} 
                />
            </div>

            <div className="form-group">
                <label className="form-label">Preço {addon.monthly ? 'Mensal' : 'Por Episódio'} (R$)</label>
                <div style={{ position: 'relative' }}>
                    <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', fontWeight: 600 }}>R$</span>
                    <input className="form-input" style={{ paddingLeft: 40, fontWeight: 700, fontSize: '1.125rem' }}
                        type="text" 
                        value={localPrice}
                        onChange={e => {
                            // basic mask behavior - allow typing digits and comma
                            const clean = e.target.value.replace(/[^0-9,]/g, '');
                            setLocalPrice(clean);
                        }} 
                        onBlur={() => {
                            // formatting back properly on blur
                            handleBlur('price', localPrice);
                        }}
                    />
                </div>
            </div>

            <div className="form-group">
                <label className="form-label">Descrição</label>
                <textarea className="form-input" style={{ minHeight: 60, resize: 'vertical', fontFamily: 'inherit', fontSize: '0.8125rem' }}
                    value={localDesc} 
                    onChange={e => setLocalDesc(e.target.value)} 
                    onBlur={() => handleBlur('description', localDesc)} 
                />
            </div>
        </div>
    );
}

export default function AdminServicesPage() {
    const [addons, setAddons] = useState<AddOnConfig[]>([]);
    const [addonEdited, setAddonEdited] = useState(false);
    
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [success, setSuccess] = useState('');
    const [error, setError] = useState('');

    useEffect(() => { loadAddons(); }, []);

    const loadAddons = async () => {
        setLoading(true);
        try { 
            const res = await pricingApi.getAddons(); 
            setAddons(res.addons); 
        } catch (err) { 
            console.error(err); 
            setError('Não foi possível carregar os serviços adicionais.');
        } finally {
            setLoading(false);
        }
    };

    const showMsg = (msg: string) => { setSuccess(msg); setTimeout(() => setSuccess(''), 4000); };

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
        try { 
            await pricingApi.updateAddons(addons); 
            showMsg('✅ Serviços atualizados com sucesso!'); 
            setAddonEdited(false); 
        } catch (err: unknown) { 
            setError(getErrorMessage(err)); 
        } finally { 
            setSaving(false); 
        }
    };

    if (loading) return <div className="loading-spinner"><div className="spinner" /></div>;

    const perEpisodeAddons = addons.filter(a => !a.monthly);
    const monthlyAddons = addons.filter(a => a.monthly);

    const renderAddonGroup = (title: string, desc: string, icon: string, groupAddons: AddOnConfig[]) => {
        if (groupAddons.length === 0) return null;
        return (
            <div style={{ marginBottom: '32px' }}>
                <div style={{ marginBottom: '16px', paddingBottom: '12px', borderBottom: '1px solid var(--border-color)' }}>
                    <h2 style={{ fontSize: '1.25rem', fontWeight: 800, display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span>{icon}</span> {title}
                    </h2>
                    <p style={{ fontSize: '0.875rem', color: 'var(--text-muted)' }}>{desc}</p>
                </div>
                
                <div style={{ display: 'grid', gap: '16px', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
                    {groupAddons.map(addon => (
                        <AddonEditorCard key={addon.key} addon={addon} onUpdate={handleAddonChange} />
                    ))}
                </div>
            </div>
        );
    };

    return (
        <div>
            {/* ─── HEADER ─── */}
            <div style={{ marginBottom: '28px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '16px' }}>
                <div>
                    <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <span style={{ fontSize: '1.75rem' }}>✨</span> Serviços
                    </h1>
                    <p className="page-subtitle" style={{ marginTop: '4px' }}>
                        Gerencie os serviços adicionais pagos por episódio ou mensalmente
                    </p>
                </div>
                <div>
                    <button className="btn btn-primary" onClick={handleSaveAddons} disabled={!addonEdited || saving} style={{ width: 140 }}>
                        {saving ? '⏳...' : addonEdited ? '💾 Salvar' : '✅ Salvo'}
                    </button>
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

            {renderAddonGroup('Serviços por Episódio', 'Clientes podem adicionar esses serviços pontualmente a cada agendamento feito.', '🎙️', perEpisodeAddons)}
            {renderAddonGroup('Serviços Mensais', 'Serviços contínuos geralmente linkados a contratos mais englobados.', '📅', monthlyAddons)}
            
        </div>
    );
}

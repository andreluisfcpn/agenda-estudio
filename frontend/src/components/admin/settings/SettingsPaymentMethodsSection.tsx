import { getErrorMessage } from '../../../utils/errors';
import { useState, useEffect } from 'react';
import { pricingApi, PaymentMethodConfigItem } from '../../../api/client';
import { setPaymentMethods as setCachedPaymentMethods } from '../../../constants/paymentMethods';
import LoadingSpinner from '../../ui/LoadingSpinner';
import SettingsSaveBar, { SettingsMessages } from './SettingsSaveBar';

/**
 * Self-contained payment-methods editor. Reuses the payment-method cards from
 * AdminPricingPage's "payments" tab verbatim, and on save updates the global
 * payment-methods cache so the rest of the app reflects changes immediately.
 */
export default function SettingsPaymentMethodsSection() {
    const [paymentMethods, setPaymentMethods] = useState<PaymentMethodConfigItem[]>([]);
    const [pmEdited, setPmEdited] = useState(false);

    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [success, setSuccess] = useState('');
    const [error, setError] = useState('');

    useEffect(() => { loadAll(); }, []);

    const loadAll = async () => {
        setLoading(true);
        try {
            const res = await pricingApi.getPaymentMethodsAll();
            setPaymentMethods(res.methods);
            setPmEdited(false);
        } catch (err) {
            console.error(err);
        }
        setLoading(false);
    };

    const showMsg = (msg: string) => { setSuccess(msg); setTimeout(() => setSuccess(''), 4000); };

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
        } catch (err: unknown) { setError(getErrorMessage(err)); }
        finally { setSaving(false); }
    };

    if (loading) return <LoadingSpinner />;

    return (
        <div>
            <div style={{ marginBottom: '20px' }}>
                <h2 style={{ fontSize: '1.125rem', fontWeight: 800, marginBottom: '2px' }}>Métodos de Pagamento</h2>
                <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>Métodos disponíveis em wizards e modais de todo o sistema.</p>
            </div>

            <SettingsMessages error={error} success={success} />

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
                {paymentMethods.map((pm) => (
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

            {pmEdited && (
                <SettingsSaveBar saving={saving} onSave={handleSavePaymentMethods} onDiscard={loadAll} />
            )}
        </div>
    );
}

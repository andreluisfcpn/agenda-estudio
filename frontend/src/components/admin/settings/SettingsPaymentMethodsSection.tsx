import { getErrorMessage } from '../../../utils/errors';
import { useState, useEffect } from 'react';
import { pricingApi, PaymentMethodConfigItem } from '../../../api/client';
import { setPaymentMethods as setCachedPaymentMethods } from '../../../constants/paymentMethods';
import LoadingSpinner from '../../ui/LoadingSpinner';
import SettingsSaveBar, { SettingsMessages } from './SettingsSaveBar';
import SegmentedControl from '../../ui/fields/SegmentedControl';
import ColorField from '../../ui/fields/ColorField';
import EmojiField from '../../ui/fields/EmojiField';
import StepperField from '../../ui/fields/StepperField';

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

            {/* `min(100%, 380px)` forces a single real column when the container is narrow
                (the card never demands 380px if it doesn't fit) → no overflow at narrow widths. */}
            <div style={{ display: 'grid', gap: 'var(--space-4)', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 380px), 1fr))' }}>
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

                        {/* Emoji + Descrição (visíveis sempre) */}
                        <div style={{ display: 'grid', gap: '12px', gridTemplateColumns: 'auto 1fr', marginTop: '12px', alignItems: 'end' }}>
                            <div className="form-group" style={{ marginBottom: 0 }}>
                                <label className="form-label">Emoji</label>
                                <EmojiField value={pm.emoji} onChange={v => handlePmChange(pm.key, 'emoji', v)} />
                            </div>
                            <div className="form-group" style={{ marginBottom: 0 }}>
                                <label className="form-label">Descrição</label>
                                <input className="form-input" value={pm.description}
                                    onChange={e => handlePmChange(pm.key, 'description', e.target.value)} />
                            </div>
                        </div>

                        {/* Contexts — onde aparece (always visible: key business decision) */}
                        <div style={{ marginTop: '16px' }}>
                            <label className="form-label" style={{ marginBottom: '6px' }}>Aparece em</label>
                            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                                {([['avulso', 'Avulso'], ['contract', 'Contratos'], ['invoice', 'Faturas']] as const).map(([ctx, lbl]) => {
                                    const list = (pm.contexts || 'avulso,contract,invoice').split(',').map(s => s.trim()).filter(Boolean);
                                    const on = list.includes(ctx);
                                    return (
                                        <button key={ctx} type="button"
                                            onClick={() => {
                                                const next = on ? list.filter(c => c !== ctx) : [...list, ctx];
                                                handlePmChange(pm.key, 'contexts', next.join(','));
                                            }}
                                            style={{
                                                padding: '6px 12px', borderRadius: '8px', fontSize: '0.75rem', fontWeight: 600, cursor: 'pointer',
                                                background: on ? `${pm.color}1f` : 'var(--bg-elevated)',
                                                color: on ? pm.color : 'var(--text-muted)',
                                                border: `1px solid ${on ? pm.color : 'var(--border-color)'}`,
                                            }}>
                                            {on ? '✓ ' : ''}{lbl}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>

                        {/* Advanced settings: collapsed by default to reduce card density. */}
                        <details className="sf-advanced">
                            <summary>Avançado</summary>
                            <div className="sf-advanced-body">
                                <div className="sf-grid-2">
                                    <div className="form-group" style={{ marginBottom: 0 }}>
                                        <label className="form-label">Cor</label>
                                        <ColorField value={pm.color}
                                            onChange={v => handlePmChange(pm.key, 'color', v)} />
                                    </div>
                                    <div className="form-group" style={{ marginBottom: 0 }}>
                                        <label className="form-label">Modo de Acesso</label>
                                        <SegmentedControl
                                            aria-label="Modo de Acesso"
                                            value={pm.accessMode as 'FULL' | 'PROGRESSIVE'}
                                            onChange={v => handlePmChange(pm.key, 'accessMode', v)}
                                            options={[
                                                { value: 'FULL', label: 'Imediato' },
                                                { value: 'PROGRESSIVE', label: 'Progressivo' },
                                            ]}
                                        />
                                    </div>
                                </div>

                                <div className="form-group" style={{ marginBottom: 0 }}>
                                    <label className="form-label">Ordem de exibição</label>
                                    <StepperField value={pm.sortOrder} min={0} max={99}
                                        onChange={n => handlePmChange(pm.key, 'sortOrder', n)} />
                                </div>

                                {/* Preview */}
                                <div style={{
                                    padding: '12px 14px', borderRadius: '10px',
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
                            </div>
                        </details>
                    </div>
                ))}
            </div>

            {pmEdited && (
                <SettingsSaveBar saving={saving} onSave={handleSavePaymentMethods} onDiscard={loadAll} />
            )}
        </div>
    );
}

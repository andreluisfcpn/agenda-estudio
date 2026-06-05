import { getErrorMessage } from '../../../utils/errors';
import { useState, useEffect } from 'react';
import { pricingApi, BusinessConfigItem } from '../../../api/client';
import LoadingSpinner from '../../ui/LoadingSpinner';
import SettingsSaveBar, { SettingsMessages } from './SettingsSaveBar';

/**
 * Group metadata copied verbatim from AdminPricingPage so the section headers,
 * icons and descriptions match the legacy "rules" tab exactly.
 */
const GROUP_LABELS: Record<string, { label: string; emoji: string; desc: string; color: string }> = {
    plans:    { label: 'Planos & Episódios',    emoji: '📦', desc: 'Descontos por fidelidade e contagem de episódios', color: '#2dd4bf' },
    policies: { label: 'Políticas Operacionais', emoji: '📋', desc: 'Janelas de tempo, multas e restrições de agendamento', color: '#f59e0b' },
    payments: { label: 'Taxas & Descontos',      emoji: '💳', desc: 'Descontos PIX, taxas cartão e serviços mensais', color: '#10b981' },
    schedule: { label: 'Horários & Grade',       emoji: '🕐', desc: 'Slots de atendimento, dias de funcionamento e duração dos blocos', color: '#3b82f6' },
    gateway:  { label: 'Taxas de Gateway',       emoji: '🏦', desc: 'Taxas de processamento dos meios de pagamento (Stripe e Cora)', color: '#ef4444' },
    studio:   { label: 'Estúdio & Branding',     emoji: '🏢', desc: 'Nome, logo, e-mail e imagens do estúdio', color: '#f97316' },
};

interface SettingsBusinessConfigSectionProps {
    /** Which business-config groups to render in this section. */
    groups: string[];
    title: string;
    subtitle?: string;
    /** Stack the save bar above a sibling section's bar (financeiro: tiers + config). */
    stackedSaveBar?: boolean;
}

/**
 * Self-contained business-config editor. Fetches the full business config,
 * renders ONLY the fields whose `group` is in `groups` (reusing the exact
 * field-by-`type` rendering from AdminPricingPage's "rules" tab), and saves
 * via pricingApi.updateBusinessConfig sending the full set (preserving the
 * legacy behavior). Owns its own dirty flag + floating save bar.
 */
export default function SettingsBusinessConfigSection({ groups, title, subtitle, stackedSaveBar }: SettingsBusinessConfigSectionProps) {
    const [configs, setConfigs] = useState<BusinessConfigItem[]>([]);
    const [configGrouped, setConfigGrouped] = useState<Record<string, BusinessConfigItem[]>>({});
    const [configEdited, setConfigEdited] = useState(false);

    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [success, setSuccess] = useState('');
    const [error, setError] = useState('');

    useEffect(() => { loadConfigs(); }, []);

    const loadConfigs = async () => {
        setLoading(true);
        try {
            const res = await pricingApi.getBusinessConfig();
            setConfigs(res.configs);
            setConfigGrouped(res.grouped);
            setConfigEdited(false);
        } catch (err) {
            console.error(err);
            setError('Não foi possível carregar as regras de negócio.');
        } finally {
            setLoading(false);
        }
    };

    const showMsg = (msg: string) => { setSuccess(msg); setTimeout(() => setSuccess(''), 4000); };

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
        } catch (err: unknown) { setError(getErrorMessage(err)); }
        finally { setSaving(false); }
    };

    if (loading) return <LoadingSpinner />;

    const visibleGroups = groups.filter(g => (configGrouped[g] || []).length > 0);

    return (
        <div>
            <div style={{ marginBottom: '20px' }}>
                <h2 style={{ fontSize: '1.125rem', fontWeight: 800, marginBottom: '2px' }}>{title}</h2>
                {subtitle && <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>{subtitle}</p>}
            </div>

            <SettingsMessages error={error} success={success} />

            <div style={{ display: 'grid', gap: '20px' }}>
                {visibleGroups.map(groupKey => {
                    const groupMeta = GROUP_LABELS[groupKey];
                    const items = configGrouped[groupKey] || [];
                    if (!groupMeta || items.length === 0) return null;
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

                {visibleGroups.length === 0 && (
                    <div style={{
                        padding: '24px', borderRadius: '16px', textAlign: 'center',
                        background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
                        color: 'var(--text-muted)', fontSize: '0.8125rem',
                    }}>
                        Nenhuma configuração disponível nesta seção.
                    </div>
                )}

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

            {configEdited && (
                <SettingsSaveBar saving={saving} onSave={handleSaveConfigs} onDiscard={loadConfigs} stacked={stackedSaveBar} />
            )}
        </div>
    );
}

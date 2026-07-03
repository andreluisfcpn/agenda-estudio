import { getErrorMessage } from '../../../utils/errors';
import { useState, useEffect } from 'react';
import { pricingApi, BusinessConfigItem } from '../../../api/client';
import LoadingSpinner from '../../ui/LoadingSpinner';
import SettingsSaveBar, { SettingsMessages } from './SettingsSaveBar';
import ScheduleEditor from './ScheduleEditor';
import ToggleField from '../../ui/fields/ToggleField';
import StepperField from '../../ui/fields/StepperField';
import TimeField from '../../ui/fields/TimeField';
import ColorField from '../../ui/fields/ColorField';
import UrlField from '../../ui/fields/UrlField';
import EmailField from '../../ui/fields/EmailField';

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

/**
 * Strips a trailing unit-only parenthetical (e.g. "(%)", "(R$)", "(centavos)",
 * "(horas)") from a config label — the field's own suffix already conveys the
 * unit, so repeating it in the label is noise. Meaningful parentheticals like
 * "(pacotes 2h)" or "(parcelas sem taxa própria)" are preserved.
 */
const UNIT_PAREN_RE = /\s*\((?:%|R\$|reais?|centavos?|horas?|hrs?|minutos?|mins?|dias?|meses?|h|min|d)\)\s*$/i;
function cleanConfigLabel(label: string): string {
    return label.replace(UNIT_PAREN_RE, '').trim();
}

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

                            {/* `schedule` gets a fully visual editor (toggles, time pickers, steppers)
                                instead of the generic input grid below. */}
                            {groupKey === 'schedule' ? (
                                <ScheduleEditor items={items} onChange={handleConfigChange} />
                            ) : (
                            <div className="sf-config-grid">
                                {items.map(cfg => {
                                    // JSON configs (e.g. card_installment_surcharges) get a
                                    // friendly editor and span the full grid row.
                                    if (cfg.type === 'json') {
                                        return (
                                            <div key={cfg.key} className="sf-config-cell sf-config-cell--full">
                                                <label className="sf-config-label">{cleanConfigLabel(cfg.label)}</label>
                                                <InstallmentSurchargesEditor
                                                    value={cfg.value}
                                                    onChange={v => handleConfigChange(cfg.key, v)}
                                                />
                                            </div>
                                        );
                                    }
                                    return (
                                        <div key={cfg.key} className="sf-config-cell">
                                            <label className="sf-config-label">{cleanConfigLabel(cfg.label)}</label>
                                            <SpecializedConfigField cfg={cfg} onChange={handleConfigChange} />
                                        </div>
                                    );
                                })}
                            </div>
                            )}
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
                <div className="admin-info-banner">
                    <span className="admin-info-banner__icon" aria-hidden="true">ℹ️</span>
                    <span>Alterações nestas regras afetam imediatamente a criação de <strong>novos contratos</strong> e agendamentos. Contratos já existentes não são retroativamente recalculados.</span>
                </div>
            </div>

            {configEdited && (
                <SettingsSaveBar saving={saving} onSave={handleSaveConfigs} onDiscard={loadConfigs} stacked={stackedSaveBar} />
            )}
        </div>
    );
}

/** Number of installments shown in the surcharge editor (1x..12x). */
const INSTALLMENT_COUNT = 12;

/** Safely parse a `{ "1": 0, "2": 6, ... }` JSON string into a number map. */
function parseSurcharges(raw: string): Record<string, number> {
    try {
        const obj = JSON.parse(raw || '{}');
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
        const out: Record<string, number> = {};
        for (const [k, v] of Object.entries(obj)) {
            const n = Number(v);
            if (Number.isFinite(n)) out[k] = n;
        }
        return out;
    } catch {
        return {};
    }
}

/**
 * Friendly editor for `card_installment_surcharges` (type 'json'): one % input
 * per installment (1x..12x). Re-serializes to a JSON string on every change and
 * pushes it up via `onChange`, so the existing PUT save flow is unchanged.
 */
function InstallmentSurchargesEditor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
    const surcharges = parseSurcharges(value);

    const setOne = (installment: number, raw: string) => {
        const next = { ...surcharges };
        if (raw === '') {
            delete next[String(installment)];
        } else {
            const n = Number(raw);
            next[String(installment)] = Number.isFinite(n) ? n : 0;
        }
        // Serialize with numerically-sorted keys for a stable, readable payload.
        const ordered: Record<string, number> = {};
        Object.keys(next)
            .map(k => Number(k))
            .filter(n => Number.isFinite(n))
            .sort((a, b) => a - b)
            .forEach(k => { ordered[String(k)] = next[String(k)]; });
        onChange(JSON.stringify(ordered));
    };

    return (
        <div>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '10px' }}>
                Acréscimo (%) aplicado ao parcelar no cartão, por número de parcelas. Deixe em branco para usar o padrão.
            </p>
            <div className="sf-pct-grid">
                {Array.from({ length: INSTALLMENT_COUNT }, (_, i) => i + 1).map(n => {
                    const raw = surcharges[String(n)];
                    const isEmpty = raw === undefined;
                    const isFree = !isEmpty && Number(raw) === 0;
                    const cls = `sf-pct${isEmpty ? ' sf-pct--default' : ''}${isFree ? ' sf-pct--free' : ''}`;
                    return (
                        <label key={n} className={cls} title={`${n}x`}>
                            <span className="sf-pct-prefix">{n}x</span>
                            <input
                                className="sf-pct-input"
                                type="number"
                                min="0"
                                step="1"
                                inputMode="numeric"
                                placeholder="—"
                                aria-label={`Acréscimo para ${n}x`}
                                value={raw ?? ''}
                                onChange={e => setOne(n, e.target.value)}
                            />
                            <span className="sf-pct-suffix">%</span>
                        </label>
                    );
                })}
            </div>
            <div className="sf-pct-legend">
                <span><span className="sf-pct-legend-dot sf-pct-legend-dot--free" /> 0% = sem juros</span>
                <span><span className="sf-pct-legend-dot sf-pct-legend-dot--default" /> vazio = usa o padrão</span>
            </div>
        </div>
    );
}

/**
 * Dispatcher: chooses the right specialized field by `type` and `key` heuristic,
 * so URLs get a UrlField, emails get an EmailField, percent/cents/hours/minutes/days
 * numerics get a StepperField with the right suffix, booleans get a Toggle, etc.
 * Falls back to a plain text input for unknown string fields.
 */
function SpecializedConfigField({ cfg, onChange }: { cfg: BusinessConfigItem; onChange: (key: string, value: string) => void }) {
    const key = cfg.key.toLowerCase();
    const type = cfg.type;

    // Boolean → switch
    if (type === 'boolean' || cfg.value === 'true' || cfg.value === 'false') {
        return (
            <ToggleField
                checked={cfg.value === 'true'}
                onChange={v => onChange(cfg.key, String(v))}
                aria-label={cfg.label}
            />
        );
    }

    // Time field: keys ending in _time or open_/close_ time
    if (key.endsWith('_time') || key === 'open_time' || key === 'close_time') {
        return <TimeField value={cfg.value} onChange={v => onChange(cfg.key, v)} aria-label={cfg.label} />;
    }

    // Color field: keys with "color"
    if (key === 'color' || key.endsWith('_color') || key.includes('color_')) {
        return <ColorField value={cfg.value} onChange={v => onChange(cfg.key, v)} />;
    }

    // URL field: any URL/link key
    if (key.includes('url') || key.includes('link') || key.endsWith('_logo') || key.endsWith('_image')) {
        return <UrlField value={cfg.value} onChange={v => onChange(cfg.key, v)} />;
    }

    // Email field: any email/mail key (kept above generic string so it gets validated)
    if (key.includes('email') || key.includes('mail_')) {
        return <EmailField value={cfg.value} onChange={v => onChange(cfg.key, v)} />;
    }

    // Numeric (number/percent/cents) → stepper with sensible suffix
    if (type !== 'string') {
        const suffix =
            type === 'percent' ? '%' :
            type === 'cents' || key.includes('cents') ? '¢' :
            key.includes('minute') ? 'min' :
            key.includes('hour') ? 'h' :
            key.includes('day') ? 'd' :
            key.includes('month') ? 'm' :
            '';
        const n = Number(cfg.value);
        return (
            <StepperField
                value={Number.isFinite(n) ? n : 0}
                onChange={v => onChange(cfg.key, String(v))}
                min={0}
                suffix={suffix || undefined}
            />
        );
    }

    // Fallback: plain text input (no suffix, single-line). Same look as before.
    return (
        <input
            className="form-input"
            type="text"
            value={cfg.value}
            onChange={e => onChange(cfg.key, e.target.value)}
        />
    );
}

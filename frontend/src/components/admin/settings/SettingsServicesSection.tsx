import { getErrorMessage } from '../../../utils/errors';
import { useState, useEffect } from 'react';
import { pricingApi, AddOnConfig } from '../../../api/client';
import LoadingSpinner from '../../ui/LoadingSpinner';
import { SettingsMessages } from './SettingsSaveBar';
import SegmentedControl from '../../ui/fields/SegmentedControl';
import StepperField from '../../ui/fields/StepperField';
import { Plus, Trash2, Save, Check, CalendarDays, Mic } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { renderServiceIcon, SERVICE_ICON_OPTIONS } from '../../../utils/serviceIcons';

type EditableAddon = AddOnConfig & { _isNew?: boolean };

const PARSE_BENEFITS = (json?: string | null): string[] => {
    try { const p = json ? JSON.parse(json) : []; return Array.isArray(p) ? p.filter((b): b is string => typeof b === 'string') : []; }
    catch { return []; }
};

/** One self-contained service card: owns its draft + dirty state + its OWN Save button. */
function AddonCard({ initial, siblingKeys, onSaved, onDeleted }: {
    initial: EditableAddon;
    siblingKeys: string[];
    onSaved: (prevKey: string, saved: AddOnConfig) => void;
    onDeleted: (addon: EditableAddon) => void;
}) {
    const [draft, setDraft] = useState<EditableAddon>(initial);
    const [priceText, setPriceText] = useState((initial.price / 100).toFixed(2).replace('.', ','));
    const [benefitsText, setBenefitsText] = useState(PARSE_BENEFITS(initial.benefits).join('\n'));
    const [dirty, setDirty] = useState(!!initial._isNew);
    const [saving, setSaving] = useState(false);
    const [err, setErr] = useState('');
    const [confirmDel, setConfirmDel] = useState(false);

    const set = (patch: Partial<EditableAddon>) => { setDraft(d => ({ ...d, ...patch })); setDirty(true); setErr(''); };

    const monthly = !!draft.monthly;
    const active = draft.active !== false;
    const plans = (draft.plansAllowed || 'FULL').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

    const save = async () => {
        const key = (draft.key || '').trim();
        if (!/^[A-Z0-9_]+$/.test(key) || key.startsWith('NOVO_')) { setErr('Defina uma chave válida (MAIÚSCULAS, números e _).'); return; }
        if (draft._isNew && siblingKeys.includes(key)) { setErr('Já existe um serviço com essa chave.'); return; }
        if (!draft.name?.trim()) { setErr('Informe o nome do serviço.'); return; }
        setSaving(true); setErr('');
        try {
            const { _isNew, ...payload } = { ...draft, key };
            const res = await pricingApi.updateAddons([payload as AddOnConfig]);
            onSaved(initial.key, res.addons[0]);
            setDirty(false);
        } catch (e) { setErr(getErrorMessage(e)); }
        finally { setSaving(false); }
    };

    return (
        <div style={{
            padding: '20px', borderRadius: '16px',
            background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
            borderTop: `3px solid ${active ? 'var(--accent-primary)' : 'var(--border-color)'}`,
            opacity: active ? 1 : 0.65, transition: 'all 0.3s ease',
        }}>
            {/* Header: icon + key + active toggle */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, gap: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                    <div style={{
                        width: 44, height: 44, borderRadius: 12, flexShrink: 0,
                        background: 'rgba(17,129,155,0.12)', border: '1px solid rgba(17,129,155,0.25)',
                        color: 'var(--accent-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                        {renderServiceIcon(draft.icon, 22)}
                    </div>
                    {draft._isNew ? (
                        <input className="form-input" placeholder="CHAVE_UNICA" value={draft.key}
                            onChange={e => set({ key: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '') })}
                            style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '0.75rem', maxWidth: 170 }} />
                    ) : (
                        <span style={{ fontSize: '0.625rem', color: 'var(--text-muted)', background: 'var(--bg-elevated)', padding: '2px 8px', borderRadius: 6, fontFamily: "'JetBrains Mono', monospace" }}>{draft.key}</span>
                    )}
                </div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                    <span style={{ fontSize: '0.6875rem', fontWeight: 600, color: active ? '#10b981' : 'var(--text-muted)' }}>{active ? 'Ativo' : 'Inativo'}</span>
                    <div onClick={() => set({ active: !active })} style={{
                        width: 44, height: 24, borderRadius: 12, cursor: 'pointer',
                        background: active ? '#10b981' : 'var(--bg-elevated)', border: `1px solid ${active ? '#10b981' : 'var(--border-color)'}`,
                        position: 'relative', transition: 'all 0.2s ease',
                    }}>
                        <div style={{ width: 18, height: 18, borderRadius: '50%', background: '#fff', position: 'absolute', top: 2, left: active ? 22 : 2, transition: 'left 0.2s ease', boxShadow: '0 1px 3px rgba(0,0,0,0.3)' }} />
                    </div>
                </label>
            </div>

            {/* Family */}
            <div className="form-group" style={{ marginBottom: 12 }}>
                <label className="form-label">Família</label>
                <SegmentedControl
                    aria-label="Família do serviço"
                    value={monthly ? 'MONTHLY' : 'EPISODE'}
                    onChange={v => set({ monthly: v === 'MONTHLY' })}
                    options={[{ value: 'EPISODE', label: 'Por episódio' }, { value: 'MONTHLY', label: 'Mensal' }]}
                />
            </div>

            <div className="admin-grid-2" style={{ gap: 12 }}>
                <div className="form-group" style={{ marginBottom: 0 }}>
                    <label className="form-label">Nome</label>
                    <input className="form-input" value={draft.name} onChange={e => set({ name: e.target.value })} />
                </div>
                <div className="form-group" style={{ marginBottom: 0 }}>
                    <label className="form-label">Preço {monthly ? 'mensal' : 'por episódio'} (R$)</label>
                    <input className="form-input" type="text" value={priceText}
                        onChange={e => { const clean = e.target.value.replace(/[^0-9,]/g, ''); setPriceText(clean); set({ price: Math.round(parseFloat(clean.replace(',', '.')) * 100) || 0 }); }} />
                </div>
            </div>

            <div className="form-group" style={{ marginTop: 12, marginBottom: 0 }}>
                <label className="form-label">Descrição</label>
                <textarea className="form-input" style={{ minHeight: 56, resize: 'vertical', fontFamily: 'inherit', fontSize: '0.8125rem' }}
                    value={draft.description || ''} onChange={e => set({ description: e.target.value })} />
            </div>

            {/* Display: icon + order + landing */}
            <div className="admin-grid-2" style={{ gap: 12, marginTop: 12, alignItems: 'end' }}>
                <div className="form-group" style={{ marginBottom: 0 }}>
                    <label className="form-label">Ícone</label>
                    <select className="form-input" value={SERVICE_ICON_OPTIONS.includes(draft.icon || '') ? (draft.icon || 'Sparkles') : 'Sparkles'}
                        onChange={e => set({ icon: e.target.value })}>
                        {SERVICE_ICON_OPTIONS.map(ic => <option key={ic} value={ic}>{ic}</option>)}
                    </select>
                </div>
                <div className="form-group" style={{ marginBottom: 0 }}>
                    <label className="form-label">Ordem</label>
                    <StepperField value={draft.sortOrder ?? 0} min={0} max={99} onChange={n => set({ sortOrder: n })} />
                </div>
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginTop: 14, fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
                <input type="checkbox" checked={draft.showOnLanding !== false} onChange={e => set({ showOnLanding: e.target.checked })} />
                Aparece na landing page
            </label>

            {/* Monthly-only: benefits + durations + plans + cadence */}
            {monthly && (
                <details className="sf-advanced" open>
                    <summary>Configuração do serviço mensal</summary>
                    <div className="sf-advanced-body">
                        <div className="form-group" style={{ marginBottom: 0 }}>
                            <label className="form-label">Benefícios (um por linha)</label>
                            <textarea className="form-input" style={{ minHeight: 80, resize: 'vertical', fontFamily: 'inherit', fontSize: '0.8125rem' }}
                                value={benefitsText}
                                onChange={e => { setBenefitsText(e.target.value); const list = e.target.value.split('\n').map(s => s.trim()).filter(Boolean); set({ benefits: list.length ? JSON.stringify(list) : '' }); }}
                                placeholder={'Publicação nas redes\nRelatório mensal\nMaking-of'} />
                        </div>
                        <div className="sf-grid-2">
                            <div className="form-group" style={{ marginBottom: 0 }}>
                                <label className="form-label">Durações (meses, CSV)</label>
                                <input className="form-input" value={draft.durationsOffered || '3,6'}
                                    onChange={e => set({ durationsOffered: e.target.value.replace(/[^0-9,]/g, '') })} />
                            </div>
                            <div className="form-group" style={{ marginBottom: 0 }}>
                                <label className="form-label">Cadência</label>
                                <SegmentedControl
                                    aria-label="Cadência de cobrança"
                                    value={draft.billingCadence === 'CALENDAR_MONTH' ? 'CALENDAR_MONTH' : 'BILLING_CYCLE_28'}
                                    onChange={v => set({ billingCadence: v as AddOnConfig['billingCadence'] })}
                                    options={[{ value: 'CALENDAR_MONTH', label: 'Mês (30d)' }, { value: 'BILLING_CYCLE_28', label: '28 dias' }]}
                                />
                            </div>
                        </div>
                        <div className="form-group" style={{ marginBottom: 0 }}>
                            <label className="form-label" style={{ marginBottom: 6 }}>Planos de pagamento</label>
                            <div style={{ display: 'flex', gap: 8 }}>
                                {([['MONTHLY', 'Mensal'], ['FULL', 'À vista']] as const).map(([p, lbl]) => {
                                    const on = plans.includes(p);
                                    return (
                                        <button key={p} type="button"
                                            onClick={() => { const next = on ? plans.filter(x => x !== p) : [...plans, p]; set({ plansAllowed: (next.length ? next : ['FULL']).join(',') }); }}
                                            style={{
                                                padding: '6px 12px', borderRadius: 8, fontSize: '0.75rem', fontWeight: 600, cursor: 'pointer',
                                                background: on ? 'rgba(17,129,155,0.15)' : 'var(--bg-elevated)',
                                                color: on ? 'var(--accent-primary)' : 'var(--text-muted)',
                                                border: `1px solid ${on ? 'var(--accent-primary)' : 'var(--border-color)'}`,
                                            }}>
                                            {on ? <><Check size={12} aria-hidden="true" style={{ verticalAlign: '-1px' }} /> </> : ''}{lbl}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    </div>
                </details>
            )}

            {err && <div style={{ marginTop: 12, fontSize: '0.8125rem', color: '#ef4444' }}>{err}</div>}

            {/* Footer: per-card Save + Delete */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 16, borderTop: '1px solid var(--border-color)', paddingTop: 14 }}>
                <button className="btn btn-primary btn-sm" onClick={save} disabled={saving || !dirty} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Save size={14} /> {saving ? 'Salvando…' : dirty ? 'Salvar' : 'Salvo'}
                </button>
                <div style={{ marginLeft: 'auto' }}>
                    {confirmDel ? (
                        <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Remover?</span>
                            <button className="btn btn-sm" style={{ color: '#ef4444' }} onClick={() => { setConfirmDel(false); onDeleted(draft); }}>Sim</button>
                            <button className="btn btn-ghost btn-sm" onClick={() => setConfirmDel(false)}>Não</button>
                        </span>
                    ) : (
                        <button className="btn btn-ghost btn-sm" style={{ color: 'var(--text-muted)' }} onClick={() => setConfirmDel(true)}>
                            <Trash2 size={14} /> Remover
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}

/**
 * Admin CRUD for services (two families via `monthly`). Each card has its OWN Save button
 * (no floating bar) — saving one service is a single-item upsert via pricingApi.updateAddons.
 * Changes reflect automatically on the landing carousel and the contract wizards/modals.
 */
export default function SettingsServicesSection() {
    const [addons, setAddons] = useState<EditableAddon[]>([]);
    const [loading, setLoading] = useState(true);
    const [success, setSuccess] = useState('');
    const [error, setError] = useState('');

    useEffect(() => { loadAddons(); }, []);

    const loadAddons = async () => {
        setLoading(true);
        try {
            const res = await pricingApi.getAddonsAll();
            setAddons(res.addons);
        } catch (err) {
            console.error(err);
            setError('Não foi possível carregar os serviços.');
        } finally { setLoading(false); }
    };

    const showMsg = (msg: string) => { setSuccess(msg); setError(''); setTimeout(() => setSuccess(''), 4000); };

    const handleAdd = () => {
        const tempKey = `NOVO_${Date.now().toString().slice(-4)}`;
        setAddons(prev => [{
            key: tempKey, name: 'Novo serviço', price: 0, description: '', monthly: true,
            active: true, sortOrder: (prev.reduce((m, a) => Math.max(m, a.sortOrder ?? 0), 0) + 1),
            icon: 'Sparkles', showOnLanding: true, benefits: '', durationsOffered: '3,6',
            plansAllowed: 'MONTHLY,FULL', billingCadence: 'CALENDAR_MONTH', _isNew: true,
        }, ...prev]);
    };

    const handleSaved = (prevKey: string, saved: AddOnConfig) => {
        setAddons(prev => prev.map(a => a.key === prevKey ? { ...saved } : a));
        showMsg('✅ Serviço salvo com sucesso!');
    };

    const handleDelete = async (addon: EditableAddon) => {
        if (addon._isNew) { setAddons(prev => prev.filter(a => a.key !== addon.key)); return; }
        try {
            const res = await pricingApi.removeAddon(addon.key);
            showMsg(res.softDeleted ? '⚠️ ' + res.message : '🗑️ ' + res.message);
            loadAddons();
        } catch (err) { setError(getErrorMessage(err)); }
    };

    if (loading) return <LoadingSpinner />;

    const allKeys = addons.map(a => a.key);
    const perEpisode = addons.filter(a => !a.monthly);
    const monthly = addons.filter(a => a.monthly);

    const renderGroup = (title: string, desc: string, Icon: LucideIcon, group: EditableAddon[]) => (
        <div style={{ marginBottom: 32 }}>
            <div style={{ marginBottom: 16, paddingBottom: 12, borderBottom: '1px solid var(--border-color)' }}>
                <h2 style={{ fontSize: '1.1rem', fontWeight: 800, display: 'flex', alignItems: 'center', gap: 8 }}><Icon size={18} aria-hidden="true" /> {title}</h2>
                <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>{desc}</p>
            </div>
            {group.length === 0 ? (
                <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>Nenhum serviço nesta família.</p>
            ) : (
                <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 360px), 1fr))' }}>
                    {group.map(a => (
                        <AddonCard key={a.key} initial={a} siblingKeys={allKeys.filter(k => k !== a.key)}
                            onSaved={handleSaved} onDeleted={handleDelete} />
                    ))}
                </div>
            )}
        </div>
    );

    return (
        <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20, gap: 12, flexWrap: 'wrap' }}>
                <div>
                    <h2 style={{ fontSize: '1.125rem', fontWeight: 800, marginBottom: 2 }}>Serviços</h2>
                    <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>Adicionais por episódio e serviços mensais. Cada card tem seu próprio botão Salvar. Reflete na landing e nos modais.</p>
                </div>
                <button className="btn btn-primary btn-sm" onClick={handleAdd}><Plus size={15} /> Adicionar serviço</button>
            </div>

            <SettingsMessages error={error} success={success} />

            {renderGroup('Serviços Mensais', 'Assinaturas contratáveis pelo cliente (ex.: Gestão de Redes Sociais).', CalendarDays, monthly)}
            {renderGroup('Serviços por Episódio', 'Adicionais que acompanham cada gravação.', Mic, perEpisode)}
        </div>
    );
}

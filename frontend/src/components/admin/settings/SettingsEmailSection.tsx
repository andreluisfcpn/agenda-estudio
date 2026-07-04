import { getErrorMessage } from '../../../utils/errors';
import { useState, useEffect, useMemo, type CSSProperties } from 'react';
import { pricingApi } from '../../../api/client';
import LoadingSpinner from '../../ui/LoadingSpinner';
import SettingsSaveBar, { SettingsMessages } from './SettingsSaveBar';
import ToggleField from '../../ui/fields/ToggleField';
import { Mail, Send, Eye, EyeOff, FileText, Lock } from 'lucide-react';

// All editable keys in the `email` config group.
const EMAIL_KEYS = [
    'email_provider', 'email_from_name', 'email_from_address',
    'email_smtp_host', 'email_smtp_port', 'email_smtp_user', 'email_smtp_password', 'email_smtp_secure',
    'email_resend_api_key', 'login_email_subject', 'login_email_html',
] as const;
const SECRET_KEYS = new Set(['email_smtp_password', 'email_resend_api_key']);

type Vals = Record<string, string>;

export default function SettingsEmailSection() {
    const [vals, setVals] = useState<Vals>({});
    const [initial, setInitial] = useState<Vals>({});
    const [studioName, setStudioName] = useState('Estúdio Búzios Digital');
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [success, setSuccess] = useState('');
    const [error, setError] = useState('');
    const [showPreview, setShowPreview] = useState(false);
    const [showSecret, setShowSecret] = useState(false);

    const [testTo, setTestTo] = useState('');
    const [testing, setTesting] = useState(false);
    const [testMsg, setTestMsg] = useState('');

    useEffect(() => { load(); }, []);

    const load = async () => {
        setLoading(true);
        try {
            const res = await pricingApi.getBusinessConfig();
            const map: Vals = {};
            for (const c of res.configs) if (c.group === 'email') map[c.key] = c.value;
            for (const k of EMAIL_KEYS) if (map[k] === undefined) map[k] = '';
            setVals(map);
            setInitial(map);
            // {{studio_name}} no template é resolvido pela config 'studio_name' (grupo studio), não pelo remetente.
            setStudioName(res.configs.find(c => c.key === 'studio_name')?.value || 'Estúdio Búzios Digital');
        } catch (err) {
            setError(getErrorMessage(err) || 'Não foi possível carregar as configurações de e-mail.');
        } finally {
            setLoading(false);
        }
    };

    const set = (key: string, value: string) => {
        setVals(prev => ({ ...prev, [key]: value }));
        setSuccess('');
    };

    const dirty = EMAIL_KEYS.some(k => (vals[k] ?? '') !== (initial[k] ?? ''));

    const handleSave = async () => {
        setSaving(true); setError('');
        try {
            const payload = EMAIL_KEYS
                .filter(k => (vals[k] ?? '') !== (initial[k] ?? ''))
                // Don't send empties (the PUT schema requires non-empty) nor unchanged masked secrets.
                .filter(k => (vals[k] ?? '') !== '' && !(SECRET_KEYS.has(k) && vals[k].includes('•')))
                .map(k => ({ key: k, value: vals[k] }));
            if (payload.length > 0) {
                await pricingApi.updateBusinessConfig(payload);
            }
            setSuccess('✅ Configurações de e-mail salvas!');
            setTimeout(() => setSuccess(''), 4000);
            await load();
        } catch (err: unknown) {
            setError(getErrorMessage(err) || 'Erro ao salvar.');
        } finally {
            setSaving(false);
        }
    };

    const handleTest = async () => {
        if (!testTo) { setTestMsg('Informe um e-mail de destino.'); return; }
        setTesting(true); setTestMsg('');
        try {
            const res = await pricingApi.testEmail(testTo);
            setTestMsg(res.success ? `✅ ${res.message || 'E-mail de teste enviado.'}` : `❌ ${res.error || 'Falha no envio.'}`);
        } catch (err: unknown) {
            setTestMsg(`❌ ${getErrorMessage(err) || 'Falha no envio.'}`);
        } finally {
            setTesting(false);
        }
    };

    const preview = useMemo(() => {
        return (vals.login_email_html || '')
            .replace(/\{\{\s*code\s*\}\}/g, '123456')
            .replace(/\{\{\s*name\s*\}\}/g, 'Maria')
            .replace(/\{\{\s*studio_name\s*\}\}/g, studioName);
    }, [vals.login_email_html, studioName]);

    if (loading) return <LoadingSpinner />;

    const provider = (vals.email_provider || 'smtp').toLowerCase();
    const cardStyle: CSSProperties = { padding: 24, borderRadius: 16, background: 'var(--bg-secondary)', border: '1px solid var(--border-color)' };

    return (
        <div>
            <div style={{ marginBottom: 20 }}>
                <h2 style={{ fontSize: '1.125rem', fontWeight: 800, marginBottom: 2 }}>E-mail & Login por código</h2>
                <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
                    Provedor de envio e o template do e-mail com o código de acesso (login por código).
                </p>
            </div>

            <SettingsMessages error={error} success={success} />

            <div style={{ display: 'grid', gap: 20 }}>
                {/* ── Provedor ── */}
                <div style={cardStyle}>
                    <h3 style={{ fontSize: '0.9375rem', fontWeight: 700, marginBottom: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
                        <Mail size={17} /> Provedor de envio
                    </h3>
                    <div className="sf-config-grid">
                        <div className="sf-config-cell">
                            <label className="sf-config-label">Provedor</label>
                            <select className="form-select" value={provider} onChange={e => set('email_provider', e.target.value)}>
                                <option value="smtp">SMTP (servidor próprio)</option>
                                <option value="resend">Resend (API)</option>
                            </select>
                        </div>
                        <div className="sf-config-cell">
                            <label className="sf-config-label">Remetente — Nome</label>
                            <input className="form-input" value={vals.email_from_name || ''} onChange={e => set('email_from_name', e.target.value)} placeholder="Estúdio Búzios Digital" />
                        </div>
                        <div className="sf-config-cell">
                            <label className="sf-config-label">Remetente — E-mail</label>
                            <input className="form-input" type="email" value={vals.email_from_address || ''} onChange={e => set('email_from_address', e.target.value)} placeholder="contato@buzios.digital" />
                        </div>
                    </div>

                    {provider === 'smtp' ? (
                        <div className="sf-config-grid" style={{ marginTop: 12 }}>
                            <div className="sf-config-cell">
                                <label className="sf-config-label">SMTP — Host</label>
                                <input className="form-input" value={vals.email_smtp_host || ''} onChange={e => set('email_smtp_host', e.target.value)} placeholder="smtp.seudominio.com" />
                            </div>
                            <div className="sf-config-cell">
                                <label className="sf-config-label">SMTP — Porta</label>
                                <input className="form-input" type="number" inputMode="numeric" value={vals.email_smtp_port || ''} onChange={e => set('email_smtp_port', e.target.value)} placeholder="587" />
                            </div>
                            <div className="sf-config-cell">
                                <label className="sf-config-label">SMTP — Usuário</label>
                                <input className="form-input" value={vals.email_smtp_user || ''} onChange={e => set('email_smtp_user', e.target.value)} placeholder="usuario@seudominio.com" autoComplete="off" />
                            </div>
                            <div className="sf-config-cell">
                                <label className="sf-config-label">SMTP — Senha</label>
                                <div style={{ position: 'relative' }}>
                                    <input
                                        className="form-input"
                                        type={showSecret ? 'text' : 'password'}
                                        value={vals.email_smtp_password || ''}
                                        onChange={e => set('email_smtp_password', e.target.value)}
                                        placeholder={initial.email_smtp_password ? 'Mantém a atual (•••)' : 'Senha do SMTP'}
                                        autoComplete="new-password"
                                        style={{ paddingRight: 38 }}
                                    />
                                    <button type="button" onClick={() => setShowSecret(s => !s)} aria-label={showSecret ? 'Ocultar' : 'Mostrar'}
                                        style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}>
                                        {showSecret ? <EyeOff size={16} /> : <Eye size={16} />}
                                    </button>
                                </div>
                            </div>
                            <div className="sf-config-cell">
                                <label className="sf-config-label">Conexão segura (SSL/TLS)</label>
                                <ToggleField checked={vals.email_smtp_secure === 'true'} onChange={v => set('email_smtp_secure', String(v))} aria-label="Conexão segura SMTP" />
                            </div>
                        </div>
                    ) : (
                        <div className="sf-config-grid" style={{ marginTop: 12 }}>
                            <div className="sf-config-cell sf-config-cell--full">
                                <label className="sf-config-label">Resend — API Key</label>
                                <div style={{ position: 'relative' }}>
                                    <input
                                        className="form-input"
                                        type={showSecret ? 'text' : 'password'}
                                        value={vals.email_resend_api_key || ''}
                                        onChange={e => set('email_resend_api_key', e.target.value)}
                                        placeholder={initial.email_resend_api_key ? 'Mantém a atual (•••)' : 're_xxxxxxxx'}
                                        autoComplete="new-password"
                                        style={{ paddingRight: 38 }}
                                    />
                                    <button type="button" onClick={() => setShowSecret(s => !s)} aria-label={showSecret ? 'Ocultar' : 'Mostrar'}
                                        style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}>
                                        {showSecret ? <EyeOff size={16} /> : <Eye size={16} />}
                                    </button>
                                </div>
                                <p style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 6 }}>
                                    Requer um domínio verificado no Resend e o remetente usando esse domínio.
                                </p>
                            </div>
                        </div>
                    )}
                </div>

                {/* ── Template do e-mail ── */}
                <div style={cardStyle}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, gap: 8, flexWrap: 'wrap' }}>
                        <h3 style={{ fontSize: '0.9375rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8, margin: 0 }}>
                            <FileText size={16} aria-hidden="true" /> Template do código
                        </h3>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowPreview(p => !p)} style={{ gap: 6 }}>
                            <Eye size={14} /> {showPreview ? 'Ocultar prévia' : 'Pré-visualizar'}
                        </button>
                    </div>

                    <div className="sf-config-cell sf-config-cell--full" style={{ marginBottom: 12 }}>
                        <label className="sf-config-label">Assunto</label>
                        <input className="form-input" value={vals.login_email_subject || ''} onChange={e => set('login_email_subject', e.target.value)} placeholder="Seu código de acesso — {{studio_name}}" />
                    </div>

                    <div className="sf-config-cell sf-config-cell--full">
                        <label className="sf-config-label">Corpo (HTML)</label>
                        <textarea
                            className="form-input"
                            value={vals.login_email_html || ''}
                            onChange={e => set('login_email_html', e.target.value)}
                            rows={12}
                            spellCheck={false}
                            style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '0.78rem', lineHeight: 1.5, resize: 'vertical' }}
                        />
                        <p style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 6 }}>
                            Variáveis disponíveis: <code>{'{{code}}'}</code>, <code>{'{{name}}'}</code>, <code>{'{{studio_name}}'}</code>.
                        </p>
                    </div>

                    {showPreview && (
                        <div style={{ marginTop: 12 }}>
                            <label className="sf-config-label">Prévia (código de exemplo 123456)</label>
                            <iframe title="Pré-visualização do e-mail" srcDoc={preview} sandbox=""
                                style={{ width: '100%', height: 400, border: '1px solid var(--border-color)', borderRadius: 12, background: '#fff' }} />
                        </div>
                    )}
                </div>

                {/* ── Teste de envio ── */}
                <div style={cardStyle}>
                    <h3 style={{ fontSize: '0.9375rem', fontWeight: 700, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
                        <Send size={16} /> Enviar e-mail de teste
                    </h3>
                    <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 12 }}>
                        Salve as configurações antes de testar. Enviaremos o template com o código <strong>123456</strong>.
                    </p>
                    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                        <input className="form-input" type="email" value={testTo} onChange={e => setTestTo(e.target.value)} placeholder="destino@exemplo.com" style={{ flex: 1, minWidth: 220 }} />
                        <button type="button" className="btn btn-secondary" onClick={handleTest} disabled={testing} style={{ gap: 6 }}>
                            <Send size={15} /> {testing ? 'Enviando…' : 'Enviar teste'}
                        </button>
                    </div>
                    {testMsg && <div style={{ marginTop: 10, fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>{testMsg}</div>}
                </div>

                {/* Info */}
                <div style={{
                    padding: '14px 18px', borderRadius: 12, fontSize: '0.8125rem',
                    background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.15)',
                    color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 8,
                }}>
                    <Lock size={16} aria-hidden="true" style={{ flexShrink: 0 }} />
                    As senhas/chaves são guardadas criptografadas e nunca aparecem por completo aqui nem na configuração pública.
                </div>
            </div>

            {dirty && <SettingsSaveBar saving={saving} onSave={handleSave} onDiscard={load} />}
        </div>
    );
}

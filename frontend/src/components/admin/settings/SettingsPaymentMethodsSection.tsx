import { getErrorMessage } from '../../../utils/errors';
import { useState, useEffect, useId, useRef } from 'react';
import { pricingApi, ApiError, PaymentMethodConfigItem, type BoletoStatus } from '../../../api/client';
import { loadPaymentMethods, setBoletoStatus as setCachedBoletoStatus } from '../../../constants/paymentMethods';
import LoadingSpinner from '../../ui/LoadingSpinner';
import ToggleSwitch from '../../ui/ToggleSwitch';
import DangerConfirmDialog from '../../ui/DangerConfirmDialog';
import SettingsSaveBar, { SettingsMessages } from './SettingsSaveBar';
import SegmentedControl from '../../ui/fields/SegmentedControl';
import ColorField from '../../ui/fields/ColorField';
import EmojiField from '../../ui/fields/EmojiField';
import StepperField from '../../ui/fields/StepperField';
import { CreditCard, Check, FileText, AlertTriangle, Lock } from 'lucide-react';

/** Estado do boleto devolvido junto de um 400 BOLETO_PROVIDER_DISABLED (ApiError.body.boleto). */
function boletoFromError(err: unknown): BoletoStatus | null {
    if (!(err instanceof ApiError) || err.code !== 'BOLETO_PROVIDER_DISABLED') return null;
    const b = err.body?.boleto as Partial<BoletoStatus> | undefined;
    return b && typeof b.enabled === 'boolean' && typeof b.providerEnabled === 'boolean' ? b as BoletoStatus : null;
}

/**
 * Self-contained payment-methods editor. Reuses the payment-method cards from
 * AdminPricingPage's "payments" tab verbatim, and on save updates the global
 * payment-methods cache so the rest of the app reflects changes immediately.
 *
 * E3 — chave-mestra "Aceitar pagamento por boleto" (topo): salva NA HORA (PUT /pricing/payment-methods/boleto),
 * fica bloqueada com o aviso `boleto.message` enquanto a integração Cora não estiver ativa, e é a fonte
 * única de "o boleto aparece?" em todo o sistema. O card "Boleto" da lista só edita nome/emoji/contextos.
 */
export default function SettingsPaymentMethodsSection() {
    const uid = useId();
    const [paymentMethods, setPaymentMethods] = useState<PaymentMethodConfigItem[]>([]);
    const [pmEdited, setPmEdited] = useState(false);
    // E3 — chave-mestra do boleto (estado vindo da API: chave + Cora).
    const [boleto, setBoleto] = useState<BoletoStatus | null>(null);
    const [boletoSaving, setBoletoSaving] = useState(false);
    const [confirmBoletoOff, setConfirmBoletoOff] = useState(false);
    const boletoInFlightRef = useRef(false); // trava por requisição em voo (nunca por tempo)

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
            setBoleto(res.boleto ?? null);
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

    /** Aplica o estado do boleto vindo da API: tela + cache global (o resto do app reflete na hora). */
    const applyBoleto = (next: BoletoStatus) => {
        setBoleto(next);
        // O card "Boleto" da lista espelha a chave (sem marcar a lista como editada).
        setPaymentMethods(prev => prev.map(pm => (pm.key === 'BOLETO' ? { ...pm, active: next.enabled } : pm)));
        setCachedBoletoStatus(next);
        // O endpoint público é a verdade do que está de fato disponível (ativo + provedor).
        void loadPaymentMethods();
    };

    const handleSavePaymentMethods = async () => {
        setSaving(true); setError('');
        try {
            const res = await pricingApi.updatePaymentMethods(paymentMethods);
            showMsg('✅ Métodos de pagamento atualizados!');
            setPmEdited(false);
            if (res.boleto) setBoleto(res.boleto);
            // Update the global cache so all components reflect changes immediately — pelo endpoint
            // público, que já respeita o provedor de cada método (e a chave-mestra do boleto).
            if (res.boleto) setCachedBoletoStatus(res.boleto);
            void loadPaymentMethods();
        } catch (err: unknown) {
            const current = boletoFromError(err);
            if (current) applyBoleto(current);
            setError(getErrorMessage(err));
        }
        finally { setSaving(false); }
    };

    /** Liga/desliga a chave-mestra do boleto — salva na hora. Lança em caso de erro (o diálogo mostra). */
    const saveBoleto = async (enabled: boolean) => {
        if (boletoInFlightRef.current) return;
        boletoInFlightRef.current = true;
        setBoletoSaving(true); setError(''); setSuccess('');
        try {
            const res = await pricingApi.setBoletoEnabled(enabled);
            applyBoleto(res.boleto);
            showMsg(res.message || (enabled ? 'Pagamento por boleto ativado.' : 'Pagamento por boleto desativado.'));
        } catch (err: unknown) {
            // Ligar sem a Cora ativa → 400 BOLETO_PROVIDER_DISABLED (traz o estado atual).
            const current = boletoFromError(err);
            if (current) applyBoleto(current);
            throw err;
        } finally {
            boletoInFlightRef.current = false;
            setBoletoSaving(false);
        }
    };

    const handleBoletoToggle = (next: boolean) => {
        if (!boleto || boletoSaving || boletoInFlightRef.current) return;
        if (next === boleto.enabled) return;
        if (!next) { setConfirmBoletoOff(true); return; } // desligar tem impacto → confirma antes
        if (!boleto.providerEnabled) return; // bloqueado: a Cora não está ativa
        saveBoleto(true).catch((err: unknown) => setError(getErrorMessage(err)));
    };

    // Bloqueado enquanto a Cora não estiver ativa. Exceção: se a chave ficou ligada e a Cora foi
    // desativada depois, ainda dá para DESLIGAR (o backend sempre aceita desligar).
    const boletoLocked = !!boleto && !boleto.providerEnabled && !boleto.enabled;
    const boletoTone = !boleto ? 'off' : boleto.available ? 'on' : !boleto.providerEnabled ? 'blocked' : 'off';

    if (loading) return <LoadingSpinner />;

    return (
        <div>
            <div style={{ marginBottom: '20px' }}>
                <h2 style={{ fontSize: '1.125rem', fontWeight: 800, marginBottom: '2px' }}>Métodos de Pagamento</h2>
                <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>Métodos disponíveis em wizards e modais de todo o sistema.</p>
            </div>

            <SettingsMessages error={error} success={success} />

            {/* E3 — chave-mestra do boleto: salva na hora; bloqueada enquanto a Cora não está ativa. */}
            {boleto && (
                <section
                    aria-labelledby={`${uid}-boleto-title`}
                    style={{
                        padding: '18px 20px', borderRadius: '16px', marginBottom: '20px',
                        background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
                        // Mesmo acento dos cards de método logo abaixo (faixa superior de 3px).
                        borderTop: `3px solid ${boletoTone === 'on' ? 'var(--success)' : boletoTone === 'blocked' ? 'var(--warning)' : 'var(--border-color)'}`,
                    }}
                >
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '14px', flexWrap: 'wrap' }}>
                        <div aria-hidden="true" style={{
                            width: 44, height: 44, borderRadius: '12px', flexShrink: 0,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            background: boletoTone === 'on' ? 'var(--success-bg)' : 'var(--bg-elevated)',
                            color: boletoTone === 'on' ? 'var(--success)' : 'var(--text-muted)',
                            border: '1px solid var(--border-color)',
                        }}>
                            <FileText size={20} />
                        </div>
                        <div style={{ flex: '1 1 200px', minWidth: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                                <h3 id={`${uid}-boleto-title`} style={{ fontSize: '0.9375rem', fontWeight: 800, margin: 0 }}>
                                    Aceitar pagamento por boleto
                                </h3>
                                <span role="status" style={{
                                    display: 'inline-flex', alignItems: 'center', gap: '4px',
                                    fontSize: '0.6875rem', fontWeight: 700, padding: '2px 8px', borderRadius: '999px',
                                    background: boletoTone === 'on' ? 'var(--success-bg)' : boletoTone === 'blocked' ? 'var(--warning-bg)' : 'var(--bg-elevated)',
                                    color: boletoTone === 'on' ? 'var(--success)' : boletoTone === 'blocked' ? 'var(--warning)' : 'var(--text-muted)',
                                }}>
                                    {boletoTone === 'blocked' && <Lock size={11} aria-hidden="true" />}
                                    {boletoSaving ? 'Salvando…' : boletoTone === 'on' ? 'Ligado' : boletoTone === 'blocked' ? (boleto.enabled ? 'Indisponível' : 'Bloqueado') : 'Desligado'}
                                </span>
                            </div>
                            <p style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)', lineHeight: 1.5, margin: '6px 0 0' }}>
                                Ligado, o Boleto aparece como 3ª opção (junto de PIX e Cartão) nas cobranças feitas pelo admin e nas
                                faturas e parcelas de contratos já ativos. Desligado, não aparece em lugar nenhum. Nunca entra nas
                                contratações com reserva de 10 minutos, porque o boleto compensa em até 3 dias úteis.
                            </p>
                        </div>
                        <div style={{ flexShrink: 0, alignSelf: 'center' }}>
                            <ToggleSwitch
                                id={`${uid}-boleto-switch`}
                                checked={boleto.enabled}
                                disabled={boletoLocked || boletoSaving}
                                onChange={handleBoletoToggle}
                                label="Aceitar boleto"
                            />
                        </div>
                    </div>
                    {!boleto.providerEnabled && (
                        <div role="note" style={{
                            display: 'flex', alignItems: 'flex-start', gap: '8px', marginTop: '14px',
                            padding: '10px 12px', borderRadius: '10px', fontSize: '0.8125rem', lineHeight: 1.45,
                            background: 'var(--warning-bg)', color: 'var(--text-primary)',
                            border: '1px solid color-mix(in srgb, var(--warning) 35%, transparent)',
                        }}>
                            <AlertTriangle size={15} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2, color: 'var(--warning)' }} />
                            <span>{boleto.message || 'A integração Cora não está ativa. Ative a Cora em Integrações para aceitar pagamento por boleto.'}</span>
                        </div>
                    )}
                </section>
            )}

            {/* Info banner */}
            <div style={{
                padding: '14px 18px', borderRadius: '12px', fontSize: '0.8125rem', marginBottom: '20px',
                background: 'rgba(45,212,191,0.06)', border: '1px solid rgba(45,212,191,0.15)',
                color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '8px',
            }}>
                <CreditCard size={16} aria-hidden="true" style={{ flexShrink: 0 }} />
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
                                {/* Só o nome legível: a chave técnica (PIX/CARTAO/BOLETO) não é editável nem útil aqui (E8). */}
                                <div style={{ fontWeight: 700, fontSize: '1.0625rem', minWidth: 0, overflowWrap: 'anywhere' }}>{pm.label}</div>
                            </div>

                            {/* Active Toggle — o do BOLETO é a chave-mestra do topo (salva na hora, exige a Cora). */}
                            {pm.key === 'BOLETO' ? (
                                <span style={{ fontSize: '0.6875rem', fontWeight: 600, color: 'var(--text-muted)', textAlign: 'right', maxWidth: 150 }}>
                                    {pm.active ? 'Ligado' : 'Desligado'} · use a chave “Aceitar pagamento por boleto” acima
                                </span>
                            ) : (
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
                            )}
                        </div>

                        {/* Fields */}
                        <div className="admin-grid-2" style={{ gap: '12px' }}>
                            <div className="form-group" style={{ marginBottom: 0 }}>
                                <label className="form-label" htmlFor={`${uid}-${pm.key}-fullname`}>Nome Completo</label>
                                <input id={`${uid}-${pm.key}-fullname`} className="form-input" value={pm.label}
                                    onChange={e => handlePmChange(pm.key, 'label', e.target.value)} />
                            </div>
                            <div className="form-group" style={{ marginBottom: 0 }}>
                                <label className="form-label" htmlFor={`${uid}-${pm.key}-shortname`}>Nome Curto</label>
                                <input id={`${uid}-${pm.key}-shortname`} className="form-input" value={pm.shortLabel}
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
                                <label className="form-label" htmlFor={`${uid}-${pm.key}-description`}>Descrição</label>
                                <input id={`${uid}-${pm.key}-description`} className="form-input" value={pm.description}
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
                                            {on ? <><Check size={12} aria-hidden="true" style={{ verticalAlign: '-1px' }} /> </> : ''}{lbl}
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

            {/* Desligar o boleto: reversível, mas com impacto → confirmação em tom de aviso (design-system §3a). */}
            <DangerConfirmDialog
                isOpen={confirmBoletoOff}
                tone="warning"
                icon={FileText}
                title="Desligar o pagamento por boleto?"
                description="A opção Boleto deixa de aparecer em todo o sistema, para o admin e para os clientes."
                consequences={[
                    'Nenhum boleto novo é emitido — o sistema recusa qualquer tentativa.',
                    'Boletos já emitidos continuam válidos no banco e são conciliados enquanto a integração Cora estiver ativa.',
                    'Cobranças pendentes seguem pagáveis por PIX ou cartão.',
                ]}
                confirmLabel="Desligar boleto"
                loadingLabel="Desligando…"
                onConfirm={() => saveBoleto(false)}
                onClose={() => setConfirmBoletoOff(false)}
            />
        </div>
    );
}

import React, { useState, useEffect, useCallback } from 'react';
import { integrationsApi } from '../api/client';
import { getErrorMessage } from '../utils/errors';
import {
  Icons, StatusBadge, Toggle, TestInfo, WebhookUrlBox,
  FileUploadZone, EnvSelector, envConfigured,
  type IntegrationSummary,
} from './IntegrationHelpers';
import '../styles/integration-settings.css';

const emptyCoraCreds = { clientId: '', certificatePem: '', privateKeyPem: '', pixKey: '' };
const emptyStripeCreds = { secretKey: '', publishableKey: '', webhookSecret: '' };

export default function IntegrationSettings() {
  const [integrations, setIntegrations] = useState<IntegrationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [testingProvider, setTestingProvider] = useState<string | null>(null);

  // Accordion state — multiple cards can be open simultaneously on desktop
  const [openCards, setOpenCards] = useState<Set<string>>(new Set(['CORA']));

  // Cora form
  const [coraForm, setCoraForm] = useState({
    sandbox: { ...emptyCoraCreds }, production: { ...emptyCoraCreds }, environment: 'sandbox',
  });

  // Stripe form
  const [stripeForm, setStripeForm] = useState({
    sandbox: { ...emptyStripeCreds }, production: { ...emptyStripeCreds }, environment: 'sandbox',
  });

  // Aba de EDIÇÃO de credenciais — desacoplada do ambiente ATIVO (form.environment).
  // Alternar a aba NÃO muda qual ambiente o checkout usa; só o Salvar aplica o environment.
  const [coraEditEnv, setCoraEditEnv] = useState<'sandbox' | 'production'>('sandbox');
  const [stripeEditEnv, setStripeEditEnv] = useState<'sandbox' | 'production'>('sandbox');

  // Cora webhooks
  const [coraWebhooks, setCoraWebhooks] = useState<{ id: string; url: string; events?: string[] }[]>([]);
  const [loadingWebhooks, setLoadingWebhooks] = useState(false);
  const [registeringWebhook, setRegisteringWebhook] = useState(false);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const res = await integrationsApi.list();
      setIntegrations(res.integrations);

      // Valores MASCARADOS pelo backend ('abc...def', '***CONFIGURED***') não entram
      // no form: campo vazio = "manter o valor atual" (o merge do PUT preserva) e o
      // placeholder "Já configurada" comunica isso — antes o mascarado aparecia editável.
      const unmask = (v?: string) => (!v || v.includes('...') || v.includes('***') ? '' : v);

      const cora = res.integrations.find((i: IntegrationSummary) => i.provider === 'CORA');
      if (cora?.configured) {
        const cfg = cora.config || {};
        const parseCreds = (c: any) => ({
          clientId: unmask(c?.clientId),
          certificatePem: unmask(c?.certificatePem),
          privateKeyPem: unmask(c?.privateKeyPem),
          pixKey: c?.pixKey || '',
        });
        const hasDual = cfg.sandbox || cfg.production;
        setCoraForm({
          sandbox: hasDual ? parseCreds(cfg.sandbox) : parseCreds(cfg),
          production: hasDual ? parseCreds(cfg.production) : { ...emptyCoraCreds },
          environment: cora.environment || 'sandbox',
        });
        setCoraEditEnv(cora.environment === 'production' ? 'production' : 'sandbox');
      }

      const stripe = res.integrations.find((i: IntegrationSummary) => i.provider === 'STRIPE');
      if (stripe?.configured) {
        const cfg = stripe.config || {};
        const parseCreds = (c: any) => ({
          secretKey: unmask(c?.secretKey), publishableKey: c?.publishableKey || '', webhookSecret: unmask(c?.webhookSecret),
        });
        const hasDual = cfg.sandbox || cfg.production;
        setStripeForm({
          sandbox: hasDual ? parseCreds(cfg.sandbox) : parseCreds(cfg),
          production: hasDual ? parseCreds(cfg.production) : { ...emptyStripeCreds },
          environment: stripe.environment || 'sandbox',
        });
        setStripeEditEnv(stripe.environment === 'production' ? 'production' : 'sandbox');
      }
    } catch (err) { console.error(err); }
    setLoading(false);
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  const showMsg = (msg: string) => { setSuccess(msg); setTimeout(() => setSuccess(''), 4000); };
  const clearMsgs = () => { setError(''); setSuccess(''); };

  const handleSave = async (provider: string) => {
    setSaving(true); clearMsgs();
    try {
      let data;
      if (provider === 'CORA') {
        const buildCreds = (creds: typeof coraForm.sandbox) => {
          const c: Record<string, string> = {};
          if (creds.clientId && !creds.clientId.includes('...')) c.clientId = creds.clientId;
          if (creds.pixKey) c.pixKey = creds.pixKey;
          if (creds.certificatePem) c.certificatePem = creds.certificatePem;
          if (creds.privateKeyPem) c.privateKeyPem = creds.privateKeyPem;
          return c;
        };
        data = { environment: coraForm.environment, config: { sandbox: buildCreds(coraForm.sandbox), production: buildCreds(coraForm.production) } };
      } else {
        const buildCreds = (creds: typeof stripeForm.sandbox) => {
          const c: Record<string, string> = { publishableKey: creds.publishableKey };
          if (creds.secretKey && !creds.secretKey.includes('...')) c.secretKey = creds.secretKey;
          if (creds.webhookSecret && !creds.webhookSecret.includes('...')) c.webhookSecret = creds.webhookSecret;
          return c;
        };
        data = { environment: stripeForm.environment, config: { sandbox: buildCreds(stripeForm.sandbox), production: buildCreds(stripeForm.production) } };
      }
      const res = await integrationsApi.save(provider, data);
      showMsg(res.message);
      const listRes = await integrationsApi.list();
      setIntegrations(listRes.integrations);
    } catch (e: unknown) { setError(getErrorMessage(e) || 'Erro ao salvar'); }
    finally { setSaving(false); }
  };

  const handleTest = async (provider: string) => {
    setTestingProvider(provider); clearMsgs();
    try {
      const res = await integrationsApi.test(provider);
      if (res.success) showMsg(`${provider}: ${res.message}`);
      else setError(`${provider}: ${res.message}`);
      const listRes = await integrationsApi.list();
      setIntegrations(listRes.integrations);
    } catch (e: unknown) { setError(getErrorMessage(e) || 'Erro ao testar'); }
    finally { setTestingProvider(null); }
  };

  const handleToggle = async (provider: string, enabled: boolean) => {
    try {
      await integrationsApi.toggle(provider, enabled);
      const listRes = await integrationsApi.list();
      setIntegrations(listRes.integrations);
      showMsg(`${provider} ${enabled ? 'ativado' : 'desativado'}`);
    } catch (e: unknown) { setError(getErrorMessage(e)); }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    showMsg('URL copiada!');
  };

  const toggleCard = (id: string) => setOpenCards(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const cora = integrations.find(i => i.provider === 'CORA');
  const stripe = integrations.find(i => i.provider === 'STRIPE');

  if (loading) return <div className="loading-spinner"><div className="spinner" /></div>;

  // Cora saved state checks — indexados pela aba de EDIÇÃO (não pelo ambiente ativo)
  const savedCoraCfg = cora?.config || {};
  const coraEditKey = coraEditEnv;
  const savedCoraEnvCfg = (savedCoraCfg as any)?.[coraEditKey] || (coraEditKey === 'sandbox' ? savedCoraCfg : undefined);
  const hasSavedCert = savedCoraEnvCfg?.certificatePem === '***CERTIFICATE_CONFIGURED***';
  const hasSavedKey = savedCoraEnvCfg?.privateKeyPem === '***PRIVATE_KEY_CONFIGURED***';
  const hasSavedCoraClientId = !!savedCoraEnvCfg?.clientId;

  // Stripe saved state checks
  const savedStripeCfg = stripe?.config || {};
  const stripeEditKey = stripeEditEnv;
  const savedStripeEnvCfg = (savedStripeCfg as any)?.[stripeEditKey] || (stripeEditKey === 'sandbox' ? savedStripeCfg : undefined);
  const hasSavedStripeKey = !!savedStripeEnvCfg?.secretKey;
  const hasSavedStripeWebhook = !!savedStripeEnvCfg?.webhookSecret;

  // Ambiente tem credenciais? (salvas OU digitadas no form — evita aviso falso enquanto cola)
  const coraEnvOk = (env: 'sandbox' | 'production') =>
    envConfigured('CORA', savedCoraCfg, env) ||
    !!(coraForm[env].clientId && coraForm[env].certificatePem && coraForm[env].privateKeyPem);
  const stripeEnvOk = (env: 'sandbox' | 'production') =>
    envConfigured('STRIPE', savedStripeCfg, env) ||
    !!(stripeForm[env].secretKey && stripeForm[env].publishableKey);

  // Webhook helpers
  const webhookUrl = window.location.hostname === 'localhost'
    ? 'http://localhost:3001/api/webhooks/cora'
    : `https://${window.location.hostname}/api/webhooks/cora`;

  const loadWebhooks = async () => {
    setLoadingWebhooks(true);
    try { const res = await integrationsApi.listCoraWebhooks(); setCoraWebhooks(res.endpoints || []); }
    catch { setCoraWebhooks([]); }
    finally { setLoadingWebhooks(false); }
  };

  const registerWebhook = async () => {
    setRegisteringWebhook(true);
    try {
      await integrationsApi.registerCoraWebhook(webhookUrl);
      showMsg('Webhook registrado na Cora!');
      await loadWebhooks();
    } catch (e: unknown) { setError(getErrorMessage(e) || 'Erro ao registrar webhook'); }
    finally { setRegisteringWebhook(false); }
  };

  const deleteWebhook = async (id: string) => {
    try { await integrationsApi.deleteCoraWebhook(id); showMsg('Webhook removido.'); await loadWebhooks(); }
    catch (e: unknown) { setError(getErrorMessage(e) || 'Erro ao remover webhook'); }
  };

  const isWebhookRegistered = coraWebhooks.some(w => w.url === webhookUrl);

  const coraCreds = coraForm[coraEditKey];
  const stripeCreds = stripeForm[stripeEditKey];

  return (
    <div className="int-settings">
      {/* Banner */}
      <div className="int-banner">
        <Icons.Info size={18} />
        <div>
          Configure as credenciais dos provedores de pagamento. O <strong>Stripe</strong> é usado para cartão de crédito/débito.
          O <strong>Cora</strong> é usado para PIX e Boleto Bancário (requer certificado mTLS).
          <div className="int-banner-sub">
            <Icons.Shield size={13} /> Campos sensíveis são mascarados após salvar. Deixe em branco para manter os valores atuais.
          </div>
        </div>
      </div>

      {/* Messages */}
      {error && <div className="int-msg int-msg--error"><Icons.Info size={16} /> {error}</div>}
      {success && <div className="int-msg int-msg--success"><Icons.Check size={16} /> {success}</div>}

      {/* Cards Grid */}
      <div className="int-cards-grid">
        {/* ═══ CORA CARD ═══ */}
        <div className={`int-card int-card--cora ${cora?.enabled ? 'int-card--enabled' : ''}`}>
          <div className="int-card-header" onClick={() => toggleCard('CORA')}>
            <div className="int-card-identity">
              <div className="int-card-icon int-card-icon--cora"><Icons.Bank /></div>
              <div>
                <div className="int-card-title">Cora</div>
                <div className="int-card-desc">PIX e Boleto Bancário (mTLS)</div>
              </div>
            </div>
            <div className="int-card-controls" onClick={e => e.stopPropagation()}>
              <StatusBadge provider={cora} />
              <Toggle on={!!cora?.enabled} disabled={!cora?.configured}
                ariaLabel="Ativar ou desativar cobranças via Cora (PIX/Boleto)"
                onChange={() => cora?.configured && handleToggle('CORA', !cora?.enabled)} />
            </div>
            <Icons.ChevronDown className={`int-chevron ${openCards.has('CORA') ? 'int-chevron--open' : ''}`} />
          </div>

          <div className={`int-card-body ${openCards.has('CORA') ? 'int-card-body--open' : ''}`}>
            <div className="int-card-content">
              {cora?.configured && !cora.enabled && (
                <div className="int-off-note">
                  Integração desligada: <strong>PIX e Boleto</strong> não aparecem no checkout. Use o interruptor acima para ativar.
                </div>
              )}

              <EnvSelector
                env={coraForm.environment as 'sandbox' | 'production'}
                onChange={v => { setCoraForm(f => ({ ...f, environment: v })); setCoraEditEnv(v); }}
                labels={{ sandbox: 'Sandbox', production: 'Produção' }}
                sandboxOk={coraEnvOk('sandbox')} productionOk={coraEnvOk('production')}
                pendingSave={!!(cora?.environment && coraForm.environment !== cora.environment)}
              />

              {coraForm.environment === 'production' && !coraEnvOk('production') && (
                <div className="int-warn" role="alert">
                  <Icons.Info size={15} />
                  <div>Produção selecionada, mas as credenciais de produção estão vazias — preencha-as abaixo antes de salvar/ativar, senão o checkout não conseguirá cobrar.</div>
                </div>
              )}

              {/* Client ID + Chave PIX — short fields side-by-side on tablet+ */}
              <div className="int-field-row">
                <div className="int-field">
                  <label className="int-label"><Icons.Key /> Client ID ({coraEditKey})</label>
                  <input className="int-input int-input--cora" type="text"
                    placeholder={hasSavedCoraClientId ? '✅ Já configurado. Deixe em branco para manter.' : `Client ID da Cora para ${coraEditKey === 'sandbox' ? 'homologação' : 'produção'}`}
                    value={coraCreds.clientId}
                    onChange={e => setCoraForm(f => ({ ...f, [coraEditKey]: { ...f[coraEditKey], clientId: e.target.value } }))}
                  />
                </div>
                <div className="int-field">
                  <label className="int-label"><Icons.Globe /> Chave PIX ({coraEditKey})</label>
                  <input className="int-input int-input--cora" type="text" placeholder="email@empresa.com ou CPF/CNPJ"
                    value={coraCreds.pixKey}
                    onChange={e => setCoraForm(f => ({ ...f, [coraEditKey]: { ...f[coraEditKey], pixKey: e.target.value } }))}
                  />
                </div>
              </div>

              {/* Certificate Upload */}
              <FileUploadZone label={`Certificado mTLS (.pem) — ${coraEditKey}`}
                accept=".pem,.crt,.cer" provider="cora" hasSaved={hasSavedCert}
                value={coraCreds.certificatePem}
                onChange={v => setCoraForm(f => ({ ...f, [coraEditKey]: { ...f[coraEditKey], certificatePem: v } }))}
                placeholder="Cole o conteúdo do certificado .pem aqui...&#10;-----BEGIN CERTIFICATE-----&#10;..."
              />

              {/* Private Key Upload */}
              <FileUploadZone label={`Chave Privada (.key) — ${coraEditKey}`}
                accept=".key,.pem" provider="cora" hasSaved={hasSavedKey}
                value={coraCreds.privateKeyPem}
                onChange={v => setCoraForm(f => ({ ...f, [coraEditKey]: { ...f[coraEditKey], privateKeyPem: v } }))}
                placeholder="Cole o conteúdo da chave privada .key aqui...&#10;-----BEGIN PRIVATE KEY-----&#10;..."
              />

              {/* Webhook Manager */}
              <div className="int-webhook">
                <div className="int-webhook-header">
                  <div className="int-webhook-title"><Icons.Bell /> Webhook Cora (API)</div>
                  <button className="int-btn int-btn--verify int-btn--small" onClick={loadWebhooks}
                    disabled={loadingWebhooks || !cora?.configured} type="button">
                    {loadingWebhooks ? <span className="int-spinner" /> : <Icons.RefreshCw />} Verificar
                  </button>
                </div>

                <div className="int-webhook-url">{webhookUrl}</div>

                {coraWebhooks.length > 0 && (
                  <div style={{ marginTop: '10px' }}>
                    <div style={{ fontSize: '0.625rem', color: 'var(--text-muted)', marginBottom: '6px' }}>
                      Endpoints registrados:
                    </div>
                    {coraWebhooks.map(w => (
                      <div key={w.id} className={`int-webhook-endpoint ${w.url === webhookUrl ? 'int-webhook-endpoint--active' : ''}`}>
                        <span className="int-webhook-endpoint-url">
                          {w.url === webhookUrl && <><Icons.Check size={10} /> </>}{w.url}
                        </span>
                        <button className="int-webhook-endpoint-delete" onClick={() => deleteWebhook(w.id)} type="button">
                          <Icons.Trash /> Remover
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {!isWebhookRegistered && (
                  <button className="int-btn int-btn--webhook" onClick={registerWebhook}
                    disabled={registeringWebhook || !cora?.configured} type="button">
                    {registeringWebhook ? <><span className="int-spinner" /> Registrando...</> : <><Icons.Bell /> Registrar Webhook na Cora</>}
                  </button>
                )}

                {isWebhookRegistered && (
                  <div className="int-webhook-success"><Icons.Check size={14} /> Webhook ativo — notificações automáticas</div>
                )}
              </div>

              <TestInfo provider={cora} />

              <div className="int-actions">
                <button className="int-btn int-btn--save int-btn--save-cora" onClick={() => handleSave('CORA')} disabled={saving} type="button">
                  {saving ? <><span className="int-spinner" /> Salvando...</> : <><Icons.Save /> Salvar Cora</>}
                </button>
                <button className="int-btn int-btn--test" onClick={() => handleTest('CORA')}
                  disabled={testingProvider === 'CORA' || !cora?.configured} type="button">
                  {testingProvider === 'CORA' ? <><span className="int-spinner" /> Testando...</> : <><Icons.Zap /> Testar</>}
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* ═══ STRIPE CARD ═══ */}
        <div className={`int-card int-card--stripe ${stripe?.enabled ? 'int-card--enabled' : ''}`}>
          <div className="int-card-header" onClick={() => toggleCard('STRIPE')}>
            <div className="int-card-identity">
              <div className="int-card-icon int-card-icon--stripe"><Icons.CreditCard /></div>
              <div>
                <div className="int-card-title">Stripe</div>
                <div className="int-card-desc">Cartão de Crédito, Débito e PIX</div>
              </div>
            </div>
            <div className="int-card-controls" onClick={e => e.stopPropagation()}>
              <StatusBadge provider={stripe} />
              <Toggle on={!!stripe?.enabled} disabled={!stripe?.configured}
                ariaLabel="Ativar ou desativar cobranças via Stripe (Cartão)"
                onChange={() => stripe?.configured && handleToggle('STRIPE', !stripe?.enabled)} />
            </div>
            <Icons.ChevronDown className={`int-chevron ${openCards.has('STRIPE') ? 'int-chevron--open' : ''}`} />
          </div>

          <div className={`int-card-body ${openCards.has('STRIPE') ? 'int-card-body--open' : ''}`}>
            <div className="int-card-content">
              {stripe?.configured && !stripe.enabled && (
                <div className="int-off-note">
                  Integração desligada: <strong>Cartão</strong> não aparece no checkout. Use o interruptor acima para ativar.
                </div>
              )}

              <EnvSelector
                env={stripeForm.environment as 'sandbox' | 'production'}
                onChange={v => { setStripeForm(f => ({ ...f, environment: v })); setStripeEditEnv(v); }}
                labels={{ sandbox: 'Teste (sk_test)', production: 'Produção (sk_live)' }}
                sandboxOk={stripeEnvOk('sandbox')} productionOk={stripeEnvOk('production')}
                pendingSave={!!(stripe?.environment && stripeForm.environment !== stripe.environment)}
              />

              {stripeForm.environment === 'production' && !stripeEnvOk('production') && (
                <div className="int-warn" role="alert">
                  <Icons.Info size={15} />
                  <div>Produção selecionada, mas as credenciais de produção estão vazias — preencha-as abaixo antes de salvar/ativar, senão o checkout não conseguirá cobrar.</div>
                </div>
              )}

              {/* Secret + Publishable Key — credentials pair side-by-side on tablet+ */}
              <div className="int-field-row">
                <div className="int-field">
                  <label className="int-label"><Icons.Key /> Secret Key ({stripeEditKey})</label>
                  <input className="int-input int-input--stripe" type="password"
                    placeholder={hasSavedStripeKey ? '✅ Já configurada. Deixe em branco para manter.' : stripeEditKey === 'sandbox' ? 'sk_test_xxx' : 'sk_live_xxx'}
                    value={stripeCreds.secretKey}
                    onChange={e => setStripeForm(f => ({ ...f, [stripeEditKey]: { ...f[stripeEditKey], secretKey: e.target.value } }))}
                  />
                </div>
                <div className="int-field">
                  <label className="int-label"><Icons.Globe /> Publishable Key ({stripeEditKey})</label>
                  <input className="int-input int-input--stripe" type="text"
                    placeholder={stripeEditKey === 'sandbox' ? 'pk_test_xxx' : 'pk_live_xxx'}
                    value={stripeCreds.publishableKey}
                    onChange={e => setStripeForm(f => ({ ...f, [stripeEditKey]: { ...f[stripeEditKey], publishableKey: e.target.value } }))}
                  />
                </div>
              </div>

              {/* Webhook Secret */}
              <div className="int-field">
                <label className="int-label"><Icons.Bell /> Webhook Secret ({stripeEditKey})</label>
                <input className="int-input int-input--stripe" type="password"
                  placeholder={hasSavedStripeWebhook ? '✅ Já configurado. Deixe em branco para manter.' : 'whsec_xxx'}
                  value={stripeCreds.webhookSecret}
                  onChange={e => setStripeForm(f => ({ ...f, [stripeEditKey]: { ...f[stripeEditKey], webhookSecret: e.target.value } }))}
                />
              </div>

              <WebhookUrlBox url={stripe?.webhookUrl || null} label="Webhook URL (cole no dashboard Stripe)" onCopy={copyToClipboard} />
              <TestInfo provider={stripe} />

              <div className="int-actions">
                <button className="int-btn int-btn--save int-btn--save-stripe" onClick={() => handleSave('STRIPE')} disabled={saving} type="button">
                  {saving ? <><span className="int-spinner" /> Salvando...</> : <><Icons.Save /> Salvar Stripe</>}
                </button>
                <button className="int-btn int-btn--test" onClick={() => handleTest('STRIPE')}
                  disabled={testingProvider === 'STRIPE' || !stripe?.configured} type="button">
                  {testingProvider === 'STRIPE' ? <><span className="int-spinner" /> Testando...</> : <><Icons.Zap /> Testar</>}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

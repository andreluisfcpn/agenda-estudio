import React, { useState, useEffect, useCallback } from 'react';
import { integrationsApi } from '../api/client';
import { getErrorMessage } from '../utils/errors';
import {
  Icons, StatusBadge, Toggle, TestInfo, WebhookUrlBox,
  FileUploadZone, EnvToggle,
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

  // Cora webhooks
  const [coraWebhooks, setCoraWebhooks] = useState<{ id: string; url: string; events?: string[] }[]>([]);
  const [loadingWebhooks, setLoadingWebhooks] = useState(false);
  const [registeringWebhook, setRegisteringWebhook] = useState(false);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const res = await integrationsApi.list();
      setIntegrations(res.integrations);

      const cora = res.integrations.find((i: IntegrationSummary) => i.provider === 'CORA');
      if (cora?.configured) {
        const cfg = cora.config || {};
        const parseCreds = (c: any) => ({
          clientId: c?.clientId || '',
          certificatePem: c?.certificatePem === '***CERTIFICATE_CONFIGURED***' ? '' : (c?.certificatePem || ''),
          privateKeyPem: c?.privateKeyPem === '***PRIVATE_KEY_CONFIGURED***' ? '' : (c?.privateKeyPem || ''),
          pixKey: c?.pixKey || '',
        });
        const hasDual = cfg.sandbox || cfg.production;
        setCoraForm({
          sandbox: hasDual ? parseCreds(cfg.sandbox) : parseCreds(cfg),
          production: hasDual ? parseCreds(cfg.production) : { ...emptyCoraCreds },
          environment: cora.environment || 'sandbox',
        });
      }

      const stripe = res.integrations.find((i: IntegrationSummary) => i.provider === 'STRIPE');
      if (stripe?.configured) {
        const cfg = stripe.config || {};
        const parseCreds = (c: any) => ({
          secretKey: c?.secretKey || '', publishableKey: c?.publishableKey || '', webhookSecret: c?.webhookSecret || '',
        });
        const hasDual = cfg.sandbox || cfg.production;
        setStripeForm({
          sandbox: hasDual ? parseCreds(cfg.sandbox) : parseCreds(cfg),
          production: hasDual ? parseCreds(cfg.production) : { ...emptyStripeCreds },
          environment: stripe.environment || 'sandbox',
        });
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

  // Cora saved state checks
  const savedCoraCfg = cora?.config || {};
  const coraEnvKey = coraForm.environment as 'sandbox' | 'production';
  const savedCoraEnvCfg = (savedCoraCfg as any)?.[coraEnvKey] || savedCoraCfg;
  const hasSavedCert = savedCoraEnvCfg?.certificatePem === '***CERTIFICATE_CONFIGURED***';
  const hasSavedKey = savedCoraEnvCfg?.privateKeyPem === '***PRIVATE_KEY_CONFIGURED***';

  // Stripe saved state checks
  const savedStripeCfg = stripe?.config || {};
  const stripeEnvKey = stripeForm.environment as 'sandbox' | 'production';
  const savedStripeEnvCfg = (savedStripeCfg as any)?.[stripeEnvKey] || savedStripeCfg;
  const hasSavedStripeKey = savedStripeEnvCfg?.secretKey?.includes?.('...');
  const hasSavedStripeWebhook = savedStripeEnvCfg?.webhookSecret?.includes?.('...');

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

  const coraCreds = coraForm[coraEnvKey];
  const stripeCreds = stripeForm[stripeEnvKey];

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
                onChange={() => cora?.configured && handleToggle('CORA', !cora?.enabled)} />
            </div>
            <Icons.ChevronDown className={`int-chevron ${openCards.has('CORA') ? 'int-chevron--open' : ''}`} />
          </div>

          <div className={`int-card-body ${openCards.has('CORA') ? 'int-card-body--open' : ''}`}>
            <div className="int-card-content">
              <EnvToggle
                env={coraForm.environment as 'sandbox' | 'production'}
                onChange={v => setCoraForm(f => ({ ...f, environment: v }))}
                labels={{ sandbox: 'Sandbox', production: 'Produção' }}
              />

              {/* Client ID */}
              <div className="int-field">
                <label className="int-label"><Icons.Key /> Client ID ({coraEnvKey})</label>
                <input className="int-input int-input--cora" type="text"
                  placeholder={`Client ID da Cora para ${coraEnvKey === 'sandbox' ? 'homologação' : 'produção'}`}
                  value={coraCreds.clientId}
                  onChange={e => setCoraForm(f => ({ ...f, [coraEnvKey]: { ...f[coraEnvKey], clientId: e.target.value } }))}
                />
              </div>

              {/* Chave PIX */}
              <div className="int-field">
                <label className="int-label"><Icons.Globe /> Chave PIX ({coraEnvKey})</label>
                <input className="int-input int-input--cora" type="text" placeholder="email@empresa.com ou CPF/CNPJ"
                  value={coraCreds.pixKey}
                  onChange={e => setCoraForm(f => ({ ...f, [coraEnvKey]: { ...f[coraEnvKey], pixKey: e.target.value } }))}
                />
              </div>

              {/* Certificate Upload */}
              <FileUploadZone label={`Certificado mTLS (.pem) — ${coraEnvKey}`}
                accept=".pem,.crt,.cer" provider="cora" hasSaved={hasSavedCert}
                value={coraCreds.certificatePem}
                onChange={v => setCoraForm(f => ({ ...f, [coraEnvKey]: { ...f[coraEnvKey], certificatePem: v } }))}
                placeholder="Cole o conteúdo do certificado .pem aqui...&#10;-----BEGIN CERTIFICATE-----&#10;..."
              />

              {/* Private Key Upload */}
              <FileUploadZone label={`Chave Privada (.key) — ${coraEnvKey}`}
                accept=".key,.pem" provider="cora" hasSaved={hasSavedKey}
                value={coraCreds.privateKeyPem}
                onChange={v => setCoraForm(f => ({ ...f, [coraEnvKey]: { ...f[coraEnvKey], privateKeyPem: v } }))}
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
                onChange={() => stripe?.configured && handleToggle('STRIPE', !stripe?.enabled)} />
            </div>
            <Icons.ChevronDown className={`int-chevron ${openCards.has('STRIPE') ? 'int-chevron--open' : ''}`} />
          </div>

          <div className={`int-card-body ${openCards.has('STRIPE') ? 'int-card-body--open' : ''}`}>
            <div className="int-card-content">
              <EnvToggle
                env={stripeForm.environment as 'sandbox' | 'production'}
                onChange={v => setStripeForm(f => ({ ...f, environment: v }))}
                labels={{ sandbox: 'Teste (sk_test)', production: 'Produção (sk_live)' }}
              />

              {/* Secret Key */}
              <div className="int-field">
                <label className="int-label"><Icons.Key /> Secret Key ({stripeEnvKey})</label>
                <input className="int-input int-input--stripe" type="password"
                  placeholder={hasSavedStripeKey ? '✅ Já configurada. Deixe em branco para manter.' : stripeEnvKey === 'sandbox' ? 'sk_test_xxx' : 'sk_live_xxx'}
                  value={stripeCreds.secretKey}
                  onChange={e => setStripeForm(f => ({ ...f, [stripeEnvKey]: { ...f[stripeEnvKey], secretKey: e.target.value } }))}
                />
              </div>

              {/* Publishable Key */}
              <div className="int-field">
                <label className="int-label"><Icons.Globe /> Publishable Key ({stripeEnvKey})</label>
                <input className="int-input int-input--stripe" type="text"
                  placeholder={stripeEnvKey === 'sandbox' ? 'pk_test_xxx' : 'pk_live_xxx'}
                  value={stripeCreds.publishableKey}
                  onChange={e => setStripeForm(f => ({ ...f, [stripeEnvKey]: { ...f[stripeEnvKey], publishableKey: e.target.value } }))}
                />
              </div>

              {/* Webhook Secret */}
              <div className="int-field">
                <label className="int-label"><Icons.Bell /> Webhook Secret ({stripeEnvKey})</label>
                <input className="int-input int-input--stripe" type="password"
                  placeholder={hasSavedStripeWebhook ? '✅ Já configurado. Deixe em branco para manter.' : 'whsec_xxx'}
                  value={stripeCreds.webhookSecret}
                  onChange={e => setStripeForm(f => ({ ...f, [stripeEnvKey]: { ...f[stripeEnvKey], webhookSecret: e.target.value } }))}
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

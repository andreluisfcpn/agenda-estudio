import React, { useState, useRef, useCallback } from 'react';
import type { IntegrationSummary } from '../api/client';

/* ═══ SVG Icons (Lucide-style, inline) ═══ */
const I = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

export const Icons = {
  Info: (p: any) => <svg {...I} {...p} width={p.size||20} height={p.size||20}><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>,
  Shield: (p: any) => <svg {...I} {...p} width={p.size||20} height={p.size||20}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
  ChevronDown: (p: any) => <svg {...I} {...p} width={p.size||20} height={p.size||20}><polyline points="6 9 12 15 18 9"/></svg>,
  Key: (p: any) => <svg {...I} {...p} width={p.size||14} height={p.size||14}><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>,
  Upload: (p: any) => <svg {...I} {...p} width={p.size||20} height={p.size||20}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>,
  FileText: (p: any) => <svg {...I} {...p} width={p.size||14} height={p.size||14}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>,
  Check: (p: any) => <svg {...I} {...p} width={p.size||14} height={p.size||14}><polyline points="20 6 9 17 4 12"/></svg>,
  Copy: (p: any) => <svg {...I} {...p} width={p.size||14} height={p.size||14}><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>,
  Trash: (p: any) => <svg {...I} {...p} width={p.size||12} height={p.size||12}><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>,
  Bell: (p: any) => <svg {...I} {...p} width={p.size||14} height={p.size||14}><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>,
  Globe: (p: any) => <svg {...I} {...p} width={p.size||14} height={p.size||14}><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>,
  Save: (p: any) => <svg {...I} {...p} width={p.size||16} height={p.size||16}><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>,
  Zap: (p: any) => <svg {...I} {...p} width={p.size||16} height={p.size||16}><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>,
  RefreshCw: (p: any) => <svg {...I} {...p} width={p.size||12} height={p.size||12}><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>,
  Link: (p: any) => <svg {...I} {...p} width={p.size||14} height={p.size||14}><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>,
  Edit: (p: any) => <svg {...I} {...p} width={p.size||14} height={p.size||14}><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>,
  // Provider logos (simple SVG representations)
  Bank: (p: any) => <svg {...I} {...p} width={p.size||22} height={p.size||22}><path d="M3 21h18"/><path d="M3 10h18"/><path d="M5 6l7-3 7 3"/><path d="M4 10v11"/><path d="M20 10v11"/><path d="M8 14v3"/><path d="M12 14v3"/><path d="M16 14v3"/></svg>,
  CreditCard: (p: any) => <svg {...I} {...p} width={p.size||22} height={p.size||22}><rect x="1" y="4" width="22" height="16" rx="2" ry="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>,
  Flask: (p: any) => <svg {...I} {...p} width={p.size||16} height={p.size||16}><path d="M9 3h6"/><path d="M10 3v7.4a2 2 0 0 1-.6 1.4L4 17.2a2 2 0 0 0-.5 2A2 2 0 0 0 5.3 21h13.4a2 2 0 0 0 1.8-1.2 2 2 0 0 0-.1-1.8L15 12.8a2 2 0 0 1-.6-1.4V3"/></svg>,
  Rocket: (p: any) => <svg {...I} {...p} width={p.size||16} height={p.size||16}><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/></svg>,
};

/* ═══ Shared Types ═══ */
export type { IntegrationSummary };

/* ═══ Status Badge ═══
   Comunica o estado REAL da integração (ligada? em qual ambiente?).
   O dot fica vermelho quando o último teste de conexão falhou. */
export function StatusBadge({ provider }: { provider?: IntegrationSummary }) {
  const dot = <span className={`int-status-dot${provider?.testStatus === 'error' ? ' int-status-dot--error' : ''}`} />;
  if (!provider?.configured) return <span className="int-status int-status--unconfigured"><span className="int-status-dot" /> Não configurada</span>;
  if (!provider.enabled) return <span className="int-status int-status--off">{dot} Desligada</span>;
  if (provider.environment === 'production') return <span className="int-status int-status--on-prod">{dot} Ativa · Produção</span>;
  return <span className="int-status int-status--on-sandbox">{dot} Ativa · Sandbox</span>;
}

/* ═══ Credenciais configuradas? (por ambiente, sobre o config MASCARADO) ═══ */
export function envConfigured(provider: 'CORA' | 'STRIPE', maskedCfg: Record<string, any> | undefined, env: 'sandbox' | 'production'): boolean {
  const cfg = maskedCfg?.[env] ?? (env === 'sandbox' ? maskedCfg : undefined); // config flat legado = sandbox
  if (!cfg) return false;
  if (provider === 'CORA') return !!(cfg.clientId && cfg.certificatePem && cfg.privateKeyPem);
  return !!(cfg.secretKey && cfg.publishableKey);
}

/* ═══ Toggle Switch ═══ */
export function Toggle({ on, disabled, onChange, ariaLabel }: { on: boolean; disabled?: boolean; onChange: () => void; ariaLabel?: string }) {
  return (
    <div
      className={`int-toggle ${on ? 'int-toggle--on' : ''} ${disabled ? 'int-toggle--disabled' : ''}`}
      onClick={e => { e.stopPropagation(); if (!disabled) onChange(); }}
      role="switch" aria-checked={on} aria-label={ariaLabel} tabIndex={0}
      onKeyDown={e => { if (!disabled && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onChange(); } }}
    >
      <div className="int-toggle-knob" />
    </div>
  );
}

/* ═══ Test Info ═══ */
export function TestInfo({ provider }: { provider?: IntegrationSummary }) {
  if (!provider?.lastTestedAt) return null;
  const cls = provider.testStatus === 'success' ? 'success' : provider.testStatus === 'error' ? 'error' : '';
  return (
    <div className={`int-test-info ${cls ? `int-test-info--${cls}` : ''}`}>
      <div className="int-test-time">Último teste: {new Date(provider.lastTestedAt).toLocaleString('pt-BR')}</div>
      {provider.testMessage && <div className={`int-test-msg ${cls ? `int-test-msg--${cls}` : ''}`}>{provider.testMessage}</div>}
    </div>
  );
}

/* ═══ Webhook URL Box ═══ */
export function WebhookUrlBox({ url, label, onCopy }: { url: string | null; label: string; onCopy: (t: string) => void }) {
  if (!url) return null;
  return (
    <div className="int-webhook-url-box">
      <label className="int-label"><Icons.Link /> {label}</label>
      <div className="int-webhook-url-display">
        <span>{url}</span>
        <button className="int-copy-btn" onClick={() => onCopy(url)} type="button">
          <Icons.Copy /> Copiar
        </button>
      </div>
    </div>
  );
}

/* ═══ File Upload Zone ═══ */
export function FileUploadZone({
  label, accept, provider, hasSaved, value, onChange, placeholder,
}: {
  label: string; accept: string; provider: 'cora' | 'stripe';
  hasSaved: boolean; value: string; onChange: (v: string) => void; placeholder: string;
}) {
  const [mode, setMode] = useState<'upload' | 'paste'>(hasSaved && !value ? 'upload' : 'upload');
  const [dragOver, setDragOver] = useState(false);
  const [fileName, setFileName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const content = e.target?.result as string;
      onChange(content);
      setFileName(file.name);
    };
    reader.readAsText(file);
  }, [onChange]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const hasContent = value.length > 0;

  return (
    <div className="int-field">
      <label className="int-label"><Icons.FileText /> {label}</label>
      <div className="int-upload-wrapper">
        <div className="int-upload-toggle">
          <button type="button" className={`int-upload-toggle-btn ${mode === 'upload' ? 'int-upload-toggle-btn--active' : ''}`}
            onClick={() => setMode('upload')}>
            <Icons.Upload size={12} /> Arquivo
          </button>
          <button type="button" className={`int-upload-toggle-btn ${mode === 'paste' ? 'int-upload-toggle-btn--active' : ''}`}
            onClick={() => setMode('paste')}>
            <Icons.Edit size={12} /> Colar
          </button>
        </div>

        {mode === 'upload' ? (
          <>
            <div
              className={`int-upload-zone int-upload-zone--${provider} ${dragOver ? 'int-upload-zone--dragover' : ''} ${(hasContent || hasSaved) ? 'int-upload-zone--has-file' : ''}`}
              onClick={() => inputRef.current?.click()}
              onDragOver={e => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
            >
              <div className="int-upload-icon">
                {hasContent || hasSaved ? <Icons.Check size={24} /> : <Icons.Upload size={24} />}
              </div>
              {hasContent ? (
                <div className="int-upload-filename"><Icons.FileText /> {fileName || 'Arquivo carregado'}</div>
              ) : hasSaved ? (
                <div className="int-upload-saved"><Icons.Check size={14} /> Já configurado — envie novo para substituir</div>
              ) : (
                <div className="int-upload-text">
                  <strong>Arraste o arquivo aqui</strong> ou toque para selecionar<br />
                  <span style={{ fontSize: '0.625rem' }}>{accept}</span>
                </div>
              )}
              <input ref={inputRef} type="file" accept={accept} className="int-upload-input" onChange={handleInputChange} />
            </div>
          </>
        ) : (
          <textarea
            className={`int-input int-textarea int-input--${provider}`}
            placeholder={hasSaved ? '✅ Já configurado. Deixe em branco para manter, ou cole um novo.' : placeholder}
            value={value} onChange={e => onChange(e.target.value)}
          />
        )}
      </div>
    </div>
  );
}

/* ═══ Environment Toggle (Sandbox ↔ Produção) ═══
   Com `title`/`hint` vira o seletor rotulado de "Ambiente ativo". */
export function EnvToggle({ env, onChange, labels, title, hint }: {
  env: 'sandbox' | 'production';
  onChange: (v: 'sandbox' | 'production') => void;
  labels: { sandbox: string; production: string };
  title?: string;
  hint?: string;
}) {
  const isProd = env === 'production';
  return (
    <div className="int-env-toggle-wrap">
      {title && <div className="int-env-title">{title}</div>}
      <button
        type="button"
        className={`int-env-toggle ${isProd ? 'int-env-toggle--prod' : ''}`}
        onClick={() => onChange(isProd ? 'sandbox' : 'production')}
        role="switch"
        aria-checked={isProd}
        aria-label={title || 'Ambiente'}
      >
        <span className={`int-env-toggle-option ${!isProd ? 'int-env-toggle-option--active' : ''}`}>
          <Icons.Flask size={13} /> {labels.sandbox}
        </span>
        <span className={`int-env-toggle-option ${isProd ? 'int-env-toggle-option--active' : ''}`}>
          <Icons.Rocket size={13} /> {labels.production}
        </span>
        <span className="int-env-toggle-slider" />
      </button>
      {hint && <div className="int-env-hint">{hint}</div>}
    </div>
  );
}

/* ═══ Abas de EDIÇÃO de credenciais (desacopladas do ambiente ativo) ═══
   Cada aba indica se aquele ambiente já tem credenciais (✓) ou não (—). */
export function CredsTabs({ editEnv, onChange, sandboxOk, productionOk }: {
  editEnv: 'sandbox' | 'production';
  onChange: (v: 'sandbox' | 'production') => void;
  sandboxOk: boolean;
  productionOk: boolean;
}) {
  const tab = (env: 'sandbox' | 'production', label: string, ok: boolean) => (
    <button type="button"
      className={`int-creds-tab ${editEnv === env ? 'int-creds-tab--active' : ''}`}
      onClick={() => onChange(env)}
      aria-pressed={editEnv === env}>
      {label}
      <span className={`int-creds-tab-dot ${ok ? 'int-creds-tab-dot--ok' : ''}`} role="img" aria-label={ok ? 'configurado' : 'sem credenciais'}>
        {ok ? <Icons.Check size={10} /> : '—'}
      </span>
    </button>
  );
  return (
    <div className="int-creds-tabs" role="group" aria-label="Editar credenciais de qual ambiente">
      <span className="int-creds-tabs-label">Credenciais:</span>
      {tab('sandbox', 'Sandbox', sandboxOk)}
      {tab('production', 'Produção', productionOk)}
    </div>
  );
}

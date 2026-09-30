// ─── Payment Methods — Single Source of Truth ────────────────────────
// All UI components that display payment method options MUST consume from
// this file to ensure consistent labels, icons, colors, and descriptions.
// Backend source of truth: Prisma enum PaymentMethod { CARTAO, PIX, BOLETO }
// Admin-configurable via: PaymentMethodConfig table + AdminPricingPage tab

import { useSyncExternalStore } from 'react';
import { pricingApi, PaymentMethodConfigItem, type BoletoStatus } from '../api/client';

export type PaymentMethodKey = 'PIX' | 'CARTAO' | 'BOLETO';

export interface PaymentMethodConfig {
  /** Matches the Prisma enum value */
  key: PaymentMethodKey;
  /** Full label for modals/forms: "Cartão de Crédito" */
  label: string;
  /** Short label for badges/tables: "Cartão" */
  shortLabel: string;
  /** Emoji icon */
  emoji: string;
  /** Client-facing description */
  description: string;
  /** Admin-side description (access mode) */
  adminDescription: string;
  /** Accent color when selected */
  color: string;
  /** Background when selected */
  bgActive: string;
  /** Border when selected */
  borderActive: string;
  /** Background when not selected */
  bgInactive: string;
  /** Border when not selected */
  borderInactive: string;
  /** How bookings/payments are released */
  accessMode: 'FULL' | 'PROGRESSIVE';
  /** CSV of checkout contexts where this method appears: avulso, contract, invoice */
  contexts?: string;
}

// ─── Static Fallback Defaults ────────────────────────────
// E3: o BOLETO NÃO entra nos padrões estáticos — antes de a API responder (ou se ela falhar) o boleto
// fica desligado. Ele só é oferecido quando `boleto.available` vem de GET /pricing/payment-methods.
const STATIC_DEFAULTS: PaymentMethodConfig[] = [
  {
    key: 'PIX',
    label: 'PIX',
    shortLabel: 'PIX',
    emoji: '⚡',
    description: 'Pagamento instantâneo',
    adminDescription: 'Acesso imediato',
    color: '#22c55e',
    bgActive: 'rgba(34, 197, 94, 0.1)',
    borderActive: '#22c55e',
    bgInactive: 'rgba(34, 197, 94, 0.04)',
    borderInactive: 'rgba(34, 197, 94, 0.2)',
    accessMode: 'FULL',
  },
  {
    key: 'CARTAO',
    label: 'Cartão de Crédito',
    shortLabel: 'Cartão',
    emoji: '💳',
    description: 'Crédito ou débito',
    adminDescription: 'Acesso imediato',
    color: 'var(--accent-primary)',
    bgActive: 'rgba(139, 92, 246, 0.08)',
    borderActive: 'var(--accent-primary)',
    bgInactive: 'var(--bg-secondary)',
    borderInactive: 'var(--border-subtle)',
    accessMode: 'FULL',
  },
];

/**
 * Aparência/rótulos do boleto — só APRESENTAÇÃO (nome de cobranças antigas pagas por boleto e a aba
 * Boleto quando ele está disponível). Não é oferta: quem decide se o boleto aparece é `isBoletoAvailable()`.
 */
const BOLETO_PRESENTATION: PaymentMethodConfig = {
  key: 'BOLETO',
  label: 'Boleto Bancário',
  shortLabel: 'Boleto',
  emoji: '📄',
  description: 'Compensação em até 3 dias úteis',
  adminDescription: 'Acesso progressivo',
  color: '#f59e0b',
  bgActive: 'rgba(245, 158, 11, 0.1)',
  borderActive: '#f59e0b',
  bgInactive: 'var(--bg-secondary)',
  borderInactive: 'var(--border-subtle)',
  accessMode: 'PROGRESSIVE',
};

/** Todos os métodos conhecidos (inclui o boleto, mesmo desligado) — só para EXIBIR nomes/emoji. */
const LABEL_FALLBACKS: PaymentMethodConfig[] = [...STATIC_DEFAULTS, BOLETO_PRESENTATION];

const BOLETO_OFF: BoletoStatus = { enabled: false, providerEnabled: false, available: false, reason: null, message: null };

/**
 * SEC-3 — a rota PÚBLICA (GET /pricing/payment-methods) devolve o boleto SANEADO: só `available` é
 * informação (sem o estado da integração Cora, a posição da chave nem a mensagem de administração).
 * Normaliza aqui, para o cache nunca depender de mais do que isso vindo da rota pública. O estado COMPLETO
 * (chave × Cora, `reason`, `message`) só vem das rotas ADMIN — GET /pricing/payment-methods/all e os PUT —
 * e é lido direto pela tela de Configurações (estado local dela, não este cache).
 */
function publicBoleto(b: Partial<BoletoStatus> | null | undefined): BoletoStatus {
  const available = b?.available === true;
  return { enabled: available, providerEnabled: available, available, reason: null, message: null };
}

// ─── Mutable Cache (updated from API) ────────────────────
let _cachedMethods: PaymentMethodConfig[] = [...STATIC_DEFAULTS];
let _loaded = false;
// E3 — estado do boleto (chave-mestra + Cora) vindo da API. Desligado até a API responder.
let _boleto: BoletoStatus = BOLETO_OFF;
let _inflight: Promise<PaymentMethodConfig[]> | null = null;

// Assinatura do cache: telas montadas (checkout, Configurações) re-renderizam quando os métodos ou o
// estado do boleto mudam (ex.: o admin liga/desliga a chave, ou o checkout revalida ao abrir).
let _version = 0;
const _listeners = new Set<() => void>();
function notify() {
  _version++;
  _listeners.forEach(l => { try { l(); } catch { /* um ouvinte com erro não derruba os outros */ } });
}
function subscribe(listener: () => void) {
  _listeners.add(listener);
  return () => { _listeners.delete(listener); };
}
const getVersion = () => _version;

/** Re-renderiza o componente quando o cache de métodos/boleto muda. Devolve um contador (serve de dep). */
export function usePaymentMethodsVersion(): number {
  return useSyncExternalStore(subscribe, getVersion, getVersion);
}

/** Um método só é oferecido se estiver ativo; o BOLETO, só quando EFETIVO (chave ligada + Cora). */
function offered(items: PaymentMethodConfigItem[], boleto: BoletoStatus): PaymentMethodConfigItem[] {
  return items.filter(i => i.active !== false && (i.key !== 'BOLETO' || boleto.available));
}

/** Convert API response item to full PaymentMethodConfig with computed style props */
function apiToConfig(item: PaymentMethodConfigItem): PaymentMethodConfig {
  const color = item.color || '#14b8a6';
  // Parse hex color to rgba for backgrounds
  const rgb = hexToRgb(color);
  const isVar = color.startsWith('var(');

  return {
    key: item.key as PaymentMethodKey,
    label: item.label,
    shortLabel: item.shortLabel,
    emoji: item.emoji,
    description: item.description,
    adminDescription: item.accessMode === 'PROGRESSIVE' ? 'Acesso progressivo' : 'Acesso imediato',
    color,
    bgActive: isVar ? 'rgba(139, 92, 246, 0.08)' : `rgba(${rgb}, 0.1)`,
    borderActive: color,
    bgInactive: isVar ? 'var(--bg-secondary)' : `rgba(${rgb}, 0.04)`,
    borderInactive: isVar ? 'var(--border-subtle)' : `rgba(${rgb}, 0.2)`,
    accessMode: item.accessMode as 'FULL' | 'PROGRESSIVE',
    contexts: item.contexts || 'avulso,contract,invoice',
  };
}

/** Parse hex color to "r, g, b" string */
function hexToRgb(hex: string): string {
  if (hex.startsWith('var(') || !hex.startsWith('#')) return '139, 92, 246';
  const h = hex.replace('#', '');
  const bigint = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return `${(bigint >> 16) & 255}, ${(bigint >> 8) & 255}, ${bigint & 255}`;
}

/**
 * Load payment methods from API and update cache. Call once on app init or admin save.
 * Chamadas simultâneas compartilham a mesma requisição. O `boleto` da resposta é a fonte ÚNICA de
 * "o boleto aparece?" (E3) — sem ele, o boleto fica desligado.
 */
export function loadPaymentMethods(): Promise<PaymentMethodConfig[]> {
  if (_inflight) return _inflight;
  _inflight = (async () => {
    try {
      const res = await pricingApi.getPaymentMethods();
      _boleto = publicBoleto(res.boleto);
      if (res.methods && res.methods.length > 0) {
        _cachedMethods = offered(res.methods, _boleto).map(apiToConfig);
        _loaded = true;
      } else if (!_boleto.available) {
        _cachedMethods = _cachedMethods.filter(m => m.key !== 'BOLETO');
      }
      notify();
    } catch (err) {
      console.warn('Failed to load payment methods from API, using defaults:', err);
    } finally {
      _inflight = null;
    }
    return _cachedMethods;
  })();
  return _inflight;
}

/**
 * Manually set payment methods (used by admin after save to avoid re-fetch). Passe o `boleto` devolvido
 * pela API: o BOLETO só entra no cache quando `boleto.available` (nunca só por estar "ativo" na lista).
 * Atenção: a lista do admin não filtra PIX/Cartão por provedor — depois de salvar, prefira
 * `loadPaymentMethods()` (o endpoint público já devolve só o que está de fato disponível).
 */
export function setPaymentMethods(items: PaymentMethodConfigItem[], boleto?: BoletoStatus) {
  if (boleto) _boleto = boleto;
  _cachedMethods = offered(items, _boleto).map(apiToConfig);
  _loaded = true;
  notify();
}

/**
 * E3 — estado do boleto em cache. Vindo da rota pública (o caso normal) só `available` é confiável:
 * `reason`/`message` são null e `enabled`/`providerEnabled` espelham `available` (SEC-3). Quem mostra um
 * texto de "boleto indisponível" deve ter um texto genérico de reserva (`message || '…'`); quem precisa do
 * motivo real (chave × Cora) lê `boleto` de `pricingApi.getPaymentMethodsAll()` (ADMIN).
 */
export function getBoletoStatus(): BoletoStatus {
  return _boleto;
}

/** E3 — atualiza o estado do boleto (resposta do switch das Configurações ou de um 400 da API). */
export function setBoletoStatus(boleto: BoletoStatus) {
  _boleto = boleto;
  if (!boleto.available) _cachedMethods = _cachedMethods.filter(m => m.key !== 'BOLETO');
  notify();
}

/**
 * E3 — FONTE ÚNICA de "o boleto pode ser oferecido?": chave ligada E Cora habilitada (`boleto.available`).
 * Mesmo true, o boleto NÃO entra em contratações com prazo de 10 minutos (avulso do cliente, contratação
 * nova, serviço, personalizado do cliente, renovação) — o contexto é decidido pelo checkout (`offerBoleto`).
 */
export function isBoletoAvailable(): boolean {
  return _boleto.available === true;
}

/** Active payment methods — always returns cached (or static defaults before API loads) */
export const PAYMENT_METHODS: PaymentMethodConfig[] = _cachedMethods;

/** Get the current list (reactive — always returns latest cache) */
export function getPaymentMethods(): PaymentMethodConfig[] {
  return _cachedMethods;
}

/**
 * Métodos dos WIZARDS do cliente (contratação nova, avulso, serviço, personalizado, renovação): nunca
 * inclui BOLETO — esses fluxos têm reserva de 10 minutos e o boleto compensa em dias (E3). Nas faturas
 * de contrato já ativo o boleto entra pelo checkout (`offerBoleto` + `isBoletoAvailable()`).
 */
export function getClientPaymentMethods(): PaymentMethodConfig[] {
  return _cachedMethods.filter(m => m.key !== 'BOLETO');
}

/**
 * Aparência do boleto (rótulo, cor, emoji): a configurada pelo admin quando o boleto está no cache, senão
 * a padrão. Só apresentação — para saber se o boleto pode ser oferecido use `isBoletoAvailable()`.
 */
export function getBoletoMethodConfig(): PaymentMethodConfig {
  return _cachedMethods.find(m => m.key === 'BOLETO') ?? BOLETO_PRESENTATION;
}

/** Whether a method is enabled for a given checkout context (avulso/contract/invoice). */
export function methodInContext(m: PaymentMethodConfig, context: string): boolean {
  if (!m.contexts) return true; // no restriction configured → show everywhere
  return m.contexts.split(',').map(s => s.trim()).includes(context);
}

/** Whether the methods have been loaded from the API */
export function isPaymentMethodsLoaded(): boolean {
  return _loaded;
}

/** Map for O(1) lookups by key (só para EXIBIR: inclui a aparência do boleto mesmo com ele desligado). */
export function getPaymentMethodMap(): Record<PaymentMethodKey, PaymentMethodConfig> {
  return Object.fromEntries([...LABEL_FALLBACKS, ..._cachedMethods].map(pm => [pm.key, pm])) as Record<PaymentMethodKey, PaymentMethodConfig>;
}

/** @deprecated Use getPaymentMethodMap() for dynamic data */
export const PAYMENT_METHOD_MAP: Record<PaymentMethodKey, PaymentMethodConfig> =
  Object.fromEntries(LABEL_FALLBACKS.map(pm => [pm.key, pm])) as Record<PaymentMethodKey, PaymentMethodConfig>;

/** Config para EXIBIR o nome de um método: a do cache ou, se ele não está ativo (ex.: boleto desligado), a padrão. */
function labelConfig(key: string): PaymentMethodConfig | undefined {
  return _cachedMethods.find(m => m.key === key) ?? LABEL_FALLBACKS.find(m => m.key === key);
}

/** Get full label for a payment method key, with fallback */
export function getPaymentLabel(key: string | null | undefined): string {
  if (!key) return '—';
  const pm = labelConfig(key);
  return pm?.label ?? key;
}

/** Get short label for badges/compact displays */
export function getPaymentShortLabel(key: string | null | undefined): string {
  if (!key) return '—';
  const pm = labelConfig(key);
  return pm?.shortLabel ?? key;
}

/** Get emoji for a payment method key */
export function getPaymentEmoji(key: string | null | undefined): string {
  if (!key) return '💰';
  const pm = labelConfig(key);
  return pm?.emoji ?? '💰';
}

/**
 * Provedor da cobrança (Payment.provider) → forma de pagamento exibida ao usuário.
 *  STRIPE → CARTAO · SICOOB → PIX · CORA → PIX (ou BOLETO quando a cobrança é um boleto:
 *  `boletoUrl` preenchido e sem `pixString`) · BOLETO → BOLETO.
 * Aceita também a própria chave de método (PIX/CARTAO/BOLETO, qualquer caixa) — idempotente.
 * Desconhecido/vazio → null.
 */
export function providerToMethod(
  provider: string | null | undefined,
  hint?: { boletoUrl?: string | null; pixString?: string | null },
): PaymentMethodKey | null {
  if (!provider) return null;
  switch (provider.trim().toUpperCase()) {
    case 'STRIPE':
    case 'CARTAO':
      return 'CARTAO';
    case 'SICOOB':
    case 'PIX':
      return 'PIX';
    case 'CORA':
      return hint?.boletoUrl && !hint?.pixString ? 'BOLETO' : 'PIX';
    case 'BOLETO':
      return 'BOLETO';
    default:
      return null;
  }
}

/** Get emoji + short label together (for badges, table cells).
 *  Aceita chave de método (PIX/CARTAO/BOLETO) ou de provedor (SICOOB/CORA → PIX, STRIPE → Cartão),
 *  para nunca exibir "SICOOB" cru. */
export function getPaymentBadge(key: string | null | undefined): { emoji: string; label: string } {
  if (!key) return { emoji: '💰', label: '—' };
  const pm = labelConfig(key)
    ?? (() => {
      const method = providerToMethod(key);
      return method ? labelConfig(method) : undefined;
    })();
  return pm
    ? { emoji: pm.emoji, label: pm.shortLabel }
    : { emoji: '💰', label: key };
}

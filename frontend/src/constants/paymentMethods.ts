// ─── Payment Methods — Single Source of Truth ────────────────────────
// All UI components that display payment method options MUST consume from
// this file to ensure consistent labels, icons, colors, and descriptions.
// Backend source of truth: Prisma enum PaymentMethod { CARTAO, PIX, BOLETO }
// Admin-configurable via: PaymentMethodConfig table + AdminPricingPage tab

import { pricingApi, PaymentMethodConfigItem } from '../api/client';

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
}

// ─── Static Fallback Defaults ────────────────────────────
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
  {
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
  },
];

// ─── Mutable Cache (updated from API) ────────────────────
let _cachedMethods: PaymentMethodConfig[] = [...STATIC_DEFAULTS];
let _loaded = false;

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
  };
}

/** Parse hex color to "r, g, b" string */
function hexToRgb(hex: string): string {
  if (hex.startsWith('var(') || !hex.startsWith('#')) return '139, 92, 246';
  const h = hex.replace('#', '');
  const bigint = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return `${(bigint >> 16) & 255}, ${(bigint >> 8) & 255}, ${bigint & 255}`;
}

/** Load payment methods from API and update cache. Call once on app init or admin save. */
export async function loadPaymentMethods(): Promise<PaymentMethodConfig[]> {
  try {
    const res = await pricingApi.getPaymentMethods();
    if (res.methods && res.methods.length > 0) {
      _cachedMethods = res.methods.map(apiToConfig);
      _loaded = true;
    }
  } catch (err) {
    console.warn('Failed to load payment methods from API, using defaults:', err);
  }
  return _cachedMethods;
}

/** Manually set payment methods (used by admin after save to avoid re-fetch) */
export function setPaymentMethods(items: PaymentMethodConfigItem[]) {
  _cachedMethods = items.filter(i => i.active).map(apiToConfig);
  _loaded = true;
}

/** Active payment methods — always returns cached (or static defaults before API loads) */
export const PAYMENT_METHODS: PaymentMethodConfig[] = _cachedMethods;

/** Get the current list (reactive — always returns latest cache) */
export function getPaymentMethods(): PaymentMethodConfig[] {
  return _cachedMethods;
}

/** Whether the methods have been loaded from the API */
export function isPaymentMethodsLoaded(): boolean {
  return _loaded;
}

/** Map for O(1) lookups by key */
export function getPaymentMethodMap(): Record<PaymentMethodKey, PaymentMethodConfig> {
  return Object.fromEntries(_cachedMethods.map(pm => [pm.key, pm])) as Record<PaymentMethodKey, PaymentMethodConfig>;
}

/** @deprecated Use getPaymentMethodMap() for dynamic data */
export const PAYMENT_METHOD_MAP: Record<PaymentMethodKey, PaymentMethodConfig> =
  Object.fromEntries(STATIC_DEFAULTS.map(pm => [pm.key, pm])) as Record<PaymentMethodKey, PaymentMethodConfig>;

/** Get full label for a payment method key, with fallback */
export function getPaymentLabel(key: string | null | undefined): string {
  if (!key) return '—';
  const pm = _cachedMethods.find(m => m.key === key);
  return pm?.label ?? key;
}

/** Get short label for badges/compact displays */
export function getPaymentShortLabel(key: string | null | undefined): string {
  if (!key) return '—';
  const pm = _cachedMethods.find(m => m.key === key);
  return pm?.shortLabel ?? key;
}

/** Get emoji for a payment method key */
export function getPaymentEmoji(key: string | null | undefined): string {
  if (!key) return '💰';
  const pm = _cachedMethods.find(m => m.key === key);
  return pm?.emoji ?? '💰';
}

/** Get emoji + short label together (for badges, table cells) */
export function getPaymentBadge(key: string | null | undefined): { emoji: string; label: string } {
  if (!key) return { emoji: '💰', label: '—' };
  const pm = _cachedMethods.find(m => m.key === key);
  return pm
    ? { emoji: pm.emoji, label: pm.shortLabel }
    : { emoji: '💰', label: key };
}

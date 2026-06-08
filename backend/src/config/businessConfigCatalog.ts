// ─── Business Config Catalog ───────────────────────────
// SINGLE source of truth for every BusinessConfig key: default value, type,
// human label and group. Consumed by:
//   - seedBusinessConfig.ts (upsert into DB)
//   - lib/businessConfig.ts  (DEFAULTS map for runtime reads)
//   - modules/pricing/pricing.config.ts (GET merges absent keys; PUT upserts)
// This guarantees admins can SEE and EDIT every config (no hardcoded rates).

export interface ConfigCatalogItem {
    key: string;
    value: string;       // default value (string; JSON-encoded for type 'json')
    type: 'percent' | 'number' | 'string' | 'json' | 'cents';
    label: string;
    group: string;
}

export const BUSINESS_CONFIG_CATALOG: ConfigCatalogItem[] = [
    // ── Plans ─────────────────────────────────────────────
    { key: 'discount_3months',       value: '30', type: 'percent', label: 'Desconto Fidelidade 3 Meses (%)', group: 'plans' },
    { key: 'discount_6months',       value: '40', type: 'percent', label: 'Desconto Fidelidade 6 Meses (%)', group: 'plans' },
    { key: 'sessions_per_month',     value: '4',  type: 'number',  label: 'Sessões por Mês (pacotes 2h)',    group: 'plans' },
    { key: 'episodes_3months',       value: '12', type: 'number',  label: 'Episódios — Plano 3 Meses',        group: 'plans' },
    { key: 'episodes_6months',       value: '24', type: 'number',  label: 'Episódios — Plano 6 Meses',        group: 'plans' },
    // ── Policies ──────────────────────────────────────────
    { key: 'cancellation_fine_pct',       value: '20', type: 'percent', label: 'Multa por Quebra de Contrato (%)',           group: 'policies' },
    { key: 'first_booking_min_days',      value: '1',  type: 'number',  label: 'Mínimo de Dias para 1ª Gravação',            group: 'policies' },
    { key: 'first_booking_max_days',      value: '15', type: 'number',  label: 'Máximo de Dias para 1ª Gravação',            group: 'policies' },
    { key: 'reschedule_max_days',         value: '7',  type: 'number',  label: 'Janela para Reagendamento (dias)',           group: 'policies' },
    { key: 'reschedule_min_hours',        value: '24', type: 'number',  label: 'Antecedência Mínima para Reagendar (horas)', group: 'policies' },
    { key: 'booking_min_advance_hours',   value: '12', type: 'number',  label: 'Antecedência Mínima para Agendar (horas)',   group: 'policies' },
    // ── Payments (taxas — editáveis pelo admin, nada hardcoded) ──
    { key: 'pix_extra_discount_pct',   value: '10', type: 'percent', label: 'Desconto Extra PIX à Vista (%)',          group: 'payments' },
    { key: 'card_fee_default_pct',     value: '5',  type: 'percent', label: 'Juros Cartão — padrão (parcelas sem taxa própria) (%)', group: 'payments' },
    { key: 'service_discount_3months', value: '30', type: 'percent', label: 'Desconto Serviço Mensal 3 Meses (%)',     group: 'payments' },
    { key: 'service_discount_6months', value: '40', type: 'percent', label: 'Desconto Serviço Mensal 6 Meses (%)',     group: 'payments' },
    // Tarifa fixa de cartão por nº de parcelas (1x..12x) — fonte central única.
    { key: 'card_installment_surcharges', value: '{"1":0,"2":5,"3":7,"4":8,"5":10,"6":11,"7":13,"8":14,"9":16,"10":17,"11":19,"12":20}', type: 'json', label: 'Tarifa de Cartão por Parcela (%)', group: 'payments' },
    // ── Gateway (taxas de processamento dos provedores) ──
    { key: 'gateway_stripe_fee_pct',  value: '4',   type: 'percent', label: 'Taxa de Processamento Stripe (%)',   group: 'gateway' },
    { key: 'gateway_cora_fee_cents',  value: '200', type: 'cents',   label: 'Taxa de Processamento Cora (centavos)', group: 'gateway' },
    // ── Studio & Branding (aba "Gerais") — fonte única do catálogo ──
    { key: 'studio_name',       value: 'Estúdio Búzios Digital', type: 'string', label: 'Nome do Estúdio',   group: 'studio' },
    { key: 'studio_email',      value: 'contato@buzios.digital', type: 'string', label: 'E-mail de Contato', group: 'studio' },
    { key: 'studio_location',   value: 'Búzios, RJ',             type: 'string', label: 'Localização',       group: 'studio' },
    { key: 'studio_logo_url',   value: 'https://buzios.digital/wp-content/uploads/2025/01/logo-site-branca.svg', type: 'string', label: 'URL do Logo', group: 'studio' },
    { key: 'studio_hero_image', value: 'https://buzios.digital/wp-content/uploads/elementor/thumbs/bd-estudio-enhanced-sr-r9lm9twze86yo0wxu68fp1e0yf8baho28zrniyf1o0.jpg', type: 'string', label: 'Imagem Principal', group: 'studio' },
    // ── Ambiente (hero animado por aba + clima/dia-noite) — só apresentação ──
    // toggles usam value 'true'/'false' (o admin renderiza como switch pela detecção de valor).
    { key: 'ambient_enabled',         value: 'true',        type: 'string', label: 'Animação Ambiente no Hero',                 group: 'ambient' },
    { key: 'ambient_weather_enabled', value: 'true',        type: 'string', label: 'Refletir o Clima (Open-Meteo)',             group: 'ambient' },
    { key: 'ambient_location',        value: 'Búzios, RJ',  type: 'string', label: 'Cidade para o Clima',                       group: 'ambient' },
    // ── Gravações (plataformas de transmissão habilitadas) — toggles 'true'/'false' ──
    { key: 'platform_youtube_enabled',   value: 'true', type: 'string', label: 'Plataforma: YouTube',   group: 'recordings' },
    { key: 'platform_instagram_enabled', value: 'true', type: 'string', label: 'Plataforma: Instagram', group: 'recordings' },
    { key: 'platform_facebook_enabled',  value: 'true', type: 'string', label: 'Plataforma: Facebook',  group: 'recordings' },
    { key: 'platform_tiktok_enabled',    value: 'true', type: 'string', label: 'Plataforma: TikTok',    group: 'recordings' },
];

/** key → default value (string), derived from the catalog. */
export const CONFIG_DEFAULT_VALUES: Record<string, string> = Object.fromEntries(
    BUSINESS_CONFIG_CATALOG.map(c => [c.key, c.value]),
);

/** key → catalog item, for metadata lookups (label/type/group). */
export const CONFIG_CATALOG_BY_KEY: Record<string, ConfigCatalogItem> = Object.fromEntries(
    BUSINESS_CONFIG_CATALOG.map(c => [c.key, c]),
);

/**
 * Keys retired from the product. They may still exist as orphan rows in the DB
 * (from past seeds/edits), so the config endpoints filter them out — they no
 * longer appear in the admin UI nor in the public config, and nothing reads them.
 *  - card_fee_3x_pct / card_fee_6x_pct: superseded by `card_installment_surcharges`
 *    (the central per-installment table). Card juros now applies uniformly at checkout.
 */
export const DEPRECATED_CONFIG_KEYS = new Set<string>([
    'card_fee_3x_pct',
    'card_fee_6x_pct',
]);

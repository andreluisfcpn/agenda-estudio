// ─── Streaming platforms (shared) ───────────────────────────────────────────
// Single source for the networks a recording can be broadcast to, plus helpers to
// parse the JSON-string columns the backend stores (Booking.platforms / platformLinks
// / streamMetrics). Per-network livestream metrics are: views, peak, subscribers, likes, comments.

export interface PlatformDef { key: string; label: string; color: string; emoji: string; }

export const PLATFORMS: PlatformDef[] = [
    { key: 'YOUTUBE', label: 'YouTube', color: '#FF0000', emoji: '▶️' },
    { key: 'TIKTOK', label: 'TikTok', color: '#00F2EA', emoji: '🎵' },
    { key: 'INSTAGRAM', label: 'Instagram', color: '#E1306C', emoji: '📸' },
    { key: 'FACEBOOK', label: 'Facebook', color: '#1877F2', emoji: '👍' },
];

export const PLATFORM_BY_KEY: Record<string, PlatformDef> = Object.fromEntries(PLATFORMS.map(p => [p.key, p]));

export interface PlatformMetric { views?: number; peak?: number; subscribers?: number; likes?: number; comments?: number; }
export type StreamMetricsMap = Record<string, PlatformMetric>;

/** Snapshot metrics captured per network AT SESSION END, with labels for forms/cards. */
export const METRIC_FIELDS: { key: keyof PlatformMetric; label: string; short: string }[] = [
    { key: 'views', label: 'Visualizações', short: 'Views' },
    { key: 'peak', label: 'Pico ao vivo', short: 'Pico' },
    { key: 'subscribers', label: 'Inscritos', short: 'Inscritos' },
    { key: 'likes', label: 'Curtidas', short: 'Curtidas' },
    { key: 'comments', label: 'Comentários', short: 'Coment.' },
];

export function parsePlatforms(json: string | null | undefined): string[] {
    if (!json) return [];
    try { const v = JSON.parse(json); return Array.isArray(v) ? v : []; } catch { return []; }
}

export function parsePlatformLinks(json: string | null | undefined): Record<string, string> {
    if (!json) return {};
    try { const v = JSON.parse(json); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}

export function parseStreamMetrics(json: string | null | undefined): StreamMetricsMap {
    if (!json) return {};
    try { const v = JSON.parse(json); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}

// ─── Stream metrics (per-platform livestream analytics) ─────────────────────
// Bookings store livestream analytics per network in Booking.streamMetrics as JSON:
//   { "YOUTUBE": { views, peak, subscribers, likes, comments }, "TIKTOK": { ... }, ... }
// The flat Booking.peakViewers / chatMessages columns are kept as derived aggregates
// (max peak / total comments) so legacy displays (Relatórios, metric cards) keep working.

export interface PlatformMetric {
    views?: number;
    peak?: number;
    subscribers?: number;
    likes?: number;
    comments?: number;
}
export type StreamMetricsMap = Record<string, PlatformMetric>;

/** Derive legacy aggregates (max peak across networks, total comments) from streamMetrics JSON. */
export function deriveStreamAggregates(
    streamMetricsJson: string | null | undefined,
): { peakViewers: number | null; chatMessages: number | null } {
    if (!streamMetricsJson) return { peakViewers: null, chatMessages: null };
    try {
        const map = JSON.parse(streamMetricsJson) as StreamMetricsMap;
        const entries = Object.values(map || {});
        if (entries.length === 0) return { peakViewers: null, chatMessages: null };
        const peak = Math.max(0, ...entries.map(m => Number(m?.peak) || 0));
        const comments = entries.reduce((s, m) => s + (Number(m?.comments) || 0), 0);
        return { peakViewers: peak || null, chatMessages: comments || null };
    } catch {
        return { peakViewers: null, chatMessages: null };
    }
}

import { BarChart, Bar, XAxis, YAxis, Tooltip, Cell, ResponsiveContainer } from 'recharts';
import { METRIC_FIELDS, PLATFORM_BY_KEY, parseStreamMetrics } from '../../constants/platforms';

interface Props { streamMetrics: string | null | undefined }

const fmt = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);

/**
 * Per-network livestream metrics, one compact bar chart per metric (Views / Pico /
 * Curtidas / Comentários). Each metric gets its own axis so very different scales
 * (thousands of views vs. dozens of comments) stay readable. Bars are colored by network.
 */
export default function StreamMetricsChart({ streamMetrics }: Props) {
    const map = parseStreamMetrics(streamMetrics);
    const platformKeys = Object.keys(map);
    if (platformKeys.length === 0) return null;

    return (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
            {METRIC_FIELDS.map(f => {
                const data = platformKeys.map(k => ({
                    name: PLATFORM_BY_KEY[k]?.label || k,
                    value: Number(map[k]?.[f.key]) || 0,
                    color: PLATFORM_BY_KEY[k]?.color || 'var(--accent-primary)',
                }));
                const total = data.reduce((s, d) => s + d.value, 0);
                return (
                    <div key={f.key} style={{ background: 'var(--bg-card)', border: '1px solid var(--border-default)', borderRadius: 12, padding: '12px 10px 6px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '0 4px', marginBottom: 6 }}>
                            <span style={{ fontSize: '0.6875rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{f.label}</span>
                            <span style={{ fontSize: '0.8125rem', fontWeight: 800, color: 'var(--text-primary)' }}>{fmt(total)}</span>
                        </div>
                        <ResponsiveContainer width="100%" height={110}>
                            <BarChart data={data} margin={{ top: 4, right: 6, left: -18, bottom: 0 }}>
                                <XAxis dataKey="name" tick={{ fontSize: 9, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} interval={0} />
                                <YAxis tick={{ fontSize: 9, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} width={34} tickFormatter={fmt} />
                                <Tooltip
                                    cursor={{ fill: 'rgba(255,255,255,0.04)' }}
                                    contentStyle={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', borderRadius: 8, fontSize: '0.75rem' }}
                                    labelStyle={{ color: 'var(--text-primary)' }}
                                    formatter={(v) => [Number(v).toLocaleString('pt-BR'), f.label]}
                                />
                                <Bar dataKey="value" radius={[4, 4, 0, 0]} maxBarSize={44}>
                                    {data.map((d, i) => <Cell key={i} fill={d.color} />)}
                                </Bar>
                            </BarChart>
                        </ResponsiveContainer>
                    </div>
                );
            })}
        </div>
    );
}

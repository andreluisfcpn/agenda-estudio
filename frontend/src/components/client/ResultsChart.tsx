import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell } from 'recharts';

const fmtK = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
const fmtDay = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
const TOOLTIP_STYLE = { background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', borderRadius: 8, fontSize: '0.75rem' } as const;

// ── Evolução de visualizações no tempo (geral) ──
export function ResultsTimeline({ data }: { data: { date: string; views: number; peak: number }[] }) {
    if (data.length === 0) return null;
    return (
        <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={data} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
                <defs>
                    <linearGradient id="resViews" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#11819B" stopOpacity={0.45} />
                        <stop offset="100%" stopColor="#11819B" stopOpacity={0.03} />
                    </linearGradient>
                </defs>
                <CartesianGrid stroke="rgba(148,163,184,0.12)" vertical={false} />
                <XAxis dataKey="date" tickFormatter={fmtDay} tick={{ fontSize: 10, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} minTickGap={24} />
                <YAxis tickFormatter={fmtK} tick={{ fontSize: 10, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} width={38} />
                <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={{ color: 'var(--text-primary)' }}
                    labelFormatter={(d: unknown) => fmtDay(String(d))} formatter={(v: unknown) => [Number(v).toLocaleString('pt-BR'), 'Visualizações']} />
                <Area type="monotone" dataKey="views" stroke="#11819B" strokeWidth={2} fill="url(#resViews)" />
            </AreaChart>
        </ResponsiveContainer>
    );
}

// ── Comparação de visualizações por contrato ──
const BAR_COLORS = ['#11819B', '#8b5cf6', '#3b82f6', '#10b981', '#f59e0b', '#ec4899'];
export function ResultsByContract({ data }: { data: { name: string; views: number }[] }) {
    if (data.length === 0) return null;
    return (
        <ResponsiveContainer width="100%" height={Math.max(140, data.length * 48)}>
            <BarChart data={data} layout="vertical" margin={{ top: 4, right: 12, left: 4, bottom: 4 }}>
                <CartesianGrid stroke="rgba(148,163,184,0.12)" horizontal={false} />
                <XAxis type="number" tickFormatter={fmtK} tick={{ fontSize: 10, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 11, fill: 'var(--text-secondary)' }} axisLine={false} tickLine={false} width={110} />
                <Tooltip cursor={{ fill: 'rgba(255,255,255,0.04)' }} contentStyle={TOOLTIP_STYLE}
                    labelStyle={{ color: 'var(--text-primary)' }} formatter={(v: unknown) => [Number(v).toLocaleString('pt-BR'), 'Visualizações']} />
                <Bar dataKey="views" radius={[0, 6, 6, 0]} maxBarSize={28}>
                    {/* key pelo nome do contrato: com key={i}, remover/reordenar contratos
                        reaproveitava a Cell errada (cor trocada). Hex ficam: var() não é
                        confiável em presentation attribute de SVG via prop do recharts. */}
                    {data.map((d, i) => <Cell key={d.name} fill={BAR_COLORS[i % BAR_COLORS.length]} />)}
                </Bar>
            </BarChart>
        </ResponsiveContainer>
    );
}

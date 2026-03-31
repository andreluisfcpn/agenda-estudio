import React, { useState, useEffect, useCallback } from 'react';
import {
    reportsApi, ReportSummary, SlotOccupancy, DayOccupancy,
    TierBreakdownItem, AudienceMetrics, ClientRankItem,
} from '../api/client';
import { useNavigate } from 'react-router-dom';

function formatBRL(cents: number): string {
    return `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;
}

function formatBRLCompact(cents: number): string {
    const v = cents / 100;
    if (v >= 1000) return `R$ ${(v / 1000).toFixed(1).replace('.', ',')}k`;
    return `R$ ${v.toFixed(0)}`;
}

const TIER_META: Record<string, { emoji: string; color: string; bg: string; label: string }> = {
    COMERCIAL: { emoji: '🏢', color: '#10b981', bg: 'rgba(16,185,129,0.10)', label: 'Comercial' },
    AUDIENCIA: { emoji: '🎤', color: '#2dd4bf', bg: 'rgba(45,212,191,0.10)', label: 'Audiência' },
    SABADO:    { emoji: '🌟', color: '#fbbf24', bg: 'rgba(245,158,11,0.10)', label: 'Sábado' },
};

type Period = '7d' | '30d' | '90d' | '365d';

function getDateRange(period: Period): { from: string; to: string } {
    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - parseInt(period));
    return { from: from.toISOString().split('T')[0], to: to.toISOString().split('T')[0] };
}

export default function AdminReportsPage() {
    const navigate = useNavigate();
    const [summary, setSummary] = useState<ReportSummary | null>(null);
    const [slotOccupancy, setSlotOccupancy] = useState<SlotOccupancy[]>([]);
    const [dayOccupancy, setDayOccupancy] = useState<DayOccupancy[]>([]);
    const [tierBreakdown, setTierBreakdown] = useState<TierBreakdownItem[]>([]);
    const [audienceMetrics, setAudienceMetrics] = useState<AudienceMetrics | null>(null);
    const [clientRanking, setClientRanking] = useState<ClientRankItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [period, setPeriod] = useState<Period>('30d');

    const loadData = useCallback(async () => {
        setLoading(true);
        try {
            const range = getDateRange(period);
            const [sumRes, occRes, tierRes, audRes, rankRes] = await Promise.all([
                reportsApi.getSummary(range),
                reportsApi.getOccupancy(range),
                reportsApi.getTiers(range),
                reportsApi.getAudience(range),
                reportsApi.getRanking({ ...range, limit: 10 }),
            ]);
            setSummary(sumRes.summary);
            setSlotOccupancy(occRes.slotOccupancy);
            setDayOccupancy(occRes.dayOccupancy);
            setTierBreakdown(tierRes.tierBreakdown);
            setAudienceMetrics(audRes.audience);
            setClientRanking(rankRes.ranking);
        } catch (err) { console.error(err); }
        finally { setLoading(false); }
    }, [period]);

    useEffect(() => { loadData(); }, [loadData]);

    const handleExportCSV = () => {
        if (!summary) return;
        const headers = ['Cliente', 'Sessões', 'Concluídas', 'Faltas', 'Receita (R$)', 'Média Viewers'];
        const rows = clientRanking.map(c => [
            c.name, c.sessions, c.completed, c.falta,
            (c.revenue / 100).toFixed(2).replace('.', ','),
            c.avgViewers || 0,
        ]);
        const csvContent = [
            `Relatório Búzios Digital — ${period}`,
            `Sessões: ${summary.totalBookings}; Concluídas: ${summary.completedBookings}; Faltas: ${summary.faltaBookings}; Receita: R$ ${(summary.totalRevenue / 100).toFixed(2).replace('.', ',')}`,
            '',
            headers.join(';'),
            ...rows.map(r => r.join(';')),
        ].join('\n');
        const blob = new Blob(['\ufeff' + csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `relatorio_buzios_${period}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    };

    if (loading || !summary) return <div className="loading-spinner"><div className="spinner" /></div>;

    return (
        <div aria-label="Relatórios administrativos">
            {/* ─── HEADER ─── */}
            <div style={{ marginBottom: '28px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '16px' }}>
                <div>
                    <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <span style={{ fontSize: '1.75rem' }}>📈</span> Relatórios & Métricas
                    </h1>
                    <p className="page-subtitle" style={{ marginTop: '4px' }}>
                        Visão estratégica do desempenho do estúdio
                    </p>
                </div>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                    {/* Period pills */}
                    <div style={{ display: 'flex', gap: '2px', padding: '3px', background: 'var(--bg-elevated)', borderRadius: '10px' }}>
                        {([
                            { key: '7d' as Period, label: '7 dias' },
                            { key: '30d' as Period, label: '30 dias' },
                            { key: '90d' as Period, label: '90 dias' },
                            { key: '365d' as Period, label: '1 ano' },
                        ]).map(p => (
                            <button key={p.key}
                                onClick={() => setPeriod(p.key)}
                                style={{
                                    padding: '5px 12px', borderRadius: '8px', fontSize: '0.6875rem',
                                    fontWeight: period === p.key ? 700 : 500, border: 'none', cursor: 'pointer',
                                    background: period === p.key ? 'var(--bg-secondary)' : 'transparent',
                                    color: period === p.key ? 'var(--text-primary)' : 'var(--text-muted)',
                                    boxShadow: period === p.key ? '0 1px 3px rgba(0,0,0,0.2)' : 'none',
                                    transition: 'all 0.2s'
                                }}
                            >
                                {p.label}
                            </button>
                        ))}
                    </div>
                    <button onClick={handleExportCSV}
                        style={{
                            display: 'flex', alignItems: 'center', gap: '6px',
                            background: 'var(--bg-elevated)', border: '1px solid var(--border-color)',
                            color: 'var(--text-secondary)', padding: '6px 14px', borderRadius: '8px',
                            cursor: 'pointer', fontSize: '0.6875rem', fontWeight: 600, transition: 'all 0.2s'
                        }}
                        onMouseEnter={e => { e.currentTarget.style.borderColor = '#10b981'; e.currentTarget.style.color = '#10b981'; }}
                        onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border-color)'; e.currentTarget.style.color = 'var(--text-secondary)'; }}
                    >
                        📥 Exportar CSV
                    </button>
                </div>
            </div>

            {/* ─── KPI CARDS ─── */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '14px', marginBottom: '24px' }}>
                <div style={{
                    padding: '20px', borderRadius: '14px',
                    background: 'linear-gradient(135deg, rgba(99,102,241,0.08), rgba(67,56,202,0.04))',
                    border: '1px solid rgba(99,102,241,0.2)',
                }}>
                    <div style={{ fontSize: '0.6875rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '6px' }}>Sessões</div>
                    <div style={{ fontSize: '2rem', fontWeight: 800, color: 'var(--text-primary)' }}>{summary.totalBookings}</div>
                    <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', marginTop: '4px' }}>no período</div>
                </div>
                <div style={{
                    padding: '20px', borderRadius: '14px',
                    background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
                }}>
                    <div style={{ fontSize: '0.6875rem', fontWeight: 700, color: '#10b981', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '6px' }}>Concluídas</div>
                    <div style={{ fontSize: '2rem', fontWeight: 800, color: 'var(--text-primary)' }}>{summary.completedBookings}</div>
                    <div style={{ fontSize: '0.6875rem', color: '#10b981', marginTop: '4px', fontWeight: 600 }}>{summary.attendanceRate}% presença</div>
                </div>
                <div style={{
                    padding: '20px', borderRadius: '14px',
                    background: summary.faltaBookings > 0 ? 'linear-gradient(135deg, rgba(239,68,68,0.06), rgba(220,38,38,0.04))' : 'var(--bg-secondary)',
                    border: summary.faltaBookings > 0 ? '1px solid rgba(239,68,68,0.2)' : '1px solid var(--border-color)',
                }}>
                    <div style={{ fontSize: '0.6875rem', fontWeight: 700, color: '#ef4444', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '6px' }}>Faltas</div>
                    <div style={{ fontSize: '2rem', fontWeight: 800, color: summary.faltaBookings > 0 ? '#ef4444' : 'var(--text-primary)' }}>{summary.faltaBookings}</div>
                    <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', marginTop: '4px' }}>{summary.faltaBookings > 0 ? `${100 - summary.attendanceRate}%` : '0%'}</div>
                </div>
                <div style={{
                    padding: '20px', borderRadius: '14px',
                    background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
                }}>
                    <div style={{ fontSize: '0.6875rem', fontWeight: 700, color: '#f59e0b', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '6px' }}>Cancelamentos</div>
                    <div style={{ fontSize: '2rem', fontWeight: 800, color: 'var(--text-primary)' }}>{summary.cancelledBookings}</div>
                    <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', marginTop: '4px' }}>{summary.cancellationRate}%</div>
                </div>
                <div style={{
                    padding: '20px', borderRadius: '14px',
                    background: 'linear-gradient(135deg, rgba(16,185,129,0.10), rgba(6,78,59,0.06))',
                    border: '1px solid rgba(16,185,129,0.25)',
                }}>
                    <div style={{ fontSize: '0.6875rem', fontWeight: 700, color: '#10b981', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '6px' }}>Receita</div>
                    <div style={{ fontSize: '1.5rem', fontWeight: 800, color: '#10b981' }}>{formatBRLCompact(summary.totalRevenue)}</div>
                    <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', marginTop: '4px' }}>total acumulado</div>
                </div>
            </div>

            {/* ─── OCCUPANCY: Slot + Day ─── */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px', marginBottom: '24px' }}>
                {/* By Slot */}
                <div style={{ padding: '24px', borderRadius: '16px', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)' }}>
                    <h3 style={{ fontSize: '0.8125rem', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: '18px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{ width: 16, height: 2, background: '#3b82f6', borderRadius: 1 }} />
                        Ocupação por Horário
                    </h3>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                        {slotOccupancy.map(s => (
                            <div key={s.slot} style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                                <span style={{ fontSize: '0.6875rem', fontWeight: 700, color: 'var(--text-muted)', minWidth: 50, fontFamily: "'JetBrains Mono', monospace" }}>{s.label}</span>
                                <div style={{ flex: 1, height: 8, borderRadius: 4, background: 'rgba(255,255,255,0.04)', overflow: 'hidden' }}>
                                    <div style={{
                                        height: '100%', borderRadius: 4, width: `${s.pct}%`,
                                        background: s.pct >= 70 ? 'linear-gradient(90deg, #10b981, #34d399)' : s.pct >= 40 ? 'linear-gradient(90deg, #3b82f6, #60a5fa)' : 'rgba(107,114,128,0.3)',
                                        transition: 'width 0.5s ease',
                                    }} />
                                </div>
                                <span style={{ fontSize: '0.6875rem', fontWeight: 700, color: s.pct >= 70 ? '#10b981' : s.pct >= 40 ? '#3b82f6' : 'var(--text-muted)', minWidth: 36, textAlign: 'right' }}>{s.pct}%</span>
                            </div>
                        ))}
                    </div>
                </div>

                {/* By Day */}
                <div style={{ padding: '24px', borderRadius: '16px', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)' }}>
                    <h3 style={{ fontSize: '0.8125rem', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: '18px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{ width: 16, height: 2, background: '#10b981', borderRadius: 1 }} />
                        Ocupação por Dia da Semana
                    </h3>
                    <div style={{ display: 'flex', alignItems: 'flex-end', gap: '10px', height: 130, paddingTop: '10px' }}>
                        {dayOccupancy.map(d => (
                            <div key={d.day} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px' }}>
                                <div style={{ width: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: 90 }}>
                                    <div style={{
                                        height: `${Math.max(d.pct, 4)}%`, borderRadius: '6px 6px 0 0',
                                        background: d.pct >= 70 ? 'linear-gradient(180deg, #10b981, #059669)' : d.pct >= 40 ? 'linear-gradient(180deg, #3b82f6, #2563eb)' : 'rgba(107,114,128,0.25)',
                                        transition: 'height 0.5s ease', minHeight: 4,
                                    }} />
                                </div>
                                <div style={{ fontSize: '0.6875rem', fontWeight: 700, color: d.pct >= 70 ? '#10b981' : d.pct >= 40 ? '#3b82f6' : 'var(--text-muted)' }}>{d.pct}%</div>
                                <div style={{ fontSize: '0.625rem', color: 'var(--text-muted)', fontWeight: 600 }}>{d.day}</div>
                            </div>
                        ))}
                    </div>
                </div>
            </div>

            {/* ─── TIER + AUDIENCE ─── */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px', marginBottom: '24px' }}>
                {/* Tier Breakdown */}
                <div style={{ padding: '24px', borderRadius: '16px', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)' }}>
                    <h3 style={{ fontSize: '0.8125rem', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: '18px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{ width: 16, height: 2, background: '#f59e0b', borderRadius: 1 }} />
                        Distribuição por Faixa
                    </h3>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                        {tierBreakdown.map(t => {
                            const meta = TIER_META[t.tier] || { emoji: '•', color: '#888', bg: 'rgba(136,136,136,0.1)', label: t.tier };
                            return (
                                <div key={t.tier} style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                                    <div style={{
                                        width: 36, height: 36, borderRadius: '10px',
                                        background: meta.bg, display: 'flex', alignItems: 'center', justifyContent: 'center',
                                        fontSize: '1.125rem', flexShrink: 0,
                                    }}>
                                        {meta.emoji}
                                    </div>
                                    <div style={{ flex: 1 }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                                            <span style={{ fontSize: '0.8125rem', fontWeight: 700, color: meta.color }}>{meta.label}</span>
                                            <span style={{ fontSize: '0.6875rem', color: 'var(--text-muted)' }}>{t.count} sessões · {formatBRLCompact(t.revenue)}</span>
                                        </div>
                                        <div style={{ height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.04)', overflow: 'hidden' }}>
                                            <div style={{ height: '100%', borderRadius: 3, width: `${t.pct}%`, background: meta.color, transition: 'width 0.5s ease' }} />
                                        </div>
                                    </div>
                                    <span style={{ fontSize: '0.8125rem', fontWeight: 800, color: meta.color, minWidth: 36, textAlign: 'right' }}>{t.pct}%</span>
                                </div>
                            );
                        })}
                    </div>
                </div>

                {/* Audience Metrics */}
                <div style={{ padding: '24px', borderRadius: '16px', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)' }}>
                    <h3 style={{ fontSize: '0.8125rem', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: '18px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{ width: 16, height: 2, background: '#2dd4bf', borderRadius: 1 }} />
                        Métricas de Audiência
                    </h3>
                    {!audienceMetrics || audienceMetrics.totalCompleted === 0 ? (
                        <div style={{ textAlign: 'center', padding: '32px', color: 'var(--text-muted)' }}>
                            <div style={{ fontSize: '2.5rem', marginBottom: '8px', opacity: 0.4 }}>📊</div>
                            <div style={{ fontSize: '0.875rem', fontWeight: 600 }}>Sem dados de audiência</div>
                            <div style={{ fontSize: '0.75rem', marginTop: '4px' }}>Nenhuma sessão concluída neste período</div>
                        </div>
                    ) : (
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                            {[
                                { icon: '👁️', label: 'Média de Viewers', value: audienceMetrics.avgViewers.toLocaleString('pt-BR'), color: '#2dd4bf' },
                                { icon: '🏆', label: 'Pico Máximo', value: audienceMetrics.maxViewers.toLocaleString('pt-BR'), color: '#fbbf24' },
                                { icon: '💬', label: 'Média de Chat', value: audienceMetrics.avgChat.toLocaleString('pt-BR'), color: '#10b981' },
                                { icon: '⏱️', label: 'Duração Média', value: audienceMetrics.avgDuration > 0 ? `${audienceMetrics.avgDuration}min` : '—', color: '#3b82f6' },
                            ].map(m => (
                                <div key={m.label} style={{
                                    padding: '16px', borderRadius: '12px', textAlign: 'center',
                                    background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-color)',
                                }}>
                                    <div style={{ fontSize: '1.25rem', marginBottom: '4px' }}>{m.icon}</div>
                                    <div style={{ fontSize: '0.5625rem', textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--text-muted)', marginBottom: '4px', fontWeight: 700 }}>{m.label}</div>
                                    <div style={{ fontSize: '1.25rem', fontWeight: 800, color: m.color }}>{m.value}</div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>

            {/* ─── CLIENT RANKING ─── */}
            <div style={{ borderRadius: '16px', border: '1px solid var(--border-color)', background: 'var(--bg-secondary)', overflow: 'hidden', marginBottom: '24px' }}>
                <div style={{ padding: '20px 24px 0', marginBottom: '16px' }}>
                    <h3 style={{ fontSize: '0.8125rem', fontWeight: 700, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{ width: 16, height: 2, background: '#fbbf24', borderRadius: 1 }} />
                        🏆 Ranking de Clientes — Top 10 por Receita
                    </h3>
                </div>
                {clientRanking.length === 0 ? (
                    <div style={{ padding: '48px 20px', textAlign: 'center', color: 'var(--text-muted)' }}>
                        <div style={{ fontSize: '2.5rem', marginBottom: '12px', opacity: 0.4 }}>🏆</div>
                        <div style={{ fontWeight: 600 }}>Nenhum dado de cliente neste período</div>
                    </div>
                ) : (
                    <div className="table-container" style={{ margin: 0 }}>
                        <table>
                            <thead>
                                <tr>
                                    <th style={{ width: 50, paddingLeft: '24px' }}>#</th>
                                    <th>Cliente</th>
                                    <th style={{ textAlign: 'center' }}>Sessões</th>
                                    <th style={{ textAlign: 'center' }}>Concluídas</th>
                                    <th style={{ textAlign: 'center' }}>Faltas</th>
                                    <th style={{ textAlign: 'right' }}>Receita</th>
                                    <th style={{ textAlign: 'center' }}>Média Viewers</th>
                                </tr>
                            </thead>
                            <tbody>
                                {clientRanking.map((c, i) => (
                                    <tr key={c.id}
                                        style={{
                                            background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)',
                                            transition: 'background 0.15s'
                                        }}
                                        onMouseEnter={e => (e.currentTarget.style.background = 'rgba(16,185,129,0.04)')}
                                        onMouseLeave={e => (e.currentTarget.style.background = i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)')}
                                    >
                                        <td style={{ textAlign: 'center', paddingLeft: '24px' }}>
                                            <span style={{
                                                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                                                width: 28, height: 28, borderRadius: '8px',
                                                background: i === 0 ? 'rgba(251,191,36,0.15)' : i === 1 ? 'rgba(192,192,192,0.12)' : i === 2 ? 'rgba(205,127,50,0.12)' : 'rgba(255,255,255,0.03)',
                                                color: i === 0 ? '#fbbf24' : i === 1 ? '#c0c0c0' : i === 2 ? '#cd7f32' : 'var(--text-muted)',
                                                fontSize: '0.75rem', fontWeight: 800,
                                            }}>
                                                {i < 3 ? ['🥇', '🥈', '🥉'][i] : i + 1}
                                            </span>
                                        </td>
                                        <td>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                                <div style={{
                                                    width: 34, height: 34, borderRadius: '10px',
                                                    background: i === 0 ? 'rgba(251,191,36,0.12)' : i === 1 ? 'rgba(192,192,192,0.1)' : 'rgba(16,185,129,0.08)',
                                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                    fontSize: '0.75rem', fontWeight: 700, flexShrink: 0,
                                                    color: i === 0 ? '#fbbf24' : i === 1 ? '#c0c0c0' : '#10b981',
                                                }}>
                                                    {c.name.charAt(0).toUpperCase()}
                                                </div>
                                                <span style={{ fontWeight: 600, cursor: 'pointer', color: 'var(--accent-primary)', fontSize: '0.875rem' }}
                                                    onClick={() => navigate(`/admin/clients/${c.id}`)}>
                                                    {c.name}
                                                </span>
                                            </div>
                                        </td>
                                        <td style={{ textAlign: 'center', fontSize: '0.875rem', fontWeight: 600 }}>{c.sessions}</td>
                                        <td style={{ textAlign: 'center' }}><span style={{ color: '#10b981', fontWeight: 700, fontSize: '0.875rem' }}>{c.completed}</span></td>
                                        <td style={{ textAlign: 'center' }}><span style={{ color: c.falta > 0 ? '#ef4444' : 'var(--text-muted)', fontWeight: 700, fontSize: '0.875rem' }}>{c.falta}</span></td>
                                        <td style={{ textAlign: 'right', fontWeight: 800, fontSize: '0.9375rem', fontVariantNumeric: 'tabular-nums' }}>{formatBRL(c.revenue)}</td>
                                        <td style={{ textAlign: 'center', color: c.avgViewers > 0 ? '#2dd4bf' : 'var(--text-muted)', fontSize: '0.875rem', fontWeight: 600 }}>
                                            {c.avgViewers > 0 ? c.avgViewers.toLocaleString('pt-BR') : '—'}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        </div>
    );
}

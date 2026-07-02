import React, { useState, useEffect, useCallback } from 'react';
import {
    reportsApi, ReportSummary, SlotOccupancy, DayOccupancy,
    TierBreakdownItem, AudienceMetrics, ClientRankItem,
} from '../api/client';
import { useNavigate } from 'react-router-dom';
import { BarChart3 } from 'lucide-react';
import AdminPageHeader from '../components/admin/AdminPageHeader';
import { HeroSkeleton, TableSkeleton } from '../components/ui/SkeletonLoader';
import { TIER_META, getMeta } from '../constants/adminMeta';

import { formatBRL } from '../utils/format';

function formatBRLCompact(cents: number): string {
    const v = cents / 100;
    if (v >= 1000) return `R$ ${(v / 1000).toFixed(1).replace('.', ',')}k`;
    return `R$ ${v.toFixed(0)}`;
}

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

    if (loading || !summary) return <div><HeroSkeleton /><TableSkeleton rows={6} cols={7} /></div>;

    return (
        <div aria-label="Relatórios administrativos">
            {/* ─── HEADER ─── */}
            <AdminPageHeader
                icon={BarChart3}
                title="Relatórios"
                subtitle="Métricas, ocupação e ranking"
                actions={
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                        {/* Period pills */}
                        <div className="admin-segmented" role="group" aria-label="Período do relatório">
                            {([
                                { key: '7d' as Period, label: '7 dias' },
                                { key: '30d' as Period, label: '30 dias' },
                                { key: '90d' as Period, label: '90 dias' },
                                { key: '365d' as Period, label: '1 ano' },
                            ]).map(p => (
                                <button key={p.key}
                                    onClick={() => setPeriod(p.key)}
                                    aria-pressed={period === p.key}
                                    className={`admin-segmented__btn${period === p.key ? ' admin-segmented__btn--active' : ''}`}
                                >
                                    {p.label}
                                </button>
                            ))}
                        </div>
                        <button onClick={handleExportCSV} className="btn-admin-ghost" style={{ fontSize: '0.6875rem', padding: '6px 14px' }}>
                            📥 Exportar CSV
                        </button>
                    </div>
                }
            />

            {/* ─── KPI CARDS ─── */}
            <div className="admin-kpi-grid" style={{ marginBottom: '24px' }}>
                <div className="admin-kpi-card admin-kpi-card--accent">
                    <div className="admin-kpi-card__label">Sessões</div>
                    <div className="admin-kpi-card__value">{summary.totalBookings}</div>
                    <div className="admin-kpi-card__caption">no período</div>
                </div>
                <div className="admin-kpi-card">
                    <div className="admin-kpi-card__label" style={{ color: 'var(--success)' }}>Concluídas</div>
                    <div className="admin-kpi-card__value">{summary.completedBookings}</div>
                    <div className="admin-kpi-card__caption" style={{ color: 'var(--success)', fontWeight: 600 }}>{summary.attendanceRate}% presença</div>
                </div>
                <div className={`admin-kpi-card${summary.faltaBookings > 0 ? ' admin-kpi-card--danger' : ''}`}>
                    <div className="admin-kpi-card__label" style={{ color: 'var(--danger)' }}>Faltas</div>
                    <div className="admin-kpi-card__value" style={summary.faltaBookings > 0 ? { color: 'var(--danger)' } : undefined}>{summary.faltaBookings}</div>
                    <div className="admin-kpi-card__caption">{summary.faltaBookings > 0 ? `${100 - summary.attendanceRate}%` : '0%'}</div>
                </div>
                <div className="admin-kpi-card">
                    <div className="admin-kpi-card__label" style={{ color: 'var(--warning)' }}>Cancelamentos</div>
                    <div className="admin-kpi-card__value">{summary.cancelledBookings}</div>
                    <div className="admin-kpi-card__caption">{summary.cancellationRate}%</div>
                </div>
                <div className="admin-kpi-card admin-kpi-card--success">
                    <div className="admin-kpi-card__label" style={{ color: 'var(--success)' }}>Receita</div>
                    <div className="admin-kpi-card__value admin-kpi-card__value--sm" style={{ color: 'var(--success)' }}>{formatBRLCompact(summary.totalRevenue)}</div>
                    <div className="admin-kpi-card__caption">total acumulado</div>
                </div>
            </div>

            {/* ─── OCCUPANCY: Slot + Day ─── */}
            <div className="admin-grid-2" style={{ gap: '14px', marginBottom: '24px' }}>
                {/* By Slot */}
                <div style={{ padding: '24px', borderRadius: '16px', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)' }}>
                    <h3 style={{ fontSize: '0.8125rem', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: '18px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{ width: 16, height: 2, background: 'var(--info)', borderRadius: 1 }} />
                        Ocupação por Horário
                    </h3>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }} role="img"
                        aria-label={`Ocupação por horário: ${slotOccupancy.map(s => `${s.label} ${s.pct}%`).join(', ')}`}>
                        {slotOccupancy.map(s => (
                            <div key={s.slot} style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                                <span style={{ fontSize: '0.6875rem', fontWeight: 700, color: 'var(--text-muted)', minWidth: 50, fontFamily: "'JetBrains Mono', monospace" }}>{s.label}</span>
                                <div style={{ flex: 1, height: 8, borderRadius: 4, background: 'rgba(255,255,255,0.04)', overflow: 'hidden' }}>
                                    <div style={{
                                        height: '100%', borderRadius: 4, width: `${s.pct}%`,
                                        background: s.pct >= 70 ? 'linear-gradient(90deg, #10b981, #34d399)' : s.pct >= 40 ? 'linear-gradient(90deg, #3b82f6, #60a5fa)' : 'rgba(107,114,128,0.3)',
                                        transition: 'width 0.3s ease',
                                    }} />
                                </div>
                                <span style={{ fontSize: '0.6875rem', fontWeight: 700, color: s.pct >= 70 ? 'var(--success)' : s.pct >= 40 ? 'var(--info)' : 'var(--text-muted)', minWidth: 36, textAlign: 'right' }}>{s.pct}%</span>
                            </div>
                        ))}
                    </div>
                </div>

                {/* By Day */}
                <div style={{ padding: '24px', borderRadius: '16px', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)' }}>
                    <h3 style={{ fontSize: '0.8125rem', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: '18px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{ width: 16, height: 2, background: 'var(--success)', borderRadius: 1 }} />
                        Ocupação por Dia da Semana
                    </h3>
                    <div style={{ display: 'flex', alignItems: 'flex-end', gap: '10px', height: 130, paddingTop: '10px' }} role="img"
                        aria-label={`Ocupação por dia da semana: ${dayOccupancy.map(d => `${d.day} ${d.pct}%`).join(', ')}`}>
                        {dayOccupancy.map(d => (
                            <div key={d.day} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px' }}>
                                <div style={{ width: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: 90 }}>
                                    <div style={{
                                        height: `${Math.max(d.pct, 4)}%`, borderRadius: '6px 6px 0 0',
                                        background: d.pct >= 70 ? 'linear-gradient(180deg, #10b981, #059669)' : d.pct >= 40 ? 'linear-gradient(180deg, #3b82f6, #2563eb)' : 'rgba(107,114,128,0.25)',
                                        transition: 'height 0.3s ease', minHeight: 4,
                                    }} />
                                </div>
                                <div style={{ fontSize: '0.6875rem', fontWeight: 700, color: d.pct >= 70 ? 'var(--success)' : d.pct >= 40 ? 'var(--info)' : 'var(--text-muted)' }}>{d.pct}%</div>
                                <div style={{ fontSize: '0.625rem', color: 'var(--text-muted)', fontWeight: 600 }}>{d.day}</div>
                            </div>
                        ))}
                    </div>
                </div>
            </div>

            {/* ─── TIER + AUDIENCE ─── */}
            <div className="admin-grid-2" style={{ gap: '14px', marginBottom: '24px' }}>
                {/* Tier Breakdown */}
                <div style={{ padding: '24px', borderRadius: '16px', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)' }}>
                    <h3 style={{ fontSize: '0.8125rem', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: '18px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{ width: 16, height: 2, background: 'var(--warning)', borderRadius: 1 }} />
                        Distribuição por Faixa
                    </h3>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                        {tierBreakdown.map(t => {
                            const meta = getMeta(TIER_META, t.tier);
                            const TierIcon = meta.icon;
                            return (
                                <div key={t.tier} style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                                    <div style={{
                                        width: 36, height: 36, borderRadius: '10px',
                                        background: meta.bg, color: meta.color, display: 'flex', alignItems: 'center', justifyContent: 'center',
                                        flexShrink: 0,
                                    }}>
                                        <TierIcon size={18} strokeWidth={1.8} />
                                    </div>
                                    <div style={{ flex: 1 }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                                            <span style={{ fontSize: '0.8125rem', fontWeight: 700, color: meta.color }}>{meta.label}</span>
                                            <span style={{ fontSize: '0.6875rem', color: 'var(--text-muted)' }}>{t.count} sessões · {formatBRLCompact(t.revenue)}</span>
                                        </div>
                                        <div style={{ height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.04)', overflow: 'hidden' }}>
                                            <div style={{ height: '100%', borderRadius: 3, width: `${t.pct}%`, background: meta.color, transition: 'width 0.3s ease' }} />
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
                        <span style={{ width: 16, height: 2, background: 'var(--accent-text)', borderRadius: 1 }} />
                        Métricas de Audiência
                    </h3>
                    {!audienceMetrics || audienceMetrics.totalCompleted === 0 ? (
                        <div style={{ textAlign: 'center', padding: '32px', color: 'var(--text-muted)' }}>
                            <div style={{ fontSize: '2.5rem', marginBottom: '8px', opacity: 0.4 }}>📊</div>
                            <div style={{ fontSize: '0.875rem', fontWeight: 600 }}>Sem dados de audiência</div>
                            <div style={{ fontSize: '0.75rem', marginTop: '4px' }}>Nenhuma sessão concluída neste período</div>
                        </div>
                    ) : (
                        <div className="admin-grid-2" style={{ gap: '12px' }}>
                            {[
                                { icon: '👁️', label: 'Média de Viewers', value: audienceMetrics.avgViewers.toLocaleString('pt-BR'), color: 'var(--accent-text)' },
                                { icon: '🏆', label: 'Pico Máximo', value: audienceMetrics.maxViewers.toLocaleString('pt-BR'), color: 'var(--warning)' },
                                { icon: '💬', label: 'Média de Chat', value: audienceMetrics.avgChat.toLocaleString('pt-BR'), color: 'var(--success)' },
                                { icon: '⏱️', label: 'Duração Média', value: audienceMetrics.avgDuration > 0 ? `${audienceMetrics.avgDuration}min` : '—', color: 'var(--info)' },
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
                        <span style={{ width: 16, height: 2, background: 'var(--warning)', borderRadius: 1 }} />
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
                      <div className="admin-table-wrap">
                        <table className="admin-table--cards">
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
                                    <tr key={c.id} className="admin-zebra-row">
                                        <td data-label="Posição" style={{ textAlign: 'center', paddingLeft: '24px' }}>
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
                                        <td className="admin-card-title">
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
                                                <button style={{ fontWeight: 600, cursor: 'pointer', color: 'var(--accent-text)', fontSize: '0.875rem', background: 'none', border: 'none', padding: 0, fontFamily: 'inherit', textAlign: 'left' }}
                                                    title={`Abrir perfil de ${c.name}`}
                                                    onClick={() => navigate(`/admin/clients/${c.id}`)}>
                                                    {c.name}
                                                </button>
                                            </div>
                                        </td>
                                        <td data-label="Sessões" style={{ textAlign: 'center', fontSize: '0.875rem', fontWeight: 600 }}>{c.sessions}</td>
                                        <td data-label="Concluídas" style={{ textAlign: 'center' }}><span style={{ color: 'var(--success)', fontWeight: 700, fontSize: '0.875rem' }}>{c.completed}</span></td>
                                        <td data-label="Faltas" style={{ textAlign: 'center' }}><span style={{ color: c.falta > 0 ? 'var(--danger)' : 'var(--text-muted)', fontWeight: 700, fontSize: '0.875rem' }}>{c.falta}</span></td>
                                        <td data-label="Receita" style={{ textAlign: 'right', fontWeight: 800, fontSize: '0.9375rem', fontVariantNumeric: 'tabular-nums' }}>{formatBRL(c.revenue)}</td>
                                        <td data-label="Média viewers" style={{ textAlign: 'center', color: c.avgViewers > 0 ? 'var(--accent-text)' : 'var(--text-muted)', fontSize: '0.875rem', fontWeight: 600 }}>
                                            {c.avgViewers > 0 ? c.avgViewers.toLocaleString('pt-BR') : '—'}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                      </div>
                    </div>
                )}
            </div>
        </div>
    );
}

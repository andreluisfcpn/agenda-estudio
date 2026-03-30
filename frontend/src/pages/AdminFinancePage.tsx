import React, { useState, useEffect, useMemo } from 'react';
import { financeApi, FinanceClosingResponse, EnrichedPayment } from '../api/client';
import { useUI } from '../context/UIContext';

function formatBRL(cents: number): string {
    return `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;
}

const MONTHS = [
    'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
    'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'
];

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string; icon: string }> = {
    PAID:     { label: 'Pago',       color: '#10b981', bg: 'rgba(16,185,129,0.12)',  icon: '✓' },
    PENDING:  { label: 'Pendente',   color: '#f59e0b', bg: 'rgba(245,158,11,0.12)',  icon: '⏳' },
    FAILED:   { label: 'Falhou',     color: '#ef4444', bg: 'rgba(239,68,68,0.12)',   icon: '✗' },
    REFUNDED: { label: 'Estornado',  color: '#8b5cf6', bg: 'rgba(139,92,246,0.12)',  icon: '↩' },
};

export default function AdminFinancePage() {
    const { showAlert } = useUI();
    const today = new Date();
    
    const [selectedYear, setSelectedYear] = useState<number>(today.getFullYear());
    const [selectedMonth, setSelectedMonth] = useState<number>(today.getMonth() + 1);

    const [data, setData] = useState<FinanceClosingResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [statusFilter, setStatusFilter] = useState<string>('ALL');
    const [searchTerm, setSearchTerm] = useState('');

    useEffect(() => {
        loadData();
    }, [selectedYear, selectedMonth]);

    const loadData = async () => {
        setLoading(true);
        try {
            const res = await financeApi.getMonthlyClosing(selectedYear, selectedMonth);
            setData(res);
        } catch (err: any) {
            showAlert({ message: err.message || 'Erro ao carregar dados financeiros', type: 'error' });
        } finally {
            setLoading(false);
        }
    };

    const isCurrentMonth = selectedYear === today.getFullYear() && selectedMonth === today.getMonth() + 1;

    const filteredPayments = useMemo(() => {
        if (!data) return [];
        let list = data.payments;
        if (statusFilter !== 'ALL') {
            list = list.filter(p => p.status === statusFilter);
        }
        if (searchTerm.trim()) {
            const q = searchTerm.toLowerCase();
            list = list.filter(p => 
                p.user?.name?.toLowerCase().includes(q) || 
                p.user?.email?.toLowerCase().includes(q) ||
                p.contract?.name?.toLowerCase().includes(q)
            );
        }
        return list;
    }, [data, statusFilter, searchTerm]);

    // Totals for the filtered set
    const filteredTotals = useMemo(() => {
        const t = { gross: 0, fees: 0, net: 0 };
        for (const p of filteredPayments) {
            if (p.status === 'PAID') {
                t.gross += p.amount;
                t.fees += p.feeDeduced;
                t.net += p.netAmount;
            }
        }
        return t;
    }, [filteredPayments]);

    // Collection rate (% paid vs total)
    const collectionRate = useMemo(() => {
        if (!data || data.payments.length === 0) return 0;
        const paid = data.payments.filter(p => p.status === 'PAID').length;
        return Math.round((paid / data.payments.length) * 100);
    }, [data]);

    const goMonth = (delta: number) => {
        let m = selectedMonth + delta;
        let y = selectedYear;
        if (m < 1) { m = 12; y--; }
        if (m > 12) { m = 1; y++; }
        setSelectedMonth(m);
        setSelectedYear(y);
    };

    return (
        <div>
            {/* ─── HEADER ─── */}
            <div style={{ marginBottom: '28px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '16px' }}>
                <div>
                    <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <span style={{ fontSize: '1.75rem' }}>💰</span> Financeiro
                    </h1>
                    <p className="page-subtitle" style={{ marginTop: '4px' }}>
                        Fechamento mensal e controle de pagamentos
                    </p>
                </div>
                
                {/* Month Navigator */}
                <div style={{
                    display: 'flex', alignItems: 'center', gap: '0',
                    background: 'var(--bg-secondary)', borderRadius: '12px',
                    border: '1px solid var(--border-color)', overflow: 'hidden'
                }}>
                    <button onClick={() => goMonth(-1)} style={{
                        background: 'none', border: 'none', color: 'var(--text-secondary)',
                        padding: '10px 14px', cursor: 'pointer', fontSize: '1rem',
                        transition: 'all 0.2s'
                    }} onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-elevated)')} onMouseLeave={e => (e.currentTarget.style.background = 'none')}>
                        ‹
                    </button>
                    <div style={{
                        padding: '10px 20px', fontWeight: 700, fontSize: '0.9375rem',
                        color: 'var(--text-primary)', borderLeft: '1px solid var(--border-color)',
                        borderRight: '1px solid var(--border-color)', minWidth: '180px', textAlign: 'center',
                        background: isCurrentMonth ? 'rgba(16,185,129,0.06)' : 'none'
                    }}>
                        {MONTHS[selectedMonth - 1]} {selectedYear}
                        {isCurrentMonth && <span style={{ fontSize: '0.6875rem', color: '#10b981', display: 'block', fontWeight: 500 }}>Mês Atual</span>}
                    </div>
                    <button onClick={() => goMonth(1)} style={{
                        background: 'none', border: 'none', color: 'var(--text-secondary)',
                        padding: '10px 14px', cursor: 'pointer', fontSize: '1rem',
                        transition: 'all 0.2s'
                    }} onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-elevated)')} onMouseLeave={e => (e.currentTarget.style.background = 'none')}>
                        ›
                    </button>
                </div>
            </div>

            {loading ? (
                <div className="loading-spinner"><div className="spinner" /></div>
            ) : !data ? (
                <div className="empty-state">Nenhum dado encontrado para este período.</div>
            ) : (
                <>
                    {/* ─── KPI HERO CARDS ─── */}
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '16px', marginBottom: '24px' }}>
                        
                        {/* NET REVENUE — hero card */}
                        <div style={{
                            padding: '28px', borderRadius: '16px',
                            background: 'linear-gradient(135deg, rgba(16,185,129,0.12) 0%, rgba(6,78,59,0.08) 100%)',
                            border: '1px solid rgba(16,185,129,0.2)',
                            position: 'relative', overflow: 'hidden'
                        }}>
                            <div style={{ position: 'absolute', top: '-20px', right: '-20px', fontSize: '6rem', opacity: 0.04, transform: 'rotate(15deg)' }}>💎</div>
                            <div style={{ fontSize: '0.75rem', fontWeight: 700, color: '#10b981', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '8px' }}>
                                Repasse Líquido
                            </div>
                            <div style={{ fontSize: '2.75rem', fontWeight: 800, color: 'var(--text-primary)', lineHeight: 1.1, marginBottom: '6px' }}>
                                {formatBRL(data.metrics.netRevenue)}
                            </div>
                            <p style={{ fontSize: '0.8125rem', color: 'rgba(16,185,129,0.8)', fontWeight: 500, margin: 0 }}>
                                Na conta do Estúdio {isCurrentMonth && '(parcial)'}
                            </p>
                        </div>

                        {/* GROSS REVENUE */}
                        <div style={{
                            padding: '24px', borderRadius: '16px',
                            background: 'var(--bg-secondary)', border: '1px solid var(--border-color)'
                        }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                                <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                                    Faturamento Bruto
                                </div>
                                <span style={{ fontSize: '1.5rem', opacity: 0.6 }}>💳</span>
                            </div>
                            <div style={{ fontSize: '1.875rem', fontWeight: 800, color: 'var(--text-primary)', marginTop: '10px' }}>
                                {formatBRL(data.metrics.grossRevenue)}
                            </div>
                            <div style={{ marginTop: '10px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                <span style={{
                                    display: 'inline-flex', alignItems: 'center', gap: '4px',
                                    padding: '3px 8px', borderRadius: '6px', fontSize: '0.6875rem', fontWeight: 600,
                                    background: 'rgba(16,185,129,0.1)', color: '#10b981'
                                }}>
                                    ✓ {data.metrics.paidCount} pagos
                                </span>
                            </div>
                        </div>

                        {/* FEES */}
                        <div style={{
                            padding: '24px', borderRadius: '16px',
                            background: 'var(--bg-secondary)', border: '1px solid var(--border-color)'
                        }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                                <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                                    Taxas Retidas
                                </div>
                                <span style={{ fontSize: '1.5rem', opacity: 0.6 }}>🏦</span>
                            </div>
                            <div style={{ fontSize: '1.875rem', fontWeight: 800, color: '#ef4444', marginTop: '10px' }}>
                                − {formatBRL(data.metrics.totalFees)}
                            </div>
                            <div style={{ marginTop: '10px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                                {data.metrics.breakdown.stripe > 0 && (
                                    <span style={{
                                        padding: '3px 8px', borderRadius: '6px', fontSize: '0.6875rem', fontWeight: 600,
                                        background: 'rgba(99,102,241,0.1)', color: '#818cf8'
                                    }}>
                                        Stripe: {data.metrics.breakdown.stripe}
                                    </span>
                                )}
                                {data.metrics.breakdown.cora > 0 && (
                                    <span style={{
                                        padding: '3px 8px', borderRadius: '6px', fontSize: '0.6875rem', fontWeight: 600,
                                        background: 'rgba(245,158,11,0.1)', color: '#f59e0b'
                                    }}>
                                        Cora: {data.metrics.breakdown.cora}
                                    </span>
                                )}
                            </div>
                        </div>

                        {/* PENDING / OVERDUE */}
                        <div style={{
                            padding: '24px', borderRadius: '16px',
                            background: data.metrics.pendingRevenue > 0 
                                ? 'linear-gradient(135deg, rgba(239,68,68,0.06), rgba(234,88,12,0.04))'
                                : 'var(--bg-secondary)',
                            border: data.metrics.pendingRevenue > 0 
                                ? '1px solid rgba(239,68,68,0.2)' 
                                : '1px solid var(--border-color)'
                        }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                                <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                                    {isCurrentMonth ? 'A Receber' : 'Inadimplência'}
                                </div>
                                <span style={{ fontSize: '1.5rem', opacity: 0.6 }}>{data.metrics.pendingRevenue > 0 ? '🚨' : '✅'}</span>
                            </div>
                            <div style={{ fontSize: '1.875rem', fontWeight: 800, color: data.metrics.pendingRevenue > 0 ? '#ea580c' : '#10b981', marginTop: '10px' }}>
                                {data.metrics.pendingRevenue > 0 ? formatBRL(data.metrics.pendingRevenue) : 'R$ 0,00'}
                            </div>
                            <div style={{ marginTop: '10px' }}>
                                <span style={{
                                    padding: '3px 8px', borderRadius: '6px', fontSize: '0.6875rem', fontWeight: 600,
                                    background: data.metrics.unpaidCount > 0 ? 'rgba(234,88,12,0.1)' : 'rgba(16,185,129,0.1)',
                                    color: data.metrics.unpaidCount > 0 ? '#ea580c' : '#10b981'
                                }}>
                                    {data.metrics.unpaidCount} pendente{data.metrics.unpaidCount !== 1 ? 's' : ''}
                                </span>
                            </div>
                        </div>
                    </div>

                    {/* ─── COLLECTION RATE BAR ─── */}
                    <div style={{
                        padding: '16px 20px', borderRadius: '12px', marginBottom: '24px',
                        background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
                        display: 'flex', alignItems: 'center', gap: '16px'
                    }}>
                        <div style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                            Taxa de Recebimento
                        </div>
                        <div style={{ flex: 1, height: '8px', borderRadius: '4px', background: 'var(--bg-elevated)', overflow: 'hidden' }}>
                            <div style={{
                                height: '100%', borderRadius: '4px',
                                width: `${collectionRate}%`,
                                background: collectionRate >= 80 
                                    ? 'linear-gradient(90deg, #10b981, #34d399)' 
                                    : collectionRate >= 50 
                                        ? 'linear-gradient(90deg, #f59e0b, #fbbf24)' 
                                        : 'linear-gradient(90deg, #ef4444, #f87171)',
                                transition: 'width 0.8s ease-out'
                            }} />
                        </div>
                        <div style={{ 
                            fontSize: '0.9375rem', fontWeight: 800, minWidth: '45px', textAlign: 'right',
                            color: collectionRate >= 80 ? '#10b981' : collectionRate >= 50 ? '#f59e0b' : '#ef4444'
                        }}>
                            {collectionRate}%
                        </div>
                    </div>

                    {/* ─── INVOICES TABLE ─── */}
                    <div style={{ borderRadius: '16px', border: '1px solid var(--border-color)', background: 'var(--bg-secondary)', overflow: 'hidden' }}>
                        
                        {/* Table Header */}
                        <div style={{
                            padding: '16px 20px', display: 'flex', flexWrap: 'wrap', gap: '12px',
                            justifyContent: 'space-between', alignItems: 'center',
                            borderBottom: '1px solid var(--border-color)'
                        }}>
                            <h3 style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--text-primary)', margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
                                📋 Faturas
                                <span style={{
                                    fontSize: '0.6875rem', fontWeight: 600, padding: '2px 8px',
                                    borderRadius: '10px', background: 'var(--bg-elevated)', color: 'var(--text-muted)'
                                }}>
                                    {filteredPayments.length}
                                </span>
                            </h3>

                            <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
                                {/* Search */}
                                <div style={{ position: 'relative' }}>
                                    <input
                                        type="text"
                                        placeholder="Buscar cliente..."
                                        value={searchTerm}
                                        onChange={e => setSearchTerm(e.target.value)}
                                        style={{
                                            padding: '6px 12px 6px 30px', borderRadius: '8px', fontSize: '0.8125rem',
                                            background: 'var(--bg-elevated)', border: '1px solid var(--border-color)',
                                            color: 'var(--text-primary)', width: '180px', outline: 'none',
                                            transition: 'border-color 0.2s'
                                        }}
                                        onFocus={e => (e.currentTarget.style.borderColor = '#10b981')}
                                        onBlur={e => (e.currentTarget.style.borderColor = 'var(--border-color)')}
                                    />
                                    <span style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', fontSize: '0.75rem', opacity: 0.5 }}>🔍</span>
                                </div>

                                {/* Status Filter Pills */}
                                <div style={{
                                    display: 'flex', gap: '2px', padding: '3px',
                                    background: 'var(--bg-elevated)', borderRadius: '10px'
                                }}>
                                    {[
                                        { key: 'ALL', label: 'Todas' },
                                        { key: 'PAID', label: 'Pagos' },
                                        { key: 'PENDING', label: 'Pendentes' },
                                        { key: 'FAILED', label: 'Falhos' },
                                    ].map(s => (
                                        <button key={s.key}
                                            onClick={() => setStatusFilter(s.key)}
                                            style={{
                                                padding: '5px 12px', borderRadius: '8px', fontSize: '0.75rem',
                                                fontWeight: statusFilter === s.key ? 700 : 500, border: 'none', cursor: 'pointer',
                                                background: statusFilter === s.key ? 'var(--bg-secondary)' : 'transparent',
                                                color: statusFilter === s.key ? 'var(--text-primary)' : 'var(--text-muted)',
                                                boxShadow: statusFilter === s.key ? '0 1px 3px rgba(0,0,0,0.2)' : 'none',
                                                transition: 'all 0.2s'
                                            }}
                                        >
                                            {s.label}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        </div>

                        {filteredPayments.length === 0 ? (
                            <div style={{ padding: '48px 20px', textAlign: 'center', color: 'var(--text-muted)' }}>
                                <div style={{ fontSize: '2.5rem', marginBottom: '12px', opacity: 0.4 }}>📭</div>
                                <div style={{ fontWeight: 600 }}>Nenhuma fatura encontrada</div>
                                <div style={{ fontSize: '0.8125rem', marginTop: '4px' }}>Tente ajustar os filtros ou período</div>
                            </div>
                        ) : (
                            <>
                                <div className="table-container" style={{ margin: 0 }}>
                                    <table>
                                        <thead>
                                            <tr>
                                                <th style={{ paddingLeft: '20px' }}>Cliente</th>
                                                <th>Contrato</th>
                                                <th>Vencimento</th>
                                                <th>Canal</th>
                                                <th style={{ textAlign: 'right' }}>Bruto</th>
                                                <th style={{ textAlign: 'right', color: '#ef4444' }}>Taxa</th>
                                                <th style={{ textAlign: 'right', color: '#10b981' }}>Líquido</th>
                                                <th style={{ textAlign: 'center' }}>Status</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {filteredPayments.map((p, i) => {
                                                const sc = STATUS_CONFIG[p.status] || STATUS_CONFIG.PENDING;
                                                return (
                                                    <tr key={p.id} style={{
                                                        background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)',
                                                        transition: 'background 0.15s'
                                                    }}
                                                    onMouseEnter={e => (e.currentTarget.style.background = 'rgba(16,185,129,0.04)')}
                                                    onMouseLeave={e => (e.currentTarget.style.background = i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)')}
                                                    >
                                                        <td style={{ paddingLeft: '20px' }}>
                                                            <div style={{ fontWeight: 600, fontSize: '0.875rem' }}>{p.user?.name || 'Removido'}</div>
                                                            <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', marginTop: '2px' }}>{p.user?.email}</div>
                                                        </td>
                                                        <td>
                                                            {p.contract ? (
                                                                <div>
                                                                    <div style={{ fontWeight: 500, fontSize: '0.8125rem' }}>{p.contract.name}</div>
                                                                    <span style={{
                                                                        display: 'inline-block', marginTop: '3px',
                                                                        padding: '1px 6px', borderRadius: '4px', fontSize: '0.625rem', fontWeight: 700,
                                                                        background: p.contract.tier === 'AUDIENCIA' ? 'rgba(139,92,246,0.15)' : p.contract.tier === 'SABADO' ? 'rgba(245,158,11,0.15)' : 'rgba(16,185,129,0.15)',
                                                                        color: p.contract.tier === 'AUDIENCIA' ? '#a78bfa' : p.contract.tier === 'SABADO' ? '#fbbf24' : '#34d399'
                                                                    }}>
                                                                        {p.contract.tier}
                                                                    </span>
                                                                </div>
                                                            ) : (
                                                                <span style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>Avulso</span>
                                                            )}
                                                        </td>
                                                        <td style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
                                                            {(p.dueDate ? new Date(p.dueDate) : new Date(p.createdAt)).toLocaleDateString('pt-BR', { timeZone: 'UTC' })}
                                                        </td>
                                                        <td>
                                                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                                                <span style={{ fontSize: '0.9375rem' }}>
                                                                    {p.methodEmoji || '💰'}
                                                                </span>
                                                                <div>
                                                                    <div style={{ fontSize: '0.8125rem', fontWeight: 500 }}>{p.methodLabel}</div>
                                                                    <div style={{ fontSize: '0.625rem', color: 'var(--text-muted)' }}>{p.provider}</div>
                                                                </div>
                                                            </div>
                                                        </td>
                                                        <td style={{ textAlign: 'right', fontWeight: 600, fontSize: '0.875rem', fontVariantNumeric: 'tabular-nums' }}>
                                                            {formatBRL(p.amount)}
                                                        </td>
                                                        <td style={{ textAlign: 'right', color: p.feeDeduced > 0 ? '#ef4444' : 'var(--text-muted)', fontSize: '0.8125rem', fontVariantNumeric: 'tabular-nums' }}>
                                                            {p.feeDeduced > 0 ? `− ${formatBRL(p.feeDeduced)}` : '—'}
                                                        </td>
                                                        <td style={{ textAlign: 'right', fontWeight: 700, fontSize: '0.875rem', color: p.status === 'PAID' ? '#10b981' : 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
                                                            {p.status === 'PAID' ? formatBRL(p.netAmount) : '—'}
                                                        </td>
                                                        <td style={{ textAlign: 'center' }}>
                                                            <span style={{
                                                                display: 'inline-flex', alignItems: 'center', gap: '4px',
                                                                padding: '4px 10px', borderRadius: '20px', fontSize: '0.6875rem', fontWeight: 700,
                                                                background: sc.bg, color: sc.color,
                                                                letterSpacing: '0.02em'
                                                            }}>
                                                                {sc.icon} {sc.label}
                                                            </span>
                                                        </td>
                                                    </tr>
                                                );
                                            })}
                                        </tbody>

                                        {/* TOTALS FOOTER */}
                                        {filteredTotals.gross > 0 && (
                                            <tfoot>
                                                <tr style={{ borderTop: '2px solid var(--border-color)', background: 'rgba(16,185,129,0.03)' }}>
                                                    <td colSpan={4} style={{ paddingLeft: '20px', fontWeight: 700, fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
                                                        TOTAL ({filteredPayments.filter(p => p.status === 'PAID').length} pagos)
                                                    </td>
                                                    <td style={{ textAlign: 'right', fontWeight: 800, fontSize: '0.9375rem', fontVariantNumeric: 'tabular-nums' }}>
                                                        {formatBRL(filteredTotals.gross)}
                                                    </td>
                                                    <td style={{ textAlign: 'right', fontWeight: 700, color: '#ef4444', fontSize: '0.8125rem', fontVariantNumeric: 'tabular-nums' }}>
                                                        − {formatBRL(filteredTotals.fees)}
                                                    </td>
                                                    <td style={{ textAlign: 'right', fontWeight: 800, color: '#10b981', fontSize: '0.9375rem', fontVariantNumeric: 'tabular-nums' }}>
                                                        {formatBRL(filteredTotals.net)}
                                                    </td>
                                                    <td />
                                                </tr>
                                            </tfoot>
                                        )}
                                    </table>
                                </div>
                            </>
                        )}
                    </div>
                </>
            )}
        </div>
    );
}

import { getErrorMessage } from '../utils/errors';
import React, { useState, useEffect, useMemo } from 'react';
import { Wallet, CheckCircle2, Clock } from 'lucide-react';
import { financeApi, FinanceClosingResponse, EnrichedPayment } from '../api/client';
import { useUI } from '../context/UIContext';
import AdminPageHeader from '../components/admin/AdminPageHeader';
import { HeroSkeleton, TableSkeleton } from '../components/ui/SkeletonLoader';
import StatusBadge from '../components/ui/StatusBadge';
import StatCard from '../components/ui/StatCard';
import { PAYMENT_STATUS_META, TIER_META, getMeta } from '../constants/adminMeta';

import { formatBRL } from '../utils/format';

const MONTHS = [
    'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
    'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'
];

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
        } catch (err: unknown) {
            showAlert({ message: getErrorMessage(err) || 'Erro ao carregar dados financeiros', type: 'error' });
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
            {/* --- HEADER --- */}
            <AdminPageHeader
                icon={Wallet}
                title="Financeiro"
                subtitle="Fechamento mensal e cobranças"
                actions={
                    /* Month Navigator */
                    <div style={{
                        display: 'flex', alignItems: 'center', gap: '0',
                        background: 'var(--bg-secondary)', borderRadius: '12px',
                        border: '1px solid var(--border-color)', overflow: 'hidden'
                    }}>
                        <button onClick={() => goMonth(-1)} aria-label="Mês anterior" className="admin-hover-bg" style={{
                            background: 'none', border: 'none', color: 'var(--text-secondary)',
                            padding: '10px 14px', minWidth: 44, minHeight: 44, cursor: 'pointer', fontSize: '1rem',
                        }}>
                            ‹
                        </button>
                        <div style={{
                            padding: '10px 20px', fontWeight: 700, fontSize: '0.9375rem',
                            color: 'var(--text-primary)', borderLeft: '1px solid var(--border-color)',
                            borderRight: '1px solid var(--border-color)', minWidth: '180px', textAlign: 'center',
                            background: isCurrentMonth ? 'rgba(16,185,129,0.06)' : 'none'
                        }}>
                            {MONTHS[selectedMonth - 1]} {selectedYear}
                            {isCurrentMonth && <span style={{ fontSize: '0.6875rem', color: 'var(--success)', display: 'block', fontWeight: 500 }}>Mês Atual</span>}
                        </div>
                        <button onClick={() => goMonth(1)} aria-label="Próximo mês" className="admin-hover-bg" style={{
                            background: 'none', border: 'none', color: 'var(--text-secondary)',
                            padding: '10px 14px', minWidth: 44, minHeight: 44, cursor: 'pointer', fontSize: '1rem',
                        }}>
                            ›
                        </button>
                    </div>
                }
            />

            {loading ? (
                <div><HeroSkeleton /><TableSkeleton rows={6} cols={8} /></div>
            ) : !data ? (
                <div className="empty-state">Nenhum dado encontrado para este período.</div>
            ) : (
                <>
                    {/* --- KPI HERO CARDS --- */}
                    <div className="admin-kpi-grid" style={{ marginBottom: '24px' }}>

                        {/* NET REVENUE */}
                        <StatCard
                            icon={Wallet}
                            label="Repasse Líquido"
                            value={formatBRL(data.metrics.netRevenue)}
                            detail={`Na conta do Estúdio ${isCurrentMonth ? '(parcial)' : ''}`.trim()}
                            accent="var(--success)"
                        />

                        {/* GROSS REVENUE / PAID */}
                        <StatCard
                            icon={CheckCircle2}
                            label="Faturamento Bruto"
                            value={formatBRL(data.metrics.grossRevenue)}
                            detail={`${data.metrics.paidCount} pagos`}
                            accent="var(--success)"
                        />

                        {/* FEES */}
                        <div style={{
                            padding: '24px', borderRadius: '16px',
                            background: 'var(--bg-secondary)', border: '1px solid var(--border-color)'
                        }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                                <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                                    Taxas Retidas
                                </div>
                                <span style={{ fontSize: '1.5rem', opacity: 0.6 }}>✂️</span>
                            </div>
                            <div style={{ fontSize: '1.875rem', fontWeight: 800, color: 'var(--danger)', marginTop: '10px' }}>
                                - {formatBRL(data.metrics.totalFees)}
                            </div>
                            <div style={{ marginTop: '10px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                                {data.metrics.breakdown.stripe > 0 && (
                                    <span style={{
                                        padding: '3px 8px', borderRadius: '6px', fontSize: '0.6875rem', fontWeight: 600,
                                        background: 'var(--info-bg)', color: 'var(--info)'
                                    }}>
                                        Stripe: {data.metrics.breakdown.stripe}
                                    </span>
                                )}
                                {data.metrics.breakdown.cora > 0 && (
                                    <span style={{
                                        padding: '3px 8px', borderRadius: '6px', fontSize: '0.6875rem', fontWeight: 600,
                                        background: 'var(--warning-bg)', color: 'var(--warning)'
                                    }}>
                                        Cora: {data.metrics.breakdown.cora}
                                    </span>
                                )}
                            </div>
                        </div>

                        {/* PENDING / OVERDUE */}
                        <StatCard
                            icon={Clock}
                            label={isCurrentMonth ? 'A Receber' : 'Inadimplência'}
                            value={data.metrics.pendingRevenue > 0 ? formatBRL(data.metrics.pendingRevenue) : 'R$ 0,00'}
                            detail={`${data.metrics.unpaidCount} pendente${data.metrics.unpaidCount !== 1 ? 's' : ''}`}
                            accent={data.metrics.pendingRevenue > 0 ? 'var(--warning)' : 'var(--success)'}
                        />
                    </div>

                    {/* --- COLLECTION RATE BAR --- */}
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
                            color: collectionRate >= 80 ? 'var(--success)' : collectionRate >= 50 ? 'var(--warning)' : 'var(--danger)'
                        }}>
                            {collectionRate}%
                        </div>
                    </div>

                    {/* --- INVOICES TABLE --- */}
                    <div style={{ borderRadius: '16px', border: '1px solid var(--border-color)', background: 'var(--bg-secondary)', overflow: 'hidden' }}>
                        
                        {/* Table Header */}
                        <div style={{
                            padding: '16px 20px', display: 'flex', flexWrap: 'wrap', gap: '12px',
                            justifyContent: 'space-between', alignItems: 'center',
                            borderBottom: '1px solid var(--border-color)'
                        }}>
                            <h3 style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--text-primary)', margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
                                📄 Faturas
                                <span style={{
                                    fontSize: '0.6875rem', fontWeight: 600, padding: '2px 8px',
                                    borderRadius: '10px', background: 'var(--bg-elevated)', color: 'var(--text-muted)'
                                }}>
                                    {filteredPayments.length}
                                </span>
                            </h3>

                            <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
                                {/* Search */}
                                <div className="admin-search" style={{ flex: 'none', minWidth: 180, maxWidth: 220 }}>
                                    <input
                                        type="text"
                                        placeholder="Buscar cliente..."
                                        aria-label="Buscar cliente"
                                        value={searchTerm}
                                        onChange={e => setSearchTerm(e.target.value)}
                                    />
                                    <span className="admin-search__icon" aria-hidden="true">🔎</span>
                                </div>

                                {/* Status Filter Pills */}
                                <div className="admin-segmented" role="group" aria-label="Filtrar por status">
                                    {[
                                        { key: 'ALL', label: 'Todas' },
                                        { key: 'PAID', label: 'Pagos' },
                                        { key: 'PENDING', label: 'Pendentes' },
                                        { key: 'FAILED', label: 'Falhos' },
                                    ].map(s => (
                                        <button key={s.key}
                                            onClick={() => setStatusFilter(s.key)}
                                            aria-pressed={statusFilter === s.key}
                                            className={`admin-segmented__btn${statusFilter === s.key ? ' admin-segmented__btn--active' : ''}`}
                                        >
                                            {s.label}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        </div>

                        {filteredPayments.length === 0 ? (
                            <div style={{ padding: '48px 20px', textAlign: 'center', color: 'var(--text-muted)' }}>
                                <div style={{ fontSize: '2.5rem', marginBottom: '12px', opacity: 0.4 }}>😴</div>
                                <div style={{ fontWeight: 600 }}>Nenhuma fatura encontrada</div>
                                <div style={{ fontSize: '0.8125rem', marginTop: '4px' }}>Tente ajustar os filtros ou período</div>
                            </div>
                        ) : (
                            <>
                                <div className="table-container" style={{ margin: 0 }}>
                                  <div className="admin-table-wrap">
                                    <table className="admin-table--cards">
                                        <thead>
                                            <tr>
                                                <th style={{ paddingLeft: '20px' }}>Cliente</th>
                                                <th>Contrato</th>
                                                <th>Vencimento</th>
                                                <th>Canal</th>
                                                <th style={{ textAlign: 'right' }}>Bruto</th>
                                                <th style={{ textAlign: 'right', color: 'var(--danger)' }}>Taxa</th>
                                                <th style={{ textAlign: 'right', color: 'var(--success)' }}>Líquido</th>
                                                <th style={{ textAlign: 'center' }}>Status</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {filteredPayments.map((p) => {
                                                return (
                                                    <tr key={p.id} className="admin-zebra-row">
                                                        <td className="admin-card-title" style={{ paddingLeft: '20px' }}>
                                                            <div style={{ fontWeight: 600, fontSize: '0.875rem' }}>{p.user?.name || 'Removido'}</div>
                                                            <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', marginTop: '2px' }}>{p.user?.email}</div>
                                                        </td>
                                                        <td data-label="Contrato">
                                                            {p.contract ? (
                                                                <div>
                                                                    <div style={{ fontWeight: 500, fontSize: '0.8125rem' }}>{p.contract.name}</div>
                                                                    <span style={{
                                                                        display: 'inline-block', marginTop: '3px',
                                                                        padding: '1px 6px', borderRadius: '4px', fontSize: '0.625rem', fontWeight: 700,
                                                                        background: getMeta(TIER_META, p.contract.tier).bg,
                                                                        color: getMeta(TIER_META, p.contract.tier).color
                                                                    }}>
                                                                        {p.contract.tier}
                                                                    </span>
                                                                </div>
                                                            ) : (
                                                                <span style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>Avulso</span>
                                                            )}
                                                        </td>
                                                        <td data-label="Vencimento" style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
                                                            {(p.dueDate ? new Date(p.dueDate) : new Date(p.createdAt)).toLocaleDateString('pt-BR', { timeZone: 'UTC' })}
                                                        </td>
                                                        <td data-label="Canal">
                                                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                                                <span style={{ fontSize: '0.9375rem' }}>
                                                                    {p.methodEmoji || '💳'}
                                                                </span>
                                                                <div>
                                                                    <div style={{ fontSize: '0.8125rem', fontWeight: 500 }}>{p.methodLabel}</div>
                                                                    <div style={{ fontSize: '0.625rem', color: 'var(--text-muted)' }}>{p.provider}</div>
                                                                </div>
                                                            </div>
                                                        </td>
                                                        <td data-label="Bruto" style={{ textAlign: 'right', fontWeight: 600, fontSize: '0.875rem', fontVariantNumeric: 'tabular-nums' }}>
                                                            {formatBRL(p.amount)}
                                                        </td>
                                                        <td data-label="Taxa" style={{ textAlign: 'right', color: p.feeDeduced > 0 ? 'var(--danger)' : 'var(--text-muted)', fontSize: '0.8125rem', fontVariantNumeric: 'tabular-nums' }}>
                                                            {p.feeDeduced > 0 ? `- ${formatBRL(p.feeDeduced)}` : '—'}
                                                        </td>
                                                        <td data-label="Líquido" style={{ textAlign: 'right', fontWeight: 700, fontSize: '0.875rem', color: p.status === 'PAID' ? 'var(--success)' : 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
                                                            {p.status === 'PAID' ? formatBRL(p.netAmount) : '—'}
                                                        </td>
                                                        <td data-label="Status" style={{ textAlign: 'center' }}>
                                                            <StatusBadge meta={getMeta(PAYMENT_STATUS_META, p.status)} size="md" />
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
                                                    <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--danger)', fontSize: '0.8125rem', fontVariantNumeric: 'tabular-nums' }}>
                                                        - {formatBRL(filteredTotals.fees)}
                                                    </td>
                                                    <td style={{ textAlign: 'right', fontWeight: 800, color: 'var(--success)', fontSize: '0.9375rem', fontVariantNumeric: 'tabular-nums' }}>
                                                        {formatBRL(filteredTotals.net)}
                                                    </td>
                                                    <td />
                                                </tr>
                                            </tfoot>
                                        )}
                                    </table>
                                  </div>
                                </div>
                                {/* tfoot some no modo cards (<768px) — resumo mobile */}
                                {filteredTotals.gross > 0 && (
                                    <div className="admin-mobile-totals">
                                        <div className="admin-mobile-totals__row">
                                            <span style={{ fontWeight: 700, color: 'var(--text-secondary)' }}>TOTAL ({filteredPayments.filter(p => p.status === 'PAID').length} pagos)</span>
                                            <span style={{ fontWeight: 800 }}>{formatBRL(filteredTotals.gross)}</span>
                                        </div>
                                        <div className="admin-mobile-totals__row">
                                            <span style={{ color: 'var(--text-muted)' }}>Taxas</span>
                                            <span style={{ fontWeight: 700, color: 'var(--danger)' }}>- {formatBRL(filteredTotals.fees)}</span>
                                        </div>
                                        <div className="admin-mobile-totals__row">
                                            <span style={{ color: 'var(--text-muted)' }}>Líquido</span>
                                            <span style={{ fontWeight: 800, color: 'var(--success)' }}>{formatBRL(filteredTotals.net)}</span>
                                        </div>
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                </>
            )}
        </div>
    );
}

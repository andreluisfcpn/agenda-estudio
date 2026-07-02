import { getErrorMessage } from '../utils/errors';
import { useState, useMemo } from 'react';
import { TicketPercent, CheckCircle, Clock, XCircle, Ban } from 'lucide-react';
import { couponsApi, Coupon } from '../api/client';
import { useUI } from '../context/UIContext';
import { useAdminCoupons, CouponStatusFilter } from '../hooks/useAdminCoupons';
import AdminPageHeader from '../components/admin/AdminPageHeader';
import CouponModal from '../components/admin/coupons/CouponModal';
import { HeroSkeleton, TableSkeleton } from '../components/ui/SkeletonLoader';
import StatusBadge from '../components/ui/StatusBadge';

import { formatBRL } from '../utils/format';

type CouponStatus = 'ACTIVE' | 'INACTIVE' | 'EXPIRED' | 'EXHAUSTED';

const COUPON_STATUS_META: Record<CouponStatus, { label: string; color: string; bg: string; icon: typeof CheckCircle }> = {
    ACTIVE:    { label: 'Ativo',    color: '#10b981', bg: 'rgba(16,185,129,0.1)',  icon: CheckCircle },
    INACTIVE:  { label: 'Inativo',  color: '#6b7280', bg: 'rgba(107,114,128,0.1)', icon: Ban },
    EXPIRED:   { label: 'Expirado', color: '#f59e0b', bg: 'rgba(245,158,11,0.1)',  icon: Clock },
    EXHAUSTED: { label: 'Esgotado', color: '#ef4444', bg: 'rgba(239,68,68,0.1)',   icon: XCircle },
};

/** Data-calendário de HOJE em São Paulo, como 'YYYY-MM-DD' (en-CA formata nesse padrão). */
function todaySP(): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
}

/** 'YYYY-MM-DD...' → 'dd/mm/aaaa' sem passar por new Date (evita fuso). */
function formatDateBR(iso: string): string {
    const [y, m, d] = iso.slice(0, 10).split('-');
    return `${d}/${m}/${y}`;
}

export default function AdminCouponsPage() {
    const { showToast, showConfirm } = useUI();
    const { coupons, loading, statusFilter, setStatusFilter, reload } = useAdminCoupons();

    const [showCreate, setShowCreate] = useState(false);
    const [editCoupon, setEditCoupon] = useState<Coupon | null>(null);

    // --- Derivação de status (client-side) ---
    const today = todaySP();
    const isExpired = (c: Coupon) => !!c.expiresAt && c.expiresAt.slice(0, 10) < today;
    const isExhausted = (c: Coupon) => c.maxUses != null && c.usedCount >= c.maxUses;
    const isActive = (c: Coupon) => c.active && !isExpired(c) && !isExhausted(c);
    const statusOf = (c: Coupon): CouponStatus =>
        isExhausted(c) ? 'EXHAUSTED' : isExpired(c) ? 'EXPIRED' : c.active ? 'ACTIVE' : 'INACTIVE';

    const activeCount = coupons.filter(isActive).length;
    const expiredCount = coupons.filter(isExpired).length;
    const exhaustedCount = coupons.filter(isExhausted).length;
    const totalUses = coupons.reduce((sum, c) => sum + c.usedCount, 0);

    const filtered = useMemo(() => {
        if (statusFilter === 'ACTIVE') return coupons.filter(isActive);
        if (statusFilter === 'EXPIRED') return coupons.filter(isExpired);
        if (statusFilter === 'EXHAUSTED') return coupons.filter(isExhausted);
        return coupons;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [coupons, statusFilter, today]);

    // --- Ações ---
    const handleToggle = async (c: Coupon) => {
        try {
            await couponsApi.update(c.id, { active: !c.active });
            await reload();
            showToast(c.active ? 'Cupom desativado.' : 'Cupom ativado.');
        } catch (err: unknown) {
            showToast({ message: getErrorMessage(err) || 'Erro ao atualizar cupom', type: 'error' });
        }
    };

    const confirmDelete = (c: Coupon) => {
        showConfirm({
            title: 'Excluir cupom?',
            message: `Essa ação não pode ser desfeita. O cupom ${c.code} será removido permanentemente.`,
            onConfirm: () => handleDelete(c),
        });
    };

    const handleDelete = async (c: Coupon) => {
        try {
            await couponsApi.remove(c.id);
            await reload();
            showToast('Cupom excluído.');
        } catch (err: unknown) {
            // Erro 409 (cupom já usado) e demais erros: mensagem do backend no toast.
            showToast({ message: getErrorMessage(err) || 'Erro ao excluir cupom', type: 'error' });
        }
    };

    if (loading) return <div><HeroSkeleton /><TableSkeleton rows={6} cols={7} /></div>;

    return (
        <div>
            {/* --- HEADER --- */}
            <AdminPageHeader
                icon={TicketPercent}
                title="Cupons"
                subtitle="Cupons de desconto para pagamentos"
                actions={
                    <button className="btn btn-primary" onClick={() => setShowCreate(true)}
                        style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '12px 24px', borderRadius: '12px', fontWeight: 700 }}>
                        <span style={{ fontSize: '1.1rem' }}>+</span> Novo Cupom
                    </button>
                }
            />

            {/* --- KPI CARDS --- */}
            <div className="admin-kpi-grid" style={{ marginBottom: '24px' }}>
                {([
                    { key: 'ALL' as CouponStatusFilter, label: 'Total', count: coupons.length, desc: 'cupons cadastrados', icon: '🎟️', color: '#6366f1', gradient: 'rgba(99,102,241,0.08)', clickable: true },
                    { key: 'ACTIVE' as CouponStatusFilter, label: 'Ativos', count: activeCount, desc: 'prontos para uso', icon: '✅', color: '#10b981', gradient: 'rgba(16,185,129,0.08)', clickable: true },
                    { key: 'EXPIRED' as CouponStatusFilter, label: 'Expirados', count: expiredCount, desc: 'validade vencida', icon: '⏰', color: '#f59e0b', gradient: 'rgba(245,158,11,0.08)', clickable: true },
                    { key: 'EXHAUSTED' as CouponStatusFilter, label: 'Esgotados', count: exhaustedCount, desc: 'limite de usos atingido', icon: '🚫', color: '#94a3b8', gradient: 'rgba(148,163,184,0.08)', clickable: true },
                    { key: 'USES' as const, label: 'Usos', count: totalUses, desc: 'usos registrados', icon: '📈', color: '#2dd4bf', gradient: 'rgba(45,212,191,0.08)', clickable: false },
                ]).map(card => {
                    const isSelected = card.clickable && statusFilter === card.key;
                    return (
                        <div key={card.key}
                            onClick={card.clickable ? () => setStatusFilter(isSelected ? 'ALL' : card.key as CouponStatusFilter) : undefined}
                            style={{
                                padding: '18px 16px', borderRadius: '14px', cursor: card.clickable ? 'pointer' : 'default',
                                background: isSelected ? `linear-gradient(135deg, ${card.gradient}, ${card.gradient.replace('0.08', '0.02')})` : 'var(--bg-secondary)',
                                border: `1px solid ${isSelected ? card.color + '44' : 'var(--border-color)'}`,
                                transition: 'all 0.25s ease',
                                position: 'relative', overflow: 'hidden',
                            }}
                            onMouseEnter={e => { if (card.clickable && !isSelected) e.currentTarget.style.borderColor = card.color + '33'; }}
                            onMouseLeave={e => { if (card.clickable && !isSelected) e.currentTarget.style.borderColor = 'var(--border-color)'; }}
                        >
                            {/* Top row: icon + label */}
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' }}>
                                <span style={{ fontSize: '0.9rem' }}>{card.icon}</span>
                                <span style={{
                                    fontSize: '0.6875rem', fontWeight: 700, color: isSelected ? card.color : 'var(--text-muted)',
                                    textTransform: 'uppercase', letterSpacing: '0.08em',
                                    transition: 'color 0.2s',
                                }}>{card.label}</span>
                            </div>
                            {/* Count */}
                            <div style={{
                                fontSize: '1.75rem', fontWeight: 800, color: 'var(--text-primary)',
                                fontVariantNumeric: 'tabular-nums', lineHeight: 1, marginBottom: '4px',
                            }}>{card.count}</div>
                            {/* Description */}
                            <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', lineHeight: 1.3 }}>{card.desc}</div>
                            {/* Active indicator bar */}
                            {isSelected && (
                                <div style={{
                                    position: 'absolute', bottom: 0, left: '16px', right: '16px', height: '2px',
                                    background: `linear-gradient(90deg, ${card.color}, transparent)`,
                                    borderRadius: '2px',
                                }} />
                            )}
                        </div>
                    );
                })}
            </div>

            {/* --- FILTER INFO BAR --- */}
            {statusFilter !== 'ALL' && (
                <div style={{
                    padding: '12px 16px', borderRadius: '12px', marginBottom: '16px',
                    background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
                    display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap'
                }}>
                    <button onClick={() => setStatusFilter('ALL')} style={{
                        display: 'flex', alignItems: 'center', gap: '6px',
                        padding: '5px 12px', borderRadius: '8px', fontSize: '0.75rem', fontWeight: 600,
                        background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.15)',
                        color: '#ef4444', cursor: 'pointer', transition: 'all 0.2s'
                    }}>
                        🗑️ Limpar filtro
                    </button>
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', padding: '4px 10px', background: 'var(--bg-elevated)', borderRadius: '8px' }}>
                        {filtered.length} resultado{filtered.length !== 1 ? 's' : ''}
                    </span>
                </div>
            )}

            {/* --- COUPONS TABLE --- */}
            <div style={{ borderRadius: '16px', border: '1px solid var(--border-color)', background: 'var(--bg-secondary)', overflow: 'hidden' }}>
                {filtered.length === 0 ? (
                    <div style={{ padding: '48px 20px', textAlign: 'center', color: 'var(--text-muted)' }}>
                        <div style={{ fontSize: '2.5rem', marginBottom: '12px', opacity: 0.4 }}>🎟️</div>
                        <div style={{ fontWeight: 600 }}>Nenhum cupom encontrado</div>
                        <div style={{ fontSize: '0.8125rem', marginTop: '4px' }}>
                            {coupons.length === 0 ? 'Crie seu primeiro cupom de desconto' : 'Tente ajustar os filtros'}
                        </div>
                    </div>
                ) : (
                    <div className="table-container" style={{ margin: 0 }}>
                        <div className="admin-table-wrap">
                        <table className="admin-table--cards">
                            <thead>
                                <tr>
                                    <th style={{ paddingLeft: '20px' }}>Código</th>
                                    <th>Desconto</th>
                                    <th>Elegibilidade</th>
                                    <th>Validade</th>
                                    <th style={{ textAlign: 'center' }}>Usos</th>
                                    <th>Status</th>
                                    <th style={{ textAlign: 'center' }}>Ações</th>
                                </tr>
                            </thead>
                            <tbody>
                                {filtered.map((c, i) => {
                                    const status = statusOf(c);
                                    const meta = COUPON_STATUS_META[status];
                                    const expired = isExpired(c);
                                    return (
                                        <tr key={c.id}
                                            style={{
                                                background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)',
                                                transition: 'background 0.15s'
                                            }}
                                            onMouseEnter={e => (e.currentTarget.style.background = 'rgba(99,102,241,0.04)')}
                                            onMouseLeave={e => (e.currentTarget.style.background = i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)')}
                                        >
                                            {/* Código */}
                                            <td className="admin-card-title" style={{ paddingLeft: '20px' }}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                                                    <div style={{
                                                        width: '40px', height: '40px', borderRadius: '12px',
                                                        background: meta.bg,
                                                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                        fontSize: '1rem', flexShrink: 0,
                                                        border: `1px solid ${meta.color}22`,
                                                    }}>🎟️</div>
                                                    <div style={{ minWidth: 0 }}>
                                                        <div style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: '0.875rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-primary)' }}>
                                                            {c.code}
                                                        </div>
                                                        {c.description && (
                                                            <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '220px' }}>
                                                                {c.description}
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>
                                            </td>

                                            {/* Desconto */}
                                            <td data-label="Desconto">
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                                                    <span style={{ fontWeight: 700, fontSize: '0.875rem', color: '#818cf8', fontVariantNumeric: 'tabular-nums' }}>
                                                        {c.discountType === 'VALOR' ? formatBRL(c.discountValue) : `${c.discountValue}%`}
                                                    </span>
                                                    {c.scope === 'ALL_INSTALLMENTS' && (
                                                        <span style={{
                                                            fontSize: '0.5625rem', fontWeight: 700, padding: '2px 8px', borderRadius: '999px',
                                                            background: 'rgba(129,140,248,0.1)', border: '1px solid rgba(129,140,248,0.2)', color: '#818cf8',
                                                            textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap',
                                                        }}>
                                                            todas as parcelas
                                                        </span>
                                                    )}
                                                </div>
                                                {c.minAmount != null && c.minAmount > 0 && (
                                                    <div style={{ fontSize: '0.625rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                                                        mín. {formatBRL(c.minAmount)}
                                                    </div>
                                                )}
                                            </td>

                                            {/* Elegibilidade */}
                                            <td data-label="Elegibilidade">
                                                {c.onlyNewClients ? (
                                                    <span style={{
                                                        fontSize: '0.6875rem', fontWeight: 600, padding: '3px 10px', borderRadius: '999px',
                                                        background: 'rgba(236,72,153,0.1)', border: '1px solid rgba(236,72,153,0.2)', color: '#ec4899',
                                                        whiteSpace: 'nowrap',
                                                    }}>
                                                        ✨ Só novos clientes
                                                    </span>
                                                ) : c.eligibleUsers.length > 0 ? (
                                                    <span
                                                        title={c.eligibleUsers.map(u => u.name).join(', ')}
                                                        style={{
                                                            fontSize: '0.6875rem', fontWeight: 600, padding: '3px 10px', borderRadius: '999px',
                                                            background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.2)', color: '#6366f1',
                                                            whiteSpace: 'nowrap', cursor: 'help',
                                                        }}>
                                                        🎯 {c.eligibleUsers.length} cliente{c.eligibleUsers.length !== 1 ? 's' : ''}
                                                    </span>
                                                ) : (
                                                    <span style={{
                                                        fontSize: '0.6875rem', fontWeight: 600, padding: '3px 10px', borderRadius: '999px',
                                                        background: 'rgba(148,163,184,0.1)', border: '1px solid rgba(148,163,184,0.2)', color: 'var(--text-secondary)',
                                                        whiteSpace: 'nowrap',
                                                    }}>
                                                        👥 Todos
                                                    </span>
                                                )}
                                            </td>

                                            {/* Validade */}
                                            <td data-label="Validade">
                                                {c.expiresAt ? (
                                                    <div style={{ fontSize: '0.75rem', fontWeight: expired ? 700 : 400, color: expired ? '#f59e0b' : 'var(--text-secondary)' }}>
                                                        {formatDateBR(c.expiresAt)}
                                                        {expired && <div style={{ fontSize: '0.625rem', fontWeight: 600 }}>vencido</div>}
                                                    </div>
                                                ) : (
                                                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Sem validade</span>
                                                )}
                                            </td>

                                            {/* Usos */}
                                            <td data-label="Usos" style={{ textAlign: 'center' }}>
                                                <div style={{ fontWeight: 700, fontSize: '0.875rem', fontVariantNumeric: 'tabular-nums' }}>
                                                    {c.usedCount}/{c.maxUses != null ? c.maxUses : '∞'}
                                                </div>
                                                {c.maxUsesPerUser != null && (
                                                    <div style={{ fontSize: '0.625rem', color: 'var(--text-muted)' }}>
                                                        máx. {c.maxUsesPerUser}/cliente
                                                    </div>
                                                )}
                                            </td>

                                            {/* Status */}
                                            <td data-label="Status">
                                                <StatusBadge meta={meta} />
                                            </td>

                                            {/* Ações */}
                                            <td data-label="" style={{ textAlign: 'center' }}>
                                                <div style={{ display: 'flex', gap: '4px', justifyContent: 'center' }}>
                                                    <button style={{
                                                        background: 'var(--bg-elevated)', border: '1px solid var(--border-color)',
                                                        color: 'var(--text-secondary)', padding: '6px 10px', borderRadius: '8px',
                                                        cursor: 'pointer', fontSize: '0.8125rem', transition: 'all 0.2s'
                                                    }}
                                                    onMouseEnter={e => { e.currentTarget.style.borderColor = '#6366f1'; e.currentTarget.style.color = '#6366f1'; }}
                                                    onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border-color)'; e.currentTarget.style.color = 'var(--text-secondary)'; }}
                                                    title="Editar"
                                                    onClick={() => setEditCoupon(c)}>✏️</button>

                                                    <button style={{
                                                        background: 'var(--bg-elevated)', border: '1px solid var(--border-color)',
                                                        color: 'var(--text-secondary)', padding: '6px 10px', borderRadius: '8px',
                                                        cursor: 'pointer', fontSize: '0.8125rem', transition: 'all 0.2s'
                                                    }}
                                                    onMouseEnter={e => { e.currentTarget.style.borderColor = c.active ? '#f59e0b' : '#10b981'; e.currentTarget.style.color = c.active ? '#f59e0b' : '#10b981'; }}
                                                    onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border-color)'; e.currentTarget.style.color = 'var(--text-secondary)'; }}
                                                    title={c.active ? 'Desativar' : 'Ativar'}
                                                    onClick={() => handleToggle(c)}>{c.active ? '⏸️' : '▶️'}</button>

                                                    <button style={{
                                                        background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.15)',
                                                        color: '#ef4444', padding: '6px 10px', borderRadius: '8px',
                                                        cursor: 'pointer', fontSize: '0.8125rem', transition: 'all 0.2s', opacity: 0.7
                                                    }}
                                                    onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
                                                    onMouseLeave={e => (e.currentTarget.style.opacity = '0.7')}
                                                    title="Excluir"
                                                    onClick={() => confirmDelete(c)}>🗑️</button>
                                                </div>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                        </div>
                    </div>
                )}
            </div>

            {/* --- MODALS --- */}
            {showCreate && (
                <CouponModal
                    onClose={() => setShowCreate(false)}
                    onSaved={reload}
                />
            )}

            {editCoupon && (
                <CouponModal
                    coupon={editCoupon}
                    onClose={() => setEditCoupon(null)}
                    onSaved={reload}
                />
            )}
        </div>
    );
}

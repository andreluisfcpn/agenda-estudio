import { getErrorMessage } from '../utils/errors';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { contractsApi, Contract } from '../api/client';
import { useBusinessConfig } from '../hooks/useBusinessConfig';
import { useUI } from '../context/UIContext';
import { FileText } from 'lucide-react';
import BottomSheetModal from '../components/BottomSheetModal';
import AdminPageHeader from '../components/admin/AdminPageHeader';
import { HeroSkeleton, TableSkeleton } from '../components/ui/SkeletonLoader';
import StatusBadge from '../components/ui/StatusBadge';
import { CONTRACT_STATUS_META, CONTRACT_TYPE_META, getMeta } from '../constants/adminMeta';
import { getPaymentMethods, getPaymentBadge } from '../constants/paymentMethods';
import { useAdminContracts } from '../hooks/useAdminContracts';
import CreateContractModal from '../components/admin/contracts/CreateContractModal';
import CustomContractModal from '../components/admin/contracts/CustomContractModal';

export default function AdminContractsPage() {
    const navigate = useNavigate();
    const { showAlert, showConfirm, showToast } = useUI();
    const {
        contracts,
        users,
        pricing,
        loading,
        filter, setFilter,
        search, setSearch,
        reload,
    } = useAdminContracts();

    const [showCreate, setShowCreate] = useState(false);


    const [editContract, setEditContract] = useState<Contract | null>(null);
    const [editForm, setEditForm] = useState({ status: '', endDate: '', flexCreditsRemaining: '', contractUrl: '', paymentMethod: '', boletoAllowed: false });
    const [editError, setEditError] = useState('');

    // --- Custom Contract Wizard ---
    const [showCustom, setShowCustom] = useState(false);

    const { get: getRule } = useBusinessConfig();
    const ep3 = getRule('episodes_3months');
    const ep6 = getRule('episodes_6months');
    const cancFine = getRule('cancellation_fine_pct');

    const handleEdit = async () => {
        if (!editContract) return;
        setEditError('');
        try {
            const data: any = {};
            if (editForm.status) data.status = editForm.status;
            if (editForm.endDate) data.endDate = editForm.endDate;
            if (editForm.flexCreditsRemaining !== '') data.flexCreditsRemaining = Number(editForm.flexCreditsRemaining);
            if (editForm.contractUrl !== (editContract.contractUrl || '')) data.contractUrl = editForm.contractUrl;
            if (editForm.paymentMethod && editForm.paymentMethod !== (editContract.paymentMethod || '')) data.paymentMethod = editForm.paymentMethod;
            if (editForm.boletoAllowed !== (editContract.boletoAllowed ?? false)) data.boletoAllowed = editForm.boletoAllowed;
            await contractsApi.update(editContract.id, data);
            setEditContract(null);
            await reload();
        } catch (err: unknown) { setEditError(getErrorMessage(err)); }
    };

    const handleCancel = (id: string) => {
        showConfirm({
            title: 'Cancelar contrato?',
            message: 'Deseja forçar o cancelamento deste contrato agora? Todos os agendamentos futuros não realizados também serão cancelados.',
            onConfirm: () => doCancel(id),
        });
    };

    const doCancel = async (id: string) => {
        try {
            await contractsApi.cancel(id);
            showToast('Contrato cancelado com sucesso.');
            await reload();
        } catch (err: unknown) { showAlert({ message: getErrorMessage(err), type: 'error' }); }
    };

    const handleResolveCancel = (id: string, action: 'CHARGE_FEE' | 'WAIVE_FEE') => {
        showConfirm({
            title: action === 'CHARGE_FEE' ? 'Aplicar multa?' : 'Isentar multa?',
            message: action === 'CHARGE_FEE'
                ? `Tem certeza que deseja quebrar o contrato aplicando a MULTA INTEGRAL DE ${cancFine}% sobre o restante?`
                : 'Tem certeza que deseja ISENTAR a multa e aceitar o cancelamento de modo amigável?',
            onConfirm: () => doResolveCancel(id, action),
        });
    };

    const doResolveCancel = async (id: string, action: 'CHARGE_FEE' | 'WAIVE_FEE') => {
        try {
            const res = await contractsApi.resolveCancellation(id, action);
            showToast(res.message);
            await reload();
        } catch (err: unknown) { showAlert({ message: getErrorMessage(err), type: 'error' }); }
    };

    const statusFiltered = filter === 'ALL' ? contracts : contracts.filter(c => c.status === filter);
    const filtered = search.trim().length >= 3
        ? statusFiltered.filter(c => {
            const q = search.toLowerCase();
            return (c.user?.name || '').toLowerCase().includes(q) || c.name.toLowerCase().includes(q);
        })
        : statusFiltered;
    const episodeCount = (months: number) => months === 3 ? ep3 : ep6;

    const getDaysToExpiry = (endDate: string) => {
        const now = new Date();
        const end = new Date(endDate);
        return Math.ceil((end.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    };

    const getVencimentoBadge = (c: { status: string; endDate: string }) => {
        if (c.status !== 'ACTIVE') return null;
        const days = getDaysToExpiry(c.endDate);
        if (days <= 0) return { label: 'Expirado', color: '#6b7280', bg: 'rgba(107,114,128,0.15)' };
        if (days <= 7) return { label: `${days}d`, color: '#dc2626', bg: 'rgba(220,38,38,0.15)' };
        if (days <= 30) return { label: `${days}d`, color: '#d97706', bg: 'rgba(217,119,6,0.15)' };
        return null;
    };

    // KPI computations
    const activeContracts = contracts.filter(c => c.status === 'ACTIVE');
    const totalFlexCredits = activeContracts.reduce((sum, c) => sum + (c.flexCreditsRemaining || 0), 0);
    const expiringIn30 = activeContracts.filter(c => getDaysToExpiry(c.endDate) <= 30 && getDaysToExpiry(c.endDate) > 0).length;
    const pendingCancellation = contracts.filter(c => c.status === 'PENDING_CANCELLATION').length;

    if (loading) return <div><HeroSkeleton /><TableSkeleton rows={6} cols={7} /></div>;

    return (
        <div>
            {/* --- HEADER --- */}
            <AdminPageHeader
                icon={FileText}
                title="Contratos"
                subtitle="Gestão do ciclo de vida dos contratos"
                actions={
                    <>
                        <button className="btn btn-primary" onClick={() => { setShowCreate(true); }}
                            style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '12px 24px', borderRadius: '12px', fontWeight: 700 }}>
                            <span style={{ fontSize: '1.1rem' }}>+</span> Novo Contrato
                        </button>
                        <button onClick={() => { setShowCustom(true); }}
                            style={{
                                display: 'flex', alignItems: 'center', gap: '8px', padding: '12px 24px', borderRadius: '12px', fontWeight: 700,
                                background: 'linear-gradient(135deg, rgba(45,212,191,0.15), rgba(59,130,246,0.1))',
                                border: '1px solid rgba(45,212,191,0.3)', color: '#2dd4bf', cursor: 'pointer',
                                fontSize: '0.875rem', transition: 'all 0.2s',
                            }}>
                            <span style={{ fontSize: '1.1rem' }}>✨</span> Contrato Personalizado
                        </button>
                    </>
                }
            />

            {/* --- KPI CARDS --- */}
            <div className="admin-kpi-grid" style={{ marginBottom: '24px' }}>
                {/* Active */}
                <div onClick={() => setFilter('ACTIVE')} style={{
                    padding: '20px', borderRadius: '14px', cursor: 'pointer',
                    background: filter === 'ACTIVE' ? 'linear-gradient(135deg, rgba(16,185,129,0.12), rgba(6,78,59,0.08))' : 'var(--bg-secondary)',
                    border: filter === 'ACTIVE' ? '1px solid rgba(16,185,129,0.3)' : '1px solid var(--border-color)',
                    transition: 'all 0.2s'
                }}>
                    <div style={{ fontSize: '0.6875rem', fontWeight: 700, color: '#10b981', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '6px' }}>Ativos</div>
                    <div style={{ fontSize: '2rem', fontWeight: 800, color: 'var(--text-primary)' }}>{activeContracts.length}</div>
                    <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', marginTop: '4px' }}>contratos em vigor</div>
                </div>
                {/* Pending Cancellation */}
                <div onClick={() => setFilter('PENDING_CANCELLATION')} style={{
                    padding: '20px', borderRadius: '14px', cursor: 'pointer',
                    background: filter === 'PENDING_CANCELLATION' ? 'linear-gradient(135deg, rgba(245,158,11,0.12), rgba(120,53,15,0.08))' : 'var(--bg-secondary)',
                    border: filter === 'PENDING_CANCELLATION' ? '1px solid rgba(245,158,11,0.3)' : '1px solid var(--border-color)',
                    transition: 'all 0.2s'
                }}>
                    <div style={{ fontSize: '0.6875rem', fontWeight: 700, color: '#f59e0b', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '6px' }}>Pend. Cancelamento</div>
                    <div style={{ fontSize: '2rem', fontWeight: 800, color: pendingCancellation > 0 ? '#f59e0b' : 'var(--text-primary)' }}>{pendingCancellation}</div>
                    <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', marginTop: '4px' }}>a resolver</div>
                </div>
                {/* Flex Credits */}
                <div style={{
                    padding: '20px', borderRadius: '14px',
                    background: 'var(--bg-secondary)', border: '1px solid var(--border-color)'
                }}>
                    <div style={{ fontSize: '0.6875rem', fontWeight: 700, color: 'var(--accent-primary)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '6px' }}>Créditos Flex</div>
                    <div style={{ fontSize: '2rem', fontWeight: 800, color: 'var(--text-primary)' }}>{totalFlexCredits}</div>
                    <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', marginTop: '4px' }}>episódios restantes</div>
                </div>
                {/* Expiring */}
                <div style={{
                    padding: '20px', borderRadius: '14px',
                    background: expiringIn30 > 0 ? 'linear-gradient(135deg, rgba(239,68,68,0.06), rgba(220,38,38,0.04))' : 'var(--bg-secondary)',
                    border: expiringIn30 > 0 ? '1px solid rgba(239,68,68,0.2)' : '1px solid var(--border-color)'
                }}>
                    <div style={{ fontSize: '0.6875rem', fontWeight: 700, color: expiringIn30 > 0 ? '#ef4444' : 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '6px' }}>Vencendo (30d)</div>
                    <div style={{ fontSize: '2rem', fontWeight: 800, color: expiringIn30 > 0 ? '#ef4444' : 'var(--text-primary)' }}>{expiringIn30}</div>
                    <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', marginTop: '4px' }}>atenção necessária</div>
                </div>
                {/* Total */}
                <div onClick={() => setFilter('ALL')} style={{
                    padding: '20px', borderRadius: '14px', cursor: 'pointer',
                    background: filter === 'ALL' ? 'linear-gradient(135deg, rgba(99,102,241,0.08), rgba(67,56,202,0.04))' : 'var(--bg-secondary)',
                    border: filter === 'ALL' ? '1px solid rgba(99,102,241,0.25)' : '1px solid var(--border-color)',
                    transition: 'all 0.2s'
                }}>
                    <div style={{ fontSize: '0.6875rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '6px' }}>Total</div>
                    <div style={{ fontSize: '2rem', fontWeight: 800, color: 'var(--text-primary)' }}>{contracts.length}</div>
                    <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', marginTop: '4px' }}>todos os contratos</div>
                </div>
            </div>

            {/* --- SEARCH + FILTERS --- */}
            <div style={{
                padding: '12px 16px', borderRadius: '12px', marginBottom: '16px',
                background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
                display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap'
            }}>
                <div style={{ position: 'relative', flex: 1, minWidth: '200px' }}>
                    <input
                        type="text" placeholder="Buscar por projeto ou cliente..."
                        value={search} onChange={e => setSearch(e.target.value)}
                        style={{
                            width: '100%', padding: '8px 12px 8px 32px', borderRadius: '8px', fontSize: '0.8125rem',
                            background: 'var(--bg-elevated)', border: '1px solid var(--border-color)',
                            color: 'var(--text-primary)', outline: 'none', transition: 'border-color 0.2s'
                        }}
                        onFocus={e => (e.currentTarget.style.borderColor = '#10b981')}
                        onBlur={e => (e.currentTarget.style.borderColor = 'var(--border-color)')}
                    />
                    <span style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', fontSize: '0.75rem', opacity: 0.5, pointerEvents: 'none' }}>🔎</span>
                </div>
                {search && <button onClick={() => setSearch('')} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '1rem' }}>✕</button>}

                <div style={{ display: 'flex', gap: '2px', padding: '3px', background: 'var(--bg-elevated)', borderRadius: '10px' }}>
                    {([
                        { key: 'ALL', label: 'Todos' },
                        { key: 'ACTIVE', label: 'Ativos' },
                        { key: 'PAUSED', label: 'Pausados' },
                        { key: 'EXPIRED', label: 'Expirados' },
                        { key: 'CANCELLED', label: 'Cancelados' },
                    ] as const).map(s => (
                        <button key={s.key}
                            onClick={() => setFilter(s.key)}
                            style={{
                                padding: '5px 12px', borderRadius: '8px', fontSize: '0.75rem',
                                fontWeight: filter === s.key ? 700 : 500, border: 'none', cursor: 'pointer',
                                background: filter === s.key ? 'var(--bg-secondary)' : 'transparent',
                                color: filter === s.key ? 'var(--text-primary)' : 'var(--text-muted)',
                                boxShadow: filter === s.key ? '0 1px 3px rgba(0,0,0,0.2)' : 'none',
                                transition: 'all 0.2s'
                            }}
                        >
                            {s.label}
                        </button>
                    ))}
                </div>

                {search.trim().length >= 3 && (
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', padding: '4px 10px', background: 'var(--bg-elevated)', borderRadius: '8px' }}>
                        {filtered.length} resultado{filtered.length !== 1 ? 's' : ''}
                    </span>
                )}
            </div>

            {/* --- CONTRACTS TABLE --- */}
            <div style={{ borderRadius: '16px', border: '1px solid var(--border-color)', background: 'var(--bg-secondary)', overflow: 'hidden' }}>
                {filtered.length === 0 ? (
                    <div style={{ padding: '48px 20px', textAlign: 'center', color: 'var(--text-muted)' }}>
                        <div style={{ fontSize: '2.5rem', marginBottom: '12px', opacity: 0.4 }}>📭</div>
                        <div style={{ fontWeight: 600 }}>Nenhum contrato encontrado</div>
                        <div style={{ fontSize: '0.8125rem', marginTop: '4px' }}>Tente ajustar os filtros ou busca</div>
                    </div>
                ) : (
                    <div className="table-container admin-table-wrap" style={{ margin: 0 }}>
                        <table className="admin-table--cards">
                            <thead>
                                <tr>
                                    <th style={{ paddingLeft: '20px' }}>Cliente / Projeto</th>
                                    <th>Tipo</th>
                                    <th>Gravações</th>
                                    <th>Pagamento</th>
                                    <th>Vigência</th>
                                    <th style={{ textAlign: 'center' }}>Status</th>
                                    <th style={{ textAlign: 'center' }}>Ações</th>
                                </tr>
                            </thead>
                            <tbody>
                                {filtered.map((c, i) => {
                                    const venc = getVencimentoBadge(c);
                                    return (
                                        <tr key={c.id}
                                            style={{
                                                background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)',
                                                transition: 'background 0.15s'
                                            }}
                                            onMouseEnter={e => (e.currentTarget.style.background = 'rgba(16,185,129,0.04)')}
                                            onMouseLeave={e => (e.currentTarget.style.background = i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)')}
                                        >
                                            {/* Cliente + Projeto merged */}
                                            <td className="admin-card-title" style={{ paddingLeft: '20px' }}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                                    <div style={{
                                                        width: '36px', height: '36px', borderRadius: '10px',
                                                        background: c.tier === 'AUDIENCIA' ? 'rgba(45,212,191,0.15)' : c.tier === 'SABADO' ? 'rgba(245,158,11,0.15)' : 'rgba(16,185,129,0.15)',
                                                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                        fontSize: '0.9375rem', flexShrink: 0
                                                    }}>
                                                        {(() => { const TI = getMeta(CONTRACT_TYPE_META, c.type).icon; return <TI size={17} />; })()}
                                                    </div>
                                                    <div>
                                                        <div style={{ fontWeight: 600, fontSize: '0.875rem', cursor: 'pointer', color: 'var(--accent-primary)' }}
                                                            onClick={() => c.user?.id && navigate(`/admin/clients/${c.user.id}`)}>
                                                            {c.user?.name || '—'}
                                                        </div>
                                                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '1px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                                            <span style={{ cursor: 'pointer' }} onClick={() => navigate(`/admin/contracts/${c.id}`)} title="Abrir contrato">{c.name}</span>
                                                            {c.contractUrl && <a href={c.contractUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent-primary)', fontSize: '0.65rem' }} title="Contrato digital">🔗</a>}
                                                        </div>
                                                    </div>
                                                </div>
                                            </td>

                                            {/* Type + Tier */}
                                            <td data-label="Tipo">
                                                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                                    <StatusBadge meta={getMeta(CONTRACT_TYPE_META, c.type)} />
                                                    <span style={{
                                                        padding: '2px 8px', borderRadius: '6px', fontSize: '0.625rem', fontWeight: 700,
                                                        background: c.tier === 'AUDIENCIA' ? 'rgba(45,212,191,0.15)' : c.tier === 'SABADO' ? 'rgba(245,158,11,0.15)' : 'rgba(16,185,129,0.15)',
                                                        color: c.tier === 'AUDIENCIA' ? '#2dd4bf' : c.tier === 'SABADO' ? '#fbbf24' : '#34d399',
                                                        width: 'fit-content'
                                                    }}>
                                                        {c.tier}
                                                    </span>
                                                </div>
                                            </td>

                                            {/* Episodes */}
                                            <td data-label="Gravações">
                                                <div style={{ fontWeight: 700, fontSize: '0.9375rem' }}>{episodeCount(c.durationMonths)}</div>
                                                <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)' }}>
                                                    {c.durationMonths}m · {c.discountPct}% desc
                                                </div>
                                                {c.type === 'FLEX' && c.flexCreditsRemaining != null && (
                                                    <div style={{
                                                        marginTop: '4px', fontSize: '0.625rem', fontWeight: 600,
                                                        color: c.flexCreditsRemaining > 0 ? '#10b981' : '#ef4444',
                                                        display: 'flex', alignItems: 'center', gap: '3px'
                                                    }}>
                                                        <span style={{
                                                            width: '6px', height: '6px', borderRadius: '50%',
                                                            background: c.flexCreditsRemaining > 0 ? '#10b981' : '#ef4444'
                                                        }} />
                                                        {c.flexCreditsRemaining} restante{c.flexCreditsRemaining !== 1 ? 's' : ''}
                                                    </div>
                                                )}
                                            </td>

                                            {/* Payment */}
                                            <td data-label="Pagamento">
                                                {c.paymentMethod ? (() => {
                                                    const pmBadge = getPaymentBadge(c.paymentMethod);
                                                    return (
                                                        <span style={{
                                                            display: 'inline-flex', alignItems: 'center', gap: '4px',
                                                            padding: '3px 8px', borderRadius: '6px', fontSize: '0.6875rem', fontWeight: 600,
                                                            background: 'var(--bg-elevated)', color: 'var(--text-secondary)'
                                                        }}>
                                                            {pmBadge.emoji}
                                                            {pmBadge.label}
                                                        </span>
                                                    );
                                                })() : <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>—</span>}
                                            </td>

                                            {/* Vigência */}
                                            <td data-label="Vigência">
                                                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                                                    {new Date(c.startDate).toLocaleDateString('pt-BR', { timeZone: 'UTC' })} – {new Date(c.endDate).toLocaleDateString('pt-BR', { timeZone: 'UTC' })}
                                                </div>
                                                {venc && (
                                                    <span style={{
                                                        display: 'inline-flex', alignItems: 'center', gap: '3px',
                                                        marginTop: '4px', fontSize: '0.625rem', fontWeight: 700,
                                                        color: venc.color, background: venc.bg,
                                                        padding: '2px 8px', borderRadius: '10px'
                                                    }}>
                                                        ⏰ Vence em {venc.label}
                                                    </span>
                                                )}
                                            </td>

                                            {/* Status */}
                                            <td data-label="Status" style={{ textAlign: 'center' }}>
                                                <StatusBadge meta={getMeta(CONTRACT_STATUS_META, c.status)} size="md" />
                                            </td>

                                            {/* Actions */}
                                            <td data-label="" style={{ textAlign: 'center' }}>
                                                <div style={{ display: 'flex', gap: '4px', justifyContent: 'center', flexWrap: 'wrap' }}>
                                                    <button className="btn btn-ghost btn-sm" title="Abrir contrato" style={{ fontSize: '0.8125rem', padding: '4px 8px', borderRadius: '8px' }}
                                                        onClick={() => navigate(`/admin/contracts/${c.id}`)}>📂</button>
                                                    <button className="btn btn-ghost btn-sm" title="Editar" style={{ fontSize: '0.8125rem', padding: '4px 8px', borderRadius: '8px' }}
                                                        onClick={() => {
                                                            setEditContract(c);
                                                            setEditForm({ status: c.status, endDate: c.endDate.split('T')[0], flexCreditsRemaining: c.flexCreditsRemaining?.toString() || '', contractUrl: c.contractUrl || '', paymentMethod: c.paymentMethod || '', boletoAllowed: c.boletoAllowed ?? false });
                                                            setEditError('');
                                                        }}>✏️</button>

                                                    {c.status === 'PENDING_CANCELLATION' && (
                                                        <>
                                                            <button className="btn btn-sm" style={{ background: 'rgba(239,68,68,0.12)', color: '#ef4444', border: 'none', fontSize: '0.6875rem', padding: '4px 8px', borderRadius: '8px', fontWeight: 600, cursor: 'pointer' }}
                                                                onClick={() => handleResolveCancel(c.id, 'CHARGE_FEE')} title="Cobrar multa">💰</button>
                                                            <button className="btn btn-sm" style={{ background: 'rgba(16,185,129,0.12)', color: '#10b981', border: 'none', fontSize: '0.6875rem', padding: '4px 8px', borderRadius: '8px', fontWeight: 600, cursor: 'pointer' }}
                                                                onClick={() => handleResolveCancel(c.id, 'WAIVE_FEE')} title="Isentar multa">🆓</button>
                                                        </>
                                                    )}

                                                    {c.status === 'ACTIVE' && (
                                                        <button className="btn btn-sm" style={{ background: 'rgba(239,68,68,0.08)', color: '#ef4444', border: 'none', fontSize: '0.8125rem', padding: '4px 8px', borderRadius: '8px', cursor: 'pointer' }}
                                                            onClick={() => handleCancel(c.id)} title="Cancelar">🚫</button>
                                                    )}

                                                    {(c.status === 'ACTIVE' || c.status === 'EXPIRED') && (
                                                        <button className="btn btn-ghost btn-sm" title="Renovar" style={{ fontSize: '0.8125rem', padding: '4px 8px', borderRadius: '8px' }}
                                                            onClick={() => {
                                                                showConfirm({ title: '🔄 Renovar Contrato', message: `Renovar "${c.name}" por mais 3 meses?`, onConfirm: async () => { try { const r = await contractsApi.renew(c.id, { durationMonths: 3 }); showToast(r.message); reload(); } catch (e: unknown) { showToast(getErrorMessage(e) || 'Erro'); } } });
                                                            }}>🔄</button>
                                                    )}
                                                    {c.status === 'ACTIVE' && (
                                                        <button className="btn btn-ghost btn-sm" title="Pausar" style={{ fontSize: '0.8125rem', padding: '4px 8px', borderRadius: '8px' }}
                                                            onClick={() => {
                                                                showConfirm({ title: '⏸️ Pausar Contrato', message: `Pausar "${c.name}"? Bookings futuros serão cancelados.`, onConfirm: async () => { try { const r = await contractsApi.pause(c.id, { reason: 'Pausa administrativa' }); showToast(r.message); reload(); } catch (e: unknown) { showToast(getErrorMessage(e) || 'Erro'); } } });
                                                            }}>⏸️</button>
                                                    )}
                                                    {(c.status as string) === 'PAUSED' && (
                                                        <button className="btn btn-sm" title="Retomar" style={{ background: 'rgba(16,185,129,0.12)', color: '#10b981', border: 'none', fontSize: '0.8125rem', padding: '4px 8px', borderRadius: '8px', fontWeight: 600, cursor: 'pointer' }}
                                                            onClick={() => {
                                                                showConfirm({ title: '▶️ Retomar Contrato', message: `Retomar "${c.name}"? Vigência será estendida.`, onConfirm: async () => { try { const r = await contractsApi.resume(c.id); showToast(r.message); reload(); } catch (e: unknown) { showToast(getErrorMessage(e) || 'Erro'); } } });
                                                            }}>▶️</button>
                                                    )}
                                                </div>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            {/* ---------------------------------------------------------------
               MODALS
            --------------------------------------------------------------- */}

            {showCreate && (
                <CreateContractModal
                    isOpen={showCreate}
                    onClose={() => setShowCreate(false)}
                    onCreated={reload}
                    users={users}
                    pricing={pricing}
                />
            )}

            {/* Edit Modal */}
            {editContract && (
                <BottomSheetModal isOpen onClose={() => setEditContract(null)} title="Editar Contrato" size="md">
                    <div>
                        <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginBottom: '16px' }}>
                            {editContract.type} · {editContract.tier} · {editContract.user?.name} · {episodeCount(editContract.durationMonths)} gravações
                        </p>
                        {editError && <div className="error-message">{editError}</div>}
                        <div className="form-group"><label className="form-label">Status</label>
                            <select className="form-select" value={editForm.status} onChange={e => setEditForm({ ...editForm, status: e.target.value })}>
                                <option value="ACTIVE">Ativo</option><option value="PENDING_CANCELLATION">Aguardando Cancelamento</option><option value="EXPIRED">Expirado</option><option value="CANCELLED">Cancelado</option>
                            </select>
                        </div>
                        <div className="form-group"><label className="form-label">Data de Término</label>
                            <input type="date" className="form-input" value={editForm.endDate} onChange={e => setEditForm({ ...editForm, endDate: e.target.value })} />
                        </div>
                        {editContract.type === 'FLEX' && (
                            <div className="form-group"><label className="form-label">Créditos Flex Restantes</label>
                                <input type="number" className="form-input" min={0} value={editForm.flexCreditsRemaining} onChange={e => setEditForm({ ...editForm, flexCreditsRemaining: e.target.value })} />
                            </div>
                        )}
                        <div className="form-group">
                            <label className="form-label">🔗 Link do Contrato Digital</label>
                            <input className="form-input" type="url" placeholder="https://..." value={editForm.contractUrl} onChange={e => setEditForm({ ...editForm, contractUrl: e.target.value })} />
                        </div>
                        <div className="form-group">
                            <label className="form-label">💳 Forma de Pagamento</label>
                            <select className="form-select" value={editForm.paymentMethod} onChange={e => setEditForm({ ...editForm, paymentMethod: e.target.value })}>
                                <option value="">-- Não definido --</option>
                                {getPaymentMethods().map(pm => (
                                    <option key={pm.key} value={pm.key}>{pm.emoji} {pm.label}</option>
                                ))}
                            </select>
                        </div>
                        <div className="form-group">
                            <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: '0.875rem' }}>
                                <input
                                    type="checkbox"
                                    checked={editForm.boletoAllowed}
                                    onChange={e => setEditForm({ ...editForm, boletoAllowed: e.target.checked })}
                                    style={{ width: 18, height: 18, accentColor: '#f59e0b', cursor: 'pointer' }}
                                />
                                <span>📄 Permitir <strong>boleto</strong> neste contrato</span>
                            </label>
                            <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: '6px 0 0 28px' }}>
                                O cliente poderá pagar as parcelas deste contrato via boleto. Desligado por padrão.
                            </p>
                        </div>
                        <div className="admin-actions-row">
                            <button className="btn btn-secondary" onClick={() => setEditContract(null)}>Cancelar</button>
                            <button className="btn btn-primary" onClick={handleEdit}>💾 Salvar</button>
                        </div>
                    </div>
                </BottomSheetModal>
            )}

            {/* Cancel (Force) Modal */}
            {/* -------------------------------------------------------
               CUSTOM CONTRACT WIZARD
            ------------------------------------------------------- */}
            {showCustom && (
                <CustomContractModal
                    isOpen={showCustom}
                    onClose={() => setShowCustom(false)}
                    onCreated={reload}
                    users={users}
                    pricing={pricing}
                />
            )}
        </div>
    );
}

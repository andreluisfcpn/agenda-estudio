import { getErrorMessage } from '../utils/errors';
import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { contractsApi, usersApi, pricingApi, Contract, UserSummary, CreateContractData, PricingConfig, AddOnConfig, CustomContractData } from '../api/client';
import { useBusinessConfig } from '../hooks/useBusinessConfig';
import { useUI } from '../context/UIContext';
import ModalOverlay from '../components/ModalOverlay';
import { getPaymentMethods, getPaymentBadge } from '../constants/paymentMethods';

function formatBRL(cents: number): string {
    return `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;
}

const DAY_NAMES_FULL = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string; icon: string }> = {
    ACTIVE:               { label: 'Ativo',       color: '#10b981', bg: 'rgba(16,185,129,0.12)',  icon: '?' },
    EXPIRED:              { label: 'Expirado',    color: '#6b7280', bg: 'rgba(107,114,128,0.12)', icon: '?' },
    CANCELLED:            { label: 'Cancelado',   color: '#ef4444', bg: 'rgba(239,68,68,0.12)',   icon: '?' },
    PENDING_CANCELLATION: { label: 'Pend. Cancel', color: '#f59e0b', bg: 'rgba(245,158,11,0.12)', icon: '?' },
    PAUSED:               { label: 'Pausado',     color: '#14b8a6', bg: 'rgba(45,212,191,0.12)',  icon: '?' },
};

export default function AdminContractsPage() {
    const navigate = useNavigate();
    const { showAlert, showConfirm, showToast } = useUI();
    const [contracts, setContracts] = useState<Contract[]>([]);
    const [users, setUsers] = useState<UserSummary[]>([]);
    const [loading, setLoading] = useState(true);
    const [pricing, setPricing] = useState<PricingConfig[]>([]);
    const [filter, setFilter] = useState<'ALL' | 'ACTIVE' | 'EXPIRED' | 'CANCELLED' | 'PENDING_CANCELLATION' | 'PAUSED'>('ALL');
    const [search, setSearch] = useState('');

    const [showCreate, setShowCreate] = useState(false);
    const [createForm, setCreateForm] = useState<Partial<CreateContractData> & { contractUrl?: string }>({
        name: '', type: 'FIXO', tier: 'COMERCIAL', durationMonths: 3, startDate: new Date().toISOString().split('T')[0], contractUrl: '',
    });
    const [createError, setCreateError] = useState('');
    const [createSuccess, setCreateSuccess] = useState('');

    const [conflicts, setConflicts] = useState<{ date: string, originalTime: string, suggestedReplacement?: { date: string, time: string } }[]>([]);
    const [resolvedConflicts, setResolvedConflicts] = useState<{ originalDate: string, originalTime: string, newDate: string, newTime: string }[]>([]);
    const [showConflictModal, setShowConflictModal] = useState(false);

    const [showCancelModalFor, setShowCancelModalFor] = useState<string | null>(null);
    const [showResolveModalFor, setShowResolveModalFor] = useState<{ id: string, action: 'CHARGE_FEE' | 'WAIVE_FEE' } | null>(null);

    const [editContract, setEditContract] = useState<Contract | null>(null);
    const [editForm, setEditForm] = useState({ status: '', endDate: '', flexCreditsRemaining: '', contractUrl: '', paymentMethod: '' });
    const [editError, setEditError] = useState('');

    // --- Custom Contract Wizard ---
    const [showCustom, setShowCustom] = useState(false);
    const [customStep, setCustomStep] = useState<1 | 2 | 3 | 4>(1);
    const [customForm, setCustomForm] = useState({
        userId: '', name: '', tier: 'COMERCIAL' as string,
        durationMonths: 3, startDate: new Date().toISOString().split('T')[0],
        selectedDays: [] as number[], dayTimes: {} as Record<number, string>,
        paymentMethod: '' as string,
        frequency: 'WEEKLY' as 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY' | 'CUSTOM',
        weekPattern: [1, 3] as number[],
        customDates: [] as { date: string; time: string }[],
    });
    const [customAddons, setCustomAddons] = useState<AddOnConfig[]>([]);
    const [customAddonConfig, setCustomAddonConfig] = useState<Record<string, { mode: 'all' | 'credits' | 'none'; perCycle: number }>>({});
    const [customError, setCustomError] = useState('');
    const [customSubmitting, setCustomSubmitting] = useState(false);
    const [customSuccess, setCustomSuccess] = useState('');
    const [calMonth, setCalMonth] = useState({ year: new Date().getFullYear(), month: new Date().getMonth() });

    const { get: getRule } = useBusinessConfig();
    const ep3 = getRule('episodes_3months');
    const ep6 = getRule('episodes_6months');
    const disc3 = getRule('discount_3months');
    const disc6 = getRule('discount_6months');
    const cancFine = getRule('cancellation_fine_pct');

    useEffect(() => { loadData(); }, []);

    const loadData = async () => {
        setLoading(true);
        try {
            const [cRes, uRes, pRes] = await Promise.all([contractsApi.getAll(), usersApi.getAll(), pricingApi.get()]);
            setContracts(cRes.contracts);
            setUsers(uRes.users);
            setPricing(pRes.pricing);
        } catch (err) { console.error(err); }
        finally { setLoading(false); }
    };

    const executeCreate = async (resolutions: any[] = []) => {
        setCreateError(''); setCreateSuccess('');
        try {
            const data: CreateContractData = {
                userId: createForm.userId!,
                name: createForm.name!,
                type: createForm.type as 'FIXO' | 'FLEX',
                tier: createForm.tier as any,
                durationMonths: createForm.durationMonths as 3 | 6,
                startDate: createForm.startDate!,
                contractUrl: createForm.contractUrl || undefined,
                resolvedConflicts: resolutions.length > 0 ? resolutions : undefined,
                ...(createForm.type === 'FIXO' && { fixedDayOfWeek: createForm.fixedDayOfWeek || 1, fixedTime: createForm.fixedTime || '14:00' }),
            };
            const res = await contractsApi.create(data);
            setCreateSuccess(res.message);
            await loadData();
            setTimeout(() => { setShowCreate(false); setShowConflictModal(false); setCreateSuccess(''); }, 1500);
        } catch (err: unknown) { setCreateError(getErrorMessage(err)); }
    };

    const handleCreate = async () => {
        if (!createForm.userId) return;
        setCreateError('');

        if (createForm.type === 'FIXO') {
            try {
                const res = await contractsApi.checkFixo({
                    tier: createForm.tier!,
                    durationMonths: createForm.durationMonths as 3 | 6,
                    startDate: createForm.startDate!,
                    fixedDayOfWeek: createForm.fixedDayOfWeek || 1,
                    fixedTime: createForm.fixedTime || '14:00'
                });

                if (!res.available) {
                    setConflicts(res.conflicts);
                    const autoResolutions = res.conflicts
                        .filter(c => c.suggestedReplacement)
                        .map(c => ({
                            originalDate: c.date,
                            originalTime: c.originalTime,
                            newDate: c.suggestedReplacement!.date,
                            newTime: c.suggestedReplacement!.time
                        }));
                    setResolvedConflicts(autoResolutions);
                    setShowConflictModal(true);
                    return;
                }
            } catch (err: unknown) {
                setCreateError(getErrorMessage(err) || 'Erro ao validar agenda.');
                return;
            }
        }

        await executeCreate([]);
    };

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
            await contractsApi.update(editContract.id, data);
            setEditContract(null);
            await loadData();
        } catch (err: unknown) { setEditError(getErrorMessage(err)); }
    };

    const handleCancel = async (id: string) => {
        setShowCancelModalFor(id);
    };

    const confirmCancel = async () => {
        if (!showCancelModalFor) return;
        try {
            await contractsApi.cancel(showCancelModalFor);
            showToast('Contrato cancelado com sucesso.');
            setShowCancelModalFor(null);
            await loadData();
        } catch (err: unknown) { showAlert({ message: getErrorMessage(err), type: 'error' }); }
    };

    const handleResolveCancel = async (id: string, action: 'CHARGE_FEE' | 'WAIVE_FEE') => {
        setShowResolveModalFor({ id, action });
    };

    const confirmResolveCancel = async () => {
        if (!showResolveModalFor) return;
        try {
            const res = await contractsApi.resolveCancellation(showResolveModalFor.id, showResolveModalFor.action);
            showToast(res.message);
            setShowResolveModalFor(null);
            await loadData();
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

    if (loading) return <div className="loading-spinner"><div className="spinner" /></div>;

    return (
        <div>
            {/* --- HEADER --- */}
            <div style={{ marginBottom: '28px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '16px' }}>
                <div>
                    <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <span style={{ fontSize: '1.75rem' }}>??</span> Contratos
                    </h1>
                    <p className="page-subtitle" style={{ marginTop: '4px' }}>
                        Gerencie contratos de fidelidade e pacotes de episódios
                    </p>
                </div>
                <div style={{ display: 'flex', gap: '10px' }}>
                    <button className="btn btn-primary" onClick={() => { setShowCreate(true); setCreateError(''); setCreateSuccess(''); }}
                        style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '12px 24px', borderRadius: '12px', fontWeight: 700 }}>
                        <span style={{ fontSize: '1.1rem' }}>+</span> Novo Contrato
                    </button>
                    <button onClick={() => {
                        setShowCustom(true); setCustomStep(1); setCustomError(''); setCustomSuccess('');
                        setCustomForm({ userId: '', name: '', tier: 'COMERCIAL', durationMonths: 3, startDate: new Date().toISOString().split('T')[0], selectedDays: [], dayTimes: {}, paymentMethod: '', frequency: 'WEEKLY', weekPattern: [1, 3], customDates: [] });
                        setCustomAddonConfig({});
                        setCalMonth({ year: new Date().getFullYear(), month: new Date().getMonth() });
                        pricingApi.getAddons().then(res => setCustomAddons(res.addons)).catch(console.error);
                    }}
                        style={{
                            display: 'flex', alignItems: 'center', gap: '8px', padding: '12px 24px', borderRadius: '12px', fontWeight: 700,
                            background: 'linear-gradient(135deg, rgba(45,212,191,0.15), rgba(59,130,246,0.1))',
                            border: '1px solid rgba(45,212,191,0.3)', color: '#2dd4bf', cursor: 'pointer',
                            fontSize: '0.875rem', transition: 'all 0.2s',
                        }}>
                        <span style={{ fontSize: '1.1rem' }}>??</span> Contrato Personalizado
                    </button>
                </div>
            </div>

            {/* --- KPI CARDS --- */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '14px', marginBottom: '24px' }}>
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
                    <span style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', fontSize: '0.75rem', opacity: 0.5 }}>??</span>
                </div>
                {search && <button onClick={() => setSearch('')} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '1rem' }}>?</button>}

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
                        <div style={{ fontSize: '2.5rem', marginBottom: '12px', opacity: 0.4 }}>??</div>
                        <div style={{ fontWeight: 600 }}>Nenhum contrato encontrado</div>
                        <div style={{ fontSize: '0.8125rem', marginTop: '4px' }}>Tente ajustar os filtros ou busca</div>
                    </div>
                ) : (
                    <div className="table-container" style={{ margin: 0 }}>
                        <table>
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
                                    const sc = STATUS_CONFIG[c.status] || STATUS_CONFIG.ACTIVE;
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
                                            <td style={{ paddingLeft: '20px' }}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                                    <div style={{
                                                        width: '36px', height: '36px', borderRadius: '10px',
                                                        background: c.tier === 'AUDIENCIA' ? 'rgba(45,212,191,0.15)' : c.tier === 'SABADO' ? 'rgba(245,158,11,0.15)' : 'rgba(16,185,129,0.15)',
                                                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                        fontSize: '0.9375rem', flexShrink: 0
                                                    }}>
                                                        {c.type === 'FIXO' ? '??' : '??'}
                                                    </div>
                                                    <div>
                                                        <div style={{ fontWeight: 600, fontSize: '0.875rem', cursor: 'pointer', color: 'var(--accent-primary)' }}
                                                            onClick={() => c.user?.id && navigate(`/admin/clients/${c.user.id}`)}>
                                                            {c.user?.name || '—'}
                                                        </div>
                                                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '1px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                                            {c.name}
                                                            {c.contractUrl && <a href={c.contractUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent-primary)', fontSize: '0.65rem' }} title="Contrato digital">???</a>}
                                                        </div>
                                                    </div>
                                                </div>
                                            </td>

                                            {/* Type + Tier */}
                                            <td>
                                                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                                    <span style={{
                                                        display: 'inline-flex', alignItems: 'center', gap: '3px',
                                                        padding: '2px 8px', borderRadius: '6px', fontSize: '0.6875rem', fontWeight: 700,
                                                        background: c.type === 'FIXO' ? 'rgba(99,102,241,0.12)' : 'rgba(16,185,129,0.12)',
                                                        color: c.type === 'FIXO' ? '#818cf8' : '#34d399',
                                                        width: 'fit-content'
                                                    }}>
                                                        {c.type === 'FIXO' ? '?? Fixo' : '?? Flex'}
                                                    </span>
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
                                            <td>
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
                                            <td>
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
                                            <td>
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
                                                        ? Vence em {venc.label}
                                                    </span>
                                                )}
                                            </td>

                                            {/* Status */}
                                            <td style={{ textAlign: 'center' }}>
                                                <span style={{
                                                    display: 'inline-flex', alignItems: 'center', gap: '4px',
                                                    padding: '4px 10px', borderRadius: '20px', fontSize: '0.6875rem', fontWeight: 700,
                                                    background: sc.bg, color: sc.color, letterSpacing: '0.02em'
                                                }}>
                                                    {sc.icon} {sc.label}
                                                </span>
                                            </td>

                                            {/* Actions */}
                                            <td style={{ textAlign: 'center' }}>
                                                <div style={{ display: 'flex', gap: '4px', justifyContent: 'center', flexWrap: 'wrap' }}>
                                                    <button className="btn btn-ghost btn-sm" title="Editar" style={{ fontSize: '0.8125rem', padding: '4px 8px', borderRadius: '8px' }}
                                                        onClick={() => {
                                                            setEditContract(c);
                                                            setEditForm({ status: c.status, endDate: c.endDate.split('T')[0], flexCreditsRemaining: c.flexCreditsRemaining?.toString() || '', contractUrl: c.contractUrl || '', paymentMethod: c.paymentMethod || '' });
                                                            setEditError('');
                                                        }}>??</button>

                                                    {c.status === 'PENDING_CANCELLATION' && (
                                                        <>
                                                            <button className="btn btn-sm" style={{ background: 'rgba(239,68,68,0.12)', color: '#ef4444', border: 'none', fontSize: '0.6875rem', padding: '4px 8px', borderRadius: '8px', fontWeight: 600, cursor: 'pointer' }}
                                                                onClick={() => handleResolveCancel(c.id, 'CHARGE_FEE')} title="Cobrar multa">??</button>
                                                            <button className="btn btn-sm" style={{ background: 'rgba(16,185,129,0.12)', color: '#10b981', border: 'none', fontSize: '0.6875rem', padding: '4px 8px', borderRadius: '8px', fontWeight: 600, cursor: 'pointer' }}
                                                                onClick={() => handleResolveCancel(c.id, 'WAIVE_FEE')} title="Isentar multa">??</button>
                                                        </>
                                                    )}

                                                    {c.status === 'ACTIVE' && (
                                                        <button className="btn btn-sm" style={{ background: 'rgba(239,68,68,0.08)', color: '#ef4444', border: 'none', fontSize: '0.8125rem', padding: '4px 8px', borderRadius: '8px', cursor: 'pointer' }}
                                                            onClick={() => handleCancel(c.id)} title="Cancelar">?</button>
                                                    )}

                                                    {(c.status === 'ACTIVE' || c.status === 'EXPIRED') && (
                                                        <button className="btn btn-ghost btn-sm" title="Renovar" style={{ fontSize: '0.8125rem', padding: '4px 8px', borderRadius: '8px' }}
                                                            onClick={() => {
                                                                showConfirm({ title: '?? Renovar Contrato', message: `Renovar "${c.name}" por mais 3 meses?`, onConfirm: async () => { try { const r = await contractsApi.renew(c.id, { durationMonths: 3 }); showToast(r.message); loadData(); } catch (e: unknown) { showToast(getErrorMessage(e) || 'Erro'); } } });
                                                            }}>??</button>
                                                    )}
                                                    {c.status === 'ACTIVE' && (
                                                        <button className="btn btn-ghost btn-sm" title="Pausar" style={{ fontSize: '0.8125rem', padding: '4px 8px', borderRadius: '8px' }}
                                                            onClick={() => {
                                                                showConfirm({ title: '?? Pausar Contrato', message: `Pausar "${c.name}"? Bookings futuros serão cancelados.`, onConfirm: async () => { try { const r = await contractsApi.pause(c.id, { reason: 'Pausa administrativa' }); showToast(r.message); loadData(); } catch (e: unknown) { showToast(getErrorMessage(e) || 'Erro'); } } });
                                                            }}>??</button>
                                                    )}
                                                    {(c.status as string) === 'PAUSED' && (
                                                        <button className="btn btn-sm" title="Retomar" style={{ background: 'rgba(16,185,129,0.12)', color: '#10b981', border: 'none', fontSize: '0.8125rem', padding: '4px 8px', borderRadius: '8px', fontWeight: 600, cursor: 'pointer' }}
                                                            onClick={() => {
                                                                showConfirm({ title: '?? Retomar Contrato', message: `Retomar "${c.name}"? Vigência será estendida.`, onConfirm: async () => { try { const r = await contractsApi.resume(c.id); showToast(r.message); loadData(); } catch (e: unknown) { showToast(getErrorMessage(e) || 'Erro'); } } });
                                                            }}>??</button>
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
               MODALS (preserved from original — these already work great)
            --------------------------------------------------------------- */}

            {showCreate && (() => {
                const inputStyle = (hasError = false) => ({
                    width: '100%', padding: '10px 14px 10px 36px', borderRadius: '10px', fontSize: '0.8125rem',
                    background: 'var(--bg-elevated)', border: `1px solid ${hasError ? 'rgba(239,68,68,0.5)' : 'var(--border-default)'}`,
                    color: 'var(--text-primary)', outline: 'none', fontFamily: 'inherit', transition: 'border-color 0.2s',
                } as React.CSSProperties);

                const labelStyle = {
                    fontSize: '0.6875rem', fontWeight: 700, color: 'var(--text-muted)',
                    textTransform: 'uppercase' as const, letterSpacing: '0.1em', marginBottom: '6px', display: 'block',
                };

                const sectionHeader = (num: number, text: string, color: string) => (
                    <div style={{ fontSize: '0.625rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: '14px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span style={{ width: 18, height: 18, borderRadius: '50%', background: color, color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.5rem', fontWeight: 800 }}>{num}</span>
                        {text}
                    </div>
                );

                const tierPrice = pricing.find(p => p.tier === createForm.tier);
                const base = tierPrice?.price || 0;
                const episodes = createForm.durationMonths === 3 ? ep3 : ep6;
                const discount = createForm.durationMonths === 3 ? disc3 : disc6;
                const discounted = Math.round(base * (1 - discount / 100));
                const total = discounted * episodes;
                const monthly = createForm.durationMonths ? Math.round(total / createForm.durationMonths) : 0;

                const canCreate = !!createForm.userId && !!createForm.name?.trim();

                const clientUsers = users.filter(u => u.role !== 'ADMIN');
                const selectedUser = clientUsers.find(u => u.id === createForm.userId);

                return (
                    <ModalOverlay onClose={() => setShowCreate(false)}>
                        <div className="modal" style={{ maxWidth: 580, maxHeight: '94vh', overflowY: 'auto', padding: 0 }}>
                            {/* --- HEADER --- */}
                            <div style={{ padding: '28px 32px 0' }}>
                                <h2 style={{ fontSize: '1.25rem', fontWeight: 800, margin: 0, display: 'flex', alignItems: 'center', gap: '10px' }}>
                                    <span style={{ width: 36, height: 36, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'linear-gradient(135deg, #818cf8, #6366f1)', fontSize: '1rem' }}>??</span>
                                    Novo Contrato
                                </h2>
                                <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '6px', marginBottom: 0 }}>
                                    Crie um contrato de fidelidade vinculado a um cliente
                                </p>
                            </div>

                            <div style={{ padding: '20px 32px 28px' }}>
                                {createError && <div style={{ marginBottom: '16px', padding: '10px 14px', borderRadius: '10px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.15)', color: '#ef4444', fontSize: '0.8125rem', fontWeight: 600 }}>{createError}</div>}
                                {createSuccess && <div style={{ marginBottom: '16px', padding: '10px 14px', borderRadius: '10px', background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.15)', color: '#10b981', fontSize: '0.8125rem', fontWeight: 600 }}>{createSuccess}</div>}

                                {/* --- SECTION 1: Cliente & Projeto --- */}
                                <div style={{ marginBottom: '20px' }}>
                                    {sectionHeader(1, 'Cliente & Projeto', '#10b981')}

                                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                                        {/* Client selector */}
                                        <div>
                                            <label style={labelStyle}>Cliente *</label>
                                            <div style={{ position: 'relative' }}>
                                                <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: '0.75rem', opacity: 0.5 }}>??</span>
                                                <select
                                                    value={createForm.userId || ''}
                                                    onChange={e => setCreateForm({ ...createForm, userId: e.target.value })}
                                                    style={{
                                                        ...inputStyle(), paddingLeft: '36px', appearance: 'none', cursor: 'pointer',
                                                        backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%23666'/%3E%3C/svg%3E")`,
                                                        backgroundRepeat: 'no-repeat', backgroundPosition: 'right 12px center',
                                                    }}
                                                >
                                                    <option value="">Selecione o cliente</option>
                                                    {clientUsers.map(u => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)}
                                                </select>
                                            </div>
                                            {selectedUser && (
                                                <div style={{ marginTop: '6px', padding: '6px 10px', borderRadius: '8px', background: 'rgba(16,185,129,0.06)', border: '1px solid rgba(16,185,129,0.12)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                                                    <span style={{ width: 24, height: 24, borderRadius: 6, background: 'rgba(16,185,129,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.625rem', fontWeight: 700, color: '#10b981' }}>{selectedUser.name.charAt(0)}</span>
                                                    <div>
                                                        <div style={{ fontSize: '0.75rem', fontWeight: 600 }}>{selectedUser.name}</div>
                                                        <div style={{ fontSize: '0.5625rem', color: 'var(--text-muted)' }}>{selectedUser.email}</div>
                                                    </div>
                                                </div>
                                            )}
                                        </div>

                                        {/* Project name */}
                                        <div>
                                            <label style={labelStyle}>Nome do Projeto *</label>
                                            <div style={{ position: 'relative' }}>
                                                <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: '0.75rem', opacity: 0.5 }}>??</span>
                                                <input
                                                    value={createForm.name || ''} onChange={e => setCreateForm({ ...createForm, name: e.target.value })}
                                                    placeholder="Ex: Podcast Verão 2026"
                                                    style={inputStyle()}
                                                    onFocus={e => (e.currentTarget.style.borderColor = '#10b981')}
                                                    onBlur={e => (e.currentTarget.style.borderColor = 'var(--border-default)')}
                                                />
                                            </div>
                                        </div>
                                    </div>
                                </div>

                                {/* --- SECTION 2: Configuração --- */}
                                <div style={{ marginBottom: '20px' }}>
                                    {sectionHeader(2, 'Configuração do Contrato', '#818cf8')}

                                    {/* Type selector cards */}
                                    <div style={{ marginBottom: '14px' }}>
                                        <label style={labelStyle}>Tipo de contrato</label>
                                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                                            {[
                                                { key: 'FIXO', icon: '??', label: 'Fixo', desc: 'Recorrente: dia/hora fixos toda semana' },
                                                { key: 'FLEX', icon: '??', label: 'Flex', desc: 'Créditos: agende quando quiser' },
                                            ].map(t => (
                                                <button key={t.key} onClick={() => setCreateForm({ ...createForm, type: t.key as any })}
                                                    style={{
                                                        padding: '12px', borderRadius: '10px', cursor: 'pointer', textAlign: 'left',
                                                        background: createForm.type === t.key ? (t.key === 'FIXO' ? 'rgba(99,102,241,0.08)' : 'rgba(16,185,129,0.08)') : 'var(--bg-elevated)',
                                                        border: `1.5px solid ${createForm.type === t.key ? (t.key === 'FIXO' ? 'rgba(99,102,241,0.3)' : 'rgba(16,185,129,0.3)') : 'var(--border-default)'}`,
                                                        transition: 'all 0.15s',
                                                    }}>
                                                    <div style={{ fontSize: '0.875rem', fontWeight: 700, color: createForm.type === t.key ? (t.key === 'FIXO' ? '#818cf8' : '#10b981') : 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '6px' }}>{t.icon} {t.label}</div>
                                                    <div style={{ fontSize: '0.5625rem', color: 'var(--text-muted)', marginTop: '3px' }}>{t.desc}</div>
                                                </button>
                                            ))}
                                        </div>
                                    </div>

                                    {/* Tier selector cards */}
                                    <div style={{ marginBottom: '14px' }}>
                                        <label style={labelStyle}>Faixa</label>
                                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '6px' }}>
                                            {[
                                                { key: 'COMERCIAL', icon: '??', label: 'Comercial', color: '#10b981' },
                                                { key: 'AUDIENCIA', icon: '??', label: 'Audiência', color: '#2dd4bf' },
                                                { key: 'SABADO', icon: '??', label: 'Sábado', color: '#fbbf24' },
                                            ].map(t => (
                                                <button key={t.key} onClick={() => setCreateForm({ ...createForm, tier: t.key as any })}
                                                    style={{
                                                        padding: '10px 8px', borderRadius: '10px', cursor: 'pointer', textAlign: 'center',
                                                        background: createForm.tier === t.key ? `${t.color}12` : 'var(--bg-elevated)',
                                                        border: `1.5px solid ${createForm.tier === t.key ? `${t.color}44` : 'var(--border-default)'}`,
                                                        transition: 'all 0.15s',
                                                    }}>
                                                    <div style={{ fontSize: '1rem' }}>{t.icon}</div>
                                                    <div style={{ fontSize: '0.6875rem', fontWeight: 700, color: createForm.tier === t.key ? t.color : 'var(--text-primary)', marginTop: '2px' }}>{t.label}</div>
                                                    {tierPrice && t.key === createForm.tier && <div style={{ fontSize: '0.5625rem', color: 'var(--text-muted)', marginTop: '2px' }}>{formatBRL(base)}/ep</div>}
                                                </button>
                                            ))}
                                        </div>
                                    </div>

                                    {/* Duration selector */}
                                    <div style={{ marginBottom: '14px' }}>
                                        <label style={labelStyle}>Pacote & Duração</label>
                                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                                            {[
                                                { months: 3, eps: ep3, disc: disc3 },
                                                { months: 6, eps: ep6, disc: disc6 },
                                            ].map(p => (
                                                <button key={p.months} onClick={() => setCreateForm({ ...createForm, durationMonths: p.months as 3 | 6 })}
                                                    style={{
                                                        padding: '12px', borderRadius: '10px', cursor: 'pointer', textAlign: 'center',
                                                        background: createForm.durationMonths === p.months ? 'rgba(16,185,129,0.08)' : 'var(--bg-elevated)',
                                                        border: `1.5px solid ${createForm.durationMonths === p.months ? 'rgba(16,185,129,0.3)' : 'var(--border-default)'}`,
                                                        transition: 'all 0.15s',
                                                    }}>
                                                    <div style={{ fontSize: '1.25rem', fontWeight: 800, color: createForm.durationMonths === p.months ? '#10b981' : 'var(--text-primary)' }}>{p.eps}</div>
                                                    <div style={{ fontSize: '0.625rem', color: 'var(--text-muted)' }}>gravações · {p.months} meses</div>
                                                    <div style={{ marginTop: '4px', display: 'inline-flex', padding: '2px 6px', borderRadius: '6px', fontSize: '0.5625rem', fontWeight: 700, background: 'rgba(16,185,129,0.1)', color: '#10b981' }}>-{p.disc}% desconto</div>
                                                </button>
                                            ))}
                                        </div>
                                    </div>

                                    {/* Date + Contract URL row */}
                                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '14px' }}>
                                        <div>
                                            <label style={labelStyle}>Data de Início</label>
                                            <div style={{ position: 'relative' }}>
                                                <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: '0.75rem', opacity: 0.5 }}>??</span>
                                                <input type="date" value={createForm.startDate}
                                                    onChange={e => setCreateForm({ ...createForm, startDate: e.target.value })}
                                                    style={inputStyle()}
                                                    onFocus={e => (e.currentTarget.style.borderColor = '#818cf8')}
                                                    onBlur={e => (e.currentTarget.style.borderColor = 'var(--border-default)')} />
                                            </div>
                                        </div>
                                        <div>
                                            <label style={labelStyle}>?? Link do Contrato</label>
                                            <div style={{ position: 'relative' }}>
                                                <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: '0.75rem', opacity: 0.5 }}>??</span>
                                                <input type="url" value={createForm.contractUrl || ''}
                                                    onChange={e => setCreateForm({ ...createForm, contractUrl: e.target.value })}
                                                    placeholder="https://contrato.digital/..."
                                                    style={inputStyle()}
                                                    onFocus={e => (e.currentTarget.style.borderColor = '#818cf8')}
                                                    onBlur={e => (e.currentTarget.style.borderColor = 'var(--border-default)')} />
                                            </div>
                                        </div>
                                    </div>

                                    {/* FIXO-specific fields */}
                                    {createForm.type === 'FIXO' && (
                                        <div style={{ padding: '14px', borderRadius: '10px', background: 'rgba(99,102,241,0.04)', border: '1px solid rgba(99,102,241,0.1)', marginBottom: '14px' }}>
                                            <div style={{ fontSize: '0.625rem', fontWeight: 700, color: '#818cf8', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '10px' }}>?? Configuração Recorrente</div>
                                            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '12px', alignItems: 'end' }}>
                                                <div>
                                                    <label style={labelStyle}>Dia da Semana</label>
                                                    <div style={{ display: 'flex', gap: '4px' }}>
                                                        {['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'].map((d, i) => (
                                                            <button key={i} onClick={() => setCreateForm({ ...createForm, fixedDayOfWeek: i + 1 })}
                                                                style={{
                                                                    flex: 1, padding: '8px 2px', borderRadius: '8px', fontSize: '0.625rem', fontWeight: 700, cursor: 'pointer',
                                                                    background: (createForm.fixedDayOfWeek || 1) === i + 1 ? 'rgba(99,102,241,0.15)' : 'var(--bg-elevated)',
                                                                    border: `1px solid ${(createForm.fixedDayOfWeek || 1) === i + 1 ? 'rgba(99,102,241,0.35)' : 'var(--border-default)'}`,
                                                                    color: (createForm.fixedDayOfWeek || 1) === i + 1 ? '#818cf8' : 'var(--text-muted)',
                                                                }}>
                                                                {d}
                                                            </button>
                                                        ))}
                                                    </div>
                                                </div>
                                                <div>
                                                    <label style={labelStyle}>Horário</label>
                                                    <input type="time" value={createForm.fixedTime || '14:00'}
                                                        onChange={e => setCreateForm({ ...createForm, fixedTime: e.target.value })}
                                                        style={{ ...inputStyle(), paddingLeft: '14px', width: '100px' }}
                                                        onFocus={e => (e.currentTarget.style.borderColor = '#818cf8')}
                                                        onBlur={e => (e.currentTarget.style.borderColor = 'var(--border-default)')} />
                                                </div>
                                            </div>
                                        </div>
                                    )}

                                    {/* FLEX info */}
                                    {createForm.type === 'FLEX' && (
                                        <div style={{ padding: '12px 14px', borderRadius: '10px', background: 'rgba(16,185,129,0.04)', border: '1px solid rgba(16,185,129,0.1)', marginBottom: '14px', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                                            <div style={{ fontWeight: 700, color: '#10b981', marginBottom: '6px', fontSize: '0.6875rem' }}>?? Regras Flex</div>
                                            <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                                                <span>• Mínimo 1 gravação/semana (use ou perca)</span>
                                                <span>• Adiantamento livre de créditos</span>
                                                <span>• Compensação automática de semanas futuras</span>
                                            </div>
                                        </div>
                                    )}
                                </div>

                                {/* --- SECTION 3: Price Preview --- */}
                                {tierPrice && (
                                    <div style={{ marginBottom: '20px' }}>
                                        {sectionHeader(3, 'Estimativa de Preço', '#f59e0b')}
                                        <div style={{ padding: '16px', borderRadius: '12px', background: 'linear-gradient(135deg, rgba(16,185,129,0.06), rgba(6,78,59,0.03))', border: '1px solid rgba(16,185,129,0.15)' }}>
                                            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '8px', fontSize: '0.8125rem' }}>
                                                <span style={{ color: 'var(--text-muted)' }}>Preço base/episódio</span>
                                                <span style={{ textAlign: 'right', fontWeight: 600 }}>{formatBRL(base)}</span>

                                                <span style={{ color: 'var(--text-muted)' }}>Desconto fidelidade ({discount}%)</span>
                                                <span style={{ textAlign: 'right', color: '#10b981', fontWeight: 600 }}>-{formatBRL(base - discounted)}</span>

                                                <span style={{ color: 'var(--text-muted)' }}>Preço/ep com desconto</span>
                                                <span style={{ textAlign: 'right', fontWeight: 700 }}>{formatBRL(discounted)}</span>

                                                <div style={{ gridColumn: '1 / -1', borderTop: '1px solid var(--border-default)', margin: '4px 0' }} />

                                                <span style={{ fontWeight: 700 }}>{episodes} episódios × {formatBRL(discounted)}</span>
                                                <span style={{ textAlign: 'right', fontSize: '1.125rem', fontWeight: 800, color: '#10b981' }}>{formatBRL(total)}</span>

                                                <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>Estimativa mensal</span>
                                                <span style={{ textAlign: 'right', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>~{formatBRL(monthly)}/mês</span>
                                            </div>
                                        </div>
                                    </div>
                                )}

                                {/* --- ACTIONS --- */}
                                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px' }}>
                                    <button onClick={() => setShowCreate(false)}
                                        style={{ padding: '10px 20px', borderRadius: '10px', background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-secondary)', fontSize: '0.8125rem', fontWeight: 600, cursor: 'pointer' }}>
                                        Cancelar
                                    </button>
                                    <button onClick={handleCreate} disabled={!canCreate}
                                        style={{
                                            padding: '10px 28px', borderRadius: '10px', border: 'none', fontSize: '0.875rem', fontWeight: 700, cursor: 'pointer',
                                            background: canCreate ? 'linear-gradient(135deg, #818cf8, #6366f1)' : 'var(--bg-elevated)',
                                            color: canCreate ? '#fff' : 'var(--text-muted)',
                                            opacity: canCreate ? 1 : 0.5,
                                            display: 'flex', alignItems: 'center', gap: '8px',
                                        }}>
                                        ?? Criar Contrato
                                    </button>
                                </div>
                            </div>
                        </div>
                    </ModalOverlay>
                );
            })()}

            {/* Edit Modal */}
            {editContract && (
                <ModalOverlay onClose={() => setEditContract(null)}>
                    <div className="modal">
                        <h2 className="modal-title">Editar Contrato</h2>
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
                            <label className="form-label">?? Link do Contrato Digital</label>
                            <input className="form-input" type="url" placeholder="https://..." value={editForm.contractUrl} onChange={e => setEditForm({ ...editForm, contractUrl: e.target.value })} />
                        </div>
                        <div className="form-group">
                            <label className="form-label">?? Forma de Pagamento</label>
                            <select className="form-select" value={editForm.paymentMethod} onChange={e => setEditForm({ ...editForm, paymentMethod: e.target.value })}>
                                <option value="">-- Não definido --</option>
                                {getPaymentMethods().map(pm => (
                                    <option key={pm.key} value={pm.key}>{pm.emoji} {pm.label}</option>
                                ))}
                            </select>
                        </div>
                        <div className="modal-actions">
                            <button className="btn btn-secondary" onClick={() => setEditContract(null)}>Cancelar</button>
                            <button className="btn btn-primary" onClick={handleEdit}>?? Salvar</button>
                        </div>
                    </div>
                </ModalOverlay>
            )}

            {/* Conflict Resolution Modal */}
            {showConflictModal && (
                <ModalOverlay onClose={() => setShowConflictModal(false)}>
                    <div className="modal" style={{ maxWidth: 600 }}>
                        <div style={{ textAlign: 'center', marginBottom: '20px' }}>
                            <div style={{ fontSize: '2.5rem', marginBottom: '8px' }}>??</div>
                            <h3 style={{ fontSize: '1.25rem', color: '#ef4444' }}>Conflitos de Agenda</h3>
                            <p style={{ color: 'var(--text-muted)' }}>Alguns dias projetados já possuem outras gravações.</p>
                        </div>

                        <div style={{ background: 'var(--bg-secondary)', padding: '16px', borderRadius: 'var(--radius-md)', marginBottom: '24px', maxHeight: '400px', overflowY: 'auto' }}>
                            <div style={{ fontWeight: 700, marginBottom: '12px', fontSize: '0.875rem' }}>Ocorrências Interceptadas:</div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                                {conflicts.map((c, i) => {
                                    const ymd = c.date.split('-');
                                    const dateObj = new Date(`${c.date}T12:00:00`);
                                    const localDate = `${ymd[2]}/${ymd[1]}/${ymd[0]}`;
                                    const dow = DAY_NAMES_FULL[dateObj.getDay()];

                                    return (
                                        <div key={i} style={{ padding: '12px', background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' }}>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                                                <span style={{ fontWeight: 600 }}>{dow}, {localDate} às {c.originalTime}</span>
                                                <span style={{ fontSize: '0.75rem', color: '#ef4444', fontWeight: 600, background: 'rgba(239, 68, 68, 0.1)', padding: '2px 8px', borderRadius: '10px' }}>Indisponível</span>
                                            </div>

                                            {c.suggestedReplacement ? (
                                                <div style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                                                    <span>?? Auto-Substituição:</span>
                                                    <span style={{ background: 'rgba(34, 197, 94, 0.1)', color: '#22c55e', padding: '4px 8px', borderRadius: '4px', fontWeight: 600 }}>
                                                        {c.suggestedReplacement.time} no mesmo dia
                                                    </span>
                                                </div>
                                            ) : (
                                                <div style={{ fontSize: '0.8125rem', color: '#f59e0b', display: 'flex', alignItems: 'center', gap: '8px' }}>
                                                    <span>?? Dia completamente lotado para a faixa. Remanejamento no fim do ciclo.</span>
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>

                        <div className="modal-actions" style={{ flexDirection: 'column', gap: '12px' }}>
                            <button className="btn btn-primary" style={{ width: '100%', padding: '14px' }}
                                onClick={() => executeCreate(resolvedConflicts)}>
                                ? Forçar Criação e Aplicar Sugestões
                            </button>
                            <button className="btn btn-secondary" style={{ width: '100%', padding: '14px' }}
                                onClick={() => setShowConflictModal(false)}>
                                ? Cancelar e voltar para escolhas
                            </button>
                        </div>
                    </div>
                </ModalOverlay>
            )}

            {/* Cancel (Force) Modal */}
            {showCancelModalFor && (
                <ModalOverlay onClose={() => setShowCancelModalFor(null)}>
                    <div className="modal" style={{ maxWidth: 400 }}>
                        <div style={{ textAlign: 'center', marginBottom: '20px' }}>
                            <div style={{ fontSize: '3rem', marginBottom: '10px' }}>??</div>
                            <h2 style={{ fontSize: '1.25rem', fontWeight: 700 }}>Cancelar Contrato</h2>
                        </div>
                        <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginBottom: '24px', lineHeight: 1.5, textAlign: 'center' }}>
                            Deseja forçar o cancelamento deste contrato agora? <strong>Todos os agendamentos futuros não realizados também serão cancelados.</strong>
                        </p>
                        <div className="modal-actions">
                            <button className="btn btn-secondary" onClick={() => setShowCancelModalFor(null)} style={{ flex: 1 }}>Voltar</button>
                            <button className="btn btn-danger" onClick={confirmCancel} style={{ flex: 1 }}>Sim, Cancelar</button>
                        </div>
                    </div>
                </ModalOverlay>
            )}

            {/* Resolve Cancellation Modal */}
            {showResolveModalFor && (
                <ModalOverlay onClose={() => setShowResolveModalFor(null)}>
                    <div className="modal" style={{ maxWidth: 400 }}>
                        <div style={{ textAlign: 'center', marginBottom: '20px' }}>
                            <div style={{ fontSize: '3rem', marginBottom: '10px' }}>
                                {showResolveModalFor.action === 'CHARGE_FEE' ? '??' : '??'}
                            </div>
                            <h2 style={{ fontSize: '1.25rem', fontWeight: 700 }}>
                                {showResolveModalFor.action === 'CHARGE_FEE' ? 'Aplicar Multa' : 'Isentar Multa'}
                            </h2>
                        </div>
                        <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginBottom: '24px', lineHeight: 1.5, textAlign: 'center' }}>
                            {showResolveModalFor.action === 'CHARGE_FEE'
                                ? `Tem certeza que deseja quebrar o contrato aplicando a MULTA INTEGRAL DE ${cancFine}% sobre o restante?`
                                : 'Tem certeza que deseja ISENTAR a multa e aceitar o cancelamento de modo amigável?'}
                        </p>
                        <div className="modal-actions">
                            <button className="btn btn-secondary" onClick={() => setShowResolveModalFor(null)} style={{ flex: 1 }}>Voltar</button>
                            <button className={showResolveModalFor.action === 'CHARGE_FEE' ? "btn btn-danger" : "btn btn-primary"} onClick={confirmResolveCancel} style={{ flex: 1 }}>
                                Confirmar Ação
                            </button>
                        </div>
                    </div>
                </ModalOverlay>
            )}

            {/* -------------------------------------------------------
               CUSTOM CONTRACT WIZARD
            ------------------------------------------------------- */}
            {showCustom && (() => {
                const POSSIBLE_SLOTS: Record<string, string[]> = {
                    COMERCIAL: ['10:00', '13:00', '15:30'],
                    AUDIENCIA: ['10:00', '13:00', '15:30', '18:00', '20:30'],
                    SABADO: ['10:00', '13:00', '15:30', '18:00', '20:30'],
                };

                const cusLabelStyle = {
                    fontSize: '0.6875rem', fontWeight: 700, color: 'var(--text-muted)',
                    textTransform: 'uppercase' as const, letterSpacing: '0.12em', marginBottom: '6px', display: 'block',
                };
                const cusInputStyle = (hasErr = false) => ({
                    width: '100%', padding: '10px 14px 10px 36px', borderRadius: '10px', fontSize: '0.8125rem',
                    background: 'var(--bg-elevated)', border: `1px solid ${hasErr ? 'rgba(239,68,68,0.5)' : 'var(--border-default)'}`,
                    color: 'var(--text-primary)', outline: 'none', fontFamily: 'inherit', transition: 'border-color 0.2s',
                } as React.CSSProperties);

                const tierConfig = pricing.find(p => p.tier === customForm.tier);
                const basePrice = tierConfig?.price || 0;
                const freq = customForm.frequency;

                // Mode-aware session calculations
                let sessionsPerWeek: number;
                let sessionsPerCycle: number;
                let totalSessions: number;

                if (freq === 'CUSTOM') {
                    totalSessions = customForm.customDates.length;
                    sessionsPerCycle = Math.round(totalSessions / Math.max(1, customForm.durationMonths));
                    sessionsPerWeek = Math.round(totalSessions / Math.max(1, customForm.durationMonths * 4));
                } else {
                    sessionsPerWeek = customForm.selectedDays.length;
                    if (freq === 'BIWEEKLY') {
                        sessionsPerCycle = sessionsPerWeek * 2;
                    } else if (freq === 'MONTHLY') {
                        sessionsPerCycle = sessionsPerWeek * customForm.weekPattern.length;
                    } else {
                        sessionsPerCycle = sessionsPerWeek * 4;
                    }
                    totalSessions = sessionsPerCycle * customForm.durationMonths;
                }

                // Dynamic discount thresholds based on tier base price
                // 12 sessions equivalent ? 30%, 24 sessions equivalent ? 40%
                const threshold30 = 12 * basePrice;
                const threshold40 = 24 * basePrice;

                // Raw costs (no discount) — full price for threshold comparison
                const activeAddonEntries = Object.entries(customAddonConfig).filter(([, v]) => v.mode !== 'none');
                let rawAddonsCostTotal = 0;
                for (const [key, config] of activeAddonEntries) {
                    const addon = customAddons.find(a => a.key === key);
                    if (!addon) continue;
                    if (config.mode === 'credits') rawAddonsCostTotal += addon.price * config.perCycle * customForm.durationMonths;
                    else rawAddonsCostTotal += addon.price * sessionsPerCycle * customForm.durationMonths;
                }
                const rawSessionsCostTotal = basePrice * totalSessions;
                const grossTotalValue = rawSessionsCostTotal + rawAddonsCostTotal;

                // Unified discount: compare gross total (full price) against dynamic thresholds
                let discountPct = 0;
                if (grossTotalValue >= threshold40) discountPct = 40;
                else if (grossTotalValue >= threshold30) discountPct = 30;

                const discountedSessionPrice = Math.round(basePrice * (1 - discountPct / 100));
                const cycleBaseAmount = sessionsPerCycle * discountedSessionPrice;

                // Add-ons cost WITH discount applied (for Step 4 / payment)
                let addonsCostPerCycle = 0;
                for (const [key, config] of activeAddonEntries) {
                    const addon = customAddons.find(a => a.key === key);
                    if (!addon) continue;
                    if (config.mode === 'credits') addonsCostPerCycle += Math.round(addon.price * config.perCycle * (1 - discountPct / 100));
                    else addonsCostPerCycle += Math.round(addon.price * sessionsPerCycle * (1 - discountPct / 100));
                }
                const cycleAmount = cycleBaseAmount + addonsCostPerCycle;
                const totalAmount = cycleAmount * customForm.durationMonths;

                // Progress bar: always relative to threshold40 (max bar)
                const valProgressPct = Math.min((grossTotalValue / threshold40) * 100, 100);
                const threshold30Pct = (threshold30 / threshold40) * 100; // marker position for 30%

                const schedule = customForm.selectedDays.map(day => ({
                    day, time: customForm.dayTimes[day] || POSSIBLE_SLOTS[customForm.tier]?.[0] || '10:00',
                }));

                const toggleDay = (day: number) => {
                    if (customForm.selectedDays.includes(day)) {
                        setCustomForm(f => ({ ...f, selectedDays: f.selectedDays.filter(d => d !== day), dayTimes: (() => { const n = { ...f.dayTimes }; delete n[day]; return n; })() }));
                    } else {
                        setCustomForm(f => ({ ...f, selectedDays: [...f.selectedDays, day].sort(), dayTimes: { ...f.dayTimes, [day]: POSSIBLE_SLOTS[f.tier]?.[0] || '10:00' } }));
                    }
                };

                const canStep1 = customForm.userId && customForm.name.length >= 2;
                const canStep2 = freq === 'CUSTOM' ? customForm.customDates.length >= 1 : sessionsPerWeek >= 1;
                const canStep3 = true; // addons are optional
                const canStep4 = !!customForm.paymentMethod;

                const handleCustomSubmit = async () => {
                    setCustomSubmitting(true); setCustomError('');
                    try {
                        const activeAddonKeys = activeAddonEntries.map(([k]) => k);
                        const addonConfigPayload: Record<string, { mode: 'all' | 'credits'; perCycle?: number }> = {};
                        for (const [key, config] of activeAddonEntries) {
                            addonConfigPayload[key] = { mode: config.mode as 'all' | 'credits', ...(config.mode === 'credits' ? { perCycle: config.perCycle } : {}) };
                        }
                        await contractsApi.createCustom({
                            userId: customForm.userId,
                            name: customForm.name,
                            tier: customForm.tier as 'COMERCIAL' | 'AUDIENCIA' | 'SABADO',
                            durationMonths: customForm.durationMonths,
                            schedule: freq !== 'CUSTOM' ? schedule : [],
                            paymentMethod: customForm.paymentMethod as 'CARTAO' | 'PIX' | 'BOLETO',
                            addOns: activeAddonKeys.length > 0 ? activeAddonKeys : undefined,
                            addonConfig: activeAddonKeys.length > 0 ? addonConfigPayload : undefined,
                            startDate: customForm.startDate,
                            frequency: freq,
                            weekPattern: (freq === 'BIWEEKLY' || freq === 'MONTHLY') ? customForm.weekPattern : undefined,
                            customDates: freq === 'CUSTOM' ? customForm.customDates : undefined,
                        });
                        setCustomSuccess('Contrato personalizado criado com sucesso!');
                        await loadData();
                        setTimeout(() => { setShowCustom(false); setCustomSuccess(''); }, 2000);
                    } catch (err: unknown) { setCustomError(getErrorMessage(err) || 'Erro ao criar contrato'); }
                    finally { setCustomSubmitting(false); }
                };

                const nextThreshold = totalSessions < 12 ? 12 : totalSessions < 24 ? 24 : null;
                const progressPct = nextThreshold ? Math.min((totalSessions / nextThreshold) * 100, 100) : 100;

                // Mini-calendar helper for CUSTOM mode
                const getCalendarMonth = (year: number, month: number) => {
                    const firstDay = new Date(year, month, 1).getDay();
                    const daysInMonth = new Date(year, month + 1, 0).getDate();
                    const weeks: (number | null)[][] = [];
                    let week: (number | null)[] = Array(firstDay).fill(null);
                    for (let d = 1; d <= daysInMonth; d++) {
                        week.push(d);
                        if (week.length === 7) { weeks.push(week); week = []; }
                    }
                    if (week.length > 0) { while (week.length < 7) week.push(null); weeks.push(week); }
                    return weeks;
                };
                const calStartDate = new Date(customForm.startDate + 'T00:00:00');
                const calEndDate = new Date(calStartDate); calEndDate.setMonth(calEndDate.getMonth() + customForm.durationMonths);
                const calWeeks = getCalendarMonth(calMonth.year, calMonth.month);
                const toggleCalDate = (dateStr: string) => {
                    setCustomForm(f => {
                        const exists = f.customDates.find(cd => cd.date === dateStr);
                        if (exists) return { ...f, customDates: f.customDates.filter(cd => cd.date !== dateStr) };
                        return { ...f, customDates: [...f.customDates, { date: dateStr, time: POSSIBLE_SLOTS[f.tier]?.[0] || '10:00' }].sort((a, b) => a.date.localeCompare(b.date)) };
                    });
                };
                const updateCalTime = (dateStr: string, time: string) => {
                    setCustomForm(f => ({ ...f, customDates: f.customDates.map(cd => cd.date === dateStr ? { ...cd, time } : cd) }));
                };
                const prevMonth = () => setCalMonth(m => m.month === 0 ? { year: m.year - 1, month: 11 } : { ...m, month: m.month - 1 });
                const nextMonth = () => setCalMonth(m => m.month === 11 ? { year: m.year + 1, month: 0 } : { ...m, month: m.month + 1 });
                const monthNames = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

                return (
                    <ModalOverlay onClose={() => setShowCustom(false)}>
                        <div className="modal" style={{ maxWidth: 580, maxHeight: '92vh', overflowY: 'auto', padding: 0 }}>
                            {/* Header */}
                            <div style={{ padding: '28px 32px 0', borderBottom: 'none' }}>
                                <h2 style={{ fontSize: '1.25rem', fontWeight: 800, margin: 0, display: 'flex', alignItems: 'center', gap: '10px' }}>
                                    <span style={{ width: 36, height: 36, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'linear-gradient(135deg, #2dd4bf, #3b82f6)', fontSize: '1rem' }}>??</span>
                                    Contrato Personalizado
                                </h2>
                                <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '6px', marginBottom: 0 }}>
                                    Monte um plano sob medida para o cliente
                                </p>
                                {/* Step indicator */}
                                <div style={{ display: 'flex', gap: '8px', marginTop: '16px' }}>
                                    {[{ n: 1, label: 'Plano' }, { n: 2, label: 'Agenda' }, { n: 3, label: 'Serviços' }, { n: 4, label: 'Resumo' }].map(s => (
                                        <div key={s.n} style={{
                                            flex: 1, padding: '8px', borderRadius: '8px', textAlign: 'center', fontSize: '0.625rem', fontWeight: 700,
                                            background: customStep === s.n ? 'rgba(45,212,191,0.12)' : customStep > s.n ? 'rgba(16,185,129,0.08)' : 'var(--bg-elevated)',
                                            border: `1px solid ${customStep === s.n ? 'rgba(45,212,191,0.3)' : customStep > s.n ? 'rgba(16,185,129,0.2)' : 'var(--border-default)'}`,
                                            color: customStep === s.n ? '#2dd4bf' : customStep > s.n ? '#10b981' : 'var(--text-muted)',
                                            transition: 'all 0.2s',
                                        }}>
                                            {customStep > s.n ? '?' : s.n}. {s.label}
                                        </div>
                                    ))}
                                </div>
                            </div>

                            {customError && <div style={{ margin: '16px 32px 0', padding: '10px 14px', borderRadius: '10px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.15)', color: '#ef4444', fontSize: '0.8125rem', fontWeight: 600 }}>{customError}</div>}
                            {customSuccess && <div style={{ margin: '16px 32px 0', padding: '10px 14px', borderRadius: '10px', background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.15)', color: '#10b981', fontSize: '0.8125rem', fontWeight: 600 }}>{customSuccess}</div>}

                            <div style={{ padding: '20px 32px 28px' }}>

                                {/* --- STEP 1: Cliente & Plano --- */}
                                {customStep === 1 && (
                                    <div>
                                        <div style={{ fontSize: '0.625rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: '14px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                            <span style={{ width: 18, height: 18, borderRadius: '50%', background: '#10b981', color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.5rem', fontWeight: 800 }}>1</span>
                                            Cliente & Plano
                                        </div>

                                        {/* Client selector */}
                                        <div style={{ marginBottom: '12px' }}>
                                            <label style={cusLabelStyle}>Cliente *</label>
                                            <div style={{ position: 'relative' }}>
                                                <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: '0.75rem', opacity: 0.5 }}>??</span>
                                                <select value={customForm.userId} onChange={e => setCustomForm(f => ({ ...f, userId: e.target.value }))}
                                                    style={{ ...cusInputStyle(), appearance: 'none', cursor: 'pointer', paddingRight: '32px', background: `var(--bg-elevated) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23888' stroke-width='1.5' fill='none'/%3E%3C/svg%3E") right 12px center no-repeat` }}>
                                                    <option value="">Selecione um cliente...</option>
                                                    {users.filter(u => u.role === 'CLIENTE').map(u => (
                                                        <option key={u.id} value={u.id}>{u.name} ({u.email})</option>
                                                    ))}
                                                </select>
                                            </div>
                                        </div>

                                        {/* Contract name */}
                                        <div style={{ marginBottom: '12px' }}>
                                            <label style={cusLabelStyle}>Nome do Contrato *</label>
                                            <div style={{ position: 'relative' }}>
                                                <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: '0.75rem', opacity: 0.5 }}>??</span>
                                                <input value={customForm.name} onChange={e => setCustomForm(f => ({ ...f, name: e.target.value }))}
                                                    placeholder='Ex: Podcast Verão 2x/semana' style={cusInputStyle()}
                                                    onFocus={e => e.currentTarget.style.borderColor = '#2dd4bf'}
                                                    onBlur={e => e.currentTarget.style.borderColor = 'var(--border-default)'}
                                                />
                                            </div>
                                        </div>

                                        {/* Tier selector */}
                                        <div style={{ marginBottom: '12px' }}>
                                            <label style={cusLabelStyle}>Faixa Horária</label>
                                            <div style={{ display: 'flex', gap: '6px' }}>
                                                {[{ key: 'COMERCIAL', emoji: '??', label: 'Comercial', desc: 'Até 17:30' }, { key: 'AUDIENCIA', emoji: '??', label: 'Audiência', desc: 'Até 23:00' }, { key: 'SABADO', emoji: '??', label: 'Sábado', desc: 'Sáb exclusivo' }].map(t => (
                                                    <button key={t.key} onClick={() => setCustomForm(f => ({ ...f, tier: t.key, selectedDays: [], dayTimes: {} }))}
                                                        style={{
                                                            flex: 1, padding: '10px 8px', borderRadius: '10px', cursor: 'pointer',
                                                            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px',
                                                            background: customForm.tier === t.key ? 'rgba(45,212,191,0.1)' : 'var(--bg-elevated)',
                                                            border: `1px solid ${customForm.tier === t.key ? 'rgba(45,212,191,0.3)' : 'var(--border-default)'}`,
                                                            transition: 'all 0.15s',
                                                        }}>
                                                        <span style={{ fontSize: '1.25rem' }}>{t.emoji}</span>
                                                        <span style={{ fontSize: '0.75rem', fontWeight: 700, color: customForm.tier === t.key ? '#2dd4bf' : 'var(--text-primary)' }}>{t.label}</span>
                                                        <span style={{ fontSize: '0.5625rem', color: 'var(--text-muted)' }}>{t.desc} — {formatBRL(pricing.find(p => p.tier === t.key)?.price || 0)}</span>
                                                    </button>
                                                ))}
                                            </div>
                                        </div>

                                        {/* Duration + Start date */}
                                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                                            <div>
                                                <label style={cusLabelStyle}>Duração (meses)</label>
                                                <div style={{ position: 'relative' }}>
                                                    <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: '0.75rem', opacity: 0.5 }}>??</span>
                                                    <select value={customForm.durationMonths} onChange={e => setCustomForm(f => ({ ...f, durationMonths: Number(e.target.value) }))}
                                                        style={{ ...cusInputStyle(), appearance: 'none', cursor: 'pointer', paddingRight: '32px', background: `var(--bg-elevated) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23888' stroke-width='1.5' fill='none'/%3E%3C/svg%3E") right 12px center no-repeat` }}>
                                                        {[1, 2, 3, 4, 5, 6, 9, 12].map(m => (<option key={m} value={m}>{m} {m === 1 ? 'mês' : 'meses'}</option>))}
                                                    </select>
                                                </div>
                                            </div>
                                            <div>
                                                <label style={cusLabelStyle}>Data Início</label>
                                                <div style={{ position: 'relative' }}>
                                                    <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: '0.75rem', opacity: 0.5 }}>???</span>
                                                    <input type="date" value={customForm.startDate} onChange={e => setCustomForm(f => ({ ...f, startDate: e.target.value }))}
                                                        style={cusInputStyle()}
                                                        onFocus={e => e.currentTarget.style.borderColor = '#2dd4bf'}
                                                        onBlur={e => e.currentTarget.style.borderColor = 'var(--border-default)'}
                                                    />
                                                </div>
                                            </div>
                                        </div>

                                        {/* Actions */}
                                        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '20px' }}>
                                            <button onClick={() => { if (canStep1) setCustomStep(2); }} disabled={!canStep1}
                                                style={{
                                                    padding: '10px 28px', borderRadius: '10px', border: 'none', fontSize: '0.875rem', fontWeight: 700, cursor: 'pointer',
                                                    background: canStep1 ? 'linear-gradient(135deg, #2dd4bf, #3b82f6)' : 'var(--bg-elevated)',
                                                    color: canStep1 ? '#fff' : 'var(--text-muted)', opacity: canStep1 ? 1 : 0.5,
                                                    display: 'flex', alignItems: 'center', gap: '8px',
                                                }}>
                                                Próximo ?
                                            </button>
                                        </div>
                                    </div>
                                )}

                                {/* --- STEP 2: Agenda --- */}
                                {customStep === 2 && (
                                    <div>
                                        <div style={{ fontSize: '0.625rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: '14px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                            <span style={{ width: 18, height: 18, borderRadius: '50%', background: '#3b82f6', color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.5rem', fontWeight: 800 }}>2</span>
                                            Configuração de Agenda
                                        </div>

                                        {/* Frequency tabs */}
                                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '4px', marginBottom: '16px', background: 'var(--bg-elevated)', borderRadius: '10px', padding: '3px', border: '1px solid var(--border-default)' }}>
                                            {([
                                                { key: 'WEEKLY', emoji: '??', label: 'Semanal' },
                                                { key: 'BIWEEKLY', emoji: '??', label: 'Quinzenal' },
                                                { key: 'MONTHLY', emoji: '??', label: 'Mensal' },
                                                { key: 'CUSTOM', emoji: '??', label: 'Datas Livres' },
                                            ] as const).map(fm => (
                                                <button key={fm.key} onClick={() => setCustomForm(f => ({ ...f, frequency: fm.key, selectedDays: [], dayTimes: {}, customDates: [] }))}
                                                    style={{
                                                        padding: '7px 4px', borderRadius: '8px', cursor: 'pointer', border: 'none',
                                                        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1px',
                                                        background: freq === fm.key ? 'rgba(59,130,246,0.12)' : 'transparent',
                                                        transition: 'all 0.15s',
                                                    }}>
                                                    <span style={{ fontSize: '0.875rem' }}>{fm.emoji}</span>
                                                    <span style={{ fontSize: '0.5625rem', fontWeight: 700, color: freq === fm.key ? '#3b82f6' : 'var(--text-muted)' }}>{fm.label}</span>
                                                </button>
                                            ))}
                                        </div>

                                        {/* -- WEEKLY / BIWEEKLY / MONTHLY shared UI -- */}
                                        {freq !== 'CUSTOM' && (
                                            <>
                                                <label style={cusLabelStyle}>Dias da Semana</label>
                                                <div style={{ display: 'flex', gap: '6px', marginBottom: '10px' }}>
                                                    {(customForm.tier === 'SABADO' ? [6] : [1, 2, 3, 4, 5]).map(day => {
                                                        const names: Record<number, string> = { 1: 'Seg', 2: 'Ter', 3: 'Qua', 4: 'Qui', 5: 'Sex', 6: 'Sáb' };
                                                        const sel = customForm.selectedDays.includes(day);
                                                        return (
                                                            <button key={day} onClick={() => toggleDay(day)}
                                                                style={{
                                                                    flex: 1, padding: '10px 4px', borderRadius: '10px', cursor: 'pointer',
                                                                    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px',
                                                                    background: sel ? 'rgba(59,130,246,0.12)' : 'var(--bg-elevated)',
                                                                    border: `1px solid ${sel ? 'rgba(59,130,246,0.3)' : 'var(--border-default)'}`,
                                                                    transition: 'all 0.15s',
                                                                }}>
                                                                <span style={{ fontSize: '0.8125rem', fontWeight: 700, color: sel ? '#3b82f6' : 'var(--text-primary)' }}>{names[day]}</span>
                                                            </button>
                                                        );
                                                    })}
                                                </div>

                                                {freq === 'BIWEEKLY' && (
                                                    <div style={{ marginBottom: '10px' }}>
                                                        <label style={cusLabelStyle}>Padrão de Semanas</label>
                                                        <div style={{ display: 'flex', gap: '6px' }}>
                                                            {[{ pattern: [1, 3], label: 'Semanas 1 e 3', desc: '1ª e 3ª do ciclo' }, { pattern: [2, 4], label: 'Semanas 2 e 4', desc: '2ª e 4ª do ciclo' }].map(wp => {
                                                                const sel = JSON.stringify(customForm.weekPattern) === JSON.stringify(wp.pattern);
                                                                return (
                                                                    <button key={wp.label} onClick={() => setCustomForm(f => ({ ...f, weekPattern: wp.pattern }))}
                                                                        style={{
                                                                            flex: 1, padding: '10px 8px', borderRadius: '10px', cursor: 'pointer',
                                                                            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px',
                                                                            background: sel ? 'rgba(59,130,246,0.1)' : 'var(--bg-elevated)',
                                                                            border: `1px solid ${sel ? 'rgba(59,130,246,0.3)' : 'var(--border-default)'}`,
                                                                            transition: 'all 0.15s',
                                                                        }}>
                                                                        <span style={{ fontSize: '0.75rem', fontWeight: 700, color: sel ? '#3b82f6' : 'var(--text-primary)' }}>{wp.label}</span>
                                                                        <span style={{ fontSize: '0.5rem', color: 'var(--text-muted)' }}>{wp.desc}</span>
                                                                    </button>
                                                                );
                                                            })}
                                                        </div>
                                                    </div>
                                                )}

                                                {freq === 'MONTHLY' && (
                                                    <div style={{ marginBottom: '10px' }}>
                                                        <label style={cusLabelStyle}>Semanas do Mês</label>
                                                        <div style={{ display: 'flex', gap: '4px' }}>
                                                            {[1, 2, 3, 4].map(wk => {
                                                                const sel = customForm.weekPattern.includes(wk);
                                                                return (
                                                                    <button key={wk} onClick={() => setCustomForm(f => ({ ...f, weekPattern: sel ? f.weekPattern.filter(w => w !== wk) : [...f.weekPattern, wk].sort() }))}
                                                                        style={{
                                                                            flex: 1, padding: '10px 4px', borderRadius: '10px', cursor: 'pointer',
                                                                            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px',
                                                                            background: sel ? 'rgba(45,212,191,0.1)' : 'var(--bg-elevated)',
                                                                            border: `1px solid ${sel ? 'rgba(45,212,191,0.3)' : 'var(--border-default)'}`,
                                                                            transition: 'all 0.15s',
                                                                        }}>
                                                                        <span style={{ fontSize: '0.75rem', fontWeight: 700, color: sel ? '#2dd4bf' : 'var(--text-primary)' }}>{wk}ª</span>
                                                                        <span style={{ fontSize: '0.5rem', color: 'var(--text-muted)' }}>semana</span>
                                                                    </button>
                                                                );
                                                            })}
                                                        </div>
                                                    </div>
                                                )}

                                                {customForm.selectedDays.length > 0 && (
                                                    <div style={{ marginBottom: '12px' }}>
                                                        <label style={cusLabelStyle}>Horários por Dia</label>
                                                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '8px' }}>
                                                            {customForm.selectedDays.map(day => {
                                                                const dayNames: Record<number, string> = { 1: 'Segunda', 2: 'Terça', 3: 'Quarta', 4: 'Quinta', 5: 'Sexta', 6: 'Sábado' };
                                                                return (
                                                                    <div key={day} style={{ padding: '10px', borderRadius: '10px', background: 'rgba(59,130,246,0.04)', border: '1px solid rgba(59,130,246,0.1)' }}>
                                                                        <div style={{ fontSize: '0.625rem', fontWeight: 700, color: '#3b82f6', textTransform: 'uppercase', marginBottom: '6px' }}>{dayNames[day]}</div>
                                                                        <select value={customForm.dayTimes[day] || ''} onChange={e => setCustomForm(f => ({ ...f, dayTimes: { ...f.dayTimes, [day]: e.target.value } }))}
                                                                            style={{ width: '100%', padding: '6px 8px', borderRadius: '8px', fontSize: '0.8125rem', background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-primary)', outline: 'none', fontFamily: 'inherit', cursor: 'pointer' }}>
                                                                            {(POSSIBLE_SLOTS[customForm.tier] || []).map(t => (<option key={t} value={t}>{t}</option>))}
                                                                        </select>
                                                                    </div>
                                                                );
                                                            })}
                                                        </div>
                                                    </div>
                                                )}
                                            </>
                                        )}

                                        {/* -- CUSTOM: Mini-Calendar -- */}
                                        {freq === 'CUSTOM' && (
                                            <div>
                                                <label style={cusLabelStyle}>Selecione as Datas</label>
                                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                                                    <button onClick={prevMonth} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: '0.875rem', padding: '4px 8px' }}>?</button>
                                                    <span style={{ fontSize: '0.875rem', fontWeight: 700, color: 'var(--text-primary)' }}>{monthNames[calMonth.month]} {calMonth.year}</span>
                                                    <button onClick={nextMonth} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: '0.875rem', padding: '4px 8px' }}>?</button>
                                                </div>
                                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '2px', marginBottom: '2px' }}>
                                                    {['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'].map(d => (
                                                        <div key={d} style={{ textAlign: 'center', fontSize: '0.5rem', fontWeight: 700, color: 'var(--text-muted)', padding: '4px 0', textTransform: 'uppercase' }}>{d}</div>
                                                    ))}
                                                </div>
                                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '2px', marginBottom: '12px' }}>
                                                    {calWeeks.flat().map((day, idx) => {
                                                        if (day === null) return <div key={`e${idx}`} />;
                                                        const dateStr = `${calMonth.year}-${String(calMonth.month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                                                        const dateObj = new Date(dateStr + 'T00:00:00');
                                                        const inRange = dateObj >= calStartDate && dateObj < calEndDate;
                                                        const selected = customForm.customDates.some(cd => cd.date === dateStr);
                                                        const isToday = dateStr === new Date().toISOString().split('T')[0];
                                                        return (
                                                            <button key={dateStr} onClick={() => { if (inRange) toggleCalDate(dateStr); }} disabled={!inRange}
                                                                style={{
                                                                    padding: '6px 2px', borderRadius: '8px', cursor: inRange ? 'pointer' : 'default',
                                                                    fontSize: '0.75rem', fontWeight: selected ? 800 : isToday ? 700 : 500,
                                                                    background: selected ? 'rgba(45,212,191,0.2)' : 'transparent',
                                                                    border: `1.5px solid ${selected ? '#2dd4bf' : isToday ? 'rgba(59,130,246,0.3)' : 'transparent'}`,
                                                                    color: !inRange ? 'var(--text-muted)' : selected ? '#2dd4bf' : 'var(--text-primary)',
                                                                    opacity: inRange ? 1 : 0.3, transition: 'all 0.1s',
                                                                }}>
                                                                {day}
                                                            </button>
                                                        );
                                                    })}
                                                </div>
                                                {customForm.customDates.length > 0 && (
                                                    <div style={{ marginBottom: '12px' }}>
                                                        <label style={cusLabelStyle}>{customForm.customDates.length} data{customForm.customDates.length !== 1 ? 's' : ''} selecionada{customForm.customDates.length !== 1 ? 's' : ''}</label>
                                                        <div style={{ maxHeight: '150px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                                            {customForm.customDates.map(cd => {
                                                                const d = new Date(cd.date + 'T12:00:00');
                                                                const dn = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
                                                                return (
                                                                    <div key={cd.date} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 10px', borderRadius: '8px', background: 'rgba(45,212,191,0.04)', border: '1px solid rgba(45,212,191,0.1)' }}>
                                                                        <span style={{ fontSize: '0.625rem', fontWeight: 700, color: '#2dd4bf', width: '24px' }}>{dn[d.getDay()]}</span>
                                                                        <span style={{ fontSize: '0.75rem', color: 'var(--text-primary)', flex: 1 }}>{String(d.getDate()).padStart(2, '0')}/{String(d.getMonth() + 1).padStart(2, '0')}/{d.getFullYear()}</span>
                                                                        <select value={cd.time} onChange={e => updateCalTime(cd.date, e.target.value)}
                                                                            style={{ padding: '3px 6px', borderRadius: '6px', fontSize: '0.6875rem', background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-primary)', outline: 'none', cursor: 'pointer' }}>
                                                                            {(POSSIBLE_SLOTS[customForm.tier] || []).map(t => (<option key={t} value={t}>{t}</option>))}
                                                                        </select>
                                                                        <button onClick={() => toggleCalDate(cd.date)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: '0.75rem', padding: '2px 4px' }}>?</button>
                                                                    </div>
                                                                );
                                                            })}
                                                        </div>
                                                    </div>
                                                )}
                                            </div>
                                        )}

                                        {/* Discount progress + summary */}
                                        <div style={{ padding: '14px', borderRadius: '10px', background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', marginBottom: '14px' }}>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                                                <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-primary)' }}>{totalSessions} sessões total</span>
                                                <span style={{ fontSize: '0.875rem', fontWeight: 800, color: discountPct > 0 ? '#10b981' : 'var(--text-muted)' }}>
                                                    {discountPct > 0 ? `${discountPct}% OFF` : 'Sem desconto'}
                                                </span>
                                            </div>
                                            <div style={{ height: '6px', borderRadius: '3px', background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
                                                <div style={{ height: '100%', width: `${progressPct}%`, borderRadius: '3px', background: discountPct >= 40 ? '#10b981' : discountPct >= 30 ? '#3b82f6' : '#f59e0b', transition: 'width 0.3s' }} />
                                            </div>
                                            {nextThreshold && (
                                                <div style={{ fontSize: '0.625rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                                                    +{nextThreshold - totalSessions} sessões para {nextThreshold >= 24 ? '40%' : '30%'} de desconto
                                                </div>
                                            )}
                                            <div style={{ display: 'grid', gridTemplateColumns: freq === 'CUSTOM' ? '1fr 1fr' : '1fr 1fr 1fr', gap: '8px', marginTop: '10px' }}>
                                                {freq !== 'CUSTOM' && (
                                                    <div style={{ textAlign: 'center' }}>
                                                        <div style={{ fontSize: '1.25rem', fontWeight: 800, color: 'var(--text-primary)' }}>{sessionsPerWeek}</div>
                                                        <div style={{ fontSize: '0.5625rem', color: 'var(--text-muted)' }}>por semana</div>
                                                    </div>
                                                )}
                                                <div style={{ textAlign: 'center' }}>
                                                    <div style={{ fontSize: '1.25rem', fontWeight: 800, color: 'var(--text-primary)' }}>{sessionsPerCycle}</div>
                                                    <div style={{ fontSize: '0.5625rem', color: 'var(--text-muted)' }}>por ciclo</div>
                                                </div>
                                                <div style={{ textAlign: 'center' }}>
                                                    <div style={{ fontSize: '1.25rem', fontWeight: 800, color: '#2dd4bf' }}>{formatBRL(discountedSessionPrice)}</div>
                                                    <div style={{ fontSize: '0.5625rem', color: 'var(--text-muted)' }}>por sessão</div>
                                                </div>
                                            </div>
                                        </div>

                                        {/* Actions */}
                                        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '20px' }}>
                                            <button onClick={() => setCustomStep(1)}
                                                style={{ padding: '10px 20px', borderRadius: '10px', background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-secondary)', fontSize: '0.8125rem', fontWeight: 600, cursor: 'pointer' }}>
                                                ? Voltar
                                            </button>
                                            <button onClick={() => { if (canStep2) setCustomStep(3); }} disabled={!canStep2}
                                                style={{
                                                    padding: '10px 28px', borderRadius: '10px', border: 'none', fontSize: '0.875rem', fontWeight: 700, cursor: 'pointer',
                                                    background: canStep2 ? 'linear-gradient(135deg, #2dd4bf, #3b82f6)' : 'var(--bg-elevated)',
                                                    color: canStep2 ? '#fff' : 'var(--text-muted)', opacity: canStep2 ? 1 : 0.5,
                                                    display: 'flex', alignItems: 'center', gap: '8px',
                                                }}>
                                                Próximo ?
                                            </button>
                                        </div>
                                    </div>
                                )}


                                {/* --- STEP 3: Serviços Adicionais --- */}
                                {customStep === 3 && (
                                    <div>
                                        <div style={{ fontSize: '0.625rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: '14px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                            <span style={{ width: 18, height: 18, borderRadius: '50%', background: '#2dd4bf', color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.5rem', fontWeight: 800 }}>3</span>
                                            Serviços Adicionais
                                        </div>

                                        {/* Value-based discount progress */}
                                        <div style={{ padding: '14px', borderRadius: '10px', background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', marginBottom: '14px' }}>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                                                <span style={{ fontSize: '0.6875rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                                                    {discountPct > 0 ? `?? ${discountPct}% de desconto ativo` : 'Barra de Desconto'}
                                                </span>
                                                <span style={{ fontSize: '0.75rem', fontWeight: 800, color: discountPct >= 40 ? '#10b981' : discountPct >= 30 ? '#3b82f6' : '#f59e0b' }}>
                                                    {formatBRL(grossTotalValue)}
                                                </span>
                                            </div>
                                            <div style={{ fontSize: '0.5625rem', color: 'var(--text-muted)', marginBottom: '6px' }}>
                                                {discountPct >= 40
                                                    ? `Desconto máximo atingido! (${totalSessions} gravações + serviços)`
                                                    : discountPct >= 30
                                                        ? `Faltam ${formatBRL(threshold40 - grossTotalValue)} para 40% de desconto`
                                                        : `${totalSessions} gravações — adicione serviços para desbloquear descontos`
                                                }
                                            </div>
                                            <div style={{ height: '8px', borderRadius: '4px', background: 'rgba(255,255,255,0.06)', overflow: 'hidden', position: 'relative' }}>
                                                <div style={{ height: '100%', width: `${valProgressPct}%`, borderRadius: '4px', background: discountPct >= 40 ? '#10b981' : discountPct >= 30 ? '#3b82f6' : 'linear-gradient(90deg, #f59e0b, #ef4444)', transition: 'width 0.3s' }} />
                                                {/* 30% threshold marker */}
                                                <div style={{ position: 'absolute', left: `${threshold30Pct}%`, top: 0, bottom: 0, width: '1.5px', background: 'rgba(59,130,246,0.5)' }} />
                                            </div>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px', fontSize: '0.5rem', color: 'var(--text-muted)' }}>
                                                <span>R$ 0</span>
                                                <span style={{ color: grossTotalValue >= threshold30 ? '#3b82f6' : 'var(--text-muted)', fontWeight: grossTotalValue >= threshold30 ? 700 : 400 }}>{formatBRL(threshold30)} (30%)</span>
                                                <span style={{ color: grossTotalValue >= threshold40 ? '#10b981' : 'var(--text-muted)', fontWeight: grossTotalValue >= threshold40 ? 700 : 400 }}>{formatBRL(threshold40)} (40%)</span>
                                            </div>
                                            {discountPct < 30 && (
                                                <div style={{ fontSize: '0.5625rem', color: '#f59e0b', marginTop: '6px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                                                    <span>??</span>
                                                    Faltam {formatBRL(threshold30 - grossTotalValue)} para 30% de desconto
                                                </div>
                                            )}
                                        </div>

                                        {/* Add-ons list */}
                                        {customAddons.length > 0 && (
                                            <div style={{ marginBottom: '14px' }}>
                                                <label style={cusLabelStyle}>Adicionar Serviços</label>
                                                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                                    {customAddons.map(addon => {
                                                        const cfg = customAddonConfig[addon.key] || { mode: 'none', perCycle: 4 };
                                                        const addonDiscountedPrice = Math.round(addon.price * (1 - discountPct / 100));
                                                        return (
                                                            <div key={addon.key} style={{
                                                                padding: '10px 12px', borderRadius: '10px',
                                                                background: cfg.mode !== 'none' ? 'rgba(45,212,191,0.04)' : 'var(--bg-elevated)',
                                                                border: `1px solid ${cfg.mode !== 'none' ? 'rgba(45,212,191,0.15)' : 'var(--border-default)'}`,
                                                            }}>
                                                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                                                    <div>
                                                                        <div style={{ fontSize: '0.8125rem', fontWeight: 700, color: 'var(--text-primary)' }}>{addon.name}</div>
                                                                        <div style={{ fontSize: '0.625rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                                                                            {discountPct > 0 && <span style={{ textDecoration: 'line-through', opacity: 0.5 }}>{formatBRL(addon.price)}</span>}
                                                                            <span style={{ fontWeight: discountPct > 0 ? 700 : 400, color: discountPct > 0 ? '#2dd4bf' : 'var(--text-muted)' }}>
                                                                                {formatBRL(addonDiscountedPrice)}/un
                                                                            </span>
                                                                            {discountPct > 0 && <span style={{ fontSize: '0.5rem', color: '#10b981', fontWeight: 700 }}>-{discountPct}%</span>}
                                                                        </div>
                                                                    </div>
                                                                    <div style={{ display: 'flex', gap: '3px' }}>
                                                                        {['none', 'all', 'credits'].map(mode => (
                                                                            <button key={mode} onClick={() => setCustomAddonConfig(prev => ({ ...prev, [addon.key]: { ...cfg, mode: mode as any } }))}
                                                                                style={{
                                                                                    padding: '4px 8px', borderRadius: '6px', fontSize: '0.5625rem', fontWeight: 700, cursor: 'pointer',
                                                                                    background: cfg.mode === mode ? (mode === 'none' ? 'rgba(107,114,128,0.15)' : 'rgba(45,212,191,0.12)') : 'transparent',
                                                                                    border: `1px solid ${cfg.mode === mode ? (mode === 'none' ? 'rgba(107,114,128,0.3)' : 'rgba(45,212,191,0.3)') : 'transparent'}`,
                                                                                    color: cfg.mode === mode ? (mode === 'none' ? '#6b7280' : '#2dd4bf') : 'var(--text-muted)',
                                                                                }}>
                                                                                {mode === 'none' ? 'Não' : mode === 'all' ? 'Todas' : 'Créditos'}
                                                                            </button>
                                                                        ))}
                                                                    </div>
                                                                </div>
                                                                {cfg.mode === 'credits' && (
                                                                    <div style={{ marginTop: '8px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                                                                        <span style={{ fontSize: '0.625rem', color: 'var(--text-muted)' }}>Créditos/ciclo:</span>
                                                                        <input type="number" min={1} max={20} value={cfg.perCycle}
                                                                            onChange={e => setCustomAddonConfig(prev => ({ ...prev, [addon.key]: { ...cfg, perCycle: Math.max(1, Number(e.target.value)) } }))}
                                                                            style={{ width: '60px', padding: '4px 8px', borderRadius: '6px', fontSize: '0.75rem', background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-primary)', outline: 'none', textAlign: 'center' }}
                                                                        />
                                                                    </div>
                                                                )}
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            </div>
                                        )}

                                        {/* Quick cost preview */}
                                        {addonsCostPerCycle > 0 && (
                                            <div style={{ padding: '10px 12px', borderRadius: '10px', background: 'rgba(45,212,191,0.04)', border: '1px solid rgba(45,212,191,0.1)', marginBottom: '14px' }}>
                                                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem' }}>
                                                    <span style={{ color: 'var(--text-muted)' }}>Add-ons/ciclo</span>
                                                    <span style={{ color: '#2dd4bf', fontWeight: 700 }}>+ {formatBRL(addonsCostPerCycle)}</span>
                                                </div>
                                                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8125rem', marginTop: '4px', borderTop: '1px solid rgba(45,212,191,0.1)', paddingTop: '6px' }}>
                                                    <span style={{ color: 'var(--text-primary)', fontWeight: 700 }}>Total/ciclo (gravações + add-ons)</span>
                                                    <span style={{ color: '#10b981', fontWeight: 800 }}>{formatBRL(cycleAmount)}</span>
                                                </div>
                                            </div>
                                        )}

                                        {/* Actions */}
                                        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '20px' }}>
                                            <button onClick={() => setCustomStep(2)}
                                                style={{ padding: '10px 20px', borderRadius: '10px', background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-secondary)', fontSize: '0.8125rem', fontWeight: 600, cursor: 'pointer' }}>
                                                ? Voltar
                                            </button>
                                            <button onClick={() => setCustomStep(4)}
                                                style={{
                                                    padding: '10px 28px', borderRadius: '10px', border: 'none', fontSize: '0.875rem', fontWeight: 700, cursor: 'pointer',
                                                    background: 'linear-gradient(135deg, #2dd4bf, #3b82f6)',
                                                    color: '#fff',
                                                    display: 'flex', alignItems: 'center', gap: '8px',
                                                }}>
                                                Próximo ?
                                            </button>
                                        </div>
                                    </div>
                                )}

                                {/* --- STEP 4: Pagamento & Resumo --- */}
                                {customStep === 4 && (
                                    <div>
                                        <div style={{ fontSize: '0.625rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: '14px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                            <span style={{ width: 18, height: 18, borderRadius: '50%', background: 'rgba(16,185,129,0.15)', color: '#10b981', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.5rem', fontWeight: 800 }}>4</span>
                                            <span style={{ fontSize: '0.6875rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Pagamento & Resumo</span>
                                        </div>

                                        {/* Payment method */}
                                        <label style={cusLabelStyle}>Método de Pagamento *</label>
                                        <div style={{ display: 'flex', gap: '6px', marginBottom: '16px' }}>
                                            {getPaymentMethods().map(pm => (
                                                <button key={pm.key} onClick={() => setCustomForm(f => ({ ...f, paymentMethod: pm.key }))}
                                                    style={{
                                                        flex: 1, padding: '10px 8px', borderRadius: '10px', cursor: 'pointer',
                                                        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px',
                                                        background: customForm.paymentMethod === pm.key ? pm.bgActive : 'var(--bg-elevated)',
                                                        border: `1px solid ${customForm.paymentMethod === pm.key ? pm.borderActive : 'var(--border-default)'}`,
                                                        transition: 'all 0.15s',
                                                    }}>
                                                    <span style={{ fontSize: '1.25rem' }}>{pm.emoji}</span>
                                                    <span style={{ fontSize: '0.75rem', fontWeight: 700, color: customForm.paymentMethod === pm.key ? pm.color : 'var(--text-primary)' }}>{pm.shortLabel}</span>
                                                    <span style={{ fontSize: '0.5rem', color: 'var(--text-muted)' }}>{pm.adminDescription}</span>
                                                </button>
                                            ))}
                                        </div>

                                        {/* Financial summary */}
                                        <div style={{ padding: '16px', borderRadius: '10px', background: 'rgba(16,185,129,0.04)', border: '1px solid rgba(16,185,129,0.1)', marginBottom: '16px' }}>
                                            <div style={{ fontSize: '0.625rem', fontWeight: 700, color: '#10b981', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '10px' }}>?? Resumo Financeiro</div>
                                            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '0.8125rem' }}>
                                                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                                    <span style={{ color: 'var(--text-muted)' }}>Base/sessão</span>
                                                    <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
                                                        {discountPct > 0 && <span style={{ textDecoration: 'line-through', color: 'var(--text-muted)', marginRight: '6px', fontSize: '0.75rem' }}>{formatBRL(basePrice)}</span>}
                                                        {formatBRL(discountedSessionPrice)}
                                                    </span>
                                                </div>
                                                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                                    <span style={{ color: 'var(--text-muted)' }}>{sessionsPerCycle} sessões/ciclo × {formatBRL(discountedSessionPrice)}</span>
                                                    <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{formatBRL(cycleBaseAmount)}</span>
                                                </div>
                                                {addonsCostPerCycle > 0 && (
                                                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                                        <span style={{ color: 'var(--text-muted)' }}>Add-ons/ciclo</span>
                                                        <span style={{ color: '#2dd4bf', fontWeight: 600 }}>+ {formatBRL(addonsCostPerCycle)}</span>
                                                    </div>
                                                )}
                                                {discountPct > 0 && (
                                                    <div style={{ display: 'flex', justifyContent: 'space-between', background: 'rgba(16,185,129,0.06)', margin: '2px -8px', padding: '4px 8px', borderRadius: '6px' }}>
                                                        <span style={{ color: '#10b981', fontWeight: 600 }}>Desconto aplicado</span>
                                                        <span style={{ color: '#10b981', fontWeight: 700 }}>{discountPct}% OFF</span>
                                                    </div>
                                                )}
                                                <div style={{ borderTop: '1px solid rgba(16,185,129,0.15)', paddingTop: '6px', marginTop: '4px', display: 'flex', justifyContent: 'space-between' }}>
                                                    <span style={{ color: 'var(--text-primary)', fontWeight: 700 }}>Valor/ciclo</span>
                                                    <span style={{ color: '#10b981', fontWeight: 800, fontSize: '1rem' }}>{formatBRL(cycleAmount)}</span>
                                                </div>
                                                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                                    <span style={{ color: 'var(--text-muted)' }}>Total ({customForm.durationMonths} ciclos)</span>
                                                    <span style={{ color: 'var(--text-primary)', fontWeight: 700 }}>{formatBRL(totalAmount)}</span>
                                                </div>
                                            </div>
                                        </div>

                                        {/* Schedule summary */}
                                        <div style={{ padding: '12px 14px', borderRadius: '10px', background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', marginBottom: '16px', fontSize: '0.75rem' }}>
                                            <div style={{ fontWeight: 700, color: 'var(--text-primary)', marginBottom: '6px' }}>?? Agenda</div>
                                            {freq === 'CUSTOM' ? (
                                                <div style={{ color: 'var(--text-muted)' }}>{customForm.customDates.length} datas personalizadas</div>
                                            ) : (
                                                <>
                                                    {schedule.map(s => {
                                                        const dayNames: Record<number, string> = { 1: 'Segunda', 2: 'Terça', 3: 'Quarta', 4: 'Quinta', 5: 'Sexta', 6: 'Sábado' };
                                                        return <div key={s.day} style={{ color: 'var(--text-muted)' }}>{dayNames[s.day]} às {s.time}</div>;
                                                    })}
                                                    {freq !== 'WEEKLY' && (
                                                        <div style={{ color: 'var(--text-muted)', marginTop: '2px', fontSize: '0.625rem' }}>
                                                            Modo: {freq === 'BIWEEKLY' ? 'Quinzenal' : 'Mensal'} — Semanas {customForm.weekPattern.join(', ')}
                                                        </div>
                                                    )}
                                                </>
                                            )}
                                        </div>

                                        {/* Actions */}
                                        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '20px' }}>
                                            <button onClick={() => setCustomStep(3)}
                                                style={{ padding: '10px 20px', borderRadius: '10px', background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-secondary)', fontSize: '0.8125rem', fontWeight: 600, cursor: 'pointer' }}>
                                                ? Voltar
                                            </button>
                                            <button onClick={handleCustomSubmit} disabled={!canStep4 || customSubmitting}
                                                style={{
                                                    padding: '10px 28px', borderRadius: '10px', border: 'none', fontSize: '0.875rem', fontWeight: 700, cursor: 'pointer',
                                                    background: canStep4 && !customSubmitting ? 'linear-gradient(135deg, #10b981, #11819B)' : 'var(--bg-elevated)',
                                                    color: canStep4 && !customSubmitting ? '#fff' : 'var(--text-muted)',
                                                    opacity: canStep4 && !customSubmitting ? 1 : 0.5,
                                                    display: 'flex', alignItems: 'center', gap: '8px',
                                                }}>
                                                {customSubmitting ? '? Criando...' : '?? Criar Contrato'}
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    </ModalOverlay>
                );
            })()}
        </div>
    );
}

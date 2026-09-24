import { getErrorMessage } from '../utils/errors';
import { useState, useId } from 'react';
import { useNavigate } from 'react-router-dom';
import { contractsApi, Contract, ContractStatus } from '../api/client';
import { useBusinessConfig } from '../hooks/useBusinessConfig';
import { useUI } from '../context/UIContext';
import { FileText, Search, X, Inbox, Link2, FolderOpen, Pencil, CircleDollarSign, HandCoins, Ban, RefreshCw, Pause, Play, CreditCard, Sparkles, Loader2, Clock, UserX } from 'lucide-react';
import BottomSheetModal from '../components/BottomSheetModal';
import AdminPageHeader from '../components/admin/AdminPageHeader';
import { HeroSkeleton, TableSkeleton } from '../components/ui/SkeletonLoader';
import StatusBadge from '../components/ui/StatusBadge';
import Tooltip from '../components/ui/Tooltip';
import { CONTRACT_STATUS_META, CONTRACT_TYPE_META, TIER_META, getMeta } from '../constants/adminMeta';
import { getPaymentMethods, getPaymentBadge } from '../constants/paymentMethods';
import { useAdminContracts } from '../hooks/useAdminContracts';
import { describeContractTerms, isAvulsoContract } from '../utils/contractStatus';
import CreateContractModal from '../components/admin/contracts/CreateContractModal';
import CustomContractModal from '../components/admin/contracts/CustomContractModal';

/** Status que o admin pode escolher no "Editar" (espelha updateContractSchema do backend). */
const EDITABLE_STATUSES: readonly ContractStatus[] = ['ACTIVE', 'COMPLETED', 'EXPIRED', 'CANCELLED'];

/** Selo do contrato de cliente excluído (D3) — mesmas cores do selo "Excluído" do perfil. */
const DELETED_CLIENT_META = { label: 'Cliente excluído', color: 'var(--danger)', bg: 'var(--danger-bg)', icon: UserX };

/**
 * D3: GET /contracts traz user.deletedAt. Cliente excluído (anonimizado) não ganha obrigação nova:
 * a lista esconde Renovar/Pausar/Retomar/Cobrar multa e o "Editar" não reativa (o backend recusa 409).
 */
const isClientDeleted = (c: Contract) => !!(c.user as { deletedAt?: string | null } | undefined)?.deletedAt;

export default function AdminContractsPage() {
    const uid = useId();
    const navigate = useNavigate();
    const { showConfirm, showToast } = useUI();
    const {
        contracts,
        users,
        pricing,
        loading,
        refreshing,
        filter, setFilter,
        search, setSearch,
        reload,
    } = useAdminContracts();

    const [showCreate, setShowCreate] = useState(false);


    const [editContract, setEditContract] = useState<Contract | null>(null);
    const [editForm, setEditForm] = useState({ status: '', endDate: '', flexCreditsRemaining: '', contractUrl: '', paymentMethod: '', boletoAllowed: false });
    const [editError, setEditError] = useState('');
    // D3: "Editar" → status Cancelado passa pela confirmação de perigo; enquanto ela está aberta o
    // modal de edição não fecha pelo Esc (o Esc fecha só a confirmação).
    const [confirmingEditCancel, setConfirmingEditCancel] = useState(false);

    // --- Custom Contract Wizard ---
    const [showCustom, setShowCustom] = useState(false);

    const { get: getRule } = useBusinessConfig();
    const ep3 = getRule('episodes_3months');
    const ep6 = getRule('episodes_6months');
    const cancFine = getRule('cancellation_fine_pct');

    const submitEdit = async (contract: Contract, data: Record<string, unknown>) => {
        await contractsApi.update(contract.id, data);
        setEditContract(null);
        await reload();
    };

    const handleEdit = async () => {
        if (!editContract) return;
        setEditError('');
        try {
            const data: any = {};
            // Só envia o status quando MUDOU: o PATCH aceita apenas ACTIVE/COMPLETED/EXPIRED/CANCELLED,
            // então reenviar o atual de um contrato Pausado/Pend. cancelamento/Aguard. pagamento dava 400.
            if (editForm.status && editForm.status !== editContract.status) data.status = editForm.status;
            if (editForm.endDate) data.endDate = editForm.endDate;
            if (editForm.flexCreditsRemaining !== '') data.flexCreditsRemaining = Number(editForm.flexCreditsRemaining);
            if (editForm.contractUrl !== (editContract.contractUrl || '')) data.contractUrl = editForm.contractUrl;
            if (editForm.paymentMethod && editForm.paymentMethod !== (editContract.paymentMethod || '')) data.paymentMethod = editForm.paymentMethod;
            if (editForm.boletoAllowed !== (editContract.boletoAllowed ?? false)) data.boletoAllowed = editForm.boletoAllowed;
            // Mudar para Cancelado pelo "Editar" faz o MESMO que "Cancelar contrato" no backend (anula
            // parcelas, encerra a recorrência, cancela as gravações de hoje em diante) → confirmação danger.
            if (data.status === 'CANCELLED') {
                const c = editContract;
                setConfirmingEditCancel(true);
                showConfirm({
                    tone: 'danger',
                    icon: Ban,
                    title: 'Cancelar este contrato?',
                    message: `“${c.name}”${clientLabel(c)} será encerrado ao salvar. As demais alterações deste formulário são salvas junto.`,
                    consequences: [
                        ...cancelContractConsequences(c),
                        ...(c.status === 'PENDING_CANCELLATION'
                            ? ['O cliente pediu o cancelamento: salvar como Cancelado equivale a isentar a multa (para cobrá-la, use “Cobrar multa” na lista).']
                            : []),
                    ],
                    confirmLabel: 'Salvar e cancelar contrato',
                    cancelLabel: 'Voltar à edição',
                    // Sem try/catch: o erro do PATCH aparece dentro do diálogo.
                    onConfirm: async () => {
                        await submitEdit(c, data);
                        setConfirmingEditCancel(false);
                    },
                    onCancel: () => setConfirmingEditCancel(false),
                });
                return;
            }
            await submitEdit(editContract, data);
        } catch (err: unknown) { setEditError(getErrorMessage(err)); }
    };

    // D3 — confirmações com o que o backend faz DE FATO (contract.lifecycle.ts). Com `tone`, o
    // diálogo aguarda o onConfirm e mostra o erro dentro dele: por isso nada de try/catch aqui.
    function clientLabel(c: Contract) { return c.user?.name ? ` de ${c.user.name}` : ''; }

    /** O que o cancelamento faz (DELETE /contracts/:id e PATCH status CANCELLED fazem o mesmo). */
    function cancelContractConsequences(c: Contract): string[] {
        return [
            'O contrato passa a Cancelado.',
            ...(c.type === 'SERVICO' ? [] : ['As gravações de hoje em diante são canceladas e os horários ficam livres para outros clientes.']),
            'As parcelas pendentes são anuladas (deixam de ser cobradas) e a recorrência no cartão, se houver, é encerrada.',
            'Nenhuma multa é gerada e nada do que já foi pago é estornado.',
        ];
    }

    const handleCancel = (c: Contract) => {
        showConfirm({
            tone: 'danger',
            icon: Ban,
            title: 'Cancelar este contrato?',
            message: `“${c.name}”${clientLabel(c)} será encerrado agora.`,
            consequences: cancelContractConsequences(c),
            confirmLabel: 'Cancelar contrato',
            cancelLabel: 'Manter contrato',
            onConfirm: async () => {
                const res = await contractsApi.cancel(c.id);
                showToast(res.message || 'Contrato cancelado.');
                await reload();
            },
        });
    };

    const handleResolveCancel = (c: Contract, action: 'CHARGE_FEE' | 'WAIVE_FEE') => {
        const common = [
            'O contrato passa a Cancelado (as gravações futuras já foram liberadas quando o cliente pediu o cancelamento).',
            'As parcelas pendentes são anuladas e a recorrência no cartão, se houver, é encerrada.',
        ];
        if (action === 'CHARGE_FEE') {
            showConfirm({
                tone: 'danger',
                icon: CircleDollarSign,
                title: 'Cobrar a multa de cancelamento?',
                message: `Encerra “${c.name}”${clientLabel(c)} com a multa de ${cancFine}% prevista nas políticas.`,
                consequences: [
                    `É gerada uma cobrança de multa de ${cancFine}% sobre o total que o cliente já pagou neste contrato (sem nada pago, não há multa).`,
                    'A multa fica pendente para o cliente pagar: ela não é cobrada automaticamente no cartão.',
                    ...common,
                ],
                confirmLabel: 'Cobrar multa e cancelar',
                onConfirm: async () => {
                    const res = await contractsApi.resolveCancellation(c.id, action);
                    showToast(res.message);
                    await reload();
                },
            });
            return;
        }
        showConfirm({
            tone: 'warning',
            icon: HandCoins,
            title: 'Isentar a multa de cancelamento?',
            message: `Aceita o cancelamento de “${c.name}”${clientLabel(c)} sem cobrar multa.`,
            consequences: [
                'Nenhuma multa é gerada para o cliente.',
                ...common,
            ],
            confirmLabel: 'Isentar multa e cancelar',
            onConfirm: async () => {
                const res = await contractsApi.resolveCancellation(c.id, action);
                showToast(res.message);
                await reload();
            },
        });
    };

    // Pausar é reversível (warning). O backend só cancela gravações futuras do FIXO (a retomada
    // recria as do dia/horário fixo); FLEX/CUSTOM mantêm as sessões já agendadas.
    const handlePause = (c: Contract) => {
        showConfirm({
            tone: 'warning',
            icon: Pause,
            title: 'Pausar este contrato?',
            message: `“${c.name}”${clientLabel(c)} fica pausado até você retomar.`,
            consequences: c.type === 'FIXO'
                ? [
                    'As gravações agendadas daqui em diante são canceladas e os horários ficam livres para outros clientes.',
                    'Ao retomar, a vigência é estendida pelos dias em pausa e as gravações do dia e horário fixos são recriadas.',
                    'Parcelas pendentes não são cobradas automaticamente enquanto o contrato estiver pausado.',
                ]
                : [
                    'As gravações já agendadas são mantidas.',
                    'Ao retomar, a vigência é estendida pelos dias em pausa.',
                    'Parcelas pendentes não são cobradas automaticamente enquanto o contrato estiver pausado.',
                ],
            confirmLabel: 'Pausar contrato',
            onConfirm: async () => {
                const r = await contractsApi.pause(c.id, { reason: 'Pausa administrativa' });
                showToast(r.message);
                await reload();
            },
        });
    };

    const statusFiltered = filter === 'ALL' ? contracts : contracts.filter(c => c.status === filter);
    const filtered = search.trim().length >= 3
        ? statusFiltered.filter(c => {
            const q = search.toLowerCase();
            return (c.user?.name || '').toLowerCase().includes(q) || c.name.toLowerCase().includes(q);
        })
        : statusFiltered;
    const episodeCount = (months: number) => months === 3 ? ep3 : ep6;
    // L6: episodeCount só cobre 3/6 meses — para AVULSO (durationMonths=1) caía no ramo ep6 (24) errado.
    // Deriva do TIPO: AVULSO = 1 gravação; CUSTOM = totalSessions real; demais = episódios do plano por duração.
    const contractEpisodes = (c: { type: string; durationMonths: number; totalSessions?: number | null }) =>
        isAvulsoContract(c) ? 1 : c.type === 'CUSTOM' ? (c.totalSessions ?? episodeCount(c.durationMonths)) : episodeCount(c.durationMonths);

    const getDaysToExpiry = (endDate: string) => {
        const now = new Date();
        const end = new Date(endDate);
        return Math.ceil((end.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    };

    // Vencimento só vale para PLANOS ativos ou concluídos (o concluído continua renovável — D6).
    // O AVULSO é uma sessão única e nunca "vence" (mesma regra do alerta de expiração do backend).
    const tracksExpiry = (c: Contract) => (c.status === 'ACTIVE' || c.status === 'COMPLETED') && !isAvulsoContract(c);

    const getVencimentoBadge = (c: Contract) => {
        if (!tracksExpiry(c)) return null;
        const days = getDaysToExpiry(c.endDate);
        if (days <= 0) return { label: 'Vigência encerrada', color: '#6b7280', bg: 'rgba(107,114,128,0.15)' };
        if (days <= 7) return { label: `Vence em ${days}d`, color: '#dc2626', bg: 'rgba(220,38,38,0.15)' };
        if (days <= 30) return { label: `Vence em ${days}d`, color: '#d97706', bg: 'rgba(217,119,6,0.15)' };
        return null;
    };

    // KPI computations
    const activeContracts = contracts.filter(c => c.status === 'ACTIVE');
    const totalFlexCredits = activeContracts.reduce((sum, c) => sum + (c.flexCreditsRemaining || 0), 0);
    const expiringIn30 = contracts.filter(c => tracksExpiry(c) && getDaysToExpiry(c.endDate) <= 30 && getDaysToExpiry(c.endDate) > 0).length;
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
                        <button className="btn-admin-go" onClick={() => { setShowCreate(true); }}>
                            <span style={{ fontSize: '1.1rem' }} aria-hidden="true">+</span> Novo Contrato
                        </button>
                        <button onClick={() => { setShowCustom(true); }}
                            style={{
                                display: 'flex', alignItems: 'center', gap: '8px', padding: '12px 24px', borderRadius: '12px', fontWeight: 700,
                                background: 'linear-gradient(135deg, rgba(45,212,191,0.15), rgba(59,130,246,0.1))',
                                border: '1px solid rgba(45,212,191,0.3)', color: 'var(--accent-text)', cursor: 'pointer',
                                fontSize: '0.875rem', transition: 'background 0.2s ease, border-color 0.2s ease',
                            }}>
                            <Sparkles size={16} aria-hidden="true" /> Contrato Personalizado
                        </button>
                    </>
                }
            />

            {/* --- KPI CARDS --- */}
            <div className="admin-kpi-grid" style={{ marginBottom: '24px' }}>
                {/* Active */}
                <button type="button" onClick={() => setFilter('ACTIVE')} aria-pressed={filter === 'ACTIVE'}
                    className={`admin-kpi-card${filter === 'ACTIVE' ? ' admin-kpi-card--success' : ''}`}>
                    <div className="admin-kpi-card__label" style={{ color: 'var(--success)' }}>Ativos</div>
                    <div className="admin-kpi-card__value">{activeContracts.length}</div>
                    <div className="admin-kpi-card__caption">contratos em vigor</div>
                </button>
                {/* Pending Cancellation */}
                <button type="button" onClick={() => setFilter('PENDING_CANCELLATION')} aria-pressed={filter === 'PENDING_CANCELLATION'}
                    className="admin-kpi-card"
                    style={filter === 'PENDING_CANCELLATION' ? { background: 'linear-gradient(135deg, rgba(245,158,11,0.12), rgba(120,53,15,0.08))', borderColor: 'rgba(245,158,11,0.3)' } : undefined}>
                    <div className="admin-kpi-card__label" style={{ color: 'var(--warning)' }}>Pend. Cancelamento</div>
                    <div className="admin-kpi-card__value" style={pendingCancellation > 0 ? { color: 'var(--warning)' } : undefined}>{pendingCancellation}</div>
                    <div className="admin-kpi-card__caption">a resolver</div>
                </button>
                {/* Flex Credits */}
                <div className="admin-kpi-card">
                    <div className="admin-kpi-card__label" style={{ color: 'var(--accent-text)' }}>Créditos Flex</div>
                    <div className="admin-kpi-card__value">{totalFlexCredits}</div>
                    <div className="admin-kpi-card__caption">episódios restantes</div>
                </div>
                {/* Expiring */}
                <div className={`admin-kpi-card${expiringIn30 > 0 ? ' admin-kpi-card--danger' : ''}`}>
                    <div className="admin-kpi-card__label" style={expiringIn30 > 0 ? { color: 'var(--danger)' } : undefined}>Vencendo (30d)</div>
                    <div className="admin-kpi-card__value" style={expiringIn30 > 0 ? { color: 'var(--danger)' } : undefined}>{expiringIn30}</div>
                    <div className="admin-kpi-card__caption">atenção necessária</div>
                </div>
                {/* Total */}
                <button type="button" onClick={() => setFilter('ALL')} aria-pressed={filter === 'ALL'}
                    className={`admin-kpi-card${filter === 'ALL' ? ' admin-kpi-card--accent' : ''}`}>
                    <div className="admin-kpi-card__label">Total</div>
                    <div className="admin-kpi-card__value">{contracts.length}</div>
                    <div className="admin-kpi-card__caption">todos os contratos</div>
                </button>
            </div>

            {/* --- SEARCH + FILTERS --- */}
            <div className="admin-filter-bar admin-filter-bar--panel">
                <div className="admin-search">
                    <input
                        type="text" placeholder="Buscar por projeto ou cliente..."
                        aria-label="Buscar por projeto ou cliente"
                        value={search} onChange={e => setSearch(e.target.value)}
                    />
                    <Search size={14} className="admin-search__icon" aria-hidden="true" />
                </div>
                {search && (
                    <Tooltip content="Limpar busca" describe={false}>
                        <button onClick={() => setSearch('')} aria-label="Limpar busca"
                            style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '1rem', minWidth: 36, minHeight: 36 }}><X size={16} aria-hidden="true" /></button>
                    </Tooltip>
                )}

                <div className="admin-segmented" role="group" aria-label="Filtrar por status">
                    {([
                        { key: 'ALL', label: 'Todos' },
                        { key: 'ACTIVE', label: 'Ativos' },
                        { key: 'AWAITING_PAYMENT', label: 'Aguard. pagamento' },
                        { key: 'PAUSED', label: 'Pausados' },
                        { key: 'COMPLETED', label: 'Concluídos' },
                        { key: 'EXPIRED', label: 'Expirados' },
                        { key: 'CANCELLED', label: 'Cancelados' },
                    ] as const).map(s => (
                        <button key={s.key}
                            onClick={() => setFilter(s.key)}
                            aria-pressed={filter === s.key}
                            className={`admin-segmented__btn${filter === s.key ? ' admin-segmented__btn--active' : ''}`}
                        >
                            {s.label}
                        </button>
                    ))}
                </div>

                {search.trim().length >= 3 && (
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', padding: '4px 10px', background: 'var(--bg-elevated)', borderRadius: '8px' }} aria-live="polite">
                        {filtered.length} resultado{filtered.length !== 1 ? 's' : ''}
                    </span>
                )}

                {/* Recarregamento silencioso (após criar/editar/renovar): a lista continua visível. */}
                {refreshing && (
                    <span role="status"
                        style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                        <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} aria-hidden="true" /> Atualizando…
                    </span>
                )}
            </div>

            {/* --- CONTRACTS TABLE --- */}
            <div style={{ borderRadius: '16px', border: '1px solid var(--border-color)', background: 'var(--bg-secondary)', overflow: 'hidden' }}>
                {filtered.length === 0 ? (
                    <div style={{ padding: '48px 20px', textAlign: 'center', color: 'var(--text-muted)' }}>
                        <Inbox size={44} className="admin-empty__icon" aria-hidden="true" />
                        <div className="admin-empty__title">Nenhum contrato encontrado</div>
                        <div className="admin-empty__hint">Tente ajustar os filtros ou busca</div>
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
                                {filtered.map((c) => {
                                    const venc = getVencimentoBadge(c);
                                    const clientDeleted = isClientDeleted(c);
                                    // A lista não traz reservas/pagamentos: o avulso mostra a data do contrato (= da gravação).
                                    const terms = describeContractTerms(c, null, null, { dateFormat: 'short' });
                                    return (
                                        <tr key={c.id} className="admin-zebra-row">
                                            {/* Cliente + Projeto merged */}
                                            <td className="admin-card-title" style={{ paddingLeft: '20px' }}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                                    <div style={{
                                                        width: '36px', height: '36px', borderRadius: '10px',
                                                        background: getMeta(TIER_META, c.tier).bg,
                                                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                        fontSize: '0.9375rem', flexShrink: 0
                                                    }}>
                                                        {(() => { const TI = getMeta(CONTRACT_TYPE_META, c.type).icon; return <TI size={17} />; })()}
                                                    </div>
                                                    <div>
                                                        <Tooltip content={c.user?.name ? 'Abrir perfil do cliente' : null}>
                                                            <button
                                                                style={{ fontWeight: 600, fontSize: '0.875rem', cursor: 'pointer', color: 'var(--accent-text)', background: 'none', border: 'none', padding: 0, fontFamily: 'inherit', textAlign: 'left' }}
                                                                onClick={() => c.user?.id && navigate(`/admin/clients/${c.user.id}`)}>
                                                                {c.user?.name || '—'}
                                                            </button>
                                                        </Tooltip>
                                                        {clientDeleted && (
                                                            <div style={{ marginTop: 3 }}>
                                                                <StatusBadge meta={DELETED_CLIENT_META} />
                                                            </div>
                                                        )}
                                                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '1px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                                            <Tooltip content="Abrir contrato">
                                                                <button style={{ cursor: 'pointer', background: 'none', border: 'none', padding: 0, color: 'inherit', font: 'inherit', textAlign: 'left' }} onClick={() => navigate(`/admin/contracts/${c.id}`)}>{c.name}</button>
                                                            </Tooltip>
                                                            {c.contractUrl && (
                                                                <Tooltip content="Abrir contrato digital" describe={false}>
                                                                    <a href={c.contractUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent-primary)', fontSize: '0.65rem' }} aria-label="Abrir contrato digital"><Link2 size={12} aria-hidden="true" /></a>
                                                                </Tooltip>
                                                            )}
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
                                                        background: getMeta(TIER_META, c.tier).bg,
                                                        color: getMeta(TIER_META, c.tier).color,
                                                        width: 'fit-content'
                                                    }}>
                                                        {c.tier}
                                                    </span>
                                                </div>
                                            </td>

                                            {/* Episodes */}
                                            <td data-label="Gravações">
                                                <div style={{ fontWeight: 700, fontSize: '0.9375rem' }}>{contractEpisodes(c)}</div>
                                                <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)' }}>
                                                    {terms.duracao}
                                                </div>
                                                {c.type === 'FLEX' && c.flexCreditsRemaining != null && (
                                                    <div style={{
                                                        marginTop: '4px', fontSize: '0.625rem', fontWeight: 600,
                                                        color: c.flexCreditsRemaining > 0 ? 'var(--success)' : 'var(--danger)',
                                                        display: 'flex', alignItems: 'center', gap: '3px'
                                                    }}>
                                                        <span style={{
                                                            width: '6px', height: '6px', borderRadius: '50%',
                                                            background: c.flexCreditsRemaining > 0 ? 'var(--success)' : 'var(--danger)'
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
                                                <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                                                    {terms.plano}
                                                </div>
                                            </td>

                                            {/* Vigência */}
                                            <td data-label="Vigência">
                                                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                                                    {terms.vigencia}
                                                </div>
                                                {venc && (
                                                    <span style={{
                                                        display: 'inline-flex', alignItems: 'center', gap: '3px',
                                                        marginTop: '4px', fontSize: '0.625rem', fontWeight: 700,
                                                        color: venc.color, background: venc.bg,
                                                        padding: '2px 8px', borderRadius: '10px', whiteSpace: 'nowrap'
                                                    }}>
                                                        <Clock size={11} aria-hidden="true" /> {venc.label}
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
                                                    <Tooltip content="Abrir contrato" describe={false}>
                                                        <button className="admin-icon-btn" aria-label={`Abrir contrato ${c.name}`}
                                                            onClick={() => navigate(`/admin/contracts/${c.id}`)}><FolderOpen size={16} aria-hidden="true" /></button>
                                                    </Tooltip>
                                                    <Tooltip content="Editar contrato" describe={false}>
                                                        <button className="admin-icon-btn admin-icon-btn--success" aria-label={`Editar contrato ${c.name}`}
                                                            onClick={() => {
                                                                setEditContract(c);
                                                                setEditForm({ status: c.status, endDate: c.endDate.split('T')[0], flexCreditsRemaining: c.flexCreditsRemaining?.toString() || '', contractUrl: c.contractUrl || '', paymentMethod: c.paymentMethod || '', boletoAllowed: c.boletoAllowed ?? false });
                                                                setEditError('');
                                                            }}><Pencil size={16} aria-hidden="true" /></button>
                                                    </Tooltip>

                                                    {c.status === 'PENDING_CANCELLATION' && (
                                                        <>
                                                            {/* Multa = cobrança nova: nunca para cliente excluído (D3). */}
                                                            {!clientDeleted && (
                                                                <Tooltip content="Cobrar multa de cancelamento" describe={false}>
                                                                    <button className="admin-icon-btn admin-icon-btn--danger" aria-label="Cobrar multa de cancelamento"
                                                                        onClick={() => handleResolveCancel(c, 'CHARGE_FEE')}><CircleDollarSign size={16} aria-hidden="true" /></button>
                                                                </Tooltip>
                                                            )}
                                                            <Tooltip content="Isentar multa de cancelamento" describe={false}>
                                                                <button className="admin-icon-btn admin-icon-btn--success" aria-label="Isentar multa de cancelamento"
                                                                    onClick={() => handleResolveCancel(c, 'WAIVE_FEE')}><HandCoins size={16} aria-hidden="true" /></button>
                                                            </Tooltip>
                                                        </>
                                                    )}

                                                    {c.status === 'ACTIVE' && (
                                                        <Tooltip content="Cancelar contrato" describe={false}>
                                                            <button className="admin-icon-btn admin-icon-btn--danger" aria-label={`Cancelar contrato ${c.name}`}
                                                                onClick={() => handleCancel(c)}><Ban size={16} aria-hidden="true" /></button>
                                                        </Tooltip>
                                                    )}

                                                    {/* D6: plano Concluído continua renovável; avulso (sessão única) nunca renova.
                                                        D3: cliente excluído não renova, não pausa nem retoma (criariam obrigação). */}
                                                    {!clientDeleted && (c.status === 'ACTIVE' || c.status === 'EXPIRED' || c.status === 'COMPLETED') && !isAvulsoContract(c) && (
                                                        <Tooltip content="Renovar contrato (+3 meses)" describe={false}>
                                                            <button className="admin-icon-btn" aria-label={`Renovar contrato ${c.name}`}
                                                                onClick={() => {
                                                                    showConfirm({ title: 'Renovar Contrato', message: `Renovar "${c.name}" por mais 3 meses?`, onConfirm: async () => { try { const r = await contractsApi.renew(c.id, { durationMonths: 3 }); showToast(r.message); reload(); } catch (e: unknown) { showToast(getErrorMessage(e) || 'Erro'); } } });
                                                                }}><RefreshCw size={16} aria-hidden="true" /></button>
                                                        </Tooltip>
                                                    )}
                                                    {!clientDeleted && c.status === 'ACTIVE' && (
                                                        <Tooltip content="Pausar contrato" describe={false}>
                                                            <button className="admin-icon-btn" aria-label={`Pausar contrato ${c.name}`}
                                                                onClick={() => handlePause(c)}><Pause size={16} aria-hidden="true" /></button>
                                                        </Tooltip>
                                                    )}
                                                    {!clientDeleted && (c.status as string) === 'PAUSED' && (
                                                        <Tooltip content="Retomar contrato" describe={false}>
                                                            <button className="admin-icon-btn admin-icon-btn--success" aria-label={`Retomar contrato ${c.name}`}
                                                                onClick={() => {
                                                                    showConfirm({ title: 'Retomar Contrato', message: `Retomar "${c.name}"? Vigência será estendida.`, onConfirm: async () => { try { const r = await contractsApi.resume(c.id); showToast(r.message); reload(); } catch (e: unknown) { showToast(getErrorMessage(e) || 'Erro'); } } });
                                                                }}><Play size={16} aria-hidden="true" /></button>
                                                        </Tooltip>
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
                <BottomSheetModal isOpen onClose={() => setEditContract(null)} preventClose={confirmingEditCancel} title="Editar Contrato" size="md">
                    <div>
                        <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginBottom: '16px' }}>
                            {getMeta(CONTRACT_TYPE_META, editContract.type).label} · {getMeta(TIER_META, editContract.tier).label} · {editContract.user?.name} · {(() => { const n = contractEpisodes(editContract); return `${n} ${n === 1 ? 'gravação' : 'gravações'}`; })()}
                        </p>
                        {editError && <div className="error-message">{editError}</div>}
                        {isClientDeleted(editContract) && (
                            <div className="admin-alert admin-alert--danger" role="note" style={{ marginBottom: 12 }}>
                                Cliente excluído: o contrato não pode voltar a Ativo nem ter os créditos alterados. Link, forma de pagamento, término e encerramento continuam editáveis.
                            </div>
                        )}
                        <div className="form-group"><label className="form-label" htmlFor={`${uid}-status`}>Status</label>
                            <select id={`${uid}-status`} className="form-select" value={editForm.status} onChange={e => setEditForm({ ...editForm, status: e.target.value })}>
                                {/* O PATCH aceita só estes 4. Pausado/Pend. cancelamento/Aguard. pagamento têm fluxo
                                    próprio (Retomar, Cobrar/Isentar multa, pagamento) e aparecem só como "atual". */}
                                {!EDITABLE_STATUSES.includes(editContract.status) && (
                                    <option value={editContract.status} disabled>{getMeta(CONTRACT_STATUS_META, editContract.status).label} (atual)</option>
                                )}
                                {EDITABLE_STATUSES.map(s => (
                                    <option key={s} value={s}
                                        disabled={s === 'ACTIVE' && editContract.status !== 'ACTIVE' && isClientDeleted(editContract)}>
                                        {getMeta(CONTRACT_STATUS_META, s).label}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <div className="form-group"><label className="form-label" htmlFor={`${uid}-end-date`}>Data de Término</label>
                            <input id={`${uid}-end-date`} type="date" className="form-input" value={editForm.endDate} onChange={e => setEditForm({ ...editForm, endDate: e.target.value })} />
                        </div>
                        {editContract.type === 'FLEX' && (
                            <div className="form-group"><label className="form-label" htmlFor={`${uid}-flex-credits`}>Créditos Flex Restantes</label>
                                <input id={`${uid}-flex-credits`} type="number" className="form-input" min={0} value={editForm.flexCreditsRemaining}
                                    disabled={isClientDeleted(editContract)}
                                    onChange={e => setEditForm({ ...editForm, flexCreditsRemaining: e.target.value })} />
                            </div>
                        )}
                        <div className="form-group">
                            <label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: 5 }} htmlFor={`${uid}-contract-url`}><Link2 size={13} aria-hidden="true" /> Link do Contrato Digital</label>
                            <input id={`${uid}-contract-url`} className="form-input" type="url" placeholder="https://..." value={editForm.contractUrl} onChange={e => setEditForm({ ...editForm, contractUrl: e.target.value })} />
                        </div>
                        <div className="form-group">
                            <label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: 5 }} htmlFor={`${uid}-payment-method`}><CreditCard size={13} aria-hidden="true" /> Forma de Pagamento</label>
                            <select id={`${uid}-payment-method`} className="form-select" value={editForm.paymentMethod} onChange={e => setEditForm({ ...editForm, paymentMethod: e.target.value })}>
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
                                <span><FileText size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} aria-hidden="true" />Permitir <strong>boleto</strong> neste contrato</span>
                            </label>
                            <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: '6px 0 0 28px' }}>
                                O cliente poderá pagar as parcelas deste contrato via boleto. Desligado por padrão.
                            </p>
                        </div>
                        <div className="admin-actions-row">
                            <button className="btn btn-secondary" onClick={() => setEditContract(null)}>Cancelar</button>
                            <button className="btn btn-primary" onClick={handleEdit}>Salvar</button>
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

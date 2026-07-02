import { getErrorMessage } from '../utils/errors';
import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Users } from 'lucide-react';
import { usersApi, UserSummary } from '../api/client';
import { useUI } from '../context/UIContext';
import { useAdminClients } from '../hooks/useAdminClients';
import AdminPageHeader from '../components/admin/AdminPageHeader';
import CreateClientModal from '../components/admin/clients/CreateClientModal';
import EditClientModal from '../components/admin/clients/EditClientModal';
import { HeroSkeleton, TableSkeleton } from '../components/ui/SkeletonLoader';
import StatusBadge from '../components/ui/StatusBadge';
import { USER_TYPE_META, getMeta } from '../constants/adminMeta';
import { maskPhone } from '../utils/mask';

import { formatBRL } from '../utils/format';

function getUserType(u: UserSummary): string {
    if (u.role === 'ADMIN') return 'ADMIN';
    if (u.contracts && u.contracts.length > 0) {
        return u.contracts[0].type; // FIXO | FLEX | AVULSO | SERVICO | CUSTOM
    }
    return 'AVULSO';
}

export default function AdminClientsPage() {
    const navigate = useNavigate();
    const { showAlert, showConfirm, showToast } = useUI();
    const { users, loading, search, setSearch, typeFilter, setTypeFilter, reload } = useAdminClients();

    const [showCreate, setShowCreate] = useState(false);
    const [editUser, setEditUser] = useState<UserSummary | null>(null);

    const confirmDelete = (u: UserSummary) => {
        showConfirm({
            title: 'Excluir cliente?',
            message: `Tem certeza que deseja excluir ${u.name}? Todos os contratos e agendamentos vinculados serão cancelados e os dados removidos permanentemente.`,
            onConfirm: () => handleDelete(u),
        });
    };

    const handleDelete = async (u: UserSummary) => {
        try {
            await usersApi.remove(u.id);
            await reload();
            showToast('Cliente excluído.');
        } catch (err: unknown) {
            showAlert({ message: getErrorMessage(err) || 'Erro ao excluir usuário', type: 'error' });
        }
    };

    // --- Computed ---
    const clientUsers = users.filter(u => u.role !== 'ADMIN');
    const hasActiveContract = (u: UserSummary) => u.contracts?.some(c => c.status === 'ACTIVE') ?? false;
    const hadAnyContract = (u: UserSummary) => (u._count?.contracts ?? 0) > 0;
    const hasActiveAddon = (u: UserSummary) => u.contracts?.some(c => c.status === 'ACTIVE' && c.addOns && c.addOns.length > 0) ?? false;

    const activeCount = clientUsers.filter(hasActiveContract).length;
    const exClientCount = clientUsers.filter(u => hadAnyContract(u) && !hasActiveContract(u)).length;
    const noContractCount = clientUsers.filter(u => !hadAnyContract(u)).length;
    const noAddonCount = clientUsers.filter(u => hasActiveContract(u) && !hasActiveAddon(u)).length;

    const filtered = useMemo(() => {
        let result = users;
        if (typeFilter === 'ACTIVE') result = result.filter(u => u.role !== 'ADMIN' && hasActiveContract(u));
        else if (typeFilter === 'EX_CLIENT') result = result.filter(u => u.role !== 'ADMIN' && hadAnyContract(u) && !hasActiveContract(u));
        else if (typeFilter === 'NO_CONTRACT') result = result.filter(u => u.role !== 'ADMIN' && !hadAnyContract(u));
        else if (typeFilter === 'NO_ADDON') result = result.filter(u => u.role !== 'ADMIN' && hasActiveContract(u) && !hasActiveAddon(u));
        const q = search.trim().toLowerCase();
        if (q.length >= 3) {
            const digits = q.replace(/\D/g, '');
            result = result.filter(u =>
                u.name.toLowerCase().includes(q) ||
                u.email.toLowerCase().includes(q) ||
                (digits.length > 0 && u.phone && u.phone.includes(digits))
            );
        }
        return result;
    }, [users, typeFilter, search]);

    if (loading) return <div><HeroSkeleton /><TableSkeleton rows={6} cols={7} /></div>;

    return (
        <div>
            {/* --- HEADER --- */}
            <AdminPageHeader
                icon={Users}
                title="Clientes"
                subtitle="Diretório de clientes e contratos"
                actions={
                    <button className="btn-admin-go" onClick={() => { setShowCreate(true); }}>
                        <span style={{ fontSize: '1.1rem' }} aria-hidden="true">+</span> Novo Cliente
                    </button>
                }
            />

            {/* --- KPI CARDS (clicáveis = filtro) --- */}
            <div className="admin-kpi-grid" style={{ marginBottom: '24px' }}>
                {([
                    { key: 'ALL' as const, label: 'Total', count: clientUsers.length, desc: 'clientes cadastrados', icon: '👥', color: '#11819B', gradient: 'rgba(17,129,155,0.10)' },
                    { key: 'ACTIVE' as const, label: 'Ativos', count: activeCount, desc: 'com contrato ativo', icon: '✅', color: '#10b981', gradient: 'rgba(16,185,129,0.08)' },
                    { key: 'EX_CLIENT' as const, label: 'Ex-clientes', count: exClientCount, desc: 'contrato expirado', icon: '👋', color: '#f59e0b', gradient: 'rgba(245,158,11,0.08)' },
                    { key: 'NO_CONTRACT' as const, label: 'Sem Contrato', count: noContractCount, desc: 'nunca contrataram', icon: '📭', color: '#94a3b8', gradient: 'rgba(148,163,184,0.08)' },
                    { key: 'NO_ADDON' as const, label: 'Sem Add-on', count: noAddonCount, desc: 'sem serviço extra', icon: '🧩', color: '#2dd4bf', gradient: 'rgba(45,212,191,0.08)' },
                ] as const).map(card => {
                    const isActive = typeFilter === card.key;
                    return (
                        <button key={card.key} type="button"
                            className="admin-kpi-card"
                            aria-pressed={isActive}
                            onClick={() => setTypeFilter(isActive ? 'ALL' : card.key)}
                            style={{
                                padding: '18px 16px',
                                background: isActive ? `linear-gradient(135deg, ${card.gradient}, ${card.gradient.replace(/0\.(08|10)/, '0.02')})` : undefined,
                                borderColor: isActive ? card.color + '44' : undefined,
                                position: 'relative', overflow: 'hidden',
                            }}
                        >
                            {/* Top row: icon + label */}
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' }}>
                                <span style={{ fontSize: '0.9rem' }} aria-hidden="true">{card.icon}</span>
                                <span style={{
                                    fontSize: '0.6875rem', fontWeight: 700, color: isActive ? card.color : 'var(--text-muted)',
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
                            {isActive && (
                                <div style={{
                                    position: 'absolute', bottom: 0, left: '16px', right: '16px', height: '2px',
                                    background: `linear-gradient(90deg, ${card.color}, transparent)`,
                                    borderRadius: '2px',
                                }} />
                            )}
                        </button>
                    );
                })}
            </div>

            {/* --- SEARCH BAR --- */}
            <div className="admin-filter-bar admin-filter-bar--panel">
                <div className="admin-search">
                    <input
                        type="text" placeholder="Buscar por nome, e-mail ou telefone..."
                        aria-label="Buscar por nome, e-mail ou telefone"
                        value={search} onChange={e => setSearch(e.target.value)}
                    />
                    <span className="admin-search__icon" aria-hidden="true">🔎</span>
                </div>
                {search && (
                    <button onClick={() => setSearch('')} aria-label="Limpar busca"
                        style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '1rem', minWidth: 36, minHeight: 36 }}>
                        ✖️
                    </button>
                )}

                {typeFilter !== 'ALL' && (
                    <button className="admin-filter-clear" onClick={() => setTypeFilter('ALL')}>
                        🗑️ Limpar filtro
                    </button>
                )}

                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', padding: '4px 10px', background: 'var(--bg-elevated)', borderRadius: '8px' }} aria-live="polite">
                    {filtered.length} resultado{filtered.length !== 1 ? 's' : ''}
                </span>
            </div>

            {/* --- CLIENTS TABLE --- */}
            <div style={{ borderRadius: '16px', border: '1px solid var(--border-color)', background: 'var(--bg-secondary)', overflow: 'hidden' }}>
                {filtered.length === 0 ? (
                    <div style={{ padding: '48px 20px', textAlign: 'center', color: 'var(--text-muted)' }}>
                        <div style={{ fontSize: '2.5rem', marginBottom: '12px', opacity: 0.4 }}>🔍</div>
                        <div style={{ fontWeight: 600 }}>Nenhum cliente encontrado</div>
                        <div style={{ fontSize: '0.8125rem', marginTop: '4px' }}>Tente ajustar busca ou filtros</div>
                    </div>
                ) : (
                    <div className="table-container" style={{ margin: 0 }}>
                        <div className="admin-table-wrap">
                        <table className="admin-table--cards">
                            <thead>
                                <tr>
                                    <th style={{ paddingLeft: '20px' }}>Cliente</th>
                                    <th style={{ textAlign: 'center' }}>Sessões</th>
                                    <th style={{ textAlign: 'center' }}>Contratos</th>
                                    <th style={{ textAlign: 'right' }}>Valor Pago</th>
                                    <th style={{ textAlign: 'right' }}>A Receber</th>
                                    <th>Desde</th>
                                    <th style={{ textAlign: 'center' }}>Ações</th>
                                </tr>
                            </thead>
                            <tbody>
                                {filtered.map((u) => {
                                    const hasActive = u.contracts?.some(c => c.status === 'ACTIVE');
                                    const avatarColor = hasActive ? '#10b981' : u.role === 'ADMIN' ? '#f59e0b' : '#64748b';
                                    const avatarBg = hasActive ? 'rgba(16,185,129,0.12)' : u.role === 'ADMIN' ? 'rgba(245,158,11,0.12)' : 'rgba(100,116,139,0.12)';
                                    return (
                                        <tr key={u.id} className="admin-zebra-row">
                                            {/* Client info merged: Name + Email + Phone */}
                                            <td className="admin-card-title" style={{ paddingLeft: '20px' }}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                                                    {/* Avatar */}
                                                    <div style={{
                                                        width: '40px', height: '40px', borderRadius: '12px',
                                                        background: avatarBg,
                                                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                        fontSize: '1.125rem', flexShrink: 0,
                                                        border: `1px solid ${avatarColor}22`,
                                                        color: avatarColor, fontWeight: 700,
                                                    }}>
                                                        {u.name.charAt(0).toUpperCase()}
                                                    </div>
                                                    <div>
                                                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                                                            <button
                                                                style={{ fontWeight: 600, fontSize: '0.875rem', cursor: 'pointer', color: 'var(--accent-text)', background: 'none', border: 'none', padding: 0, fontFamily: 'inherit', textAlign: 'left' }}
                                                                title={`Abrir perfil de ${u.name}`}
                                                                onClick={() => navigate(`/admin/clients/${u.id}`)}>
                                                                {u.name}
                                                            </button>
                                                            <StatusBadge meta={getMeta(USER_TYPE_META, getUserType(u))} />
                                                        </div>
                                                        <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', marginTop: '2px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                                                            <span>{u.email}</span>
                                                            {u.phone && (
                                                                <>
                                                                    <span style={{ opacity: 0.3 }}>•</span>
                                                                    <span>{maskPhone(u.phone)}</span>
                                                                </>
                                                            )}
                                                        </div>
                                                    </div>
                                                </div>
                                            </td>

                                            {/* Sessions count */}
                                            <td data-label="Sessões" style={{ textAlign: 'center' }}>
                                                <div style={{ fontWeight: 700, fontSize: '1rem' }}>{u._count.bookings}</div>
                                                <div style={{ fontSize: '0.625rem', color: 'var(--text-muted)' }}>sessões</div>
                                            </td>

                                            {/* Contracts count */}
                                            <td data-label="Contratos" style={{ textAlign: 'center' }}>
                                                <div style={{ fontWeight: 700, fontSize: '1rem' }}>{u._count.contracts}</div>
                                                <div style={{ fontSize: '0.625rem', color: 'var(--text-muted)' }}>contratos</div>
                                            </td>

                                            {/* Valor Pago */}
                                            <td data-label="Pago" style={{ textAlign: 'right' }}>
                                                {u.totalPaid > 0 ? (
                                                    <span style={{ fontWeight: 700, fontSize: '0.8125rem', color: 'var(--success)', fontVariantNumeric: 'tabular-nums' }}>
                                                        {formatBRL(u.totalPaid)}
                                                    </span>
                                                ) : (
                                                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>—</span>
                                                )}
                                            </td>

                                            {/* A Receber */}
                                            <td data-label="A Receber" style={{ textAlign: 'right' }}>
                                                {u.totalPending > 0 ? (
                                                    <span style={{ fontWeight: 700, fontSize: '0.8125rem', color: 'var(--warning)', fontVariantNumeric: 'tabular-nums' }}>
                                                        {formatBRL(u.totalPending)}
                                                    </span>
                                                ) : (
                                                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>—</span>
                                                )}
                                            </td>

                                            {/* Registration date */}
                                            <td data-label="Desde">
                                                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                                                    {new Date(u.createdAt).toLocaleDateString('pt-BR', { timeZone: 'UTC' })}
                                                </div>
                                            </td>

                                            {/* Actions */}
                                            <td data-label="" style={{ textAlign: 'center' }}>
                                                <div style={{ display: 'flex', gap: '4px', justifyContent: 'center' }}>
                                                    <button className="admin-icon-btn admin-icon-btn--success"
                                                        aria-label={`Editar ${u.name}`}
                                                        onClick={() => setEditUser(u)}>✏️</button>

                                                    {u.role !== 'ADMIN' && (
                                                        <button className="admin-icon-btn admin-icon-btn--danger"
                                                            aria-label={`Excluir ${u.name}`}
                                                            onClick={() => confirmDelete(u)}>🗑️</button>
                                                    )}
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

            {/* -------------------------------------------------------
               MODALS (preserved from original)
            ------------------------------------------------------- */}

            {/* Create Modal */}
            {showCreate && (
                <CreateClientModal
                    isOpen={showCreate}
                    onClose={() => setShowCreate(false)}
                    onCreated={reload}
                />
            )}

            {/* Edit Modal */}
            {editUser && (
                <EditClientModal
                    user={editUser}
                    onClose={() => setEditUser(null)}
                    onSaved={reload}
                />
            )}

        </div>
    );
}

import { getErrorMessage } from '../utils/errors';
import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { usersApi, UserSummary, ApiError } from '../api/client';
import { useUI } from '../context/UIContext';
import ModalOverlay from '../components/ModalOverlay';
import { maskPhone, maskEmail, maskCpfCnpj, translateError } from '../utils/mask';

function formatBRL(cents: number): string {
    return `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;
}

const TYPE_CONFIG: Record<string, { label: string; color: string; bg: string; icon: string }> = {
    ADMIN:  { label: 'Admin',  color: '#f59e0b', bg: 'rgba(245,158,11,0.12)',  icon: '???' },
    FIXO:   { label: 'Fixo',   color: '#818cf8', bg: 'rgba(99,102,241,0.12)',   icon: '??' },
    FLEX:   { label: 'Flex',   color: '#34d399', bg: 'rgba(16,185,129,0.12)',   icon: '??' },
    AVULSO: { label: 'Avulso', color: '#f97316', bg: 'rgba(249,115,22,0.12)',   icon: '??' },
};

function getUserType(u: UserSummary): string {
    if (u.role === 'ADMIN') return 'ADMIN';
    if (u.contracts && u.contracts.length > 0) {
        return u.contracts[0].type === 'FIXO' ? 'FIXO' : 'FLEX';
    }
    return 'AVULSO';
}

export default function AdminClientsPage() {
    const navigate = useNavigate();
    const { showAlert } = useUI();
    const [users, setUsers] = useState<UserSummary[]>([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState('');
    const [typeFilter, setTypeFilter] = useState<'ALL' | 'ACTIVE' | 'EX_CLIENT' | 'NO_CONTRACT' | 'NO_ADDON'>('ALL');

    const [showCreate, setShowCreate] = useState(false);
    const [createForm, setCreateForm] = useState({ name: '', email: '', phone: '', password: '', role: 'CLIENTE', notes: '', cpfCnpj: '', socialLinks: '', clientStatus: 'ACTIVE' });
    const [createError, setCreateError] = useState('');
    const [createFieldErrors, setCreateFieldErrors] = useState<Record<string, string>>({});
    const [showAdvanced, setShowAdvanced] = useState(false);
    const [creating, setCreating] = useState(false);

    const [editUser, setEditUser] = useState<UserSummary | null>(null);
    const [editForm, setEditForm] = useState({
        name: '', email: '', phone: '', role: '', password: '',
        notes: '', cpfCnpj: '', address: '', city: '', state: '',
        socialLinks: '', clientStatus: 'ACTIVE',
    });
    const [editError, setEditError] = useState('');
    const [editFieldErrors, setEditFieldErrors] = useState<Record<string, string>>({});
    const [editLoading, setEditLoading] = useState(false);
    const [editFetching, setEditFetching] = useState(false);

    const [deleteUser, setDeleteUser] = useState<UserSummary | null>(null);
    const [deleteLoading, setDeleteLoading] = useState(false);

    useEffect(() => { loadData(); }, []);

    const loadData = async () => {
        setLoading(true);
        try { const res = await usersApi.getAll(); setUsers(res.users); } catch (err) { console.error(err); }
        finally { setLoading(false); }
    };

    const handleCreate = async () => {
        setCreateError('');
        setCreateFieldErrors({});
        setCreating(true);
        try {
            const payload: any = {
                name: createForm.name,
                email: createForm.email,
                password: createForm.password,
                phone: createForm.phone.replace(/\D/g, '') || undefined,
                role: createForm.role,
            };
            if (createForm.notes.trim()) payload.notes = createForm.notes;
            if (createForm.cpfCnpj.replace(/\D/g, '')) payload.cpfCnpj = createForm.cpfCnpj.replace(/\D/g, '');
            if (createForm.socialLinks.trim()) payload.socialLinks = createForm.socialLinks;
            if (createForm.clientStatus !== 'ACTIVE') payload.clientStatus = createForm.clientStatus;
            await usersApi.create(payload);
            resetCreateModal();
            await loadData();
        } catch (err: unknown) {
            if (err instanceof Error && err.name === 'ApiError') {
                const apiErr = err as ApiError;
                if (apiErr.details && Array.isArray(apiErr.details)) {
                    const mapped: Record<string, string> = {};
                    apiErr.details.forEach((issue: any) => { mapped[issue.path.join('.')] = issue.message; });
                    setCreateFieldErrors(mapped);
                } else if (apiErr.status === 409) {
                    setCreateFieldErrors({ email: apiErr.message });
                }
                setCreateError(apiErr.message);
            } else {
                setCreateError(getErrorMessage(err));
            }
        } finally { setCreating(false); }
    };

    const resetCreateModal = () => {
        setShowCreate(false);
        setCreateForm({ name: '', email: '', phone: '', password: '', role: 'CLIENTE', notes: '', cpfCnpj: '', socialLinks: '', clientStatus: 'ACTIVE' });
        setCreateError('');
        setCreateFieldErrors({});
        setShowAdvanced(false);
    };

    const handleEdit = async () => {
        if (!editUser) return;
        setEditError('');
        setEditFieldErrors({});
        setEditLoading(true);
        try {
            const data: any = {};
            if (editForm.name && editForm.name !== editUser.name) data.name = editForm.name;
            if (editForm.email && editForm.email !== editUser.email) data.email = editForm.email;
            if (editForm.phone.replace(/\D/g, '') !== (editUser.phone || '')) data.phone = editForm.phone.replace(/\D/g, '');
            if (editForm.role && editForm.role !== editUser.role) data.role = editForm.role;
            if (editForm.password) data.password = editForm.password;
            if (editForm.clientStatus) data.clientStatus = editForm.clientStatus;
            // Optional text fields — send if changed (compare to empty for summary-level data)
            data.notes = editForm.notes || null;
            data.cpfCnpj = editForm.cpfCnpj.replace(/\D/g, '') || null;
            data.address = editForm.address || null;
            data.city = editForm.city || null;
            data.state = editForm.state || null;
            data.socialLinks = editForm.socialLinks || null;
            await usersApi.update(editUser.id, data);
            setEditUser(null);
            await loadData();
        } catch (err: unknown) {
            if (err instanceof Error && err.name === 'ApiError') {
                const apiErr = err as ApiError;
                if (apiErr.details && Array.isArray(apiErr.details)) {
                    const mapped: Record<string, string> = {};
                    apiErr.details.forEach((issue: any) => { mapped[issue.path.join('.')] = issue.message; });
                    setEditFieldErrors(mapped);
                } else if (apiErr.status === 409) {
                    setEditFieldErrors({ email: apiErr.message });
                }
                setEditError(apiErr.message);
            } else {
                setEditError(getErrorMessage(err));
            }
        } finally { setEditLoading(false); }
    };

    const openEditModal = async (u: UserSummary) => {
        setEditUser(u);
        setEditForm({
            name: u.name, email: u.email, phone: maskPhone(u.phone || ''), role: u.role, password: '',
            notes: '', cpfCnpj: '', address: '', city: '', state: '', socialLinks: '', clientStatus: u.clientStatus || 'ACTIVE',
        });
        setEditError('');
        setEditFieldErrors({});
        setEditFetching(true);
        try {
            const res = await usersApi.getById(u.id);
            const d = res.user;
            setEditForm(prev => ({
                ...prev,
                notes: d.notes || '',
                cpfCnpj: d.cpfCnpj ? maskCpfCnpj(d.cpfCnpj) : '',
                address: d.address || '',
                city: d.city || '',
                state: d.state || '',
                socialLinks: d.socialLinks || '',
                clientStatus: d.clientStatus || 'ACTIVE',
            }));
        } catch (err) { console.error('Failed to fetch user detail:', err); }
        finally { setEditFetching(false); }
    };

    const handleDelete = async () => {
        if (!deleteUser) return;
        setDeleteLoading(true);
        try {
            await usersApi.remove(deleteUser.id);
            setDeleteUser(null);
            await loadData();
        } catch (err: unknown) {
            showAlert({ message: getErrorMessage(err) || 'Erro ao excluir usuário', type: 'error' });
        } finally {
            setDeleteLoading(false);
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

    if (loading) return <div className="loading-spinner"><div className="spinner" /></div>;

    return (
        <div>
            {/* --- HEADER --- */}
            <div style={{ marginBottom: '28px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '16px' }}>
                <div>
                    <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <span style={{ fontSize: '1.75rem' }}>??</span> Clientes
                    </h1>
                    <p className="page-subtitle" style={{ marginTop: '4px' }}>
                        Gerencie os usuários e clientes do sistema
                    </p>
                </div>
                <button className="btn btn-primary" onClick={() => { setShowCreate(true); setCreateError(''); }}
                    style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '12px 24px', borderRadius: '12px', fontWeight: 700 }}>
                    <span style={{ fontSize: '1.1rem' }}>+</span> Novo Cliente
                </button>
            </div>

            {/* --- KPI CARDS --- */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '12px', marginBottom: '24px' }}>
                {([
                    { key: 'ALL' as const, label: 'Total', count: clientUsers.length, desc: 'clientes cadastrados', icon: '??', color: '#6366f1', gradient: 'rgba(99,102,241,0.08)' },
                    { key: 'ACTIVE' as const, label: 'Ativos', count: activeCount, desc: 'com contrato ativo', icon: '?', color: '#10b981', gradient: 'rgba(16,185,129,0.08)' },
                    { key: 'EX_CLIENT' as const, label: 'Ex-clientes', count: exClientCount, desc: 'contrato expirado', icon: '??', color: '#f59e0b', gradient: 'rgba(245,158,11,0.08)' },
                    { key: 'NO_CONTRACT' as const, label: 'Sem Contrato', count: noContractCount, desc: 'nunca contrataram', icon: '??', color: '#94a3b8', gradient: 'rgba(148,163,184,0.08)' },
                    { key: 'NO_ADDON' as const, label: 'Sem Add-on', count: noAddonCount, desc: 'sem serviço extra', icon: '??', color: '#2dd4bf', gradient: 'rgba(45,212,191,0.08)' },
                ] as const).map(card => {
                    const isActive = typeFilter === card.key;
                    return (
                        <div key={card.key}
                            onClick={() => setTypeFilter(isActive ? 'ALL' : card.key)}
                            style={{
                                padding: '18px 16px', borderRadius: '14px', cursor: 'pointer',
                                background: isActive ? `linear-gradient(135deg, ${card.gradient}, ${card.gradient.replace('0.08', '0.02')})` : 'var(--bg-secondary)',
                                border: `1px solid ${isActive ? card.color + '44' : 'var(--border-color)'}`,
                                transition: 'all 0.25s ease',
                                position: 'relative', overflow: 'hidden',
                            }}
                            onMouseEnter={e => { if (!isActive) e.currentTarget.style.borderColor = card.color + '33'; }}
                            onMouseLeave={e => { if (!isActive) e.currentTarget.style.borderColor = 'var(--border-color)'; }}
                        >
                            {/* Top row: icon + label */}
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' }}>
                                <span style={{ fontSize: '0.9rem' }}>{card.icon}</span>
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
                        </div>
                    );
                })}
            </div>

            {/* --- SEARCH BAR --- */}
            <div style={{
                padding: '12px 16px', borderRadius: '12px', marginBottom: '16px',
                background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
                display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap'
            }}>
                <div style={{ position: 'relative', flex: 1, minWidth: '200px' }}>
                    <input
                        type="text" placeholder="Buscar por nome, e-mail ou telefone..."
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

                {typeFilter !== 'ALL' && (
                    <button onClick={() => setTypeFilter('ALL')} style={{
                        display: 'flex', alignItems: 'center', gap: '6px',
                        padding: '5px 12px', borderRadius: '8px', fontSize: '0.75rem', fontWeight: 600,
                        background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.15)',
                        color: '#ef4444', cursor: 'pointer', transition: 'all 0.2s'
                    }}>
                        ? Limpar filtro
                    </button>
                )}

                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', padding: '4px 10px', background: 'var(--bg-elevated)', borderRadius: '8px' }}>
                    {filtered.length} resultado{filtered.length !== 1 ? 's' : ''}
                </span>
            </div>

            {/* --- CLIENTS TABLE --- */}
            <div style={{ borderRadius: '16px', border: '1px solid var(--border-color)', background: 'var(--bg-secondary)', overflow: 'hidden' }}>
                {filtered.length === 0 ? (
                    <div style={{ padding: '48px 20px', textAlign: 'center', color: 'var(--text-muted)' }}>
                        <div style={{ fontSize: '2.5rem', marginBottom: '12px', opacity: 0.4 }}>??</div>
                        <div style={{ fontWeight: 600 }}>Nenhum cliente encontrado</div>
                        <div style={{ fontSize: '0.8125rem', marginTop: '4px' }}>Tente ajustar busca ou filtros</div>
                    </div>
                ) : (
                    <div className="table-container" style={{ margin: 0 }}>
                        <table>
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
                                {filtered.map((u, i) => {
                                    const hasActive = u.contracts?.some(c => c.status === 'ACTIVE');
                                    const avatarColor = hasActive ? '#10b981' : u.role === 'ADMIN' ? '#f59e0b' : '#64748b';
                                    const avatarBg = hasActive ? 'rgba(16,185,129,0.12)' : u.role === 'ADMIN' ? 'rgba(245,158,11,0.12)' : 'rgba(100,116,139,0.12)';
                                    return (
                                        <tr key={u.id}
                                            style={{
                                                background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)',
                                                transition: 'background 0.15s'
                                            }}
                                            onMouseEnter={e => (e.currentTarget.style.background = 'rgba(16,185,129,0.04)')}
                                            onMouseLeave={e => (e.currentTarget.style.background = i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)')}
                                        >
                                            {/* Client info merged: Name + Email + Phone */}
                                            <td style={{ paddingLeft: '20px' }}>
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
                                                        <div style={{ fontWeight: 600, fontSize: '0.875rem', cursor: 'pointer', color: 'var(--accent-primary)' }}
                                                            onClick={() => navigate(`/admin/clients/${u.id}`)}>
                                                            {u.name}
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
                                            <td style={{ textAlign: 'center' }}>
                                                <div style={{ fontWeight: 700, fontSize: '1rem' }}>{u._count.bookings}</div>
                                                <div style={{ fontSize: '0.625rem', color: 'var(--text-muted)' }}>sessões</div>
                                            </td>

                                            {/* Contracts count */}
                                            <td style={{ textAlign: 'center' }}>
                                                <div style={{ fontWeight: 700, fontSize: '1rem' }}>{u._count.contracts}</div>
                                                <div style={{ fontSize: '0.625rem', color: 'var(--text-muted)' }}>contratos</div>
                                            </td>

                                            {/* Valor Pago */}
                                            <td style={{ textAlign: 'right' }}>
                                                {u.totalPaid > 0 ? (
                                                    <span style={{ fontWeight: 700, fontSize: '0.8125rem', color: '#10b981', fontVariantNumeric: 'tabular-nums' }}>
                                                        {formatBRL(u.totalPaid)}
                                                    </span>
                                                ) : (
                                                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>—</span>
                                                )}
                                            </td>

                                            {/* A Receber */}
                                            <td style={{ textAlign: 'right' }}>
                                                {u.totalPending > 0 ? (
                                                    <span style={{ fontWeight: 700, fontSize: '0.8125rem', color: '#f59e0b', fontVariantNumeric: 'tabular-nums' }}>
                                                        {formatBRL(u.totalPending)}
                                                    </span>
                                                ) : (
                                                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>—</span>
                                                )}
                                            </td>

                                            {/* Registration date */}
                                            <td>
                                                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                                                    {new Date(u.createdAt).toLocaleDateString('pt-BR', { timeZone: 'UTC' })}
                                                </div>
                                            </td>

                                            {/* Actions */}
                                            <td style={{ textAlign: 'center' }}>
                                                <div style={{ display: 'flex', gap: '4px', justifyContent: 'center' }}>
                                                    <button style={{
                                                        background: 'var(--bg-elevated)', border: '1px solid var(--border-color)',
                                                        color: 'var(--text-secondary)', padding: '6px 10px', borderRadius: '8px',
                                                        cursor: 'pointer', fontSize: '0.8125rem', transition: 'all 0.2s'
                                                    }}
                                                    onMouseEnter={e => { e.currentTarget.style.borderColor = '#10b981'; e.currentTarget.style.color = '#10b981'; }}
                                                    onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border-color)'; e.currentTarget.style.color = 'var(--text-secondary)'; }}
                                                    title="Editar"
                                                    onClick={() => openEditModal(u)}>??</button>

                                                    {u.role !== 'ADMIN' && (
                                                        <button style={{
                                                            background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.15)',
                                                            color: '#ef4444', padding: '6px 10px', borderRadius: '8px',
                                                            cursor: 'pointer', fontSize: '0.8125rem', transition: 'all 0.2s', opacity: 0.7
                                                        }}
                                                        onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
                                                        onMouseLeave={e => (e.currentTarget.style.opacity = '0.7')}
                                                        title="Excluir"
                                                        onClick={() => setDeleteUser(u)}>???</button>
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

            {/* -------------------------------------------------------
               MODALS (preserved from original)
            ------------------------------------------------------- */}

            {/* Create Modal */}
            {showCreate && (() => {
                const inputStyle = (hasError: boolean) => ({
                    width: '100%', padding: '10px 14px 10px 36px', borderRadius: '10px', fontSize: '0.8125rem',
                    background: 'var(--bg-elevated)', border: `1px solid ${hasError ? 'rgba(239,68,68,0.5)' : 'var(--border-default)'}`,
                    color: 'var(--text-primary)', outline: 'none', fontFamily: 'inherit',
                    transition: 'border-color 0.2s',
                } as React.CSSProperties);

                const labelStyle = {
                    fontSize: '0.6875rem', fontWeight: 700, color: 'var(--text-muted)',
                    textTransform: 'uppercase' as const, letterSpacing: '0.1em', marginBottom: '6px', display: 'block',
                };

                const fieldErrorStyle = {
                    fontSize: '0.6875rem', color: '#ef4444', fontWeight: 600, marginTop: '4px', paddingLeft: '4px',
                };

                const canCreate = createForm.name.length >= 2 && createForm.email.includes('@') && createForm.password.length >= 6;

                return (
                    <ModalOverlay onClose={resetCreateModal}>
                        <div className="modal" style={{ maxWidth: 520, maxHeight: '92vh', overflowY: 'auto', padding: 0 }}>
                            {/* --- HEADER --- */}
                            <div style={{ padding: '28px 32px 0', borderBottom: 'none' }}>
                                <h2 style={{ fontSize: '1.25rem', fontWeight: 800, margin: 0, display: 'flex', alignItems: 'center', gap: '10px' }}>
                                    <span style={{
                                        width: 36, height: 36, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center',
                                        background: 'linear-gradient(135deg, #10b981, #11819B)', fontSize: '1rem'
                                    }}>??</span>
                                    Novo Cliente
                                </h2>
                                <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '6px', marginBottom: 0 }}>
                                    Cadastre um novo cliente no sistema do estúdio
                                </p>
                            </div>

                            <div style={{ padding: '20px 32px 28px' }}>
                                {createError && Object.keys(createFieldErrors).length === 0 && (
                                    <div style={{ marginBottom: '16px', padding: '10px 14px', borderRadius: '10px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.15)', color: '#ef4444', fontSize: '0.8125rem', fontWeight: 600 }}>{createError}</div>
                                )}

                                {/* --- SECTION 1: Dados Essenciais --- */}
                                <div style={{ marginBottom: '20px' }}>
                                    <div style={{ fontSize: '0.625rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: '14px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                        <span style={{ width: 18, height: 18, borderRadius: '50%', background: '#10b981', color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.5rem', fontWeight: 800 }}>1</span>
                                        Dados Essenciais
                                    </div>

                                    {/* Name + Email row */}
                                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '12px' }}>
                                        <div>
                                            <label style={labelStyle}>Nome *</label>
                                            <div style={{ position: 'relative' }}>
                                                <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: '0.75rem', opacity: 0.5 }}>??</span>
                                                <input
                                                    value={createForm.name} onChange={e => setCreateForm({ ...createForm, name: e.target.value })}
                                                    placeholder="Nome completo" autoFocus
                                                    style={inputStyle(!!createFieldErrors.name)}
                                                    onFocus={e => (e.currentTarget.style.borderColor = '#10b981')}
                                                    onBlur={e => (e.currentTarget.style.borderColor = createFieldErrors.name ? 'rgba(239,68,68,0.5)' : 'var(--border-default)')}
                                                />
                                            </div>
                                            {createFieldErrors.name && <div style={fieldErrorStyle}>{translateError(createFieldErrors.name)}</div>}
                                        </div>
                                        <div>
                                            <label style={labelStyle}>E-mail *</label>
                                            <div style={{ position: 'relative' }}>
                                                <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: '0.75rem', opacity: 0.5 }}>??</span>
                                                <input
                                                    type="email" value={createForm.email}
                                                    onChange={e => setCreateForm({ ...createForm, email: maskEmail(e.target.value) })}
                                                    placeholder="email@exemplo.com"
                                                    style={inputStyle(!!createFieldErrors.email)}
                                                    onFocus={e => (e.currentTarget.style.borderColor = '#10b981')}
                                                    onBlur={e => (e.currentTarget.style.borderColor = createFieldErrors.email ? 'rgba(239,68,68,0.5)' : 'var(--border-default)')}
                                                />
                                            </div>
                                            {createFieldErrors.email && <div style={fieldErrorStyle}>{translateError(createFieldErrors.email)}</div>}
                                        </div>
                                    </div>

                                    {/* Password + Phone row */}
                                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                                        <div>
                                            <label style={labelStyle}>Senha *</label>
                                            <div style={{ position: 'relative' }}>
                                                <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: '0.75rem', opacity: 0.5 }}>??</span>
                                                <input
                                                    type="password" value={createForm.password}
                                                    onChange={e => setCreateForm({ ...createForm, password: e.target.value })}
                                                    placeholder="Mínimo 6 caracteres"
                                                    style={inputStyle(!!createFieldErrors.password)}
                                                    onFocus={e => (e.currentTarget.style.borderColor = '#10b981')}
                                                    onBlur={e => (e.currentTarget.style.borderColor = createFieldErrors.password ? 'rgba(239,68,68,0.5)' : 'var(--border-default)')}
                                                />
                                            </div>
                                            {createFieldErrors.password && <div style={fieldErrorStyle}>{translateError(createFieldErrors.password)}</div>}
                                        </div>
                                        <div>
                                            <label style={labelStyle}>Telefone</label>
                                            <div style={{ position: 'relative' }}>
                                                <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: '0.75rem', opacity: 0.5 }}>??</span>
                                                <input
                                                    value={createForm.phone}
                                                    onChange={e => setCreateForm({ ...createForm, phone: maskPhone(e.target.value) })}
                                                    placeholder="(21) 99999-9999"
                                                    style={inputStyle(!!createFieldErrors.phone)}
                                                    onFocus={e => (e.currentTarget.style.borderColor = '#10b981')}
                                                    onBlur={e => (e.currentTarget.style.borderColor = 'var(--border-default)')}
                                                />
                                            </div>
                                            {createFieldErrors.phone && <div style={fieldErrorStyle}>{translateError(createFieldErrors.phone)}</div>}
                                        </div>
                                    </div>

                                    {/* Role toggle */}
                                    <div style={{ marginTop: '14px' }}>
                                        <label style={labelStyle}>Tipo de conta</label>
                                        <div style={{ display: 'flex', gap: '6px' }}>
                                            {[{ key: 'CLIENTE', label: '?? Cliente', desc: 'Acesso ao painel do cliente' }, { key: 'ADMIN', label: '??? Admin', desc: 'Acesso total ao sistema' }].map(r => (
                                                <button key={r.key}
                                                    onClick={() => setCreateForm({ ...createForm, role: r.key })}
                                                    style={{
                                                        flex: 1, padding: '10px 14px', borderRadius: '10px', cursor: 'pointer',
                                                        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px',
                                                        background: createForm.role === r.key ? 'rgba(16,185,129,0.1)' : 'var(--bg-elevated)',
                                                        border: `1px solid ${createForm.role === r.key ? 'rgba(16,185,129,0.3)' : 'var(--border-default)'}`,
                                                        transition: 'all 0.15s',
                                                    }}>
                                                    <span style={{ fontSize: '0.8125rem', fontWeight: 700, color: createForm.role === r.key ? '#10b981' : 'var(--text-primary)' }}>{r.label}</span>
                                                    <span style={{ fontSize: '0.5625rem', color: 'var(--text-muted)' }}>{r.desc}</span>
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                </div>

                                {/* --- SECTION 2: Advanced (collapsible) --- */}
                                <div style={{ marginBottom: '18px' }}>
                                    <button
                                        onClick={() => setShowAdvanced(!showAdvanced)}
                                        style={{
                                            width: '100%', padding: '10px 14px', borderRadius: '10px', cursor: 'pointer',
                                            background: 'var(--bg-elevated)', border: '1px solid var(--border-default)',
                                            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                                            transition: 'all 0.2s',
                                        }}>
                                        <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                            <span style={{ width: 18, height: 18, borderRadius: '50%', background: 'rgba(45,212,191,0.15)', color: '#2dd4bf', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.5rem', fontWeight: 800 }}>2</span>
                                            <span style={{ fontSize: '0.6875rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Dados Adicionais</span>
                                            <span style={{ fontSize: '0.5625rem', color: 'var(--text-muted)', fontWeight: 500, textTransform: 'none', letterSpacing: '0' }}>(opcional)</span>
                                        </span>
                                        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', transition: 'transform 0.2s', transform: showAdvanced ? 'rotate(180deg)' : 'rotate(0)' }}>?</span>
                                    </button>

                                    {showAdvanced && (
                                        <div style={{ marginTop: '12px', padding: '16px', borderRadius: '10px', background: 'rgba(45,212,191,0.03)', border: '1px solid rgba(45,212,191,0.08)' }}>
                                            {/* CPF/CNPJ + Status */}
                                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '12px' }}>
                                                <div>
                                                    <label style={labelStyle}>CPF/CNPJ</label>
                                                    <div style={{ position: 'relative' }}>
                                                        <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: '0.75rem', opacity: 0.5 }}>??</span>
                                                        <input
                                                            value={createForm.cpfCnpj}
                                                            onChange={e => setCreateForm({ ...createForm, cpfCnpj: maskCpfCnpj(e.target.value) })}
                                                            placeholder="000.000.000-00"
                                                            style={inputStyle(false)}
                                                            onFocus={e => (e.currentTarget.style.borderColor = '#2dd4bf')}
                                                            onBlur={e => (e.currentTarget.style.borderColor = 'var(--border-default)')}
                                                        />
                                                    </div>
                                                </div>
                                                <div>
                                                    <label style={labelStyle}>Status</label>
                                                    <div style={{ display: 'flex', gap: '4px' }}>
                                                        {[{ key: 'ACTIVE', label: 'Ativo', color: '#10b981' }, { key: 'INACTIVE', label: 'Inativo', color: '#6b7280' }, { key: 'BLOCKED', label: 'Bloqueado', color: '#ef4444' }].map(s => (
                                                            <button key={s.key}
                                                                onClick={() => setCreateForm({ ...createForm, clientStatus: s.key })}
                                                                style={{
                                                                    flex: 1, padding: '8px 4px', borderRadius: '8px', fontSize: '0.625rem', fontWeight: 700, cursor: 'pointer',
                                                                    background: createForm.clientStatus === s.key ? `${s.color}15` : 'var(--bg-elevated)',
                                                                    border: `1px solid ${createForm.clientStatus === s.key ? `${s.color}44` : 'var(--border-default)'}`,
                                                                    color: createForm.clientStatus === s.key ? s.color : 'var(--text-muted)',
                                                                }}>
                                                                {s.label}
                                                            </button>
                                                        ))}
                                                    </div>
                                                </div>
                                            </div>

                                            {/* Social Links */}
                                            <div style={{ marginBottom: '12px' }}>
                                                <label style={labelStyle}>Redes Sociais</label>
                                                <div style={{ position: 'relative' }}>
                                                    <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: '0.75rem', opacity: 0.5 }}>??</span>
                                                    <input
                                                        value={createForm.socialLinks}
                                                        onChange={e => setCreateForm({ ...createForm, socialLinks: e.target.value })}
                                                        placeholder="Instagram, YouTube, TikTok..."
                                                        style={inputStyle(false)}
                                                        onFocus={e => (e.currentTarget.style.borderColor = '#2dd4bf')}
                                                        onBlur={e => (e.currentTarget.style.borderColor = 'var(--border-default)')}
                                                    />
                                                </div>
                                            </div>

                                            {/* Notes */}
                                            <div>
                                                <label style={labelStyle}>?? Notas internas</label>
                                                <textarea
                                                    value={createForm.notes}
                                                    onChange={e => setCreateForm({ ...createForm, notes: e.target.value })}
                                                    placeholder="Observações sobre o cliente..."
                                                    rows={2}
                                                    style={{
                                                        width: '100%', padding: '10px 14px', borderRadius: '10px', fontSize: '0.8125rem',
                                                        background: 'var(--bg-elevated)', border: '1px solid var(--border-default)',
                                                        color: 'var(--text-primary)', outline: 'none', resize: 'vertical', fontFamily: 'inherit',
                                                    }}
                                                />
                                            </div>
                                        </div>
                                    )}
                                </div>

                                {/* --- ACTIONS --- */}
                                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px' }}>
                                    <button onClick={resetCreateModal}
                                        style={{ padding: '10px 20px', borderRadius: '10px', background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-secondary)', fontSize: '0.8125rem', fontWeight: 600, cursor: 'pointer' }}>
                                        Cancelar
                                    </button>
                                    <button onClick={handleCreate} disabled={!canCreate || creating}
                                        style={{
                                            padding: '10px 28px', borderRadius: '10px', border: 'none', fontSize: '0.875rem', fontWeight: 700, cursor: 'pointer',
                                            background: canCreate && !creating ? 'linear-gradient(135deg, #10b981, #11819B)' : 'var(--bg-elevated)',
                                            color: canCreate && !creating ? '#fff' : 'var(--text-muted)',
                                            opacity: canCreate && !creating ? 1 : 0.5,
                                            display: 'flex', alignItems: 'center', gap: '8px',
                                        }}>
                                        {creating ? '? Criando...' : '?? Cadastrar Cliente'}
                                    </button>
                                </div>
                            </div>
                        </div>
                    </ModalOverlay>
                );
            })()}

            {/* Edit Modal */}
            {editUser && (() => {
                const editInputStyle = (hasError: boolean) => ({
                    width: '100%', padding: '10px 14px 10px 36px', borderRadius: '10px', fontSize: '0.8125rem',
                    background: 'var(--bg-elevated)', border: `1px solid ${hasError ? 'rgba(239,68,68,0.5)' : 'var(--border-default)'}`,
                    color: 'var(--text-primary)', outline: 'none', fontFamily: 'inherit',
                    transition: 'border-color 0.2s',
                } as React.CSSProperties);

                const editLabelStyle = {
                    fontSize: '0.6875rem', fontWeight: 700, color: 'var(--text-muted)',
                    textTransform: 'uppercase' as const, letterSpacing: '0.12em', marginBottom: '6px', display: 'block',
                };

                const editFieldErrorStyle = {
                    fontSize: '0.6875rem', color: '#ef4444', fontWeight: 600, marginTop: '4px', paddingLeft: '4px',
                };

                return (
                <ModalOverlay onClose={() => setEditUser(null)}>
                    <div className="modal" style={{ maxWidth: 520, maxHeight: '92vh', overflowY: 'auto', padding: 0 }}>
                        {/* --- HEADER --- */}
                        <div style={{ padding: '28px 32px 0', borderBottom: 'none' }}>
                            <h2 style={{ fontSize: '1.25rem', fontWeight: 800, margin: 0, display: 'flex', alignItems: 'center', gap: '10px' }}>
                                <span style={{
                                    width: 36, height: 36, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    background: 'linear-gradient(135deg, #10b981, #11819B)', fontSize: '1rem'
                                }}>??</span>
                                Editar Cliente
                            </h2>
                            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '6px', marginBottom: 0 }}>
                                Atualize as informações de <strong style={{ color: 'var(--text-primary)' }}>{editUser.name}</strong>
                            </p>
                        </div>

                        {editError && Object.keys(editFieldErrors).length === 0 && (
                            <div style={{ margin: '16px 32px 0', padding: '10px 14px', borderRadius: '10px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.15)', color: '#ef4444', fontSize: '0.8125rem', fontWeight: 600 }}>{editError}</div>
                        )}

                        {editFetching ? (
                            <div style={{ padding: '48px 32px', textAlign: 'center', color: 'var(--text-muted)' }}>
                                <div className="spinner" style={{ margin: '0 auto 12px' }} />
                                <div style={{ fontSize: '0.8125rem' }}>Carregando dados...</div>
                            </div>
                        ) : (
                        <div style={{ padding: '20px 32px 28px' }}>
                            {/* --- SECTION 1: Dados Pessoais --- */}
                            <div style={{ marginBottom: '20px' }}>
                                <div style={{ fontSize: '0.625rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: '14px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                    <span style={{ width: 18, height: 18, borderRadius: '50%', background: '#10b981', color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.5rem', fontWeight: 800 }}>1</span>
                                    Dados Pessoais
                                </div>

                                {/* Name + CPF row */}
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '12px' }}>
                                    <div>
                                        <label style={editLabelStyle}>Nome *</label>
                                        <div style={{ position: 'relative' }}>
                                            <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: '0.75rem', opacity: 0.5 }}>??</span>
                                            <input
                                                value={editForm.name} onChange={e => setEditForm({ ...editForm, name: e.target.value })}
                                                placeholder="Nome completo"
                                                style={editInputStyle(!!editFieldErrors.name)}
                                                onFocus={e => (e.currentTarget.style.borderColor = '#10b981')}
                                                onBlur={e => (e.currentTarget.style.borderColor = editFieldErrors.name ? 'rgba(239,68,68,0.5)' : 'var(--border-default)')}
                                            />
                                        </div>
                                        {editFieldErrors.name && <div style={editFieldErrorStyle}>{translateError(editFieldErrors.name)}</div>}
                                    </div>
                                    <div>
                                        <label style={editLabelStyle}>CPF / CNPJ</label>
                                        <div style={{ position: 'relative' }}>
                                            <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: '0.75rem', opacity: 0.5 }}>??</span>
                                            <input
                                                value={editForm.cpfCnpj} onChange={e => setEditForm({ ...editForm, cpfCnpj: maskCpfCnpj(e.target.value) })}
                                                placeholder="000.000.000-00"
                                                style={editInputStyle(false)}
                                                onFocus={e => (e.currentTarget.style.borderColor = '#10b981')}
                                                onBlur={e => (e.currentTarget.style.borderColor = 'var(--border-default)')}
                                            />
                                        </div>
                                    </div>
                                </div>

                                {/* Status toggle */}
                                <div>
                                    <label style={editLabelStyle}>Status</label>
                                    <div style={{ display: 'flex', gap: '4px' }}>
                                        {[{ key: 'ACTIVE', label: 'Ativo', color: '#10b981' }, { key: 'INACTIVE', label: 'Inativo', color: '#6b7280' }, { key: 'BLOCKED', label: 'Bloqueado', color: '#ef4444' }].map(s => (
                                            <button key={s.key}
                                                onClick={() => setEditForm({ ...editForm, clientStatus: s.key })}
                                                style={{
                                                    flex: 1, padding: '8px 4px', borderRadius: '8px', fontSize: '0.625rem', fontWeight: 700, cursor: 'pointer',
                                                    background: editForm.clientStatus === s.key ? `${s.color}15` : 'var(--bg-elevated)',
                                                    border: `1px solid ${editForm.clientStatus === s.key ? `${s.color}44` : 'var(--border-default)'}`,
                                                    color: editForm.clientStatus === s.key ? s.color : 'var(--text-muted)',
                                                }}
                                            >{s.label}</button>
                                        ))}
                                    </div>
                                </div>

                                {/* Role toggle */}
                                <div style={{ marginTop: '14px' }}>
                                    <label style={editLabelStyle}>Tipo de conta</label>
                                    <div style={{ display: 'flex', gap: '6px' }}>
                                        {[{ key: 'CLIENTE', label: '?? Cliente', desc: 'Acesso ao painel do cliente' }, { key: 'ADMIN', label: '??? Admin', desc: 'Acesso total ao sistema' }].map(r => (
                                            <button key={r.key}
                                                onClick={() => setEditForm({ ...editForm, role: r.key })}
                                                style={{
                                                    flex: 1, padding: '10px 14px', borderRadius: '10px', cursor: 'pointer',
                                                    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px',
                                                    background: editForm.role === r.key ? 'rgba(16,185,129,0.1)' : 'var(--bg-elevated)',
                                                    border: `1px solid ${editForm.role === r.key ? 'rgba(16,185,129,0.3)' : 'var(--border-default)'}`,
                                                    transition: 'all 0.15s',
                                                }}>
                                                <span style={{ fontSize: '0.8125rem', fontWeight: 700, color: editForm.role === r.key ? '#10b981' : 'var(--text-primary)' }}>{r.label}</span>
                                                <span style={{ fontSize: '0.5625rem', color: 'var(--text-muted)' }}>{r.desc}</span>
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            </div>

                            {/* --- SECTION 2: Contato & Endereço --- */}
                            <div style={{ marginBottom: '20px' }}>
                                <div style={{ fontSize: '0.625rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: '14px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                    <span style={{ width: 18, height: 18, borderRadius: '50%', background: '#3b82f6', color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.5rem', fontWeight: 800 }}>2</span>
                                    Contato & Endereço
                                </div>

                                {/* Email + Phone */}
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '12px' }}>
                                    <div>
                                        <label style={editLabelStyle}>E-mail *</label>
                                        <div style={{ position: 'relative' }}>
                                            <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: '0.75rem', opacity: 0.5 }}>??</span>
                                            <input
                                                type="email" value={editForm.email}
                                                onChange={e => setEditForm({ ...editForm, email: maskEmail(e.target.value) })}
                                                placeholder="email@exemplo.com"
                                                style={editInputStyle(!!editFieldErrors.email)}
                                                onFocus={e => (e.currentTarget.style.borderColor = '#3b82f6')}
                                                onBlur={e => (e.currentTarget.style.borderColor = editFieldErrors.email ? 'rgba(239,68,68,0.5)' : 'var(--border-default)')}
                                            />
                                        </div>
                                        {editFieldErrors.email && <div style={editFieldErrorStyle}>{translateError(editFieldErrors.email)}</div>}
                                    </div>
                                    <div>
                                        <label style={editLabelStyle}>Telefone</label>
                                        <div style={{ position: 'relative' }}>
                                            <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: '0.75rem', opacity: 0.5 }}>??</span>
                                            <input
                                                value={editForm.phone}
                                                onChange={e => setEditForm({ ...editForm, phone: maskPhone(e.target.value) })}
                                                placeholder="(21) 99999-9999"
                                                style={editInputStyle(!!editFieldErrors.phone)}
                                                onFocus={e => (e.currentTarget.style.borderColor = '#3b82f6')}
                                                onBlur={e => (e.currentTarget.style.borderColor = 'var(--border-default)')}
                                            />
                                        </div>
                                        {editFieldErrors.phone && <div style={editFieldErrorStyle}>{translateError(editFieldErrors.phone)}</div>}
                                    </div>
                                </div>

                                {/* Social Links */}
                                <div style={{ marginBottom: '12px' }}>
                                    <label style={editLabelStyle}>Redes Sociais</label>
                                    <div style={{ position: 'relative' }}>
                                        <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: '0.75rem', opacity: 0.5 }}>??</span>
                                        <input
                                            value={editForm.socialLinks}
                                            onChange={e => setEditForm({ ...editForm, socialLinks: e.target.value })}
                                            placeholder="Instagram, YouTube, TikTok..."
                                            style={editInputStyle(false)}
                                            onFocus={e => (e.currentTarget.style.borderColor = '#3b82f6')}
                                            onBlur={e => (e.currentTarget.style.borderColor = 'var(--border-default)')}
                                        />
                                    </div>
                                </div>

                                {/* Address row */}
                                <div style={{ marginBottom: '12px' }}>
                                    <label style={editLabelStyle}>Endereço</label>
                                    <div style={{ position: 'relative' }}>
                                        <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: '0.75rem', opacity: 0.5 }}>??</span>
                                        <input
                                            value={editForm.address}
                                            onChange={e => setEditForm({ ...editForm, address: e.target.value })}
                                            placeholder="Rua, número, complemento"
                                            style={editInputStyle(false)}
                                            onFocus={e => (e.currentTarget.style.borderColor = '#3b82f6')}
                                            onBlur={e => (e.currentTarget.style.borderColor = 'var(--border-default)')}
                                        />
                                    </div>
                                </div>

                                {/* City + State */}
                                <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '12px' }}>
                                    <div>
                                        <label style={editLabelStyle}>Cidade</label>
                                        <div style={{ position: 'relative' }}>
                                            <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: '0.75rem', opacity: 0.5 }}>???</span>
                                            <input
                                                value={editForm.city}
                                                onChange={e => setEditForm({ ...editForm, city: e.target.value })}
                                                placeholder="Rio de Janeiro"
                                                style={editInputStyle(false)}
                                                onFocus={e => (e.currentTarget.style.borderColor = '#3b82f6')}
                                                onBlur={e => (e.currentTarget.style.borderColor = 'var(--border-default)')}
                                            />
                                        </div>
                                    </div>
                                    <div>
                                        <label style={editLabelStyle}>UF</label>
                                        <div style={{ position: 'relative' }}>
                                            <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: '0.75rem', opacity: 0.5 }}>??</span>
                                            <input
                                                value={editForm.state}
                                                onChange={e => setEditForm({ ...editForm, state: e.target.value })}
                                                placeholder="RJ" maxLength={2}
                                                style={{ ...editInputStyle(false), textTransform: 'uppercase' as any }}
                                                onFocus={e => (e.currentTarget.style.borderColor = '#3b82f6')}
                                                onBlur={e => (e.currentTarget.style.borderColor = 'var(--border-default)')}
                                            />
                                        </div>
                                    </div>
                                </div>
                            </div>

                            {/* --- SECTION 3: Segurança & Notas --- */}
                            <div style={{ marginBottom: '18px' }}>
                                <div style={{ fontSize: '0.625rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: '14px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                    <span style={{ width: 18, height: 18, borderRadius: '50%', background: 'rgba(45,212,191,0.15)', color: '#2dd4bf', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.5rem', fontWeight: 800 }}>3</span>
                                    <span style={{ fontSize: '0.6875rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Segurança & Notas</span>
                                    <span style={{ fontSize: '0.5625rem', color: 'var(--text-muted)', fontWeight: 500, textTransform: 'none', letterSpacing: '0' }}>(opcional)</span>
                                </div>

                                <div style={{ padding: '16px', borderRadius: '10px', background: 'rgba(45,212,191,0.03)', border: '1px solid rgba(45,212,191,0.08)' }}>
                                    {/* Password */}
                                    <div style={{ marginBottom: '12px' }}>
                                        <label style={editLabelStyle}>Nova Senha <span style={{ fontWeight: 500, textTransform: 'none', letterSpacing: 0, color: 'var(--text-muted)' }}>(vazio = manter atual)</span></label>
                                        <div style={{ position: 'relative' }}>
                                            <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: '0.75rem', opacity: 0.5 }}>??</span>
                                            <input
                                                type="password" value={editForm.password}
                                                onChange={e => setEditForm({ ...editForm, password: e.target.value })}
                                                placeholder="Mínimo 6 caracteres"
                                                style={editInputStyle(!!editFieldErrors.password)}
                                                onFocus={e => (e.currentTarget.style.borderColor = '#2dd4bf')}
                                                onBlur={e => (e.currentTarget.style.borderColor = editFieldErrors.password ? 'rgba(239,68,68,0.5)' : 'var(--border-default)')}
                                            />
                                        </div>
                                        {editFieldErrors.password && <div style={editFieldErrorStyle}>{translateError(editFieldErrors.password)}</div>}
                                    </div>

                                    {/* Notes */}
                                    <div>
                                        <label style={editLabelStyle}>?? Notas internas</label>
                                        <textarea
                                            value={editForm.notes}
                                            onChange={e => setEditForm({ ...editForm, notes: e.target.value })}
                                            placeholder="Observações sobre o cliente..."
                                            rows={2}
                                            style={{
                                                width: '100%', padding: '10px 14px', borderRadius: '10px', fontSize: '0.8125rem',
                                                background: 'var(--bg-elevated)', border: '1px solid var(--border-default)',
                                                color: 'var(--text-primary)', outline: 'none', resize: 'vertical', fontFamily: 'inherit',
                                            }}
                                        />
                                    </div>
                                </div>
                            </div>

                            {/* --- ACTIONS --- */}
                            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px' }}>
                                <button onClick={() => setEditUser(null)}
                                    style={{ padding: '10px 20px', borderRadius: '10px', background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-secondary)', fontSize: '0.8125rem', fontWeight: 600, cursor: 'pointer' }}>
                                    Cancelar
                                </button>
                                <button onClick={handleEdit} disabled={editLoading}
                                    style={{
                                        padding: '10px 28px', borderRadius: '10px', border: 'none', fontSize: '0.875rem', fontWeight: 700, cursor: 'pointer',
                                        background: !editLoading ? 'linear-gradient(135deg, #10b981, #11819B)' : 'var(--bg-elevated)',
                                        color: !editLoading ? '#fff' : 'var(--text-muted)',
                                        opacity: !editLoading ? 1 : 0.5,
                                        display: 'flex', alignItems: 'center', gap: '8px',
                                    }}>
                                    {editLoading ? '? Salvando...' : '?? Salvar Alterações'}
                                </button>
                            </div>
                        </div>
                        )}
                    </div>
                </ModalOverlay>
                );
            })()}

            {/* Delete Confirmation Modal */}
            {deleteUser && (
                <ModalOverlay onClose={() => setDeleteUser(null)}>
                    <div className="modal" style={{ maxWidth: 400 }}>
                        <div style={{ textAlign: 'center', marginBottom: '20px' }}>
                            <div style={{ fontSize: '3rem', marginBottom: '10px' }}>??</div>
                            <h2 style={{ fontSize: '1.25rem', fontWeight: 700 }}>Excluir Usuário</h2>
                        </div>
                        <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginBottom: '8px', textAlign: 'center' }}>
                            Tem certeza que deseja excluir <strong>{deleteUser.name}</strong>?
                        </p>
                        <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', marginBottom: '24px', lineHeight: 1.5, textAlign: 'center' }}>
                            Todos os contratos e agendamentos vinculados serão cancelados e os dados removidos permanentemente.
                        </p>
                        <div className="modal-actions">
                            <button className="btn btn-secondary" onClick={() => setDeleteUser(null)} disabled={deleteLoading} style={{ flex: 1 }}>Voltar</button>
                            <button className="btn btn-danger" onClick={handleDelete} disabled={deleteLoading} style={{ flex: 1 }}>
                                {deleteLoading ? 'Excluindo...' : 'Sim, Excluir'}
                            </button>
                        </div>
                    </div>
                </ModalOverlay>
            )}
        </div>
    );
}

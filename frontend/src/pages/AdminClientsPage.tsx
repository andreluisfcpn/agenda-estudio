import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { usersApi, UserSummary, ApiError } from '../api/client';

import { maskPhone, maskEmail, translateError } from '../utils/mask';



export default function AdminClientsPage() {
    const navigate = useNavigate();
    const [users, setUsers] = useState<UserSummary[]>([]);
    const [loading, setLoading] = useState(true);

    const [showCreate, setShowCreate] = useState(false);
    const [createForm, setCreateForm] = useState({ name: '', email: '', phone: '', password: '', role: 'CLIENTE' });
    const [createError, setCreateError] = useState('');
    const [createFieldErrors, setCreateFieldErrors] = useState<Record<string, string>>({});


    const [editUser, setEditUser] = useState<UserSummary | null>(null);
    const [editForm, setEditForm] = useState({ name: '', email: '', phone: '', role: '', password: '' });
    const [editError, setEditError] = useState('');
    const [editFieldErrors, setEditFieldErrors] = useState<Record<string, string>>({});


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
        try {
            await usersApi.create({
                name: createForm.name,
                email: createForm.email,
                password: createForm.password,
                phone: createForm.phone.replace(/\D/g, '') || undefined,
                role: createForm.role
            });

            setShowCreate(false);
            setCreateForm({ name: '', email: '', phone: '', password: '', role: 'CLIENTE' });
            await loadData();
        } catch (err: any) {
            if (err.name === 'ApiError') {
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
                setCreateError(err.message);
            }
        }
    };

    const handleEdit = async () => {
        if (!editUser) return;
        setEditError('');
        setEditFieldErrors({});
        try {
            const data: any = {};
            if (editForm.name && editForm.name !== editUser.name) data.name = editForm.name;
            if (editForm.email && editForm.email !== editUser.email) data.email = editForm.email;
            if (editForm.phone.replace(/\D/g, '') !== (editUser.phone || '')) data.phone = editForm.phone.replace(/\D/g, '');
            if (editForm.role && editForm.role !== editUser.role) data.role = editForm.role;

            if (editForm.password) data.password = editForm.password;
            await usersApi.update(editUser.id, data);
            setEditUser(null);
            await loadData();
        } catch (err: any) {
            if (err.name === 'ApiError') {
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
                setEditError(err.message);
            }
        }
    };



    const handleDelete = async () => {
        if (!deleteUser) return;
        setDeleteLoading(true);
        try {
            await usersApi.remove(deleteUser.id);
            setDeleteUser(null);
            await loadData();
        } catch (err: any) {
            alert(err.message || 'Erro ao excluir usuário');
        } finally {
            setDeleteLoading(false);
        }
    };

    const getRoleLabel = (u: UserSummary): string => {
        if (u.role === 'ADMIN') return '🛡️ Admin';
        if (u.contracts && u.contracts.length > 0) {
            const type = u.contracts[0].type;
            return type === 'FIXO' ? '📌 Fixo' : '🔄 Flex';
        }
        return '👤 Avulso';
    };

    const getRoleBadgeClass = (u: UserSummary): string => {
        if (u.role === 'ADMIN') return 'badge-sabado';
        if (u.contracts && u.contracts.length > 0) {
            return u.contracts[0].type === 'FIXO' ? 'badge-confirmed' : 'badge-reserved';
        }
        return 'badge-comercial';
    };

    if (loading) return <div className="loading-spinner"><div className="spinner" /></div>;

    return (
        <div>
            <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '12px' }}>
                <div><h1 className="page-title">👥 Clientes</h1><p className="page-subtitle">Gerencie os usuários do sistema</p></div>
                <button className="btn btn-primary" onClick={() => { setShowCreate(true); setCreateError(''); }}>+ Novo Cliente</button>
            </div>

            <div className="stats-row">
                <div className="stat-card"><div className="stat-label">Total</div><div className="stat-value">{users.length}</div></div>
                <div className="stat-card"><div className="stat-label">Fixo</div><div className="stat-value">{users.filter(u => u.contracts?.some(c => c.type === 'FIXO')).length}</div></div>
                <div className="stat-card"><div className="stat-label">Flex</div><div className="stat-value">{users.filter(u => u.contracts?.some(c => c.type === 'FLEX')).length}</div></div>
                <div className="stat-card"><div className="stat-label">Avulsos</div><div className="stat-value">{users.filter(u => u.role === 'CLIENTE' && (!u.contracts || u.contracts.length === 0)).length}</div></div>
            </div>

            <div className="card">
                <div className="table-container">
                    <table>
                        <thead><tr><th>Nome</th><th>E-mail</th><th>Telefone</th><th>Tipo</th><th>Sessões</th><th>Contratos</th><th>Cadastro</th><th>Ações</th></tr></thead>
                        <tbody>
                            {users.map(u => (
                                <tr key={u.id}>
                                    <td>
                                        <span style={{ fontWeight: 600, cursor: 'pointer', color: 'var(--accent-primary)' }} onClick={() => navigate(`/admin/clients/${u.id}`)}>
                                            {u.name}
                                        </span>
                                    </td>
                                    <td style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>{u.email}</td>
                                    <td style={{ fontSize: '0.8125rem' }}>{maskPhone(u.phone || '') || '—'}</td>
                                    <td><span className={`badge ${getRoleBadgeClass(u)}`}>{getRoleLabel(u)}</span></td>

                                    <td>{u._count.bookings}</td>
                                    <td>{u._count.contracts}</td>
                                    <td style={{ fontSize: '0.75rem' }}>{new Date(u.createdAt).toLocaleDateString('pt-BR', { timeZone: 'UTC' })}</td>
                                    <td style={{ display: 'flex', gap: '6px' }}>
                                        <button className="btn btn-ghost btn-sm" onClick={() => { setEditUser(u); setEditForm({ name: u.name, email: u.email, phone: maskPhone(u.phone || ''), role: u.role, password: '' }); setEditError(''); }}>✏️</button>
                                        {u.role !== 'ADMIN' && <button className="btn btn-danger btn-sm" onClick={() => setDeleteUser(u)}>🗑️</button>}
                                    </td>

                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* Create Modal */}
            {showCreate && (
                <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setShowCreate(false)}>
                    <div className="modal">
                        <h2 className="modal-title">Novo Cliente</h2>
                        {createError && Object.keys(createFieldErrors).length === 0 && <div className="error-message">{createError}</div>}

                        <div className="form-group"><label className="form-label">Nome</label><input className={`form-input ${createFieldErrors.name ? 'error' : ''}`} value={createForm.name} onChange={e => setCreateForm({ ...createForm, name: e.target.value })} placeholder="Nome completo" />{createFieldErrors.name && <div className="field-error-message">{translateError(createFieldErrors.name)}</div>}</div>
                        <div className="form-group"><label className="form-label">E-mail</label><input className={`form-input ${createFieldErrors.email ? 'error' : ''}`} type="email" value={createForm.email} onChange={e => setCreateForm({ ...createForm, email: maskEmail(e.target.value) })} placeholder="email@exemplo.com" />{createFieldErrors.email && <div className="field-error-message">{translateError(createFieldErrors.email)}</div>}</div>
                        <div className="form-group"><label className="form-label">Senha</label><input className={`form-input ${createFieldErrors.password ? 'error' : ''}`} type="password" value={createForm.password} onChange={e => setCreateForm({ ...createForm, password: e.target.value })} placeholder="Mínimo 6 caracteres" />{createFieldErrors.password && <div className="field-error-message">{translateError(createFieldErrors.password)}</div>}</div>
                        <div className="form-group"><label className="form-label">Telefone (opcional)</label><input className={`form-input ${createFieldErrors.phone ? 'error' : ''}`} value={createForm.phone} onChange={e => setCreateForm({ ...createForm, phone: maskPhone(e.target.value) })} placeholder="(21) 99999-9999" />{createFieldErrors.phone && <div className="field-error-message">{translateError(createFieldErrors.phone)}</div>}</div>



                        <div className="form-group"><label className="form-label">Tipo</label>
                            <select className="form-select" value={createForm.role} onChange={e => setCreateForm({ ...createForm, role: e.target.value })}>
                                <option value="CLIENTE">👤 Cliente</option><option value="ADMIN">🛡️ Administrador</option>
                            </select>
                        </div>
                        <div className="modal-actions">
                            <button className="btn btn-secondary" onClick={() => setShowCreate(false)}>Cancelar</button>
                            <button className="btn btn-primary" onClick={handleCreate} disabled={!createForm.name || !createForm.email || !createForm.password}>🚀 Criar</button>
                        </div>
                    </div>
                </div>
            )}

            {/* Edit Modal */}
            {editUser && (
                <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setEditUser(null)}>
                    <div className="modal">
                        <h2 className="modal-title">Editar Usuário</h2>
                        {editError && Object.keys(editFieldErrors).length === 0 && <div className="error-message">{editError}</div>}

                        <div className="form-group"><label className="form-label">Nome</label><input className={`form-input ${editFieldErrors.name ? 'error' : ''}`} value={editForm.name} onChange={e => setEditForm({ ...editForm, name: e.target.value })} />{editFieldErrors.name && <div className="field-error-message">{translateError(editFieldErrors.name)}</div>}</div>
                        <div className="form-group"><label className="form-label">E-mail</label><input className={`form-input ${editFieldErrors.email ? 'error' : ''}`} type="email" value={editForm.email} onChange={e => setEditForm({ ...editForm, email: maskEmail(e.target.value) })} />{editFieldErrors.email && <div className="field-error-message">{translateError(editFieldErrors.email)}</div>}</div>
                        <div className="form-group"><label className="form-label">Telefone</label><input className={`form-input ${editFieldErrors.phone ? 'error' : ''}`} value={editForm.phone} onChange={e => setEditForm({ ...editForm, phone: maskPhone(e.target.value) })} />{editFieldErrors.phone && <div className="field-error-message">{translateError(editFieldErrors.phone)}</div>}</div>



                        <div className="form-group"><label className="form-label">Tipo</label>
                            <select className="form-select" value={editForm.role} onChange={e => setEditForm({ ...editForm, role: e.target.value })}>
                                <option value="CLIENTE">👤 Cliente</option><option value="ADMIN">🛡️ Admin</option>
                            </select>
                        </div>
                        <div className="form-group"><label className="form-label">Nova Senha (deixe vazio para manter)</label><input className={`form-input ${editFieldErrors.password ? 'error' : ''}`} type="password" value={editForm.password} onChange={e => setEditForm({ ...editForm, password: e.target.value })} placeholder="Mínimo 6 caracteres" />{editFieldErrors.password && <div className="field-error-message">{translateError(editFieldErrors.password)}</div>}</div>


                        <div className="modal-actions">
                            <button className="btn btn-secondary" onClick={() => setEditUser(null)}>Cancelar</button>
                            <button className="btn btn-primary" onClick={handleEdit}>💾 Salvar</button>
                        </div>
                    </div>
                </div>
            )}

            {/* Delete Confirmation Modal */}
            {deleteUser && (
                <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setDeleteUser(null)}>
                    <div className="modal">
                        <h2 className="modal-title" style={{ color: 'var(--status-cancelled)' }}>⚠️ Excluir Usuário?</h2>
                        <div style={{ marginBottom: '20px', color: 'var(--text-secondary)' }}>
                            <p>Tem certeza que deseja excluir o cliente <strong>{deleteUser.name}</strong>?</p>
                            <p style={{ marginTop: '8px', fontSize: '0.85rem' }}>Todos os contratos e agendamentos vinculados a esta conta serão cancelados e os dados removidos permanentemente.</p>
                        </div>
                        <div className="modal-actions">
                            <button className="btn btn-secondary" onClick={() => setDeleteUser(null)} disabled={deleteLoading}>Cancelar</button>
                            <button className="btn btn-danger" onClick={handleDelete} disabled={deleteLoading}>
                                {deleteLoading ? 'Excluindo...' : 'Sim, Excluir'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

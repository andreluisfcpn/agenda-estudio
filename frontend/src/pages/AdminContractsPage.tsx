import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { contractsApi, usersApi, Contract, UserSummary, CreateContractData } from '../api/client';

function formatBRL(cents: number): string {
    return `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;
}

const DAY_NAMES_FULL = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

export default function AdminContractsPage() {
    const navigate = useNavigate();
    const [contracts, setContracts] = useState<Contract[]>([]);
    const [users, setUsers] = useState<UserSummary[]>([]);
    const [loading, setLoading] = useState(true);
    const [filter, setFilter] = useState<'ALL' | 'ACTIVE' | 'EXPIRED' | 'CANCELLED' | 'PENDING_CANCELLATION'>('ALL');

    const [showCreate, setShowCreate] = useState(false);
    const [createForm, setCreateForm] = useState<Partial<CreateContractData> & { contractUrl?: string }>({
        name: '', type: 'FIXO', tier: 'COMERCIAL', durationMonths: 3, startDate: new Date().toISOString().split('T')[0], contractUrl: '',
    });
    const [createError, setCreateError] = useState('');
    const [createSuccess, setCreateSuccess] = useState('');

    const [conflicts, setConflicts] = useState<{ date: string, originalTime: string, suggestedReplacement?: { date: string, time: string } }[]>([]);
    const [resolvedConflicts, setResolvedConflicts] = useState<{ originalDate: string, originalTime: string, newDate: string, newTime: string }[]>([]);
    const [showConflictModal, setShowConflictModal] = useState(false);

    // Cancel / Resolve Action States
    const [showCancelModalFor, setShowCancelModalFor] = useState<string | null>(null);
    const [showResolveModalFor, setShowResolveModalFor] = useState<{ id: string, action: 'CHARGE_FEE' | 'WAIVE_FEE' } | null>(null);

    const [editContract, setEditContract] = useState<Contract | null>(null);
    const [editForm, setEditForm] = useState({ status: '', endDate: '', flexCreditsRemaining: '', contractUrl: '', paymentMethod: '' });
    const [editError, setEditError] = useState('');

    useEffect(() => { loadData(); }, []);

    const loadData = async () => {
        setLoading(true);
        try {
            const [cRes, uRes] = await Promise.all([contractsApi.getAll(), usersApi.getAll()]);
            setContracts(cRes.contracts);
            setUsers(uRes.users);
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
        } catch (err: any) { setCreateError(err.message); }
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
            } catch (err: any) {
                setCreateError(err.message || 'Erro ao validar agenda.');
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
        } catch (err: any) { setEditError(err.message); }
    };

    const handleCancel = async (id: string) => {
        setShowCancelModalFor(id);
    };

    const confirmCancel = async () => {
        if (!showCancelModalFor) return;
        try {
            await contractsApi.cancel(showCancelModalFor);
            setShowCancelModalFor(null);
            await loadData();
        } catch (err: any) { alert(err.message); }
    };

    const handleResolveCancel = async (id: string, action: 'CHARGE_FEE' | 'WAIVE_FEE') => {
        setShowResolveModalFor({ id, action });
    };

    const confirmResolveCancel = async () => {
        if (!showResolveModalFor) return;
        try {
            const res = await contractsApi.resolveCancellation(showResolveModalFor.id, showResolveModalFor.action);
            alert(res.message);
            setShowResolveModalFor(null);
            await loadData();
        } catch (err: any) { alert(err.message); }
    };

    const filtered = filter === 'ALL' ? contracts : contracts.filter(c => c.status === filter);
    const episodeCount = (months: number) => months === 3 ? 12 : 24;

    if (loading) return <div className="loading-spinner"><div className="spinner" /></div>;

    return (
        <div>
            <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '12px' }}>
                <div><h1 className="page-title">📋 Contratos</h1><p className="page-subtitle">Gerencie contratos de fidelidade (pacote de episódios)</p></div>
                <button className="btn btn-primary" onClick={() => { setShowCreate(true); setCreateError(''); setCreateSuccess(''); }}>+ Novo Contrato</button>
            </div>

            <div className="stats-row">
                {(['ALL', 'ACTIVE', 'PENDING_CANCELLATION', 'EXPIRED', 'CANCELLED'] as const).map(s => (
                    <div key={s} className={`stat-card`} onClick={() => setFilter(s)} style={{ cursor: 'pointer', border: filter === s ? '2px solid var(--accent-primary)' : undefined }}>
                        <div className="stat-label">{s === 'ALL' ? 'Todos' : s === 'ACTIVE' ? 'Ativos' : s === 'PENDING_CANCELLATION' ? 'Aguardando Cancelamento' : s === 'EXPIRED' ? 'Expirados' : 'Cancelados'}</div>
                        <div className="stat-value">{s === 'ALL' ? contracts.length : contracts.filter(c => c.status === s).length}</div>
                    </div>
                ))}
            </div>

            <div className="card">
                <div className="table-container">
                    <table>
                        <thead><tr><th>Cliente</th><th>Tipo</th><th>Faixa</th><th>Gravações</th><th>Desconto</th><th>Pagamento</th><th>Vigência</th><th>Contrato</th><th>Status</th><th>Ações</th></tr></thead>
                        <tbody>
                            {filtered.map(c => (
                                <tr key={c.id}>
                                    <td>
                                        <span style={{ fontWeight: 600, cursor: 'pointer', color: 'var(--accent-primary)' }} onClick={() => c.user?.id && navigate(`/admin/clients/${c.user.id}`)}>
                                            {c.user?.name || '—'}
                                        </span>
                                    </td>
                                    <td><span className={`badge ${c.type === 'FIXO' ? 'badge-confirmed' : 'badge-reserved'}`}>{c.type === 'FIXO' ? '📌 Fixo' : '🔄 Flex'}</span></td>
                                    <td><span className={`badge badge-${c.tier.toLowerCase()}`}>{c.tier}</span></td>
                                    <td>
                                        <span style={{ fontWeight: 700 }}>{episodeCount(c.durationMonths)}</span>
                                        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}> ep ({c.durationMonths}m)</span>
                                        {c.type === 'FLEX' && c.flexCreditsRemaining != null && (
                                            <div style={{ fontSize: '0.7rem', color: 'var(--accent-primary)' }}>Restantes: {c.flexCreditsRemaining}</div>
                                        )}
                                    </td>
                                    <td style={{ fontWeight: 700, color: 'var(--tier-comercial)' }}>{c.discountPct}%</td>
                                    <td>
                                        {c.paymentMethod ? (
                                            <span className="badge" style={{ fontSize: '0.7rem' }}>
                                                {c.paymentMethod === 'CARTAO' ? '💳 Cartão' : c.paymentMethod === 'PIX' ? '🟢 PIX' : '📄 Boleto'}
                                            </span>
                                        ) : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                                    </td>
                                    <td style={{ fontSize: '0.75rem' }}>{new Date(c.startDate).toLocaleDateString('pt-BR', { timeZone: 'UTC' })} — {new Date(c.endDate).toLocaleDateString('pt-BR', { timeZone: 'UTC' })}</td>
                                    <td>
                                        {c.contractUrl ? (
                                            <a href={c.contractUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent-primary)', fontSize: '0.875rem' }} title="Abrir contrato digital">📄↗</a>
                                        ) : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                                    </td>
                                    <td><span className={`badge badge-${c.status.toLowerCase()}`}>{c.status}</span></td>
                                    <td style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                                        <button className="btn btn-ghost btn-sm" onClick={() => {
                                            setEditContract(c);
                                            setEditForm({ status: c.status, endDate: c.endDate.split('T')[0], flexCreditsRemaining: c.flexCreditsRemaining?.toString() || '', contractUrl: c.contractUrl || '', paymentMethod: c.paymentMethod || '' });
                                            setEditError('');
                                        }}>✏️</button>

                                        {c.status === 'PENDING_CANCELLATION' && (
                                            <>
                                                <button className="btn btn-danger btn-sm" onClick={() => handleResolveCancel(c.id, 'CHARGE_FEE')} title="Aplicar multa de 20%">💸 Cobrar Multa</button>
                                                <button className="btn btn-secondary btn-sm" onClick={() => handleResolveCancel(c.id, 'WAIVE_FEE')} title="Isentar multa">🤝 Isentar</button>
                                            </>
                                        )}

                                        {c.status === 'ACTIVE' && <button className="btn btn-danger btn-sm" onClick={() => handleCancel(c.id)}>✕</button>}
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
                        <h2 className="modal-title">Novo Contrato</h2>
                        {createError && <div className="error-message">{createError}</div>}
                        {createSuccess && <div className="success-message">{createSuccess}</div>}
                        <div className="form-group"><label className="form-label">Cliente</label>
                            <select className="form-select" value={createForm.userId || ''} onChange={e => setCreateForm({ ...createForm, userId: e.target.value })}>
                                <option value="">Selecione</option>
                                {users.filter(u => u.role !== 'ADMIN').map(u => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)}
                            </select>
                        </div>
                        <div className="form-group">
                            <label className="form-label">Nome do Projeto/Contrato</label>
                            <input className="form-input" type="text" value={createForm.name || ''} onChange={e => setCreateForm({ ...createForm, name: e.target.value })} placeholder="Ex: Projeto Verão" />
                        </div>
                        <div className="form-group"><label className="form-label">Tipo</label>
                            <select className="form-select" value={createForm.type} onChange={e => setCreateForm({ ...createForm, type: e.target.value as any })}>
                                <option value="FIXO">📌 Fixo (Recorrente)</option><option value="FLEX">🔄 Flex (Créditos)</option>
                            </select>
                        </div>
                        <div className="form-group"><label className="form-label">Faixa</label>
                            <select className="form-select" value={createForm.tier} onChange={e => setCreateForm({ ...createForm, tier: e.target.value as any })}>
                                <option value="COMERCIAL">🏢 Comercial</option><option value="AUDIENCIA">🎤 Audiência</option><option value="SABADO">🌟 Sábado</option>
                            </select>
                        </div>
                        <div className="form-group">
                            <label className="form-label">Pacote</label>
                            <select className="form-select" value={createForm.durationMonths} onChange={e => setCreateForm({ ...createForm, durationMonths: Number(e.target.value) as 3 | 6 })}>
                                <option value={3}>📦 12 gravações (3 meses · 30% desconto)</option>
                                <option value={6}>📦 24 gravações (6 meses · 40% desconto)</option>
                            </select>
                        </div>
                        <div className="form-group"><label className="form-label">Data de Início</label>
                            <input type="date" className="form-input" value={createForm.startDate} onChange={e => setCreateForm({ ...createForm, startDate: e.target.value })} />
                        </div>
                        <div className="form-group">
                            <label className="form-label">🔗 Link do Contrato Digital</label>
                            <input className="form-input" type="url" placeholder="https://..." value={createForm.contractUrl || ''} onChange={e => setCreateForm({ ...createForm, contractUrl: e.target.value })} />
                        </div>
                        {createForm.type === 'FIXO' && (
                            <>
                                <div className="form-group"><label className="form-label">Dia da Semana</label>
                                    <select className="form-select" value={createForm.fixedDayOfWeek || 1} onChange={e => setCreateForm({ ...createForm, fixedDayOfWeek: Number(e.target.value) })}>
                                        {['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'].map((d, i) => <option key={i} value={i + 1}>{d}</option>)}
                                    </select>
                                </div>
                                <div className="form-group"><label className="form-label">Horário</label>
                                    <input type="time" className="form-input" value={createForm.fixedTime || '14:00'} onChange={e => setCreateForm({ ...createForm, fixedTime: e.target.value })} />
                                </div>
                            </>
                        )}

                        {/* Flex Rules Info */}
                        {createForm.type === 'FLEX' && (
                            <div style={{ padding: '12px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)', fontSize: '0.8125rem', color: 'var(--text-secondary)', marginTop: '4px' }}>
                                <div style={{ fontWeight: 700, marginBottom: '6px', color: 'var(--accent-primary)' }}>ℹ️ Regras do Plano Flex</div>
                                <ul style={{ margin: 0, paddingLeft: '16px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                    <li>Consumo: mínimo 1 gravação/semana (use ou perca)</li>
                                    <li>Adiantamento livre: pode usar todos os créditos de uma vez</li>
                                    <li>Compensação: gravações adiantadas compensam semanas futuras</li>
                                </ul>
                            </div>
                        )}

                        <div className="modal-actions">
                            <button className="btn btn-secondary" onClick={() => setShowCreate(false)}>Cancelar</button>
                            <button className="btn btn-primary" onClick={handleCreate} disabled={!createForm.userId || !createForm.name?.trim()}>🚀 Criar</button>
                        </div>
                    </div>
                </div>
            )}

            {/* Edit Modal */}
            {editContract && (
                <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setEditContract(null)}>
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
                            <label className="form-label">🔗 Link do Contrato Digital</label>
                            <input className="form-input" type="url" placeholder="https://..." value={editForm.contractUrl} onChange={e => setEditForm({ ...editForm, contractUrl: e.target.value })} />
                        </div>
                        <div className="form-group">
                            <label className="form-label">💳 Forma de Pagamento</label>
                            <select className="form-select" value={editForm.paymentMethod} onChange={e => setEditForm({ ...editForm, paymentMethod: e.target.value })}>
                                <option value="">-- Não definido --</option>
                                <option value="CARTAO">💳 Cartão de Crédito</option>
                                <option value="PIX">🟢 PIX</option>
                                <option value="BOLETO">📄 Boleto Mensal</option>
                            </select>
                        </div>
                        <div className="modal-actions">
                            <button className="btn btn-secondary" onClick={() => setEditContract(null)}>Cancelar</button>
                            <button className="btn btn-primary" onClick={handleEdit}>💾 Salvar</button>
                        </div>
                    </div>
                </div>
            )}

            {/* Conflict Resolution Modal */}
            {showConflictModal && (
                <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setShowConflictModal(false)}>
                    <div className="modal" style={{ maxWidth: 600 }}>
                        <div style={{ textAlign: 'center', marginBottom: '20px' }}>
                            <div style={{ fontSize: '2.5rem', marginBottom: '8px' }}>⚠️</div>
                            <h3 style={{ fontSize: '1.25rem', color: '#ef4444' }}>Conflitos de Agenda</h3>
                            <p style={{ color: 'var(--text-muted)' }}>Alguns dias projetados já possuem outras gravações em andamento.</p>
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
                                                    <span>💡 Auto-Substituição:</span>
                                                    <span style={{ background: 'rgba(34, 197, 94, 0.1)', color: '#22c55e', padding: '4px 8px', borderRadius: '4px', fontWeight: 600 }}>
                                                        {c.suggestedReplacement.time} no mesmo dia
                                                    </span>
                                                </div>
                                            ) : (
                                                <div style={{ fontSize: '0.8125rem', color: '#f59e0b', display: 'flex', alignItems: 'center', gap: '8px' }}>
                                                    <span>⚠️ Dia completamente lotado para a faixa. Remanejamento no fim do ciclo.</span>
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
                                ✅ Forçar Criação e Aplicar Sugestões
                            </button>
                            <button className="btn btn-secondary" style={{ width: '100%', padding: '14px' }}
                                onClick={() => setShowConflictModal(false)}>
                                ⬅ Cancelar e voltar para escolhas
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Cancel (Force) Modal */}
            {showCancelModalFor && (
                <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setShowCancelModalFor(null)}>
                    <div className="modal" style={{ maxWidth: 400 }}>
                        <div style={{ textAlign: 'center', marginBottom: '20px' }}>
                            <div style={{ fontSize: '3rem', marginBottom: '10px' }}>🛑</div>
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
                </div>
            )}

            {/* Resolve Cancellation Modal */}
            {showResolveModalFor && (
                <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setShowResolveModalFor(null)}>
                    <div className="modal" style={{ maxWidth: 400 }}>
                        <div style={{ textAlign: 'center', marginBottom: '20px' }}>
                            <div style={{ fontSize: '3rem', marginBottom: '10px' }}>
                                {showResolveModalFor.action === 'CHARGE_FEE' ? '💸' : '🤝'}
                            </div>
                            <h2 style={{ fontSize: '1.25rem', fontWeight: 700 }}>
                                {showResolveModalFor.action === 'CHARGE_FEE' ? 'Aplicar Multa' : 'Isentar Multa'}
                            </h2>
                        </div>
                        <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginBottom: '24px', lineHeight: 1.5, textAlign: 'center' }}>
                            {showResolveModalFor.action === 'CHARGE_FEE'
                                ? 'Tem certeza que deseja quebrar o contrato aplicando a MULTA INTEGRAL DE 20% sobre o restante?'
                                : 'Tem certeza que deseja ISENTAR a multa e aceitar o cancelamento de modo amigável?'}
                        </p>
                        <div className="modal-actions">
                            <button className="btn btn-secondary" onClick={() => setShowResolveModalFor(null)} style={{ flex: 1 }}>Voltar</button>
                            <button className={showResolveModalFor.action === 'CHARGE_FEE' ? "btn btn-danger" : "btn btn-primary"} onClick={confirmResolveCancel} style={{ flex: 1 }}>
                                Confirmar Ação
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

import { getErrorMessage } from '../../../utils/errors';
import React, { useState, useEffect } from 'react';
import { usersApi, UserSummary, ApiError } from '../../../api/client';
import BottomSheetModal from '../../BottomSheetModal';
import { Pencil, UserRound, Mail, Lock, Smartphone, IdCard, Globe, MapPin, Building2, Map, NotebookPen, ShieldCheck, Save } from 'lucide-react';
import { maskPhone, maskCpfCnpj, maskEmail, translateError } from '../../../utils/mask';

interface EditClientModalProps {
    user: UserSummary;
    onClose: () => void;
    onSaved: () => void;
}

export default function EditClientModal({ user, onClose, onSaved }: EditClientModalProps) {
    const [editForm, setEditForm] = useState({
        name: '', email: '', phone: '', role: '', password: '',
        notes: '', cpfCnpj: '', address: '', city: '', state: '',
        socialLinks: '', clientStatus: 'ACTIVE',
    });
    const [editError, setEditError] = useState('');
    const [editFieldErrors, setEditFieldErrors] = useState<Record<string, string>>({});
    const [editLoading, setEditLoading] = useState(false);
    // Start true so the very first paint shows the loading spinner (matching the
    // original, where seed + fetching=true were set synchronously before paint).
    const [editFetching, setEditFetching] = useState(true);

    useEffect(() => {
        let cancelled = false;
        setEditForm({
            name: user.name, email: user.email, phone: maskPhone(user.phone || ''), role: user.role, password: '',
            notes: '', cpfCnpj: '', address: '', city: '', state: '', socialLinks: '', clientStatus: user.clientStatus || 'ACTIVE',
        });
        setEditError('');
        setEditFieldErrors({});
        setEditFetching(true);
        (async () => {
            try {
                const res = await usersApi.getById(user.id);
                const d = res.user;
                if (cancelled) return;
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
            finally { if (!cancelled) setEditFetching(false); }
        })();
        return () => { cancelled = true; };
    }, [user]);

    const handleEdit = async () => {
        if (!user) return;
        setEditError('');
        setEditFieldErrors({});
        setEditLoading(true);
        try {
            const data: any = {};
            if (editForm.name && editForm.name !== user.name) data.name = editForm.name;
            if (editForm.email && editForm.email !== user.email) data.email = editForm.email;
            if (editForm.phone.replace(/\D/g, '') !== (user.phone || '')) data.phone = editForm.phone.replace(/\D/g, '');
            if (editForm.role && editForm.role !== user.role) data.role = editForm.role;
            if (editForm.password) data.password = editForm.password;
            if (editForm.clientStatus) data.clientStatus = editForm.clientStatus;
            // Optional text fields — send if changed (compare to empty for summary-level data)
            data.notes = editForm.notes || null;
            data.cpfCnpj = editForm.cpfCnpj.replace(/\D/g, '') || null;
            data.address = editForm.address || null;
            data.city = editForm.city || null;
            data.state = editForm.state || null;
            data.socialLinks = editForm.socialLinks || null;
            await usersApi.update(user.id, data);
            onClose();
            onSaved();
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
        fontSize: '0.6875rem', color: 'var(--danger)', fontWeight: 600, marginTop: '4px', paddingLeft: '4px',
    };

    return (
        <BottomSheetModal isOpen onClose={onClose} hideHeader size="md" className="admin-sheet" title="Editar Cliente">
                {/* --- HEADER --- */}
                <div style={{ padding: '28px 32px 0', borderBottom: 'none' }}>
                    <h2 style={{ fontSize: '1.25rem', fontWeight: 800, margin: 0, display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <span style={{
                            width: 36, height: 36, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center',
                            background: 'var(--accent-gradient-go)', fontSize: '1rem'
                        }}><Pencil size={18} aria-hidden="true" style={{ color: '#fff' }} /></span>
                        Editar Cliente
                    </h2>
                    <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '6px', marginBottom: 0 }}>
                        Atualize as informações de <strong style={{ color: 'var(--text-primary)' }}>{user.name}</strong>
                    </p>
                </div>

                {editError && Object.keys(editFieldErrors).length === 0 && (
                    <div style={{ margin: '16px 32px 0', padding: '10px 14px', borderRadius: '10px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.15)', color: 'var(--danger)', fontSize: '0.8125rem', fontWeight: 600 }}>{editError}</div>
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
                        <div className="admin-grid-2" style={{ gap: '12px', marginBottom: '12px' }}>
                            <div>
                                <label style={editLabelStyle}>Nome *</label>
                                <div style={{ position: 'relative' }}>
                                    <UserRound size={14} aria-hidden="true" style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none', opacity: 0.7 }} />
                                    <input
                                        value={editForm.name} onChange={e => setEditForm({ ...editForm, name: e.target.value })}
                                        placeholder="Nome completo"
                                        style={editInputStyle(!!editFieldErrors.name)}
                                        onBlur={e => (e.currentTarget.style.borderColor = editFieldErrors.name ? 'rgba(239,68,68,0.5)' : 'var(--border-default)')}
                                    />
                                </div>
                                {editFieldErrors.name && <div style={editFieldErrorStyle}>{translateError(editFieldErrors.name)}</div>}
                            </div>
                            <div>
                                <label style={editLabelStyle}>CPF / CNPJ</label>
                                <div style={{ position: 'relative' }}>
                                    <IdCard size={14} aria-hidden="true" style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none', opacity: 0.7 }} />
                                    <input
                                        value={editForm.cpfCnpj} onChange={e => setEditForm({ ...editForm, cpfCnpj: maskCpfCnpj(e.target.value) })}
                                        placeholder="000.000.000-00"
                                        style={editInputStyle(false)}
                                        onBlur={e => (e.currentTarget.style.borderColor = 'var(--border-default)')}
                                    />
                                </div>
                            </div>
                        </div>

                        {/* Status toggle */}
                        <div>
                            <label style={editLabelStyle}>Status</label>
                            <div style={{ display: 'flex', gap: '4px' }}>
                                {[{ key: 'ACTIVE', label: 'Ativo', color: 'var(--success)' }, { key: 'INACTIVE', label: 'Inativo', color: '#6b7280' }, { key: 'BLOCKED', label: 'Bloqueado', color: 'var(--danger)' }].map(s => (
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
                                {[{ key: 'CLIENTE', icon: UserRound, label: 'Cliente', desc: 'Acesso ao painel do cliente' }, { key: 'ADMIN', icon: ShieldCheck, label: 'Admin', desc: 'Acesso total ao sistema' }].map(r => (
                                    <button key={r.key}
                                        onClick={() => setEditForm({ ...editForm, role: r.key })}
                                        style={{
                                            flex: 1, padding: '10px 14px', borderRadius: '10px', cursor: 'pointer',
                                            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px',
                                            background: editForm.role === r.key ? 'rgba(16,185,129,0.1)' : 'var(--bg-elevated)',
                                            border: `1px solid ${editForm.role === r.key ? 'rgba(16,185,129,0.3)' : 'var(--border-default)'}`,
                                            transition: 'all 0.15s',
                                        }}>
                                        <span style={{ fontSize: '0.8125rem', fontWeight: 700, color: editForm.role === r.key ? '#10b981' : 'var(--text-primary)', display: 'inline-flex', alignItems: 'center', gap: 5 }}>{(() => { const RI = r.icon; return <RI size={14} aria-hidden="true" />; })()} {r.label}</span>
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
                        <div className="admin-grid-2" style={{ gap: '12px', marginBottom: '12px' }}>
                            <div>
                                <label style={editLabelStyle}>E-mail *</label>
                                <div style={{ position: 'relative' }}>
                                    <Mail size={14} aria-hidden="true" style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none', opacity: 0.7 }} />
                                    <input
                                        type="email" value={editForm.email}
                                        onChange={e => setEditForm({ ...editForm, email: maskEmail(e.target.value) })}
                                        placeholder="email@exemplo.com"
                                        style={editInputStyle(!!editFieldErrors.email)}
                                        onBlur={e => (e.currentTarget.style.borderColor = editFieldErrors.email ? 'rgba(239,68,68,0.5)' : 'var(--border-default)')}
                                    />
                                </div>
                                {editFieldErrors.email && <div style={editFieldErrorStyle}>{translateError(editFieldErrors.email)}</div>}
                            </div>
                            <div>
                                <label style={editLabelStyle}>Telefone</label>
                                <div style={{ position: 'relative' }}>
                                    <Smartphone size={14} aria-hidden="true" style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none', opacity: 0.7 }} />
                                    <input
                                        value={editForm.phone}
                                        onChange={e => setEditForm({ ...editForm, phone: maskPhone(e.target.value) })}
                                        placeholder="(21) 99999-9999"
                                        style={editInputStyle(!!editFieldErrors.phone)}
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
                                <Globe size={14} aria-hidden="true" style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none', opacity: 0.7 }} />
                                <input
                                    value={editForm.socialLinks}
                                    onChange={e => setEditForm({ ...editForm, socialLinks: e.target.value })}
                                    placeholder="Instagram, YouTube, TikTok..."
                                    style={editInputStyle(false)}
                                    onBlur={e => (e.currentTarget.style.borderColor = 'var(--border-default)')}
                                />
                            </div>
                        </div>

                        {/* Address row */}
                        <div style={{ marginBottom: '12px' }}>
                            <label style={editLabelStyle}>Endereço</label>
                            <div style={{ position: 'relative' }}>
                                <MapPin size={14} aria-hidden="true" style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none', opacity: 0.7 }} />
                                <input
                                    value={editForm.address}
                                    onChange={e => setEditForm({ ...editForm, address: e.target.value })}
                                    placeholder="Rua, número, complemento"
                                    style={editInputStyle(false)}
                                    onBlur={e => (e.currentTarget.style.borderColor = 'var(--border-default)')}
                                />
                            </div>
                        </div>

                        {/* City + State */}
                        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '12px' }}>
                            <div>
                                <label style={editLabelStyle}>Cidade</label>
                                <div style={{ position: 'relative' }}>
                                    <Building2 size={14} aria-hidden="true" style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none', opacity: 0.7 }} />
                                    <input
                                        value={editForm.city}
                                        onChange={e => setEditForm({ ...editForm, city: e.target.value })}
                                        placeholder="Rio de Janeiro"
                                        style={editInputStyle(false)}
                                        onBlur={e => (e.currentTarget.style.borderColor = 'var(--border-default)')}
                                    />
                                </div>
                            </div>
                            <div>
                                <label style={editLabelStyle}>UF</label>
                                <div style={{ position: 'relative' }}>
                                    <Map size={14} aria-hidden="true" style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none', opacity: 0.7 }} />
                                    <input
                                        value={editForm.state}
                                        onChange={e => setEditForm({ ...editForm, state: e.target.value })}
                                        placeholder="RJ" maxLength={2}
                                        style={{ ...editInputStyle(false), textTransform: 'uppercase' as any }}
                                        onBlur={e => (e.currentTarget.style.borderColor = 'var(--border-default)')}
                                    />
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* --- SECTION 3: Segurança & Notas --- */}
                    <div style={{ marginBottom: '18px' }}>
                        <div style={{ fontSize: '0.625rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: '14px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <span style={{ width: 18, height: 18, borderRadius: '50%', background: 'rgba(45,212,191,0.15)', color: 'var(--accent-text)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.5rem', fontWeight: 800 }}>3</span>
                            <span style={{ fontSize: '0.6875rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Segurança & Notas</span>
                            <span style={{ fontSize: '0.5625rem', color: 'var(--text-muted)', fontWeight: 500, textTransform: 'none', letterSpacing: '0' }}>(opcional)</span>
                        </div>

                        <div style={{ padding: '16px', borderRadius: '10px', background: 'rgba(45,212,191,0.03)', border: '1px solid rgba(45,212,191,0.08)' }}>
                            {/* Password */}
                            <div style={{ marginBottom: '12px' }}>
                                <label style={editLabelStyle}>Nova Senha <span style={{ fontWeight: 500, textTransform: 'none', letterSpacing: 0, color: 'var(--text-muted)' }}>(vazio = manter atual)</span></label>
                                <div style={{ position: 'relative' }}>
                                    <Lock size={14} aria-hidden="true" style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none', opacity: 0.7 }} />
                                    <input
                                        type="password" value={editForm.password}
                                        onChange={e => setEditForm({ ...editForm, password: e.target.value })}
                                        placeholder="Mínimo 6 caracteres"
                                        style={editInputStyle(!!editFieldErrors.password)}
                                        onBlur={e => (e.currentTarget.style.borderColor = editFieldErrors.password ? 'rgba(239,68,68,0.5)' : 'var(--border-default)')}
                                    />
                                </div>
                                {editFieldErrors.password && <div style={editFieldErrorStyle}>{translateError(editFieldErrors.password)}</div>}
                            </div>

                            {/* Notes */}
                            <div>
                                <label style={editLabelStyle}><NotebookPen size={12} aria-hidden="true" style={{ verticalAlign: '-2px' }} /> Notas internas</label>
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
                        <button onClick={onClose}
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
                            {editLoading ? 'Salvando...' : <><Save size={16} aria-hidden="true" /> Salvar Alterações</>}
                        </button>
                    </div>
                </div>
                )}
        </BottomSheetModal>
    );
}

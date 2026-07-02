import { getErrorMessage } from '../../../utils/errors';
import React, { useState } from 'react';
import { usersApi, ApiError } from '../../../api/client';
import BottomSheetModal from '../../BottomSheetModal';
import { maskPhone, maskEmail, maskCpfCnpj, translateError } from '../../../utils/mask';

interface CreateClientModalProps {
    isOpen: boolean;
    onClose: () => void;
    onCreated: () => void;
}

export default function CreateClientModal({ isOpen, onClose, onCreated }: CreateClientModalProps) {
    const [createForm, setCreateForm] = useState({ name: '', email: '', phone: '', password: '', role: 'CLIENTE', notes: '', cpfCnpj: '', socialLinks: '', clientStatus: 'ACTIVE' });
    const [createError, setCreateError] = useState('');
    const [createFieldErrors, setCreateFieldErrors] = useState<Record<string, string>>({});
    const [showAdvanced, setShowAdvanced] = useState(false);
    const [creating, setCreating] = useState(false);

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
            onCreated();
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
        onClose();
        setCreateForm({ name: '', email: '', phone: '', password: '', role: 'CLIENTE', notes: '', cpfCnpj: '', socialLinks: '', clientStatus: 'ACTIVE' });
        setCreateError('');
        setCreateFieldErrors({});
        setShowAdvanced(false);
    };

    if (!isOpen) return null;

    const labelStyle = {
        fontSize: '0.6875rem', fontWeight: 700, color: 'var(--text-muted)',
        textTransform: 'uppercase' as const, letterSpacing: '0.1em', marginBottom: '6px', display: 'block',
    };

    const fieldErrorStyle = {
        fontSize: '0.6875rem', color: 'var(--danger)', fontWeight: 600, marginTop: '4px', paddingLeft: '4px',
    };

    const canCreate = createForm.name.length >= 2 && createForm.email.includes('@') && createForm.password.length >= 6;

    return (
        <BottomSheetModal isOpen onClose={resetCreateModal} hideHeader size="md" className="admin-sheet" title="Novo Cliente">
                {/* --- HEADER --- */}
                <div style={{ padding: '28px 32px 0', borderBottom: 'none' }}>
                    <h2 style={{ fontSize: '1.25rem', fontWeight: 800, margin: 0, display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <span style={{
                            width: 36, height: 36, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center',
                            background: 'var(--accent-gradient-go)', fontSize: '1rem'
                        }}>➕</span>
                        Novo Cliente
                    </h2>
                    <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '6px', marginBottom: 0 }}>
                        Cadastre um novo cliente no sistema do estúdio
                    </p>
                </div>

                <div style={{ padding: '20px 32px 28px' }}>
                    {createError && Object.keys(createFieldErrors).length === 0 && (
                        <div style={{ marginBottom: '16px', padding: '10px 14px', borderRadius: '10px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.15)', color: 'var(--danger)', fontSize: '0.8125rem', fontWeight: 600 }}>{createError}</div>
                    )}

                    {/* --- SECTION 1: Dados Essenciais --- */}
                    <div style={{ marginBottom: '20px' }}>
                        <div style={{ fontSize: '0.625rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: '14px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <span style={{ width: 18, height: 18, borderRadius: '50%', background: '#10b981', color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.5rem', fontWeight: 800 }}>1</span>
                            Dados Essenciais
                        </div>

                        {/* Name + Email row */}
                        <div className="admin-grid-2" style={{ gap: '12px', marginBottom: '12px' }}>
                            <div>
                                <label style={labelStyle}>Nome *</label>
                                <div style={{ position: 'relative' }}>
                                    <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: '0.75rem', opacity: 0.5 }}>👤</span>
                                    <input
                                        value={createForm.name} onChange={e => setCreateForm({ ...createForm, name: e.target.value })}
                                        placeholder="Nome completo" autoFocus
                                        className={`form-input form-input--raised${(!!createFieldErrors.name) ? ' error' : ''}`} style={{ paddingLeft: 36, fontSize: '0.8125rem' }}
                                        onBlur={e => (e.currentTarget.style.borderColor = createFieldErrors.name ? 'rgba(239,68,68,0.5)' : 'var(--border-default)')}
                                    />
                                </div>
                                {createFieldErrors.name && <div style={fieldErrorStyle}>{translateError(createFieldErrors.name)}</div>}
                            </div>
                            <div>
                                <label style={labelStyle}>E-mail *</label>
                                <div style={{ position: 'relative' }}>
                                    <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: '0.75rem', opacity: 0.5 }}>📧</span>
                                    <input
                                        type="email" value={createForm.email}
                                        onChange={e => setCreateForm({ ...createForm, email: maskEmail(e.target.value) })}
                                        placeholder="email@exemplo.com"
                                        className={`form-input form-input--raised${(!!createFieldErrors.email) ? ' error' : ''}`} style={{ paddingLeft: 36, fontSize: '0.8125rem' }}
                                        onBlur={e => (e.currentTarget.style.borderColor = createFieldErrors.email ? 'rgba(239,68,68,0.5)' : 'var(--border-default)')}
                                    />
                                </div>
                                {createFieldErrors.email && <div style={fieldErrorStyle}>{translateError(createFieldErrors.email)}</div>}
                            </div>
                        </div>

                        {/* Password + Phone row */}
                        <div className="admin-grid-2" style={{ gap: '12px' }}>
                            <div>
                                <label style={labelStyle}>Senha *</label>
                                <div style={{ position: 'relative' }}>
                                    <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: '0.75rem', opacity: 0.5 }}>🔒</span>
                                    <input
                                        type="password" value={createForm.password}
                                        onChange={e => setCreateForm({ ...createForm, password: e.target.value })}
                                        placeholder="Mínimo 6 caracteres"
                                        className={`form-input form-input--raised${(!!createFieldErrors.password) ? ' error' : ''}`} style={{ paddingLeft: 36, fontSize: '0.8125rem' }}
                                        onBlur={e => (e.currentTarget.style.borderColor = createFieldErrors.password ? 'rgba(239,68,68,0.5)' : 'var(--border-default)')}
                                    />
                                </div>
                                {createFieldErrors.password && <div style={fieldErrorStyle}>{translateError(createFieldErrors.password)}</div>}
                            </div>
                            <div>
                                <label style={labelStyle}>Telefone</label>
                                <div style={{ position: 'relative' }}>
                                    <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: '0.75rem', opacity: 0.5 }}>📱</span>
                                    <input
                                        value={createForm.phone}
                                        onChange={e => setCreateForm({ ...createForm, phone: maskPhone(e.target.value) })}
                                        placeholder="(21) 99999-9999"
                                        className={`form-input form-input--raised${(!!createFieldErrors.phone) ? ' error' : ''}`} style={{ paddingLeft: 36, fontSize: '0.8125rem' }}
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
                                {[{ key: 'CLIENTE', label: '👤 Cliente', desc: 'Acesso ao painel do cliente' }, { key: 'ADMIN', label: '🛡️ Admin', desc: 'Acesso total ao sistema' }].map(r => (
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
                                <span style={{ width: 18, height: 18, borderRadius: '50%', background: 'rgba(45,212,191,0.15)', color: 'var(--accent-text)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.5rem', fontWeight: 800 }}>2</span>
                                <span style={{ fontSize: '0.6875rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Dados Adicionais</span>
                                <span style={{ fontSize: '0.5625rem', color: 'var(--text-muted)', fontWeight: 500, textTransform: 'none', letterSpacing: '0' }}>(opcional)</span>
                            </span>
                            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', transition: 'transform 0.2s', transform: showAdvanced ? 'rotate(180deg)' : 'rotate(0)' }}>▼</span>
                        </button>

                        {showAdvanced && (
                            <div style={{ marginTop: '12px', padding: '16px', borderRadius: '10px', background: 'rgba(45,212,191,0.03)', border: '1px solid rgba(45,212,191,0.08)' }}>
                                {/* CPF/CNPJ + Status */}
                                <div className="admin-grid-2" style={{ gap: '12px', marginBottom: '12px' }}>
                                    <div>
                                        <label style={labelStyle}>CPF/CNPJ</label>
                                        <div style={{ position: 'relative' }}>
                                            <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: '0.75rem', opacity: 0.5 }}>🪪</span>
                                            <input
                                                value={createForm.cpfCnpj}
                                                onChange={e => setCreateForm({ ...createForm, cpfCnpj: maskCpfCnpj(e.target.value) })}
                                                placeholder="000.000.000-00"
                                                className={`form-input form-input--raised${(false) ? ' error' : ''}`} style={{ paddingLeft: 36, fontSize: '0.8125rem' }}
                                                onBlur={e => (e.currentTarget.style.borderColor = 'var(--border-default)')}
                                            />
                                        </div>
                                    </div>
                                    <div>
                                        <label style={labelStyle}>Status</label>
                                        <div style={{ display: 'flex', gap: '4px' }}>
                                            {[{ key: 'ACTIVE', label: 'Ativo', color: 'var(--success)' }, { key: 'INACTIVE', label: 'Inativo', color: '#6b7280' }, { key: 'BLOCKED', label: 'Bloqueado', color: 'var(--danger)' }].map(s => (
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
                                        <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: '0.75rem', opacity: 0.5 }}>🌐</span>
                                        <input
                                            value={createForm.socialLinks}
                                            onChange={e => setCreateForm({ ...createForm, socialLinks: e.target.value })}
                                            placeholder="Instagram, YouTube, TikTok..."
                                            className={`form-input form-input--raised${(false) ? ' error' : ''}`} style={{ paddingLeft: 36, fontSize: '0.8125rem' }}
                                            onBlur={e => (e.currentTarget.style.borderColor = 'var(--border-default)')}
                                        />
                                    </div>
                                </div>

                                {/* Notes */}
                                <div>
                                    <label style={labelStyle}>📝 Notas internas</label>
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
                            {creating ? '⏳ Criando...' : '➕ Cadastrar Cliente'}
                        </button>
                    </div>
                </div>
        </BottomSheetModal>
    );
}

import { getErrorMessage } from '../../../utils/errors';
import React, { useState, useEffect } from 'react';
import { couponsApi, usersApi, ApiError, Coupon, CouponInput, CouponUserRef, UserSummary } from '../../../api/client';
import { useUI } from '../../../context/UIContext';
import BottomSheetModal from '../../BottomSheetModal';

type Eligibility = 'ALL' | 'SPECIFIC' | 'NEW';

interface CouponModalProps {
    /** Cupom em edição; omitir/null = criação */
    coupon?: Coupon | null;
    onClose: () => void;
    onSaved: () => void;
}

/** Converte texto em reais ("49,90") para centavos. */
function parseReais(text: string): number {
    return Math.round(parseFloat(text.replace(',', '.')) * 100) || 0;
}

/** Formata centavos como texto em reais editável ("49,90"). */
function centsToText(cents: number): string {
    return (cents / 100).toFixed(2).replace('.', ',');
}

export default function CouponModal({ coupon, onClose, onSaved }: CouponModalProps) {
    const { showToast } = useUI();
    const isEdit = !!coupon;

    // ─── Form state ───
    const [code, setCode] = useState(coupon?.code || '');
    const [description, setDescription] = useState(coupon?.description || '');
    const [discountType, setDiscountType] = useState<'VALOR' | 'PERCENTUAL'>(coupon?.discountType || 'VALOR');
    const [valueText, setValueText] = useState(() =>
        coupon ? (coupon.discountType === 'VALOR' ? centsToText(coupon.discountValue) : String(coupon.discountValue)) : ''
    );
    const [scope, setScope] = useState<'FIRST_PAYMENT' | 'ALL_INSTALLMENTS'>(coupon?.scope || 'FIRST_PAYMENT');
    const [expiresAt, setExpiresAt] = useState(coupon?.expiresAt ? coupon.expiresAt.slice(0, 10) : '');
    const [maxUses, setMaxUses] = useState(coupon?.maxUses != null ? String(coupon.maxUses) : '');
    const [maxUsesPerUser, setMaxUsesPerUser] = useState(coupon?.maxUsesPerUser != null ? String(coupon.maxUsesPerUser) : '');
    const [minAmountText, setMinAmountText] = useState(coupon?.minAmount != null ? centsToText(coupon.minAmount) : '');
    const [active, setActive] = useState(coupon?.active ?? true);
    const [eligibility, setEligibility] = useState<Eligibility>(
        coupon?.onlyNewClients ? 'NEW' : (coupon?.eligibleUsers?.length ? 'SPECIFIC' : 'ALL')
    );
    const [selectedUsers, setSelectedUsers] = useState<CouponUserRef[]>(coupon?.eligibleUsers || []);

    // ─── Client picker (lazy: só carrega quando "clientes específicos" é escolhido) ───
    const [clients, setClients] = useState<UserSummary[]>([]);
    const [clientsLoaded, setClientsLoaded] = useState(false);
    const [clientSearch, setClientSearch] = useState('');
    useEffect(() => {
        if (eligibility !== 'SPECIFIC' || clientsLoaded) return;
        setClientsLoaded(true);
        usersApi.getAll('CLIENTE').then(r => setClients(r.users)).catch(() => {});
    }, [eligibility, clientsLoaded]);

    const [saving, setSaving] = useState(false);
    const [apiError, setApiError] = useState('');
    const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

    // ─── Styles (padrão CreateContractModal / CreateClientModal) ───
    const inputStyle = (hasError = false, withIcon = true) => ({
        width: '100%', padding: withIcon ? '10px 14px 10px 36px' : '10px 14px', borderRadius: '10px', fontSize: '0.8125rem',
        background: 'var(--bg-elevated)', border: `1px solid ${hasError ? 'rgba(239,68,68,0.5)' : 'var(--border-default)'}`,
        color: 'var(--text-primary)', outline: 'none', fontFamily: 'inherit', transition: 'border-color 0.2s',
    } as React.CSSProperties);

    const labelStyle = {
        fontSize: '0.6875rem', fontWeight: 700, color: 'var(--text-muted)',
        textTransform: 'uppercase' as const, letterSpacing: '0.1em', marginBottom: '6px', display: 'block',
    };

    const hintStyle = { fontSize: '0.625rem', color: 'var(--text-muted)', marginTop: '4px', lineHeight: 1.4 };

    const fieldErrorStyle = {
        fontSize: '0.6875rem', color: '#ef4444', fontWeight: 600, marginTop: '4px', paddingLeft: '4px',
    };

    const sectionHeader = (num: number, text: string, color: string) => (
        <div style={{ fontSize: '0.625rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: '14px', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ width: 18, height: 18, borderRadius: '50%', background: color, color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.5rem', fontWeight: 800 }}>{num}</span>
            {text}
        </div>
    );

    // ─── Validação local field-by-field ───
    const validate = (): Record<string, string> => {
        const errs: Record<string, string> = {};
        if (!isEdit && code.trim().length < 3) errs.code = 'O código precisa de pelo menos 3 caracteres.';
        const value = discountType === 'VALOR' ? parseReais(valueText) : (parseInt(valueText, 10) || 0);
        if (value <= 0) errs.discountValue = 'Informe um desconto maior que zero.';
        else if (discountType === 'PERCENTUAL' && value > 100) errs.discountValue = 'O percentual não pode passar de 100%.';
        if (eligibility === 'SPECIFIC' && selectedUsers.length === 0) errs.eligibility = 'Selecione pelo menos um cliente.';
        return errs;
    };

    const handleSave = async () => {
        setApiError('');
        const errs = validate();
        setFieldErrors(errs);
        if (Object.keys(errs).length > 0) return;
        setSaving(true);
        try {
            const base: Omit<CouponInput, 'code'> = {
                description: description.trim() ? description.trim() : null,
                discountType,
                discountValue: discountType === 'VALOR' ? parseReais(valueText) : parseInt(valueText, 10),
                scope,
                expiresAt: expiresAt || null,               // 'YYYY-MM-DD' puro — nunca new Date local
                maxUses: maxUses.trim() ? parseInt(maxUses, 10) : null,
                maxUsesPerUser: maxUsesPerUser.trim() ? parseInt(maxUsesPerUser, 10) : null,
                minAmount: minAmountText.trim() ? parseReais(minAmountText) : null,
                onlyNewClients: eligibility === 'NEW',
                eligibleUserIds: eligibility === 'SPECIFIC' ? selectedUsers.map(u => u.id) : [],
                active,
            };
            if (isEdit) {
                await couponsApi.update(coupon!.id, base);
                showToast('Cupom atualizado.');
            } else {
                await couponsApi.create({ code: code.trim(), ...base });
                showToast('Cupom criado!');
            }
            onSaved();
            onClose();
        } catch (err: unknown) {
            if (err instanceof Error && err.name === 'ApiError') {
                const apiErr = err as ApiError;
                if (apiErr.details && Array.isArray(apiErr.details)) {
                    const mapped: Record<string, string> = {};
                    apiErr.details.forEach((issue: any) => { mapped[issue.path.join('.')] = issue.message; });
                    setFieldErrors(mapped);
                }
                setApiError(apiErr.message);
            } else {
                setApiError(getErrorMessage(err));
            }
        } finally { setSaving(false); }
    };

    const toggleUser = (u: UserSummary) => {
        setSelectedUsers(prev => prev.some(s => s.id === u.id)
            ? prev.filter(s => s.id !== u.id)
            : [...prev, { id: u.id, name: u.name, email: u.email }]);
    };

    const filteredClients = clients.filter(u => {
        const q = clientSearch.trim().toLowerCase();
        if (!q) return true;
        return u.name.toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q);
    });

    const canSave = (isEdit || code.trim().length >= 3) && valueText.trim().length > 0;

    return (
        <BottomSheetModal isOpen onClose={onClose} hideHeader maxWidth="580px" className="admin-sheet" title={isEdit ? 'Editar Cupom' : 'Novo Cupom'}>
            {/* --- HEADER --- */}
            <div style={{ padding: '28px 32px 0' }}>
                <h2 style={{ fontSize: '1.25rem', fontWeight: 800, margin: 0, display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <span style={{ width: 36, height: 36, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'linear-gradient(135deg, #818cf8, #6366f1)', fontSize: '1rem' }}>🎟️</span>
                    {isEdit ? 'Editar Cupom' : 'Novo Cupom'}
                </h2>
                <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '6px', marginBottom: 0 }}>
                    {isEdit ? `Ajuste as regras do cupom ${coupon!.code}` : 'Crie um cupom de desconto para pagamentos'}
                </p>
            </div>

            <div style={{ padding: '20px 32px 28px' }}>
                {apiError && (
                    <div style={{ marginBottom: '16px', padding: '10px 14px', borderRadius: '10px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.15)', color: '#ef4444', fontSize: '0.8125rem', fontWeight: 600 }}>{apiError}</div>
                )}

                {/* --- SEÇÃO 1: Identificação --- */}
                <div style={{ marginBottom: '20px' }}>
                    {sectionHeader(1, 'Identificação', '#10b981')}

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                        <div>
                            <label style={labelStyle}>Código *</label>
                            <div style={{ position: 'relative' }}>
                                <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: '0.75rem', opacity: 0.5 }}>🎟️</span>
                                <input
                                    value={code}
                                    onChange={e => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, ''))}
                                    placeholder="Ex: BEMVINDO10"
                                    disabled={isEdit}
                                    autoFocus={!isEdit}
                                    style={{ ...inputStyle(!!fieldErrors.code), fontFamily: 'monospace', fontWeight: 700, letterSpacing: '0.08em', opacity: isEdit ? 0.6 : 1, cursor: isEdit ? 'not-allowed' : 'text' }}
                                    onFocus={e => (e.currentTarget.style.borderColor = '#10b981')}
                                    onBlur={e => (e.currentTarget.style.borderColor = fieldErrors.code ? 'rgba(239,68,68,0.5)' : 'var(--border-default)')}
                                />
                            </div>
                            {fieldErrors.code && <div style={fieldErrorStyle}>{fieldErrors.code}</div>}
                        </div>
                        <div>
                            <label style={labelStyle}>Descrição</label>
                            <div style={{ position: 'relative' }}>
                                <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: '0.75rem', opacity: 0.5 }}>📝</span>
                                <input
                                    value={description}
                                    onChange={e => setDescription(e.target.value)}
                                    placeholder="Ex: Boas-vindas de novos clientes"
                                    style={inputStyle()}
                                    onFocus={e => (e.currentTarget.style.borderColor = '#10b981')}
                                    onBlur={e => (e.currentTarget.style.borderColor = 'var(--border-default)')}
                                />
                            </div>
                        </div>
                    </div>
                </div>

                {/* --- SEÇÃO 2: Desconto --- */}
                <div style={{ marginBottom: '20px' }}>
                    {sectionHeader(2, 'Desconto', '#818cf8')}

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '12px' }}>
                        {[
                            { key: 'VALOR' as const, icon: '💰', label: 'Valor fixo (R$)', desc: 'Desconta um valor exato em reais' },
                            { key: 'PERCENTUAL' as const, icon: '📊', label: 'Percentual (%)', desc: 'Desconta uma porcentagem do total' },
                        ].map(t => (
                            <button key={t.key} onClick={() => { setDiscountType(t.key); setValueText(''); }}
                                style={{
                                    padding: '12px', borderRadius: '10px', cursor: 'pointer', textAlign: 'left',
                                    background: discountType === t.key ? 'rgba(129,140,248,0.08)' : 'var(--bg-elevated)',
                                    border: `1.5px solid ${discountType === t.key ? 'rgba(129,140,248,0.3)' : 'var(--border-default)'}`,
                                    transition: 'all 0.15s',
                                }}>
                                <div style={{ fontSize: '0.875rem', fontWeight: 700, color: discountType === t.key ? '#818cf8' : 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '6px' }}>{t.icon} {t.label}</div>
                                <div style={{ fontSize: '0.5625rem', color: 'var(--text-muted)', marginTop: '3px' }}>{t.desc}</div>
                            </button>
                        ))}
                    </div>

                    <div>
                        <label style={labelStyle}>{discountType === 'VALOR' ? 'Valor do desconto (R$) *' : 'Percentual de desconto (%) *'}</label>
                        <div style={{ position: 'relative' }}>
                            <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: '0.75rem', opacity: 0.5 }}>{discountType === 'VALOR' ? '💵' : '％'}</span>
                            {discountType === 'VALOR' ? (
                                <input
                                    value={valueText}
                                    onChange={e => setValueText(e.target.value.replace(/[^0-9,]/g, ''))}
                                    placeholder="Ex: 50,00"
                                    inputMode="decimal"
                                    style={inputStyle(!!fieldErrors.discountValue)}
                                    onFocus={e => (e.currentTarget.style.borderColor = '#818cf8')}
                                    onBlur={e => (e.currentTarget.style.borderColor = fieldErrors.discountValue ? 'rgba(239,68,68,0.5)' : 'var(--border-default)')}
                                />
                            ) : (
                                <input
                                    type="number" min={1} max={100} step={1}
                                    value={valueText}
                                    onChange={e => setValueText(e.target.value)}
                                    placeholder="Ex: 10"
                                    style={inputStyle(!!fieldErrors.discountValue)}
                                    onFocus={e => (e.currentTarget.style.borderColor = '#818cf8')}
                                    onBlur={e => (e.currentTarget.style.borderColor = fieldErrors.discountValue ? 'rgba(239,68,68,0.5)' : 'var(--border-default)')}
                                />
                            )}
                        </div>
                        {fieldErrors.discountValue && <div style={fieldErrorStyle}>{fieldErrors.discountValue}</div>}
                    </div>
                </div>

                {/* --- SEÇÃO 3: Aplicação --- */}
                <div style={{ marginBottom: '20px' }}>
                    {sectionHeader(3, 'Aplicação', '#f59e0b')}

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        {[
                            { key: 'FIRST_PAYMENT' as const, icon: '1️⃣', label: 'Só a 1ª cobrança', hint: 'O desconto vale para a primeira fatura do contrato' },
                            { key: 'ALL_INSTALLMENTS' as const, icon: '🔁', label: 'Todas as parcelas', hint: 'O desconto se repete em todas as mensalidades' },
                        ].map(s => (
                            <button key={s.key} onClick={() => setScope(s.key)}
                                style={{
                                    padding: '10px 14px', borderRadius: '10px', cursor: 'pointer', textAlign: 'left',
                                    display: 'flex', alignItems: 'center', gap: '10px',
                                    background: scope === s.key ? 'rgba(245,158,11,0.08)' : 'var(--bg-elevated)',
                                    border: `1.5px solid ${scope === s.key ? 'rgba(245,158,11,0.3)' : 'var(--border-default)'}`,
                                    transition: 'all 0.15s',
                                }}>
                                <span style={{
                                    width: 14, height: 14, borderRadius: '50%', flexShrink: 0,
                                    border: `2px solid ${scope === s.key ? '#f59e0b' : 'var(--border-default)'}`,
                                    background: scope === s.key ? '#f59e0b' : 'transparent',
                                    boxShadow: scope === s.key ? 'inset 0 0 0 2.5px var(--bg-elevated)' : 'none',
                                }} />
                                <span>
                                    <span style={{ fontSize: '0.8125rem', fontWeight: 700, color: scope === s.key ? '#f59e0b' : 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '6px' }}>{s.icon} {s.label}</span>
                                    <span style={{ fontSize: '0.5625rem', color: 'var(--text-muted)', display: 'block', marginTop: '2px' }}>{s.hint}</span>
                                </span>
                            </button>
                        ))}
                    </div>
                </div>

                {/* --- SEÇÃO 4: Limites --- */}
                <div style={{ marginBottom: '20px' }}>
                    {sectionHeader(4, 'Limites', '#2dd4bf')}

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '12px' }}>
                        <div>
                            <label style={labelStyle}>Expira em</label>
                            <input
                                type="date"
                                value={expiresAt}
                                onChange={e => setExpiresAt(e.target.value)}
                                style={inputStyle(false, false)}
                                onFocus={e => (e.currentTarget.style.borderColor = '#2dd4bf')}
                                onBlur={e => (e.currentTarget.style.borderColor = 'var(--border-default)')}
                            />
                            <div style={hintStyle}>Deixe vazio para não expirar</div>
                        </div>
                        <div>
                            <label style={labelStyle}>Máx. de usos</label>
                            <input
                                type="number" min={1} step={1}
                                value={maxUses}
                                onChange={e => setMaxUses(e.target.value)}
                                placeholder="Ex: 20"
                                style={inputStyle(false, false)}
                                onFocus={e => (e.currentTarget.style.borderColor = '#2dd4bf')}
                                onBlur={e => (e.currentTarget.style.borderColor = 'var(--border-default)')}
                            />
                            <div style={hintStyle}>Deixe vazio para ilimitado</div>
                        </div>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '12px' }}>
                        <div>
                            <label style={labelStyle}>Limite por cliente</label>
                            <input
                                type="number" min={1} step={1}
                                value={maxUsesPerUser}
                                onChange={e => setMaxUsesPerUser(e.target.value)}
                                placeholder="Ex: 1"
                                style={inputStyle(false, false)}
                                onFocus={e => (e.currentTarget.style.borderColor = '#2dd4bf')}
                                onBlur={e => (e.currentTarget.style.borderColor = 'var(--border-default)')}
                            />
                            <div style={hintStyle}>Quantas vezes o MESMO cliente pode usar (vazio = ilimitado)</div>
                        </div>
                        <div>
                            <label style={labelStyle}>Valor mínimo (R$)</label>
                            <input
                                value={minAmountText}
                                onChange={e => setMinAmountText(e.target.value.replace(/[^0-9,]/g, ''))}
                                placeholder="Ex: 100,00"
                                inputMode="decimal"
                                style={inputStyle(false, false)}
                                onFocus={e => (e.currentTarget.style.borderColor = '#2dd4bf')}
                                onBlur={e => (e.currentTarget.style.borderColor = 'var(--border-default)')}
                            />
                            <div style={hintStyle}>Só vale em cobranças a partir deste valor (vazio = sem mínimo)</div>
                        </div>
                    </div>

                    <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', padding: '10px 14px', borderRadius: '10px', background: active ? 'rgba(16,185,129,0.06)' : 'var(--bg-elevated)', border: `1px solid ${active ? 'rgba(16,185,129,0.2)' : 'var(--border-default)'}`, transition: 'all 0.15s' }}>
                        <input
                            type="checkbox"
                            checked={active}
                            onChange={e => setActive(e.target.checked)}
                            style={{ width: 16, height: 16, accentColor: '#10b981', cursor: 'pointer' }}
                        />
                        <span>
                            <span style={{ fontSize: '0.8125rem', fontWeight: 700, color: active ? '#10b981' : 'var(--text-primary)' }}>Cupom ativo</span>
                            <span style={{ fontSize: '0.5625rem', color: 'var(--text-muted)', display: 'block', marginTop: '2px' }}>Cupons inativos não podem ser aplicados em novos pagamentos</span>
                        </span>
                    </label>
                </div>

                {/* --- SEÇÃO 5: Elegibilidade --- */}
                <div style={{ marginBottom: '20px' }}>
                    {sectionHeader(5, 'Elegibilidade', '#ec4899')}

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        {[
                            { key: 'ALL' as const, icon: '👥', label: 'Todos os clientes', hint: 'Qualquer cliente pode usar este cupom' },
                            { key: 'SPECIFIC' as const, icon: '🎯', label: 'Apenas clientes específicos', hint: 'Escolha quem pode usar o cupom' },
                            { key: 'NEW' as const, icon: '✨', label: 'Apenas clientes novos', hint: 'Clientes que nunca fizeram nenhum pagamento.' },
                        ].map(o => (
                            <button key={o.key} onClick={() => setEligibility(o.key)}
                                style={{
                                    padding: '10px 14px', borderRadius: '10px', cursor: 'pointer', textAlign: 'left',
                                    display: 'flex', alignItems: 'center', gap: '10px',
                                    background: eligibility === o.key ? 'rgba(236,72,153,0.08)' : 'var(--bg-elevated)',
                                    border: `1.5px solid ${eligibility === o.key ? 'rgba(236,72,153,0.3)' : 'var(--border-default)'}`,
                                    transition: 'all 0.15s',
                                }}>
                                <span style={{
                                    width: 14, height: 14, borderRadius: '50%', flexShrink: 0,
                                    border: `2px solid ${eligibility === o.key ? '#ec4899' : 'var(--border-default)'}`,
                                    background: eligibility === o.key ? '#ec4899' : 'transparent',
                                    boxShadow: eligibility === o.key ? 'inset 0 0 0 2.5px var(--bg-elevated)' : 'none',
                                }} />
                                <span>
                                    <span style={{ fontSize: '0.8125rem', fontWeight: 700, color: eligibility === o.key ? '#ec4899' : 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '6px' }}>{o.icon} {o.label}</span>
                                    <span style={{ fontSize: '0.5625rem', color: 'var(--text-muted)', display: 'block', marginTop: '2px' }}>{o.hint}</span>
                                </span>
                            </button>
                        ))}
                    </div>

                    {eligibility === 'SPECIFIC' && (
                        <div style={{ marginTop: '12px', padding: '14px', borderRadius: '10px', background: 'rgba(236,72,153,0.03)', border: '1px solid rgba(236,72,153,0.1)' }}>
                            {/* Chips dos selecionados */}
                            {selectedUsers.length > 0 && (
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '10px' }}>
                                    {selectedUsers.map(u => (
                                        <span key={u.id} style={{
                                            display: 'inline-flex', alignItems: 'center', gap: '6px',
                                            padding: '4px 8px', borderRadius: '999px', fontSize: '0.6875rem', fontWeight: 600,
                                            background: 'rgba(236,72,153,0.1)', border: '1px solid rgba(236,72,153,0.2)', color: '#ec4899',
                                        }}>
                                            {u.name}
                                            <button
                                                onClick={() => setSelectedUsers(prev => prev.filter(s => s.id !== u.id))}
                                                aria-label={`Remover ${u.name}`}
                                                style={{ background: 'none', border: 'none', color: '#ec4899', cursor: 'pointer', padding: 0, fontSize: '0.75rem', lineHeight: 1 }}>
                                                ✕
                                            </button>
                                        </span>
                                    ))}
                                </div>
                            )}

                            {/* Busca */}
                            <div style={{ position: 'relative', marginBottom: '8px' }}>
                                <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: '0.75rem', opacity: 0.5 }}>🔎</span>
                                <input
                                    value={clientSearch}
                                    onChange={e => setClientSearch(e.target.value)}
                                    placeholder="Buscar por nome ou e-mail..."
                                    style={inputStyle()}
                                    onFocus={e => (e.currentTarget.style.borderColor = '#ec4899')}
                                    onBlur={e => (e.currentTarget.style.borderColor = 'var(--border-default)')}
                                />
                            </div>

                            {/* Lista de clientes */}
                            <div style={{ maxHeight: '200px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                {filteredClients.length === 0 ? (
                                    <div style={{ padding: '16px', textAlign: 'center', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                        {clients.length === 0 ? 'Carregando clientes...' : 'Nenhum cliente encontrado'}
                                    </div>
                                ) : filteredClients.map(u => {
                                    const checked = selectedUsers.some(s => s.id === u.id);
                                    return (
                                        <label key={u.id} style={{
                                            display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 10px',
                                            borderRadius: '8px', cursor: 'pointer',
                                            background: checked ? 'rgba(236,72,153,0.06)' : 'transparent',
                                            border: `1px solid ${checked ? 'rgba(236,72,153,0.15)' : 'transparent'}`,
                                            transition: 'all 0.15s',
                                        }}>
                                            <input
                                                type="checkbox"
                                                checked={checked}
                                                onChange={() => toggleUser(u)}
                                                style={{ width: 14, height: 14, accentColor: '#ec4899', cursor: 'pointer', flexShrink: 0 }}
                                            />
                                            <span style={{
                                                width: 26, height: 26, borderRadius: 8, flexShrink: 0,
                                                background: 'rgba(236,72,153,0.12)', color: '#ec4899',
                                                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                                                fontSize: '0.6875rem', fontWeight: 700,
                                            }}>{u.name.charAt(0).toUpperCase()}</span>
                                            <span style={{ minWidth: 0 }}>
                                                <span style={{ fontSize: '0.75rem', fontWeight: 600, display: 'block', color: 'var(--text-primary)' }}>{u.name}</span>
                                                <span style={{ fontSize: '0.625rem', color: 'var(--text-muted)', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.email}</span>
                                            </span>
                                        </label>
                                    );
                                })}
                            </div>
                        </div>
                    )}
                    {fieldErrors.eligibility && <div style={fieldErrorStyle}>{fieldErrors.eligibility}</div>}
                </div>

                {/* --- AÇÕES --- */}
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px' }}>
                    <button onClick={onClose}
                        style={{ padding: '10px 20px', borderRadius: '10px', background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-secondary)', fontSize: '0.8125rem', fontWeight: 600, cursor: 'pointer' }}>
                        Cancelar
                    </button>
                    <button onClick={handleSave} disabled={!canSave || saving}
                        style={{
                            padding: '10px 28px', borderRadius: '10px', border: 'none', fontSize: '0.875rem', fontWeight: 700, cursor: 'pointer',
                            background: canSave && !saving ? 'linear-gradient(135deg, #818cf8, #6366f1)' : 'var(--bg-elevated)',
                            color: canSave && !saving ? '#fff' : 'var(--text-muted)',
                            opacity: canSave && !saving ? 1 : 0.5,
                            display: 'flex', alignItems: 'center', gap: '8px',
                        }}>
                        {saving ? '⏳ Salvando...' : isEdit ? '💾 Salvar Alterações' : '🎟️ Criar Cupom'}
                    </button>
                </div>
            </div>
        </BottomSheetModal>
    );
}

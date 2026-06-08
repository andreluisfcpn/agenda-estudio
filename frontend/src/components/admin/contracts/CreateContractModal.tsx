import { getErrorMessage } from '../../../utils/errors';
import React, { useState, useEffect } from 'react';
import { contractsApi, pricingApi, UserSummary, CreateContractData, PricingConfig, InstallmentPlan, AddOnConfig, ServiceBreakdownItem } from '../../../api/client';
import { useBusinessConfig } from '../../../hooks/useBusinessConfig';
import BottomSheetModal from '../../BottomSheetModal';
import InlineCheckout from '../../InlineCheckout';
import ServiceLineItem from '../../ui/ServiceLineItem';

import { formatBRL } from '../../../utils/format';

type AdminMethod = 'CARTAO' | 'PIX' | 'BOLETO';

const DAY_NAMES_FULL = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

interface CreateContractModalProps {
    isOpen: boolean;
    onClose: () => void;
    onCreated: () => void;
    users: UserSummary[];
    pricing: PricingConfig[];
}

export default function CreateContractModal({ isOpen, onClose, onCreated, users, pricing }: CreateContractModalProps) {
    const { get: getRule } = useBusinessConfig();
    const ep3 = getRule('episodes_3months');
    const ep6 = getRule('episodes_6months');
    const disc3 = getRule('discount_3months');
    const disc6 = getRule('discount_6months');
    const sessionsPerMonth = getRule('sessions_per_month');

    const [createForm, setCreateForm] = useState<Partial<CreateContractData> & { contractUrl?: string }>({
        name: '', type: 'FIXO', tier: 'COMERCIAL', durationMonths: 3, startDate: new Date().toISOString().split('T')[0], contractUrl: '', paymentPlan: 'MONTHLY',
    });
    const [createError, setCreateError] = useState('');
    const [createSuccess, setCreateSuccess] = useState('');
    const [paymentMethod, setPaymentMethod] = useState<AdminMethod>('CARTAO');

    const [conflicts, setConflicts] = useState<{ date: string, originalTime: string, suggestedReplacement?: { date: string, time: string } }[]>([]);
    const [resolvedConflicts, setResolvedConflicts] = useState<{ originalDate: string, originalTime: string, newDate: string, newTime: string }[]>([]);
    const [showConflictModal, setShowConflictModal] = useState(false);

    // Authoritative pricing (same rules as the client) + optional "charge now" step.
    const [quote, setQuote] = useState<{ monthlyAmount: number; fullPix: number; fullCard: number; installmentPlans: InstallmentPlan[]; services: ServiceBreakdownItem[]; servicesPerRecordingCents: number } | null>(null);
    const [chargePaymentId, setChargePaymentId] = useState<string | null>(null);

    // Per-episode services (accompany every recording). GESTAO_SOCIAL (monthly) is excluded,
    // matching the client wizard; the per-recording value is shown via ServiceLineItem.
    const [addons, setAddons] = useState<AddOnConfig[]>([]);
    const [selectedAddons, setSelectedAddons] = useState<string[]>([]);
    useEffect(() => {
        if (!isOpen) return;
        pricingApi.getAddons().then(r => setAddons(r.addons.filter(a => !a.monthly))).catch(() => setAddons([]));
    }, [isOpen]);

    const planSel = createForm.paymentPlan || 'MONTHLY';
    useEffect(() => {
        if (!isOpen) return;
        let alive = true;
        pricingApi.checkoutQuote({ durationMonths: createForm.durationMonths || 3, contractType: createForm.type, tier: createForm.tier, addOns: selectedAddons })
            .then(q => { if (alive) setQuote(q); })
            .catch(() => { if (alive) setQuote(null); });
        return () => { alive = false; };
    }, [isOpen, createForm.tier, createForm.durationMonths, createForm.type, selectedAddons]);

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
                boletoAllowed: createForm.boletoAllowed || undefined,
                paymentPlan: createForm.paymentPlan || 'MONTHLY',
                paymentMethod,
                addOns: selectedAddons.length > 0 ? selectedAddons : undefined,
                resolvedConflicts: resolutions.length > 0 ? resolutions : undefined,
                ...(createForm.type === 'FIXO' && { fixedDayOfWeek: createForm.fixedDayOfWeek || 1, fixedTime: createForm.fixedTime || '14:00' }),
            };
            const res = await contractsApi.create(data);
            onCreated();
            setShowConflictModal(false);
            // Offer to charge the first payment on the spot (PIX QR / client's card present),
            // using the SAME InlineCheckout + unified policy as the client. Otherwise it stays
            // PENDING and the client pays later (or via auto-charge).
            if (res.firstPaymentId) {
                setChargePaymentId(res.firstPaymentId);
            } else {
                setCreateSuccess(res.message);
                setTimeout(() => { onClose(); setCreateSuccess(''); }, 1500);
            }
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

    if (!isOpen) return null;

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
    const chargeAmount = planSel === 'FULL'
        ? (paymentMethod === 'PIX' ? (quote?.fullPix ?? total) : (quote?.fullCard ?? total))
        : (quote?.monthlyAmount ?? monthly);

    const clientUsers = users.filter(u => u.role !== 'ADMIN');
    const selectedUser = clientUsers.find(u => u.id === createForm.userId);

    return (
        <>
            <BottomSheetModal isOpen onClose={onClose} hideHeader maxWidth="580px" className="admin-sheet" title="Novo Contrato">
                    {/* --- HEADER --- */}
                    <div style={{ padding: '28px 32px 0' }}>
                        <h2 style={{ fontSize: '1.25rem', fontWeight: 800, margin: 0, display: 'flex', alignItems: 'center', gap: '10px' }}>
                            <span style={{ width: 36, height: 36, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'linear-gradient(135deg, #818cf8, #6366f1)', fontSize: '1rem' }}>📄</span>
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
                                        <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: '0.75rem', opacity: 0.5 }}>👤</span>
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
                                        <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: '0.75rem', opacity: 0.5 }}>📝</span>
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
                                        { key: 'FIXO', icon: '📌', label: 'Fixo', desc: 'Recorrente: dia/hora fixos toda semana' },
                                        { key: 'FLEX', icon: '🎟️', label: 'Flex', desc: 'Créditos: agende quando quiser' },
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
                                        { key: 'COMERCIAL', icon: '🏢', label: 'Comercial', color: '#10b981' },
                                        { key: 'AUDIENCIA', icon: '🎤', label: 'Audiência', color: '#2dd4bf' },
                                        { key: 'SABADO', icon: '🌟', label: 'Sábado', color: '#fbbf24' },
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
                                        <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: '0.75rem', opacity: 0.5 }}>📅</span>
                                        <input type="date" value={createForm.startDate}
                                            onChange={e => setCreateForm({ ...createForm, startDate: e.target.value })}
                                            style={inputStyle()}
                                            onFocus={e => (e.currentTarget.style.borderColor = '#818cf8')}
                                            onBlur={e => (e.currentTarget.style.borderColor = 'var(--border-default)')} />
                                    </div>
                                </div>
                                <div>
                                    <label style={labelStyle}>🔗 Link do Contrato</label>
                                    <div style={{ position: 'relative' }}>
                                        <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: '0.75rem', opacity: 0.5 }}>🔗</span>
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
                                    <div style={{ fontSize: '0.625rem', fontWeight: 700, color: '#818cf8', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '10px' }}>🔁 Configuração Recorrente</div>
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
                                    <div style={{ fontWeight: 700, color: '#10b981', marginBottom: '6px', fontSize: '0.6875rem' }}>🎟️ Regras Flex</div>
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                                        <span>• Mínimo 1 gravação/semana (use ou perca)</span>
                                        <span>• Adiantamento livre de créditos</span>
                                        <span>• Compensação automática de semanas futuras</span>
                                    </div>
                                </div>
                            )}
                            {/* Billing plan toggle: Mensal | Integral */}
                            <div style={{ marginBottom: '14px' }}>
                                <label style={labelStyle}>Plano de cobrança</label>
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                                    {[
                                        { key: 'MONTHLY' as const, icon: '📆', label: 'Mensal', desc: `${createForm.durationMonths || 3} parcelas` },
                                        { key: 'FULL' as const, icon: '💰', label: 'Integral', desc: '1 cobrança do total' },
                                    ].map(p => {
                                        const active = (createForm.paymentPlan || 'MONTHLY') === p.key;
                                        return (
                                            <button key={p.key} onClick={() => setCreateForm({ ...createForm, paymentPlan: p.key })}
                                                style={{
                                                    padding: '12px', borderRadius: '10px', cursor: 'pointer', textAlign: 'left',
                                                    background: active ? 'rgba(99,102,241,0.08)' : 'var(--bg-elevated)',
                                                    border: `1.5px solid ${active ? 'rgba(99,102,241,0.3)' : 'var(--border-default)'}`,
                                                    transition: 'all 0.15s',
                                                }}>
                                                <div style={{ fontSize: '0.875rem', fontWeight: 700, color: active ? '#818cf8' : 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '6px' }}>{p.icon} {p.label}</div>
                                                <div style={{ fontSize: '0.5625rem', color: 'var(--text-muted)', marginTop: '3px' }}>{p.desc}</div>
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                            {/* Payment method selector — unified with the client (PIX / Cartão / Boleto se liberado) */}
                            <div style={{ marginBottom: '14px' }}>
                                <label style={labelStyle}>Forma de pagamento</label>
                                <div style={{ display: 'grid', gridTemplateColumns: `repeat(${createForm.boletoAllowed ? 3 : 2}, 1fr)`, gap: '8px' }}>
                                    {([
                                        { key: 'PIX' as const, icon: '⚡', label: 'PIX' },
                                        { key: 'CARTAO' as const, icon: '💳', label: 'Cartão' },
                                        ...(createForm.boletoAllowed ? [{ key: 'BOLETO' as const, icon: '📄', label: 'Boleto' }] : []),
                                    ]).map(m => {
                                        const active = paymentMethod === m.key;
                                        return (
                                            <button key={m.key} onClick={() => setPaymentMethod(m.key)}
                                                style={{
                                                    padding: '10px 8px', borderRadius: '10px', cursor: 'pointer', textAlign: 'center',
                                                    background: active ? 'rgba(99,102,241,0.08)' : 'var(--bg-elevated)',
                                                    border: `1.5px solid ${active ? 'rgba(99,102,241,0.3)' : 'var(--border-default)'}`,
                                                    transition: 'all 0.15s',
                                                }}>
                                                <div style={{ fontSize: '1rem' }}>{m.icon}</div>
                                                <div style={{ fontSize: '0.6875rem', fontWeight: 700, color: active ? '#818cf8' : 'var(--text-primary)', marginTop: '2px' }}>{m.label}</div>
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                            {/* Boleto release toggle */}
                            <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', padding: '12px 14px', borderRadius: '10px', background: createForm.boletoAllowed ? 'rgba(245,158,11,0.06)' : 'var(--bg-elevated)', border: `1px solid ${createForm.boletoAllowed ? 'rgba(245,158,11,0.3)' : 'var(--border-default)'}` }}>
                                <input type="checkbox" checked={!!createForm.boletoAllowed} onChange={e => setCreateForm({ ...createForm, boletoAllowed: e.target.checked })} style={{ width: 18, height: 18, accentColor: '#f59e0b', cursor: 'pointer' }} />
                                <div>
                                    <div style={{ fontSize: '0.8125rem', fontWeight: 600 }}>📄 Permitir boleto neste contrato</div>
                                    <div style={{ fontSize: '0.625rem', color: 'var(--text-muted)', marginTop: '2px' }}>O cliente poderá pagar as parcelas via boleto. Desligado por padrão.</div>
                                </div>
                            </label>
                        </div>

                        {/* --- SECTION 3: Serviços por Gravação --- */}
                        {addons.length > 0 && (
                            <div style={{ marginBottom: '20px' }}>
                                {sectionHeader(3, 'Serviços por Gravação', '#2dd4bf')}
                                <p style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', margin: '-8px 0 12px' }}>
                                    Acompanham toda gravação do contrato e entram na parcela. Valor com {discount}% de desconto de fidelidade.
                                </p>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                    {addons.map(addon => {
                                        const selected = selectedAddons.includes(addon.key);
                                        const perRecording = Math.round(addon.price * (1 - discount / 100));
                                        return (
                                            <ServiceLineItem
                                                key={addon.key}
                                                name={addon.name}
                                                description={addon.description}
                                                perRecordingCents={perRecording}
                                                sessionsPerMonth={sessionsPerMonth}
                                                selected={selected}
                                                onToggle={() => setSelectedAddons(prev => selected ? prev.filter(k => k !== addon.key) : [...prev, addon.key])}
                                            />
                                        );
                                    })}
                                </div>
                                {selectedAddons.length > 0 && quote && (
                                    <div style={{ marginTop: 10, fontSize: '0.75rem', color: '#2dd4bf', fontWeight: 700, textAlign: 'right' }}>
                                        +{formatBRL(quote.servicesPerRecordingCents)}/gravação em serviços
                                    </div>
                                )}
                            </div>
                        )}

                        {/* --- SECTION 4: Price Preview --- */}
                        {tierPrice && (
                            <div style={{ marginBottom: '20px' }}>
                                {sectionHeader(4, 'Estimativa de Preço', '#f59e0b')}
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

                                        {selectedAddons.length > 0 && quote && (
                                            <>
                                                <span style={{ color: '#2dd4bf', fontWeight: 600 }}>Serviços ({episodes} grav. × {formatBRL(quote.servicesPerRecordingCents)})</span>
                                                <span style={{ textAlign: 'right', color: '#2dd4bf', fontWeight: 700 }}>+{formatBRL(quote.servicesPerRecordingCents * episodes)}</span>
                                            </>
                                        )}

                                        {planSel === 'FULL' ? (
                                            <>
                                                <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>À vista {paymentMethod === 'PIX' ? '(PIX, com desconto)' : '(cartão, até 12x)'}</span>
                                                <span style={{ textAlign: 'right', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{formatBRL(quote ? (paymentMethod === 'PIX' ? quote.fullPix : quote.fullCard) : total)}</span>
                                            </>
                                        ) : (
                                            <>
                                                <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>Mensal (1x, sem acréscimo)</span>
                                                <span style={{ textAlign: 'right', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{createForm.durationMonths || 3}× {formatBRL(quote ? quote.monthlyAmount : monthly)}/mês</span>
                                            </>
                                        )}
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* --- ACTIONS --- */}
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px' }}>
                            <button onClick={onClose}
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
                                📄 Criar Contrato
                            </button>
                        </div>
                    </div>
            </BottomSheetModal>

            {/* Conflict Resolution Modal */}
            {showConflictModal && (
                <BottomSheetModal isOpen onClose={() => setShowConflictModal(false)} hideHeader maxWidth="600px" title="Conflitos de Agenda">
                        <div style={{ textAlign: 'center', marginBottom: '20px' }}>
                            <div style={{ fontSize: '2.5rem', marginBottom: '8px' }}>⚠️</div>
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
                                                    <span>🔄 Auto-Substituição:</span>
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
                                🚫 Cancelar e voltar para escolhas
                            </button>
                        </div>
                </BottomSheetModal>
            )}

            {/* Charge-now step: same InlineCheckout + unified policy as the client. PIX shows a QR;
                cartão uses Stripe Elements with the client's card present. Charges the CLIENT
                (payment.userId) — the backend resolves the payer from the payment, not the admin. */}
            {chargePaymentId && (
                <BottomSheetModal isOpen onClose={() => { onCreated(); onClose(); }} hideHeader maxWidth="460px" className="admin-sheet" title="Cobrar 1ª parcela">
                        <div style={{ padding: '24px 28px' }}>
                            <h3 style={{ fontSize: '1.0625rem', fontWeight: 800, margin: '0 0 4px' }}>Cobrar 1ª parcela</h3>
                            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: '0 0 16px' }}>
                                Cobre agora (PIX ou cartão do cliente presente) ou deixe pendente — o cliente paga depois / cobrança automática.
                            </p>
                            <InlineCheckout
                                amount={chargeAmount}
                                paymentId={chargePaymentId}
                                description={`${createForm.name || 'Contrato'} - 1ª cobrança`}
                                contractDuration={planSel === 'FULL' ? (createForm.durationMonths || 3) : 1}
                                allowedMethods={[paymentMethod]}
                                isAdmin
                                allowBoleto={!!createForm.boletoAllowed}
                                context="contract"
                                onSuccess={() => { onCreated(); onClose(); }}
                                onError={(msg) => setCreateError(msg)}
                                onCancel={() => { onCreated(); onClose(); }}
                            />
                            <button onClick={() => { onCreated(); onClose(); }}
                                style={{ marginTop: 12, width: '100%', padding: '10px', borderRadius: '10px', background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-secondary)', fontSize: '0.8125rem', fontWeight: 600, cursor: 'pointer' }}>
                                Deixar pendente (cliente paga depois)
                            </button>
                        </div>
                </BottomSheetModal>
            )}
        </>
    );
}

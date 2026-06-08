import { getErrorMessage } from '../../../utils/errors';
import React, { useState, useCallback, useEffect } from 'react';
import { bookingsApi, contractsApi, pricingApi, UserSummary, Contract, Slot, AddOnConfig } from '../../../api/client';
import { useUI } from '../../../context/UIContext';
import BottomSheetModal from '../../BottomSheetModal';
import InlineCheckout from '../../InlineCheckout';
import ServiceLineItem from '../../ui/ServiceLineItem';
import { formatBRL } from '../../../utils/format';
import { TIER_META } from '../../../constants/adminMeta';

const TIER_EMOJI: Record<string, string> = { COMERCIAL: '🏢', AUDIENCIA: '🎤', SABADO: '🌟' };

interface CreateBookingModalProps {
    isOpen: boolean;
    onClose: () => void;
    users: UserSummary[];
    onCreated: () => void;
}

export default function CreateBookingModal({ isOpen, onClose, users, onCreated }: CreateBookingModalProps) {
    const { showToast } = useUI();

    const [createStep, setCreateStep] = useState(1);
    const [createForm, setCreateForm] = useState({ userId: '', contractId: '', date: '', startTime: '', status: 'CONFIRMED', adminNotes: '' });
    const [createError, setCreateError] = useState('');
    const [createSearch, setCreateSearch] = useState('');
    const [clientContracts, setClientContracts] = useState<Contract[]>([]);
    const [daySlots, setDaySlots] = useState<Slot[]>([]);
    const [slotsLoading, setSlotsLoading] = useState(false);
    const [creating, setCreating] = useState(false);
    const [customPrice, setCustomPrice] = useState<number | null>(null);
    const [priceDisplay, setPriceDisplay] = useState('');
    // Per-episode services on this recording (inherit the linked contract's discount; avulso = 0%).
    const [addons, setAddons] = useState<AddOnConfig[]>([]);
    const [selectedAddons, setSelectedAddons] = useState<string[]>([]);
    useEffect(() => {
        if (!isOpen) return;
        pricingApi.getAddons().then(r => setAddons(r.addons.filter(a => !a.monthly))).catch(() => setAddons([]));
    }, [isOpen]);
    // Avulso "charge now" (unified with the client): generate PIX / charge the client's card.
    const [chargeNow, setChargeNow] = useState(false);
    const [chargeMethod, setChargeMethod] = useState<'CARTAO' | 'PIX'>('CARTAO');
    const [chargePaymentId, setChargePaymentId] = useState<string | null>(null);

    const resetCreateModal = () => {
        onClose();
        setCreateStep(1);
        setCreateForm({ userId: '', contractId: '', date: '', startTime: '', status: 'CONFIRMED', adminNotes: '' });
        setCreateError('');
        setCreateSearch('');
        setClientContracts([]);
        setDaySlots([]);
        setCustomPrice(null);
        setPriceDisplay('');
        setSelectedAddons([]);
        setChargeNow(false);
        setChargeMethod('CARTAO');
        setChargePaymentId(null);
    };

    const handleCreate = async () => {
        setCreateError('');
        setCreating(true);
        try {
            const isAvulsoCharge = !createForm.contractId && chargeNow;
            const payload: any = {
                userId: createForm.userId, date: createForm.date, startTime: createForm.startTime,
                // To charge inline the booking must await payment (RESERVED), then the payment confirms it.
                status: isAvulsoCharge ? 'RESERVED' : createForm.status,
            };
            if (createForm.contractId) payload.contractId = createForm.contractId;
            if (createForm.adminNotes.trim()) payload.adminNotes = createForm.adminNotes;
            if (!createForm.contractId && customPrice != null) payload.customPrice = customPrice;
            if (selectedAddons.length > 0) payload.addOns = selectedAddons;
            if (isAvulsoCharge) payload.paymentMethod = chargeMethod;
            const res = await bookingsApi.adminCreate(payload);
            onCreated();
            if (isAvulsoCharge && res.paymentId) {
                // Open the same InlineCheckout the client uses — charges the CLIENT (payment.userId).
                setChargePaymentId(res.paymentId);
            } else {
                resetCreateModal();
                showToast('Agendamento criado com sucesso!');
            }
        } catch (err: unknown) { setCreateError(getErrorMessage(err)); }
        finally { setCreating(false); }
    };

    // Load contracts when client is selected
    const loadClientContracts = useCallback(async (userId: string) => {
        try {
            const res = await contractsApi.getAll();
            setClientContracts(res.contracts.filter(c => c.user?.id === userId && c.status === 'ACTIVE'));
        } catch { setClientContracts([]); }
    }, []);

    // Load slot availability when date changes
    const loadDaySlots = useCallback(async (date: string) => {
        setSlotsLoading(true);
        try {
            const res = await bookingsApi.getAvailability(date);
            setDaySlots(res.slots || []);
        } catch { setDaySlots([]); }
        finally { setSlotsLoading(false); }
    }, []);

    if (!isOpen) return null;

    const selectedUser = users.find(u => u.id === createForm.userId);
    const selectedSlot = daySlots.find(s => s.time === createForm.startTime);
    const selectedContract = clientContracts.find(c => c.id === createForm.contractId);
    // Services on this recording inherit the contract's loyalty discount (avulso = 0%).
    const inheritedDiscount = selectedContract?.discountPct || 0;
    const servicesValue = selectedAddons.reduce((acc, key) => {
        const a = addons.find(x => x.key === key);
        return a ? acc + Math.round(a.price * (1 - inheritedDiscount / 100)) : acc;
    }, 0);
    const filteredClients = users.filter(u => u.role !== 'ADMIN').filter(u => {
        if (!createSearch) return true;
        const q = createSearch.toLowerCase();
        return u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q);
    });
    const tc = (tier: string) => TIER_META[tier] || TIER_META.COMERCIAL;

    const stepLabels = ['Cliente', 'Horário', 'Confirmar'];

    // Charge-now step (avulso): same InlineCheckout + unified policy as the client.
    if (chargePaymentId) {
        return (
            <BottomSheetModal isOpen onClose={() => { resetCreateModal(); showToast('Agendamento criado (pagamento pendente).'); }} hideHeader maxWidth="460px" className="admin-sheet" title="Cobrar agendamento">
                    <div style={{ padding: '24px 28px' }}>
                        <h3 style={{ fontSize: '1.0625rem', fontWeight: 800, margin: '0 0 4px' }}>Cobrar agendamento</h3>
                        <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: '0 0 16px' }}>
                            {chargeMethod === 'PIX' ? 'Mostre o QR Code PIX ao cliente.' : 'Use o cartão do cliente (presente).'} A reserva confirma ao pagar.
                        </p>
                        <InlineCheckout
                            amount={(customPrice || 0) + servicesValue}
                            paymentId={chargePaymentId}
                            description="Agendamento avulso"
                            allowedMethods={[chargeMethod]}
                            isAdmin
                            context="avulso"
                            onSuccess={() => { resetCreateModal(); showToast('Pagamento confirmado!'); }}
                            onError={(msg) => setCreateError(msg)}
                            onCancel={() => { resetCreateModal(); showToast('Agendamento criado (pagamento pendente).'); }}
                        />
                        {createError && <div style={{ marginTop: 10, padding: '8px 12px', borderRadius: 8, background: 'rgba(239,68,68,0.08)', color: '#ef4444', fontSize: '0.75rem' }}>{createError}</div>}
                        <button onClick={() => { resetCreateModal(); showToast('Agendamento criado (pagamento pendente).'); }}
                            style={{ marginTop: 12, width: '100%', padding: '10px', borderRadius: '10px', background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-secondary)', fontSize: '0.8125rem', fontWeight: 600, cursor: 'pointer' }}>
                            Fechar (deixar pendente)
                        </button>
                    </div>
                </BottomSheetModal>
        );
    }

    return (
        <BottomSheetModal isOpen onClose={resetCreateModal} hideHeader maxWidth="580px" className="admin-sheet" title="Novo Agendamento">
                {/* --- HEADER --- */}
                <div style={{ padding: '28px 32px 0', borderBottom: 'none' }}>
                    <h2 style={{ fontSize: '1.25rem', fontWeight: 800, margin: 0, display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <span style={{
                            width: 36, height: 36, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center',
                            background: 'linear-gradient(135deg, #10b981, #11819B)', fontSize: '1rem'
                        }}>➕</span>
                        Novo Agendamento
                    </h2>

                    {/* Step indicator */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginTop: '20px', padding: '0 4px' }}>
                        {stepLabels.map((label, i) => {
                            const step = i + 1;
                            const isActive = createStep === step;
                            const isDone = createStep > step;
                            return (
                                <React.Fragment key={step}>
                                    {i > 0 && <div style={{ flex: 1, height: 2, background: isDone ? '#10b981' : 'var(--border-default)', borderRadius: 1, transition: 'background 0.3s' }} />}
                                    <div style={{
                                        display: 'flex', alignItems: 'center', gap: '6px', cursor: isDone ? 'pointer' : 'default',
                                    }} onClick={() => isDone && setCreateStep(step)}>
                                        <div style={{
                                            width: 26, height: 26, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                                            fontSize: '0.6875rem', fontWeight: 700,
                                            background: isActive ? '#10b981' : isDone ? 'rgba(16,185,129,0.15)' : 'var(--bg-elevated)',
                                            color: isActive ? '#fff' : isDone ? '#10b981' : 'var(--text-muted)',
                                            border: `2px solid ${isActive ? '#10b981' : isDone ? 'rgba(16,185,129,0.3)' : 'var(--border-default)'}`,
                                            transition: 'all 0.3s',
                                        }}>
                                            {isDone ? '✓' : step}
                                        </div>
                                        <span style={{
                                            fontSize: '0.6875rem', fontWeight: isActive ? 700 : 500,
                                            color: isActive ? 'var(--text-primary)' : 'var(--text-muted)',
                                        }}>{label}</span>
                                    </div>
                                </React.Fragment>
                            );
                        })}
                    </div>
                </div>

                <div style={{ padding: '20px 32px 28px' }}>
                    {createError && <div className="error-message" style={{ marginBottom: '16px', padding: '10px 14px', borderRadius: '10px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.15)', color: '#ef4444', fontSize: '0.8125rem', fontWeight: 600 }}>{createError}</div>}

                    {/* -------- STEP 1: Select Client -------- */}
                    {createStep === 1 && (
                        <div>
                            <div style={{ position: 'relative', marginBottom: '14px' }}>
                                <input
                                    type="text" placeholder="Buscar cliente por nome ou e-mail..."
                                    value={createSearch} onChange={e => setCreateSearch(e.target.value)} autoFocus
                                    style={{
                                        width: '100%', padding: '10px 14px 10px 36px', borderRadius: '10px', fontSize: '0.8125rem',
                                        background: 'var(--bg-elevated)', border: '1px solid var(--border-default)',
                                        color: 'var(--text-primary)', outline: 'none',
                                    }}
                                    onFocus={e => (e.currentTarget.style.borderColor = '#10b981')}
                                    onBlur={e => (e.currentTarget.style.borderColor = 'var(--border-default)')}
                                />
                                <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: '0.8125rem', opacity: 0.5 }}>🔎</span>
                            </div>

                            <div style={{ maxHeight: '340px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                {filteredClients.length === 0 ? (
                                    <div style={{ padding: '32px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.8125rem' }}>
                                        Nenhum cliente encontrado
                                    </div>
                                ) : filteredClients.map(u => {
                                    const isSelected = createForm.userId === u.id;
                                    return (
                                        <div key={u.id}
                                            onClick={() => {
                                                setCreateForm({ ...createForm, userId: u.id, contractId: '' });
                                                loadClientContracts(u.id);
                                            }}
                                            style={{
                                                padding: '10px 14px', borderRadius: '10px', cursor: 'pointer',
                                                display: 'flex', alignItems: 'center', gap: '12px',
                                                background: isSelected ? 'rgba(16,185,129,0.08)' : 'transparent',
                                                border: `1px solid ${isSelected ? 'rgba(16,185,129,0.3)' : 'transparent'}`,
                                                transition: 'all 0.15s',
                                            }}
                                            onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; }}
                                            onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}
                                        >
                                            <div style={{
                                                width: 36, height: 36, borderRadius: '50%',
                                                background: isSelected ? 'linear-gradient(135deg, #10b981, #11819B)' : 'var(--bg-elevated)',
                                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                fontSize: '0.8125rem', fontWeight: 700, color: isSelected ? '#fff' : 'var(--text-muted)',
                                                flexShrink: 0,
                                            }}>
                                                {u.name.charAt(0).toUpperCase()}
                                            </div>
                                            <div style={{ flex: 1, minWidth: 0 }}>
                                                <div style={{ fontWeight: 600, fontSize: '0.8125rem', color: isSelected ? '#10b981' : 'var(--text-primary)' }}>{u.name}</div>
                                                <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.email}</div>
                                            </div>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                                {u._count.contracts > 0 && (
                                                    <span style={{
                                                        padding: '2px 8px', borderRadius: '6px', fontSize: '0.625rem', fontWeight: 700,
                                                        background: 'rgba(16,185,129,0.12)', color: '#10b981',
                                                    }}>{u._count.contracts} contrato{u._count.contracts > 1 ? 's' : ''}</span>
                                                )}
                                                {isSelected && <span style={{ color: '#10b981', fontSize: '1rem' }}>✓</span>}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>

                            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '18px', gap: '10px' }}>
                                <button onClick={resetCreateModal}
                                    style={{ padding: '9px 18px', borderRadius: '10px', background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-secondary)', fontSize: '0.8125rem', fontWeight: 600, cursor: 'pointer' }}>
                                    Cancelar
                                </button>
                                <button disabled={!createForm.userId}
                                    onClick={() => setCreateStep(2)}
                                    style={{
                                        padding: '9px 22px', borderRadius: '10px', border: 'none', fontSize: '0.8125rem', fontWeight: 700, cursor: 'pointer',
                                        background: createForm.userId ? 'linear-gradient(135deg, #10b981, #11819B)' : 'var(--bg-elevated)',
                                        color: createForm.userId ? '#fff' : 'var(--text-muted)',
                                        opacity: createForm.userId ? 1 : 0.5,
                    }}>
                                    Próximo →
                                </button>
                            </div>
                        </div>
                    )}

                    {/* -------- STEP 2: Contract, Date, Slot -------- */}
                    {createStep === 2 && (() => {
                        const TIER_LABEL: Record<string, string> = { COMERCIAL: 'Comercial', AUDIENCIA: 'Audiência', SABADO: 'Sábado' };
                        const DAY_NAMES = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

                        // Determine selected contract and its tier for slot filtering
                        const activeContract = clientContracts.find(c => c.id === createForm.contractId);
                        const filterTier = activeContract?.tier || null; // null = avulso, show all

                        // Check day compatibility for FIXO contracts
                        const selectedDateDOW = createForm.date ? new Date(createForm.date + 'T12:00:00').getDay() : null;
                        const isFixoDayMismatch = activeContract?.type === 'FIXO' && activeContract.fixedDayOfWeek != null && selectedDateDOW !== null && selectedDateDOW !== activeContract.fixedDayOfWeek;

                        // Filter slots by contract tier
                        const filteredSlots = filterTier
                            ? daySlots.filter(s => s.tier === filterTier || !s.available)
                            : daySlots;

                        return (
                        <div>
                            {/* -- Contract Selector (always shown) -- */}
                            <div style={{ marginBottom: '20px' }}>
                                <label style={{ fontSize: '0.6875rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '10px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                    📄 Vincular a Contrato
                                    {clientContracts.length > 0 && <span style={{ fontSize: '0.5625rem', fontWeight: 600, padding: '1px 6px', borderRadius: '4px', background: 'rgba(16,185,129,0.1)', color: '#10b981' }}>{clientContracts.length} ativo{clientContracts.length > 1 ? 's' : ''}</span>}
                                </label>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                    {/* Avulso card */}
                                    <div
                                        onClick={() => setCreateForm({ ...createForm, contractId: '', startTime: '' })}
                                        style={{
                                            padding: '14px 16px', borderRadius: '12px', cursor: 'pointer',
                                            display: 'flex', alignItems: 'center', gap: '14px',
                                            background: !createForm.contractId
                                                ? 'linear-gradient(135deg, rgba(99,102,241,0.08), rgba(67,56,202,0.04))'
                                                : 'var(--bg-elevated)',
                                            border: `1px solid ${!createForm.contractId ? 'rgba(99,102,241,0.35)' : 'var(--border-default)'}`,
                                            transition: 'all 0.2s',
                                        }}
                                    >
                                        <div style={{
                                            width: 40, height: 40, borderRadius: '10px', flexShrink: 0,
                                            background: !createForm.contractId ? 'linear-gradient(135deg, #6366f1, #4f46e5)' : 'var(--bg-secondary)',
                                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                                            fontSize: '1.1rem',
                                        }}>
                                            ⚡
                                        </div>
                                        <div style={{ flex: 1, minWidth: 0 }}>
                                            <div style={{ fontWeight: 700, fontSize: '0.8125rem', color: !createForm.contractId ? '#818cf8' : 'var(--text-primary)' }}>Agendamento Avulso</div>
                                            <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', marginTop: '2px' }}>Cria contrato automático · Todos os horários</div>
                                        </div>
                                        {!createForm.contractId && <span style={{ color: '#818cf8', fontSize: '1.1rem', fontWeight: 700 }}>✓</span>}
                                    </div>

                                    {/* Active contract cards */}
                                    {clientContracts.map(c => {
                                        const isSelected = createForm.contractId === c.id;
                                        const ct = tc(c.tier);
                                        const hasCredits = c.type === 'FLEX' ? (c.flexCreditsRemaining ?? 0) > 0 : true;
                                        const compat = true; // day compat checked after date selection

                                        return (
                                            <div key={c.id}
                                                onClick={() => {
                                                    if (!hasCredits) return;
                                                    setCreateForm({ ...createForm, contractId: c.id, startTime: '' });
                                                }}
                                                style={{
                                                    padding: '14px 16px', borderRadius: '12px',
                                                    cursor: hasCredits ? 'pointer' : 'not-allowed',
                                                    display: 'flex', alignItems: 'center', gap: '14px',
                                                    background: isSelected
                                                        ? `linear-gradient(135deg, ${ct.bg}, rgba(0,0,0,0))`
                                                        : !hasCredits ? 'rgba(255,255,255,0.01)' : 'var(--bg-elevated)',
                                                    border: `1px solid ${isSelected ? ct.color + '55' : 'var(--border-default)'}`,
                                                    opacity: hasCredits ? 1 : 0.4,
                                                    transition: 'all 0.2s',
                                                }}
                                            >
                                                {/* Tier icon */}
                                                <div style={{
                                                    width: 40, height: 40, borderRadius: '10px', flexShrink: 0,
                                                    background: isSelected ? `linear-gradient(135deg, ${ct.color}, ${ct.color}88)` : ct.bg,
                                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                    fontSize: '1.1rem', border: `1px solid ${ct.color}33`,
                                                }}>
                                                    {TIER_EMOJI[c.tier]}
                                                </div>

                                                {/* Contract info */}
                                                <div style={{ flex: 1, minWidth: 0 }}>
                                                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                                                        <span style={{ fontWeight: 700, fontSize: '0.8125rem', color: isSelected ? ct.color : 'var(--text-primary)' }}>{c.name}</span>
                                                        <span style={{
                                                            fontSize: '0.5625rem', fontWeight: 700, padding: '1px 6px', borderRadius: '4px',
                                                            background: ct.bg, color: ct.color,
                                                        }}>{TIER_LABEL[c.tier] || c.tier}</span>
                                                        <span style={{
                                                            fontSize: '0.5625rem', fontWeight: 600, padding: '1px 6px', borderRadius: '4px',
                                                            background: c.type === 'FIXO' ? 'rgba(245,158,11,0.1)' : 'rgba(59,130,246,0.1)',
                                                            color: c.type === 'FIXO' ? '#f59e0b' : '#3b82f6',
                                                        }}>{c.type === 'FIXO' ? '📌 Fixo' : '🔄 Flex'}</span>
                                                    </div>
                                                    <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', marginTop: '3px', display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                                                        {c.type === 'FIXO' && c.fixedDayOfWeek != null && (
                                                            <span>📅 {DAY_NAMES[c.fixedDayOfWeek]} {c.fixedTime ? `às ${c.fixedTime}` : ''}</span>
                                                        )}
                                                        {c.type === 'FLEX' && c.flexCreditsRemaining != null && (
                                                            <span style={{ color: c.flexCreditsRemaining > 0 ? '#10b981' : '#ef4444', fontWeight: 600 }}>
                                                                {c.flexCreditsRemaining > 0 ? `✅ ${c.flexCreditsRemaining} crédito${c.flexCreditsRemaining > 1 ? 's' : ''} restante${c.flexCreditsRemaining > 1 ? 's' : ''}` : '❌ Sem créditos'}
                                                            </span>
                                                        )}
                                                        {!hasCredits && <span style={{ color: '#ef4444', fontWeight: 600 }}>Créditos esgotados</span>}
                                                    </div>
                                                </div>

                                                {isSelected && <span style={{ color: ct.color, fontSize: '1.1rem', fontWeight: 700 }}>✓</span>}
                                            </div>
                                        );
                                    })}

                                    {clientContracts.length === 0 && (
                                        <div style={{
                                            padding: '16px', borderRadius: '10px', textAlign: 'center',
                                            background: 'rgba(245,158,11,0.05)', border: '1px solid rgba(245,158,11,0.15)',
                                            color: '#f59e0b', fontSize: '0.8125rem', fontWeight: 600,
                                        }}>
                                            ⚠️ Cliente sem contratos ativos · Será criado contrato avulso
                                        </div>
                                    )}
                                </div>
                            </div>

                            {/* -- Date -- */}
                            <div style={{ marginBottom: '18px' }}>
                                <label style={{ fontSize: '0.6875rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '8px', display: 'block' }}>
                                    📅 Data da gravação
                                </label>
                                <input type="date" value={createForm.date}
                                    min={new Date().toISOString().split('T')[0]}
                                    onChange={e => {
                                        const newDate = e.target.value;
                                        setCreateForm({ ...createForm, date: newDate, startTime: '' });
                                        if (newDate) loadDaySlots(newDate);
                                    }}
                                    style={{
                                        width: '100%', padding: '10px 14px', borderRadius: '10px', fontSize: '0.875rem', fontWeight: 600,
                                        background: 'var(--bg-elevated)', border: '1px solid var(--border-default)',
                                        color: 'var(--text-primary)', outline: 'none',
                                    }}
                                />
                                {/* FIXO day mismatch warning */}
                                {isFixoDayMismatch && (
                                    <div style={{
                                        marginTop: '8px', padding: '8px 12px', borderRadius: '8px',
                                        background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)',
                                        fontSize: '0.75rem', color: '#f59e0b', fontWeight: 600,
                                        display: 'flex', alignItems: 'center', gap: '6px',
                                    }}>
                                        ⚠️ Contrato {activeContract?.name} é fixo em <strong>{DAY_NAMES[activeContract!.fixedDayOfWeek!]}</strong>. A data selecionada é {DAY_NAMES[selectedDateDOW!]}.
                                    </div>
                                )}
                            </div>

                            {/* -- Filtered Slot Grid -- */}
                            {createForm.date && (
                                <div>
                                    <label style={{ fontSize: '0.6875rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '10px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                        🔓 Horário disponível
                                        {filterTier && (
                                            <span style={{
                                                fontSize: '0.5625rem', fontWeight: 700, padding: '1px 8px', borderRadius: '4px',
                                                background: tc(filterTier).bg, color: tc(filterTier).color,
                                            }}>
                                                {TIER_EMOJI[filterTier]} Filtrado: {TIER_LABEL[filterTier]}
                                            </span>
                                        )}
                                    </label>
                                    {slotsLoading ? (
                                        <div style={{ padding: '24px', textAlign: 'center' }}><div className="spinner" style={{ width: 24, height: 24, margin: '0 auto' }} /></div>
                                    ) : filteredSlots.filter(s => s.available).length === 0 ? (
                                        <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.8125rem', background: 'var(--bg-elevated)', borderRadius: 10 }}>
                                            {filterTier
                                                ? `Nenhum horário ${TIER_LABEL[filterTier]} disponível nesta data`
                                                : 'Nenhum horário disponível nesta data'}
                                        </div>
                                    ) : (
                                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: '6px' }}>
                                            {filteredSlots.map(slot => {
                                                const isSelected = createForm.startTime === slot.time;
                                                const slotTc = tc(slot.tier || 'COMERCIAL');
                                                return (
                                                    <button key={slot.time}
                                                        disabled={!slot.available}
                                                        onClick={() => { setCreateForm({ ...createForm, startTime: slot.time }); if (!createForm.contractId && slot.price != null) { setCustomPrice(slot.price); setPriceDisplay((slot.price / 100).toFixed(2).replace('.', ',')); } }}
                                                        style={{
                                                            padding: '10px 8px', borderRadius: '10px', cursor: slot.available ? 'pointer' : 'not-allowed',
                                                            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px',
                                                            background: isSelected ? slotTc.bg : !slot.available ? 'rgba(255,255,255,0.02)' : 'var(--bg-elevated)',
                                                            border: `1px solid ${isSelected ? slotTc.color + '55' : 'var(--border-default)'}`,
                                                            opacity: slot.available ? 1 : 0.35,
                                                            transition: 'all 0.15s',
                                                        }}
                                                    >
                                                        <span style={{ fontSize: '0.875rem', fontWeight: 700, color: isSelected ? slotTc.color : 'var(--text-primary)' }}>
                                                            {slot.time}
                                                        </span>
                                                        <span style={{
                                                            fontSize: '0.5625rem', fontWeight: 600, padding: '1px 6px', borderRadius: '4px',
                                                            background: slot.available ? slotTc.bg : 'rgba(255,255,255,0.05)',
                                                            color: slot.available ? slotTc.color : 'var(--text-muted)',
                                                        }}>
                                                            {slot.available ? `${TIER_EMOJI[slot.tier || 'COMERCIAL']} ${slot.tier}` : 'Ocupado'}
                                                        </span>
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    )}
                                </div>
                            )}

                            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '20px' }}>
                                <button onClick={() => setCreateStep(1)}
                                    style={{ padding: '9px 18px', borderRadius: '10px', background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-secondary)', fontSize: '0.8125rem', fontWeight: 600, cursor: 'pointer' }}>
                                    ← Voltar
                                </button>
                                <button disabled={!createForm.date || !createForm.startTime}
                                    onClick={() => setCreateStep(3)}
                                    style={{
                                        padding: '9px 22px', borderRadius: '10px', border: 'none', fontSize: '0.8125rem', fontWeight: 700, cursor: 'pointer',
                                        background: createForm.date && createForm.startTime ? 'linear-gradient(135deg, #10b981, #11819B)' : 'var(--bg-elevated)',
                                        color: createForm.date && createForm.startTime ? '#fff' : 'var(--text-muted)',
                                        opacity: createForm.date && createForm.startTime ? 1 : 0.5,
                                    }}>
                                    Próximo →
                                </button>
                            </div>
                        </div>
                        );
                    })()}

                    {/* -------- STEP 3: Confirm -------- */}
                    {createStep === 3 && (
                        <div>
                            {/* Summary card */}
                            <div style={{
                                padding: '18px', borderRadius: '14px', marginBottom: '18px',
                                background: 'var(--bg-elevated)', border: '1px solid rgba(16,185,129,0.15)',
                            }}>
                                <div style={{ fontSize: '0.625rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '14px' }}>
                                    Resumo do Agendamento
                                </div>

                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 20px' }}>
                                    <div>
                                        <div style={{ fontSize: '0.625rem', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '3px' }}>Cliente</div>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                            <div style={{
                                                width: 28, height: 28, borderRadius: '50%', background: 'linear-gradient(135deg, #10b981, #11819B)',
                                                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.6875rem', fontWeight: 700, color: '#fff',
                                            }}>{selectedUser?.name?.charAt(0).toUpperCase()}</div>
                                            <span style={{ fontWeight: 600, fontSize: '0.8125rem' }}>{selectedUser?.name}</span>
                                        </div>
                                    </div>
                                    <div>
                                        <div style={{ fontSize: '0.625rem', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '3px' }}>Data</div>
                                        <div style={{ fontWeight: 700, fontSize: '0.875rem' }}>
                                            {createForm.date ? new Date(createForm.date + 'T12:00:00').toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' }) : '—'}
                                        </div>
                                    </div>
                                    <div>
                                        <div style={{ fontSize: '0.625rem', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '3px' }}>Horário</div>
                                        <div style={{ fontWeight: 700, fontSize: '1rem' }}>{createForm.startTime || '—'}</div>
                                    </div>
                                    <div>
                                        <div style={{ fontSize: '0.625rem', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '3px' }}>Faixa</div>
                                        {selectedSlot?.tier ? (
                                            <span style={{
                                                display: 'inline-flex', alignItems: 'center', gap: '4px',
                                                padding: '2px 10px', borderRadius: '6px', fontSize: '0.6875rem', fontWeight: 700,
                                                background: tc(selectedSlot.tier).bg, color: tc(selectedSlot.tier).color,
                                            }}>
                                                {TIER_EMOJI[selectedSlot.tier]} {selectedSlot.tier}
                                            </span>
                                        ) : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                                    </div>
                                    <div style={{ gridColumn: '1 / -1' }}>
                                        <div style={{ fontSize: '0.625rem', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '3px' }}>Contrato</div>
                                        <div style={{ fontWeight: 600, fontSize: '0.8125rem' }}>
                                            {selectedContract ? `${TIER_EMOJI[selectedContract.tier]} ${selectedContract.name}` : '⚡ Avulso (contrato automático)'}
                                        </div>
                                    </div>
                                    {/* Editable price for Avulso */}
                                    {!createForm.contractId && (
                                        <div style={{ gridColumn: '1 / -1', marginTop: '4px' }}>
                                            <div style={{ fontSize: '0.625rem', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '6px' }}>💰 Valor do Agendamento</div>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                                <div style={{ position: 'relative', flex: 1, maxWidth: '200px' }}>
                                                    <span style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', fontSize: '0.8125rem', fontWeight: 700, color: '#10b981' }}>R$</span>
                                                    <input
                                                        type="text"
                                                        value={priceDisplay}
                                                        onChange={e => setPriceDisplay(e.target.value.replace(/[^\d,]/g, ''))}
                                                        style={{
                                                            width: '100%', padding: '8px 12px 8px 38px', borderRadius: '10px',
                                                            fontSize: '1.125rem', fontWeight: 800, fontVariantNumeric: 'tabular-nums',
                                                            background: 'var(--bg-elevated)', border: '1px solid rgba(16,185,129,0.3)',
                                                            color: '#10b981', outline: 'none', fontFamily: 'inherit',
                                                        }}
                                                        onFocus={e => (e.currentTarget.style.borderColor = '#10b981')}
                                                        onBlur={e => {
                                                            e.currentTarget.style.borderColor = 'rgba(16,185,129,0.3)';
                                                            const num = parseFloat(priceDisplay.replace(',', '.'));
                                                            if (!isNaN(num) && num >= 0) {
                                                                setCustomPrice(Math.round(num * 100));
                                                                setPriceDisplay(num.toFixed(2).replace('.', ','));
                                                            } else {
                                                                setCustomPrice(0);
                                                                setPriceDisplay('0,00');
                                                            }
                                                        }}
                                                    />
                                                </div>
                                                <span style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                                                    Editável · Apenas para este agendamento
                                                </span>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>

                            {/* Serviços por gravação — herdam o desconto do contrato (avulso = 0%) */}
                            {addons.length > 0 && (
                                <div style={{ marginBottom: '14px' }}>
                                    <label style={{ fontSize: '0.6875rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                        ✨ Serviços desta gravação
                                        {selectedContract && inheritedDiscount > 0 && (
                                            <span style={{ fontSize: '0.5625rem', fontWeight: 700, padding: '1px 6px', borderRadius: '4px', background: 'rgba(45,212,191,0.12)', color: '#2dd4bf' }}>-{inheritedDiscount}% do contrato</span>
                                        )}
                                    </label>
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                        {addons.map(addon => {
                                            const selected = selectedAddons.includes(addon.key);
                                            const perRecording = Math.round(addon.price * (1 - inheritedDiscount / 100));
                                            return (
                                                <ServiceLineItem
                                                    key={addon.key}
                                                    name={addon.name}
                                                    perRecordingCents={perRecording}
                                                    compact
                                                    selected={selected}
                                                    onToggle={() => setSelectedAddons(prev => selected ? prev.filter(k => k !== addon.key) : [...prev, addon.key])}
                                                />
                                            );
                                        })}
                                    </div>
                                    {servicesValue > 0 && (
                                        <div style={{ marginTop: 8, fontSize: '0.75rem', color: '#2dd4bf', fontWeight: 700, textAlign: 'right' }}>
                                            +{formatBRL(servicesValue)} em serviços {createForm.contractId ? '(somados a esta gravação)' : '(somados ao valor)'}
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* Avulso: cobrar agora (mesmo InlineCheckout do cliente) */}
                            {!createForm.contractId && (
                                <div style={{ marginBottom: '14px' }}>
                                    <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', padding: '12px 14px', borderRadius: '10px', background: chargeNow ? 'rgba(99,102,241,0.06)' : 'var(--bg-elevated)', border: `1px solid ${chargeNow ? 'rgba(99,102,241,0.3)' : 'var(--border-default)'}` }}>
                                        <input type="checkbox" checked={chargeNow} onChange={e => setChargeNow(e.target.checked)} style={{ width: 18, height: 18, accentColor: '#818cf8', cursor: 'pointer' }} />
                                        <div>
                                            <div style={{ fontSize: '0.8125rem', fontWeight: 600 }}>💳 Cobrar o cliente agora</div>
                                            <div style={{ fontSize: '0.625rem', color: 'var(--text-muted)', marginTop: '2px' }}>Gera PIX ou cobra o cartão do cliente (presente). Sem marcar, segue o status escolhido.</div>
                                        </div>
                                    </label>
                                    {chargeNow && (
                                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginTop: '8px' }}>
                                            {([{ key: 'PIX' as const, icon: '⚡', label: 'PIX' }, { key: 'CARTAO' as const, icon: '💳', label: 'Cartão' }]).map(m => {
                                                const active = chargeMethod === m.key;
                                                return (
                                                    <button key={m.key} onClick={() => setChargeMethod(m.key)} style={{ padding: '10px', borderRadius: '10px', cursor: 'pointer', textAlign: 'center', background: active ? 'rgba(99,102,241,0.08)' : 'var(--bg-elevated)', border: `1.5px solid ${active ? 'rgba(99,102,241,0.3)' : 'var(--border-default)'}` }}>
                                                        <span style={{ fontSize: '0.875rem' }}>{m.icon}</span> <span style={{ fontSize: '0.75rem', fontWeight: 700, color: active ? '#818cf8' : 'var(--text-primary)' }}>{m.label}</span>
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    )}
                                </div>
                            )}
                            {/* Status */}
                            <div style={{ marginBottom: '14px' }}>
                                <label style={{ fontSize: '0.6875rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '8px', display: 'block' }}>Status inicial</label>
                                <div style={{ display: 'flex', gap: '6px' }}>
                                    {[{ key: 'CONFIRMED', label: '✅ Confirmado' }, { key: 'RESERVED', label: '⏳ Reservado' }].map(s => (
                                        <button key={s.key}
                                            onClick={() => setCreateForm({ ...createForm, status: s.key })}
                                            style={{
                                                padding: '8px 16px', borderRadius: '8px', fontSize: '0.8125rem', fontWeight: 600, cursor: 'pointer',
                                                background: createForm.status === s.key ? 'rgba(16,185,129,0.12)' : 'var(--bg-elevated)',
                                                border: `1px solid ${createForm.status === s.key ? 'rgba(16,185,129,0.3)' : 'var(--border-default)'}`,
                                                color: createForm.status === s.key ? '#10b981' : 'var(--text-secondary)',
                                            }}>
                                            {s.label}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {/* Admin notes */}
                            <div style={{ marginBottom: '14px' }}>
                                <label style={{ fontSize: '0.6875rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '8px', display: 'block' }}>
                                    📝 Notas internas (opcional)
                                </label>
                                <textarea
                                    value={createForm.adminNotes}
                                    onChange={e => setCreateForm({ ...createForm, adminNotes: e.target.value })}
                                    placeholder="Observações internas sobre esta gravação..."
                                    rows={3}
                                    style={{
                                        width: '100%', padding: '10px 14px', borderRadius: '10px', fontSize: '0.8125rem',
                                        background: 'var(--bg-elevated)', border: '1px solid var(--border-default)',
                                        color: 'var(--text-primary)', outline: 'none', resize: 'vertical', fontFamily: 'inherit',
                                    }}
                                />
                            </div>

                            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '20px' }}>
                                <button onClick={() => setCreateStep(2)}
                                    style={{ padding: '9px 18px', borderRadius: '10px', background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-secondary)', fontSize: '0.8125rem', fontWeight: 600, cursor: 'pointer' }}>
                                    ← Voltar
                                </button>
                                <button onClick={handleCreate} disabled={creating}
                                    style={{
                                        padding: '10px 28px', borderRadius: '10px', border: 'none', fontSize: '0.875rem', fontWeight: 700, cursor: 'pointer',
                                        background: 'linear-gradient(135deg, #10b981, #11819B)', color: '#fff',
                                        opacity: creating ? 0.6 : 1, display: 'flex', alignItems: 'center', gap: '8px',
                                    }}>
                                    {creating ? '⏳ Criando...' : '📅 Agendar'}
                                </button>
                            </div>
                        </div>
                    )}
                </div>
        </BottomSheetModal>
    );
}

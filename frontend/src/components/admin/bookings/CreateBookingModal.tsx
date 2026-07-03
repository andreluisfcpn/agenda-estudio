import { getErrorMessage } from '../../../utils/errors';
import { useState, useCallback, useEffect } from 'react';
import { bookingsApi, contractsApi, pricingApi, UserSummary, Contract, Slot, AddOnConfig, CouponValidation } from '../../../api/client';
import { useUI } from '../../../context/UIContext';
import BottomSheetModal from '../../BottomSheetModal';
import CouponField from '../../CouponField';
import ServiceLineItem from '../../ui/ServiceLineItem';
import { formatBRL, DAY_NAMES } from '../../../utils/format';
import { TIER_META } from '../../../constants/adminMeta';
import WizardSteps from '../WizardSteps';
import ChargeNowSheet from '../ChargeNowSheet';
import {
    Search, FileText, CalendarDays, Zap, Wallet, TicketPercent, Sparkles,
    CreditCard, Check, NotebookPen, CheckCircle2, Clock as ClockIcon, AlertTriangle,
} from 'lucide-react';


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
    // Cupom (só avulso — elegibilidade é do CLIENTE selecionado) + valor já descontado retornado pelo backend.
    const [appliedCoupon, setAppliedCoupon] = useState<CouponValidation | null>(null);
    const [chargeAmountApi, setChargeAmountApi] = useState<number | null>(null);

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
        setAppliedCoupon(null);
        setChargeAmountApi(null);
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
            // Cupom só vale para avulso (contrato tem fluxo próprio).
            if (!createForm.contractId && appliedCoupon) payload.couponCode = appliedCoupon.code;
            const res = await bookingsApi.adminCreate(payload);
            onCreated();
            if (isAvulsoCharge && res.paymentId) {
                // Open the same InlineCheckout the client uses — charges the CLIENT (payment.userId).
                // O backend retorna o valor JÁ com o cupom descontado (paymentAmount).
                setChargeAmountApi(res.paymentAmount ?? null);
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
            <ChargeNowSheet
                paymentId={chargePaymentId}
                amount={chargeAmountApi ?? ((customPrice || 0) + servicesValue)}
                description="Agendamento avulso"
                title="Cobrar agendamento"
                subtitle={`${chargeMethod === 'PIX' ? 'Mostre o QR Code PIX ao cliente.' : 'Use o cartão do cliente (presente).'} A reserva confirma ao pagar.`}
                allowedMethods={[chargeMethod]}
                context="avulso"
                error={createError || undefined}
                onError={(msg) => setCreateError(msg)}
                onSuccess={() => { resetCreateModal(); showToast('Pagamento confirmado!'); }}
                onDismiss={() => { resetCreateModal(); showToast('Agendamento criado (pagamento pendente).'); }}
                dismissLabel="Fechar (deixar pendente)"
            />
        );
    }

    return (
        <BottomSheetModal isOpen onClose={resetCreateModal} hideHeader size="lg" className="admin-sheet" title="Novo Agendamento">
                {/* --- HEADER --- */}
                <div className="admin-modal-head">
                    <h2 className="admin-modal-title">
                        <span className="admin-modal-title__icon">➕</span>
                        Novo Agendamento
                    </h2>

                    {/* Step indicator */}
                    <WizardSteps steps={stepLabels} current={createStep} onStepClick={setCreateStep} />
                </div>

                <div className="admin-modal-body">
                    {createError && <div className="admin-alert admin-alert--danger" role="alert" style={{ marginBottom: '16px' }}>{createError}</div>}

                    {/* -------- STEP 1: Select Client -------- */}
                    {createStep === 1 && (
                        <div>
                            <div className="admin-search" style={{ marginBottom: '14px' }}>
                                <input
                                    type="text" placeholder="Buscar cliente por nome ou e-mail..."
                                    aria-label="Buscar cliente por nome ou e-mail"
                                    value={createSearch} onChange={e => setCreateSearch(e.target.value)} autoFocus
                                />
                                <Search size={14} className="admin-search__icon" aria-hidden="true" />
                            </div>

                            <div style={{ maxHeight: '340px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                {filteredClients.length === 0 ? (
                                    <div style={{ padding: '32px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.8125rem' }}>
                                        Nenhum cliente encontrado
                                    </div>
                                ) : filteredClients.map(u => {
                                    const isSelected = createForm.userId === u.id;
                                    return (
                                        <button type="button" key={u.id}
                                            className={`admin-select-row${isSelected ? ' admin-select-row--active' : ''}`}
                                            aria-pressed={isSelected}
                                            onClick={() => {
                                                setCreateForm({ ...createForm, userId: u.id, contractId: '' });
                                                loadClientContracts(u.id);
                                            }}
                                        >
                                            <div style={{
                                                width: 36, height: 36, borderRadius: '50%',
                                                background: isSelected ? 'var(--accent-gradient-go)' : 'var(--bg-elevated)',
                                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                fontSize: '0.8125rem', fontWeight: 700, color: isSelected ? '#fff' : 'var(--text-muted)',
                                                flexShrink: 0,
                                            }}>
                                                {u.name.charAt(0).toUpperCase()}
                                            </div>
                                            <div style={{ flex: 1, minWidth: 0 }}>
                                                <div style={{ fontWeight: 600, fontSize: '0.8125rem', color: isSelected ? 'var(--success)' : 'var(--text-primary)' }}>{u.name}</div>
                                                <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.email}</div>
                                            </div>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                                {u._count.contracts > 0 && (
                                                    <span style={{
                                                        padding: '2px 8px', borderRadius: '6px', fontSize: '0.625rem', fontWeight: 700,
                                                        background: 'var(--success-bg)', color: 'var(--success)',
                                                    }}>{u._count.contracts} contrato{u._count.contracts > 1 ? 's' : ''}</span>
                                                )}
                                                {isSelected && <Check size={16} style={{ color: 'var(--success)' }} aria-hidden="true" />}
                                            </div>
                                        </button>
                                    );
                                })}
                            </div>

                            <div className="admin-actions-row" style={{ marginTop: '18px' }}>
                                <button onClick={resetCreateModal} className="btn-admin-ghost">
                                    Cancelar
                                </button>
                                <button disabled={!createForm.userId}
                                    onClick={() => setCreateStep(2)}
                                    className="btn-admin-go">
                                    Próximo →
                                </button>
                            </div>
                        </div>
                    )}

                    {/* -------- STEP 2: Contract, Date, Slot -------- */}
                    {createStep === 2 && (() => {
                        const TIER_LABEL: Record<string, string> = { COMERCIAL: 'Comercial', AUDIENCIA: 'Audiência', SABADO: 'Sábado' };

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
                                    <FileText size={13} aria-hidden="true" /> Vincular a Contrato
                                    {clientContracts.length > 0 && <span style={{ fontSize: '0.5625rem', fontWeight: 600, padding: '1px 6px', borderRadius: '4px', background: 'rgba(16,185,129,0.1)', color: 'var(--success)' }}>{clientContracts.length} ativo{clientContracts.length > 1 ? 's' : ''}</span>}
                                </label>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                    {/* Avulso card */}
                                    <div
                                        role="button" tabIndex={0}
                                        aria-pressed={!createForm.contractId}
                                        onClick={() => setCreateForm({ ...createForm, contractId: '', startTime: '' })}
                                        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setCreateForm({ ...createForm, contractId: '', startTime: '' }); } }}
                                        style={{
                                            padding: '14px 16px', borderRadius: '12px', cursor: 'pointer',
                                            display: 'flex', alignItems: 'center', gap: '14px',
                                            background: !createForm.contractId
                                                ? 'linear-gradient(135deg, rgba(17,129,155,0.12), rgba(9,110,133,0.04))'
                                                : 'var(--bg-elevated)',
                                            border: `1px solid ${!createForm.contractId ? 'rgba(17,129,155,0.45)' : 'var(--border-default)'}`,
                                            transition: 'background 0.2s ease, border-color 0.2s ease',
                                        }}
                                    >
                                        <div style={{
                                            width: 40, height: 40, borderRadius: '10px', flexShrink: 0,
                                            background: !createForm.contractId ? 'var(--accent-gradient)' : 'var(--bg-secondary)',
                                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                                            fontSize: '1.1rem',
                                        }}>
                                            <Zap size={18} aria-hidden="true" />
                                        </div>
                                        <div style={{ flex: 1, minWidth: 0 }}>
                                            <div style={{ fontWeight: 700, fontSize: '0.8125rem', color: !createForm.contractId ? 'var(--accent-text)' : 'var(--text-primary)' }}>Agendamento Avulso</div>
                                            <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', marginTop: '2px' }}>Cria contrato automático · Todos os horários</div>
                                        </div>
                                        {!createForm.contractId && <Check size={17} style={{ color: 'var(--accent-text)' }} aria-hidden="true" />}
                                    </div>

                                    {/* Active contract cards */}
                                    {clientContracts.map(c => {
                                        const isSelected = createForm.contractId === c.id;
                                        const ct = tc(c.tier);
                                        const hasCredits = c.type === 'FLEX' ? (c.flexCreditsRemaining ?? 0) > 0 : true;
                                        const compat = true; // day compat checked after date selection

                                        return (
                                            <div key={c.id}
                                                role="button" tabIndex={hasCredits ? 0 : -1}
                                                aria-pressed={isSelected}
                                                aria-disabled={!hasCredits}
                                                onClick={() => {
                                                    if (!hasCredits) return;
                                                    setCreateForm({ ...createForm, contractId: c.id, startTime: '' });
                                                }}
                                                onKeyDown={e => { if (hasCredits && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setCreateForm({ ...createForm, contractId: c.id, startTime: '' }); } }}
                                                style={{
                                                    padding: '14px 16px', borderRadius: '12px',
                                                    cursor: hasCredits ? 'pointer' : 'not-allowed',
                                                    display: 'flex', alignItems: 'center', gap: '14px',
                                                    background: isSelected
                                                        ? `linear-gradient(135deg, ${ct.bg}, rgba(0,0,0,0))`
                                                        : !hasCredits ? 'rgba(255,255,255,0.01)' : 'var(--bg-elevated)',
                                                    border: `1px solid ${isSelected ? ct.color + '55' : 'var(--border-default)'}`,
                                                    opacity: hasCredits ? 1 : 0.4,
                                                    transition: 'background 0.2s ease, border-color 0.2s ease, opacity 0.2s ease',
                                                }}
                                            >
                                                {/* Tier icon */}
                                                <div style={{
                                                    width: 40, height: 40, borderRadius: '10px', flexShrink: 0,
                                                    background: isSelected ? `linear-gradient(135deg, ${ct.color}, ${ct.color}88)` : ct.bg,
                                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                    fontSize: '1.1rem', border: `1px solid ${ct.color}33`,
                                                }}>
                                                    <ct.icon size={18} aria-hidden="true" />
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
                                                            color: c.type === 'FIXO' ? 'var(--warning)' : 'var(--info)',
                                                        }}>{c.type === 'FIXO' ? '📌 Fixo' : '🔄 Flex'}</span>
                                                    </div>
                                                    <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', marginTop: '3px', display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                                                        {c.type === 'FIXO' && c.fixedDayOfWeek != null && (
                                                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><CalendarDays size={12} aria-hidden="true" /> {DAY_NAMES[c.fixedDayOfWeek]} {c.fixedTime ? `às ${c.fixedTime}` : ''}</span>
                                                        )}
                                                        {c.type === 'FLEX' && c.flexCreditsRemaining != null && (
                                                            <span style={{ color: c.flexCreditsRemaining > 0 ? 'var(--success)' : 'var(--danger)', fontWeight: 600 }}>
                                                                {c.flexCreditsRemaining > 0 ? `✅ ${c.flexCreditsRemaining} crédito${c.flexCreditsRemaining > 1 ? 's' : ''} restante${c.flexCreditsRemaining > 1 ? 's' : ''}` : '❌ Sem créditos'}
                                                            </span>
                                                        )}
                                                        {!hasCredits && <span style={{ color: 'var(--danger)', fontWeight: 600 }}>Créditos esgotados</span>}
                                                    </div>
                                                </div>

                                                {isSelected && <Check size={17} style={{ color: ct.color }} aria-hidden="true" />}
                                            </div>
                                        );
                                    })}

                                    {clientContracts.length === 0 && (
                                        <div style={{
                                            padding: '16px', borderRadius: '10px', textAlign: 'center',
                                            background: 'rgba(245,158,11,0.05)', border: '1px solid rgba(245,158,11,0.15)',
                                            color: 'var(--warning)', fontSize: '0.8125rem', fontWeight: 600,
                                        }}>
                                            ⚠️ Cliente sem contratos ativos · Será criado contrato avulso
                                        </div>
                                    )}
                                </div>
                            </div>

                            {/* -- Date -- */}
                            <div style={{ marginBottom: '18px' }}>
                                <label style={{ fontSize: '0.6875rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '8px', display: 'block' }}>
                                    <CalendarDays size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} aria-hidden="true" />Data da gravação
                                </label>
                                <input type="date" value={createForm.date}
                                    min={new Date().toISOString().split('T')[0]}
                                    aria-label="Data da gravação"
                                    onChange={e => {
                                        const newDate = e.target.value;
                                        setCreateForm({ ...createForm, date: newDate, startTime: '' });
                                        if (newDate) loadDaySlots(newDate);
                                    }}
                                    className="form-input form-input--raised"
                                />
                                {/* FIXO day mismatch warning */}
                                {isFixoDayMismatch && (
                                    <div style={{
                                        marginTop: '8px', padding: '8px 12px', borderRadius: '8px',
                                        background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)',
                                        fontSize: '0.75rem', color: 'var(--warning)', fontWeight: 600, lineHeight: 1.5,
                                    }}>
                                        <AlertTriangle size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} aria-hidden="true" />Contrato {activeContract?.name} é fixo em <strong>{DAY_NAMES[activeContract!.fixedDayOfWeek!]}</strong>. A data selecionada é {DAY_NAMES[selectedDateDOW!]}.
                                    </div>
                                )}
                            </div>

                            {/* -- Filtered Slot Grid -- */}
                            {createForm.date && (
                                <div>
                                    <label style={{ fontSize: '0.6875rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '10px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                        Horário disponível
                                        {filterTier && (
                                            <span style={{
                                                fontSize: '0.5625rem', fontWeight: 700, padding: '1px 8px', borderRadius: '4px',
                                                background: tc(filterTier).bg, color: tc(filterTier).color,
                                            }}>
                                                Filtrado: {TIER_LABEL[filterTier]}
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
                                                            transition: 'background 0.15s ease, border-color 0.15s ease',
                                                            fontFamily: 'inherit',
                                                        }}
                                                        aria-pressed={isSelected}
                                                    >
                                                        <span style={{ fontSize: '0.875rem', fontWeight: 700, color: isSelected ? slotTc.color : 'var(--text-primary)' }}>
                                                            {slot.time}
                                                        </span>
                                                        <span style={{
                                                            fontSize: '0.5625rem', fontWeight: 600, padding: '1px 6px', borderRadius: '4px',
                                                            background: slot.available ? slotTc.bg : 'rgba(255,255,255,0.05)',
                                                            color: slot.available ? slotTc.color : 'var(--text-muted)',
                                                        }}>
                                                            {slot.available ? slot.tier : 'Ocupado'}
                                                        </span>
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    )}
                                </div>
                            )}

                            <div className="admin-actions-row admin-actions-row--between" style={{ marginTop: '20px' }}>
                                <button onClick={() => setCreateStep(1)} className="btn-admin-ghost">
                                    ← Voltar
                                </button>
                                <button disabled={!createForm.date || !createForm.startTime}
                                    onClick={() => setCreateStep(3)}
                                    className="btn-admin-go">
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

                                <div className="admin-grid-2" style={{ gap: '12px 20px' }}>
                                    <div>
                                        <div style={{ fontSize: '0.625rem', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '3px' }}>Cliente</div>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                            <div style={{
                                                width: 28, height: 28, borderRadius: '50%', background: 'var(--accent-gradient-go)',
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
                                                {(() => { const TI = tc(selectedSlot.tier).icon; return <TI size={12} aria-hidden="true" />; })()} {selectedSlot.tier}
                                            </span>
                                        ) : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                                    </div>
                                    <div style={{ gridColumn: '1 / -1' }}>
                                        <div style={{ fontSize: '0.625rem', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '3px' }}>Contrato</div>
                                        <div style={{ fontWeight: 600, fontSize: '0.8125rem' }}>
                                            {selectedContract ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>{(() => { const TI = tc(selectedContract.tier).icon; return <TI size={13} aria-hidden="true" />; })()} {selectedContract.name}</span> : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Zap size={13} aria-hidden="true" /> Avulso (contrato automático)</span>}
                                        </div>
                                    </div>
                                    {/* Editable price for Avulso */}
                                    {!createForm.contractId && (
                                        <div style={{ gridColumn: '1 / -1', marginTop: '4px' }}>
                                            <div style={{ fontSize: '0.625rem', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '6px' }}><Wallet size={12} style={{ verticalAlign: '-2px', marginRight: 4 }} aria-hidden="true" />Valor do Agendamento</div>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                                <div style={{ position: 'relative', flex: 1, maxWidth: '200px' }}>
                                                    <span style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', fontSize: '0.8125rem', fontWeight: 700, color: 'var(--success)' }}>R$</span>
                                                    <input
                                                        type="text"
                                                        value={priceDisplay}
                                                        onChange={e => setPriceDisplay(e.target.value.replace(/[^\d,]/g, ''))}
                                                        style={{
                                                            width: '100%', padding: '8px 12px 8px 38px', borderRadius: '10px',
                                                            fontSize: '1.125rem', fontWeight: 800, fontVariantNumeric: 'tabular-nums',
                                                            background: 'var(--bg-elevated)', border: '1px solid rgba(16,185,129,0.3)',
                                                            color: 'var(--success)', outline: 'none', fontFamily: 'inherit',
                                                        }}
                                                        onFocus={e => (e.currentTarget.style.borderColor = 'var(--success)')}
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
                                    {/* Linha do cupom aplicado (só avulso) */}
                                    {!createForm.contractId && appliedCoupon && (
                                        <div style={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.8125rem', fontWeight: 700, color: 'var(--success)' }}>
                                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><TicketPercent size={13} aria-hidden="true" /> Cupom {appliedCoupon.code}</span>
                                            <span>−{formatBRL(appliedCoupon.discountAmount)}</span>
                                        </div>
                                    )}
                                </div>
                            </div>

                            {/* Serviços por gravação — herdam o desconto do contrato (avulso = 0%) */}
                            {addons.length > 0 && (
                                <div style={{ marginBottom: '14px' }}>
                                    <label style={{ fontSize: '0.6875rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                        <Sparkles size={13} aria-hidden="true" /> Serviços desta gravação
                                        {selectedContract && inheritedDiscount > 0 && (
                                            <span style={{ fontSize: '0.5625rem', fontWeight: 700, padding: '1px 6px', borderRadius: '4px', background: 'rgba(45,212,191,0.12)', color: 'var(--accent-text)' }}>-{inheritedDiscount}% do contrato</span>
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
                                        <div style={{ marginTop: 8, fontSize: '0.75rem', color: 'var(--accent-text)', fontWeight: 700, textAlign: 'right' }}>
                                            +{formatBRL(servicesValue)} em serviços {createForm.contractId ? '(somados a esta gravação)' : '(somados ao valor)'}
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* Cupom de desconto (só avulso — elegibilidade validada para o CLIENTE selecionado) */}
                            {!createForm.contractId && (
                                <div style={{ marginBottom: '14px' }}>
                                    <CouponField
                                        amount={(customPrice || 0) + servicesValue}
                                        userId={createForm.userId || undefined}
                                        applied={appliedCoupon}
                                        onApply={setAppliedCoupon}
                                        onRemove={() => setAppliedCoupon(null)}
                                        disabled={creating}
                                    />
                                </div>
                            )}

                            {/* Avulso: cobrar agora (mesmo InlineCheckout do cliente) */}
                            {!createForm.contractId && (
                                <div style={{ marginBottom: '14px' }}>
                                    <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', padding: '12px 14px', borderRadius: '10px', background: chargeNow ? 'rgba(17,129,155,0.08)' : 'var(--bg-elevated)', border: `1px solid ${chargeNow ? 'rgba(17,129,155,0.35)' : 'var(--border-default)'}` }}>
                                        <input type="checkbox" checked={chargeNow} onChange={e => setChargeNow(e.target.checked)} style={{ width: 18, height: 18, accentColor: 'var(--accent-primary)', cursor: 'pointer' }} />
                                        <div>
                                            <div style={{ fontSize: '0.8125rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}><CreditCard size={14} aria-hidden="true" /> Cobrar o cliente agora</div>
                                            <div style={{ fontSize: '0.625rem', color: 'var(--text-muted)', marginTop: '2px' }}>Gera PIX ou cobra o cartão do cliente (presente). Sem marcar, segue o status escolhido.</div>
                                        </div>
                                    </label>
                                    {chargeNow && (
                                        <div className="admin-grid-2" style={{ gap: '8px', marginTop: '8px' }}>
                                            {([{ key: 'PIX' as const, icon: Zap, label: 'PIX' }, { key: 'CARTAO' as const, icon: CreditCard, label: 'Cartão' }]).map(m => {
                                                const active = chargeMethod === m.key;
                                                return (
                                                    <button key={m.key} onClick={() => setChargeMethod(m.key)} aria-pressed={active}
                                                        style={{ padding: '10px', minHeight: 44, borderRadius: '10px', cursor: 'pointer', textAlign: 'center', fontFamily: 'inherit', background: active ? 'rgba(17,129,155,0.10)' : 'var(--bg-elevated)', border: `1.5px solid ${active ? 'rgba(17,129,155,0.4)' : 'var(--border-default)'}`, transition: 'background 0.15s ease, border-color 0.15s ease' }}>
                                                        <m.icon size={14} style={{ verticalAlign: '-2px' }} aria-hidden="true" /> <span style={{ fontSize: '0.75rem', fontWeight: 700, color: active ? 'var(--accent-text)' : 'var(--text-primary)' }}>{m.label}</span>
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
                                    {[{ key: 'CONFIRMED', icon: CheckCircle2, label: 'Confirmado' }, { key: 'RESERVED', icon: ClockIcon, label: 'Reservado' }].map(s => (
                                        <button key={s.key}
                                            onClick={() => setCreateForm({ ...createForm, status: s.key })}
                                            aria-pressed={createForm.status === s.key}
                                            style={{
                                                padding: '8px 16px', minHeight: 40, borderRadius: '8px', fontSize: '0.8125rem', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
                                                background: createForm.status === s.key ? 'var(--success-bg)' : 'var(--bg-elevated)',
                                                border: `1px solid ${createForm.status === s.key ? 'rgba(16,185,129,0.3)' : 'var(--border-default)'}`,
                                                color: createForm.status === s.key ? 'var(--success)' : 'var(--text-secondary)',
                                                transition: 'background 0.15s ease, color 0.15s ease, border-color 0.15s ease',
                                            }}>
                                            <s.icon size={13} style={{ verticalAlign: '-2px', marginRight: 5 }} aria-hidden="true" />{s.label}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {/* Admin notes */}
                            <div style={{ marginBottom: '14px' }}>
                                <label style={{ fontSize: '0.6875rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '8px', display: 'block' }}>
                                    <NotebookPen size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} aria-hidden="true" />Notas internas (opcional)
                                </label>
                                <textarea
                                    value={createForm.adminNotes}
                                    onChange={e => setCreateForm({ ...createForm, adminNotes: e.target.value })}
                                    placeholder="Observações internas sobre esta gravação..."
                                    rows={3}
                                    className="form-input form-input--raised"
                                    style={{ fontSize: '0.8125rem', resize: 'vertical' }}
                                />
                            </div>

                            <div className="admin-actions-row admin-actions-row--between" style={{ marginTop: '20px' }}>
                                <button onClick={() => setCreateStep(2)} className="btn-admin-ghost">
                                    ← Voltar
                                </button>
                                <button onClick={handleCreate} disabled={creating} className="btn-admin-go">
                                    {creating ? 'Criando…' : <><CalendarDays size={15} aria-hidden="true" /> Agendar</>}
                                </button>
                            </div>
                        </div>
                    )}
                </div>
        </BottomSheetModal>
    );
}

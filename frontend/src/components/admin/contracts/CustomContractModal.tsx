import { getErrorMessage } from '../../../utils/errors';
import { useState, useEffect } from 'react';
import { contractsApi, pricingApi, UserSummary, PricingConfig, AddOnConfig, CouponValidation } from '../../../api/client';
import BottomSheetModal from '../../BottomSheetModal';
import InlineCheckout from '../../InlineCheckout';
import CouponField from '../../CouponField';
import { getPaymentMethods } from '../../../constants/paymentMethods';

import { formatBRL } from '../../../utils/format';

interface CustomContractModalProps {
    isOpen: boolean;
    onClose: () => void;
    onCreated: () => void;
    users: UserSummary[];
    pricing: PricingConfig[];
}

export default function CustomContractModal({ isOpen, onClose, onCreated, users, pricing }: CustomContractModalProps) {
    const [customStep, setCustomStep] = useState<1 | 2 | 3 | 4>(1);
    const [customForm, setCustomForm] = useState({
        userId: '', name: '', tier: 'COMERCIAL' as string,
        durationMonths: 3, startDate: new Date().toISOString().split('T')[0],
        selectedDays: [] as number[], dayTimes: {} as Record<number, string>,
        paymentMethod: '' as string,
        frequency: 'WEEKLY' as 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY' | 'CUSTOM',
        weekPattern: [1, 3] as number[],
        customDates: [] as { date: string; time: string }[],
    });
    const [customAddons, setCustomAddons] = useState<AddOnConfig[]>([]);
    const [customAddonConfig, setCustomAddonConfig] = useState<Record<string, { mode: 'all' | 'credits' | 'none'; perCycle: number }>>({});
    const [customError, setCustomError] = useState('');
    const [customSubmitting, setCustomSubmitting] = useState(false);
    const [customSuccess, setCustomSuccess] = useState('');
    const [calMonth, setCalMonth] = useState({ year: new Date().getFullYear(), month: new Date().getMonth() });
    // Cupom (elegibilidade validada para o CLIENTE selecionado) + "cobrar agora" com o valor
    // da 1ª cobrança retornado pelo backend (JÁ descontado quando há cupom).
    const [appliedCoupon, setAppliedCoupon] = useState<CouponValidation | null>(null);
    const [chargePaymentId, setChargePaymentId] = useState<string | null>(null);
    const [chargeAmountApi, setChargeAmountApi] = useState<number | null>(null);

    useEffect(() => {
        pricingApi.getAddons().then(res => setCustomAddons(res.addons)).catch(console.error);
    }, []);

    if (!isOpen) return null;

    const POSSIBLE_SLOTS: Record<string, string[]> = {
        COMERCIAL: ['10:00', '13:00', '15:30'],
        AUDIENCIA: ['10:00', '13:00', '15:30', '18:00', '20:30'],
        SABADO: ['10:00', '13:00', '15:30', '18:00', '20:30'],
    };

    const cusLabelStyle = {
        fontSize: '0.6875rem', fontWeight: 700, color: 'var(--text-muted)',
        textTransform: 'uppercase' as const, letterSpacing: '0.12em', marginBottom: '6px', display: 'block',
    };
    const cusInputStyle = (hasErr = false) => ({
        width: '100%', padding: '10px 14px 10px 36px', borderRadius: '10px', fontSize: '0.8125rem',
        background: 'var(--bg-elevated)', border: `1px solid ${hasErr ? 'rgba(239,68,68,0.5)' : 'var(--border-default)'}`,
        color: 'var(--text-primary)', outline: 'none', fontFamily: 'inherit', transition: 'border-color 0.2s',
    } as React.CSSProperties);

    const tierConfig = pricing.find(p => p.tier === customForm.tier);
    const basePrice = tierConfig?.price || 0;
    const freq = customForm.frequency;

    // Mode-aware session calculations
    let sessionsPerWeek: number;
    let sessionsPerCycle: number;
    let totalSessions: number;

    if (freq === 'CUSTOM') {
        totalSessions = customForm.customDates.length;
        sessionsPerCycle = Math.round(totalSessions / Math.max(1, customForm.durationMonths));
        sessionsPerWeek = Math.round(totalSessions / Math.max(1, customForm.durationMonths * 4));
    } else {
        sessionsPerWeek = customForm.selectedDays.length;
        if (freq === 'BIWEEKLY') {
            sessionsPerCycle = sessionsPerWeek * 2;
        } else if (freq === 'MONTHLY') {
            sessionsPerCycle = sessionsPerWeek * customForm.weekPattern.length;
        } else {
            sessionsPerCycle = sessionsPerWeek * 4;
        }
        totalSessions = sessionsPerCycle * customForm.durationMonths;
    }

    // Dynamic discount thresholds based on tier base price
    // 12 sessions equivalent ? 30%, 24 sessions equivalent ? 40%
    const threshold30 = 12 * basePrice;
    const threshold40 = 24 * basePrice;

    // Raw costs (no discount) — full price for threshold comparison
    const activeAddonEntries = Object.entries(customAddonConfig).filter(([, v]) => v.mode !== 'none');
    let rawAddonsCostTotal = 0;
    for (const [key, config] of activeAddonEntries) {
        const addon = customAddons.find(a => a.key === key);
        if (!addon) continue;
        if (config.mode === 'credits') rawAddonsCostTotal += addon.price * config.perCycle * customForm.durationMonths;
        else rawAddonsCostTotal += addon.price * sessionsPerCycle * customForm.durationMonths;
    }
    const rawSessionsCostTotal = basePrice * totalSessions;
    const grossTotalValue = rawSessionsCostTotal + rawAddonsCostTotal;

    // Unified discount: compare gross total (full price) against dynamic thresholds
    let discountPct = 0;
    if (grossTotalValue >= threshold40) discountPct = 40;
    else if (grossTotalValue >= threshold30) discountPct = 30;

    const discountedSessionPrice = Math.round(basePrice * (1 - discountPct / 100));
    const cycleBaseAmount = sessionsPerCycle * discountedSessionPrice;

    // Add-ons cost WITH discount applied (for Step 4 / payment)
    let addonsCostPerCycle = 0;
    for (const [key, config] of activeAddonEntries) {
        const addon = customAddons.find(a => a.key === key);
        if (!addon) continue;
        if (config.mode === 'credits') addonsCostPerCycle += Math.round(addon.price * config.perCycle * (1 - discountPct / 100));
        else addonsCostPerCycle += Math.round(addon.price * sessionsPerCycle * (1 - discountPct / 100));
    }
    const cycleAmount = cycleBaseAmount + addonsCostPerCycle;
    const totalAmount = cycleAmount * customForm.durationMonths;

    // Progress bar: always relative to threshold40 (max bar)
    const valProgressPct = Math.min((grossTotalValue / threshold40) * 100, 100);
    const threshold30Pct = (threshold30 / threshold40) * 100; // marker position for 30%

    const schedule = customForm.selectedDays.map(day => ({
        day, time: customForm.dayTimes[day] || POSSIBLE_SLOTS[customForm.tier]?.[0] || '10:00',
    }));

    const toggleDay = (day: number) => {
        if (customForm.selectedDays.includes(day)) {
            setCustomForm(f => ({ ...f, selectedDays: f.selectedDays.filter(d => d !== day), dayTimes: (() => { const n = { ...f.dayTimes }; delete n[day]; return n; })() }));
        } else {
            setCustomForm(f => ({ ...f, selectedDays: [...f.selectedDays, day].sort(), dayTimes: { ...f.dayTimes, [day]: POSSIBLE_SLOTS[f.tier]?.[0] || '10:00' } }));
        }
    };

    const canStep1 = customForm.userId && customForm.name.length >= 2;
    const canStep2 = freq === 'CUSTOM' ? customForm.customDates.length >= 1 : sessionsPerWeek >= 1;
    const canStep3 = true; // addons are optional
    const canStep4 = !!customForm.paymentMethod;

    const handleCustomSubmit = async () => {
        setCustomSubmitting(true); setCustomError('');
        try {
            const activeAddonKeys = activeAddonEntries.map(([k]) => k);
            const addonConfigPayload: Record<string, { mode: 'all' | 'credits'; perCycle?: number }> = {};
            for (const [key, config] of activeAddonEntries) {
                addonConfigPayload[key] = { mode: config.mode as 'all' | 'credits', ...(config.mode === 'credits' ? { perCycle: config.perCycle } : {}) };
            }
            const res = await contractsApi.createCustom({
                userId: customForm.userId,
                name: customForm.name,
                tier: customForm.tier as 'COMERCIAL' | 'AUDIENCIA' | 'SABADO',
                durationMonths: customForm.durationMonths,
                schedule: freq !== 'CUSTOM' ? schedule : [],
                paymentMethod: customForm.paymentMethod as 'CARTAO' | 'PIX' | 'BOLETO',
                addOns: activeAddonKeys.length > 0 ? activeAddonKeys : undefined,
                addonConfig: activeAddonKeys.length > 0 ? addonConfigPayload : undefined,
                startDate: customForm.startDate,
                frequency: freq,
                weekPattern: (freq === 'BIWEEKLY' || freq === 'MONTHLY') ? customForm.weekPattern : undefined,
                customDates: freq === 'CUSTOM' ? customForm.customDates : undefined,
                couponCode: appliedCoupon?.code || undefined,
            });
            onCreated();
            // Mesmo padrão do CreateContractModal: oferecer cobrança da 1ª parcela na hora,
            // usando o valor retornado pelo backend (já com cupom descontado).
            if (res.firstPaymentId) {
                setChargeAmountApi(res.payments?.[0]?.amount ?? null);
                setChargePaymentId(res.firstPaymentId);
            } else {
                setCustomSuccess('Contrato personalizado criado com sucesso!');
                setTimeout(() => { onClose(); setCustomSuccess(''); }, 2000);
            }
        } catch (err: unknown) { setCustomError(getErrorMessage(err) || 'Erro ao criar contrato'); }
        finally { setCustomSubmitting(false); }
    };

    const nextThreshold = totalSessions < 12 ? 12 : totalSessions < 24 ? 24 : null;
    const progressPct = nextThreshold ? Math.min((totalSessions / nextThreshold) * 100, 100) : 100;

    // Mini-calendar helper for CUSTOM mode
    const getCalendarMonth = (year: number, month: number) => {
        const firstDay = new Date(year, month, 1).getDay();
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const weeks: (number | null)[][] = [];
        let week: (number | null)[] = Array(firstDay).fill(null);
        for (let d = 1; d <= daysInMonth; d++) {
            week.push(d);
            if (week.length === 7) { weeks.push(week); week = []; }
        }
        if (week.length > 0) { while (week.length < 7) week.push(null); weeks.push(week); }
        return weeks;
    };
    const calStartDate = new Date(customForm.startDate + 'T00:00:00');
    const calEndDate = new Date(calStartDate); calEndDate.setMonth(calEndDate.getMonth() + customForm.durationMonths);
    const calWeeks = getCalendarMonth(calMonth.year, calMonth.month);
    const toggleCalDate = (dateStr: string) => {
        setCustomForm(f => {
            const exists = f.customDates.find(cd => cd.date === dateStr);
            if (exists) return { ...f, customDates: f.customDates.filter(cd => cd.date !== dateStr) };
            return { ...f, customDates: [...f.customDates, { date: dateStr, time: POSSIBLE_SLOTS[f.tier]?.[0] || '10:00' }].sort((a, b) => a.date.localeCompare(b.date)) };
        });
    };
    const updateCalTime = (dateStr: string, time: string) => {
        setCustomForm(f => ({ ...f, customDates: f.customDates.map(cd => cd.date === dateStr ? { ...cd, time } : cd) }));
    };
    const prevMonth = () => setCalMonth(m => m.month === 0 ? { year: m.year - 1, month: 11 } : { ...m, month: m.month - 1 });
    const nextMonth = () => setCalMonth(m => m.month === 11 ? { year: m.year + 1, month: 0 } : { ...m, month: m.month + 1 });
    const monthNames = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

    // Charge-now step: mesmo InlineCheckout + política unificada do cliente. Cobra o CLIENTE
    // (payment.userId) — o backend resolve o pagador a partir do payment, não do admin.
    if (chargePaymentId) {
        return (
            <BottomSheetModal isOpen onClose={() => { setChargePaymentId(null); onClose(); }} hideHeader maxWidth="460px" className="admin-sheet" title="Cobrar 1ª cobrança">
                <div style={{ padding: '24px 28px' }}>
                    <h3 style={{ fontSize: '1.0625rem', fontWeight: 800, margin: '0 0 4px' }}>Cobrar 1ª cobrança</h3>
                    <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: '0 0 16px' }}>
                        Cobre agora (PIX ou cartão do cliente presente) ou deixe pendente — o cliente paga depois / cobrança automática.
                    </p>
                    <InlineCheckout
                        amount={chargeAmountApi ?? cycleAmount}
                        paymentId={chargePaymentId}
                        description={`${customForm.name || 'Contrato personalizado'} - 1ª cobrança`}
                        allowedMethods={[customForm.paymentMethod as 'CARTAO' | 'PIX' | 'BOLETO']}
                        isAdmin
                        allowBoleto={customForm.paymentMethod === 'BOLETO'}
                        context="contract"
                        onSuccess={() => { setChargePaymentId(null); onClose(); }}
                        onError={(msg) => setCustomError(msg)}
                        onCancel={() => { setChargePaymentId(null); onClose(); }}
                    />
                    {customError && <div style={{ marginTop: 10, padding: '8px 12px', borderRadius: 8, background: 'rgba(239,68,68,0.08)', color: '#ef4444', fontSize: '0.75rem' }}>{customError}</div>}
                    <button onClick={() => { setChargePaymentId(null); onClose(); }}
                        style={{ marginTop: 12, width: '100%', padding: '10px', borderRadius: '10px', background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-secondary)', fontSize: '0.8125rem', fontWeight: 600, cursor: 'pointer' }}>
                        Deixar pendente (cliente paga depois)
                    </button>
                </div>
            </BottomSheetModal>
        );
    }

    return (
        <BottomSheetModal isOpen onClose={onClose} hideHeader maxWidth="580px" className="admin-sheet" title="Contrato Personalizado">
                {/* Header */}
                <div style={{ padding: '28px 32px 0', borderBottom: 'none' }}>
                    <h2 style={{ fontSize: '1.25rem', fontWeight: 800, margin: 0, display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <span style={{ width: 36, height: 36, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'linear-gradient(135deg, #2dd4bf, #3b82f6)', fontSize: '1rem' }}>✨</span>
                        Contrato Personalizado
                    </h2>
                    <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '6px', marginBottom: 0 }}>
                        Monte um plano sob medida para o cliente
                    </p>
                    {/* Step indicator */}
                    <div style={{ display: 'flex', gap: '8px', marginTop: '16px' }}>
                        {[{ n: 1, label: 'Plano' }, { n: 2, label: 'Agenda' }, { n: 3, label: 'Serviços' }, { n: 4, label: 'Resumo' }].map(s => (
                            <div key={s.n} style={{
                                flex: 1, padding: '8px', borderRadius: '8px', textAlign: 'center', fontSize: '0.625rem', fontWeight: 700,
                                background: customStep === s.n ? 'rgba(45,212,191,0.12)' : customStep > s.n ? 'rgba(16,185,129,0.08)' : 'var(--bg-elevated)',
                                border: `1px solid ${customStep === s.n ? 'rgba(45,212,191,0.3)' : customStep > s.n ? 'rgba(16,185,129,0.2)' : 'var(--border-default)'}`,
                                color: customStep === s.n ? '#2dd4bf' : customStep > s.n ? '#10b981' : 'var(--text-muted)',
                                transition: 'all 0.2s',
                            }}>
                                {customStep > s.n ? '✓' : s.n}. {s.label}
                            </div>
                        ))}
                    </div>
                </div>

                {customError && <div style={{ margin: '16px 32px 0', padding: '10px 14px', borderRadius: '10px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.15)', color: '#ef4444', fontSize: '0.8125rem', fontWeight: 600 }}>{customError}</div>}
                {customSuccess && <div style={{ margin: '16px 32px 0', padding: '10px 14px', borderRadius: '10px', background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.15)', color: '#10b981', fontSize: '0.8125rem', fontWeight: 600 }}>{customSuccess}</div>}

                <div style={{ padding: '20px 32px 28px' }}>

                    {/* --- STEP 1: Cliente & Plano --- */}
                    {customStep === 1 && (
                        <div>
                            <div style={{ fontSize: '0.625rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: '14px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                <span style={{ width: 18, height: 18, borderRadius: '50%', background: '#10b981', color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.5rem', fontWeight: 800 }}>1</span>
                                Cliente & Plano
                            </div>

                            {/* Client selector */}
                            <div style={{ marginBottom: '12px' }}>
                                <label style={cusLabelStyle}>Cliente *</label>
                                <div style={{ position: 'relative' }}>
                                    <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: '0.75rem', opacity: 0.5 }}>👤</span>
                                    <select value={customForm.userId} onChange={e => setCustomForm(f => ({ ...f, userId: e.target.value }))}
                                        style={{ ...cusInputStyle(), appearance: 'none', cursor: 'pointer', paddingRight: '32px', background: `var(--bg-elevated) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23888' stroke-width='1.5' fill='none'/%3E%3C/svg%3E") right 12px center no-repeat` }}>
                                        <option value="">Selecione um cliente...</option>
                                        {users.filter(u => u.role === 'CLIENTE').map(u => (
                                            <option key={u.id} value={u.id}>{u.name} ({u.email})</option>
                                        ))}
                                    </select>
                                </div>
                            </div>

                            {/* Contract name */}
                            <div style={{ marginBottom: '12px' }}>
                                <label style={cusLabelStyle}>Nome do Contrato *</label>
                                <div style={{ position: 'relative' }}>
                                    <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: '0.75rem', opacity: 0.5 }}>📝</span>
                                    <input value={customForm.name} onChange={e => setCustomForm(f => ({ ...f, name: e.target.value }))}
                                        placeholder='Ex: Podcast Verão 2x/semana' style={cusInputStyle()}
                                        onFocus={e => e.currentTarget.style.borderColor = '#2dd4bf'}
                                        onBlur={e => e.currentTarget.style.borderColor = 'var(--border-default)'}
                                    />
                                </div>
                            </div>

                            {/* Tier selector */}
                            <div style={{ marginBottom: '12px' }}>
                                <label style={cusLabelStyle}>Faixa Horária</label>
                                <div style={{ display: 'flex', gap: '6px' }}>
                                    {[{ key: 'COMERCIAL', emoji: '🏢', label: 'Comercial', desc: 'Até 17:30' }, { key: 'AUDIENCIA', emoji: '🎤', label: 'Audiência', desc: 'Até 23:00' }, { key: 'SABADO', emoji: '🌟', label: 'Sábado', desc: 'Sáb exclusivo' }].map(t => (
                                        <button key={t.key} onClick={() => setCustomForm(f => ({ ...f, tier: t.key, selectedDays: [], dayTimes: {} }))}
                                            style={{
                                                flex: 1, padding: '10px 8px', borderRadius: '10px', cursor: 'pointer',
                                                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px',
                                                background: customForm.tier === t.key ? 'rgba(45,212,191,0.1)' : 'var(--bg-elevated)',
                                                border: `1px solid ${customForm.tier === t.key ? 'rgba(45,212,191,0.3)' : 'var(--border-default)'}`,
                                                transition: 'all 0.15s',
                                            }}>
                                            <span style={{ fontSize: '1.25rem' }}>{t.emoji}</span>
                                            <span style={{ fontSize: '0.75rem', fontWeight: 700, color: customForm.tier === t.key ? '#2dd4bf' : 'var(--text-primary)' }}>{t.label}</span>
                                            <span style={{ fontSize: '0.5625rem', color: 'var(--text-muted)' }}>{t.desc} — {formatBRL(pricing.find(p => p.tier === t.key)?.price || 0)}</span>
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {/* Duration + Start date */}
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                                <div>
                                    <label style={cusLabelStyle}>Duração (meses)</label>
                                    <div style={{ position: 'relative' }}>
                                        <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: '0.75rem', opacity: 0.5 }}>⏱️</span>
                                        <select value={customForm.durationMonths} onChange={e => setCustomForm(f => ({ ...f, durationMonths: Number(e.target.value) }))}
                                            style={{ ...cusInputStyle(), appearance: 'none', cursor: 'pointer', paddingRight: '32px', background: `var(--bg-elevated) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23888' stroke-width='1.5' fill='none'/%3E%3C/svg%3E") right 12px center no-repeat` }}>
                                            {[1, 2, 3, 4, 5, 6, 9, 12].map(m => (<option key={m} value={m}>{m} {m === 1 ? 'mês' : 'meses'}</option>))}
                                        </select>
                                    </div>
                                </div>
                                <div>
                                    <label style={cusLabelStyle}>Data Início</label>
                                    <div style={{ position: 'relative' }}>
                                        <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: '0.75rem', opacity: 0.5 }}>📅</span>
                                        <input type="date" value={customForm.startDate} onChange={e => setCustomForm(f => ({ ...f, startDate: e.target.value }))}
                                            style={cusInputStyle()}
                                            onFocus={e => e.currentTarget.style.borderColor = '#2dd4bf'}
                                            onBlur={e => e.currentTarget.style.borderColor = 'var(--border-default)'}
                                        />
                                    </div>
                                </div>
                            </div>

                            {/* Actions */}
                            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '20px' }}>
                                <button onClick={() => { if (canStep1) setCustomStep(2); }} disabled={!canStep1}
                                    style={{
                                        padding: '10px 28px', borderRadius: '10px', border: 'none', fontSize: '0.875rem', fontWeight: 700, cursor: 'pointer',
                                        background: canStep1 ? 'linear-gradient(135deg, #2dd4bf, #3b82f6)' : 'var(--bg-elevated)',
                                        color: canStep1 ? '#fff' : 'var(--text-muted)', opacity: canStep1 ? 1 : 0.5,
                                        display: 'flex', alignItems: 'center', gap: '8px',
                                    }}>
                                    Próximo ➡️
                                </button>
                            </div>
                        </div>
                    )}

                    {/* --- STEP 2: Agenda --- */}
                    {customStep === 2 && (
                        <div>
                            <div style={{ fontSize: '0.625rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: '14px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                <span style={{ width: 18, height: 18, borderRadius: '50%', background: '#3b82f6', color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.5rem', fontWeight: 800 }}>2</span>
                                Configuração de Agenda
                            </div>

                            {/* Frequency tabs */}
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '4px', marginBottom: '16px', background: 'var(--bg-elevated)', borderRadius: '10px', padding: '3px', border: '1px solid var(--border-default)' }}>
                                {([
                                    { key: 'WEEKLY', emoji: '📅', label: 'Semanal' },
                                    { key: 'BIWEEKLY', emoji: '🗓️', label: 'Quinzenal' },
                                    { key: 'MONTHLY', emoji: '📆', label: 'Mensal' },
                                    { key: 'CUSTOM', emoji: '✨', label: 'Datas Livres' },
                                ] as const).map(fm => (
                                    <button key={fm.key} onClick={() => setCustomForm(f => ({ ...f, frequency: fm.key, selectedDays: [], dayTimes: {}, customDates: [] }))}
                                        style={{
                                            padding: '7px 4px', borderRadius: '8px', cursor: 'pointer', border: 'none',
                                            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1px',
                                            background: freq === fm.key ? 'rgba(59,130,246,0.12)' : 'transparent',
                                            transition: 'all 0.15s',
                                        }}>
                                        <span style={{ fontSize: '0.875rem' }}>{fm.emoji}</span>
                                        <span style={{ fontSize: '0.5625rem', fontWeight: 700, color: freq === fm.key ? '#3b82f6' : 'var(--text-muted)' }}>{fm.label}</span>
                                    </button>
                                ))}
                            </div>

                            {/* -- WEEKLY / BIWEEKLY / MONTHLY shared UI -- */}
                            {freq !== 'CUSTOM' && (
                                <>
                                    <label style={cusLabelStyle}>Dias da Semana</label>
                                    <div style={{ display: 'flex', gap: '6px', marginBottom: '10px' }}>
                                        {(customForm.tier === 'SABADO' ? [6] : [1, 2, 3, 4, 5]).map(day => {
                                            const names: Record<number, string> = { 1: 'Seg', 2: 'Ter', 3: 'Qua', 4: 'Qui', 5: 'Sex', 6: 'Sáb' };
                                            const sel = customForm.selectedDays.includes(day);
                                            return (
                                                <button key={day} onClick={() => toggleDay(day)}
                                                    style={{
                                                        flex: 1, padding: '10px 4px', borderRadius: '10px', cursor: 'pointer',
                                                        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px',
                                                        background: sel ? 'rgba(59,130,246,0.12)' : 'var(--bg-elevated)',
                                                        border: `1px solid ${sel ? 'rgba(59,130,246,0.3)' : 'var(--border-default)'}`,
                                                        transition: 'all 0.15s',
                                                    }}>
                                                    <span style={{ fontSize: '0.8125rem', fontWeight: 700, color: sel ? '#3b82f6' : 'var(--text-primary)' }}>{names[day]}</span>
                                                </button>
                                            );
                                        })}
                                    </div>

                                    {freq === 'BIWEEKLY' && (
                                        <div style={{ marginBottom: '10px' }}>
                                            <label style={cusLabelStyle}>Padrão de Semanas</label>
                                            <div style={{ display: 'flex', gap: '6px' }}>
                                                {[{ pattern: [1, 3], label: 'Semanas 1 e 3', desc: '1ª e 3ª do ciclo' }, { pattern: [2, 4], label: 'Semanas 2 e 4', desc: '2ª e 4ª do ciclo' }].map(wp => {
                                                    const sel = JSON.stringify(customForm.weekPattern) === JSON.stringify(wp.pattern);
                                                    return (
                                                        <button key={wp.label} onClick={() => setCustomForm(f => ({ ...f, weekPattern: wp.pattern }))}
                                                            style={{
                                                                flex: 1, padding: '10px 8px', borderRadius: '10px', cursor: 'pointer',
                                                                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px',
                                                                background: sel ? 'rgba(59,130,246,0.1)' : 'var(--bg-elevated)',
                                                                border: `1px solid ${sel ? 'rgba(59,130,246,0.3)' : 'var(--border-default)'}`,
                                                                transition: 'all 0.15s',
                                                            }}>
                                                            <span style={{ fontSize: '0.75rem', fontWeight: 700, color: sel ? '#3b82f6' : 'var(--text-primary)' }}>{wp.label}</span>
                                                            <span style={{ fontSize: '0.5rem', color: 'var(--text-muted)' }}>{wp.desc}</span>
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    )}

                                    {freq === 'MONTHLY' && (
                                        <div style={{ marginBottom: '10px' }}>
                                            <label style={cusLabelStyle}>Semanas do Mês</label>
                                            <div style={{ display: 'flex', gap: '4px' }}>
                                                {[1, 2, 3, 4].map(wk => {
                                                    const sel = customForm.weekPattern.includes(wk);
                                                    return (
                                                        <button key={wk} onClick={() => setCustomForm(f => ({ ...f, weekPattern: sel ? f.weekPattern.filter(w => w !== wk) : [...f.weekPattern, wk].sort() }))}
                                                            style={{
                                                                flex: 1, padding: '10px 4px', borderRadius: '10px', cursor: 'pointer',
                                                                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px',
                                                                background: sel ? 'rgba(45,212,191,0.1)' : 'var(--bg-elevated)',
                                                                border: `1px solid ${sel ? 'rgba(45,212,191,0.3)' : 'var(--border-default)'}`,
                                                                transition: 'all 0.15s',
                                                            }}>
                                                            <span style={{ fontSize: '0.75rem', fontWeight: 700, color: sel ? '#2dd4bf' : 'var(--text-primary)' }}>{wk}ª</span>
                                                            <span style={{ fontSize: '0.5rem', color: 'var(--text-muted)' }}>semana</span>
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    )}

                                    {customForm.selectedDays.length > 0 && (
                                        <div style={{ marginBottom: '12px' }}>
                                            <label style={cusLabelStyle}>Horários por Dia</label>
                                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '8px' }}>
                                                {customForm.selectedDays.map(day => {
                                                    const dayNames: Record<number, string> = { 1: 'Segunda', 2: 'Terça', 3: 'Quarta', 4: 'Quinta', 5: 'Sexta', 6: 'Sábado' };
                                                    return (
                                                        <div key={day} style={{ padding: '10px', borderRadius: '10px', background: 'rgba(59,130,246,0.04)', border: '1px solid rgba(59,130,246,0.1)' }}>
                                                            <div style={{ fontSize: '0.625rem', fontWeight: 700, color: '#3b82f6', textTransform: 'uppercase', marginBottom: '6px' }}>{dayNames[day]}</div>
                                                            <select value={customForm.dayTimes[day] || ''} onChange={e => setCustomForm(f => ({ ...f, dayTimes: { ...f.dayTimes, [day]: e.target.value } }))}
                                                                style={{ width: '100%', padding: '6px 8px', borderRadius: '8px', fontSize: '0.8125rem', background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-primary)', outline: 'none', fontFamily: 'inherit', cursor: 'pointer' }}>
                                                                {(POSSIBLE_SLOTS[customForm.tier] || []).map(t => (<option key={t} value={t}>{t}</option>))}
                                                            </select>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    )}
                                </>
                            )}

                            {/* -- CUSTOM: Mini-Calendar -- */}
                            {freq === 'CUSTOM' && (
                                <div>
                                    <label style={cusLabelStyle}>Selecione as Datas</label>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                                        <button onClick={prevMonth} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: '0.875rem', padding: '4px 8px' }}>◀</button>
                                        <span style={{ fontSize: '0.875rem', fontWeight: 700, color: 'var(--text-primary)' }}>{monthNames[calMonth.month]} {calMonth.year}</span>
                                        <button onClick={nextMonth} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: '0.875rem', padding: '4px 8px' }}>▶</button>
                                    </div>
                                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '2px', marginBottom: '2px' }}>
                                        {['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'].map(d => (
                                            <div key={d} style={{ textAlign: 'center', fontSize: '0.5rem', fontWeight: 700, color: 'var(--text-muted)', padding: '4px 0', textTransform: 'uppercase' }}>{d}</div>
                                        ))}
                                    </div>
                                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '2px', marginBottom: '12px' }}>
                                        {calWeeks.flat().map((day, idx) => {
                                            if (day === null) return <div key={`e${idx}`} />;
                                            const dateStr = `${calMonth.year}-${String(calMonth.month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                                            const dateObj = new Date(dateStr + 'T00:00:00');
                                            const inRange = dateObj >= calStartDate && dateObj < calEndDate;
                                            const selected = customForm.customDates.some(cd => cd.date === dateStr);
                                            const isToday = dateStr === new Date().toISOString().split('T')[0];
                                            return (
                                                <button key={dateStr} onClick={() => { if (inRange) toggleCalDate(dateStr); }} disabled={!inRange}
                                                    style={{
                                                        padding: '6px 2px', borderRadius: '8px', cursor: inRange ? 'pointer' : 'default',
                                                        fontSize: '0.75rem', fontWeight: selected ? 800 : isToday ? 700 : 500,
                                                        background: selected ? 'rgba(45,212,191,0.2)' : 'transparent',
                                                        border: `1.5px solid ${selected ? '#2dd4bf' : isToday ? 'rgba(59,130,246,0.3)' : 'transparent'}`,
                                                        color: !inRange ? 'var(--text-muted)' : selected ? '#2dd4bf' : 'var(--text-primary)',
                                                        opacity: inRange ? 1 : 0.3, transition: 'all 0.1s',
                                                    }}>
                                                    {day}
                                                </button>
                                            );
                                        })}
                                    </div>
                                    {customForm.customDates.length > 0 && (
                                        <div style={{ marginBottom: '12px' }}>
                                            <label style={cusLabelStyle}>{customForm.customDates.length} data{customForm.customDates.length !== 1 ? 's' : ''} selecionada{customForm.customDates.length !== 1 ? 's' : ''}</label>
                                            <div style={{ maxHeight: '150px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                                {customForm.customDates.map(cd => {
                                                    const d = new Date(cd.date + 'T12:00:00');
                                                    const dn = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
                                                    return (
                                                        <div key={cd.date} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 10px', borderRadius: '8px', background: 'rgba(45,212,191,0.04)', border: '1px solid rgba(45,212,191,0.1)' }}>
                                                            <span style={{ fontSize: '0.625rem', fontWeight: 700, color: '#2dd4bf', width: '24px' }}>{dn[d.getDay()]}</span>
                                                            <span style={{ fontSize: '0.75rem', color: 'var(--text-primary)', flex: 1 }}>{String(d.getDate()).padStart(2, '0')}/{String(d.getMonth() + 1).padStart(2, '0')}/{d.getFullYear()}</span>
                                                            <select value={cd.time} onChange={e => updateCalTime(cd.date, e.target.value)}
                                                                style={{ padding: '3px 6px', borderRadius: '6px', fontSize: '0.6875rem', background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-primary)', outline: 'none', cursor: 'pointer' }}>
                                                                {(POSSIBLE_SLOTS[customForm.tier] || []).map(t => (<option key={t} value={t}>{t}</option>))}
                                                            </select>
                                                            <button onClick={() => toggleCalDate(cd.date)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: '0.75rem', padding: '2px 4px' }}>✕</button>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* Discount progress + summary */}
                            <div style={{ padding: '14px', borderRadius: '10px', background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', marginBottom: '14px' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                                    <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-primary)' }}>{totalSessions} sessões total</span>
                                    <span style={{ fontSize: '0.875rem', fontWeight: 800, color: discountPct > 0 ? '#10b981' : 'var(--text-muted)' }}>
                                        {discountPct > 0 ? `${discountPct}% OFF` : 'Sem desconto'}
                                    </span>
                                </div>
                                <div style={{ height: '6px', borderRadius: '3px', background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
                                    <div style={{ height: '100%', width: `${progressPct}%`, borderRadius: '3px', background: discountPct >= 40 ? '#10b981' : discountPct >= 30 ? '#3b82f6' : '#f59e0b', transition: 'width 0.3s' }} />
                                </div>
                                {nextThreshold && (
                                    <div style={{ fontSize: '0.625rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                                        +{nextThreshold - totalSessions} sessões para {nextThreshold >= 24 ? '40%' : '30%'} de desconto
                                    </div>
                                )}
                                <div style={{ display: 'grid', gridTemplateColumns: freq === 'CUSTOM' ? '1fr 1fr' : '1fr 1fr 1fr', gap: '8px', marginTop: '10px' }}>
                                    {freq !== 'CUSTOM' && (
                                        <div style={{ textAlign: 'center' }}>
                                            <div style={{ fontSize: '1.25rem', fontWeight: 800, color: 'var(--text-primary)' }}>{sessionsPerWeek}</div>
                                            <div style={{ fontSize: '0.5625rem', color: 'var(--text-muted)' }}>por semana</div>
                                        </div>
                                    )}
                                    <div style={{ textAlign: 'center' }}>
                                        <div style={{ fontSize: '1.25rem', fontWeight: 800, color: 'var(--text-primary)' }}>{sessionsPerCycle}</div>
                                        <div style={{ fontSize: '0.5625rem', color: 'var(--text-muted)' }}>por ciclo</div>
                                    </div>
                                    <div style={{ textAlign: 'center' }}>
                                        <div style={{ fontSize: '1.25rem', fontWeight: 800, color: '#2dd4bf' }}>{formatBRL(discountedSessionPrice)}</div>
                                        <div style={{ fontSize: '0.5625rem', color: 'var(--text-muted)' }}>por sessão</div>
                                    </div>
                                </div>
                            </div>

                            {/* Actions */}
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '20px' }}>
                                <button onClick={() => setCustomStep(1)}
                                    style={{ padding: '10px 20px', borderRadius: '10px', background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-secondary)', fontSize: '0.8125rem', fontWeight: 600, cursor: 'pointer' }}>
                                    ⬅️ Voltar
                                </button>
                                <button onClick={() => { if (canStep2) setCustomStep(3); }} disabled={!canStep2}
                                    style={{
                                        padding: '10px 28px', borderRadius: '10px', border: 'none', fontSize: '0.875rem', fontWeight: 700, cursor: 'pointer',
                                        background: canStep2 ? 'linear-gradient(135deg, #2dd4bf, #3b82f6)' : 'var(--bg-elevated)',
                                        color: canStep2 ? '#fff' : 'var(--text-muted)', opacity: canStep2 ? 1 : 0.5,
                                        display: 'flex', alignItems: 'center', gap: '8px',
                                    }}>
                                    Próximo ➡️
                                </button>
                            </div>
                        </div>
                    )}


                    {/* --- STEP 3: Serviços Adicionais --- */}
                    {customStep === 3 && (
                        <div>
                            <div style={{ fontSize: '0.625rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: '14px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                <span style={{ width: 18, height: 18, borderRadius: '50%', background: '#2dd4bf', color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.5rem', fontWeight: 800 }}>3</span>
                                Serviços Adicionais
                            </div>

                            {/* Value-based discount progress */}
                            <div style={{ padding: '14px', borderRadius: '10px', background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', marginBottom: '14px' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                                    <span style={{ fontSize: '0.6875rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                                        {discountPct > 0 ? `🎉 ${discountPct}% de desconto ativo` : 'Barra de Desconto'}
                                    </span>
                                    <span style={{ fontSize: '0.75rem', fontWeight: 800, color: discountPct >= 40 ? '#10b981' : discountPct >= 30 ? '#3b82f6' : '#f59e0b' }}>
                                        {formatBRL(grossTotalValue)}
                                    </span>
                                </div>
                                <div style={{ fontSize: '0.5625rem', color: 'var(--text-muted)', marginBottom: '6px' }}>
                                    {discountPct >= 40
                                        ? `Desconto máximo atingido! (${totalSessions} gravações + serviços)`
                                        : discountPct >= 30
                                            ? `Faltam ${formatBRL(threshold40 - grossTotalValue)} para 40% de desconto`
                                            : `${totalSessions} gravações — adicione serviços para desbloquear descontos`
                                    }
                                </div>
                                <div style={{ height: '8px', borderRadius: '4px', background: 'rgba(255,255,255,0.06)', overflow: 'hidden', position: 'relative' }}>
                                    <div style={{ height: '100%', width: `${valProgressPct}%`, borderRadius: '4px', background: discountPct >= 40 ? '#10b981' : discountPct >= 30 ? '#3b82f6' : 'linear-gradient(90deg, #f59e0b, #ef4444)', transition: 'width 0.3s' }} />
                                    {/* 30% threshold marker */}
                                    <div style={{ position: 'absolute', left: `${threshold30Pct}%`, top: 0, bottom: 0, width: '1.5px', background: 'rgba(59,130,246,0.5)' }} />
                                </div>
                                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px', fontSize: '0.5rem', color: 'var(--text-muted)' }}>
                                    <span>R$ 0</span>
                                    <span style={{ color: grossTotalValue >= threshold30 ? '#3b82f6' : 'var(--text-muted)', fontWeight: grossTotalValue >= threshold30 ? 700 : 400 }}>{formatBRL(threshold30)} (30%)</span>
                                    <span style={{ color: grossTotalValue >= threshold40 ? '#10b981' : 'var(--text-muted)', fontWeight: grossTotalValue >= threshold40 ? 700 : 400 }}>{formatBRL(threshold40)} (40%)</span>
                                </div>
                                {discountPct < 30 && (
                                    <div style={{ fontSize: '0.5625rem', color: '#f59e0b', marginTop: '6px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                                        <span>⚠️</span>
                                        Faltam {formatBRL(threshold30 - grossTotalValue)} para 30% de desconto
                                    </div>
                                )}
                            </div>

                            {/* Add-ons list */}
                            {customAddons.length > 0 && (
                                <div style={{ marginBottom: '14px' }}>
                                    <label style={cusLabelStyle}>Adicionar Serviços</label>
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                        {customAddons.map(addon => {
                                            const cfg = customAddonConfig[addon.key] || { mode: 'none', perCycle: 4 };
                                            const addonDiscountedPrice = Math.round(addon.price * (1 - discountPct / 100));
                                            return (
                                                <div key={addon.key} style={{
                                                    padding: '10px 12px', borderRadius: '10px',
                                                    background: cfg.mode !== 'none' ? 'rgba(45,212,191,0.04)' : 'var(--bg-elevated)',
                                                    border: `1px solid ${cfg.mode !== 'none' ? 'rgba(45,212,191,0.15)' : 'var(--border-default)'}`,
                                                }}>
                                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                                        <div>
                                                            <div style={{ fontSize: '0.8125rem', fontWeight: 700, color: 'var(--text-primary)' }}>{addon.name}</div>
                                                            <div style={{ fontSize: '0.625rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                                                                {discountPct > 0 && <span style={{ textDecoration: 'line-through', opacity: 0.5 }}>{formatBRL(addon.price)}</span>}
                                                                <span style={{ fontWeight: discountPct > 0 ? 700 : 400, color: discountPct > 0 ? '#2dd4bf' : 'var(--text-muted)' }}>
                                                                    {formatBRL(addonDiscountedPrice)}/un
                                                                </span>
                                                                {discountPct > 0 && <span style={{ fontSize: '0.5rem', color: '#10b981', fontWeight: 700 }}>-{discountPct}%</span>}
                                                            </div>
                                                        </div>
                                                        <div style={{ display: 'flex', gap: '3px' }}>
                                                            {['none', 'all', 'credits'].map(mode => (
                                                                <button key={mode} onClick={() => setCustomAddonConfig(prev => ({ ...prev, [addon.key]: { ...cfg, mode: mode as any } }))}
                                                                    style={{
                                                                        padding: '4px 8px', borderRadius: '6px', fontSize: '0.5625rem', fontWeight: 700, cursor: 'pointer',
                                                                        background: cfg.mode === mode ? (mode === 'none' ? 'rgba(107,114,128,0.15)' : 'rgba(45,212,191,0.12)') : 'transparent',
                                                                        border: `1px solid ${cfg.mode === mode ? (mode === 'none' ? 'rgba(107,114,128,0.3)' : 'rgba(45,212,191,0.3)') : 'transparent'}`,
                                                                        color: cfg.mode === mode ? (mode === 'none' ? '#6b7280' : '#2dd4bf') : 'var(--text-muted)',
                                                                    }}>
                                                                    {mode === 'none' ? 'Não' : mode === 'all' ? 'Todas' : 'Créditos'}
                                                                </button>
                                                            ))}
                                                        </div>
                                                    </div>
                                                    {cfg.mode === 'credits' && (
                                                        <div style={{ marginTop: '8px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                                                            <span style={{ fontSize: '0.625rem', color: 'var(--text-muted)' }}>Créditos/ciclo:</span>
                                                            <input type="number" min={1} max={20} value={cfg.perCycle}
                                                                onChange={e => setCustomAddonConfig(prev => ({ ...prev, [addon.key]: { ...cfg, perCycle: Math.max(1, Number(e.target.value)) } }))}
                                                                style={{ width: '60px', padding: '4px 8px', borderRadius: '6px', fontSize: '0.75rem', background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-primary)', outline: 'none', textAlign: 'center' }}
                                                            />
                                                        </div>
                                                    )}
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}

                            {/* Quick cost preview */}
                            {addonsCostPerCycle > 0 && (
                                <div style={{ padding: '10px 12px', borderRadius: '10px', background: 'rgba(45,212,191,0.04)', border: '1px solid rgba(45,212,191,0.1)', marginBottom: '14px' }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem' }}>
                                        <span style={{ color: 'var(--text-muted)' }}>Add-ons/ciclo</span>
                                        <span style={{ color: '#2dd4bf', fontWeight: 700 }}>+ {formatBRL(addonsCostPerCycle)}</span>
                                    </div>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8125rem', marginTop: '4px', borderTop: '1px solid rgba(45,212,191,0.1)', paddingTop: '6px' }}>
                                        <span style={{ color: 'var(--text-primary)', fontWeight: 700 }}>Total/ciclo (gravações + add-ons)</span>
                                        <span style={{ color: '#10b981', fontWeight: 800 }}>{formatBRL(cycleAmount)}</span>
                                    </div>
                                </div>
                            )}

                            {/* Actions */}
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '20px' }}>
                                <button onClick={() => setCustomStep(2)}
                                    style={{ padding: '10px 20px', borderRadius: '10px', background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-secondary)', fontSize: '0.8125rem', fontWeight: 600, cursor: 'pointer' }}>
                                    ⬅️ Voltar
                                </button>
                                <button onClick={() => setCustomStep(4)}
                                    style={{
                                        padding: '10px 28px', borderRadius: '10px', border: 'none', fontSize: '0.875rem', fontWeight: 700, cursor: 'pointer',
                                        background: 'linear-gradient(135deg, #2dd4bf, #3b82f6)',
                                        color: '#fff',
                                        display: 'flex', alignItems: 'center', gap: '8px',
                                    }}>
                                    Próximo ➡️
                                </button>
                            </div>
                        </div>
                    )}

                    {/* --- STEP 4: Pagamento & Resumo --- */}
                    {customStep === 4 && (
                        <div>
                            <div style={{ fontSize: '0.625rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: '14px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                <span style={{ width: 18, height: 18, borderRadius: '50%', background: 'rgba(16,185,129,0.15)', color: '#10b981', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.5rem', fontWeight: 800 }}>4</span>
                                <span style={{ fontSize: '0.6875rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Pagamento & Resumo</span>
                            </div>

                            {/* Payment method */}
                            <label style={cusLabelStyle}>Método de Pagamento *</label>
                            <div style={{ display: 'flex', gap: '6px', marginBottom: '16px' }}>
                                {getPaymentMethods().map(pm => (
                                    <button key={pm.key} onClick={() => setCustomForm(f => ({ ...f, paymentMethod: pm.key }))}
                                        style={{
                                            flex: 1, padding: '10px 8px', borderRadius: '10px', cursor: 'pointer',
                                            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px',
                                            background: customForm.paymentMethod === pm.key ? pm.bgActive : 'var(--bg-elevated)',
                                            border: `1px solid ${customForm.paymentMethod === pm.key ? pm.borderActive : 'var(--border-default)'}`,
                                            transition: 'all 0.15s',
                                        }}>
                                        <span style={{ fontSize: '1.25rem' }}>{pm.emoji}</span>
                                        <span style={{ fontSize: '0.75rem', fontWeight: 700, color: customForm.paymentMethod === pm.key ? pm.color : 'var(--text-primary)' }}>{pm.shortLabel}</span>
                                        <span style={{ fontSize: '0.5rem', color: 'var(--text-muted)' }}>{pm.adminDescription}</span>
                                    </button>
                                ))}
                            </div>

                            {/* Financial summary */}
                            <div style={{ padding: '16px', borderRadius: '10px', background: 'rgba(16,185,129,0.04)', border: '1px solid rgba(16,185,129,0.1)', marginBottom: '16px' }}>
                                <div style={{ fontSize: '0.625rem', fontWeight: 700, color: '#10b981', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '10px' }}>💰 Resumo Financeiro</div>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '0.8125rem' }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                        <span style={{ color: 'var(--text-muted)' }}>Base/sessão</span>
                                        <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
                                            {discountPct > 0 && <span style={{ textDecoration: 'line-through', color: 'var(--text-muted)', marginRight: '6px', fontSize: '0.75rem' }}>{formatBRL(basePrice)}</span>}
                                            {formatBRL(discountedSessionPrice)}
                                        </span>
                                    </div>
                                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                        <span style={{ color: 'var(--text-muted)' }}>{sessionsPerCycle} sessões/ciclo × {formatBRL(discountedSessionPrice)}</span>
                                        <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{formatBRL(cycleBaseAmount)}</span>
                                    </div>
                                    {addonsCostPerCycle > 0 && (
                                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                            <span style={{ color: 'var(--text-muted)' }}>Add-ons/ciclo</span>
                                            <span style={{ color: '#2dd4bf', fontWeight: 600 }}>+ {formatBRL(addonsCostPerCycle)}</span>
                                        </div>
                                    )}
                                    {discountPct > 0 && (
                                        <div style={{ display: 'flex', justifyContent: 'space-between', background: 'rgba(16,185,129,0.06)', margin: '2px -8px', padding: '4px 8px', borderRadius: '6px' }}>
                                            <span style={{ color: '#10b981', fontWeight: 600 }}>Desconto aplicado</span>
                                            <span style={{ color: '#10b981', fontWeight: 700 }}>{discountPct}% OFF</span>
                                        </div>
                                    )}
                                    <div style={{ borderTop: '1px solid rgba(16,185,129,0.15)', paddingTop: '6px', marginTop: '4px', display: 'flex', justifyContent: 'space-between' }}>
                                        <span style={{ color: 'var(--text-primary)', fontWeight: 700 }}>Valor/ciclo</span>
                                        <span style={{ color: '#10b981', fontWeight: 800, fontSize: '1rem' }}>{formatBRL(cycleAmount)}</span>
                                    </div>
                                    {appliedCoupon && (
                                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                            <span style={{ color: '#10b981', fontWeight: 700 }}>🎟️ Cupom {appliedCoupon.code}</span>
                                            <span style={{ color: '#10b981', fontWeight: 700 }}>−{formatBRL(appliedCoupon.discountAmount)}</span>
                                        </div>
                                    )}
                                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                        <span style={{ color: 'var(--text-muted)' }}>Total ({customForm.durationMonths} ciclos)</span>
                                        <span style={{ color: 'var(--text-primary)', fontWeight: 700 }}>{formatBRL(totalAmount)}</span>
                                    </div>
                                </div>
                            </div>

                            {/* Cupom de desconto (aplica na 1ª cobrança; elegibilidade é do cliente-alvo) */}
                            <div style={{ marginBottom: '16px' }}>
                                <CouponField
                                    amount={cycleAmount}
                                    userId={customForm.userId || undefined}
                                    applied={appliedCoupon}
                                    onApply={setAppliedCoupon}
                                    onRemove={() => setAppliedCoupon(null)}
                                    disabled={customSubmitting}
                                />
                            </div>

                            {/* Schedule summary */}
                            <div style={{ padding: '12px 14px', borderRadius: '10px', background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', marginBottom: '16px', fontSize: '0.75rem' }}>
                                <div style={{ fontWeight: 700, color: 'var(--text-primary)', marginBottom: '6px' }}>📅 Agenda</div>
                                {freq === 'CUSTOM' ? (
                                    <div style={{ color: 'var(--text-muted)' }}>{customForm.customDates.length} datas personalizadas</div>
                                ) : (
                                    <>
                                        {schedule.map(s => {
                                            const dayNames: Record<number, string> = { 1: 'Segunda', 2: 'Terça', 3: 'Quarta', 4: 'Quinta', 5: 'Sexta', 6: 'Sábado' };
                                            return <div key={s.day} style={{ color: 'var(--text-muted)' }}>{dayNames[s.day]} às {s.time}</div>;
                                        })}
                                        {freq !== 'WEEKLY' && (
                                            <div style={{ color: 'var(--text-muted)', marginTop: '2px', fontSize: '0.625rem' }}>
                                                Modo: {freq === 'BIWEEKLY' ? 'Quinzenal' : 'Mensal'} — Semanas {customForm.weekPattern.join(', ')}
                                            </div>
                                        )}
                                    </>
                                )}
                            </div>

                            {/* Actions */}
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '20px' }}>
                                <button onClick={() => setCustomStep(3)}
                                    style={{ padding: '10px 20px', borderRadius: '10px', background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-secondary)', fontSize: '0.8125rem', fontWeight: 600, cursor: 'pointer' }}>
                                    ⬅️ Voltar
                                </button>
                                <button onClick={handleCustomSubmit} disabled={!canStep4 || customSubmitting}
                                    style={{
                                        padding: '10px 28px', borderRadius: '10px', border: 'none', fontSize: '0.875rem', fontWeight: 700, cursor: 'pointer',
                                        background: canStep4 && !customSubmitting ? 'linear-gradient(135deg, #10b981, #11819B)' : 'var(--bg-elevated)',
                                        color: canStep4 && !customSubmitting ? '#fff' : 'var(--text-muted)',
                                        opacity: canStep4 && !customSubmitting ? 1 : 0.5,
                                        display: 'flex', alignItems: 'center', gap: '8px',
                                    }}>
                                    {customSubmitting ? '⏳ Criando...' : '✨ Criar Contrato'}
                                </button>
                            </div>
                        </div>
                    )}
                </div>
        </BottomSheetModal>
    );
}

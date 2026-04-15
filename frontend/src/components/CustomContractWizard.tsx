import { getErrorMessage } from '../utils/errors';
import React, { useState, useEffect } from 'react';
import ModalOverlay from './ModalOverlay';
import { PricingConfig, AddOnConfig, bookingsApi, contractsApi, pricingApi, CustomContractData, CustomConflict, stripeApi } from '../api/client';
import { useBusinessConfig } from '../hooks/useBusinessConfig';
import { getClientPaymentMethods } from '../constants/paymentMethods';
import StripeCardForm from './StripeCardForm';

export interface CustomContractWizardProps {
    pricing: PricingConfig[];
    onClose: () => void;
    onComplete: () => void;
}

type WizardStep = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8; // 5=loading, 6=success, 7=conflicts, 8=card-payment

const DAY_NAMES: Record<number, string> = { 1: 'Seg', 2: 'Ter', 3: 'Qua', 4: 'Qui', 5: 'Sex', 6: 'Sáb' };
const DAY_NAMES_FULL: Record<number, string> = { 1: 'Segunda', 2: 'Terça', 3: 'Quarta', 4: 'Quinta', 5: 'Sexta', 6: 'Sábado' };
const TIER_INFO: Record<string, { emoji: string; hours: string; desc: string }> = {
    COMERCIAL: { emoji: '🏢', hours: 'Horários até 17:30', desc: 'Grave durante o horário comercial com preços mais acessíveis.' },
    AUDIENCIA: { emoji: '🎤', hours: 'Horários até 23:00', desc: 'Horários flexíveis ao longo do dia e noite para maior alcance.' },
    SABADO: { emoji: '🌟', hours: 'Sábados exclusivos', desc: 'Gravações exclusivas aos sábados para conteúdo premium.' },
};

const POSSIBLE_SLOTS: Record<string, string[]> = {
    COMERCIAL: ['10:00', '13:00', '15:30'],
    AUDIENCIA: ['10:00', '13:00', '15:30', '18:00', '20:30'],
    SABADO: ['10:00', '13:00', '15:30', '18:00', '20:30'],
};

function formatBRL(cents: number): string {
    return `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;
}

export default function CustomContractWizard({ pricing, onClose, onComplete }: CustomContractWizardProps) {
    const [step, setStep] = useState<WizardStep>(1);

    // Step 1: Tier + Duration + Weekly Schedule
    const [selectedTier, setSelectedTier] = useState<string>(pricing[0]?.tier || 'COMERCIAL');
    const [contractName, setContractName] = useState('');
    const [durationMonths, setDurationMonths] = useState(3);
    const [selectedDays, setSelectedDays] = useState<number[]>([]); // [1,3,5] = Seg,Qua,Sex
    const [dayTimes, setDayTimes] = useState<Record<number, string>>({}); // {1: '10:00', 3: '18:00'}

    // Step 2: Addons
    const [addons, setAddons] = useState<AddOnConfig[]>([]);
    const [addonConfig, setAddonConfig] = useState<Record<string, { mode: 'all' | 'credits' | 'none'; perCycle: number }>>({});

    // Step 3: Payment + Terms
    const [paymentMethod, setPaymentMethod] = useState<'CARTAO' | 'PIX' | null>(null);
    const [acceptedTerms, setAcceptedTerms] = useState(false);

    // Step 7: Conflicts
    const [conflicts, setConflicts] = useState<CustomConflict[]>([]);
    const [resolvedConflicts, setResolvedConflicts] = useState<{ originalDate: string; originalTime: string; newDate: string; newTime: string }[]>([]);

    // Submission
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState('');

    // Inline card payment
    const [cardClientSecret, setCardClientSecret] = useState<string | null>(null);

    const { get: getRule } = useBusinessConfig();

    useEffect(() => {
        pricingApi.getAddons().then(res => setAddons(res.addons)).catch(console.error);
    }, []);

    // ─── Derived Calculations ────────────────────────────
    const tierConfig = pricing.find(p => p.tier === selectedTier);
    const basePrice = tierConfig?.price || 0;
    const sessionsPerWeek = selectedDays.length;
    const sessionsPerCycle = sessionsPerWeek * 4;
    const totalSessions = sessionsPerCycle * durationMonths;

    let discountPct = 0;
    if (totalSessions >= 24) discountPct = 40;
    else if (totalSessions >= 12) discountPct = 30;

    const discountedSessionPrice = Math.round(basePrice * (1 - discountPct / 100));
    const cycleBaseAmount = sessionsPerCycle * discountedSessionPrice;

    // Addon cost per cycle
    let addonsCostPerCycle = 0;
    const activeAddons = Object.entries(addonConfig).filter(([, v]) => v.mode !== 'none');
    for (const [key, config] of activeAddons) {
        const addon = addons.find(a => a.key === key);
        if (!addon) continue;
        if (config.mode === 'credits') {
            addonsCostPerCycle += Math.round(addon.price * config.perCycle * (1 - discountPct / 100));
        } else {
            addonsCostPerCycle += Math.round(addon.price * sessionsPerCycle * (1 - discountPct / 100));
        }
    }

    const cycleAmount = cycleBaseAmount + addonsCostPerCycle;
    const totalContractAmount = cycleAmount * durationMonths;

    // Discount thresholds for progress bar
    const nextThreshold = totalSessions < 12 ? 12 : totalSessions < 24 ? 24 : null;
    const sessionsToNextDiscount = nextThreshold ? nextThreshold - totalSessions : 0;

    // ─── Schedule builder ────────────────────────────────
    const schedule = selectedDays.map(day => ({
        day,
        time: dayTimes[day] || POSSIBLE_SLOTS[selectedTier]?.[0] || '10:00',
    }));

    const toggleDay = (day: number) => {
        if (selectedDays.includes(day)) {
            setSelectedDays(prev => prev.filter(d => d !== day));
            setDayTimes(prev => { const n = { ...prev }; delete n[day]; return n; });
        } else {
            setSelectedDays(prev => [...prev, day].sort());
            setDayTimes(prev => ({ ...prev, [day]: POSSIBLE_SLOTS[selectedTier]?.[0] || '10:00' }));
        }
    };

    const setDayTime = (day: number, time: string) => {
        setDayTimes(prev => ({ ...prev, [day]: time }));
    };

    // Start date: tomorrow
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const startDateStr = tomorrow.toISOString().split('T')[0];

    // ─── Handlers ────────────────────────────────────────
    const executeCreation = async (resolutions: any[] = []) => {
        setSubmitting(true);
        setError('');
        setStep(5);

        try {
            const activeAddonKeys = Object.entries(addonConfig).filter(([, v]) => v.mode !== 'none').map(([k]) => k);
            const addonConfigPayload: Record<string, { mode: 'all' | 'credits'; perCycle?: number }> = {};
            for (const [key, config] of activeAddons) {
                addonConfigPayload[key] = {
                    mode: config.mode as 'all' | 'credits',
                    ...(config.mode === 'credits' ? { perCycle: config.perCycle } : {}),
                };
            }

            const res = await contractsApi.createCustom({
                name: contractName,
                tier: selectedTier as 'COMERCIAL' | 'AUDIENCIA' | 'SABADO',
                durationMonths,
                schedule,
                paymentMethod: paymentMethod!,
                addOns: activeAddonKeys,
                addonConfig: activeAddonKeys.length > 0 ? addonConfigPayload : undefined,
                resolvedConflicts: resolutions.length > 0 ? resolutions : undefined,
                startDate: startDateStr,
            });

            // If CARTAO with clientSecret, show inline card form
            if (res.clientSecret && paymentMethod === 'CARTAO') {
                setCardClientSecret(res.clientSecret);
                setStep(8);
            } else {
                setStep(6);
            }
        } catch (err: unknown) {
            setError(getErrorMessage(err) || 'Erro ao criar contrato personalizado');
            setStep(conflicts.length > 0 ? 7 : 4);
        } finally {
            setSubmitting(false);
        }
    };

    const handleCheckAndSubmit = async () => {
        if (!paymentMethod) return;
        setSubmitting(true);
        setError('');

        try {
            const res = await contractsApi.checkCustom({
                tier: selectedTier,
                durationMonths,
                schedule,
                startDate: startDateStr,
            });

            if (!res.available && res.conflicts.length > 0) {
                setConflicts(res.conflicts);
                const autoResolutions = res.conflicts
                    .filter(c => c.suggestedReplacement)
                    .map(c => ({
                        originalDate: c.date,
                        originalTime: c.originalTime,
                        newDate: c.suggestedReplacement!.date,
                        newTime: c.suggestedReplacement!.time,
                    }));
                setResolvedConflicts(autoResolutions);
                setStep(7);
                setSubmitting(false);
                return;
            }

            await executeCreation([]);
        } catch (err: unknown) {
            setError(getErrorMessage(err) || 'Erro ao validar agenda');
            setStep(4);
            setSubmitting(false);
        }
    };

    const availableSlots = POSSIBLE_SLOTS[selectedTier] || [];
    const allowedDays = selectedTier === 'SABADO' ? [6] : [1, 2, 3, 4, 5];

    const progressSteps = step >= 5 && step !== 7 ? 4 : step;

    // ─── Render ──────────────────────────────────────────
    return (
        <ModalOverlay onClose={onClose}>
            <div className="modal" style={{ maxWidth: 900, width: '95%', maxHeight: '92vh', overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
                {/* Header */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                    <h2 className="modal-title" style={{ margin: 0 }}>🎨 Monte Seu Plano</h2>
                    <button className="btn btn-ghost btn-sm" onClick={onClose}>✕</button>
                </div>

                {/* Progress */}
                <div style={{ display: 'flex', gap: '8px', marginBottom: '24px' }}>
                    {[1, 2, 3, 4].map(s => (
                        <div key={s} style={{
                            flex: 1, height: 4, borderRadius: 2,
                            background: progressSteps >= s ? 'var(--accent-primary)' : 'var(--bg-elevated)',
                            transition: 'background 0.3s ease'
                        }} />
                    ))}
                </div>

                <div style={{ display: 'flex', gap: '24px', flex: 1, minHeight: 0 }}>
                    {/* Main Content */}
                    <div style={{ flex: 1, overflowY: 'auto' }}>

                        {/* ══════════ STEP 5: LOADING ══════════ */}
                        {step === 5 && (
                            <div style={{ textAlign: 'center', padding: '48px 0' }}>
                                <div className="spinner" style={{ margin: '0 auto 20px', width: 40, height: 40 }} />
                                <h3 style={{ fontSize: '1.25rem', marginBottom: '8px' }}>Processando...</h3>
                                <p style={{ color: 'var(--text-muted)' }}>Gerando {totalSessions} agendamentos. Aguarde um instante.</p>
                            </div>
                        )}

                        {/* ══════════ STEP 6: SUCCESS ══════════ */}
                        {step === 6 && (
                            <div style={{ textAlign: 'center', padding: '48px 0' }}>
                                <div style={{ fontSize: '3.5rem', marginBottom: '16px' }}>🎉</div>
                                <h3 style={{ fontSize: '1.25rem', marginBottom: '8px' }}>Plano Personalizado Criado!</h3>
                                <p style={{ color: 'var(--text-muted)', marginBottom: '12px' }}>
                                    {`${sessionsPerWeek}x/semana · ${totalSessions} sessões em ${durationMonths} meses · ${discountPct}% de desconto`}
                                </p>
                                <p style={{ color: 'var(--text-muted)', marginBottom: '28px', fontSize: '0.875rem' }}>
                                    {paymentMethod && getClientPaymentMethods().find(pm => pm.key === paymentMethod)?.accessMode === 'PROGRESSIVE'
                                        ? 'As sessões do primeiro ciclo estão confirmadas. Os próximos meses serão liberados após pagamento.'
                                        : 'Todas as sessões estão confirmadas na sua agenda!'}
                                </p>
                                <button className="btn btn-primary" style={{ width: '100%' }} onClick={() => { onComplete(); onClose(); }}>
                                    ✅ Ver Meus Contratos
                                </button>
                            </div>
                        )}

                        {/* ══════════ STEP 8: INLINE CARD PAYMENT ══════════ */}
                        {step === 8 && cardClientSecret && (
                            <div style={{ padding: '20px 0' }}>
                                <div style={{ textAlign: 'center', marginBottom: '24px' }}>
                                    <div style={{ fontSize: '2.5rem', marginBottom: '8px' }}>💳</div>
                                    <h3 style={{ fontSize: '1.25rem', marginBottom: '8px' }}>Pagamento do 1º Ciclo</h3>
                                    <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>
                                        Complete o pagamento para ativar seu plano personalizado.
                                    </p>
                                </div>

                                <div style={{
                                    padding: '12px 16px', borderRadius: 'var(--radius-md)',
                                    background: 'rgba(34, 197, 94, 0.06)', border: '1px solid rgba(34, 197, 94, 0.2)',
                                    fontSize: '0.8125rem', color: '#22c55e', fontWeight: 600,
                                    textAlign: 'center', marginBottom: '24px'
                                }}>
                                    💰 Valor: {formatBRL(cycleAmount)} (1º ciclo de {durationMonths}x)
                                </div>

                                <StripeCardForm
                                    mode="payment"
                                    clientSecret={cardClientSecret}
                                    onSuccess={() => setStep(6)}
                                    onError={(msg) => { setError(msg); setStep(3); }}
                                    onCancel={() => setStep(6)}
                                    submitLabel={`Pagar ${formatBRL(cycleAmount)}`}
                                />

                                <button
                                    className="btn btn-ghost btn-sm"
                                    style={{ width: '100%', marginTop: '12px', fontSize: '0.75rem', color: 'var(--text-muted)' }}
                                    onClick={() => setStep(6)}
                                >
                                    Pagar depois na aba Pagamentos →
                                </button>
                            </div>
                        )}

                        {/* ══════════ STEP 1: FREQUENCY & DURATION ══════════ */}
                        {step === 1 && (
                            <div>
                                <h3 style={{ fontSize: '1.125rem', marginBottom: '16px' }}>1. Construa sua Grade</h3>

                                {/* Name */}
                                <div className="form-group" style={{ marginBottom: '16px' }}>
                                    <label className="form-label">Nome do Projeto</label>
                                    <input className="form-input" type="text" value={contractName} onChange={e => setContractName(e.target.value)} placeholder="Ex: Podcast Tech Talks" />
                                </div>

                                {/* Tier */}
                                <div style={{ display: 'flex', gap: '4px', marginBottom: '12px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)', padding: '4px' }}>
                                    {pricing.map(p => {
                                        const info = TIER_INFO[p.tier];
                                        return (
                                            <button key={p.tier} onClick={() => { setSelectedTier(p.tier); setSelectedDays([]); setDayTimes({}); }}
                                                style={{
                                                    flex: 1, padding: '10px 8px', border: 'none', borderRadius: 'var(--radius-sm)',
                                                    background: selectedTier === p.tier ? 'var(--accent-primary)' : 'transparent',
                                                    color: selectedTier === p.tier ? '#fff' : 'var(--text-secondary)',
                                                    fontWeight: selectedTier === p.tier ? 700 : 500, fontSize: '0.8125rem', cursor: 'pointer', transition: 'all 0.2s ease',
                                                }}>
                                                {info?.emoji} {p.label}
                                            </button>
                                        );
                                    })}
                                </div>

                                {/* Duration Months */}
                                <div className="form-group" style={{ marginBottom: '20px' }}>
                                    <label className="form-label">Quantidade de Meses (Fidelidade)</label>
                                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                                        {[1, 3, 6, 9, 12].map(m => (
                                            <button key={m} onClick={() => setDurationMonths(m)}
                                                style={{
                                                    flex: '1 1 auto', minWidth: 60, padding: '12px 8px', borderRadius: 'var(--radius-md)',
                                                    background: durationMonths === m ? 'var(--accent-primary)' : 'var(--bg-secondary)',
                                                    color: durationMonths === m ? '#fff' : 'var(--text-primary)',
                                                    fontWeight: 700, fontSize: '0.9375rem', cursor: 'pointer', transition: 'all 0.2s ease',
                                                    border: durationMonths === m ? '2px solid var(--accent-primary)' : '2px solid var(--border-subtle)',
                                                }}>
                                                {m} {m === 1 ? 'mês' : 'meses'}
                                            </button>
                                        ))}
                                    </div>
                                </div>

                                {/* Day Selection */}
                                <div className="form-group" style={{ marginBottom: '16px' }}>
                                    <label className="form-label">Quais dias da semana você quer gravar?</label>
                                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                                        {allowedDays.map(day => {
                                            const isSelected = selectedDays.includes(day);
                                            return (
                                                <button key={day} onClick={() => toggleDay(day)}
                                                    style={{
                                                        flex: '1 1 auto', minWidth: 55, padding: '14px 8px', borderRadius: 'var(--radius-md)',
                                                        background: isSelected ? 'rgba(139, 92, 246, 0.15)' : 'var(--bg-secondary)',
                                                        border: `2px solid ${isSelected ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                                                        color: isSelected ? 'var(--accent-primary)' : 'var(--text-secondary)',
                                                        fontWeight: 700, fontSize: '0.9375rem', cursor: 'pointer', transition: 'all 0.2s ease',
                                                    }}>
                                                    {DAY_NAMES[day]}
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>

                                {/* Time pickers for each selected day */}
                                {selectedDays.length > 0 && (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '20px', padding: '16px', background: 'var(--bg-card)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-subtle)' }}>
                                        <div style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '4px' }}>Escolha os Horários</div>
                                        {selectedDays.map(day => (
                                            <div key={day} style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                                                <span style={{ minWidth: 65, fontWeight: 700, fontSize: '0.875rem', color: 'var(--accent-primary)' }}>
                                                    {DAY_NAMES_FULL[day]}:
                                                </span>
                                                <select className="form-input" style={{ flex: 1, maxWidth: 200 }}
                                                    value={dayTimes[day] || availableSlots[0]}
                                                    onChange={e => setDayTime(day, e.target.value)}>
                                                    {availableSlots.map(slot => {
                                                        const [h] = slot.split(':').map(Number);
                                                        return <option key={slot} value={slot}>{slot} - {h + 2}:{slot.split(':')[1]}</option>;
                                                    })}
                                                </select>
                                            </div>
                                        ))}
                                    </div>
                                )}

                                {/* Discount Progress Bar */}
                                {selectedDays.length > 0 && (
                                    <div style={{ padding: '14px 16px', borderRadius: 'var(--radius-md)', marginBottom: '20px', background: discountPct >= 40 ? 'rgba(34, 197, 94, 0.1)' : discountPct >= 30 ? 'rgba(234, 179, 8, 0.1)' : 'rgba(139, 92, 246, 0.06)', border: `1px solid ${discountPct >= 40 ? 'rgba(34, 197, 94, 0.3)' : discountPct >= 30 ? 'rgba(234, 179, 8, 0.3)' : 'var(--border-subtle)'}` }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                                            <span style={{ fontWeight: 700, fontSize: '0.875rem' }}>
                                                {discountPct >= 40 ? '🏆 Desconto Ouro Ativado!' : discountPct >= 30 ? '🎉 Desconto Prata Ativado!' : '📊 Barra de Desconto'}
                                            </span>
                                            <span style={{ fontWeight: 800, fontSize: '1.125rem', color: discountPct >= 40 ? '#22c55e' : discountPct >= 30 ? '#ca8a04' : 'var(--text-muted)' }}>
                                                {discountPct > 0 ? `-${discountPct}%` : '0%'}
                                            </span>
                                        </div>
                                        {/* Progress bar */}
                                        <div style={{ height: 8, borderRadius: 4, background: 'var(--bg-elevated)', overflow: 'hidden', marginBottom: '6px' }}>
                                            <div style={{
                                                height: '100%', borderRadius: 4, transition: 'width 0.5s ease, background 0.3s',
                                                width: `${Math.min(100, (totalSessions / 24) * 100)}%`,
                                                background: discountPct >= 40 ? '#22c55e' : discountPct >= 30 ? '#eab308' : 'var(--accent-primary)',
                                            }} />
                                        </div>
                                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                            {totalSessions} sessões no contrato
                                            {nextThreshold && ` · Faltam ${sessionsToNextDiscount} para ${nextThreshold >= 24 ? '40%' : '30%'} de desconto!`}
                                        </div>
                                    </div>
                                )}

                                <div className="modal-actions">
                                    <button className="btn btn-primary" style={{ width: '100%' }}
                                        onClick={() => setStep(2)}
                                        disabled={!contractName.trim() || selectedDays.length === 0}>
                                        Continuar ➔
                                    </button>
                                </div>
                            </div>
                        )}

                        {/* ══════════ STEP 2: ADDONS ══════════ */}
                        {step === 2 && (
                            <div>
                                <h3 style={{ fontSize: '1.125rem', marginBottom: '16px' }}>2. Serviços Adicionais</h3>
                                <p style={{ fontSize: '0.875rem', color: 'var(--text-muted)', marginBottom: '24px' }}>
                                    Escolha como quer ativar cada serviço: para <strong>todas</strong> as gravações, ou como <strong>créditos flexíveis</strong> por ciclo.
                                </p>

                                <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', marginBottom: '28px' }}>
                                    {addons.filter(a => a.key !== 'GESTAO_SOCIAL').map(addon => {
                                        const config = addonConfig[addon.key] || { mode: 'none', perCycle: 4 };
                                        const isActive = config.mode !== 'none';

                                        // Calculate prices
                                        const priceAll = Math.round(addon.price * sessionsPerCycle * (1 - discountPct / 100));
                                        const pricePerCredit = Math.round(addon.price * (1 - discountPct / 100));

                                        return (
                                            <div key={addon.key} style={{
                                                padding: '18px', borderRadius: 'var(--radius-md)',
                                                background: isActive ? 'rgba(139, 92, 246, 0.06)' : 'var(--bg-secondary)',
                                                border: `2px solid ${isActive ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                                                transition: 'all 0.2s ease',
                                            }}>
                                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px' }}>
                                                    <div>
                                                        <div style={{ fontWeight: 800, fontSize: '1rem', color: isActive ? 'var(--accent-primary)' : 'var(--text-primary)' }}>{addon.name}</div>
                                                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '2px' }}>{addon.description || 'Potencialize a entrega do seu projeto.'}</div>
                                                    </div>
                                                    {discountPct > 0 && (
                                                        <span style={{ fontSize: '0.625rem', background: 'var(--tier-comercial)', color: '#fff', padding: '2px 6px', borderRadius: '4px', fontWeight: 700, whiteSpace: 'nowrap' }}>-{discountPct}%</span>
                                                    )}
                                                </div>

                                                {/* 3-option radio */}
                                                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                                    <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '0.8125rem' }}
                                                        onClick={() => setAddonConfig(prev => ({ ...prev, [addon.key]: { mode: 'none', perCycle: 4 } }))}>
                                                        <input type="radio" checked={config.mode === 'none'} readOnly style={{ accentColor: 'var(--accent-primary)' }} />
                                                        <span>Não preciso</span>
                                                    </label>

                                                    <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '0.8125rem' }}
                                                        onClick={() => setAddonConfig(prev => ({ ...prev, [addon.key]: { mode: 'all', perCycle: 4 } }))}>
                                                        <input type="radio" checked={config.mode === 'all'} readOnly style={{ accentColor: 'var(--accent-primary)' }} />
                                                        <span>Aplicar em <strong>todas</strong> as {sessionsPerCycle} gravações</span>
                                                        <span style={{ marginLeft: 'auto', fontWeight: 700, fontSize: '0.8125rem', color: 'var(--accent-primary)' }}>+{formatBRL(priceAll)}/ciclo</span>
                                                    </label>

                                                    <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '0.8125rem' }}
                                                        onClick={() => setAddonConfig(prev => ({ ...prev, [addon.key]: { mode: 'credits', perCycle: prev[addon.key]?.perCycle || 4 } }))}>
                                                        <input type="radio" checked={config.mode === 'credits'} readOnly style={{ accentColor: 'var(--accent-primary)' }} />
                                                        <span>Banco de Créditos</span>
                                                    </label>

                                                    {config.mode === 'credits' && (
                                                        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginLeft: '28px', padding: '10px 14px', background: 'var(--bg-card)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-subtle)' }}>
                                                            <span style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>Créditos por ciclo:</span>
                                                            <button className="btn btn-ghost btn-sm" style={{ padding: '4px 10px', fontWeight: 800 }}
                                                                onClick={() => setAddonConfig(prev => ({ ...prev, [addon.key]: { ...prev[addon.key], perCycle: Math.max(1, (prev[addon.key]?.perCycle || 4) - 1) } }))}>
                                                                −
                                                            </button>
                                                            <span style={{ fontWeight: 800, fontSize: '1.125rem', minWidth: 25, textAlign: 'center' }}>{config.perCycle}</span>
                                                            <button className="btn btn-ghost btn-sm" style={{ padding: '4px 10px', fontWeight: 800 }}
                                                                onClick={() => setAddonConfig(prev => ({ ...prev, [addon.key]: { ...prev[addon.key], perCycle: Math.min(sessionsPerCycle, (prev[addon.key]?.perCycle || 4) + 1) } }))}>
                                                                +
                                                            </button>
                                                            <span style={{ marginLeft: 'auto', fontWeight: 700, fontSize: '0.8125rem', color: 'var(--accent-primary)' }}>
                                                                +{formatBRL(pricePerCredit * config.perCycle)}/ciclo
                                                            </span>
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>

                                <div className="modal-actions" style={{ justifyContent: 'space-between' }}>
                                    <button className="btn btn-secondary" onClick={() => setStep(1)}>⬅ Voltar</button>
                                    <button className="btn btn-primary" onClick={() => setStep(3)}>
                                        {activeAddons.length > 0 ? 'Continuar ➔' : 'Pular Serviços ➔'}
                                    </button>
                                </div>
                            </div>
                        )}

                        {/* ══════════ STEP 3: PAYMENT + TERMS ══════════ */}
                        {step === 3 && (
                            <div>
                                <h3 style={{ fontSize: '1.125rem', marginBottom: '16px' }}>3. Pagamento e Termos</h3>

                                {error && (
                                    <div style={{ padding: '12px 16px', borderRadius: 'var(--radius-md)', background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.3)', color: '#ef4444', fontSize: '0.875rem', marginBottom: '16px' }}>
                                        ❌ {error}
                                    </div>
                                )}

                                {/* Payment Method Cards */}
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '20px' }}>
                                    {getClientPaymentMethods().map(pm => {
                                        const isSelected = paymentMethod === pm.key;
                                        let displayPrice = '';
                                        let subPrice = '';
                                        let badge: React.ReactNode = null;
                                        let desc = '';

                                        if (pm.key === 'PIX') {
                                            displayPrice = formatBRL(Math.round(totalContractAmount * 0.9));
                                            subPrice = formatBRL(totalContractAmount);
                                            badge = <span style={{ background: '#22c55e', color: '#fff', fontSize: '0.5625rem', padding: '2px 6px', borderRadius: '6px', marginLeft: '6px', fontWeight: 700 }}>-10%</span>;
                                            desc = 'Liberação integral. Todas as sessões confirmadas de uma vez.';
                                        } else if (pm.key === 'CARTAO') {
                                            displayPrice = `${durationMonths}x ${formatBRL(Math.round(cycleAmount * 1.15))}`;
                                            subPrice = `Total: ${formatBRL(Math.round(totalContractAmount * 1.15))}`;
                                            badge = <span style={{ background: 'var(--bg-elevated)', color: 'var(--text-muted)', fontSize: '0.5625rem', padding: '2px 6px', borderRadius: '6px', marginLeft: '6px', fontWeight: 700 }}>+15% TAXA</span>;
                                            desc = 'Liberação integral. Todas as sessões confirmadas.';
                                        } else {
                                            displayPrice = `${durationMonths}x ${formatBRL(cycleAmount)}`;
                                            subPrice = `Total: ${formatBRL(totalContractAmount)}`;
                                            desc = 'Liberação progressiva. Sessões destravadas a cada pagamento.';
                                        }

                                        return (
                                            <div key={pm.key} onClick={() => setPaymentMethod(pm.key as 'CARTAO' | 'PIX')}
                                                style={{
                                                    padding: '14px 16px', borderRadius: 'var(--radius-md)', cursor: 'pointer',
                                                    background: isSelected ? pm.bgActive : pm.bgInactive,
                                                    border: `2px solid ${isSelected ? pm.borderActive : pm.borderInactive}`,
                                                    transition: 'all 0.2s ease',
                                                }}>
                                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                                    <div>
                                                        <div style={{ fontWeight: 700, fontSize: '0.875rem' }}>{pm.emoji} {pm.accessMode === 'FULL' && pm.key === 'PIX' ? `${pm.label} à vista` : pm.accessMode === 'FULL' ? `${pm.shortLabel} em ${durationMonths}x` : `${pm.label} Mensal`} {badge}</div>
                                                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{desc}</div>
                                                    </div>
                                                    <div style={{ textAlign: 'right' }}>
                                                        <div style={{ fontWeight: 800, fontSize: '1rem', color: pm.color }}>{displayPrice}</div>
                                                        <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', textDecoration: pm.key === 'PIX' ? 'line-through' : 'none' }}>{subPrice}</div>
                                                    </div>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>

                                {/* Progressive access warning */}
                                {paymentMethod && getClientPaymentMethods().find(pm => pm.key === paymentMethod)?.accessMode === 'PROGRESSIVE' && (
                                    <div style={{ padding: '12px 14px', borderRadius: 'var(--radius-md)', marginBottom: '16px', background: 'rgba(239, 68, 68, 0.06)', border: '1px solid rgba(239, 68, 68, 0.2)', fontSize: '0.8125rem', color: '#ef4444' }}>
                                        ⚠️ <strong>Atenção:</strong> No {getClientPaymentMethods().find(pm => pm.key === paymentMethod)?.shortLabel || 'boleto'} mensal, as sessões do próximo ciclo só são liberadas após a compensação do pagamento. Atrasos suspendem os agendamentos.
                                    </div>
                                )}

                                {/* Pre-paid notice */}
                                <div style={{ padding: '12px 14px', borderRadius: 'var(--radius-md)', marginBottom: '20px', background: 'rgba(234, 179, 8, 0.06)', border: '1px solid rgba(234, 179, 8, 0.2)', fontSize: '0.8125rem', color: '#ca8a04' }}>
                                    💡 O uso do estúdio é <strong>100% pré-pago</strong>. A cada 4 semanas é gerado um ciclo de cobrança. Seus horários são garantidos enquanto o pagamento estiver em dia.
                                </div>

                                {/* Terms */}
                                <div style={{ padding: '16px', borderRadius: 'var(--radius-md)', background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)', marginBottom: '20px' }}>
                                    <div style={{ fontWeight: 700, fontSize: '0.8125rem', marginBottom: '10px', color: 'var(--text-secondary)' }}>📋 Termos e Regras</div>
                                    <ul style={{ fontSize: '0.75rem', color: 'var(--text-muted)', paddingLeft: '18px', margin: '0 0 12px 0', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                        <li>Ciclos de pagamento a cada <strong>4 semanas</strong> ({durationMonths} ciclos).</li>
                                        <li>Cancelamento com menos de <strong>24 horas</strong> de antecedência implica na perda do crédito.</li>
                                        <li>Remarcação permitida com até <strong>7 dias</strong> de antecedência.</li>
                                        <li>Créditos de serviços não utilizados no ciclo expiram ao término do mesmo.</li>
                                        <li>Horários fixos são reservados automaticamente para toda a duração do contrato.</li>
                                    </ul>
                                    <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '0.8125rem', fontWeight: 600 }}>
                                        <input type="checkbox" checked={acceptedTerms} onChange={e => setAcceptedTerms(e.target.checked)} style={{ width: 18, height: 18, accentColor: 'var(--accent-primary)' }} />
                                        Li e aceito as regras acima
                                    </label>
                                </div>

                                <div className="modal-actions" style={{ justifyContent: 'space-between' }}>
                                    <button className="btn btn-secondary" onClick={() => setStep(2)}>⬅ Voltar</button>
                                    <button className="btn btn-primary" onClick={handleCheckAndSubmit} disabled={!acceptedTerms || submitting || !paymentMethod}>
                                        {submitting ? '⏳ Verificando agenda...' : '🔒 Confirmar Plano'}
                                    </button>
                                </div>
                            </div>
                        )}

                        {/* ══════════ STEP 4: (not used, reserved) ══════════ */}

                        {/* ══════════ STEP 7: CONFLICTS ══════════ */}
                        {step === 7 && (
                            <div>
                                <div style={{ textAlign: 'center', marginBottom: '20px' }}>
                                    <div style={{ fontSize: '2.5rem', marginBottom: '8px' }}>⚠️</div>
                                    <h3 style={{ fontSize: '1.25rem', color: '#ef4444' }}>Conflitos de Agenda Encontrados</h3>
                                    <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>Alguns horários do seu plano já estão ocupados por outros clientes.</p>
                                </div>

                                <div style={{ background: 'var(--bg-secondary)', padding: '16px', borderRadius: 'var(--radius-md)', marginBottom: '24px' }}>
                                    <div style={{ fontWeight: 700, marginBottom: '12px', fontSize: '0.875rem' }}>Datas em conflito ({conflicts.length}):</div>
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', maxHeight: 300, overflowY: 'auto' }}>
                                        {conflicts.map((c, i) => {
                                            const [y, m, d] = c.date.split('-');
                                            return (
                                                <div key={i} style={{ padding: '12px', background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' }}>
                                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                                                        <span style={{ fontWeight: 600 }}>{DAY_NAMES_FULL[c.day]}, {d}/{m}/{y} às {c.originalTime}</span>
                                                        <span style={{ fontSize: '0.7rem', color: '#ef4444', fontWeight: 600, background: 'rgba(239, 68, 68, 0.1)', padding: '2px 8px', borderRadius: '10px' }}>Ocupado</span>
                                                    </div>
                                                    {c.suggestedReplacement ? (
                                                        <div style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                                                            <span>💡 Sugestão:</span>
                                                            <span style={{ background: 'rgba(34, 197, 94, 0.1)', color: '#22c55e', padding: '3px 8px', borderRadius: '4px', fontWeight: 600, fontSize: '0.75rem' }}>
                                                                {c.suggestedReplacement.time} no mesmo dia
                                                            </span>
                                                        </div>
                                                    ) : (
                                                        <div style={{ fontSize: '0.8125rem', color: '#f59e0b' }}>⚠️ Dia lotado — sessão será compensada ao final do contrato.</div>
                                                    )}
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>

                                <div className="modal-actions" style={{ flexDirection: 'column', gap: '12px' }}>
                                    <button className="btn btn-primary" style={{ width: '100%', padding: '14px' }}
                                        onClick={() => executeCreation(resolvedConflicts)}>
                                        ✅ Aceitar Sugestões e Confirmar
                                    </button>
                                    <button className="btn btn-secondary" style={{ width: '100%', padding: '14px' }}
                                        onClick={() => setStep(1)}>
                                        ⬅ Voltar e ajustar horários
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>

                    {/* ══════════ STICKY SIDEBAR: CART ══════════ */}
                    {step <= 4 && (
                        <div style={{
                            width: 280, minWidth: 280, padding: '20px', borderRadius: 'var(--radius-md)',
                            background: 'var(--bg-card)', border: '1px solid var(--border-subtle)',
                            alignSelf: 'flex-start', position: 'sticky', top: 0,
                        }}>
                            <div style={{ fontWeight: 700, fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: '16px' }}>
                                💰 Seu Plano
                            </div>

                            {/* Tier + Schedule */}
                            <div style={{ marginBottom: '12px' }}>
                                <div style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', marginBottom: '2px' }}>Faixa</div>
                                <div style={{ fontWeight: 700, fontSize: '0.875rem' }}>{TIER_INFO[selectedTier]?.emoji} {tierConfig?.label || selectedTier}</div>
                            </div>

                            <div style={{ marginBottom: '12px' }}>
                                <div style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', marginBottom: '2px' }}>Fidelidade</div>
                                <div style={{ fontWeight: 700, fontSize: '0.875rem' }}>{durationMonths} {durationMonths === 1 ? 'mês' : 'meses'}</div>
                            </div>

                            {selectedDays.length > 0 && (
                                <>
                                    <div style={{ marginBottom: '12px' }}>
                                        <div style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', marginBottom: '2px' }}>Grade Semanal</div>
                                        <div style={{ fontWeight: 700, fontSize: '0.875rem' }}>
                                            {selectedDays.map(d => `${DAY_NAMES[d]} ${dayTimes[d] || ''}`).join(' · ')}
                                        </div>
                                    </div>

                                    <div style={{ marginBottom: '12px' }}>
                                        <div style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', marginBottom: '2px' }}>Volume Total</div>
                                        <div style={{ fontWeight: 700, fontSize: '0.875rem' }}>{totalSessions} sessões ({sessionsPerCycle}/ciclo)</div>
                                    </div>

                                    {discountPct > 0 && (
                                        <div style={{ marginBottom: '12px' }}>
                                            <div style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', marginBottom: '2px' }}>Desconto</div>
                                            <div style={{ fontWeight: 800, fontSize: '1rem', color: discountPct >= 40 ? '#22c55e' : '#ca8a04' }}>-{discountPct}%</div>
                                        </div>
                                    )}

                                    {/* Addon list */}
                                    {activeAddons.length > 0 && (
                                        <div style={{ marginBottom: '12px', borderTop: '1px dashed var(--border-subtle)', paddingTop: '10px' }}>
                                            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '6px' }}>Serviços:</div>
                                            {activeAddons.map(([key, config]) => {
                                                const addon = addons.find(a => a.key === key);
                                                return addon ? (
                                                    <div key={key} style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '3px' }}>
                                                        • {addon.name} ({config.mode === 'all' ? 'todas' : `${config.perCycle} créd.`})
                                                    </div>
                                                ) : null;
                                            })}
                                        </div>
                                    )}

                                    <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: '12px', marginTop: '8px' }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                                            <span style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>Ciclo (4 sem.)</span>
                                            <span style={{ fontWeight: 800, fontSize: '1rem' }}>{formatBRL(cycleAmount)}</span>
                                        </div>
                                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Total ({durationMonths}x)</span>
                                            <span style={{ fontWeight: 600, fontSize: '0.75rem', color: 'var(--text-muted)' }}>{formatBRL(totalContractAmount)}</span>
                                        </div>
                                        {basePrice > 0 && (
                                            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px' }}>
                                                <span style={{ fontSize: '0.6875rem', color: 'var(--text-muted)' }}>Sessão equivalente</span>
                                                <span style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', textDecoration: discountPct > 0 ? 'line-through' : 'none' }}>{formatBRL(basePrice)}</span>
                                            </div>
                                        )}
                                        {discountPct > 0 && (
                                            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                                                <span style={{ fontSize: '0.75rem', fontWeight: 700, color: discountPct >= 40 ? '#22c55e' : '#ca8a04' }}>{formatBRL(discountedSessionPrice)}/sessão</span>
                                            </div>
                                        )}
                                    </div>
                                </>
                            )}

                            {selectedDays.length === 0 && (
                                <div style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', fontStyle: 'italic', marginTop: '12px' }}>
                                    Selecione os dias para ver o resumo
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </ModalOverlay>
    );
}

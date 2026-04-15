import { getErrorMessage } from '../utils/errors';
import React, { useState, useEffect } from 'react';
import ModalOverlay from './ModalOverlay';
import { PricingConfig, AddOnConfig, bookingsApi, contractsApi, Slot, pricingApi, stripeApi } from '../api/client';
import { useBusinessConfig } from '../hooks/useBusinessConfig';
import { getClientPaymentMethods, type PaymentMethodKey } from '../constants/paymentMethods';
import InlineCheckout from './InlineCheckout';
import StripeCardForm from './StripeCardForm';

export interface ContractWizardProps {
    pricing: PricingConfig[];
    onClose: () => void;
    onComplete: () => void;
    onOpenCustom?: () => void;
}

type WizardStep = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8; // 5=loading, 6=success, 7=conflicts, 8=card-payment

const TIER_INFO: Record<string, { emoji: string; hours: string; desc: string }> = {
    COMERCIAL: { emoji: '🏢', hours: 'Horários até 17:30', desc: 'Grave durante o horário comercial com preços mais acessíveis.' },
    AUDIENCIA: { emoji: '🎤', hours: 'Horários até 23:00', desc: 'Horários flexíveis ao longo do dia e noite para maior alcance.' },
    SABADO: { emoji: '🌟', hours: 'Sábados exclusivos', desc: 'Gravações exclusivas aos sábados para conteúdo premium.' },
};

const DAY_NAMES_FULL = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

function formatBRL(cents: number): string {
    return `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;
}

export default function ContractWizard({ pricing, onClose, onComplete, onOpenCustom }: ContractWizardProps) {
    const [step, setStep] = useState<WizardStep>(1);

    // Step 1: Tier + Plan selection
    const [selectedTier, setSelectedTier] = useState<string>(pricing[0]?.tier || 'COMERCIAL');
    const [selectedPlan, setSelectedPlan] = useState<'3MESES' | '6MESES'>('3MESES');
    const [contractName, setContractName] = useState<string>('');

    // Step 2: Fixo/Flex + First booking
    const [scheduleType, setScheduleType] = useState<'FIXO' | 'FLEX' | null>(null);
    const [firstDate, setFirstDate] = useState('');
    const [firstTime, setFirstTime] = useState('');
    const [availableSlots, setAvailableSlots] = useState<Slot[]>([]);
    const [loadingSlots, setLoadingSlots] = useState(false);

    // Step 3: Terms + Payment
    const [acceptedTerms, setAcceptedTerms] = useState(false);
    const [paymentMethod, setPaymentMethod] = useState<'CARTAO' | 'PIX' | null>(null);
    const [addons, setAddons] = useState<AddOnConfig[]>([]);
    const [selectedAddons, setSelectedAddons] = useState<string[]>([]);

    useEffect(() => {
        pricingApi.getAddons().then(res => setAddons(res.addons)).catch(console.error);
    }, []);

    // Submission
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState('');

    // Inline card payment
    const [cardClientSecret, setCardClientSecret] = useState<string | null>(null);

    // Conflicts
    const [conflicts, setConflicts] = useState<{ date: string, originalTime: string, suggestedReplacement?: { date: string, time: string } }[]>([]);
    const [resolvedConflicts, setResolvedConflicts] = useState<{ originalDate: string, originalTime: string, newDate: string, newTime: string }[]>([]);

    // Business rules from admin config
    const { get: getRule } = useBusinessConfig();

    // Derived
    const tierConfig = pricing.find(p => p.tier === selectedTier);
    const basePrice = tierConfig?.price || 0;
    const duration = selectedPlan === '6MESES' ? 6 : 3;
    const discountPct = selectedPlan === '6MESES' ? getRule('discount_6months') : getRule('discount_3months');
    const sessionsPerMonth = getRule('sessions_per_month');
    const discountedPrice = Math.round(basePrice * (1 - discountPct / 100));
    const totalGravacoes = duration * sessionsPerMonth;

    const baseAddonsTotal = selectedAddons.reduce((acc, key) => {
        const addon = addons.find(a => a.key === key);
        return acc + (addon ? addon.price : 0);
    }, 0);
    const discountedAddonsTotal = Math.round(baseAddonsTotal * (1 - discountPct / 100));
    const monthlyTotal = (sessionsPerMonth * discountedPrice) + discountedAddonsTotal;

    // Generate 14 days ahead
    const now = new Date();
    const allowedDates = Array.from({ length: 14 }, (_, i) => {
        const d = new Date(now);
        d.setDate(d.getDate() + i + 1);
        return d;
    }).filter(d => {
        // Exclude Sundays for all tiers
        if (d.getDay() === 0) return false;
        // For COMERCIAL: also exclude Saturdays (Mon-Fri only)
        if (selectedTier === 'COMERCIAL') return d.getDay() >= 1 && d.getDay() <= 5;
        // AUDIENCIA and SABADO: show all days except Sunday
        return true;
    });

    useEffect(() => {
        if (step === 2 && firstDate && tierConfig) {
            setLoadingSlots(true);
            bookingsApi.getAvailability(firstDate)
                .then(res => {
                    setAvailableSlots(res.slots); // Keep all slots to show locks
                })
                .catch(err => console.error(err))
                .finally(() => setLoadingSlots(false));
        }
    }, [step, firstDate, tierConfig]);

    const executeCreation = async (resolutions: any[] = []) => {
        setSubmitting(true);
        setError('');
        setStep(5);

        try {
            const firstDateObj = new Date(`${firstDate}T12:00:00`);
            const dayOfWeek = firstDateObj.getDay() === 0 ? 7 : firstDateObj.getDay();

            const res = await contractsApi.createSelf({
                name: contractName,
                type: scheduleType || 'FLEX',
                tier: selectedTier as 'COMERCIAL' | 'AUDIENCIA' | 'SABADO',
                durationMonths: duration as 3 | 6,
                firstBookingDate: firstDate,
                firstBookingTime: firstTime,
                paymentMethod: paymentMethod!,
                addOns: selectedAddons,
                resolvedConflicts: resolutions.length > 0 ? resolutions : undefined,
                ...(scheduleType === 'FIXO' ? { fixedDayOfWeek: dayOfWeek, fixedTime: firstTime } : {}),
            });

            // If CARTAO with clientSecret, show inline card form
            if (res.clientSecret && paymentMethod === 'CARTAO') {
                setCardClientSecret(res.clientSecret);
                setStep(8);
            } else if (paymentMethod === 'PIX') {
                // Route to step 8 where InlineCheckout handles PIX via Cora
                setStep(8);
            } else {
                setStep(6);
            }
        } catch (err: unknown) {
            setError(getErrorMessage(err) || 'Erro ao processar criação do contrato');
            setStep(conflicts.length > 0 ? 7 : 4);
        } finally {
            setSubmitting(false);
        }
    };

    const handleSubmit = async () => {
        if (!tierConfig || !firstDate || !firstTime) return;
        setSubmitting(true);
        setError('');

        try {
            const firstDateObj = new Date(`${firstDate}T12:00:00`);
            const dayOfWeek = firstDateObj.getDay() === 0 ? 7 : firstDateObj.getDay();

            if (scheduleType === 'FIXO') {
                const res = await contractsApi.checkFixo({
                    tier: selectedTier,
                    durationMonths: duration as 3 | 6,
                    startDate: firstDate,
                    fixedDayOfWeek: dayOfWeek,
                    fixedTime: firstTime
                });

                if (!res.available) {
                    setConflicts(res.conflicts);
                    // Auto-resolve matches
                    const autoResolutions = res.conflicts
                        .filter(c => c.suggestedReplacement)
                        .map(c => ({
                            originalDate: c.date,
                            originalTime: c.originalTime,
                            newDate: c.suggestedReplacement!.date,
                            newTime: c.suggestedReplacement!.time
                        }));
                    setResolvedConflicts(autoResolutions);
                    setStep(7); // Conflict resolution modal
                    setSubmitting(false);
                    return;
                }
            }

            // Normal empty conflicts flow
            await executeCreation([]);
        } catch (err: unknown) {
            setError(getErrorMessage(err) || 'Erro ao validar agenda');
            setStep(4);
            setSubmitting(false);
        }
    };

    const progressSteps = step >= 5 && step !== 7 ? 4 : step;

    return (
        <ModalOverlay onClose={onClose}>
            <div className="modal" style={{ maxWidth: 720, width: '95%', maxHeight: '90vh', overflowY: 'auto' }}>
                {/* Header */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                    <h2 className="modal-title" style={{ margin: 0 }}>✨ Nova Contratação</h2>
                    <button className="btn btn-ghost btn-sm" onClick={onClose}>✕</button>
                </div>

                {/* Progress */}
                <div style={{ display: 'flex', gap: '8px', marginBottom: '28px' }}>
                    {[1, 2, 3, 4].map(s => (
                        <div key={s} style={{
                            flex: 1, height: 4, borderRadius: 2,
                            background: progressSteps >= s ? 'var(--accent-primary)' : 'var(--bg-elevated)',
                            transition: 'background 0.3s ease'
                        }} />
                    ))}
                </div>

                {/* ══════════ STEP 5: LOADING ══════════ */}
                {step === 5 && (
                    <div style={{ textAlign: 'center', padding: '48px 0' }}>
                        <div className="spinner" style={{ margin: '0 auto 20px', width: 40, height: 40 }} />
                        <h3 style={{ fontSize: '1.25rem', marginBottom: '8px' }}>Processando...</h3>
                        <p style={{ color: 'var(--text-muted)' }}>Gerando seus agendamentos. Aguarde um instante.</p>
                    </div>
                )}

                {/* ══════════ STEP 6: SUCCESS ══════════ */}
                {step === 6 && (
                    <div style={{ textAlign: 'center', padding: '48px 0' }}>
                        <div style={{ fontSize: '3.5rem', marginBottom: '16px' }}>🎉</div>
                        <h3 style={{ fontSize: '1.25rem', marginBottom: '8px' }}>
                            Contrato Criado com Sucesso!
                        </h3>
                        <p style={{ color: 'var(--text-muted)', marginBottom: '28px' }}>
                            {`Seu plano ${scheduleType === 'FIXO' ? 'Fixo' : 'Flex'} de ${duration} meses com ${totalGravacoes} gravações está ativo.`}
                        </p>
                        <button className="btn btn-primary" style={{ width: '100%' }} onClick={() => { onComplete(); onClose(); }}>
                            ✅ Ver Meus Contratos
                        </button>
                    </div>
                )}

                {/* ══════════ STEP 8: INLINE PAYMENT ══════════ */}
                {step === 8 && (
                    <div style={{ padding: '20px 0' }}>
                        <div style={{ textAlign: 'center', marginBottom: '24px' }}>
                            <div style={{ fontSize: '2.5rem', marginBottom: '8px' }}>💳</div>
                            <h3 style={{ fontSize: '1.25rem', marginBottom: '8px' }}>Pagamento da 1ª Parcela</h3>
                            <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>
                                Complete o pagamento para ativar seu contrato. As demais parcelas serão cobradas mensalmente.
                            </p>
                        </div>

                        {/* If CARTAO with clientSecret, show StripeCardForm directly */}
                        {paymentMethod === 'CARTAO' && cardClientSecret ? (
                            <>
                                <div style={{
                                    padding: '12px 16px', borderRadius: 'var(--radius-md)',
                                    background: 'rgba(34, 197, 94, 0.06)', border: '1px solid rgba(34, 197, 94, 0.2)',
                                    fontSize: '0.8125rem', color: '#22c55e', fontWeight: 600,
                                    textAlign: 'center', marginBottom: '24px'
                                }}>
                                    💰 Valor: {formatBRL(monthlyTotal)} (1ª parcela de {duration}x)
                                </div>
                                <StripeCardForm
                                    mode="payment"
                                    clientSecret={cardClientSecret}
                                    onSuccess={() => setStep(6)}
                                    onError={(msg) => { setError(msg); setStep(4); }}
                                    onCancel={() => setStep(6)}
                                    submitLabel={`Pagar ${formatBRL(monthlyTotal)}`}
                                />
                            </>
                        ) : (
                            /* PIX: use InlineCheckout */
                            <InlineCheckout
                                amount={monthlyTotal}
                                description={`1ª parcela - Contrato ${duration} meses`}
                                contractDuration={duration}
                                allowedMethods={paymentMethod === 'PIX' ? ['PIX'] : ['CARTAO', 'PIX']}
                                onSuccess={() => setStep(6)}
                                onError={(msg) => { setError(msg); setStep(4); }}
                                onCancel={() => setStep(6)}
                            />
                        )}

                        <button
                            className="btn btn-ghost btn-sm"
                            style={{ width: '100%', marginTop: '12px', fontSize: '0.75rem', color: 'var(--text-muted)' }}
                            onClick={() => setStep(6)}
                        >
                            Pagar depois na aba Pagamentos →
                        </button>
                    </div>
                )}

                {/* ══════════ STEP 1: PLAN SELECTION ══════════ */}
                {step === 1 && (
                    <div>
                        <h3 style={{ fontSize: '1.125rem', marginBottom: '16px' }}>1. Escolha seu Plano</h3>

                        <div className="form-group" style={{ marginBottom: '20px' }}>
                            <label className="form-label">Nome do Projeto (Obrigatório)</label>
                            <input
                                className="form-input"
                                type="text"
                                value={contractName}
                                onChange={e => setContractName(e.target.value)}
                                placeholder="Ex: Podcast de Tecnologia, Cliente VIP"
                            />
                        </div>

                        {/* Tier Tabs */}
                        <div style={{ display: 'flex', gap: '4px', marginBottom: '12px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)', padding: '4px' }}>
                            {pricing.map(p => {
                                const info = TIER_INFO[p.tier];
                                return (
                                    <button key={p.tier}
                                        onClick={() => setSelectedTier(p.tier)}
                                        style={{
                                            flex: 1, padding: '10px 8px', border: 'none', borderRadius: 'var(--radius-sm)',
                                            background: selectedTier === p.tier ? 'var(--accent-primary)' : 'transparent',
                                            color: selectedTier === p.tier ? '#fff' : 'var(--text-secondary)',
                                            fontWeight: selectedTier === p.tier ? 700 : 500,
                                            fontSize: '0.8125rem', cursor: 'pointer', transition: 'all 0.2s ease',
                                        }}>
                                        {info?.emoji} {p.label}
                                    </button>
                                );
                            })}
                        </div>

                        {/* Tier description */}
                        {tierConfig && TIER_INFO[selectedTier] && (
                            <div style={{
                                padding: '10px 14px', borderRadius: 'var(--radius-sm)',
                                background: 'var(--bg-card)', border: '1px solid var(--border-subtle)',
                                fontSize: '0.8125rem', color: 'var(--text-muted)', marginBottom: '20px',
                                display: 'flex', alignItems: 'center', gap: '8px'
                            }}>
                                <span style={{ fontWeight: 700, color: 'var(--text-secondary)' }}>🕐 {TIER_INFO[selectedTier].hours}</span>
                                <span>·</span>
                                <span>{TIER_INFO[selectedTier].desc}</span>
                            </div>
                        )}

                        {/* Price Cards */}
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '12px', marginBottom: '24px' }}>
                            {/* 3 Meses Card */}
                            <div
                                onClick={() => setSelectedPlan('3MESES')}
                                style={{
                                    padding: '20px 16px', borderRadius: 'var(--radius-md)', cursor: 'pointer',
                                    border: `2px solid ${selectedPlan === '3MESES' ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                                    background: selectedPlan === '3MESES' ? 'rgba(139, 92, 246, 0.08)' : 'var(--bg-card)',
                                    textAlign: 'center', transition: 'all 0.2s ease', position: 'relative',
                                    display: 'flex', flexDirection: 'column', justifyContent: 'space-between', minHeight: '200px',
                                }}>
                                <div style={{ position: 'absolute', top: -10, left: '50%', transform: 'translateX(-50%)', background: 'var(--tier-comercial)', color: '#fff', fontSize: '0.625rem', padding: '2px 10px', borderRadius: '10px', fontWeight: 700 }}>-30%</div>
                                <div>
                                    <div style={{ fontSize: '0.6875rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: '8px', fontWeight: 600 }}>Fidelidade 3 Meses</div>
                                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textDecoration: 'line-through' }}>{formatBRL(basePrice)}</div>
                                    <div style={{ fontSize: '1.5rem', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '4px' }}>{formatBRL(Math.round(basePrice * 0.7))}</div>
                                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>por sessão · 12 gravações</div>
                                </div>
                                <button className="btn btn-primary btn-sm" style={{ width: '100%', marginTop: '12px', opacity: selectedPlan === '3MESES' ? 1 : 0.7 }}>
                                    {selectedPlan === '3MESES' ? '✓ Selecionado' : 'Selecionar'}
                                </button>
                            </div>

                            {/* 6 Meses Card */}
                            <div
                                onClick={() => setSelectedPlan('6MESES')}
                                style={{
                                    padding: '20px 16px', borderRadius: 'var(--radius-md)', cursor: 'pointer',
                                    border: `2px solid ${selectedPlan === '6MESES' ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                                    background: selectedPlan === '6MESES' ? 'rgba(139, 92, 246, 0.08)' : 'var(--bg-card)',
                                    textAlign: 'center', transition: 'all 0.2s ease', position: 'relative',
                                    display: 'flex', flexDirection: 'column', justifyContent: 'space-between', minHeight: '200px',
                                }}>
                                <div style={{ position: 'absolute', top: -10, left: '50%', transform: 'translateX(-50%)', background: 'var(--accent-primary)', color: '#fff', fontSize: '0.625rem', padding: '2px 10px', borderRadius: '10px', fontWeight: 700 }}>MELHOR PREÇO -40%</div>
                                <div>
                                    <div style={{ fontSize: '0.6875rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: '8px', fontWeight: 600 }}>Fidelidade 6 Meses</div>
                                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textDecoration: 'line-through' }}>{formatBRL(basePrice)}</div>
                                    <div style={{ fontSize: '1.5rem', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '4px' }}>{formatBRL(Math.round(basePrice * 0.6))}</div>
                                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>por sessão · 24 gravações</div>
                                </div>
                                <button className="btn btn-primary btn-sm" style={{ width: '100%', marginTop: '12px', opacity: selectedPlan === '6MESES' ? 1 : 0.7 }}>
                                    {selectedPlan === '6MESES' ? '✓ Selecionado' : 'Selecionar'}
                                </button>
                            </div>
                        </div>

                        {/* Custom Plan Shortcut */}
                        {onOpenCustom && (
                            <div onClick={() => { onClose(); onOpenCustom(); }}
                                style={{
                                    display: 'flex', alignItems: 'center', gap: '14px',
                                    padding: '14px 16px', borderRadius: 'var(--radius-md)', cursor: 'pointer',
                                    background: 'linear-gradient(135deg, rgba(139, 92, 246, 0.06) 0%, rgba(34, 197, 94, 0.06) 100%)',
                                    border: '1px dashed rgba(139, 92, 246, 0.35)',
                                    marginBottom: '20px', transition: 'all 0.2s ease',
                                }}
                                onMouseOver={e => { e.currentTarget.style.borderColor = 'var(--accent-primary)'; e.currentTarget.style.background = 'linear-gradient(135deg, rgba(139, 92, 246, 0.12) 0%, rgba(34, 197, 94, 0.1) 100%)'; }}
                                onMouseOut={e => { e.currentTarget.style.borderColor = 'rgba(139, 92, 246, 0.35)'; e.currentTarget.style.background = 'linear-gradient(135deg, rgba(139, 92, 246, 0.06) 0%, rgba(34, 197, 94, 0.06) 100%)'; }}>
                                <div style={{ fontSize: '1.5rem', lineHeight: 1 }}>🎨</div>
                                <div style={{ flex: 1 }}>
                                    <div style={{ fontWeight: 700, fontSize: '0.8125rem', color: 'var(--accent-primary)', marginBottom: '2px' }}>
                                        Precisa de mais flexibilidade?
                                    </div>
                                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                        Monte um plano personalizado com múltiplos dias, serviços sob demanda e descontos progressivos.
                                    </div>
                                </div>
                                <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--accent-primary)', whiteSpace: 'nowrap' }}>Configurar ➔</div>
                            </div>
                        )}

                        <div className="modal-actions">
                            <button className="btn btn-primary" style={{ width: '100%' }}
                                onClick={() => { setFirstDate(''); setFirstTime(''); setStep(2); }}
                                disabled={!selectedPlan || !contractName.trim()}>
                                Continuar ➔
                            </button>
                        </div>
                    </div>
                )}

                {/* ══════════ STEP 2: AGENDA CONFIG ══════════ */}
                {step === 2 && (
                    <div>
                        <h3 style={{ fontSize: '1.125rem', marginBottom: '16px' }}>2. Configure sua Agenda</h3>

                        {/* Fixo / Flex toggle */}
                        <div style={{ marginBottom: '20px' }}>
                            <label className="form-label" style={{ marginBottom: '8px' }}>Modelo de Agenda</label>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                                <div onClick={() => setScheduleType('FIXO')}
                                    style={{
                                        padding: '14px', borderRadius: 'var(--radius-md)', cursor: 'pointer',
                                        border: `2px solid ${scheduleType === 'FIXO' ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                                        background: scheduleType === 'FIXO' ? 'rgba(139, 92, 246, 0.08)' : 'var(--bg-card)',
                                    }}>
                                    <div style={{ fontWeight: 700, marginBottom: '4px', fontSize: '0.9375rem' }}>📌 Agenda Fixa</div>
                                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Mesmo dia e horário toda semana. O sistema reserva automaticamente.</div>
                                </div>
                                <div onClick={() => setScheduleType('FLEX')}
                                    style={{
                                        padding: '14px', borderRadius: 'var(--radius-md)', cursor: 'pointer',
                                        border: `2px solid ${scheduleType === 'FLEX' ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                                        background: scheduleType === 'FLEX' ? 'rgba(139, 92, 246, 0.08)' : 'var(--bg-card)',
                                    }}>
                                    <div style={{ fontWeight: 700, marginBottom: '4px', fontSize: '0.9375rem' }}>🔄 Agenda Flex</div>
                                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Agende semana a semana com total liberdade de horários.</div>
                                </div>
                            </div>
                        </div>

                        {/* Calendar section (always visible) */}
                        {scheduleType && (
                            <>
                                {/* Vigência notice */}
                                <div style={{
                                    padding: '10px 14px', borderRadius: 'var(--radius-sm)', marginBottom: '16px',
                                    background: 'rgba(234, 179, 8, 0.1)', border: '1px solid rgba(234, 179, 8, 0.2)',
                                    fontSize: '0.8125rem', color: '#ca8a04', fontWeight: 600,
                                }}>
                                    ⚠️ Atenção: O seu contrato começará a valer a partir da data desta primeira gravação.
                                </div>

                                {/* Date picker */}
                                <div className="form-group" style={{ marginBottom: '16px' }}>
                                    <label className="form-label">Data do 1º Episódio</label>
                                    <select className="form-input" value={firstDate} onChange={e => { setFirstDate(e.target.value); setFirstTime(''); }}>
                                        <option value="">-- Selecione (próx. 14 dias) --</option>
                                        {allowedDates.map(d => {
                                            const y = d.getFullYear();
                                            const m = String(d.getMonth() + 1).padStart(2, '0');
                                            const day = String(d.getDate()).padStart(2, '0');
                                            const dateStr = `${y}-${m}-${day}`;
                                            return (
                                                <option key={dateStr} value={dateStr}>
                                                    {DAY_NAMES_FULL[d.getDay()]}, {day}/{m}/{y}
                                                </option>
                                            );
                                        })}
                                    </select>
                                </div>

                                {/* Time slots */}
                                {firstDate && (
                                    <div className="form-group" style={{ marginBottom: '16px' }}>
                                        <label className="form-label">Horário (Pacote 2h)</label>
                                        {loadingSlots ? (
                                            <div style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', padding: '12px 0' }}>⏳ Carregando horários disponíveis...</div>
                                        ) : (
                                            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                                                {availableSlots.map(s => {
                                                    const isTierAllowed = selectedTier === 'COMERCIAL' ? s.time <= '15:30' : true;

                                                    // Time check filter
                                                    const slotDateTime = new Date(`${firstDate}T${s.time}:00`);
                                                    const isPast = (slotDateTime.getTime() - Date.now()) / (1000 * 60) < 30;

                                                    const isSelectable = s.available && isTierAllowed && !isPast;
                                                    const [h] = s.time.split(':').map(Number);
                                                    const endTime = `${h + 2}:${s.time.split(':')[1]}`;

                                                    return (
                                                        <div key={s.time}
                                                            onClick={() => isSelectable && setFirstTime(s.time)}
                                                            style={{
                                                                padding: '16px', borderRadius: 'var(--radius-md)',
                                                                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                                                                cursor: isSelectable ? 'pointer' : 'not-allowed',
                                                                border: `2px solid ${firstTime === s.time ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                                                                background: firstTime === s.time ? 'rgba(139, 92, 246, 0.08)' : (isSelectable ? 'var(--bg-card)' : 'var(--bg-secondary)'),
                                                                opacity: isSelectable ? 1 : isPast ? 0.4 : 0.6,
                                                                transition: 'all 0.2s',
                                                            }}>
                                                            <div style={{ display: 'flex', flexDirection: 'column' }}>
                                                                <span style={{ fontWeight: 800, fontSize: '1rem', color: firstTime === s.time ? 'var(--accent-primary)' : 'var(--text-primary)' }}>
                                                                    {s.time} - {endTime}
                                                                </span>
                                                                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                                                    {s.tier === 'COMERCIAL' ? '🏢 Comercial' : (s.tier === 'AUDIENCIA' ? '🎤 Audiência' : '🌟 Sábado')}
                                                                </span>
                                                            </div>
                                                            <div>
                                                                {!isTierAllowed ? (
                                                                    <span style={{ fontSize: '0.875rem' }} title={`Exclusivo para planos ${s.tier}`}>🔒</span>
                                                                ) : !s.available ? (
                                                                    <span style={{ fontSize: '0.8125rem', color: 'var(--status-blocked)', fontWeight: 600 }}>Ocupado</span>
                                                                ) : firstTime === s.time ? (
                                                                    <span style={{ color: 'var(--accent-primary)', fontWeight: 800 }}>✓</span>
                                                                ) : null}
                                                            </div>
                                                        </div>
                                                    );
                                                })}
                                                {availableSlots.length === 0 && (
                                                    <div style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', padding: '8px 0' }}>
                                                        Nenhum horário disponível para esta data.
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </>
                        )}

                        <div className="modal-actions" style={{ justifyContent: 'space-between', marginTop: '24px' }}>
                            <button className="btn btn-secondary" onClick={() => setStep(1)}>⬅ Voltar</button>
                            <button className="btn btn-primary" onClick={() => { setStep(3); }}
                                disabled={!firstDate || !firstTime || !scheduleType}>
                                Continuar ➔
                            </button>
                        </div>
                    </div>
                )}

                {/* ══════════ STEP 3: ADICIONAIS OPCIONAIS ══════════ */}
                {step === 3 && tierConfig && (
                    <div>
                        <h3 style={{ fontSize: '1.125rem', marginBottom: '16px' }}>3. Serviços Adicionais (Opcionais)</h3>
                        <p style={{ fontSize: '0.875rem', color: 'var(--text-muted)', marginBottom: '24px' }}>
                            Potencialize a entrega do seu projeto. Seu plano te garante <strong>{discountPct}% de desconto</strong> nos extras selecionados abaixo. Contratação 100% opcional.
                        </p>

                        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '32px' }}>
                            {addons.filter(a => a.key !== 'GESTAO_SOCIAL').map(addon => {
                                const isSelected = selectedAddons.includes(addon.key);
                                const monthlyAddonBase = addon.price * 4;
                                const discountedAddonPrice = Math.round(monthlyAddonBase * (1 - discountPct / 100));
                                
                                return (
                                    <div key={addon.key} 
                                        onClick={() => {
                                            if (isSelected) setSelectedAddons(prev => prev.filter(k => k !== addon.key));
                                            else setSelectedAddons(prev => [...prev, addon.key]);
                                        }}
                                        style={{
                                            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                                            padding: '16px', borderRadius: 'var(--radius-md)', cursor: 'pointer',
                                            background: isSelected ? 'rgba(139, 92, 246, 0.08)' : 'var(--bg-secondary)',
                                            border: `2px solid ${isSelected ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                                            transition: 'all 0.2s ease',
                                    }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                                            <input type="checkbox" checked={isSelected} readOnly style={{ width: 22, height: 22, accentColor: 'var(--accent-primary)', pointerEvents: 'none' }} />
                                            <div>
                                                <div style={{ fontWeight: 800, fontSize: '1rem', color: isSelected ? 'var(--accent-primary)' : 'var(--text-primary)' }}>{addon.name}</div>
                                                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{addon.description || 'Impulsione seus resultados mensalmente.'}</div>
                                            </div>
                                        </div>
                                        <div style={{ textAlign: 'right', minWidth: '120px' }}>
                                            <div style={{ fontWeight: 800, fontSize: '1.125rem', color: isSelected ? 'var(--accent-primary)' : 'var(--text-primary)' }}>
                                                + {formatBRL(discountedAddonPrice)} <span style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-muted)' }}>/mês</span>
                                            </div>
                                            {discountPct > 0 && <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textDecoration: 'line-through' }}>{formatBRL(monthlyAddonBase)} /mês</div>}
                                            {discountPct > 0 && <div style={{ fontSize: '0.6875rem', background: 'var(--tier-comercial)', color: '#fff', display: 'inline-block', padding: '2px 6px', borderRadius: '4px', fontWeight: 700, marginTop: '4px' }}>-{discountPct}% OFF</div>}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>

                        <div className="modal-actions" style={{ justifyContent: 'space-between' }}>
                            <button className="btn btn-secondary" onClick={() => setStep(2)}>⬅ Voltar</button>
                            <button className="btn btn-primary" onClick={() => setStep(4)}>
                                {selectedAddons.length > 0 ? 'Continuar ➔' : 'Pular Serviços Extras ➔'}
                            </button>
                        </div>
                    </div>
                )}

                {/* ══════════ STEP 4: SUMMARY & CHECKOUT ══════════ */}
                {step === 4 && tierConfig && (
                    <div>
                        <h3 style={{ fontSize: '1.125rem', marginBottom: '16px' }}>4. Resumo e Checkout</h3>

                        {error && (
                            <div style={{ padding: '12px 16px', borderRadius: 'var(--radius-md)', background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.3)', color: '#ef4444', fontSize: '0.875rem', marginBottom: '16px' }}>
                                ❌ {error}
                            </div>
                        )}

                        {/* Order summary */}
                        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', padding: '20px', marginBottom: '20px' }}>
                            <div style={{ fontWeight: 700, fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: '14px' }}>Carrinho de Compras</div>

                            {/* Plan Base */}
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '10px' }}>
                                <div>
                                    <div style={{ fontWeight: 700, fontSize: '0.875rem' }}>Pacote Estúdio ({duration} Meses)</div>
                                    <div style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>{totalGravacoes} sessões de {tierConfig.label} ({scheduleType === 'FIXO' ? 'Fixo' : 'Flex'})</div>
                                </div>
                                <div style={{ textAlign: 'right' }}>
                                    <span style={{ fontWeight: 700, fontSize: '0.875rem' }}>{formatBRL(discountedPrice * 4)}/mês</span>
                                    {discountPct > 0 && <div style={{ fontSize: '0.6875rem', color: 'var(--tier-comercial)', fontWeight: 600 }}>-{discountPct}% aplicado</div>}
                                </div>
                            </div>

                            {/* Addons List */}
                            {selectedAddons.length > 0 && (
                                <div style={{ borderTop: '1px dashed var(--border-subtle)', paddingTop: '10px', marginTop: '4px', marginBottom: '10px' }}>
                                    <div style={{ color: 'var(--text-muted)', fontSize: '0.75rem', marginBottom: '6px', fontWeight: 600 }}>Serviços Adicionais Escolhidos:</div>
                                    {selectedAddons.map(key => {
                                        const addon = addons.find(a => a.key === key);
                                        if(!addon) return null;
                                        const discountedMonthly = Math.round((addon.price * sessionsPerMonth) * (1 - discountPct / 100));
                                        return (
                                            <div key={key} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px', paddingLeft: '8px' }}>
                                                <span style={{ color: 'var(--text-primary)', fontSize: '0.8125rem' }}>• {addon.name}</span>
                                                <span style={{ fontWeight: 600, fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>+ {formatBRL(discountedMonthly)}/mês</span>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}

                            {/* Subtotal */}
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px', marginTop: '14px', borderTop: '1px solid var(--border-subtle)', paddingTop: '14px' }}>
                                <span style={{ color: 'var(--text-primary)', fontSize: '0.875rem', fontWeight: 700 }}>Subtotal (Mensal)</span>
                                <span style={{ fontWeight: 800, fontSize: '1rem', color: 'var(--text-primary)' }}>
                                    {formatBRL(monthlyTotal)}
                                </span>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>Valor do Contrato Completo ({duration}x)</span>
                                <span style={{ fontWeight: 600, fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                    {formatBRL(monthlyTotal * duration)}
                                </span>
                            </div>
                        </div>

                        {/* Payment Options */}
                        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', padding: '20px', marginBottom: '20px' }}>
                            <div style={{ fontWeight: 700, fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: '14px' }}>Opções de Pagamento (Formato Final)</div>

                            {/* Payment Method Cards */}
                            {getClientPaymentMethods().map(pm => {
                                const isSelected = paymentMethod === pm.key;
                                let displayPrice = '';
                                let subPrice = '';
                                let badge: React.ReactNode = null;
                                let desc = '';

                                if (pm.key === 'PIX') {
                                    displayPrice = formatBRL(Math.round(monthlyTotal * duration * 0.9));
                                    subPrice = formatBRL(monthlyTotal * duration);
                                    badge = <span style={{ background: '#22c55e', color: '#fff', fontSize: '0.5625rem', padding: '2px 6px', borderRadius: '6px', marginLeft: '6px', fontWeight: 700 }}>-10%</span>;
                                    desc = 'Desconto aplicado no valor do contrato completo';
                                } else if (pm.key === 'CARTAO') {
                                    displayPrice = `${duration}x ${formatBRL(Math.round(monthlyTotal * 1.15))}`;
                                    subPrice = `Total: ${formatBRL(Math.round(monthlyTotal * duration * 1.15))}`;
                                    badge = <span style={{ background: 'var(--bg-elevated)', color: 'var(--text-muted)', fontSize: '0.5625rem', padding: '2px 6px', borderRadius: '6px', marginLeft: '6px', fontWeight: 700 }}>+15% TAXA</span>;
                                    desc = 'Valor total com acréscimo da operadora';
                                } else {
                                    displayPrice = `${duration}x ${formatBRL(monthlyTotal)}`;
                                    subPrice = `Total: ${formatBRL(monthlyTotal * duration)}`;
                                    desc = 'Sem juros mensais. 1º vencimento no envio do contrato';
                                }

                                return (
                                    <div key={pm.key} onClick={() => setPaymentMethod(pm.key as 'CARTAO' | 'PIX')}
                                        style={{
                                            padding: '12px 14px', borderRadius: 'var(--radius-sm)', marginBottom: '10px', cursor: 'pointer',
                                            background: isSelected ? pm.bgActive : pm.bgInactive,
                                            border: `2px solid ${isSelected ? pm.borderActive : pm.borderInactive}`,
                                            transition: 'all 0.2s ease',
                                        }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                            <div>
                                                <div style={{ fontWeight: 700, fontSize: '0.875rem' }}>{pm.emoji} {pm.accessMode === 'FULL' && pm.key === 'PIX' ? `${pm.label} à vista` : pm.accessMode === 'FULL' ? `${pm.shortLabel} em ${duration}x` : `${pm.label} Mensal`} {badge}</div>
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

                        {/* Terms */}
                        <div style={{ padding: '16px', borderRadius: 'var(--radius-md)', background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)', marginBottom: '20px' }}>
                            <div style={{ fontWeight: 700, fontSize: '0.8125rem', marginBottom: '10px', color: 'var(--text-secondary)' }}>📋 Termos e Regras</div>
                            <ul style={{ fontSize: '0.75rem', color: 'var(--text-muted)', paddingLeft: '18px', margin: '0 0 12px 0', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                <li>A vigência dos {duration} meses inicia em <strong>{firstDate.split('-').reverse().join('/')}</strong>.</li>
                                <li>Cancelamento com menos de <strong>{selectedTier === 'SABADO' ? '48' : '24'} horas</strong> de antecedência implica na perda do crédito.</li>
                                <li>Remarcação permitida com até <strong>7 dias</strong> de antecedência.</li>
                                <li>Créditos não utilizados dentro da vigência do contrato expiram ao final do período.</li>
                                {scheduleType === 'FIXO' && <li>Horários fixos serão reservados automaticamente para toda a duração do contrato.</li>}
                            </ul>
                            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '0.8125rem', fontWeight: 600 }}>
                                <input type="checkbox" checked={acceptedTerms} onChange={e => setAcceptedTerms(e.target.checked)}
                                    style={{ width: 18, height: 18, accentColor: 'var(--accent-primary)' }} />
                                Li e aceito as regras acima
                            </label>
                        </div>

                        <div className="modal-actions" style={{ justifyContent: 'space-between' }}>
                            <button className="btn btn-secondary" onClick={() => setStep(3)}>⬅ Voltar</button>
                            <button className="btn btn-primary" onClick={handleSubmit} disabled={!acceptedTerms || submitting || !paymentMethod}>
                                {submitting ? '⏳ Processando...' : '🔒 Ir para Pagamento'}
                            </button>
                        </div>
                    </div>
                )}

                {/* ══════════ STEP 7: CONFLICT RESOLUTION ══════════ */}
                {step === 7 && (
                    <div>
                        <div style={{ textAlign: 'center', marginBottom: '20px' }}>
                            <div style={{ fontSize: '2.5rem', marginBottom: '8px' }}>⚠️</div>
                            <h3 style={{ fontSize: '1.25rem', color: '#ef4444' }}>Conflitos de Agenda Encontrados</h3>
                            <p style={{ color: 'var(--text-muted)' }}>Alguns dias do seu contrato Fixo já possuem outras gravações marcadas.</p>
                        </div>

                        <div style={{ background: 'var(--bg-secondary)', padding: '16px', borderRadius: 'var(--radius-md)', marginBottom: '24px' }}>
                            <div style={{ fontWeight: 700, marginBottom: '12px', fontSize: '0.875rem' }}>Datas em conflito:</div>
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
                                                <span style={{ fontSize: '0.75rem', color: '#ef4444', fontWeight: 600, background: 'rgba(239, 68, 68, 0.1)', padding: '2px 8px', borderRadius: '10px' }}>Ocupado</span>
                                            </div>

                                            {c.suggestedReplacement ? (
                                                <div style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                                                    <span>💡 Nossa sugestão:</span>
                                                    <span style={{ background: 'rgba(34, 197, 94, 0.1)', color: '#22c55e', padding: '4px 8px', borderRadius: '4px', fontWeight: 600 }}>
                                                        {c.suggestedReplacement.time} no mesmo dia
                                                    </span>
                                                </div>
                                            ) : (
                                                <div style={{ fontSize: '0.8125rem', color: '#f59e0b', display: 'flex', alignItems: 'center', gap: '8px' }}>
                                                    <span>⚠️ Este dia está completamente lotado para o seu pacote. Esta gravação pulará uma semana e será adicionada ao final do seu contrato.</span>
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>

                        <div className="modal-actions" style={{ flexDirection: 'column', gap: '12px' }}>
                            <button className="btn btn-primary" style={{ width: '100%', padding: '14px' }}
                                onClick={() => executeCreation(resolvedConflicts)}>
                                ✅ Aceitar Sugestões e Concluir
                            </button>
                            <button className="btn btn-secondary" style={{ width: '100%', padding: '14px' }}
                                onClick={() => setStep(2)}>
                                ⬅ Voltar e escolher outro Plano/Horário
                            </button>
                        </div>
                    </div>
                )}

            </div>
        </ModalOverlay>
    );
}

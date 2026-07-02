import { getErrorMessage } from '../utils/errors';
import React, { useState, useEffect, useRef } from 'react';
import BottomSheetModal from './BottomSheetModal';
import { PricingConfig, AddOnConfig, bookingsApi, contractsApi, Slot, pricingApi, stripeApi, authApi, ApiError, type CouponValidation } from '../api/client';
import CouponField from './CouponField';
import { useBusinessConfig } from '../hooks/useBusinessConfig';
import { getClientPaymentMethods, type PaymentMethodKey } from '../constants/paymentMethods';
import InlineCheckout from './InlineCheckout';
import StripeCardForm from './StripeCardForm';
import CpfCnpjPrompt from './CpfCnpjPrompt';
import { useAuth } from '../context/AuthContext';
import { isValidCpfCnpj } from '../utils/mask';
import { formatBRL } from '../utils/format';
import { X, Pin, Shuffle, CalendarDays, Clock, Lock, CheckCircle2, XCircle, AlertTriangle, ChevronLeft, ChevronRight, Sparkles, Film, TrendingUp, FileText, Receipt, Mic, Tag, CreditCard, ScrollText, ShieldCheck } from 'lucide-react';

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
const DAY_NAMES_SHORT = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const MONTH_NAMES_SHORT = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

export default function ContractWizard({ pricing, onClose, onComplete, onOpenCustom }: ContractWizardProps) {
    const { user, updateUser } = useAuth();
    const [step, setStep] = useState<WizardStep>(1);
    // PIX needs a CPF/CNPJ — gate the contract creation when it's missing.
    const [showCpfPrompt, setShowCpfPrompt] = useState(false);
    const pendingResolutions = useRef<any[]>([]);

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
    // Payment plan: MONTHLY (1 now + rest monthly, current behavior) or FULL (whole contract upfront).
    const [paymentPlan, setPaymentPlan] = useState<'MONTHLY' | 'FULL'>('MONTHLY');
    const [addons, setAddons] = useState<AddOnConfig[]>([]);
    const [selectedAddons, setSelectedAddons] = useState<string[]>([]);
    // Cupom de desconto aplicado no step 4 (preview; o valor autoritativo vem do backend).
    const [appliedCoupon, setAppliedCoupon] = useState<CouponValidation | null>(null);

    useEffect(() => {
        pricingApi.getAddons().then(res => setAddons(res.addons)).catch(console.error);
    }, []);

    // Submission
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState('');

    // Inline payment (card + PIX)
    const [cardClientSecret, setCardClientSecret] = useState<string | null>(null);
    const [firstPaymentId, setFirstPaymentId] = useState<string | null>(null);
    const [firstPixString, setFirstPixString] = useState<string | null>(null);
    // Real amount of the first charge, returned by the backend. For FULL this is the
    // whole contract (with PIX-at-once discount); for MONTHLY it's the 1st installment.
    // Use this in the checkout so what is shown == what is charged.
    const [checkoutAmount, setCheckoutAmount] = useState<number | null>(null);

    // Cancel confirmation modal
    const [showCancelModal, setShowCancelModal] = useState(false);

    // Conflicts
    const [conflicts, setConflicts] = useState<{ date: string, originalTime: string, suggestedReplacement?: { date: string, time: string }, alternatives?: { date: string, time: string }[] }[]>([]);
    const [resolvedConflicts, setResolvedConflicts] = useState<{ originalDate: string, originalTime: string, newDate: string, newTime: string }[]>([]);

    // Per-conflict substitution: which alternative slot the client picked for a given conflict.
    const getResolution = (originalDate: string, originalTime: string) =>
        resolvedConflicts.find(r => r.originalDate === originalDate && r.originalTime === originalTime);
    const selectAlternative = (originalDate: string, originalTime: string, alt: { date: string, time: string }) => {
        setResolvedConflicts(prev => {
            const others = prev.filter(r => !(r.originalDate === originalDate && r.originalTime === originalTime));
            return [...others, { originalDate, originalTime, newDate: alt.date, newTime: alt.time }];
        });
    };
    // Count conflicts still unresolved (no free alternative on that day).
    const unresolvedConflicts = conflicts.filter(c =>
        !getResolution(c.date, c.originalTime) && !(c.alternatives && c.alternatives.length > 0)
    ).length;

    // Business rules from admin config
    const { get: getRule, getJson } = useBusinessConfig();

    // Derived
    const tierConfig = pricing.find(p => p.tier === selectedTier);
    const basePrice = tierConfig?.price || 0;
    const duration = selectedPlan === '6MESES' ? 6 : 3;
    const discountPct = selectedPlan === '6MESES' ? getRule('discount_6months') : getRule('discount_3months');
    const sessionsPerMonth = getRule('sessions_per_month');
    const discountedPrice = Math.round(basePrice * (1 - discountPct / 100));
    const totalGravacoes = duration * sessionsPerMonth;

    // Per-episode services accompany every recording → × sessions/month; monthly
    // services (e.g. GESTAO_SOCIAL) stay flat. Mirrors backend computeAddonsCost.
    const baseAddonsTotal = selectedAddons.reduce((acc, key) => {
        const addon = addons.find(a => a.key === key);
        if (!addon) return acc;
        return acc + (addon.monthly ? addon.price : addon.price * sessionsPerMonth);
    }, 0);
    const discountedAddonsTotal = Math.round(baseAddonsTotal * (1 - discountPct / 100));
    const monthlyTotal = (sessionsPerMonth * discountedPrice) + discountedAddonsTotal;

    // ── Display-only totals for the payment-plan selector ──
    // These mirror the backend so the user sees consistent numbers; the actual
    // charged value comes from the createSelf response (checkoutAmount).
    const pixExtraDiscountPct = getRule('pix_extra_discount_pct');
    const contractFullTotal = monthlyTotal * duration; // FULL on card (no extra discount)
    const pixFullTotal = Math.round(contractFullTotal * (1 - pixExtraDiscountPct / 100)); // FULL on PIX (à vista)

    // Total corrente do plano/método escolhido — base do cupom (1ª cobrança).
    const couponBaseAmount = paymentPlan === 'FULL'
        ? (paymentMethod === 'PIX' ? pixFullTotal : contractFullTotal)
        : monthlyTotal;

    // Generate 14 days ahead
    const now = new Date();
    const allowedDates = Array.from({ length: 14 }, (_, i) => {
        const d = new Date(now);
        d.setDate(d.getDate() + i + 1);
        return d;
    }).filter(d => {
        if (d.getDay() === 0) return false;
        if (selectedTier === 'SABADO') return d.getDay() === 6;
        return d.getDay() >= 1 && d.getDay() <= 5; // COMERCIAL + AUDIENCIA = Seg-Sex
    });

    useEffect(() => {
        if (step === 2 && firstDate && tierConfig) {
            setLoadingSlots(true);
            bookingsApi.getAvailability(firstDate)
                .then(res => { setAvailableSlots(res.slots); })
                .catch(err => console.error(err))
                .finally(() => setLoadingSlots(false));
        }
    }, [step, firstDate, tierConfig]);

    const executeCreation = async (resolutions: any[] = [], cpfChecked = false) => {
        // PIX is emitted as a Cora invoice in the user's name → requires a CPF/CNPJ.
        if (!cpfChecked && paymentMethod === 'PIX' && !isValidCpfCnpj(user?.cpfCnpj)) {
            // Belt-and-braces: o contexto pode estar com um user parcial (ex.: sessão
            // antiga) — confere no servidor antes de pedir o CPF de novo.
            try {
                const { user: fresh } = await authApi.me();
                updateUser(fresh);
                if (isValidCpfCnpj(fresh?.cpfCnpj)) {
                    // CPF já está salvo no perfil — segue sem perguntar.
                    return executeCreation(resolutions, true);
                }
            } catch { /* offline/expirado — cai no prompt normalmente */ }
            pendingResolutions.current = resolutions;
            setShowCpfPrompt(true);
            return;
        }
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
                paymentPlan,
                addOns: selectedAddons,
                resolvedConflicts: resolutions.length > 0 ? resolutions : undefined,
                couponCode: appliedCoupon?.code,
                ...(scheduleType === 'FIXO' ? { fixedDayOfWeek: dayOfWeek, fixedTime: firstTime } : {}),
            });

            // Cupom de 100% — o backend já quitou a 1ª cobrança; pula o checkout.
            if (res.alreadyPaid) {
                setStep(6);
                return;
            }

            if (res.firstPaymentId) setFirstPaymentId(res.firstPaymentId);
            if (res.firstPixString) setFirstPixString(res.firstPixString);
            // Backend-authoritative amount of the first charge → drives the checkout.
            if (typeof res.amount === 'number') setCheckoutAmount(res.amount);

            // CARTÃO has no clientSecret from /self by design — the inline checkout creates the
            // PaymentIntent with the chosen installments. PIX returns its QR up-front. Either
            // way, advance to the checkout step (otherwise the flow hangs on "Gerando pagamento").
            if (res.clientSecret && paymentMethod === 'CARTAO') {
                setCardClientSecret(res.clientSecret);
            }
            setStep(8);
        } catch (err: unknown) {
            setError(getErrorMessage(err) || 'Erro ao processar criação do contrato');
            // Erro de negócio (< 500, ex.: cupom inválido/expirado) volta ao resumo
            // com a mensagem; demais erros mantêm o comportamento anterior.
            if (err instanceof ApiError && err.status < 500) setStep(4);
            else setStep(conflicts.length > 0 ? 7 : 4);
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
                    const autoResolutions = res.conflicts
                        .filter(c => c.suggestedReplacement)
                        .map(c => ({
                            originalDate: c.date,
                            originalTime: c.originalTime,
                            newDate: c.suggestedReplacement!.date,
                            newTime: c.suggestedReplacement!.time
                        }));
                    setResolvedConflicts(autoResolutions);
                    setStep(7);
                    setSubmitting(false);
                    return;
                }
            }

            await executeCreation([]);
        } catch (err: unknown) {
            setError(getErrorMessage(err) || 'Erro ao validar agenda');
            setStep(4);
            setSubmitting(false);
        }
    };

    const progressSteps = step >= 5 && step !== 7 ? 4 : step;

    return (
        <BottomSheetModal isOpen={true} onClose={onClose} title="✨ Nova Contratação" preventClose={submitting} maxWidth="540px">
            <div className="wizard-modal-inner">
                {showCpfPrompt && (
                    <div className="wizard-cancel-overlay" onClick={() => setShowCpfPrompt(false)}>
                        <div className="wizard-cancel-modal" onClick={e => e.stopPropagation()}>
                            <CpfCnpjPrompt
                                saveLabel="Salvar e continuar"
                                onSaved={() => { setShowCpfPrompt(false); executeCreation(pendingResolutions.current, true); }}
                                onCancel={() => setShowCpfPrompt(false)}
                            />
                        </div>
                    </div>
                )}
                {/* Progress */}
                <div className="wizard-progress">
                    {[1, 2, 3, 4].map(s => (
                        <div key={s} className={`wizard-progress__step ${progressSteps >= s ? 'wizard-progress__step--active' : ''}`} />
                    ))}
                </div>

                {/* ══════════ STEP 5: LOADING ══════════ */}
                {step === 5 && (
                    <div className="wizard-state-screen">
                        <div className="spinner" style={{ margin: '0 auto 20px', width: 40, height: 40 }} />
                        <h3 className="wizard-state-screen__title">Gerando pagamento...</h3>
                        <p className="wizard-state-screen__desc">Preparando a 1ª parcela. Aguarde um instante.</p>
                    </div>
                )}

                {/* ══════════ STEP 6: SUCCESS ══════════ */}
                {step === 6 && (
                    <div className="wizard-success">
                        <div className="wizard-success__confetti">
                            <div className="wizard-success__icon-wrap">
                                <CheckCircle2 size={48} />
                            </div>
                        </div>
                        <h3 className="wizard-success__title">Parabéns! Contrato Ativado</h3>
                        <p className="wizard-success__desc">
                            Seu plano <strong>{scheduleType === 'FIXO' ? 'Fixo' : 'Flex'}</strong> de <strong>{duration} meses</strong> foi confirmado com sucesso.
                        </p>
                        <div className="wizard-success__details">
                            <div className="wizard-success__detail-row">
                                <CalendarDays size={14} />
                                <span>{totalGravacoes} sessões de gravação agendadas</span>
                            </div>
                            <div className="wizard-success__detail-row">
                                <Clock size={14} />
                                <span>Vigência a partir de {firstDate.split('-').reverse().join('/')}</span>
                            </div>
                        </div>
                        <p className="wizard-success__next">
                            Você pode acompanhar seus agendamentos e pagamentos na sua área do cliente.
                        </p>
                        <button className="wizard-cta-pay" style={{ width: '100%' }} onClick={() => { onComplete(); onClose(); }}>
                            <CalendarDays size={18} /> Ver Minha Agenda
                        </button>
                    </div>
                )}

                {/* ══════════ STEP 8: INLINE PAYMENT ══════════ */}
                {step === 8 && (
                    <div className="wizard-payment-step">
                        <div className="wizard-payment-step__header">
                            <div className="wizard-payment-step__icon-v2">
                                <ShieldCheck size={28} />
                            </div>
                            <h3 className="wizard-payment-step__title">
                                {paymentPlan === 'FULL' ? 'Pagamento Integral' : 'Pagamento da 1ª Parcela'}
                            </h3>
                            <p className="wizard-payment-step__desc">
                                {paymentPlan === 'FULL'
                                    ? 'Complete o pagamento integral para ativar seu contrato.'
                                    : 'Complete o pagamento para ativar seu contrato. As demais parcelas serão cobradas mensalmente.'}
                            </p>
                        </div>

                        {/* Warning: payment required */}
                        <div className="wizard-info-banner wizard-info-banner--warning">
                            <AlertTriangle size={14} />
                            <span>O contrato só será criado após a confirmação do pagamento. Sem pagamento, nenhum agendamento será reservado.</span>
                        </div>

                        {/* Unified checkout: card (with installments + juros via the policy) AND PIX
                            both go through InlineCheckout so the rules stay centralized. */}
                        <InlineCheckout
                            amount={checkoutAmount ?? monthlyTotal}
                            paymentId={firstPaymentId || undefined}
                            description={paymentPlan === 'FULL'
                                ? `Pagamento integral - Contrato ${duration} meses`
                                : `1ª parcela - Contrato ${duration} meses`}
                            contractDuration={paymentPlan === 'FULL' ? duration : 1}
                            allowedMethods={paymentMethod === 'PIX' ? ['PIX'] : ['CARTAO']}
                            context="contract"
                            createPaymentFn={firstPaymentId ? async () => ({
                                paymentId: firstPaymentId,
                                pixString: firstPixString || undefined,
                            }) : undefined}
                            onSuccess={() => setStep(6)}
                            onError={(msg) => { setError(msg); setStep(4); }}
                            onCancel={() => setShowCancelModal(true)}
                        />

                        {/* ── Cancel Confirmation Modal ── */}
                        {showCancelModal && (
                            <div className="wizard-cancel-overlay" onClick={() => setShowCancelModal(false)}>
                                <div className="wizard-cancel-modal" onClick={e => e.stopPropagation()}>
                                    <div className="wizard-cancel-modal__icon">
                                        <AlertTriangle size={32} />
                                    </div>
                                    <h4 className="wizard-cancel-modal__title">Tem certeza que deseja sair?</h4>
                                    <p className="wizard-cancel-modal__desc">
                                        Seu contrato <strong>não será criado</strong> sem o pagamento da 1ª parcela. Nenhum horário será reservado na agenda.
                                    </p>
                                    <p className="wizard-cancel-modal__sub">
                                        Você pode voltar a qualquer momento e iniciar uma nova contratação.
                                    </p>
                                    <button className="wizard-cta-pay" style={{ width: '100%', marginBottom: 10 }} onClick={() => setShowCancelModal(false)}>
                                        <ShieldCheck size={16} /> Continuar Pagamento
                                    </button>
                                    <button className="wizard-cancel-modal__exit" onClick={() => { setShowCancelModal(false); onClose(); }}>
                                        Sair sem pagar
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {/* ══════════ STEP 1: PLAN SELECTION ══════════ */}
                {step === 1 && (
                    <div>
                        <h3 className="wizard-step__title">1. Escolha seu Plano</h3>

                        <div className="form-group" style={{ marginBottom: 20 }}>
                            <label className="form-label">Nome do Projeto (Obrigatório)</label>
                            <input className="form-input" type="text" value={contractName}
                                onChange={e => setContractName(e.target.value)}
                                placeholder="Ex: Podcast de Tecnologia, Cliente VIP" />
                        </div>

                        {/* Tier Tabs */}
                        <div className="modal-tabs">
                            {pricing.map(p => {
                                const info = TIER_INFO[p.tier];
                                return (
                                    <button key={p.tier}
                                        className={`modal-tab ${selectedTier === p.tier ? 'modal-tab--active' : ''}`}
                                        onClick={() => setSelectedTier(p.tier)}>
                                        {info?.emoji} {p.label}
                                    </button>
                                );
                            })}
                        </div>

                        {/* Tier description */}
                        {tierConfig && TIER_INFO[selectedTier] && (
                            <div className="wizard-tier-desc">
                                <span className="wizard-tier-desc__hours">🕐 {TIER_INFO[selectedTier].hours}</span>
                                <span>·</span>
                                <span>{TIER_INFO[selectedTier].desc}</span>
                            </div>
                        )}

                        {/* Price Cards */}
                        <div className="wizard-price-grid">
                            {/* 3 Meses Card */}
                            <div className={`wizard-price-card ${selectedPlan === '3MESES' ? 'wizard-price-card--selected' : ''}`}
                                onClick={() => setSelectedPlan('3MESES')}>
                                <div className="wizard-price-card__badge" style={{ background: 'var(--tier-comercial)' }}>-30%</div>
                                <div>
                                    <div className="wizard-price-card__label">Fidelidade 3 Meses</div>
                                    <div className="wizard-price-card__original">{formatBRL(basePrice)}</div>
                                    <div className="wizard-price-card__price">{formatBRL(Math.round(basePrice * 0.7))}</div>
                                    <div className="wizard-price-card__per">por sessão · 12 gravações</div>
                                </div>
                                <button className="btn btn-primary btn-sm" style={{ width: '100%', marginTop: 12, opacity: selectedPlan === '3MESES' ? 1 : 0.7 }}>
                                    {selectedPlan === '3MESES' ? '✓ Selecionado' : 'Selecionar'}
                                </button>
                            </div>

                            {/* 6 Meses Card */}
                            <div className={`wizard-price-card ${selectedPlan === '6MESES' ? 'wizard-price-card--selected' : ''}`}
                                onClick={() => setSelectedPlan('6MESES')}>
                                <div className="wizard-price-card__badge" style={{ background: 'var(--accent-primary)' }}>MELHOR PREÇO -40%</div>
                                <div>
                                    <div className="wizard-price-card__label">Fidelidade 6 Meses</div>
                                    <div className="wizard-price-card__original">{formatBRL(basePrice)}</div>
                                    <div className="wizard-price-card__price">{formatBRL(Math.round(basePrice * 0.6))}</div>
                                    <div className="wizard-price-card__per">por sessão · 24 gravações</div>
                                </div>
                                <button className="btn btn-primary btn-sm" style={{ width: '100%', marginTop: 12, opacity: selectedPlan === '6MESES' ? 1 : 0.7 }}>
                                    {selectedPlan === '6MESES' ? '✓ Selecionado' : 'Selecionar'}
                                </button>
                            </div>
                        </div>

                        {/* Custom Plan Shortcut */}
                        {onOpenCustom && (
                            <div className="wizard-custom-cta" onClick={() => { onClose(); onOpenCustom(); }}>
                                <div className="wizard-custom-cta__icon">🎨</div>
                                <div style={{ flex: 1 }}>
                                    <div className="wizard-custom-cta__title">Precisa de mais flexibilidade?</div>
                                    <div className="wizard-custom-cta__desc">
                                        Monte um plano personalizado com múltiplos dias, serviços sob demanda e descontos progressivos.
                                    </div>
                                </div>
                                <div className="wizard-custom-cta__arrow">Configurar ➔</div>
                            </div>
                        )}

                        <div className="wizard-actions">
                            <div />
                            <button className="btn btn-primary" style={{ flex: 1 }}
                                onClick={() => { setFirstDate(''); setFirstTime(''); setStep(2); }}
                                disabled={!selectedPlan || !contractName.trim()}>
                                Continuar ➔
                            </button>
                        </div>
                    </div>
                )}

                {/* ══════════ STEP 2: AGENDA CONFIG ══════════ */}
                {step === 2 && (
                    <div className="wizard-step2">
                        <h3 className="wizard-step__title">2. Configure sua Agenda</h3>
                        <p className="wizard-step__subtitle">Escolha o modelo e selecione seu primeiro horário de gravação.</p>

                        {/* ── Schedule Type Toggle ── */}
                        <div className="wizard-schedule-toggle">
                            <button
                                className={`wizard-schedule-btn ${scheduleType === 'FIXO' ? 'wizard-schedule-btn--active' : ''}`}
                                onClick={() => setScheduleType('FIXO')}
                            >
                                <div className="wizard-schedule-btn__icon">
                                    <Pin size={20} />
                                </div>
                                <div className="wizard-schedule-btn__content">
                                    <span className="wizard-schedule-btn__title">Agenda Fixa</span>
                                    <span className="wizard-schedule-btn__desc">Mesmo dia e horário toda semana</span>
                                </div>
                                {scheduleType === 'FIXO' && <CheckCircle2 size={20} className="wizard-schedule-btn__check" />}
                            </button>
                            <button
                                className={`wizard-schedule-btn ${scheduleType === 'FLEX' ? 'wizard-schedule-btn--active' : ''}`}
                                onClick={() => setScheduleType('FLEX')}
                            >
                                <div className="wizard-schedule-btn__icon">
                                    <Shuffle size={20} />
                                </div>
                                <div className="wizard-schedule-btn__content">
                                    <span className="wizard-schedule-btn__title">Agenda Flex</span>
                                    <span className="wizard-schedule-btn__desc">Agende semana a semana com liberdade</span>
                                </div>
                                {scheduleType === 'FLEX' && <CheckCircle2 size={20} className="wizard-schedule-btn__check" />}
                            </button>
                        </div>

                        {/* ── Date & Time (progressive disclosure) ── */}
                        {scheduleType && (
                            <div className="wizard-datetime-section">
                                {/* Info banner */}
                                <div className="wizard-info-banner">
                                    <AlertTriangle size={16} />
                                    <span>Seu contrato começa a valer a partir desta gravação.</span>
                                </div>

                                {/* ── Horizontal Date Scroller ── */}
                                <div className="wizard-date-section">
                                    <label className="wizard-date-section__label">
                                        <CalendarDays size={16} />
                                        Data do 1º Episódio
                                    </label>
                                    <div className="wizard-date-scroller">
                                        <div className="wizard-date-scroller__track">
                                            {allowedDates.map(d => {
                                                const y = d.getFullYear();
                                                const m = String(d.getMonth() + 1).padStart(2, '0');
                                                const day = String(d.getDate()).padStart(2, '0');
                                                const dateStr = `${y}-${m}-${day}`;
                                                const isSelected = firstDate === dateStr;
                                                const isToday = new Date().toISOString().slice(0, 10) === dateStr;
                                                return (
                                                    <button
                                                        key={dateStr}
                                                        className={`wizard-date-chip ${isSelected ? 'wizard-date-chip--selected' : ''} ${isToday ? 'wizard-date-chip--today' : ''}`}
                                                        onClick={() => { setFirstDate(dateStr); setFirstTime(''); }}
                                                    >
                                                        <span className="wizard-date-chip__weekday">{DAY_NAMES_SHORT[d.getDay()]}</span>
                                                        <span className="wizard-date-chip__day">{d.getDate()}</span>
                                                        <span className="wizard-date-chip__month">{MONTH_NAMES_SHORT[d.getMonth()]}</span>
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    </div>
                                </div>

                                {/* ── Time Slot Grid ── */}
                                {firstDate && (
                                    <div className="wizard-time-section">
                                        <label className="wizard-date-section__label">
                                            <Clock size={16} />
                                            Horário — Pacote 2h
                                        </label>
                                        {loadingSlots ? (
                                            <div className="wizard-time-loading">
                                                <div className="wizard-time-loading__spinner" />
                                                <span>Verificando disponibilidade...</span>
                                            </div>
                                        ) : availableSlots.length === 0 ? (
                                            <div className="wizard-time-empty">
                                                <XCircle size={24} />
                                                <span>Nenhum horário disponível nesta data.</span>
                                            </div>
                                        ) : (
                                            <div className="wizard-time-grid">
                                                {availableSlots.map(s => {
                                                    const isTierAllowed = selectedTier === 'COMERCIAL' ? s.time <= '15:30' : true;
                                                    const slotDateTime = new Date(`${firstDate}T${s.time}:00`);
                                                    const isPast = (slotDateTime.getTime() - Date.now()) / (1000 * 60) < 30;
                                                    const isSelectable = s.available && isTierAllowed && !isPast;
                                                    const isSelected = firstTime === s.time;
                                                    const [h] = s.time.split(':').map(Number);
                                                    const endTime = `${String(h + 2).padStart(2, '0')}:${s.time.split(':')[1]}`;

                                                    let statusClass = '';
                                                    if (isSelected) statusClass = 'wizard-time-chip--selected';
                                                    else if (!isSelectable && !s.available) statusClass = 'wizard-time-chip--occupied';
                                                    else if (!isSelectable && !isTierAllowed) statusClass = 'wizard-time-chip--locked';
                                                    else if (!isSelectable && isPast) statusClass = 'wizard-time-chip--past';

                                                    return (
                                                        <button
                                                            key={s.time}
                                                            className={`wizard-time-chip ${statusClass}`}
                                                            onClick={() => isSelectable && setFirstTime(s.time)}
                                                            disabled={!isSelectable}
                                                        >
                                                            <span className="wizard-time-chip__range">{s.time}–{endTime}</span>
                                                            <span className="wizard-time-chip__status">
                                                                {isSelected ? <CheckCircle2 size={14} /> :
                                                                 !s.available ? 'Ocupado' :
                                                                 !isTierAllowed ? <Lock size={14} /> :
                                                                 isPast ? 'Passado' : 'Livre'}
                                                            </span>
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        )}

                        <div className="wizard-actions">
                            <button className="btn btn-secondary" onClick={() => setStep(1)}>
                                <ChevronLeft size={16} /> Voltar
                            </button>
                            <button className="btn btn-primary" onClick={() => { setStep(3); }}
                                disabled={!firstDate || !firstTime || !scheduleType}>
                                Continuar <ChevronRight size={16} />
                            </button>
                        </div>
                    </div>
                )}

                {/* ══════════ STEP 3: ADICIONAIS OPCIONAIS ══════════ */}
                {step === 3 && tierConfig && (
                    <div className="wizard-step3">
                        <h3 className="wizard-step__title">3. Turbine seu Projeto</h3>
                        <p className="wizard-step__subtitle">
                            Serviços extras com <strong>{discountPct}% OFF</strong> no seu plano. 100% opcional.
                        </p>

                        {/* Addon Cards */}
                        <div className="wizard-addons-grid">
                            {addons.filter(a => !a.monthly).map(addon => {
                                const isSelected = selectedAddons.includes(addon.key);
                                // Per-recording is the primary unit (service accompanies every recording);
                                // the monthly figure is the aggregate over the sessions in the cycle.
                                const perRecording = Math.round(addon.price * (1 - discountPct / 100));
                                const discountedMonthlyAddon = perRecording * sessionsPerMonth;

                                const ADDON_ICONS: Record<string, React.ReactNode> = {
                                    CORTES_IA: <Sparkles size={20} />,
                                    CORTES_HUMANO: <Film size={20} />,
                                    YOUTUBE_SEO: <TrendingUp size={20} />,
                                    PAUTAS: <FileText size={20} />,
                                };

                                return (
                                    <button key={addon.key}
                                        className={`wizard-addon-card ${isSelected ? 'wizard-addon-card--selected' : ''}`}
                                        onClick={() => {
                                            if (isSelected) setSelectedAddons(prev => prev.filter(k => k !== addon.key));
                                            else setSelectedAddons(prev => [...prev, addon.key]);
                                        }}>
                                        {/* Header row */}
                                        <div className="wizard-addon-card__header">
                                            <div className={`wizard-addon-card__icon ${isSelected ? 'wizard-addon-card__icon--active' : ''}`}>
                                                {ADDON_ICONS[addon.key] || <Sparkles size={20} />}
                                            </div>
                                            <div className={`wizard-addon-card__toggle ${isSelected ? 'wizard-addon-card__toggle--on' : ''}`}>
                                                <div className="wizard-addon-card__toggle-knob" />
                                            </div>
                                        </div>

                                        {/* Content */}
                                        <div className="wizard-addon-card__name">{addon.name}</div>
                                        <div className="wizard-addon-card__desc">{addon.description}</div>

                                        {/* Price footer — per-recording leads, monthly aggregate below */}
                                        <div className="wizard-addon-card__footer">
                                            <div className="wizard-addon-card__price">
                                                +{formatBRL(perRecording)}
                                                <span className="wizard-addon-card__per">/gravação</span>
                                            </div>
                                            <div className="wizard-addon-card__savings">
                                                <span className="wizard-addon-card__original">{sessionsPerMonth}× = {formatBRL(discountedMonthlyAddon)}/mês</span>
                                                {discountPct > 0 && (
                                                    <span className="wizard-addon-card__badge">-{discountPct}%</span>
                                                )}
                                            </div>
                                        </div>
                                    </button>
                                );
                            })}
                        </div>

                        {/* Selection summary */}
                        {selectedAddons.length > 0 && (
                            <div className="wizard-addon-summary">
                                <CheckCircle2 size={16} />
                                <span>{selectedAddons.length} serviço{selectedAddons.length > 1 ? 's' : ''} selecionado{selectedAddons.length > 1 ? 's' : ''}</span>
                                <span className="wizard-addon-summary__total">
                                    +{formatBRL(discountedAddonsTotal)}/mês
                                </span>
                            </div>
                        )}

                        <div className="wizard-actions">
                            <button className="btn btn-secondary" onClick={() => setStep(2)}>
                                <ChevronLeft size={16} /> Voltar
                            </button>
                            <button className="btn btn-primary" onClick={() => setStep(4)}>
                                {selectedAddons.length > 0 ? 'Continuar' : 'Pular Extras'} <ChevronRight size={16} />
                            </button>
                        </div>
                    </div>
                )}

                {/* ══════════ STEP 4: SUMMARY & CHECKOUT ══════════ */}
                {step === 4 && tierConfig && (
                    <div className="wizard-step4">
                        <h3 className="wizard-step__title">4. Resumo e Pagamento</h3>
                        <p className="wizard-step__subtitle">Revise seu pedido e escolha a forma de pagamento.</p>

                        {error && (
                            <div className="wizard-info-banner" style={{ background: 'rgba(239,68,68,0.08)', borderColor: 'rgba(239,68,68,0.2)', color: '#ef4444' }}>
                                <XCircle size={16} />
                                <span>{error}</span>
                            </div>
                        )}

                        {/* ── Receipt-style Summary ── */}
                        <div className="wizard-receipt">
                            <div className="wizard-receipt__header">
                                <Receipt size={16} />
                                <span>Resumo do Pedido</span>
                            </div>

                            {/* Main package */}
                            <div className="wizard-receipt__item">
                                <div className="wizard-receipt__item-info">
                                    <div className="wizard-receipt__item-icon">
                                        <Mic size={16} />
                                    </div>
                                    <div>
                                        <div className="wizard-receipt__item-name">Pacote Estúdio — {duration} Meses</div>
                                        <div className="wizard-receipt__item-meta">
                                            {totalGravacoes} sessões • {tierConfig.label} • {scheduleType === 'FIXO' ? 'Fixo' : 'Flex'}
                                        </div>
                                    </div>
                                </div>
                                <div className="wizard-receipt__item-price">
                                    <span>{formatBRL(discountedPrice * 4)}</span>
                                    <span className="wizard-receipt__item-per">/mês</span>
                                </div>
                            </div>

                            {discountPct > 0 && (
                                <div className="wizard-receipt__discount-pill">
                                    <Tag size={12} />
                                    <span>Desconto fidelidade de {discountPct}% aplicado</span>
                                </div>
                            )}

                            {/* Addon items */}
                            {selectedAddons.length > 0 && (
                                <div className="wizard-receipt__addons">
                                    <div className="wizard-receipt__addons-divider">
                                        <span>Serviços Extras</span>
                                    </div>
                                    {selectedAddons.map(key => {
                                        const addon = addons.find(a => a.key === key);
                                        if(!addon) return null;
                                        const perRecording = Math.round(addon.price * (1 - discountPct / 100));
                                        const discountedMonthly = addon.monthly ? perRecording : perRecording * sessionsPerMonth;
                                        const ADDON_ICON_MAP: Record<string, React.ReactNode> = {
                                            CORTES_IA: <Sparkles size={14} />,
                                            CORTES_HUMANO: <Film size={14} />,
                                            YOUTUBE_SEO: <TrendingUp size={14} />,
                                            PAUTAS: <FileText size={14} />,
                                        };
                                        return (
                                            <div key={key} className="wizard-receipt__addon-row">
                                                <div className="wizard-receipt__addon-info">
                                                    <span className="wizard-receipt__addon-icon">{ADDON_ICON_MAP[key] || <Sparkles size={14} />}</span>
                                                    <span>{addon.name}</span>
                                                    {!addon.monthly && (
                                                        <span className="wizard-receipt__addon-unit">{formatBRL(perRecording)}/gravação</span>
                                                    )}
                                                </div>
                                                <span className="wizard-receipt__addon-price">+{formatBRL(discountedMonthly)}/mês</span>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}

                            {/* Totals */}
                            <div className="wizard-receipt__totals">
                                <div className="wizard-receipt__total-row">
                                    <span>Mensal</span>
                                    <span className="wizard-receipt__total-value">{formatBRL(monthlyTotal)}/mês</span>
                                </div>
                                <div className="wizard-receipt__total-row wizard-receipt__total-row--grand">
                                    <span>Contrato Completo ({duration}x)</span>
                                    <span className="wizard-receipt__grand-value">{formatBRL(monthlyTotal * duration)}</span>
                                </div>
                                {appliedCoupon && (
                                    <>
                                        <div className="wizard-receipt__total-row">
                                            <span>Subtotal ({paymentPlan === 'FULL' ? 'à vista' : '1ª parcela'})</span>
                                            <span className="wizard-receipt__total-value">{formatBRL(couponBaseAmount)}</span>
                                        </div>
                                        <div className="wizard-receipt__total-row" style={{ color: '#10b981' }}>
                                            <span>Cupom {appliedCoupon.code}</span>
                                            <span className="wizard-receipt__total-value" style={{ color: '#10b981' }}>−{formatBRL(appliedCoupon.discountAmount)}</span>
                                        </div>
                                        <div className="wizard-receipt__total-row wizard-receipt__total-row--grand">
                                            <span>Total {paymentPlan === 'FULL' ? 'a pagar' : 'da 1ª parcela'}</span>
                                            <span className="wizard-receipt__grand-value">{formatBRL(appliedCoupon.finalAmount)}</span>
                                        </div>
                                    </>
                                )}
                            </div>
                        </div>

                        {/* ── Cupom de desconto ── */}
                        <div style={{ margin: '12px 0 4px' }}>
                            <CouponField
                                amount={couponBaseAmount}
                                applied={appliedCoupon}
                                onApply={setAppliedCoupon}
                                onRemove={() => setAppliedCoupon(null)}
                            />
                        </div>

                        {/* ── Payment Plan Selector (Mensal / À vista PIX / À vista Cartão) ── */}
                        <div className="wizard-pay-section">
                            <div className="wizard-pay-section__label">
                                <CreditCard size={16} />
                                <span>Plano de Pagamento</span>
                            </div>

                            <div className="wizard-pay-options">
                                {/* Mensal */}
                                <button
                                    className={`wizard-pay-card ${paymentPlan === 'MONTHLY' ? 'wizard-pay-card--selected' : ''}`}
                                    onClick={() => setPaymentPlan('MONTHLY')}>
                                    <div className="wizard-pay-card__left">
                                        <div className={`wizard-pay-card__radio ${paymentPlan === 'MONTHLY' ? 'wizard-pay-card__radio--on' : ''}`}>
                                            {paymentPlan === 'MONTHLY' && <div className="wizard-pay-card__radio-dot" />}
                                        </div>
                                        <div>
                                            <div className="wizard-pay-card__name">Mensal</div>
                                            <div className="wizard-pay-card__desc">{duration} parcelas mensais</div>
                                        </div>
                                    </div>
                                    <div className="wizard-pay-card__right">
                                        <div className="wizard-pay-card__price">{duration}x {formatBRL(monthlyTotal)}</div>
                                        <div className="wizard-pay-card__sub">Total: {formatBRL(contractFullTotal)}</div>
                                    </div>
                                </button>

                                {/* À vista no PIX */}
                                <button
                                    className={`wizard-pay-card ${paymentPlan === 'FULL' && paymentMethod === 'PIX' ? 'wizard-pay-card--selected' : ''}`}
                                    onClick={() => { setPaymentPlan('FULL'); setPaymentMethod('PIX'); }}>
                                    <div className="wizard-pay-card__left">
                                        <div className={`wizard-pay-card__radio ${paymentPlan === 'FULL' && paymentMethod === 'PIX' ? 'wizard-pay-card__radio--on' : ''}`}>
                                            {paymentPlan === 'FULL' && paymentMethod === 'PIX' && <div className="wizard-pay-card__radio-dot" />}
                                        </div>
                                        <div>
                                            <div className="wizard-pay-card__name">
                                                À vista no PIX
                                                {pixExtraDiscountPct > 0 && <span className="wizard-pay-card__surcharge">-{pixExtraDiscountPct}%</span>}
                                            </div>
                                            <div className="wizard-pay-card__desc">Pague tudo agora com desconto</div>
                                        </div>
                                    </div>
                                    <div className="wizard-pay-card__right">
                                        <div className="wizard-pay-card__price">{formatBRL(pixFullTotal)}</div>
                                        {pixExtraDiscountPct > 0 && (
                                            <div className="wizard-pay-card__sub" style={{ textDecoration: 'line-through' }}>{formatBRL(contractFullTotal)}</div>
                                        )}
                                    </div>
                                </button>

                                {/* À vista no Cartão */}
                                <button
                                    className={`wizard-pay-card ${paymentPlan === 'FULL' && paymentMethod === 'CARTAO' ? 'wizard-pay-card--selected' : ''}`}
                                    onClick={() => { setPaymentPlan('FULL'); setPaymentMethod('CARTAO'); }}>
                                    <div className="wizard-pay-card__left">
                                        <div className={`wizard-pay-card__radio ${paymentPlan === 'FULL' && paymentMethod === 'CARTAO' ? 'wizard-pay-card__radio--on' : ''}`}>
                                            {paymentPlan === 'FULL' && paymentMethod === 'CARTAO' && <div className="wizard-pay-card__radio-dot" />}
                                        </div>
                                        <div>
                                            <div className="wizard-pay-card__name">À vista no Cartão</div>
                                            <div className="wizard-pay-card__desc">Integral à vista ou parcelado no cartão</div>
                                        </div>
                                    </div>
                                    <div className="wizard-pay-card__right">
                                        <div className="wizard-pay-card__price">{formatBRL(contractFullTotal)}</div>
                                        <div className="wizard-pay-card__sub">ou parcelado</div>
                                    </div>
                                </button>
                            </div>
                        </div>

                        {/* ── Payment Method Selector (MONTHLY only — PIX/Cartão) ── */}
                        {paymentPlan === 'MONTHLY' && (
                        <div className="wizard-pay-section">
                            <div className="wizard-pay-section__label">
                                <CreditCard size={16} />
                                <span>Forma de Pagamento</span>
                            </div>

                            <div className="wizard-pay-options">
                                {getClientPaymentMethods().map(pm => {
                                    const isSelected = paymentMethod === pm.key;
                                    let displayPrice = '';
                                    let subPrice = '';
                                    let surchargePctVal = 0;
                                    let desc = '';

                                    if (pm.key === 'PIX') {
                                        displayPrice = `${duration}x ${formatBRL(monthlyTotal)}`;
                                        subPrice = `Total: ${formatBRL(monthlyTotal * duration)}`;
                                        desc = 'Parcelas mensais via PIX';
                                    } else if (pm.key === 'CARTAO') {
                                        // Monthly card has NO surcharge — each month is a single 1x charge (same as PIX).
                                        displayPrice = `${duration}x ${formatBRL(monthlyTotal)}`;
                                        subPrice = `Total: ${formatBRL(monthlyTotal * duration)}`;
                                        desc = 'Parcelas mensais no cartão';
                                    } else {
                                        displayPrice = `${duration}x ${formatBRL(monthlyTotal)}`;
                                        subPrice = `Total: ${formatBRL(monthlyTotal * duration)}`;
                                        desc = 'Boleto bancário mensal';
                                    }

                                    return (
                                        <button key={pm.key}
                                            className={`wizard-pay-card ${isSelected ? 'wizard-pay-card--selected' : ''}`}
                                            onClick={() => setPaymentMethod(pm.key as 'CARTAO' | 'PIX')}
                                            style={{ '--pay-color': pm.color, '--pay-bg': pm.bgActive, '--pay-border': pm.borderActive } as React.CSSProperties}>
                                            <div className="wizard-pay-card__left">
                                                <div className={`wizard-pay-card__radio ${isSelected ? 'wizard-pay-card__radio--on' : ''}`}>
                                                    {isSelected && <div className="wizard-pay-card__radio-dot" />}
                                                </div>
                                                <div>
                                                    <div className="wizard-pay-card__name">
                                                        {pm.key === 'PIX' ? 'PIX Parcelado' : pm.key === 'CARTAO' ? `Cartão em ${duration}x` : pm.label}
                                                        {surchargePctVal > 0 && <span className="wizard-pay-card__surcharge">+{surchargePctVal}%</span>}
                                                    </div>
                                                    <div className="wizard-pay-card__desc">{desc}</div>
                                                </div>
                                            </div>
                                            <div className="wizard-pay-card__right">
                                                <div className="wizard-pay-card__price">{displayPrice}</div>
                                                <div className="wizard-pay-card__sub">{subPrice}</div>
                                            </div>
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                        )}

                        {/* ── Terms ── */}
                        <div className="wizard-terms-v2">
                            <div className="wizard-terms-v2__header">
                                <ScrollText size={16} />
                                <span>Termos e Regras</span>
                            </div>
                            <ul className="wizard-terms-v2__list">
                                <li>Vigência de {duration} meses a partir de <strong>{firstDate.split('-').reverse().join('/')}</strong>.</li>
                                <li>Cancelamento com menos de <strong>{selectedTier === 'SABADO' ? '48' : '24'}h</strong> de antecedência = perda do crédito.</li>
                                <li>Remarcação com até <strong>7 dias</strong> de antecedência.</li>
                                <li>Créditos não utilizados expiram ao final do contrato.</li>
                                {scheduleType === 'FIXO' && <li>Horários fixos reservados automaticamente.</li>}
                            </ul>
                            <label className="wizard-terms-v2__accept">
                                <div className={`wizard-terms-v2__checkbox ${acceptedTerms ? 'wizard-terms-v2__checkbox--checked' : ''}`}>
                                    {acceptedTerms && <CheckCircle2 size={16} />}
                                </div>
                                <span>Li e aceito as regras acima</span>
                                <input type="checkbox" checked={acceptedTerms} onChange={e => setAcceptedTerms(e.target.checked)} className="sr-only" />
                            </label>
                        </div>

                        {/* ── Actions ── */}
                        <div className="wizard-actions">
                            <button className="btn btn-secondary" onClick={() => setStep(3)}>
                                <ChevronLeft size={16} /> Voltar
                            </button>
                            <button className="wizard-cta-pay" onClick={handleSubmit} disabled={!acceptedTerms || submitting || !paymentMethod}>
                                {submitting ? (
                                    <><div className="wizard-time-loading__spinner" style={{ width: 16, height: 16, borderWidth: 2 }} /> Processando...</>
                                ) : (
                                    <><ShieldCheck size={18} /> Ir para Pagamento</>
                                )}
                            </button>
                        </div>
                    </div>
                )}

                {/* ══════════ STEP 7: CONFLICT RESOLUTION ══════════ */}
                {step === 7 && (
                    <div>
                        <div className="wizard-state-screen" style={{ padding: '24px 0' }}>
                            <div className="wizard-state-screen__icon">⚠️</div>
                            <h3 className="wizard-state-screen__title" style={{ color: '#ef4444' }}>Conflitos de Agenda Encontrados</h3>
                            <p className="wizard-state-screen__desc">Alguns dias do seu contrato Fixo já possuem outras gravações marcadas.</p>
                        </div>

                        <div style={{ background: 'var(--bg-secondary)', padding: 16, borderRadius: 'var(--radius-md)', marginBottom: 24 }}>
                            <div style={{ fontWeight: 700, marginBottom: 4, fontSize: '0.875rem' }}>Datas em conflito:</div>
                            <p style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', margin: '0 0 14px' }}>
                                Para cada dia, escolha um horário livre como substituto — ou volte e selecione outro dia recorrente.
                            </p>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                                {conflicts.map((c, i) => {
                                    const ymd = c.date.split('-');
                                    const dateObj = new Date(`${c.date}T12:00:00`);
                                    const localDate = `${ymd[2]}/${ymd[1]}/${ymd[0]}`;
                                    const dow = DAY_NAMES_FULL[dateObj.getDay()];
                                    const alts = c.alternatives && c.alternatives.length > 0
                                        ? c.alternatives
                                        : (c.suggestedReplacement ? [c.suggestedReplacement] : []);
                                    const selected = getResolution(c.date, c.originalTime);

                                    return (
                                        <div key={i} className="wizard-conflict">
                                            <div className="wizard-conflict__header">
                                                <span className="wizard-conflict__date">{dow}, {localDate} às {c.originalTime}</span>
                                                <span className="wizard-conflict__badge">Ocupado</span>
                                            </div>

                                            {alts.length > 0 ? (
                                                <div style={{ marginTop: 10 }}>
                                                    <div style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 8 }}>
                                                        Novo horário neste dia:
                                                    </div>
                                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                                                        {alts.map(alt => {
                                                            const isSel = selected?.newTime === alt.time && selected?.newDate === alt.date;
                                                            return (
                                                                <button
                                                                    key={alt.time}
                                                                    type="button"
                                                                    onClick={() => selectAlternative(c.date, c.originalTime, alt)}
                                                                    aria-pressed={isSel}
                                                                    style={{
                                                                        padding: '7px 14px',
                                                                        borderRadius: 'var(--radius-sm)',
                                                                        border: `1.5px solid ${isSel ? 'var(--accent-primary)' : 'var(--border-default)'}`,
                                                                        background: isSel ? 'var(--accent-primary)' : 'var(--bg-card)',
                                                                        color: isSel ? '#fff' : 'var(--text-primary)',
                                                                        fontWeight: 600,
                                                                        fontSize: '0.85rem',
                                                                        cursor: 'pointer',
                                                                        transition: 'all 0.15s',
                                                                    }}
                                                                >
                                                                    {alt.time}
                                                                </button>
                                                            );
                                                        })}
                                                    </div>
                                                </div>
                                            ) : (
                                                <div className="wizard-conflict__warning">
                                                    <span>⚠️ Este dia está completamente lotado para o seu pacote. Volte e escolha outro dia/horário recorrente para evitar a sobreposição.</span>
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>

                        {unresolvedConflicts > 0 && (
                            <p style={{ fontSize: '0.78rem', color: '#ef4444', textAlign: 'center', marginBottom: 12 }}>
                                {unresolvedConflicts === 1
                                    ? '1 dia continua lotado e será criado sobre o horário ocupado. Recomendamos voltar e ajustar.'
                                    : `${unresolvedConflicts} dias continuam lotados e serão criados sobre os horários ocupados. Recomendamos voltar e ajustar.`}
                            </p>
                        )}

                        <div className="wizard-actions wizard-actions--stack">
                            <button className="btn btn-primary" style={{ width: '100%', padding: 14 }}
                                onClick={() => executeCreation(resolvedConflicts)}>
                                ✅ Confirmar Substituições e Concluir
                            </button>
                            <button className="btn btn-secondary" style={{ width: '100%', padding: 14 }}
                                onClick={() => setStep(2)}>
                                ⬅ Voltar e escolher outro Plano/Horário
                            </button>
                        </div>
                    </div>
                )}

            </div>
        </BottomSheetModal>
    );
}

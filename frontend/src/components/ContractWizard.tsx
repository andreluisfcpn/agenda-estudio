import { getErrorMessage } from '../utils/errors';
import React, { useState, useEffect } from 'react';
import BottomSheetModal from './BottomSheetModal';
import { PricingConfig, AddOnConfig, bookingsApi, contractsApi, Slot, pricingApi, stripeApi } from '../api/client';
import { useBusinessConfig } from '../hooks/useBusinessConfig';
import { getClientPaymentMethods, type PaymentMethodKey } from '../constants/paymentMethods';
import InlineCheckout from './InlineCheckout';
import StripeCardForm from './StripeCardForm';
import { X } from 'lucide-react';

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
        if (d.getDay() === 0) return false;
        if (selectedTier === 'COMERCIAL') return d.getDay() >= 1 && d.getDay() <= 5;
        return true;
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

            if (res.clientSecret && paymentMethod === 'CARTAO') {
                setCardClientSecret(res.clientSecret);
                setStep(8);
            } else if (paymentMethod === 'PIX') {
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
                        <h3 className="wizard-state-screen__title">Processando...</h3>
                        <p className="wizard-state-screen__desc">Gerando seus agendamentos. Aguarde um instante.</p>
                    </div>
                )}

                {/* ══════════ STEP 6: SUCCESS ══════════ */}
                {step === 6 && (
                    <div className="wizard-state-screen">
                        <div className="wizard-state-screen__icon">🎉</div>
                        <h3 className="wizard-state-screen__title">Contrato Criado com Sucesso!</h3>
                        <p className="wizard-state-screen__desc">
                            {`Seu plano ${scheduleType === 'FIXO' ? 'Fixo' : 'Flex'} de ${duration} meses com ${totalGravacoes} gravações está ativo.`}
                        </p>
                        <button className="btn btn-primary" style={{ width: '100%' }} onClick={() => { onComplete(); onClose(); }}>
                            ✅ Ver Meus Contratos
                        </button>
                    </div>
                )}

                {/* ══════════ STEP 8: INLINE PAYMENT ══════════ */}
                {step === 8 && (
                    <div className="wizard-payment-step">
                        <div className="wizard-payment-step__header">
                            <div className="wizard-payment-step__icon">💳</div>
                            <h3 className="wizard-payment-step__title">Pagamento da 1ª Parcela</h3>
                            <p className="wizard-payment-step__desc">
                                Complete o pagamento para ativar seu contrato. As demais parcelas serão cobradas mensalmente.
                            </p>
                        </div>

                        {paymentMethod === 'CARTAO' && cardClientSecret ? (
                            <>
                                <div className="info-box info-box--success" style={{ textAlign: 'center', marginBottom: 24 }}>
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

                        <button className="btn btn-ghost btn-sm wizard-payment-step__skip" onClick={() => setStep(6)}>
                            Pagar depois na aba Pagamentos →
                        </button>
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
                    <div>
                        <h3 className="wizard-step__title">2. Configure sua Agenda</h3>

                        {/* Fixo / Flex toggle */}
                        <div style={{ marginBottom: 20 }}>
                            <label className="form-label" style={{ marginBottom: 8 }}>Modelo de Agenda</label>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                                <div className={`selectable-card ${scheduleType === 'FIXO' ? 'selectable-card--selected' : ''}`}
                                    onClick={() => setScheduleType('FIXO')}>
                                    <div style={{ fontWeight: 700, marginBottom: 4, fontSize: '0.9375rem' }}>📌 Agenda Fixa</div>
                                    <div className="wizard-slot__tier">Mesmo dia e horário toda semana. O sistema reserva automaticamente.</div>
                                </div>
                                <div className={`selectable-card ${scheduleType === 'FLEX' ? 'selectable-card--selected' : ''}`}
                                    onClick={() => setScheduleType('FLEX')}>
                                    <div style={{ fontWeight: 700, marginBottom: 4, fontSize: '0.9375rem' }}>🔄 Agenda Flex</div>
                                    <div className="wizard-slot__tier">Agende semana a semana com total liberdade de horários.</div>
                                </div>
                            </div>
                        </div>

                        {/* Calendar section */}
                        {scheduleType && (
                            <>
                                <div className="info-box info-box--warning">
                                    ⚠️ Atenção: O seu contrato começará a valer a partir da data desta primeira gravação.
                                </div>

                                <div className="form-group" style={{ marginBottom: 16 }}>
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
                                    <div className="form-group" style={{ marginBottom: 16 }}>
                                        <label className="form-label">Horário (Pacote 2h)</label>
                                        {loadingSlots ? (
                                            <div className="modal-section__desc" style={{ padding: '12px 0' }}>⏳ Carregando horários disponíveis...</div>
                                        ) : (
                                            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                                                {availableSlots.map(s => {
                                                    const isTierAllowed = selectedTier === 'COMERCIAL' ? s.time <= '15:30' : true;
                                                    const slotDateTime = new Date(`${firstDate}T${s.time}:00`);
                                                    const isPast = (slotDateTime.getTime() - Date.now()) / (1000 * 60) < 30;
                                                    const isSelectable = s.available && isTierAllowed && !isPast;
                                                    const [h] = s.time.split(':').map(Number);
                                                    const endTime = `${h + 2}:${s.time.split(':')[1]}`;

                                                    return (
                                                        <div key={s.time}
                                                            className={`wizard-slot ${firstTime === s.time ? 'wizard-slot--selected' : ''} ${!isSelectable ? 'wizard-slot--disabled' : ''}`}
                                                            onClick={() => isSelectable && setFirstTime(s.time)}
                                                            style={{ opacity: isSelectable ? 1 : isPast ? 0.4 : 0.6 }}>
                                                            <div style={{ display: 'flex', flexDirection: 'column' }}>
                                                                <span className={`wizard-slot__time ${firstTime === s.time ? 'wizard-slot__time--selected' : ''}`}>
                                                                    {s.time} - {endTime}
                                                                </span>
                                                                <span className="wizard-slot__tier">
                                                                    {s.tier === 'COMERCIAL' ? '🏢 Comercial' : (s.tier === 'AUDIENCIA' ? '🎤 Audiência' : '🌟 Sábado')}
                                                                </span>
                                                            </div>
                                                            <div>
                                                                {!isTierAllowed ? (
                                                                    <span title={`Exclusivo para planos ${s.tier}`}>🔒</span>
                                                                ) : !s.available ? (
                                                                    <span className="wizard-slot__status">Ocupado</span>
                                                                ) : firstTime === s.time ? (
                                                                    <span style={{ color: 'var(--accent-primary)', fontWeight: 800 }}>✓</span>
                                                                ) : null}
                                                            </div>
                                                        </div>
                                                    );
                                                })}
                                                {availableSlots.length === 0 && (
                                                    <div className="modal-section__desc" style={{ padding: '8px 0' }}>
                                                        Nenhum horário disponível para esta data.
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </>
                        )}

                        <div className="wizard-actions">
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
                        <h3 className="wizard-step__title">3. Serviços Adicionais (Opcionais)</h3>
                        <p className="wizard-step__subtitle">
                            Potencialize a entrega do seu projeto. Seu plano te garante <strong>{discountPct}% de desconto</strong> nos extras selecionados abaixo. Contratação 100% opcional.
                        </p>

                        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 32 }}>
                            {addons.filter(a => a.key !== 'GESTAO_SOCIAL').map(addon => {
                                const isSelected = selectedAddons.includes(addon.key);
                                const monthlyAddonBase = addon.price * 4;
                                const discountedAddonPrice = Math.round(monthlyAddonBase * (1 - discountPct / 100));
                                
                                return (
                                    <div key={addon.key}
                                        className={`wizard-addon ${isSelected ? 'wizard-addon--selected' : ''}`}
                                        onClick={() => {
                                            if (isSelected) setSelectedAddons(prev => prev.filter(k => k !== addon.key));
                                            else setSelectedAddons(prev => [...prev, addon.key]);
                                        }}>
                                        <div className="wizard-addon__left">
                                            <input type="checkbox" checked={isSelected} readOnly className="wizard-addon__checkbox" />
                                            <div>
                                                <div className={`wizard-addon__name ${isSelected ? 'wizard-addon__name--selected' : ''}`}>{addon.name}</div>
                                                <div className="wizard-addon__desc">{addon.description || 'Impulsione seus resultados mensalmente.'}</div>
                                            </div>
                                        </div>
                                        <div className="wizard-addon__right">
                                            <div className={`wizard-addon__price ${isSelected ? 'wizard-addon__price--selected' : ''}`}>
                                                + {formatBRL(discountedAddonPrice)} <span className="wizard-addon__price-unit">/mês</span>
                                            </div>
                                            {discountPct > 0 && <div className="wizard-addon__original">{formatBRL(monthlyAddonBase)} /mês</div>}
                                            {discountPct > 0 && <div className="wizard-addon__discount">-{discountPct}% OFF</div>}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>

                        <div className="wizard-actions">
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
                        <h3 className="wizard-step__title">4. Resumo e Checkout</h3>

                        {error && (
                            <div className="info-box info-box--error">❌ {error}</div>
                        )}

                        {/* Order summary */}
                        <div className="wizard-summary">
                            <div className="wizard-summary__label">Carrinho de Compras</div>

                            <div className="wizard-summary__row">
                                <div>
                                    <div className="wizard-summary__item-name">Pacote Estúdio ({duration} Meses)</div>
                                    <div className="wizard-summary__item-desc">{totalGravacoes} sessões de {tierConfig.label} ({scheduleType === 'FIXO' ? 'Fixo' : 'Flex'})</div>
                                </div>
                                <div style={{ textAlign: 'right' }}>
                                    <span className="wizard-summary__item-price">{formatBRL(discountedPrice * 4)}/mês</span>
                                    {discountPct > 0 && <div className="wizard-summary__discount-note">-{discountPct}% aplicado</div>}
                                </div>
                            </div>

                            {selectedAddons.length > 0 && (
                                <div className="wizard-summary__addons">
                                    <div className="wizard-summary__addons-label">Serviços Adicionais Escolhidos:</div>
                                    {selectedAddons.map(key => {
                                        const addon = addons.find(a => a.key === key);
                                        if(!addon) return null;
                                        const discountedMonthly = Math.round((addon.price * sessionsPerMonth) * (1 - discountPct / 100));
                                        return (
                                            <div key={key} className="wizard-summary__addon-row">
                                                <span className="wizard-summary__addon-name">• {addon.name}</span>
                                                <span className="wizard-summary__addon-price">+ {formatBRL(discountedMonthly)}/mês</span>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}

                            <div className="wizard-summary__total">
                                <span className="wizard-summary__total-label">Subtotal (Mensal)</span>
                                <span className="wizard-summary__total-value">{formatBRL(monthlyTotal)}</span>
                            </div>
                            <div className="wizard-summary__full-total">
                                <span className="wizard-summary__full-total-label">Valor do Contrato Completo ({duration}x)</span>
                                <span className="wizard-summary__full-total-value">{formatBRL(monthlyTotal * duration)}</span>
                            </div>
                        </div>

                        {/* Payment Options */}
                        <div className="wizard-summary">
                            <div className="wizard-summary__label">Opções de Pagamento (Formato Final)</div>

                            {getClientPaymentMethods().map(pm => {
                                const isSelected = paymentMethod === pm.key;
                                let displayPrice = '';
                                let subPrice = '';
                                let badge: React.ReactNode = null;
                                let desc = '';

                                if (pm.key === 'PIX') {
                                    displayPrice = formatBRL(Math.round(monthlyTotal * duration * 0.9));
                                    subPrice = formatBRL(monthlyTotal * duration);
                                    badge = <span className="wizard-payment-card__badge" style={{ background: '#22c55e', color: '#fff' }}>-10%</span>;
                                    desc = 'Desconto aplicado no valor do contrato completo';
                                } else if (pm.key === 'CARTAO') {
                                    displayPrice = `${duration}x ${formatBRL(Math.round(monthlyTotal * 1.15))}`;
                                    subPrice = `Total: ${formatBRL(Math.round(monthlyTotal * duration * 1.15))}`;
                                    badge = <span className="wizard-payment-card__badge" style={{ background: 'var(--bg-elevated)', color: 'var(--text-muted)' }}>+15% TAXA</span>;
                                    desc = 'Valor total com acréscimo da operadora';
                                } else {
                                    displayPrice = `${duration}x ${formatBRL(monthlyTotal)}`;
                                    subPrice = `Total: ${formatBRL(monthlyTotal * duration)}`;
                                    desc = 'Sem juros mensais. 1º vencimento no envio do contrato';
                                }

                                return (
                                    <div key={pm.key}
                                        className="wizard-payment-card"
                                        onClick={() => setPaymentMethod(pm.key as 'CARTAO' | 'PIX')}
                                        style={{
                                            background: isSelected ? pm.bgActive : pm.bgInactive,
                                            border: `2px solid ${isSelected ? pm.borderActive : pm.borderInactive}`,
                                        }}>
                                        <div className="wizard-payment-card__row">
                                            <div>
                                                <div className="wizard-payment-card__name">
                                                    {pm.emoji} {pm.accessMode === 'FULL' && pm.key === 'PIX' ? `${pm.label} à vista` : pm.accessMode === 'FULL' ? `${pm.shortLabel} em ${duration}x` : `${pm.label} Mensal`} {badge}
                                                </div>
                                                <div className="wizard-payment-card__desc">{desc}</div>
                                            </div>
                                            <div style={{ textAlign: 'right' }}>
                                                <div className="wizard-payment-card__price" style={{ color: pm.color }}>{displayPrice}</div>
                                                <div className="wizard-payment-card__sub-price" style={{ textDecoration: pm.key === 'PIX' ? 'line-through' : 'none' }}>{subPrice}</div>
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>

                        {/* Terms */}
                        <div className="wizard-terms">
                            <div className="wizard-terms__title">📋 Termos e Regras</div>
                            <ul className="wizard-terms__list">
                                <li>A vigência dos {duration} meses inicia em <strong>{firstDate.split('-').reverse().join('/')}</strong>.</li>
                                <li>Cancelamento com menos de <strong>{selectedTier === 'SABADO' ? '48' : '24'} horas</strong> de antecedência implica na perda do crédito.</li>
                                <li>Remarcação permitida com até <strong>7 dias</strong> de antecedência.</li>
                                <li>Créditos não utilizados dentro da vigência do contrato expiram ao final do período.</li>
                                {scheduleType === 'FIXO' && <li>Horários fixos serão reservados automaticamente para toda a duração do contrato.</li>}
                            </ul>
                            <label className="wizard-terms__accept">
                                <input type="checkbox" checked={acceptedTerms} onChange={e => setAcceptedTerms(e.target.checked)}
                                    className="wizard-terms__checkbox" />
                                Li e aceito as regras acima
                            </label>
                        </div>

                        <div className="wizard-actions">
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
                        <div className="wizard-state-screen" style={{ padding: '24px 0' }}>
                            <div className="wizard-state-screen__icon">⚠️</div>
                            <h3 className="wizard-state-screen__title" style={{ color: '#ef4444' }}>Conflitos de Agenda Encontrados</h3>
                            <p className="wizard-state-screen__desc">Alguns dias do seu contrato Fixo já possuem outras gravações marcadas.</p>
                        </div>

                        <div style={{ background: 'var(--bg-secondary)', padding: 16, borderRadius: 'var(--radius-md)', marginBottom: 24 }}>
                            <div style={{ fontWeight: 700, marginBottom: 12, fontSize: '0.875rem' }}>Datas em conflito:</div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                                {conflicts.map((c, i) => {
                                    const ymd = c.date.split('-');
                                    const dateObj = new Date(`${c.date}T12:00:00`);
                                    const localDate = `${ymd[2]}/${ymd[1]}/${ymd[0]}`;
                                    const dow = DAY_NAMES_FULL[dateObj.getDay()];

                                    return (
                                        <div key={i} className="wizard-conflict">
                                            <div className="wizard-conflict__header">
                                                <span className="wizard-conflict__date">{dow}, {localDate} às {c.originalTime}</span>
                                                <span className="wizard-conflict__badge">Ocupado</span>
                                            </div>

                                            {c.suggestedReplacement ? (
                                                <div className="wizard-conflict__suggestion">
                                                    <span>💡 Nossa sugestão:</span>
                                                    <span className="wizard-conflict__alt">
                                                        {c.suggestedReplacement.time} no mesmo dia
                                                    </span>
                                                </div>
                                            ) : (
                                                <div className="wizard-conflict__warning">
                                                    <span>⚠️ Este dia está completamente lotado para o seu pacote. Esta gravação pulará uma semana e será adicionada ao final do seu contrato.</span>
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>

                        <div className="wizard-actions wizard-actions--stack">
                            <button className="btn btn-primary" style={{ width: '100%', padding: 14 }}
                                onClick={() => executeCreation(resolvedConflicts)}>
                                ✅ Aceitar Sugestões e Concluir
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

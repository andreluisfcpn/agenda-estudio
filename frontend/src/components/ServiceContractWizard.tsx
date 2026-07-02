import { useMemo, useRef, useState } from 'react';
import BottomSheetModal from './BottomSheetModal';
import InlineCheckout from './InlineCheckout';
import { Check, ChevronLeft, CheckCircle2 } from 'lucide-react';
import { useBusinessConfig } from '../hooks/useBusinessConfig';
import { getClientPaymentMethods, methodInContext, type PaymentMethodKey } from '../constants/paymentMethods';
import { formatBRL } from '../utils/format';
import { renderServiceIcon } from '../utils/serviceIcons';
import { contractsApi, type AddOnConfig, type CouponValidation } from '../api/client';
import { getErrorMessage } from '../utils/errors';
import CouponField from './CouponField';

interface ServiceContractWizardProps {
    isOpen: boolean;
    addon: AddOnConfig;
    onClose: () => void;
    /** Called after a successful inline payment (parent reloads its data). */
    onSuccess: () => void;
    /** Heading prefix — "Contratar" (default) or "Renovar". */
    mode?: 'hire' | 'renew';
}

type Step = 'overview' | 'plan' | 'method' | 'pay' | 'success';
type Plan = 'FULL' | 'MONTHLY';

const FALLBACK_BENEFITS = [
    'Publicação e agendamento nas redes',
    'Cortes e edição com foco em alcance',
    'Relatório mensal de métricas',
];

export default function ServiceContractWizard({ isOpen, addon, onClose, onSuccess, mode = 'hire' }: ServiceContractWizardProps) {
    const { get: getRule } = useBusinessConfig();

    // ── Catalog metadata (admin-driven) ──
    const durations = useMemo(() => {
        const list = (addon.durationsOffered || '3,6').split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
        return list.length ? list : [3, 6];
    }, [addon.durationsOffered]);

    const plans = useMemo<Plan[]>(() => {
        const list = (addon.plansAllowed || 'FULL').split(',').map(s => s.trim().toUpperCase()).filter(p => p === 'FULL' || p === 'MONTHLY') as Plan[];
        return list.length ? list : ['FULL'];
    }, [addon.plansAllowed]);

    const benefits = useMemo<string[]>(() => {
        try {
            const parsed = addon.benefits ? JSON.parse(addon.benefits) : [];
            if (Array.isArray(parsed) && parsed.length) return parsed.filter(b => typeof b === 'string');
        } catch { /* fall through */ }
        return FALLBACK_BENEFITS;
    }, [addon.benefits]);

    const [step, setStep] = useState<Step>('overview');
    const [duration, setDuration] = useState<number>(durations[0]);
    const [plan, setPlan] = useState<Plan>(plans[0]);
    const [method, setMethod] = useState<PaymentMethodKey | null>(null);
    // Cupom de desconto (preview no plano; o valor cobrado vem do backend em res.amount).
    const [appliedCoupon, setAppliedCoupon] = useState<CouponValidation | null>(null);

    // Inline-payment state (created on the method → pay transition)
    const [firstPaymentId, setFirstPaymentId] = useState<string | null>(null);
    const [checkoutAmount, setCheckoutAmount] = useState<number>(0);
    const [pixString, setPixString] = useState<string | undefined>(undefined);
    const [creating, setCreating] = useState(false);
    const [error, setError] = useState('');
    // Re-entrancy guard: state updates are async, so a double-click would otherwise fire
    // createService twice (two PENDING payments / two Cora invoices).
    const creatingRef = useRef(false);

    // ── Pricing preview (mirrors backend resolvePlanAmounts + getInstallmentPolicy; display only) ──
    // Loyalty discount applies ONLY to the configured fidelities (3/6 months); any other duration
    // gets 0% — this MUST match the backend (contract.services.ts) so the preview never over-promises.
    const discountPct = duration === 6 ? getRule('service_discount_6months')
        : duration === 3 ? getRule('service_discount_3months') : 0;
    const monthlyDiscounted = Math.round(addon.price * (1 - (discountPct || 0) / 100));
    const subtotal = monthlyDiscounted * duration;
    const pixExtra = getRule('pix_extra_discount_pct') || 0;
    const pixTotal = Math.round(subtotal * (1 - pixExtra / 100));
    // FULL on a contract is interest-free up to `duration` card installments (getInstallmentPolicy
    // freeUpTo=duration), so the card preview must NOT add card_installment_surcharges here.
    const cardPerInstallment = Math.round(subtotal / duration);

    // Total do plano ATUAL — base do cupom (MONTHLY: 1ª mensalidade; FULL: total no PIX).
    const couponBaseAmount = plan === 'MONTHLY' ? monthlyDiscounted : pixTotal;

    const clientMethods = useMemo(
        () => getClientPaymentMethods().filter(m => m.key !== 'BOLETO' && methodInContext(m, 'contract')),
        [],
    );

    const reset = () => {
        setStep('overview'); setDuration(durations[0]); setPlan(plans[0]); setMethod(null);
        setFirstPaymentId(null); setCheckoutAmount(0); setPixString(undefined); setError('');
        setAppliedCoupon(null);
    };

    const handleClose = () => { if (!creating) { reset(); onClose(); } };

    // Proceed from method selection: create the first payment, then open inline checkout.
    const goToPayment = async (chosen: PaymentMethodKey) => {
        if (creatingRef.current) return;
        creatingRef.current = true;
        setMethod(chosen);
        setCreating(true);
        setError('');
        try {
            const res = await contractsApi.createService({
                serviceKey: addon.key,
                paymentMethod: chosen as 'CARTAO' | 'PIX' | 'BOLETO',
                durationMonths: duration,
                paymentPlan: plan,
                couponCode: appliedCoupon?.code,
            });
            setFirstPaymentId(res.firstPaymentId);
            // Fonte da verdade: o backend devolve o amount já com o cupom descontado.
            setCheckoutAmount(res.amount);
            setPixString(res.pixString);
            // Cupom de 100% — pagamento já quitado no backend; vai direto ao sucesso.
            if (res.alreadyPaid) {
                setStep('success');
                return;
            }
            setStep('pay');
        } catch (err) {
            setError(getErrorMessage(err) || 'Erro ao iniciar o pagamento. Tente novamente.');
        } finally {
            setCreating(false);
            creatingRef.current = false;
        }
    };

    // Going back to method selection discards the just-created payment reference so a new
    // selection starts a fresh checkout (avoids reusing a stale/abandoned payment).
    const backToMethod = () => { setFirstPaymentId(null); setPixString(undefined); setStep('method'); };

    const title = step === 'success'
        ? 'Tudo certo!'
        : `${mode === 'renew' ? 'Renovar' : 'Contratar'} ${addon.name}`;

    return (
        <BottomSheetModal isOpen={isOpen} onClose={handleClose} title={title} preventClose={creating} maxWidth="480px">
            {/* ══ Step 1 — Overview & benefits ══ */}
            {step === 'overview' && (
                <div>
                    <div style={{ textAlign: 'center', marginBottom: '18px' }}>
                        <div style={{
                            width: 64, height: 64, borderRadius: '50%', margin: '0 auto 12px',
                            background: 'rgba(17,129,155,0.12)', border: '1px solid rgba(17,129,155,0.25)',
                            color: 'var(--accent-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }}>
                            {renderServiceIcon(addon.icon, 30)}
                        </div>
                        <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', lineHeight: 1.5, margin: '0 auto', maxWidth: 380 }}>
                            {addon.description || 'Cuidamos da produção e do alcance do seu conteúdo — você foca em gravar.'}
                        </p>
                    </div>

                    <div style={{ display: 'grid', gap: '8px', padding: '14px 16px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)', marginBottom: '20px' }}>
                        {benefits.map(b => (
                            <div key={b} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
                                <Check size={15} style={{ flexShrink: 0, color: 'var(--accent-primary)' }} /> {b}
                            </div>
                        ))}
                    </div>

                    <div style={{ textAlign: 'center', fontSize: '0.875rem', color: 'var(--text-muted)', marginBottom: '16px' }}>
                        A partir de <strong style={{ color: 'var(--text-primary)' }}>{formatBRL(addon.price)}</strong>/mês
                    </div>

                    <div className="modal-actions">
                        <button className="btn btn-secondary" onClick={handleClose} style={{ flex: 1 }}>Cancelar</button>
                        <button className="btn btn-primary" onClick={() => setStep('plan')} style={{ flex: 1 }}>Começar</button>
                    </div>
                </div>
            )}

            {/* ══ Step 2 — Duration + plan ══ */}
            {step === 'plan' && (
                <div>
                    <div style={{ fontWeight: 700, fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: '10px' }}>
                        1. Escolha sua fidelidade
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.min(durations.length, 2)}, 1fr)`, gap: '12px', marginBottom: '24px' }}>
                        {durations.map(dur => {
                            const isSel = duration === dur;
                            const dp = dur === 6 ? getRule('service_discount_6months') : dur === 3 ? getRule('service_discount_3months') : 0;
                            return (
                                <div key={dur} onClick={() => setDuration(dur)} style={{
                                    border: `2px solid ${isSel ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                                    background: isSel ? 'rgba(17,129,155,0.08)' : 'var(--bg-secondary)',
                                    borderRadius: 'var(--radius-md)', padding: '16px', cursor: 'pointer', textAlign: 'center', transition: 'all 0.2s',
                                }}>
                                    <div style={{ fontSize: '1.25rem', fontWeight: 800, color: isSel ? 'var(--accent-primary)' : 'var(--text-primary)' }}>{dur} meses</div>
                                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '4px' }}>{(dp || 0) > 0 ? `Desconto de ${dp}%` : 'Sem fidelidade'}</div>
                                </div>
                            );
                        })}
                    </div>

                    {plans.length > 1 && (
                        <>
                            <div style={{ fontWeight: 700, fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: '10px' }}>
                                2. Forma de cobrança
                            </div>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '20px' }}>
                                {([['MONTHLY', 'Mensal', `${duration}x de ${formatBRL(monthlyDiscounted)}`], ['FULL', 'À vista', `${formatBRL(pixTotal)} no PIX`]] as const)
                                    .filter(([p]) => plans.includes(p as Plan))
                                    .map(([p, label, hint]) => {
                                        const isSel = plan === p;
                                        return (
                                            <div key={p} onClick={() => setPlan(p as Plan)} style={{
                                                border: `2px solid ${isSel ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                                                background: isSel ? 'rgba(17,129,155,0.08)' : 'var(--bg-secondary)',
                                                borderRadius: 'var(--radius-md)', padding: '14px', cursor: 'pointer', textAlign: 'center', transition: 'all 0.2s',
                                            }}>
                                                <div style={{ fontSize: '0.95rem', fontWeight: 800, color: isSel ? 'var(--accent-primary)' : 'var(--text-primary)' }}>{label}</div>
                                                <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '4px' }}>{hint}</div>
                                            </div>
                                        );
                                    })}
                            </div>
                        </>
                    )}

                    {/* Price summary */}
                    <div style={{ padding: '14px 16px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)', marginBottom: '12px', display: 'grid', gap: 6 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
                            <span>{appliedCoupon ? 'Subtotal' : (plan === 'MONTHLY' ? `Mensalidade (${duration}x)` : `Total à vista (${duration} meses)`)}</span>
                            <span style={{ fontWeight: appliedCoupon ? 600 : 800, color: 'var(--text-primary)' }}>
                                {plan === 'MONTHLY' ? `${formatBRL(monthlyDiscounted)}/mês` : formatBRL(pixTotal)}
                            </span>
                        </div>
                        {appliedCoupon && (
                            <>
                                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.875rem', color: '#10b981' }}>
                                    <span>Cupom {appliedCoupon.code}</span>
                                    <span style={{ fontWeight: 600 }}>−{formatBRL(appliedCoupon.discountAmount)}</span>
                                </div>
                                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.875rem', color: 'var(--text-secondary)', borderTop: '1px solid var(--border-subtle)', paddingTop: 6 }}>
                                    <span>{plan === 'MONTHLY' ? 'Total da 1ª mensalidade' : 'Total à vista'}</span>
                                    <span style={{ fontWeight: 800, color: 'var(--text-primary)' }}>{formatBRL(appliedCoupon.finalAmount)}</span>
                                </div>
                            </>
                        )}
                    </div>

                    {/* Cupom de desconto */}
                    <CouponField
                        amount={couponBaseAmount}
                        applied={appliedCoupon}
                        onApply={setAppliedCoupon}
                        onRemove={() => setAppliedCoupon(null)}
                    />

                    <div className="modal-actions">
                        <button className="btn btn-secondary" onClick={() => setStep('overview')} style={{ flex: 1 }}>
                            <ChevronLeft size={15} /> Voltar
                        </button>
                        <button className="btn btn-primary" onClick={() => setStep('method')} style={{ flex: 1 }}>Continuar</button>
                    </div>
                </div>
            )}

            {/* ══ Step 3 — Payment method ══ */}
            {step === 'method' && (
                <div>
                    <div style={{ fontWeight: 700, fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: '10px' }}>
                        Forma de pagamento
                    </div>

                    {error && <div className="login-modal-alert login-modal-alert--error" style={{ marginBottom: 12 }}>{error}</div>}

                    {clientMethods.map(pm => {
                        const isCard = pm.key === 'CARTAO';
                        const priceLabel = plan === 'MONTHLY'
                            ? `${duration}x de ${formatBRL(monthlyDiscounted)}/mês`
                            : isCard
                                ? `${duration}x de ${formatBRL(cardPerInstallment)}`
                                : formatBRL(pixTotal);
                        const subLabel = plan === 'MONTHLY'
                            ? (isCard ? 'Cobrado mês a mês no cartão' : 'PIX mensal — pague a 1ª agora')
                            : (isCard ? `Até ${duration}x sem juros` : `${pixExtra}% de desconto à vista`);
                        return (
                            <div key={pm.key} onClick={() => !creating && goToPayment(pm.key as PaymentMethodKey)}
                                style={{
                                    padding: '14px', borderRadius: 'var(--radius-sm)', marginBottom: '10px',
                                    cursor: creating ? 'wait' : 'pointer', opacity: creating ? 0.6 : 1,
                                    background: pm.bgInactive, border: `2px solid ${pm.borderInactive}`,
                                    display: 'flex', justifyContent: 'space-between', alignItems: 'center', transition: 'all 0.2s',
                                }}>
                                <div>
                                    <div style={{ fontWeight: 700, fontSize: '0.9rem' }}>{pm.emoji} {pm.label}</div>
                                    <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{subLabel}</div>
                                </div>
                                <div style={{ fontWeight: 800, color: isCard ? 'var(--text-primary)' : pm.color }}>{priceLabel}</div>
                            </div>
                        );
                    })}

                    <div className="modal-actions">
                        <button className="btn btn-secondary" onClick={() => setStep('plan')} disabled={creating} style={{ flex: 1 }}>
                            <ChevronLeft size={15} /> Voltar
                        </button>
                    </div>
                </div>
            )}

            {/* ══ Step 4 — Inline payment ══ */}
            {step === 'pay' && method && firstPaymentId && (
                <div>
                    <InlineCheckout
                        amount={checkoutAmount}
                        paymentId={firstPaymentId}
                        description={plan === 'FULL'
                            ? `${addon.name} — ${duration} meses`
                            : `${addon.name} — 1ª mensalidade`}
                        contractDuration={plan === 'FULL' ? duration : 1}
                        allowedMethods={[method]}
                        context="contract"
                        createPaymentFn={async () => ({ paymentId: firstPaymentId, pixString })}
                        onSuccess={() => setStep('success')}
                        onError={(msg) => { setError(msg); backToMethod(); }}
                        onCancel={backToMethod}
                    />
                </div>
            )}

            {/* ══ Step 5 — Success ══ */}
            {step === 'success' && (
                <div style={{ textAlign: 'center', padding: '12px 0' }}>
                    <CheckCircle2 size={56} style={{ color: 'var(--accent-success, #22c55e)', marginBottom: 12 }} />
                    <h3 style={{ fontSize: '1.1rem', fontWeight: 800, margin: '0 0 8px' }}>Pagamento recebido!</h3>
                    <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', lineHeight: 1.5, margin: '0 auto 20px', maxWidth: 340 }}>
                        Seu serviço <strong>{addon.name}</strong> será ativado assim que o pagamento for confirmado. Você pode acompanhar tudo em Meus Contratos.
                    </p>
                    <button className="btn btn-primary" style={{ width: '100%' }} onClick={() => { onSuccess(); reset(); onClose(); }}>
                        Concluir
                    </button>
                </div>
            )}
        </BottomSheetModal>
    );
}

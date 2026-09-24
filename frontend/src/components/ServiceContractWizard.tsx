import { useEffect, useMemo, useRef, useState } from 'react';
import BottomSheetModal from './BottomSheetModal';
import InlineCheckout from './InlineCheckout';
import DangerConfirmDialog from './ui/DangerConfirmDialog';
import { Check, ChevronLeft, CheckCircle2, Clock, LogOut } from 'lucide-react';
import { useBusinessConfig } from '../hooks/useBusinessConfig';
import { useCountdown } from '../hooks/useCountdown';
import { useCardInstallments } from '../hooks/useCardInstallments';
import { useWizardStep, ignoreMultiClick } from '../hooks/useWizardStep';
import { getClientPaymentMethods, methodInContext, type PaymentMethodConfig } from '../constants/paymentMethods';
import { formatBRL } from '../utils/format';
import { renderServiceIcon } from '../utils/serviceIcons';
import { ApiError, contractsApi, type AddOnConfig, type CouponValidation } from '../api/client';
import { getErrorMessage } from '../utils/errors';
import CouponField from './CouponField';
import '../styles/service-contract-wizard.css';

interface ServiceContractWizardProps {
    isOpen: boolean;
    addon: AddOnConfig;
    onClose: () => void;
    /** Called after a successful inline payment (parent reloads its data). */
    onSuccess: () => void;
    /**
     * Chamado AO FECHAR quando a lista do pai ficou desatualizada: a contratação ficou "Aguardando
     * pagamento" (o cliente saiu do checkout sem pagar) ou a API respondeu 409 (contratação anterior
     * paga/em processamento). Nunca com o modal aberto (o reload da página o desmontaria).
     */
    onPending?: () => void;
    /** Heading prefix — "Contratar" (default) or "Renovar". */
    mode?: 'hire' | 'renew';
}

type Plan = 'FULL' | 'MONTHLY';
type Method = 'PIX' | 'CARTAO';
/** Mensal + cartão (D1): mensalidade 1×/mês OU o total agora em até N× sem juros. */
type CardMode = 'MONTHLY' | 'SPLIT';

/** Contratação criada no POST /contracts/service (passo de pagamento). */
interface Created {
    paymentId: string;
    amount: number;
    deadline: string | null;
    method: Method;
    cardSplit: boolean;
}

const STEP = { OVERVIEW: 1, PLAN: 2, METHOD: 3, PAY: 4, SUCCESS: 5 } as const;

const FALLBACK_BENEFITS = [
    'Publicação e agendamento nas redes',
    'Cortes e edição com foco em alcance',
    'Relatório mensal de métricas',
];

const monthsLabel = (n: number) => `${n} ${n === 1 ? 'mês' : 'meses'}`;

function fmtClock(secs: number): string {
    const s = Math.max(0, secs);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    const mmss = `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
    return h > 0 ? `${String(h).padStart(2, '0')}:${mmss}` : mmss;
}

function fmtTime(iso: string | null): string {
    if (!iso) return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

/**
 * Contratação/renovação de serviço mensal pelo cliente (D1/D2):
 * Visão geral → Fidelidade + forma de cobrança → Forma de pagamento → Pagamento (10 min) → Sucesso.
 *
 * Forma de cobrança × pagamento:
 *  - Mensal + PIX: 1ª mensalidade agora, as demais uma por mês.
 *  - Mensal + Cartão: o cliente escolhe (i) mês a mês (1× por mês) ou (ii) o TOTAL agora em até
 *    N× sem juros (N = meses da fidelidade) → `cardSplit: true`. A opção (ii) só aparece quando o
 *    GATEWAY parcela (POST /stripe/installment-plans com installmentCap N devolve mais que 1x); na conta
 *    Stripe BR (sem parcelamento) fica só o mês a mês — nunca oferecer o que não pode ser cumprido.
 *  - À vista: pagamento ÚNICO — PIX com o desconto PIX ou cartão 1× (sem parcelas).
 *
 * Anti-submit espúrio: sem <form>, todo botão type="button" com key própria no rodapé, avanço com
 * `next()` (setTimeout 0), guarda de etapa + trava por requisição em voo (estado, nunca tempo) na
 * criação; etapa com altura mínima estável e rodapé fixo na mesma posição (o 2º clique de um clique
 * duplo cai no botão da etapa seguinte — nunca no fundo, que fecharia o modal).
 */
export default function ServiceContractWizard({ isOpen, addon, onClose, onSuccess, onPending, mode = 'hire' }: ServiceContractWizardProps) {
    const { get: getRule } = useBusinessConfig();
    const { step, next, goTo, reset: resetStep } = useWizardStep(5);
    const stepRef = useRef(step);
    stepRef.current = step;

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

    const clientMethods = useMemo<PaymentMethodConfig[]>(
        () => getClientPaymentMethods().filter(m => (m.key === 'PIX' || m.key === 'CARTAO') && methodInContext(m, 'contract')),
        [],
    );

    const [duration, setDuration] = useState<number>(durations[0]);
    const [plan, setPlan] = useState<Plan>(plans[0]);
    const [method, setMethod] = useState<Method | null>(null);
    const [cardMode, setCardMode] = useState<CardMode | null>(null);
    // Cupom (prévia sobre a 1ª cobrança da forma escolhida; o valor cobrado vem do backend).
    const [appliedCoupon, setAppliedCoupon] = useState<CouponValidation | null>(null);

    const [created, setCreated] = useState<Created | null>(null);
    const [creating, setCreating] = useState(false);
    const [error, setError] = useState('');
    const [exitOpen, setExitOpen] = useState(false);
    // Trava por requisição em voo (não por tempo): um clique duplo em "Ir para pagamento" não cria
    // duas contratações.
    const creatingRef = useRef(false);
    // Algo mudou na lista do pai (contratação criada/aguardando, ou 409): recarrega AO FECHAR — o
    // reload da página desmonta este modal, então nunca é disparado com o wizard aberto.
    const parentDirtyRef = useRef(false);

    // ── Preço (espelha resolvePlanAmounts/paymentPolicy do backend; só exibição) ──
    // Desconto de fidelidade SÓ nas fidelidades configuradas (3/6 meses) — igual ao contract.services.ts.
    const discountFor = (dur: number) => (dur === 6 ? getRule('service_discount_6months')
        : dur === 3 ? getRule('service_discount_3months') : 0) || 0;
    const discountPct = discountFor(duration);
    const monthly = Math.round(addon.price * (1 - discountPct / 100));
    const subtotal = monthly * duration;
    const pixExtra = getRule('pix_extra_discount_pct') || 0;
    const pixTotal = Math.round(subtotal * (1 - pixExtra / 100));

    const hasPix = clientMethods.some(m => m.key === 'PIX');
    const hasCard = clientMethods.some(m => m.key === 'CARTAO');
    // D1 (ii) "parcelar o total em até N× sem juros" só se o gateway parcela de fato (conta Stripe BR não
    // parcela: o total sairia em 1×). Enquanto confere (ou se falhar) vale "não parcela".
    const splitCheck = useCardInstallments({
        amount: subtotal,
        durationMonths: duration,
        installmentCap: duration,
        enabled: isOpen && hasCard && plans.includes('MONTHLY') && duration > 1,
    });
    const splitMax = Math.min(splitCheck.maxCount, duration);
    const canSplit = splitMax > 1;
    const splitPer = Math.ceil(subtotal / Math.max(1, splitMax));
    // Com fidelidade de 1 mês não há o que parcelar: mensal no cartão é a própria cobrança única.
    const cardMonthlyPicked = plan === 'MONTHLY' && method === 'CARTAO' && duration > 1;
    const needsCardMode = cardMonthlyPicked && canSplit;
    // Conferindo o parcelamento: espera antes de criar (se o gateway parcelar, o cliente escolhe o modo).
    const cardModeLoading = cardMonthlyPicked && splitCheck.loading;
    const choiceComplete = !!method && !cardModeLoading && (!needsCardMode || !!cardMode);
    const cardSplit = needsCardMode && cardMode === 'SPLIT';
    // Base da 1ª cobrança (e do cupom) conforme a escolha.
    const firstCharge = plan === 'MONTHLY'
        ? (cardSplit ? subtotal : monthly)
        : (method === 'PIX' ? pixTotal : subtotal);

    const resetAll = () => {
        resetStep();
        setDuration(durations[0]);
        setPlan(plans[0]);
        setMethod(null);
        setCardMode(null);
        setAppliedCoupon(null);
        setCreated(null);
        setError('');
        setExitOpen(false);
    };

    const closeNow = () => {
        const dirty = parentDirtyRef.current;
        parentDirtyRef.current = false;
        resetAll();
        onClose();
        if (dirty) onPending?.();
    };

    // X / Esc / fundo: no pagamento pergunta antes (a contratação já existe e fica aguardando).
    const handleClose = () => {
        if (creating) return;
        if (step === STEP.PAY && created) { setExitOpen(true); return; }
        if (step === STEP.SUCCESS) { parentDirtyRef.current = false; onSuccess(); closeNow(); return; }
        closeNow();
    };

    const goToPayment = async () => {
        if (stepRef.current !== STEP.METHOD) return; // guarda de etapa
        if (!method || !choiceComplete || creatingRef.current) return;
        creatingRef.current = true;
        setCreating(true);
        setError('');
        try {
            const res = await contractsApi.createService({
                serviceKey: addon.key,
                paymentMethod: method,
                durationMonths: duration,
                paymentPlan: plan,
                couponCode: appliedCoupon?.code,
                ...(cardSplit ? { cardSplit: true } : {}),
            });
            // Cupom de 100% — pagamento já quitado no backend; vai direto ao sucesso.
            if (res.alreadyPaid) {
                setCreated({ paymentId: res.firstPaymentId, amount: 0, deadline: null, method, cardSplit });
                goTo(STEP.SUCCESS);
                return;
            }
            parentDirtyRef.current = true;
            // Fonte da verdade: o backend devolve o valor já com o cupom e o prazo (agora + 10 min).
            // Só o paymentId vai ao checkout — ele emite/reusa a cobrança (PIX com QR e validade).
            setCreated({
                paymentId: res.firstPaymentId,
                amount: res.amount,
                deadline: res.paymentDeadline ?? null,
                method,
                cardSplit,
            });
            goTo(STEP.PAY);
        } catch (err) {
            if (err instanceof ApiError && err.status === 409) {
                // Contratação anterior deste serviço já paga (ativa) ou com pagamento em processamento.
                setError(err.message || 'Há uma contratação anterior deste serviço em andamento. Confira em Meus Contratos.');
                parentDirtyRef.current = true;
            } else {
                setError(getErrorMessage(err) || 'Erro ao iniciar o pagamento. Tente novamente.');
            }
        } finally {
            setCreating(false);
            creatingRef.current = false;
        }
    };

    // Voltar do pagamento: a próxima criação substitui a contratação não paga (o backend a purga).
    const backToMethod = (msg = '') => {
        setCreated(null);
        setExitOpen(false);
        setError(msg);
        goTo(STEP.METHOD);
    };

    // D2: contagem de 10 min a partir do paymentDeadline devolvido pela criação.
    const remaining = useCountdown(step === STEP.PAY ? created?.deadline ?? null : null, () => {
        if (stepRef.current !== STEP.PAY) return;
        backToMethod(`Tempo esgotado. A contratação de ${addon.name} não foi concluída — escolha a forma de pagamento para gerar uma nova cobrança.`);
    });

    // À vista não tem a sub-escolha do cartão (é sempre 1×).
    useEffect(() => {
        if (plan === 'FULL') setCardMode(null);
    }, [plan]);

    const title = step === STEP.SUCCESS
        ? 'Tudo certo!'
        : `${mode === 'renew' ? 'Renovar' : 'Contratar'} ${addon.name}`;

    const footerHint = step === STEP.METHOD && !creating
        ? (!method ? 'Escolha a forma de pagamento.'
            : cardModeLoading ? 'Conferindo as opções do cartão…'
                : !choiceComplete ? 'Escolha como cobrar no cartão.' : '')
        : '';

    const methodCfg = (key: Method) => clientMethods.find(m => m.key === key);

    const renderMethodCard = (key: Method, label: string, sub: string, price: string) => {
        const cfg = methodCfg(key);
        const selected = method === key;
        return (
            <button
                key={key}
                type="button"
                role="radio"
                aria-checked={selected}
                className={`scw-choice scw-choice--method${selected ? ' scw-choice--active' : ''}`}
                style={{ '--scw-color': cfg?.color || 'var(--accent-primary)' } as React.CSSProperties}
                disabled={creating}
                onClick={() => {
                    if (method !== key) setCardMode(null);
                    setMethod(key);
                    setError('');
                }}
            >
                <span className="scw-choice__radio" aria-hidden="true">{selected && <Check size={12} />}</span>
                <span className="scw-choice__body">
                    <span className="scw-choice__title">{cfg?.emoji} {label}</span>
                    <span className="scw-choice__sub">{sub}</span>
                </span>
                <span className="scw-choice__price">{price}</span>
            </button>
        );
    };

    const renderCardMode = (key: CardMode, label: string, detail: string, sub: string) => {
        const selected = cardMode === key;
        return (
            <button
                key={key}
                type="button"
                role="radio"
                aria-checked={selected}
                className={`scw-choice scw-choice--sub${selected ? ' scw-choice--active' : ''}`}
                disabled={creating}
                onClick={() => { setCardMode(key); setError(''); }}
            >
                <span className="scw-choice__radio" aria-hidden="true">{selected && <Check size={12} />}</span>
                <span className="scw-choice__body">
                    <span className="scw-choice__title">{label}</span>
                    <span className="scw-choice__sub">{sub}</span>
                </span>
                <span className="scw-choice__price">{detail}</span>
            </button>
        );
    };

    // Resumo da escolha (passo 3).
    const summaryLines = (): { label: string; value: string }[] => {
        if (!choiceComplete) return [];
        if (plan === 'MONTHLY' && !cardSplit) {
            return [
                { label: 'Cobrança agora (1ª mensalidade)', value: formatBRL(monthly) },
                ...(duration > 1 ? [{ label: `Depois, ${duration - 1}× de`, value: `${formatBRL(monthly)}/mês` }] : []),
            ];
        }
        if (cardSplit) {
            return [
                { label: `Total de ${monthsLabel(duration)} cobrado agora`, value: formatBRL(subtotal) },
                { label: 'No cartão', value: `até ${splitMax}× de ${formatBRL(splitPer)} sem juros` },
            ];
        }
        return method === 'PIX'
            ? [{ label: `Pagamento único (${pixExtra}% de desconto PIX)`, value: formatBRL(pixTotal) }]
            : [{ label: 'Pagamento único no cartão (1×)', value: formatBRL(subtotal) }];
    };

    const checkoutDescription = created?.cardSplit
        ? `${addon.name} — ${monthsLabel(duration)} · até ${splitMax}× sem juros`
        : plan === 'FULL'
            ? `${addon.name} — ${monthsLabel(duration)} · pagamento único`
            : `${addon.name} — 1ª mensalidade`;

    const secsLeft = remaining ?? 0;
    const timerTone = remaining == null ? '' : secsLeft <= 60 ? ' scw-timer--danger' : secsLeft <= 180 ? ' scw-timer--warning' : '';

    return (
        <BottomSheetModal isOpen={isOpen} onClose={handleClose} title={title} preventClose={creating || exitOpen} size="sm" className="scw-sheet">
            {/* ══ Passo 1 — Visão geral ══ */}
            {step === STEP.OVERVIEW && (
                <div className="scw-step">
                    <div className="scw-hero">
                        <div className="scw-hero__icon">{renderServiceIcon(addon.icon, 30)}</div>
                        <p className="scw-hero__desc">
                            {addon.description || 'Cuidamos da produção e do alcance do seu conteúdo — você foca em gravar.'}
                        </p>
                    </div>

                    <ul className="scw-benefits">
                        {benefits.map(b => (
                            <li key={b}><Check size={15} aria-hidden="true" /> {b}</li>
                        ))}
                    </ul>

                    <div className="scw-from">
                        A partir de <strong>{formatBRL(addon.price)}</strong>/mês
                    </div>

                    <div className="scw-footer">
                        <p className="scw-hint" aria-live="polite" />
                        <div className="scw-actions">
                            <button key="cancel" type="button" className="btn btn-secondary" onClick={closeNow}>Cancelar</button>
                            <button key="start" type="button" className="btn btn-primary" onClick={() => next()}>Começar</button>
                        </div>
                    </div>
                </div>
            )}

            {/* ══ Passo 2 — Fidelidade + forma de cobrança ══ */}
            {step === STEP.PLAN && (
                <div className="scw-step">
                    <div className="scw-label" id="scw-duration-label">1. Escolha sua fidelidade</div>
                    <div className="scw-grid" role="radiogroup" aria-labelledby="scw-duration-label"
                        style={{ gridTemplateColumns: `repeat(${Math.min(durations.length, 2)}, minmax(0, 1fr))` }}>
                        {durations.map(dur => {
                            const isSel = duration === dur;
                            const dp = discountFor(dur);
                            return (
                                <button key={dur} type="button" role="radio" aria-checked={isSel}
                                    className={`scw-tile${isSel ? ' scw-tile--active' : ''}`}
                                    onClick={() => setDuration(dur)}>
                                    <span className="scw-tile__title">{monthsLabel(dur)}</span>
                                    <span className="scw-tile__sub">{dp > 0 ? `Desconto de ${dp}%` : 'Sem desconto'}</span>
                                </button>
                            );
                        })}
                    </div>

                    {plans.length > 1 && (
                        <>
                            <div className="scw-label" id="scw-plan-label">2. Forma de cobrança</div>
                            <div className="scw-grid" role="radiogroup" aria-labelledby="scw-plan-label"
                                style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
                                {([
                                    ['MONTHLY', 'Mensal', `${duration}× de ${formatBRL(monthly)}`],
                                    ['FULL', 'À vista', hasPix ? `Pagamento único · ${formatBRL(pixTotal)} no PIX` : `Pagamento único · ${formatBRL(subtotal)}`],
                                ] as const).filter(([p]) => plans.includes(p)).map(([p, label, hint]) => {
                                    const isSel = plan === p;
                                    return (
                                        <button key={p} type="button" role="radio" aria-checked={isSel}
                                            className={`scw-tile${isSel ? ' scw-tile--active' : ''}`}
                                            onClick={() => setPlan(p)}>
                                            <span className="scw-tile__title scw-tile__title--sm">{label}</span>
                                            <span className="scw-tile__sub">{hint}</span>
                                        </button>
                                    );
                                })}
                            </div>
                        </>
                    )}

                    <div className="scw-summary">
                        {plan === 'MONTHLY' ? (
                            <>
                                <div className="scw-summary__row">
                                    <span>Mensalidade ({monthsLabel(duration)})</span>
                                    <strong>{formatBRL(monthly)}/mês</strong>
                                </div>
                                {hasCard && duration > 1 && canSplit && (
                                    <div className="scw-summary__row scw-summary__row--muted">
                                        <span>No cartão, dá para pagar mês a mês ou o total em até {splitMax}× sem juros.</span>
                                    </div>
                                )}
                            </>
                        ) : hasPix ? (
                            <>
                                <div className="scw-summary__row">
                                    <span>Total à vista ({monthsLabel(duration)})</span>
                                    <strong>{formatBRL(pixTotal)} no PIX</strong>
                                </div>
                                {hasCard && (
                                    <div className="scw-summary__row scw-summary__row--muted">
                                        <span>No cartão: {formatBRL(subtotal)} em 1× (sem o desconto PIX).</span>
                                    </div>
                                )}
                            </>
                        ) : (
                            <div className="scw-summary__row">
                                <span>Total à vista ({monthsLabel(duration)})</span>
                                <strong>{formatBRL(subtotal)} em 1×</strong>
                            </div>
                        )}
                    </div>

                    <div className="scw-footer">
                        <p className="scw-hint" aria-live="polite" />
                        <div className="scw-actions">
                            <button key="back-overview" type="button" className="btn btn-secondary" onClick={() => goTo(STEP.OVERVIEW)}>
                                <ChevronLeft size={15} aria-hidden="true" /> Voltar
                            </button>
                            <button key="next" type="button" className="btn btn-primary" onClick={() => {
                                // A escolha de pagamento depende do plano: refeita no passo seguinte (e o
                                // "Ir para pagamento" nasce desabilitado — um clique duplo aqui não cria nada).
                                setMethod(null);
                                setCardMode(null);
                                setError('');
                                next();
                            }}>Continuar</button>
                        </div>
                    </div>
                </div>
            )}

            {/* ══ Passo 3 — Forma de pagamento ══ */}
            {step === STEP.METHOD && (
                <div className="scw-step">
                    <div className="scw-label" id="scw-method-label">
                        Forma de pagamento · {plan === 'MONTHLY' ? 'Mensal' : 'À vista'}
                    </div>

                    {error && <div className="login-modal-alert login-modal-alert--error scw-alert" role="alert">{error}</div>}

                    {clientMethods.length === 0 ? (
                        <div className="scw-empty">Nenhuma forma de pagamento disponível no momento. Fale com o estúdio.</div>
                    ) : (
                        <div className="scw-choices" role="radiogroup" aria-labelledby="scw-method-label">
                            {plan === 'MONTHLY' ? (
                                <>
                                    {hasPix && renderMethodCard('PIX', 'PIX', '1ª mensalidade agora, as demais uma por mês', `${formatBRL(monthly)}/mês`)}
                                    {hasCard && (duration > 1
                                        ? (canSplit
                                            ? renderMethodCard('CARTAO', 'Cartão de crédito', 'Mês a mês ou o total parcelado sem juros', `a partir de ${formatBRL(monthly)}/mês`)
                                            : renderMethodCard('CARTAO', 'Cartão de crédito', '1ª mensalidade agora, as demais uma por mês no cartão', `${formatBRL(monthly)}/mês`))
                                        : renderMethodCard('CARTAO', 'Cartão de crédito', 'Cobrança única no cartão (1×)', formatBRL(monthly)))}
                                </>
                            ) : (
                                <>
                                    {hasPix && renderMethodCard('PIX', 'PIX', `Pagamento único com ${pixExtra}% de desconto`, formatBRL(pixTotal))}
                                    {hasCard && renderMethodCard('CARTAO', 'Cartão', 'Pagamento único em 1× (sem parcelas)', formatBRL(subtotal))}
                                </>
                            )}
                        </div>
                    )}

                    {needsCardMode && (
                        <div className="scw-submodes">
                            <div className="scw-label scw-label--sub" id="scw-cardmode-label">Como cobrar no cartão</div>
                            <div className="scw-choices" role="radiogroup" aria-labelledby="scw-cardmode-label">
                                {renderCardMode('MONTHLY', 'Pagar mês a mês',
                                    `${duration}× de ${formatBRL(monthly)}/mês`,
                                    'Uma cobrança por mês no cartão')}
                                {renderCardMode('SPLIT', `Parcelar o total em até ${splitMax}× sem juros`,
                                    formatBRL(subtotal),
                                    `Cobra o total agora · até ${splitMax}× de ${formatBRL(splitPer)}`)}
                            </div>
                        </div>
                    )}

                    {choiceComplete && (
                        <>
                            <div className="scw-summary">
                                {summaryLines().map(l => (
                                    <div key={l.label} className="scw-summary__row">
                                        <span>{l.label}</span>
                                        <strong>{l.value}</strong>
                                    </div>
                                ))}
                                {appliedCoupon && (
                                    <>
                                        <div className="scw-summary__row scw-summary__row--discount">
                                            <span>Cupom {appliedCoupon.code}</span>
                                            <strong>−{formatBRL(appliedCoupon.discountAmount)}</strong>
                                        </div>
                                        <div className="scw-summary__row scw-summary__row--total">
                                            <span>A pagar agora</span>
                                            <strong>{formatBRL(appliedCoupon.finalAmount)}</strong>
                                        </div>
                                    </>
                                )}
                            </div>
                            <CouponField
                                amount={firstCharge}
                                applied={appliedCoupon}
                                onApply={setAppliedCoupon}
                                onRemove={() => setAppliedCoupon(null)}
                                disabled={creating}
                            />
                        </>
                    )}

                    <div className="scw-footer">
                        <p className="scw-hint" aria-live="polite">{footerHint}</p>
                        <div className="scw-actions">
                            <button key="back-plan" type="button" className="btn btn-secondary" disabled={creating}
                                onClick={() => { setError(''); goTo(STEP.PLAN); }}>
                                <ChevronLeft size={15} aria-hidden="true" /> Voltar
                            </button>
                            <button key="go-pay" type="button" className="btn btn-primary"
                                disabled={!choiceComplete || creating}
                                aria-busy={creating || undefined}
                                // 2º clique de um clique duplo (ex.: no "Continuar" da etapa anterior) não cria a contratação.
                                onClick={ignoreMultiClick(goToPayment)}>
                                {creating
                                    ? <><span className="spinner" style={{ width: 16, height: 16 }} aria-hidden="true" /> Gerando…</>
                                    : 'Ir para pagamento'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* ══ Passo 4 — Pagamento (prazo de 10 min) ══ */}
            {step === STEP.PAY && created && (
                <div className="scw-step">
                    <div className={`scw-timer${timerTone}`}>
                        <Clock size={20} aria-hidden="true" />
                        <span className="scw-timer__text">
                            Conclua o pagamento em até 10 minutos para ativar o serviço
                            {created.deadline ? ` (até ${fmtTime(created.deadline)})` : ''}.
                        </span>
                        {remaining != null && (
                            <span className="scw-timer__clock" role="timer" aria-label={`Tempo restante: ${fmtClock(secsLeft)}`}>
                                {fmtClock(secsLeft)}
                            </span>
                        )}
                    </div>

                    <InlineCheckout
                        amount={created.amount}
                        paymentId={created.paymentId}
                        description={checkoutDescription}
                        contractDuration={created.cardSplit ? duration : 1}
                        // "Parcelar o total em até N×": já abre em N× (o cliente pode reduzir).
                        initialInstallments={created.cardSplit ? splitMax : undefined}
                        allowedMethods={[created.method]}
                        context="contract"
                        onSuccess={() => { setExitOpen(false); goTo(STEP.SUCCESS); }}
                        // O erro aparece dentro do próprio checkout; o cliente continua no prazo
                        // (voltar e reenviar criaria outra contratação).
                        onError={() => { /* exibido pelo InlineCheckout */ }}
                    />

                    <div className="scw-footer">
                        <p className="scw-hint" aria-live="polite" />
                        <div className="scw-actions scw-actions--start">
                            <button key="back-method" type="button" className="btn btn-secondary" onClick={() => backToMethod()}>
                                <ChevronLeft size={15} aria-hidden="true" /> Outra forma de pagamento
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* ══ Passo 5 — Sucesso ══ */}
            {step === STEP.SUCCESS && (
                <div className="scw-step scw-step--center">
                    <div className="scw-success">
                        <CheckCircle2 size={56} aria-hidden="true" className="scw-success__icon" />
                        <h3 className="scw-success__title">{created && created.amount === 0 ? 'Serviço ativado!' : 'Pagamento confirmado!'}</h3>
                        <p className="scw-success__desc">
                            {created && created.amount === 0
                                ? <>Seu cupom cobriu o pagamento e o serviço <strong>{addon.name}</strong> já está ativo.</>
                                : <>O serviço <strong>{addon.name}</strong> está sendo ativado. Você acompanha tudo em Meus Contratos.</>}
                        </p>
                    </div>
                    <div className="scw-footer">
                        <p className="scw-hint" aria-live="polite" />
                        <div className="scw-actions">
                            <button key="done" type="button" className="btn btn-primary" onClick={() => { parentDirtyRef.current = false; onSuccess(); closeNow(); }}>
                                Concluir
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Sair no meio do pagamento: a contratação fica aguardando até o fim do prazo. */}
            <DangerConfirmDialog
                isOpen={exitOpen}
                tone="warning"
                icon={LogOut}
                title="Sair sem pagar?"
                description={created?.deadline
                    ? `A contratação de ${addon.name} fica aguardando pagamento até ${fmtTime(created.deadline)} (${fmtClock(secsLeft)} restantes). Você pode concluir em Meus Contratos; depois disso ela é cancelada e você pode contratar de novo.`
                    : `A contratação de ${addon.name} fica aguardando pagamento por poucos minutos. Você pode concluir em Meus Contratos.`}
                confirmLabel="Sair sem pagar"
                cancelLabel="Continuar pagamento"
                onConfirm={() => { parentDirtyRef.current = true; closeNow(); }}
                onClose={() => setExitOpen(false)}
                zIndex={1100}
            />
        </BottomSheetModal>
    );
}

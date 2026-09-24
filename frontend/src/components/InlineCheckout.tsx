import { getErrorMessage } from '../utils/errors';
// ─── InlineCheckout — Unified Payment Component ─────────
// ÚNICO checkout do sistema: Cartão (Stripe) + PIX (Sicoob/Cora) + Boleto (liberado por contrato).
// Toda cobrança sai de POST /stripe/create-payment a partir do paymentId (fonte única):
//  - PIX (D15): QR + validade + valor vêm da resposta (qrCodeDataUrl/expiresAt/amount) e o bloco é
//    o <PixQrCode>. QR expirado (contagem ou FAILED no polling) → "Gerar novo QR" chama o
//    create-payment de novo e reinicia o polling — nunca derruba o fluxo do pai (onError).
//  - Cartão: PaymentIntent criado com o nº de parcelas escolhido (política única do backend). N > 1 só
//    com cartão SALVO numa conta que parcela (o servidor fixa o plano); conta Stripe BR → só 1x.
//  - Valor exibido = valor cobrado (D1): no cartão, o total mostrado é o do plano 1x de
//    /stripe/installment-plans (o servidor calcula com cardChargeBaseAmount: SEM o desconto PIX do à
//    vista); com o PaymentIntent do cartão novo criado, o `amount` que o create-payment devolve (o
//    chargedAmount). No PIX, o `amount` da cobrança (com o desconto). Se diferem, o checkout avisa.

import React, { useState, useEffect, useRef, useCallback } from 'react';
import StripeCardForm from './StripeCardForm';
import PixQrCode from './PixQrCode';
import { stripeApi, paymentsApi, type SavedCard } from '../api/client';
import { getClientPaymentMethods, getPaymentMethods, methodInContext, getBoletoMethodConfig, type PaymentMethodKey } from '../constants/paymentMethods';
import { Copy, Check, Lock, QrCode, CreditCard, Plus, ShieldCheck, FileText, Info } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { isValidCpfCnpj } from '../utils/mask';
import CpfCnpjPrompt from './CpfCnpjPrompt';
import { getBrandIcon } from '../utils/cardBrand';
import { formatBRL } from '../utils/format';
import '../styles/inline-checkout.css';

// ─── Types ──────────────────────────────────────────────

interface InlineCheckoutProps {
    /** Total amount in cents */
    amount: number;
    /** Internal Payment record ID (if it already exists) */
    paymentId?: string;
    /** Human-readable description shown in the checkout */
    description: string;
    /** Contract duration in months (for installment calculation) */
    contractDuration?: number;
    /**
     * Nº de parcelas pré-selecionado no cartão de crédito (ex.: serviço "parcelar o total em até N×").
     * A política do backend manda: se N não estiver disponível, cai para a maior opção ≤ N.
     */
    initialInstallments?: number;
    /** Called when payment succeeds (any method) */
    onSuccess: () => void;
    /** Called when an error occurs */
    onError: (msg: string) => void;
    /** Optional cancel handler */
    onCancel?: () => void;
    /** Which methods to show. Default: ['CARTAO', 'PIX'] */
    allowedMethods?: PaymentMethodKey[];
    /**
     * Aba aberta primeiro — ex.: a forma de pagamento do contrato (um PIX abre direto no PIX, sem
     * passar pelo cartão salvo padrão). Ignorada se não estiver disponível. Padrão: a 1ª disponível.
     */
    initialMethod?: PaymentMethodKey | null;
    /** If true, show all methods including BOLETO (admin mode) */
    isAdmin?: boolean;
    /** Release boleto for this checkout (per-contract authorization) */
    allowBoleto?: boolean;
    /** Checkout context for per-method visibility: avulso | contract | invoice */
    context?: string;
    /**
     * Admin cobrando um CLIENTE: o gate de CPF (PIX/Boleto) e a coleta usam o CPF do CLIENTE
     * selecionado, não o do admin logado (useAuth). O backend já cobra o payment.userId (cliente).
     */
    chargeClient?: { id: string; name?: string | null; cpfCnpj?: string | null };
    /**
     * Cria o Payment sob demanda (ex.: reserva avulsa criada só na 1ª escolha de método).
     * Basta devolver `{ paymentId }`: a cobrança em si (QR PIX, PaymentIntent do cartão) é SEMPRE
     * emitida aqui via /stripe/create-payment. Os demais campos são legado: `clientSecret`
     * (PaymentIntent já criado) e `boletoUrl/barcode` ainda são aceitos; `pixString/qrCodeBase64`
     * são ignorados (o PIX vem do create-payment, com validade e reaproveitamento da cobrança viva).
     */
    createPaymentFn?: (method: 'CARTAO' | 'PIX' | 'BOLETO') => Promise<{
        paymentId: string;
        clientSecret?: string;
        pixString?: string;
        qrCodeBase64?: string;
        boletoUrl?: string;
        barcode?: string;
        paymentIntentId?: string;
    }>;
}

type ActiveTab = 'CARTAO' | 'PIX' | 'BOLETO';

/** Cobrança PIX exibida (resposta do /stripe/create-payment). */
interface PixCharge {
    pixString: string;
    qrCodeDataUrl: string | null;
    expiresAt: string | null;
    amount: number | null;
}

type InstallmentPlan = { count: number; perInstallment: number; total: number; feePercent: number; freeOfCharge: boolean };

const MAX_POLL_ATTEMPTS = 180; // 15 min (180 × 5s) — boleto e PIX sem validade conhecida
const MAX_CONSECUTIVE_ERRORS = 5; // ~25s de falhas seguidas → avisa em vez de pollar calado
/** PIX pago no limite da validade: ainda confere o status uma vez depois de expirar. */
const PIX_FINAL_CHECK_MS = 4000;

// ─── Component ──────────────────────────────────────────

export default function InlineCheckout({
    amount,
    paymentId: externalPaymentId,
    description,
    contractDuration,
    initialInstallments,
    onSuccess,
    onError,
    onCancel,
    allowedMethods = ['CARTAO', 'PIX'],
    initialMethod,
    isAdmin = false,
    allowBoleto = false,
    context,
    chargeClient,
    createPaymentFn,
}: InlineCheckoutProps) {
    const allMethods = isAdmin ? getPaymentMethods() : getClientPaymentMethods();
    const ctxMethods = allMethods.filter(m =>
        allowedMethods.includes(m.key) && (!context || methodInContext(m, context))
    );
    // Safety: never leave the checkout with zero methods (e.g. admin hid all from this context).
    let availableMethods = ctxMethods.length > 0
        ? ctxMethods
        : allMethods.filter(m => allowedMethods.includes(m.key));
    // Per-contract boleto release: surface boleto regardless of the global client
    // hiding or context CSV — its authority is the contract's boletoAllowed flag,
    // which the server enforces on /create-payment.
    if (allowBoleto && allowedMethods.includes('BOLETO') && !availableMethods.some(m => m.key === 'BOLETO')) {
        availableMethods = [...availableMethods, getBoletoMethodConfig()];
    }
    const [activeTab, setActiveTab] = useState<ActiveTab>(() => {
        const preferred = initialMethod ? availableMethods.find(m => m.key === initialMethod) : undefined;
        return ((preferred ?? availableMethods[0])?.key as ActiveTab) || 'CARTAO';
    });

    // Shared state
    const [processing, setProcessing] = useState(false);
    const [error, setError] = useState('');

    // Card state
    const [clientSecret, setClientSecret] = useState<string | null>(null);
    // Valor do PaymentIntent do cartão novo (create-payment devolve `amount` = chargedAmount): com o PI
    // criado, é ESTE o valor exibido no formulário — valor exibido = valor cobrado (D1).
    const [cardChargedAmount, setCardChargedAmount] = useState<number | null>(null);
    const [paymentIntentId, setPaymentIntentId] = useState<string | null>(null);
    const [paymentId, setPaymentId] = useState<string | null>(externalPaymentId || null);
    const [paymentType, setPaymentType] = useState<'CREDIT' | 'DEBIT'>('CREDIT');
    const [installments, setInstallments] = useState(() =>
        initialInstallments && initialInstallments > 1 ? Math.min(12, Math.floor(initialInstallments)) : 1);
    const [installmentPlans, setInstallmentPlans] = useState<InstallmentPlan[]>([]);
    // Parcelas em carregamento: o botão do cartão espera — senão um N pré-selecionado (initialInstallments)
    // ainda não conferido com a política/gateway iria ao servidor e seria recusado.
    const cardAvailable = availableMethods.some(m => m.key === 'CARTAO');
    const [plansLoading, setPlansLoading] = useState(() => cardAvailable && amount > 0);
    const [wantSaveCard, setWantSaveCard] = useState(true);

    // Saved cards state
    const [savedCards, setSavedCards] = useState<SavedCard[]>([]);
    const [selectedCard, setSelectedCard] = useState<string | null>('new');
    const [loadingCards, setLoadingCards] = useState(true);
    const [payingSavedCard, setPayingSavedCard] = useState(false);

    // PIX state
    const [pix, setPix] = useState<PixCharge | null>(null);
    const [pixExpired, setPixExpired] = useState(false);
    const [pixRegenerating, setPixRegenerating] = useState(false);
    // Boleto state (per-contract release)
    const [boletoUrl, setBoletoUrl] = useState<string | null>(null);
    const [boletoBarcode, setBoletoBarcode] = useState<string | null>(null);
    const [boletoCopied, setBoletoCopied] = useState(false);
    const pollIntervalRef = useRef<number | null>(null);
    const finalCheckRef = useRef<number | null>(null);
    // PAY-H1 FIX: Prevent double-init from rapid clicks (trava por requisição em voo, nunca por tempo)
    const initGuardRef = useRef(false);
    const regenInFlightRef = useRef(false);
    const pixExpiredRef = useRef(false);
    // onSuccess dispara UMA vez (polling, simulação e "já pago" podem concorrer).
    const succeededRef = useRef(false);
    const mountedRef = useRef(true);
    // Callbacks do pai em ref: o polling (setInterval) e os fluxos assíncronos sempre chamam a versão
    // ATUAL — ex.: o onSuccess do avulso lê o bookingId criado depois que o polling começou.
    const onSuccessRef = useRef(onSuccess);
    onSuccessRef.current = onSuccess;
    const onErrorRef = useRef(onError);
    onErrorRef.current = onError;
    /** Erro do polling: aparece no próprio checkout E vai ao pai (toast/alerta de quem usa). */
    const reportError = useCallback((msg: string) => {
        if (mountedRef.current) setError(msg);
        onErrorRef.current(msg);
    }, []);
    // PIX requires a CPF/CNPJ on file (Cora invoice). Gate the charge behind an
    // inline collection step when the user has no valid document.
    const { user } = useAuth();
    // Documento salvo AGORA pelo prompt (o prop `chargeClient` vem da lista de users e não é
    // recarregado após salvar) — assim o gate/coleta não re-perguntam num retry na mesma cobrança.
    const [savedClientDoc, setSavedClientDoc] = useState<string | null>(null);
    // Admin cobrando um cliente → o documento é do CLIENTE selecionado; senão, o do próprio usuário
    // logado (cliente pagando o seu). Antes usava sempre `user` (o admin), pedindo/gravando o CPF errado.
    const cpfOwnerDoc = savedClientDoc ?? (chargeClient ? chargeClient.cpfCnpj : user?.cpfCnpj);
    const [needsCpf, setNeedsCpf] = useState(false);
    // Sandbox testing: when PIX is in sandbox, offer a "simulate payment" button
    const [pixSandbox, setPixSandbox] = useState(false);
    const [simulating, setSimulating] = useState(false);

    // O pai pode passar o paymentId depois da montagem (ex.: criado num passo anterior).
    useEffect(() => {
        if (externalPaymentId) setPaymentId(externalPaymentId);
    }, [externalPaymentId]);

    useEffect(() => {
        paymentsApi.getSandboxMode().then(m => setPixSandbox(!!m.pix)).catch(() => {});
    }, []);

    const stopPolling = useCallback(() => {
        if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current);
            pollIntervalRef.current = null;
        }
    }, []);

    const clearFinalCheck = useCallback(() => {
        if (finalCheckRef.current) {
            clearTimeout(finalCheckRef.current);
            finalCheckRef.current = null;
        }
    }, []);

    // Cleanup polling on unmount
    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            stopPolling();
            clearFinalCheck();
        };
    }, [stopPolling, clearFinalCheck]);

    const fireSuccess = useCallback(() => {
        if (succeededRef.current) return;
        succeededRef.current = true;
        stopPolling();
        clearFinalCheck();
        onSuccessRef.current();
    }, [stopPolling, clearFinalCheck]);

    /** Depois de um erro, confere se a cobrança já consta PAGA (ex.: PIX pago antes de trocar de método). */
    const isAlreadyPaid = useCallback(async (pid: string | null | undefined) => {
        if (!pid) return false;
        try {
            const s = await paymentsApi.getStatus(pid);
            return s.status === 'PAID';
        } catch {
            return false;
        }
    }, []);

    const simulatePayment = useCallback(async () => {
        if (!paymentId || simulating) return;
        setSimulating(true);
        try {
            const res = await paymentsApi.simulate(paymentId);
            if (res.status === 'PAID') {
                fireSuccess();
            } else {
                setSimulating(false);
            }
        } catch {
            setSimulating(false);
        }
    }, [paymentId, simulating, fireSuccess]);

    // F5: the per-installment figure shown in the summary/pay button must match the chosen
    // plan (which already includes juros). The naive `amount / installments` understates it
    // whenever the selected plan carries interest — use the backend plan's perInstallment.
    const selectedPlan = installmentPlans.find(p => p.count === installments);
    // D1: o cartão cobra o valor do plano 1x que o SERVIDOR calcula (sem o desconto PIX do à vista);
    // sem a política ainda (carregando/falhou), a melhor prévia é o próprio `amount`.
    const oneXPlan = installmentPlans.find(p => p.count === 1);
    const cardBaseAmount = oneXPlan ? oneXPlan.total : amount;
    const newCardCharged = selectedCard === 'new' && clientSecret && cardChargedAmount != null ? cardChargedAmount : null;
    const cardTotal = newCardCharged ?? (installments > 1 && selectedPlan ? selectedPlan.total : cardBaseAmount);
    const cardPriceLoading = plansLoading && !oneXPlan;
    // Rótulos dos botões do cartão (1x): nunca o valor do PIX enquanto a política carrega.
    const cardAmountText = cardPriceLoading ? 'calculando…' : formatBRL(newCardCharged ?? cardBaseAmount);
    /** O "à vista" desta cobrança tem desconto PIX: no cartão o valor é maior (avisar antes de pagar). */
    const pixOnlyDiscount = cardAvailable && !!oneXPlan && oneXPlan.total > amount;
    const pixAvailable = availableMethods.some(m => m.key === 'PIX');
    const perInstallmentValue = selectedPlan ? selectedPlan.perInstallment : Math.ceil(cardBaseAmount / installments);
    const headerAmount = activeTab === 'CARTAO' ? cardTotal : (activeTab === 'PIX' && pix?.amount != null ? pix.amount : amount);
    const showInstallmentSelect = paymentType === 'CREDIT' && installmentPlans.length > 1;
    // O pai pediu N× (ex.: serviço "parcelar o total em até N×"), mas a política/gateway oferece menos
    // (conta Stripe BR não parcela): avisa em vez de trocar o nº de parcelas em silêncio.
    const maxPlanCount = installmentPlans.reduce((max, p) => Math.max(max, p.count), 0);
    const requestedInstallmentsUnavailable = paymentType === 'CREDIT' && !plansLoading
        && !!initialInstallments && initialInstallments > 1 && maxPlanCount > 0 && maxPlanCount < initialInstallments;

    // Saved cards: carregados ao abrir a aba Cartão. (Separado das parcelas: antes, a chegada do
    // paymentId — ex.: reserva avulsa criada no "Continuar" — recarregava a lista e trocava o cartão
    // escolhido pelo padrão, escondendo o formulário do cartão novo no meio do fluxo.)
    useEffect(() => {
        if (activeTab !== 'CARTAO') return;
        let alive = true;
        setLoadingCards(true);
        stripeApi.listPaymentMethods()
            .then(res => {
                if (!alive) return;
                const methods = res.paymentMethods || [];
                setSavedCards(methods);
                // Auto-select the default card, or 'new' if none
                const defaultCard = methods.find(c => c.isDefault);
                setSelectedCard(defaultCard ? defaultCard.stripePaymentMethodId : 'new');
            })
            .catch(() => { if (alive) setSavedCards([]); })
            .finally(() => { if (alive) setLoadingCards(false); });
        return () => { alive = false; };
    }, [activeTab]);

    // Parcelas: a política REAL vem do backend (/stripe/installment-plans com o paymentId — inclui o
    // teto do serviço: mensal parcelado = 1..N sem juros, à vista = só 1x; avulso/à vista de contrato
    // = regra própria). Sem paymentId ainda (rascunho), usa o valor + a duração como prévia.
    // Sem parcelamento no gateway (conta Stripe BR) o backend devolve só 1x — o N pré-selecionado cai para 1.
    // Carrega sempre que o cartão está disponível (não só na aba Cartão): o plano 1x é o valor do cartão.
    useEffect(() => {
        if (!cardAvailable || amount <= 0) return;
        let alive = true;
        setPlansLoading(true);
        stripeApi.getInstallmentPlans({ paymentId: paymentId || undefined, amount, contractDurationMonths: contractDuration })
            .then(res => { if (alive) setInstallmentPlans(res.plans); })
            // Sem a política (falha de rede): 1x, que toda política aceita — um N pré-selecionado sem seletor
            // para trocá-lo seria recusado pelo servidor a cada tentativa.
            .catch(() => { if (alive) setInstallments(1); })
            .finally(() => { if (alive) setPlansLoading(false); });
        return () => { alive = false; setPlansLoading(false); };
    }, [cardAvailable, amount, contractDuration, paymentId]);

    // A escolha precisa existir na política atual (ex.: teto do serviço chegou com o paymentId).
    useEffect(() => {
        if (installmentPlans.length === 0) return;
        if (installmentPlans.some(p => p.count === installments)) return;
        const fallback = installmentPlans.filter(p => p.count <= installments).pop()?.count ?? 1;
        setInstallments(fallback);
        setClientSecret(null);
        setPaymentIntentId(null);
    }, [installmentPlans, installments]);

    // ─── Polling ─────────────────────────────────────────

    /**
     * Consulta o status a cada 5s. PIX: FAILED (cobrança expirada/cancelada no provedor) vira o
     * estado "QR expirado — gerar novo" (sem onError, que derrubaria o wizard do pai); com validade
     * conhecida o polling acompanha a contagem (pausa ao expirar). Boleto mantém o limite de 15 min.
     */
    const startPolling = useCallback((pid: string, kind: 'PIX' | 'BOLETO', pixDeadlineMs?: number | null) => {
        stopPolling();
        let attempts = 0;
        let consecutiveErrors = 0;
        pollIntervalRef.current = window.setInterval(async () => {
            attempts++;
            if (kind === 'PIX' && pixDeadlineMs) {
                // Rede de segurança: a pausa normal vem do onExpire do PixQrCode.
                if (Date.now() > pixDeadlineMs + PIX_FINAL_CHECK_MS * 2) {
                    stopPolling();
                    pixExpiredRef.current = true;
                    setPixExpired(true);
                    return;
                }
            } else if (attempts >= MAX_POLL_ATTEMPTS) {
                stopPolling();
                if (kind === 'PIX') {
                    pixExpiredRef.current = true;
                    setPixExpired(true);
                } else {
                    reportError('Tempo de espera expirado. Verifique o status do seu pagamento.');
                }
                return;
            }
            try {
                const res = await paymentsApi.getStatus(pid);
                consecutiveErrors = 0; // a successful read clears the error streak
                if (res.status === 'PAID') {
                    fireSuccess();
                } else if (res.status === 'FAILED') {
                    stopPolling();
                    if (kind === 'PIX') {
                        pixExpiredRef.current = true;
                        setPixExpired(true);
                    } else {
                        reportError('Pagamento falhou. Tente novamente.');
                    }
                } else if (res.status === 'CANCELLED') {
                    // The installment was voided (e.g. its contract was cancelled) — stop polling
                    // instead of waiting out the full 15 min for a payment that can never land.
                    stopPolling();
                    reportError('Esta cobrança foi cancelada (contrato encerrado).');
                }
            } catch (err) {
                // Don't swallow status-check failures silently: after a few consecutive errors
                // (e.g. the user's connection dropped) stop and tell them, instead of polling
                // uselessly for 15 minutes.
                consecutiveErrors++;
                console.error('[Payment Polling] status check failed:', err);
                if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                    stopPolling();
                    reportError('Não foi possível verificar o pagamento (conexão instável). Verifique em "Meus Pagamentos".');
                }
            }
        }, 5000);
    }, [stopPolling, fireSuccess, reportError]);

    // ─── CARD ───────────────────────────────────────────

    const initCardPayment = async () => {
        if (initGuardRef.current) return;
        initGuardRef.current = true;
        setProcessing(true);
        setError('');
        let pid = paymentId;
        try {
            // Saved card: charge directly
            if (selectedCard && selectedCard !== 'new') {
                setPayingSavedCard(true);
                if (createPaymentFn) {
                    const result = await createPaymentFn('CARTAO');
                    pid = result.paymentId;
                    setPaymentId(pid);
                }
                if (pid) {
                    const result = await stripeApi.createPayment({
                        paymentId: pid,
                        installments,
                        paymentMethod: 'cartao',
                        savedPaymentMethodId: selectedCard,
                    });
                    setPaymentIntentId(result.paymentIntentId || null);
                    // Verify payment was actually processed by Stripe
                    if (result.paymentIntentId && pid) {
                        const verifyResult = await stripeApi.verifyPayment({ paymentId: pid, paymentIntentId: result.paymentIntentId });
                        if (verifyResult.status !== 'PAID') {
                            throw new Error('Pagamento não confirmado pelo Stripe.');
                        }
                    }
                    setPayingSavedCard(false);
                    fireSuccess();
                    return;
                }
                setPayingSavedCard(false);
            }

            // New card flow: get clientSecret to show PaymentElement
            if (createPaymentFn) {
                const result = await createPaymentFn('CARTAO');
                pid = result.paymentId;
                setPaymentId(pid);
                if (result.clientSecret) {
                    // Legacy: the caller already created a PaymentIntent.
                    setCardChargedAmount(null);
                    setClientSecret(result.clientSecret);
                    setPaymentIntentId(result.paymentIntentId || null);
                } else if (pid) {
                    // createPaymentFn só criou o Payment — cria o PaymentIntent AGORA com as parcelas
                    // escolhidas (a política única aplica o teto/juros).
                    const card = await stripeApi.createPayment({
                        paymentId: pid,
                        installments,
                        paymentMethod: 'cartao',
                        savePaymentMethod: wantSaveCard,
                    });
                    setCardChargedAmount(typeof card.amount === 'number' ? card.amount : null);
                    setClientSecret(card.clientSecret || null);
                    setPaymentIntentId(card.paymentIntentId || null);
                }
            } else if (pid) {
                const result = await stripeApi.createPayment({
                    paymentId: pid,
                    installments,
                    paymentMethod: 'cartao',
                    savePaymentMethod: wantSaveCard,
                });
                setCardChargedAmount(typeof result.amount === 'number' ? result.amount : null);
                setClientSecret(result.clientSecret || null);
                setPaymentIntentId(result.paymentIntentId || null);
            }
        } catch (err: unknown) {
            setPayingSavedCard(false);
            // Ex.: "Este pagamento já foi confirmado via PIX." — a cobrança já está paga: é sucesso.
            if (await isAlreadyPaid(pid)) {
                fireSuccess();
                return;
            }
            const msg = getErrorMessage(err) || 'Erro ao iniciar pagamento com cartão.';
            setError(msg);
            onErrorRef.current(msg);
        } finally {
            if (mountedRef.current) setProcessing(false);
            initGuardRef.current = false;
        }
    };

    const handleCardSuccess = async () => {
        try {
            if (paymentId && paymentIntentId) {
                await stripeApi.verifyPayment({ paymentId, paymentIntentId });
            }
            fireSuccess();
        } catch {
            // Verify failed — payment may not have been processed
            onErrorRef.current('Pagamento não pôde ser verificado. Verifique seu extrato antes de tentar novamente.');
        }
    };

    // ─── PIX ────────────────────────────────────────────

    /**
     * Emite (ou reaproveita) a cobrança PIX pelo /stripe/create-payment — fonte única (D15).
     * O backend devolve o QR pronto, a validade e o valor; `alreadyPaid` (a cobrança anterior já
     * constava paga no provedor) é sucesso.
     */
    const emitPix = async (pid: string) => {
        const r = await stripeApi.createPayment({ paymentId: pid, paymentMethod: 'pix' });
        if (r.alreadyPaid || r.status === 'PAID') {
            fireSuccess();
            return;
        }
        if (!r.pixString) {
            throw new Error('Não foi possível gerar o código PIX. Tente novamente ou use outro método.');
        }
        if (!mountedRef.current) return;
        clearFinalCheck();
        pixExpiredRef.current = false;
        setPixExpired(false);
        setPix({
            pixString: r.pixString,
            qrCodeDataUrl: r.qrCodeDataUrl || r.qrCodeBase64 || null,
            expiresAt: r.expiresAt ?? null,
            amount: typeof r.amount === 'number' ? r.amount : null,
        });
        const deadline = r.expiresAt ? new Date(r.expiresAt).getTime() : NaN;
        startPolling(pid, 'PIX', Number.isFinite(deadline) ? deadline : null);
    };

    // Gate: PIX needs a valid CPF/CNPJ. If absent, show the inline collection
    // step instead of round-tripping to the server only to fail.
    const initPixPayment = () => {
        if (!isValidCpfCnpj(cpfOwnerDoc)) {
            setNeedsCpf(true);
            return;
        }
        proceedPix();
    };

    const proceedPix = async () => {
        if (initGuardRef.current) return;
        initGuardRef.current = true;
        setProcessing(true);
        setError('');
        let pid = paymentId;
        try {
            // createPaymentFn (ex.: avulso) só cria o Payment e devolve { paymentId }.
            if (createPaymentFn) {
                const result = await createPaymentFn('PIX');
                pid = result.paymentId;
                setPaymentId(pid);
            }
            if (!pid) throw new Error('Não foi possível gerar o código PIX. Tente novamente ou use outro método.');
            await emitPix(pid);
        } catch (err: unknown) {
            if (await isAlreadyPaid(pid)) {
                fireSuccess();
                return;
            }
            const msg = getErrorMessage(err) || 'Erro ao gerar PIX.';
            setError(msg);
            onErrorRef.current(msg);
        } finally {
            if (mountedRef.current) setProcessing(false);
            initGuardRef.current = false;
        }
    };

    /** "Gerar novo QR": nova chamada ao create-payment (concilia/cancela a antiga) + polling do zero. */
    const regeneratePix = async () => {
        const pid = paymentId;
        if (!pid || regenInFlightRef.current) return;
        regenInFlightRef.current = true;
        setPixRegenerating(true);
        setError('');
        try {
            await emitPix(pid);
        } catch (err: unknown) {
            if (await isAlreadyPaid(pid)) {
                fireSuccess();
                return;
            }
            // Erro fica no checkout (sem onError): o QR continua "expirado" e dá para tentar de novo.
            if (mountedRef.current) setError(getErrorMessage(err) || 'Não foi possível gerar um novo QR. Tente novamente.');
        } finally {
            regenInFlightRef.current = false;
            if (mountedRef.current) setPixRegenerating(false);
        }
    };

    /** A contagem do QR zerou: pausa o polling e faz uma última conferência (pago no limite). */
    const handlePixExpire = useCallback(() => {
        stopPolling();
        if (pixExpiredRef.current) return;
        pixExpiredRef.current = true;
        setPixExpired(true);
        const pid = paymentId;
        if (!pid) return;
        clearFinalCheck();
        finalCheckRef.current = window.setTimeout(async () => {
            finalCheckRef.current = null;
            try {
                const s = await paymentsApi.getStatus(pid);
                if (s.status === 'PAID') fireSuccess();
            } catch { /* sem rede: o "Gerar novo QR" concilia a cobrança anterior */ }
        }, PIX_FINAL_CHECK_MS);
    }, [paymentId, stopPolling, clearFinalCheck, fireSuccess]);

    // ─── BOLETO ─────────────────────────────────────────

    // Boleto (Cora) also needs a CPF/CNPJ on file — same gate as PIX.
    const initBoletoPayment = () => {
        if (!isValidCpfCnpj(cpfOwnerDoc)) {
            setNeedsCpf(true);
            return;
        }
        proceedBoleto();
    };

    const proceedBoleto = async () => {
        if (initGuardRef.current) return;
        initGuardRef.current = true;
        setProcessing(true);
        setError('');
        let pid = paymentId;
        try {
            if (createPaymentFn) {
                const result = await createPaymentFn('BOLETO');
                pid = result.paymentId;
                setPaymentId(pid);
                if (result.boletoUrl) {
                    setBoletoUrl(result.boletoUrl);
                    if (result.barcode) setBoletoBarcode(result.barcode);
                    startPolling(pid, 'BOLETO');
                    return;
                }
            }
            if (!pid) throw new Error('Não foi possível gerar o boleto. Tente novamente ou use outro método.');
            const result = await stripeApi.createPayment({ paymentId: pid, paymentMethod: 'boleto' });
            // Guard: without a boleto URL there is nothing to pay — surface an error
            // instead of polling silently in the background.
            if (!result.boletoUrl) {
                throw new Error('Não foi possível gerar o boleto. Tente novamente ou use outro método.');
            }
            setBoletoUrl(result.boletoUrl);
            if (result.barcode) setBoletoBarcode(result.barcode);
            startPolling(pid, 'BOLETO');
        } catch (err: unknown) {
            if (await isAlreadyPaid(pid)) {
                fireSuccess();
                return;
            }
            const msg = getErrorMessage(err) || 'Erro ao gerar boleto.';
            setError(msg);
            onErrorRef.current(msg);
        } finally {
            if (mountedRef.current) setProcessing(false);
            initGuardRef.current = false;
        }
    };

    const copyBoletoBarcode = () => {
        if (boletoBarcode) {
            navigator.clipboard.writeText(boletoBarcode);
            setBoletoCopied(true);
            setTimeout(() => setBoletoCopied(false), 3000);
        }
    };

    // ─── Tabs ───────────────────────────────────────────

    const switchTab = (key: ActiveTab) => {
        if (key === activeTab) return;
        setActiveTab(key);
        setError('');
        setNeedsCpf(false);
        stopPolling();
        clearFinalCheck();
        // Saiu do PIX: descarta o QR exibido (a troca para cartão aposenta a cobrança no backend).
        // Voltando, "Gerar PIX" reaproveita a cobrança viva ou emite outra — nunca mostra QR morto.
        setPix(null);
        pixExpiredRef.current = false;
        setPixExpired(false);
        if (key !== 'CARTAO') {
            setClientSecret(null);
            setPaymentIntentId(null);
        }
        // Boleto já emitido: volta a acompanhar a compensação.
        if (key === 'BOLETO' && boletoUrl && paymentId) startPolling(paymentId, 'BOLETO');
    };

    // ─── Render ──────────────────────────────────────────

    return (
        <div style={{ width: '100%' }}>
            {/* Security Badge */}
            <div className="checkout-security-top">
                <ShieldCheck size={14} />
                Pagamento seguro - Criptografia SSL
            </div>

            {/* Amount Header */}
            <div className="checkout-amount">
                <div className="checkout-amount-label">
                    {activeTab === 'CARTAO' && pixOnlyDiscount ? 'Total no Cartão' : activeTab === 'PIX' && pixOnlyDiscount ? 'Total no PIX' : 'Total a Pagar'}
                </div>
                <div className="checkout-amount-value" aria-busy={activeTab === 'CARTAO' && cardPriceLoading ? true : undefined}>
                    {activeTab === 'CARTAO' && cardPriceLoading ? 'Calculando…' : formatBRL(headerAmount)}
                </div>
                <div className="checkout-amount-desc">{description}</div>
            </div>

            {/* D1: desconto do à vista só no PIX — o cliente vê o preço real do cartão antes de escolher. */}
            {pixOnlyDiscount && (
                <p className="checkout-installment-hint" role="note">
                    <Info size={14} aria-hidden="true" />
                    <span>
                        {pixAvailable
                            ? <>O desconto à vista vale só no PIX ({formatBRL(amount)}). <strong>No cartão, o valor é {formatBRL(cardBaseAmount)}.</strong></>
                            : <>No cartão, o valor é <strong>{formatBRL(cardBaseAmount)}</strong> (o desconto à vista vale só no PIX).</>}
                    </span>
                </p>
            )}

            {/* Tab Navigation */}
            {availableMethods.length > 1 && (
                <div className="checkout-tabs">
                    {availableMethods.filter(m => m.key === 'CARTAO' || m.key === 'PIX' || m.key === 'BOLETO').map(pm => {
                        const isActive = activeTab === pm.key;
                        const tabClass = pm.key === 'PIX' ? 'checkout-tab--pix' : pm.key === 'BOLETO' ? 'checkout-tab--boleto' : 'checkout-tab--card';
                        return (
                            <button
                                key={pm.key}
                                type="button"
                                onClick={() => switchTab(pm.key as ActiveTab)}
                                aria-pressed={isActive}
                                className={`checkout-tab ${tabClass} ${isActive ? 'checkout-tab--active' : ''}`}
                            >
                                {pm.key === 'CARTAO' ? <CreditCard size={16} /> : pm.key === 'BOLETO' ? <FileText size={16} /> : <QrCode size={16} />}
                                {pm.key === 'CARTAO' ? 'Cartão' : pm.key === 'BOLETO' ? 'Boleto' : 'PIX'}
                            </button>
                        );
                    })}
                </div>
            )}

            {/* Error */}
            {error && <div className="checkout-error" role="alert">{error}</div>}

            {/* ═══════ TAB: CARTAO ═══════ */}
            {activeTab === 'CARTAO' && (
                <div>
                    {/* Step 1: Card Type */}
                    <div className="checkout-section-label">Tipo de cartão</div>
                    <div className="checkout-type-toggle">
                        {(['CREDIT', 'DEBIT'] as const).map(type => (
                            <button
                                key={type}
                                type="button"
                                aria-pressed={paymentType === type}
                                onClick={() => {
                                    setPaymentType(type);
                                    if (type === 'DEBIT') setInstallments(1);
                                    setSelectedCard('new');
                                    setClientSecret(null);
                                }}
                                className={`checkout-type-btn ${paymentType === type ? 'checkout-type-btn--active' : ''}`}
                            >
                                <CreditCard size={16} />
                                {type === 'CREDIT' ? 'Crédito' : 'Débito'}
                            </button>
                        ))}
                    </div>

                    {/* Step 2: Installments (credit only, dropdown) — só quando a política oferece mais de 1x */}
                    {showInstallmentSelect && (
                        <>
                            <div className="checkout-section-label">Parcelamento</div>
                            <select
                                aria-label="Parcelamento"
                                value={installments}
                                onChange={(e) => {
                                    setInstallments(Number(e.target.value));
                                    // O PaymentIntent do cartão novo foi criado com o nº anterior: refaz no próximo "Continuar".
                                    setClientSecret(null);
                                    setPaymentIntentId(null);
                                }}
                                className="checkout-installment-select"
                            >
                                {installmentPlans.map(plan => (
                                    <option key={plan.count} value={plan.count}>
                                        {plan.count}x de {formatBRL(plan.perInstallment)}
                                        {plan.freeOfCharge ? ' (sem juros)' : plan.feePercent > 0 ? ` (${plan.feePercent}% juros)` : ''}
                                        {' — Total: '}{formatBRL(plan.total)}
                                    </option>
                                ))}
                            </select>
                        </>
                    )}
                    {requestedInstallmentsUnavailable && (
                        <p className="checkout-installment-hint" role="note">
                            <Info size={14} aria-hidden="true" />
                            <span>
                                O parcelamento em <strong>{initialInstallments}x</strong> não está disponível no cartão no momento:
                                {maxPlanCount > 1
                                    ? <> escolha até <strong>{maxPlanCount}x</strong>.</>
                                    : <> o total é cobrado em <strong>1x</strong>.</>}
                            </span>
                        </p>
                    )}

                    {/* Step 3: Filtered Saved Cards + New Card */}
                    {loadingCards ? (
                        <div className="checkout-cards-loading">
                            <span className="spinner" style={{ width: 16, height: 16 }} />
                            Carregando cartões...
                        </div>
                    ) : (() => {
                        // Show all saved cards in both tabs — Brazilian cards often report 'credit'
                        // funding even when they support both credit and debit transactions
                        const filteredCards = savedCards;
                        return (
                            <>
                                {filteredCards.length > 0 && (
                                    <>
                                        <div className="checkout-section-label">
                                            {paymentType === 'CREDIT' ? 'Cartões de crédito' : 'Cartões de débito'}
                                        </div>
                                        <div className="checkout-saved-cards">
                                            {filteredCards.map(card => (
                                                <button
                                                    key={card.stripePaymentMethodId}
                                                    type="button"
                                                    aria-pressed={selectedCard === card.stripePaymentMethodId}
                                                    onClick={() => { setSelectedCard(card.stripePaymentMethodId); setClientSecret(null); }}
                                                    className={`checkout-saved-card ${selectedCard === card.stripePaymentMethodId ? 'checkout-saved-card--active' : ''}`}
                                                    style={card.isDefault ? { borderColor: 'rgba(16, 185, 129, 0.5)', background: 'rgba(16, 185, 129, 0.06)' } : undefined}
                                                >
                                                    <div className="checkout-saved-card-info">
                                                        <span className="checkout-saved-card-brand">{getBrandIcon(card.brand)}</span>
                                                        <span className="checkout-saved-card-number">{'****'} {card.last4}</span>
                                                        <span className="checkout-saved-card-exp">{String(card.expMonth).padStart(2, '0')}/{String(card.expYear).slice(-2)}</span>
                                                        {card.isDefault ? (
                                                            <span style={{
                                                                fontSize: '0.6rem', fontWeight: 800, letterSpacing: '0.04em',
                                                                background: 'linear-gradient(135deg, #10b981, #059669)',
                                                                color: '#fff', padding: '2px 7px', borderRadius: '6px',
                                                            }}>PADRÃO</span>
                                                        ) : (
                                                            <span className={`checkout-saved-card-funding checkout-saved-card-funding--${card.funding}`}>
                                                                {card.funding === 'credit' ? 'Crédito' : 'Débito'}
                                                            </span>
                                                        )}
                                                    </div>
                                                    <div className={`checkout-saved-card-radio ${selectedCard === card.stripePaymentMethodId ? 'checkout-saved-card-radio--active' : ''}`}>
                                                        {selectedCard === card.stripePaymentMethodId && <Check size={12} />}
                                                    </div>
                                                </button>
                                            ))}
                                        </div>
                                    </>
                                )}

                                {/* New Card Option */}
                                <div className="checkout-saved-cards" style={filteredCards.length > 0 ? { marginTop: 0 } : undefined}>
                                    <button
                                        type="button"
                                        aria-pressed={selectedCard === 'new'}
                                        onClick={() => { setSelectedCard('new'); setClientSecret(null); setError(''); initGuardRef.current = false; }}
                                        className={`checkout-saved-card checkout-saved-card--new ${selectedCard === 'new' ? 'checkout-saved-card--active' : ''}`}
                                    >
                                        <div className="checkout-saved-card-info">
                                            <span className="checkout-saved-card-brand"><Plus size={16} /></span>
                                            <span className="checkout-saved-card-number">
                                                {filteredCards.length > 0 ? 'Usar outro cartão' : `Cadastrar cartão de ${paymentType === 'CREDIT' ? 'crédito' : 'débito'}`}
                                            </span>
                                        </div>
                                        <div className={`checkout-saved-card-radio ${selectedCard === 'new' ? 'checkout-saved-card-radio--active' : ''}`}>
                                            {selectedCard === 'new' && <Check size={12} />}
                                        </div>
                                    </button>
                                </div>
                            </>
                        );
                    })()}

                    {/* Inline Stripe Form (when "new" selected and clientSecret ready) */}
                    {selectedCard === 'new' && clientSecret && (
                        <div className="checkout-inline-form">
                            <div className="checkout-stripe-summary">
                                <span className="checkout-stripe-summary-label">
                                    <CreditCard size={14} />
                                    {paymentType === 'DEBIT' ? 'Débito' : `Crédito ${installments > 1 ? `${installments}x` : ''}`}
                                </span>
                                <span className="checkout-stripe-summary-value">
                                    {installments > 1 ? `${installments}x ${formatBRL(perInstallmentValue)}` : cardAmountText}
                                </span>
                            </div>
                            {/* Cartão NOVO sai sempre em 1x: o backend recusa N > 1 sem plano fixado no servidor
                                (pagamentos-1) e o PaymentIntent não habilita o seletor de parcelas do Stripe. */}
                            <StripeCardForm
                                mode="payment"
                                clientSecret={clientSecret}
                                onSuccess={handleCardSuccess}
                                onError={(msg) => { setError(msg); setClientSecret(null); }}
                                onCancel={() => setClientSecret(null)}
                                submitLabel={installments > 1
                                    ? `Pagar ${installments}x ${formatBRL(perInstallmentValue)}`
                                    : `Pagar ${cardAmountText}`
                                }
                                showSaveCard={true}
                                onSaveCardChange={(save) => setWantSaveCard(save)}
                            />
                        </div>
                    )}

                    {/* Pay Button (saved card or initiate new card flow) */}
                    {!(selectedCard === 'new' && clientSecret) && (
                        <button
                            key="card-go"
                            type="button"
                            // 2º clique de um clique duplo ignorado (teclado: detail 0 segue funcionando).
                            onClick={(e) => { if (e.detail > 1) return; initCardPayment(); }}
                            disabled={processing || payingSavedCard || (paymentType === 'CREDIT' && plansLoading)}
                            className="checkout-pay-btn checkout-pay-btn--card"
                        >
                            {processing || payingSavedCard ? (
                                <><span className="spinner" style={{ width: 16, height: 16 }} /> {payingSavedCard ? 'Processando...' : 'Preparando...'}</>
                            ) : (
                                <>
                                    <Lock size={14} />
                                    {selectedCard && selectedCard !== 'new'
                                        ? `Pagar com **** ${savedCards.find(c => c.stripePaymentMethodId === selectedCard)?.last4 || ''} - ${
                                            installments > 1 ? `${installments}x ${formatBRL(perInstallmentValue)}` : cardAmountText
                                        }`
                                        : selectedCard === 'new'
                                            ? 'Continuar com novo cartão'
                                            : `Pagar ${cardAmountText}`
                                    }
                                </>
                            )}
                        </button>
                    )}
                </div>
            )}

            {/* ═══════ TAB: PIX ═══════ */}
            {activeTab === 'PIX' && (
                <div>
                    {!pix ? (
                        needsCpf ? (
                            <CpfCnpjPrompt
                                client={chargeClient}
                                saveLabel={`Salvar e gerar PIX - ${formatBRL(amount)}`}
                                onSaved={(doc) => { if (doc) setSavedClientDoc(doc); setNeedsCpf(false); proceedPix(); }}
                                onCancel={() => setNeedsCpf(false)}
                            />
                        ) : (
                        <div className="checkout-pix-intro">
                            <div className="checkout-pix-icon">
                                <QrCode size={24} />
                            </div>
                            <p>Gere o QR Code PIX para pagamento instantâneo.</p>
                            <button
                                key="pix-go"
                                type="button"
                                onClick={(e) => { if (e.detail > 1) return; initPixPayment(); }}
                                disabled={processing}
                                className="checkout-pay-btn checkout-pay-btn--pix"
                            >
                                {processing ? (
                                    <><span className="spinner" style={{ width: 16, height: 16 }} /> Gerando PIX...</>
                                ) : (
                                    <>
                                        <QrCode size={16} />
                                        Gerar PIX - {formatBRL(amount)}
                                    </>
                                )}
                            </button>
                        </div>
                        )
                    ) : (
                        <div className="checkout-pix-result">
                            <PixQrCode
                                pixString={pix.pixString}
                                qrCodeDataUrl={pix.qrCodeDataUrl}
                                // FAILED no polling força o estado "QR expirado" (validade no passado).
                                expiresAt={pixExpired ? 1 : pix.expiresAt}
                                amount={pix.amount}
                                onRegenerate={regeneratePix}
                                regenerating={pixRegenerating}
                                onExpire={handlePixExpire}
                            />

                            {!pixExpired && (
                                <div className="checkout-polling checkout-polling--pix">
                                    <span className="spinner" style={{ width: 14, height: 14, borderColor: '#22c55e', borderTopColor: 'transparent' }} />
                                    Aguardando pagamento...
                                </div>
                            )}

                            {/* Sandbox testing only: no real bank can pay a homologação QR,
                                so offer a button that simulates the confirmed payment. */}
                            {pixSandbox && paymentId && !pixExpired && (
                                <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px dashed var(--border, rgba(255,255,255,0.12))', textAlign: 'center' }}>
                                    <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: 8 }}>
                                        🧪 Modo teste (sandbox) — nenhum valor real é cobrado
                                    </div>
                                    <button
                                        type="button"
                                        onClick={simulatePayment}
                                        disabled={simulating}
                                        style={{
                                            width: '100%', padding: '10px 16px', borderRadius: 10,
                                            border: '1px solid #f59e0b', background: 'rgba(245,158,11,0.12)',
                                            color: '#f59e0b', fontWeight: 600, fontSize: '0.8rem',
                                            cursor: simulating ? 'default' : 'pointer',
                                            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                                        }}
                                    >
                                        {simulating
                                            ? <><span className="spinner" style={{ width: 14, height: 14, borderColor: '#f59e0b', borderTopColor: 'transparent' }} /> Simulando...</>
                                            : <>🧪 Simular pagamento PIX</>}
                                    </button>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            )}

            {/* ═══════ TAB: BOLETO (per-contract release) ═══════ */}
            {activeTab === 'BOLETO' && (
                <div>
                    {!boletoUrl ? (
                        needsCpf ? (
                            <CpfCnpjPrompt
                                client={chargeClient}
                                saveLabel={`Salvar e gerar Boleto - ${formatBRL(amount)}`}
                                onSaved={(doc) => { if (doc) setSavedClientDoc(doc); setNeedsCpf(false); proceedBoleto(); }}
                                onCancel={() => setNeedsCpf(false)}
                            />
                        ) : (
                        <div className="checkout-pix-intro">
                            <div className="checkout-pix-icon" style={{ color: '#f59e0b' }}>
                                <FileText size={24} />
                            </div>
                            <p>Gere o boleto bancário. A compensação leva até 3 dias úteis.</p>
                            <button
                                key="boleto-go"
                                type="button"
                                onClick={(e) => { if (e.detail > 1) return; initBoletoPayment(); }}
                                disabled={processing}
                                className="checkout-pay-btn checkout-pay-btn--card"
                            >
                                {processing ? (
                                    <><span className="spinner" style={{ width: 16, height: 16 }} /> Gerando boleto...</>
                                ) : (
                                    <>
                                        <FileText size={16} />
                                        Gerar Boleto - {formatBRL(amount)}
                                    </>
                                )}
                            </button>
                        </div>
                        )
                    ) : (
                        <div className="checkout-pix-result">
                            <a
                                href={boletoUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="checkout-pay-btn checkout-pay-btn--card"
                                style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
                            >
                                <FileText size={16} /> Abrir / Imprimir Boleto (PDF)
                            </a>

                            {boletoBarcode && (
                                <>
                                    <div className="checkout-pix-code">{boletoBarcode}</div>
                                    <button
                                        type="button"
                                        onClick={copyBoletoBarcode}
                                        className={`checkout-copy-btn ${boletoCopied ? 'checkout-copy-btn--copied' : ''}`}
                                    >
                                        {boletoCopied ? <><Check size={14} /> Copiado!</> : <><Copy size={14} /> Copiar Linha Digitável</>}
                                    </button>
                                </>
                            )}

                            <div className="checkout-polling checkout-polling--pix">
                                <span className="spinner" style={{ width: 14, height: 14, borderColor: '#f59e0b', borderTopColor: 'transparent' }} />
                                Aguardando compensação...
                            </div>

                            {/* Sandbox testing only: boleto shares the Cora provider with PIX. */}
                            {pixSandbox && paymentId && (
                                <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px dashed var(--border-default, rgba(255,255,255,0.12))', textAlign: 'center' }}>
                                    <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: 8 }}>
                                        🧪 Modo teste (sandbox) — nenhum valor real é cobrado
                                    </div>
                                    <button
                                        type="button"
                                        onClick={simulatePayment}
                                        disabled={simulating}
                                        style={{
                                            width: '100%', padding: '10px 16px', borderRadius: 10,
                                            border: '1px solid #f59e0b', background: 'rgba(245,158,11,0.12)',
                                            color: '#f59e0b', fontWeight: 600, fontSize: '0.8rem',
                                            cursor: simulating ? 'default' : 'pointer',
                                            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                                        }}
                                    >
                                        {simulating
                                            ? <><span className="spinner" style={{ width: 14, height: 14, borderColor: '#f59e0b', borderTopColor: 'transparent' }} /> Simulando...</>
                                            : <>🧪 Simular pagamento do Boleto</>}
                                    </button>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            )}

            {/* Cancel */}
            {onCancel && (
                <button key="checkout-cancel" type="button" onClick={onCancel} className="checkout-cancel-btn">
                    Cancelar
                </button>
            )}
        </div>
    );
}

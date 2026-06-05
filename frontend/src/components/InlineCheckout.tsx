import { getErrorMessage } from '../utils/errors';
// ─── InlineCheckout — Unified Payment Component ─────────
// Reusable component: Cartão (Stripe) + PIX (Cora)
// Gateway routing: Cartão → Stripe | PIX → Cora
// Boleto removed from client UI (kept in backend for admin)

import React, { useState, useEffect, useRef, useCallback } from 'react';
import QRCodeLib from 'qrcode';
import StripeCardForm from './StripeCardForm';
import { stripeApi, paymentsApi, type SavedCard } from '../api/client';
import { getClientPaymentMethods, getPaymentMethods, methodInContext, type PaymentMethodKey } from '../constants/paymentMethods';
import { Copy, Check, Lock, QrCode, CreditCard, Plus, ShieldCheck } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { isValidCpfCnpj } from '../utils/mask';
import CpfCnpjPrompt from './CpfCnpjPrompt';

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
    /** Called when payment succeeds (any method) */
    onSuccess: () => void;
    /** Called when an error occurs */
    onError: (msg: string) => void;
    /** Optional cancel handler */
    onCancel?: () => void;
    /** Which methods to show. Default: ['CARTAO', 'PIX'] */
    allowedMethods?: PaymentMethodKey[];
    /** If true, show all methods including BOLETO (admin mode) */
    isAdmin?: boolean;
    /** Checkout context for per-method visibility: avulso | contract | invoice */
    context?: string;
    /** Function to create the Payment record on-the-fly */
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

type ActiveTab = 'CARTAO' | 'PIX';

function formatBRL(cents: number): string {
    return `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;
}

function getBrandIcon(brand: string): string {
    const brands: Record<string, string> = {
        visa: 'Visa',
        mastercard: 'MC',
        amex: 'Amex',
        elo: 'Elo',
        hipercard: 'Hiper',
        discover: 'Disc',
    };
    return brands[brand.toLowerCase()] || brand.charAt(0).toUpperCase();
}

// ─── Component ──────────────────────────────────────────

export default function InlineCheckout({
    amount,
    paymentId: externalPaymentId,
    description,
    contractDuration,
    onSuccess,
    onError,
    onCancel,
    allowedMethods = ['CARTAO', 'PIX'],
    isAdmin = false,
    context,
    createPaymentFn,
}: InlineCheckoutProps) {
    const allMethods = isAdmin ? getPaymentMethods() : getClientPaymentMethods();
    const ctxMethods = allMethods.filter(m =>
        allowedMethods.includes(m.key) && (!context || methodInContext(m, context))
    );
    // Safety: never leave the checkout with zero methods (e.g. admin hid all from this context).
    const availableMethods = ctxMethods.length > 0
        ? ctxMethods
        : allMethods.filter(m => allowedMethods.includes(m.key));
    const [activeTab, setActiveTab] = useState<ActiveTab>(
        (availableMethods[0]?.key as ActiveTab) || 'CARTAO'
    );

    // Shared state
    const [processing, setProcessing] = useState(false);
    const [error, setError] = useState('');

    // Card state
    const [clientSecret, setClientSecret] = useState<string | null>(null);
    const [paymentIntentId, setPaymentIntentId] = useState<string | null>(null);
    const [paymentId, setPaymentId] = useState<string | null>(externalPaymentId || null);
    const [paymentType, setPaymentType] = useState<'CREDIT' | 'DEBIT'>('CREDIT');
    const [installments, setInstallments] = useState(1);
    const [installmentPlans, setInstallmentPlans] = useState<{ count: number; perInstallment: number; total: number; feePercent: number; freeOfCharge: boolean }[]>([]);
    const [wantSaveCard, setWantSaveCard] = useState(true);

    // Saved cards state
    const [savedCards, setSavedCards] = useState<SavedCard[]>([]);
    const [selectedCard, setSelectedCard] = useState<string | null>('new');
    const [loadingCards, setLoadingCards] = useState(true);
    const [payingSavedCard, setPayingSavedCard] = useState(false);

    // PIX state
    const [pixString, setPixString] = useState<string | null>(null);
    const [pixQrBase64, setPixQrBase64] = useState<string | null>(null);
    const [pixCopied, setPixCopied] = useState(false);
    const pollIntervalRef = useRef<number | null>(null);
    // PAY-H1 FIX: Prevent double-init from rapid clicks
    const initGuardRef = useRef(false);
    // PIX requires a CPF/CNPJ on file (Cora invoice). Gate the charge behind an
    // inline collection step when the user has no valid document.
    const { user } = useAuth();
    const [needsCpf, setNeedsCpf] = useState(false);
    // Sandbox testing: when PIX is in sandbox, offer a "simulate payment" button
    const [pixSandbox, setPixSandbox] = useState(false);
    const [simulating, setSimulating] = useState(false);

    useEffect(() => {
        paymentsApi.getSandboxMode().then(m => setPixSandbox(!!m.pix)).catch(() => {});
    }, []);

    const simulatePayment = useCallback(async () => {
        if (!paymentId || simulating) return;
        setSimulating(true);
        try {
            const res = await paymentsApi.simulate(paymentId);
            if (res.status === 'PAID') {
                if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
                onSuccess();
            } else {
                setSimulating(false);
            }
        } catch {
            setSimulating(false);
        }
    }, [paymentId, simulating, onSuccess]);

    // Generate QR Code locally from pixString
    useEffect(() => {
        if (!pixString) return;
        QRCodeLib.toDataURL(pixString, {
            width: 280,
            margin: 2,
            color: { dark: '#000000', light: '#ffffff' },
            errorCorrectionLevel: 'M',
        }).then(dataUrl => {
            const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
            setPixQrBase64(base64);
        }).catch(() => {});
    }, [pixString]);

    // Load saved cards + installment plans when tab is CARTAO
    useEffect(() => {
        if (activeTab === 'CARTAO') {
            setLoadingCards(true);
            stripeApi.listPaymentMethods()
                .then(res => {
                    const methods = res.paymentMethods || [];
                    setSavedCards(methods);
                    // Auto-select the default card, or 'new' if none
                    const defaultCard = methods.find(c => c.isDefault);
                    setSelectedCard(defaultCard ? defaultCard.stripePaymentMethodId : 'new');
                })
                .catch(() => setSavedCards([]))
                .finally(() => setLoadingCards(false));

            if (amount > 0) {
                stripeApi.getInstallmentPlans({ amount, contractDurationMonths: contractDuration })
                    .then(res => setInstallmentPlans(res.plans))
                    .catch(() => {});
            }
        }
    }, [activeTab, amount, contractDuration]);

    // Cleanup polling on unmount
    useEffect(() => {
        return () => {
            if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
        };
    }, []);

    // ─── Helpers ─────────────────────────────────────────

    const startPolling = useCallback((pid: string) => {
        if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
        let attempts = 0;
        const MAX_ATTEMPTS = 180; // 15 minutos (180 × 5s)
        pollIntervalRef.current = window.setInterval(async () => {
            attempts++;
            if (attempts >= MAX_ATTEMPTS) {
                if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
                onError('Tempo de espera expirado. Verifique o status do seu pagamento.');
                return;
            }
            try {
                const res = await paymentsApi.getStatus(pid);
                if (res.status === 'PAID') {
                    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
                    onSuccess();
                } else if (res.status === 'FAILED') {
                    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
                    onError('Pagamento falhou. Tente novamente.');
                }
            } catch {}
        }, 5000);
    }, [onSuccess, onError]);

    // ─── CARD ───────────────────────────────────────────

    const initCardPayment = async () => {
        if (initGuardRef.current) return;
        initGuardRef.current = true;
        setProcessing(true);
        setError('');
        try {
            // Saved card: charge directly
            if (selectedCard && selectedCard !== 'new') {
                setPayingSavedCard(true);
                let pid = paymentId;
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
                    onSuccess();
                    return;
                }
                setPayingSavedCard(false);
            }

            // New card flow: get clientSecret to show PaymentElement
            if (createPaymentFn) {
                const result = await createPaymentFn('CARTAO');
                setPaymentId(result.paymentId);
                setClientSecret(result.clientSecret || null);
                setPaymentIntentId(result.paymentIntentId || null);
            } else if (paymentId) {
                const result = await stripeApi.createPayment({
                    paymentId,
                    installments,
                    paymentMethod: 'cartao',
                    savePaymentMethod: wantSaveCard,
                });
                setClientSecret(result.clientSecret || null);
                setPaymentIntentId(result.paymentIntentId || null);
            }
        } catch (err: unknown) {
            setPayingSavedCard(false);
            const msg = getErrorMessage(err) || 'Erro ao iniciar pagamento com cartao.';
            setError(msg);
            onError(msg);
        } finally {
            setProcessing(false);
            initGuardRef.current = false;
        }
    };

    const handleCardSuccess = async () => {
        try {
            if (paymentId && paymentIntentId) {
                await stripeApi.verifyPayment({ paymentId, paymentIntentId });
            }
            onSuccess();
        } catch {
            // Verify failed — payment may not have been processed
            onError('Pagamento não pôde ser verificado. Verifique seu extrato antes de tentar novamente.');
        }
    };

    // ─── PIX ────────────────────────────────────────────

    // Gate: PIX needs a valid CPF/CNPJ. If absent, show the inline collection
    // step instead of round-tripping to the server only to fail.
    const initPixPayment = () => {
        if (!isValidCpfCnpj(user?.cpfCnpj)) {
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
        try {
            let pid = paymentId;
            if (createPaymentFn) {
                const result = await createPaymentFn('PIX');
                pid = result.paymentId;
                setPaymentId(pid);
                if (result.pixString) setPixString(result.pixString);
                if (result.qrCodeBase64) setPixQrBase64(result.qrCodeBase64);
                if (pid) startPolling(pid);
            } else if (pid) {
                const result = await stripeApi.createPayment({
                    paymentId: pid,
                    paymentMethod: 'pix',
                });
                if (result.pixString) setPixString(result.pixString);
                if (result.qrCodeBase64) setPixQrBase64(result.qrCodeBase64);
                startPolling(pid);
            }
        } catch (err: unknown) {
            const msg = getErrorMessage(err) || 'Erro ao gerar PIX.';
            setError(msg);
            onError(msg);
        } finally {
            setProcessing(false);
            initGuardRef.current = false;
        }
    };

    const copyPixString = () => {
        if (pixString) {
            navigator.clipboard.writeText(pixString);
            setPixCopied(true);
            setTimeout(() => setPixCopied(false), 3000);
        }
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
                <div className="checkout-amount-label">Total a Pagar</div>
                <div className="checkout-amount-value">{formatBRL(amount)}</div>
                <div className="checkout-amount-desc">{description}</div>
            </div>

            {/* Tab Navigation */}
            {availableMethods.length > 1 && (
                <div className="checkout-tabs">
                    {availableMethods.filter(m => m.key === 'CARTAO' || m.key === 'PIX').map(pm => {
                        const isActive = activeTab === pm.key;
                        const tabClass = pm.key === 'PIX' ? 'checkout-tab--pix' : 'checkout-tab--card';
                        return (
                            <button
                                key={pm.key}
                                onClick={() => {
                                    setActiveTab(pm.key as ActiveTab);
                                    setError('');
                                    if (pm.key === 'CARTAO') {
                                        if (pollIntervalRef.current) {
                                            clearInterval(pollIntervalRef.current);
                                            pollIntervalRef.current = null;
                                        }
                                    } else {
                                        setClientSecret(null);
                                        setPaymentIntentId(null);
                                        setNeedsCpf(false);
                                    }
                                }}
                                className={`checkout-tab ${tabClass} ${isActive ? 'checkout-tab--active' : ''}`}
                            >
                                {pm.key === 'CARTAO' ? <CreditCard size={16} /> : <QrCode size={16} />}
                                {pm.key === 'CARTAO' ? 'Cartao' : 'PIX'}
                            </button>
                        );
                    })}
                </div>
            )}

            {/* Error */}
            {error && <div className="checkout-error">{error}</div>}

            {/* ═══════ TAB: CARTAO ═══════ */}
            {activeTab === 'CARTAO' && (
                <div>
                    {/* Step 1: Card Type */}
                    <div className="checkout-section-label">Tipo de Cartao</div>
                    <div className="checkout-type-toggle">
                        {(['CREDIT', 'DEBIT'] as const).map(type => (
                            <button
                                key={type}
                                onClick={() => {
                                    setPaymentType(type);
                                    if (type === 'DEBIT') setInstallments(1);
                                    setSelectedCard('new');
                                    setClientSecret(null);
                                }}
                                className={`checkout-type-btn ${paymentType === type ? 'checkout-type-btn--active' : ''}`}
                            >
                                <CreditCard size={16} />
                                {type === 'CREDIT' ? 'Credito' : 'Debito'}
                            </button>
                        ))}
                    </div>

                    {/* Step 2: Installments (credit only, dropdown) */}
                    {paymentType === 'CREDIT' && installmentPlans.length > 0 && (
                        <>
                            <div className="checkout-section-label">Parcelamento</div>
                            <select
                                value={installments}
                                onChange={(e) => setInstallments(Number(e.target.value))}
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

                    {/* Step 3: Filtered Saved Cards + New Card */}
                    {loadingCards ? (
                        <div className="checkout-cards-loading">
                            <span className="spinner" style={{ width: 16, height: 16 }} />
                            Carregando cartoes...
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
                                            {paymentType === 'CREDIT' ? 'Cartoes de Credito' : 'Cartoes de Debito'}
                                        </div>
                                        <div className="checkout-saved-cards">
                                            {filteredCards.map(card => (
                                                <button
                                                    key={card.stripePaymentMethodId}
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
                                                                {card.funding === 'credit' ? 'Credito' : 'Debito'}
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
                                        onClick={() => setSelectedCard('new')}
                                        className={`checkout-saved-card checkout-saved-card--new ${selectedCard === 'new' ? 'checkout-saved-card--active' : ''}`}
                                    >
                                        <div className="checkout-saved-card-info">
                                            <span className="checkout-saved-card-brand"><Plus size={16} /></span>
                                            <span className="checkout-saved-card-number">
                                                {filteredCards.length > 0 ? 'Usar Outro Cartao' : `Cadastrar Cartao de ${paymentType === 'CREDIT' ? 'Credito' : 'Debito'}`}
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
                                    {paymentType === 'DEBIT' ? 'Debito' : `Credito ${installments > 1 ? `${installments}x` : ''}`}
                                </span>
                                <span className="checkout-stripe-summary-value">
                                    {installments > 1 ? `${installments}x ${formatBRL(Math.ceil(amount / installments))}` : formatBRL(amount)}
                                </span>
                            </div>
                            <StripeCardForm
                                mode="payment"
                                clientSecret={clientSecret}
                                onSuccess={handleCardSuccess}
                                onError={(msg) => { setError(msg); setClientSecret(null); }}
                                onCancel={() => setClientSecret(null)}
                                submitLabel={installments > 1
                                    ? `Pagar ${installments}x ${formatBRL(Math.ceil(amount / installments))}`
                                    : `Pagar ${formatBRL(amount)}`
                                }
                                showSaveCard={true}
                                onSaveCardChange={(save) => setWantSaveCard(save)}
                            />
                        </div>
                    )}

                    {/* Pay Button (saved card or initiate new card flow) */}
                    {!(selectedCard === 'new' && clientSecret) && (
                        <button
                            onClick={initCardPayment}
                            disabled={processing || payingSavedCard}
                            className="checkout-pay-btn checkout-pay-btn--card"
                        >
                            {processing || payingSavedCard ? (
                                <><span className="spinner" style={{ width: 16, height: 16 }} /> {payingSavedCard ? 'Processando...' : 'Preparando...'}</>
                            ) : (
                                <>
                                    <Lock size={14} />
                                    {selectedCard && selectedCard !== 'new'
                                        ? `Pagar com **** ${savedCards.find(c => c.stripePaymentMethodId === selectedCard)?.last4 || ''} - ${
                                            installments > 1 ? `${installments}x ${formatBRL(Math.ceil(amount / installments))}` : formatBRL(amount)
                                        }`
                                        : selectedCard === 'new'
                                            ? 'Continuar com Novo Cartao'
                                            : `Pagar ${formatBRL(amount)}`
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
                    {!pixString ? (
                        needsCpf ? (
                            <CpfCnpjPrompt
                                saveLabel={`Salvar e gerar PIX - ${formatBRL(amount)}`}
                                onSaved={() => { setNeedsCpf(false); proceedPix(); }}
                                onCancel={() => setNeedsCpf(false)}
                            />
                        ) : (
                        <div className="checkout-pix-intro">
                            <div className="checkout-pix-icon">
                                <QrCode size={24} />
                            </div>
                            <p>Gere o QR Code PIX para pagamento instantaneo.</p>
                            <button
                                onClick={initPixPayment}
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
                            {pixQrBase64 ? (
                                <div className="checkout-qr-wrapper">
                                    <img src={`data:image/png;base64,${pixQrBase64}`} alt="QR Code PIX" />
                                </div>
                            ) : (
                                <div className="checkout-qr-loading">
                                    <span className="spinner" style={{ width: 28, height: 28, borderColor: '#22c55e', borderTopColor: 'transparent' }} />
                                    <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>Gerando QR Code...</span>
                                </div>
                            )}

                            <div className="checkout-pix-code">{pixString}</div>
                            <button
                                onClick={copyPixString}
                                className={`checkout-copy-btn ${pixCopied ? 'checkout-copy-btn--copied' : ''}`}
                            >
                                {pixCopied ? <><Check size={14} /> Copiado!</> : <><Copy size={14} /> Copiar Codigo PIX</>}
                            </button>

                            <div className="checkout-polling checkout-polling--pix">
                                <span className="spinner" style={{ width: 14, height: 14, borderColor: '#22c55e', borderTopColor: 'transparent' }} />
                                Aguardando pagamento...
                            </div>

                            {/* Sandbox testing only: no real bank can pay a homologação QR,
                                so offer a button that simulates the confirmed payment. */}
                            {pixSandbox && paymentId && (
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

            {/* Cancel */}
            {onCancel && (
                <button onClick={onCancel} className="checkout-cancel-btn">
                    Cancelar
                </button>
            )}
        </div>
    );
}

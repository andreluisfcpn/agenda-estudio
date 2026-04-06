// ─── InlineCheckout — Unified Payment Component ─────────
// Reusable component that embeds Cartão (Stripe), PIX (Cora), Boleto (Cora)
// inline within any modal. Drop-in replacement for scattered payment logic.
//
// Gateway routing: Cartão → Stripe | PIX/Boleto → Cora

import React, { useState, useEffect, useRef, useCallback } from 'react';
import StripeCardForm from './StripeCardForm';
import { stripeApi, paymentsApi } from '../api/client';
import { getPaymentMethods, type PaymentMethodKey } from '../constants/paymentMethods';
import { Copy, Check, ExternalLink, Lock, QrCode, FileText, CreditCard } from 'lucide-react';

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
    /** Function to create the Payment record on-the-fly (for modals that don't have one yet) */
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

function formatBRL(cents: number): string {
    return `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;
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
    createPaymentFn,
}: InlineCheckoutProps) {
    const allMethods = getPaymentMethods();
    const availableMethods = allMethods.filter(m => allowedMethods.includes(m.key));
    const [activeTab, setActiveTab] = useState<ActiveTab>(availableMethods[0]?.key || 'CARTAO');

    // Shared state
    const [processing, setProcessing] = useState(false);
    const [error, setError] = useState('');

    // Cartão state
    const [clientSecret, setClientSecret] = useState<string | null>(null);
    const [paymentIntentId, setPaymentIntentId] = useState<string | null>(null);
    const [paymentId, setPaymentId] = useState<string | null>(externalPaymentId || null);
    const [paymentType, setPaymentType] = useState<'CREDIT' | 'DEBIT'>('CREDIT');
    const [installments, setInstallments] = useState(1);
    const [installmentPlans, setInstallmentPlans] = useState<{ count: number; perInstallment: number; total: number; feePercent: number; freeOfCharge: boolean }[]>([]);

    // PIX state
    const [pixString, setPixString] = useState<string | null>(null);
    const [pixQrBase64, setPixQrBase64] = useState<string | null>(null);
    const [pixCopied, setPixCopied] = useState(false);
    const pollIntervalRef = useRef<number | null>(null);

    // Boleto state
    const [boletoUrl, setBoletoUrl] = useState<string | null>(null);
    const [barcode, setBarcode] = useState<string | null>(null);
    const [barcodeCopied, setBarcodeCopied] = useState(false);

    // Load installment plans when tab is CARTAO
    useEffect(() => {
        if (activeTab === 'CARTAO' && amount > 0) {
            stripeApi.getInstallmentPlans({ amount, contractDurationMonths: contractDuration })
                .then(res => setInstallmentPlans(res.plans))
                .catch(() => {}); // Non-critical
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

        pollIntervalRef.current = window.setInterval(async () => {
            try {
                const res = await paymentsApi.getStatus(pid);
                if (res.status === 'PAID') {
                    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
                    onSuccess();
                }
            } catch {
                // Silently continue polling
            }
        }, 5000);
    }, [onSuccess]);

    // ─── Tab: CARTÃO (Stripe) ───────────────────────────

    const initCardPayment = async () => {
        setProcessing(true);
        setError('');
        try {
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
                });
                setClientSecret(result.clientSecret || null);
                setPaymentIntentId(result.paymentIntentId || null);
            }
        } catch (err: any) {
            setError(err.message || 'Erro ao iniciar pagamento com cartão.');
            onError(err.message || 'Erro ao iniciar pagamento com cartão.');
        } finally {
            setProcessing(false);
        }
    };

    const handleCardSuccess = async () => {
        try {
            if (paymentId && paymentIntentId) {
                await stripeApi.verifyPayment({ paymentId, paymentIntentId });
            }
            onSuccess();
        } catch {
            // Payment went through even if verify fails
            onSuccess();
        }
    };

    // ─── Tab: PIX (Cora) ────────────────────────────────

    const initPixPayment = async () => {
        setProcessing(true);
        setError('');
        try {
            let result: any;
            if (createPaymentFn) {
                result = await createPaymentFn('PIX');
                setPaymentId(result.paymentId);
            } else if (paymentId) {
                result = await stripeApi.createPayment({ paymentId, paymentMethod: 'pix' });
            }
            if (result) {
                setPixString(result.pixString || null);
                setPixQrBase64(result.qrCodeBase64 || null);
                const pid = result.paymentId || paymentId;
                if (pid) startPolling(pid);
            }
        } catch (err: any) {
            setError(err.message || 'Erro ao gerar PIX.');
            onError(err.message || 'Erro ao gerar PIX.');
        } finally {
            setProcessing(false);
        }
    };

    const copyPixString = () => {
        if (pixString) {
            navigator.clipboard.writeText(pixString);
            setPixCopied(true);
            setTimeout(() => setPixCopied(false), 3000);
        }
    };

    // ─── Tab: BOLETO (Cora) ─────────────────────────────

    const initBoletoPayment = async () => {
        setProcessing(true);
        setError('');
        try {
            let result: any;
            if (createPaymentFn) {
                result = await createPaymentFn('BOLETO');
                setPaymentId(result.paymentId);
            } else if (paymentId) {
                result = await stripeApi.createPayment({ paymentId, paymentMethod: 'boleto' });
            }
            if (result) {
                setBoletoUrl(result.boletoUrl || null);
                setBarcode(result.barcode || null);
                const pid = result.paymentId || paymentId;
                if (pid) startPolling(pid);
            }
        } catch (err: any) {
            setError(err.message || 'Erro ao gerar boleto.');
            onError(err.message || 'Erro ao gerar boleto.');
        } finally {
            setProcessing(false);
        }
    };

    const copyBarcode = () => {
        if (barcode) {
            navigator.clipboard.writeText(barcode);
            setBarcodeCopied(true);
            setTimeout(() => setBarcodeCopied(false), 3000);
        }
    };

    // ─── Render ──────────────────────────────────────────

    const TAB_ICONS: Record<string, React.ReactNode> = {
        CARTAO: <CreditCard size={16} />,
        PIX: <QrCode size={16} />,
        BOLETO: <FileText size={16} />,
    };

    return (
        <div style={{ width: '100%' }}>
            {/* Amount Header */}
            <div style={{
                textAlign: 'center', padding: '16px', marginBottom: '16px',
                background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)',
                border: '1px solid var(--border-color)',
            }}>
                <div style={{ fontSize: '0.6875rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: '4px' }}>
                    Total a Pagar
                </div>
                <div style={{ fontSize: '1.75rem', fontWeight: 800, color: 'var(--text-primary)' }}>
                    {formatBRL(amount)}
                </div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                    {description}
                </div>
            </div>

            {/* Tab Navigation */}
            {availableMethods.length > 1 && (
                <div style={{
                    display: 'flex', gap: '4px', marginBottom: '16px',
                    background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)', padding: '4px',
                }}>
                    {availableMethods.map(pm => {
                        const isActive = activeTab === pm.key;
                        return (
                            <button
                                key={pm.key}
                                onClick={() => { setActiveTab(pm.key); setError(''); }}
                                style={{
                                    flex: 1, padding: '10px 8px', border: 'none',
                                    borderRadius: 'var(--radius-sm)', cursor: 'pointer',
                                    background: isActive ? pm.color : 'transparent',
                                    color: isActive ? '#fff' : 'var(--text-secondary)',
                                    fontWeight: isActive ? 700 : 500,
                                    fontSize: '0.8125rem',
                                    transition: 'all 0.2s ease',
                                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
                                }}
                            >
                                {TAB_ICONS[pm.key]} {pm.shortLabel}
                            </button>
                        );
                    })}
                </div>
            )}

            {/* Error */}
            {error && (
                <div style={{
                    padding: '10px 14px', borderRadius: 'var(--radius-sm)', marginBottom: '12px',
                    background: 'rgba(239, 68, 68, 0.08)', border: '1px solid rgba(239, 68, 68, 0.2)',
                    color: '#ef4444', fontSize: '0.8125rem', fontWeight: 600,
                }}>
                    ⚠️ {error}
                </div>
            )}

            {/* ══════════ TAB: CARTÃO ══════════ */}
            {activeTab === 'CARTAO' && (
                <div>
                    {!clientSecret ? (
                        <>
                            {/* Payment type toggle */}
                            <div style={{ fontWeight: 700, fontSize: '0.6875rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: '8px' }}>
                                Tipo de Cartão
                            </div>
                            <div style={{ display: 'flex', gap: '8px', marginBottom: '14px' }}>
                                {(['CREDIT', 'DEBIT'] as const).map(type => (
                                    <button key={type}
                                        onClick={() => { setPaymentType(type); if (type === 'DEBIT') setInstallments(1); }}
                                        style={{
                                            flex: 1, padding: '10px', borderRadius: 'var(--radius-sm)',
                                            background: paymentType === type ? 'rgba(99, 91, 255, 0.1)' : 'var(--bg-secondary)',
                                            border: `2px solid ${paymentType === type ? '#635BFF' : 'var(--border-subtle)'}`,
                                            color: paymentType === type ? '#635BFF' : 'var(--text-secondary)',
                                            fontWeight: 700, fontSize: '0.8125rem', cursor: 'pointer',
                                            transition: 'all 0.2s ease',
                                        }}
                                    >
                                        {type === 'CREDIT' ? '💳 Crédito' : '🏧 Débito'}
                                    </button>
                                ))}
                            </div>

                            {/* Installments (credit only) */}
                            {paymentType === 'CREDIT' && installmentPlans.length > 0 && (
                                <>
                                    <div style={{ fontWeight: 700, fontSize: '0.6875rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: '8px' }}>
                                        Parcelamento
                                    </div>
                                    <div style={{ display: 'flex', gap: '6px', marginBottom: '14px', flexWrap: 'wrap' }}>
                                        {installmentPlans.map(plan => (
                                            <button key={plan.count}
                                                onClick={() => setInstallments(plan.count)}
                                                style={{
                                                    flex: '1 0 calc(33% - 4px)', padding: '8px 6px', borderRadius: 'var(--radius-sm)',
                                                    background: installments === plan.count ? 'rgba(99, 91, 255, 0.1)' : 'var(--bg-secondary)',
                                                    border: `2px solid ${installments === plan.count ? '#635BFF' : 'var(--border-subtle)'}`,
                                                    color: installments === plan.count ? '#635BFF' : 'var(--text-secondary)',
                                                    fontWeight: 700, fontSize: '0.75rem', cursor: 'pointer',
                                                    transition: 'all 0.2s ease',
                                                }}
                                            >
                                                {plan.count}x {formatBRL(plan.perInstallment)}
                                                {plan.freeOfCharge && <span style={{ display: 'block', fontSize: '0.5625rem', opacity: 0.7 }}>s/ juros</span>}
                                            </button>
                                        ))}
                                    </div>
                                </>
                            )}

                            {/* Proceed to Stripe */}
                            <button
                                className="btn btn-primary"
                                onClick={initCardPayment}
                                disabled={processing}
                                style={{
                                    width: '100%', padding: '12px', fontWeight: 700,
                                    background: '#635BFF', borderColor: '#635BFF',
                                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
                                }}
                            >
                                {processing ? (
                                    <><span className="spinner" style={{ width: 16, height: 16 }} /> Preparando...</>
                                ) : (
                                    <>
                                        <Lock size={14} />
                                        Pagar {installments > 1 ? `${installments}x ${formatBRL(Math.ceil(amount / installments))}` : formatBRL(amount)}
                                    </>
                                )}
                            </button>
                        </>
                    ) : (
                        /* Stripe Card Form */
                        <div>
                            <div style={{
                                padding: '10px 14px', borderRadius: 'var(--radius-sm)', marginBottom: '16px',
                                background: 'rgba(99, 91, 255, 0.06)', border: '1px solid rgba(99, 91, 255, 0.2)',
                                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                            }}>
                                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                    {paymentType === 'DEBIT' ? '🏧 Débito' : `💳 Crédito ${installments > 1 ? `${installments}x` : ''}`}
                                </span>
                                <span style={{ fontWeight: 800, fontSize: '1rem', color: '#635BFF' }}>
                                    {installments > 1 ? `${installments}x ${formatBRL(Math.ceil(amount / installments))}` : formatBRL(amount)}
                                </span>
                            </div>
                            <StripeCardForm
                                mode="payment"
                                clientSecret={clientSecret}
                                onSuccess={handleCardSuccess}
                                onError={(msg) => { setError(msg); setClientSecret(null); }}
                                onCancel={() => setClientSecret(null)}
                                submitLabel={`Pagar ${formatBRL(amount)}`}
                            />
                        </div>
                    )}
                </div>
            )}

            {/* ══════════ TAB: PIX ══════════ */}
            {activeTab === 'PIX' && (
                <div>
                    {!pixString ? (
                        <div style={{ textAlign: 'center' }}>
                            <div style={{ fontSize: '3rem', marginBottom: '8px' }}>⚡</div>
                            <p style={{ color: 'var(--text-muted)', fontSize: '0.8125rem', marginBottom: '16px' }}>
                                Gere o QR Code PIX para pagamento instantâneo via Cora.
                            </p>
                            <button
                                className="btn btn-primary"
                                onClick={initPixPayment}
                                disabled={processing}
                                style={{
                                    width: '100%', padding: '12px', fontWeight: 700,
                                    background: '#22c55e', borderColor: '#22c55e',
                                }}
                            >
                                {processing ? (
                                    <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                                        <span className="spinner" style={{ width: 16, height: 16 }} /> Gerando PIX...
                                    </span>
                                ) : (
                                    `⚡ Gerar PIX — ${formatBRL(amount)}`
                                )}
                            </button>
                        </div>
                    ) : (
                        <div style={{ textAlign: 'center' }}>
                            {/* QR Code */}
                            {pixQrBase64 ? (
                                <div style={{
                                    display: 'inline-block', padding: '16px', background: '#fff',
                                    borderRadius: 'var(--radius-md)', marginBottom: '16px',
                                }}>
                                    <img src={`data:image/png;base64,${pixQrBase64}`} alt="QR Code PIX" style={{ width: 200, height: 200 }} />
                                </div>
                            ) : (
                                <div style={{
                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    width: 200, height: 200, margin: '0 auto 16px', borderRadius: 'var(--radius-md)',
                                    background: 'var(--bg-secondary)', border: '2px dashed var(--border-color)',
                                }}>
                                    <QrCode size={48} style={{ color: 'var(--text-muted)' }} />
                                </div>
                            )}

                            {/* Copia e Cola */}
                            <div style={{
                                padding: '10px 14px', borderRadius: 'var(--radius-sm)', marginBottom: '12px',
                                background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
                                fontSize: '0.6875rem', color: 'var(--text-muted)', wordBreak: 'break-all',
                                maxHeight: '60px', overflow: 'hidden',
                            }}>
                                {pixString}
                            </div>
                            <button
                                className="btn btn-secondary btn-sm"
                                onClick={copyPixString}
                                style={{ width: '100%', marginBottom: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}
                            >
                                {pixCopied ? <><Check size={14} /> Copiado!</> : <><Copy size={14} /> Copiar Código PIX</>}
                            </button>

                            {/* Polling indicator */}
                            <div style={{
                                padding: '12px', borderRadius: 'var(--radius-sm)',
                                background: 'rgba(34, 197, 94, 0.06)', border: '1px solid rgba(34, 197, 94, 0.2)',
                                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
                                fontSize: '0.8125rem', color: '#22c55e', fontWeight: 600,
                            }}>
                                <span className="spinner" style={{ width: 14, height: 14, borderColor: '#22c55e', borderTopColor: 'transparent' }} />
                                Aguardando pagamento...
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* ══════════ TAB: BOLETO ══════════ */}
            {activeTab === 'BOLETO' && (
                <div>
                    {!boletoUrl ? (
                        <div style={{ textAlign: 'center' }}>
                            <div style={{ fontSize: '3rem', marginBottom: '8px' }}>📄</div>
                            <p style={{ color: 'var(--text-muted)', fontSize: '0.8125rem', marginBottom: '16px' }}>
                                Gere o boleto bancário via Cora. Compensação em até 3 dias úteis.
                            </p>
                            <button
                                className="btn btn-primary"
                                onClick={initBoletoPayment}
                                disabled={processing}
                                style={{
                                    width: '100%', padding: '12px', fontWeight: 700,
                                    background: '#f59e0b', borderColor: '#f59e0b', color: '#000',
                                }}
                            >
                                {processing ? (
                                    <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                                        <span className="spinner" style={{ width: 16, height: 16 }} /> Gerando Boleto...
                                    </span>
                                ) : (
                                    `📄 Gerar Boleto — ${formatBRL(amount)}`
                                )}
                            </button>
                        </div>
                    ) : (
                        <div>
                            {/* Success State */}
                            <div style={{
                                padding: '20px', borderRadius: 'var(--radius-md)', marginBottom: '16px',
                                background: 'rgba(245, 158, 11, 0.06)', border: '1px solid rgba(245, 158, 11, 0.2)',
                                textAlign: 'center',
                            }}>
                                <div style={{ fontSize: '2rem', marginBottom: '8px' }}>✅</div>
                                <div style={{ fontWeight: 700, fontSize: '0.9375rem', marginBottom: '4px' }}>
                                    Boleto Gerado com Sucesso!
                                </div>
                                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                    Compensação em até 3 dias úteis após pagamento.
                                </div>
                            </div>

                            {/* Barcode */}
                            {barcode && (
                                <>
                                    <div style={{
                                        padding: '10px 14px', borderRadius: 'var(--radius-sm)', marginBottom: '8px',
                                        background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
                                        fontSize: '0.75rem', color: 'var(--text-secondary)', fontFamily: 'monospace',
                                        letterSpacing: '0.05em', textAlign: 'center',
                                    }}>
                                        {barcode}
                                    </div>
                                    <button
                                        className="btn btn-secondary btn-sm"
                                        onClick={copyBarcode}
                                        style={{ width: '100%', marginBottom: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}
                                    >
                                        {barcodeCopied ? <><Check size={14} /> Copiado!</> : <><Copy size={14} /> Copiar Código de Barras</>}
                                    </button>
                                </>
                            )}

                            {/* Open PDF */}
                            <a
                                href={boletoUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="btn btn-primary"
                                style={{
                                    width: '100%', padding: '12px', fontWeight: 700,
                                    background: '#f59e0b', borderColor: '#f59e0b', color: '#000',
                                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
                                    textDecoration: 'none',
                                }}
                            >
                                <ExternalLink size={14} /> Abrir Boleto (PDF)
                            </a>

                            {/* Polling */}
                            <div style={{
                                marginTop: '12px', padding: '10px', borderRadius: 'var(--radius-sm)',
                                background: 'rgba(245, 158, 11, 0.06)', border: '1px solid rgba(245, 158, 11, 0.15)',
                                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
                                fontSize: '0.75rem', color: '#f59e0b', fontWeight: 600,
                            }}>
                                <span className="spinner" style={{ width: 12, height: 12, borderColor: '#f59e0b', borderTopColor: 'transparent' }} />
                                Aguardando compensação...
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* Cancel Button */}
            {onCancel && (
                <button
                    className="btn btn-ghost btn-sm"
                    onClick={onCancel}
                    style={{ width: '100%', marginTop: '12px', fontSize: '0.75rem', color: 'var(--text-muted)' }}
                >
                    Cancelar
                </button>
            )}
        </div>
    );
}

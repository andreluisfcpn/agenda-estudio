import { getErrorMessage } from '../utils/errors';
// ─── Stripe Payment Form ────────────────────────────────
// Uses PaymentElement (recommended) — replaces legacy CardElement
// Supports: cards, wallets (Apple Pay, Google Pay), 3D Secure auto
// Docs: https://docs.stripe.com/payments/payment-element

import React, { useState, useEffect } from 'react';
import { loadStripe, Stripe as StripeType } from '@stripe/stripe-js';
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js';
import { stripeApi } from '../api/client';
import { Lock, ShieldCheck } from 'lucide-react';

// ─── Stripe Instance Singleton ─────────────────────────

let stripePromise: Promise<StripeType | null> | null = null;

export async function getStripe(): Promise<StripeType | null> {
    if (!stripePromise) {
        stripePromise = stripeApi.getPublishableKey()
            .then(res => loadStripe(res.publishableKey))
            .catch(() => null);
    }
    return stripePromise;
}

// ─── Inner Form (needs Stripe Context) ──────────────────

interface CardFormInnerProps {
    mode: 'setup' | 'payment';
    clientSecret: string;
    onSuccess: () => void;
    onError: (msg: string) => void;
    onCancel?: () => void;
    submitLabel?: string;
    showSaveCard?: boolean;
    onSaveCardChange?: (save: boolean) => void;
}

function CardFormInner({ mode, clientSecret, onSuccess, onError, onCancel, submitLabel, showSaveCard, onSaveCardChange }: CardFormInnerProps) {
    const stripe = useStripe();
    const elements = useElements();
    const [processing, setProcessing] = useState(false);
    const [formError, setFormError] = useState('');
    const [formReady, setFormReady] = useState(false);
    const [saveCard, setSaveCard] = useState(true);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!stripe || !elements) return;

        setProcessing(true);
        setFormError('');

        try {
            if (mode === 'setup') {
                const { error } = await stripe.confirmSetup({
                    elements,
                    confirmParams: {
                        return_url: window.location.href,
                    },
                    redirect: 'if_required',
                });
                if (error) {
                    const msg = error.message || 'Erro ao salvar cartão.';
                    setFormError(msg);
                    onError(msg);
                } else {
                    onSuccess();
                }
            } else {
                const { error, paymentIntent } = await stripe.confirmPayment({
                    elements,
                    confirmParams: {
                        return_url: window.location.href,
                    },
                    redirect: 'if_required',
                });
                if (error) {
                    const msg = error.message || 'Erro no pagamento.';
                    setFormError(msg);
                    onError(msg);
                } else if (paymentIntent?.status === 'succeeded') {
                    onSuccess();
                } else if (paymentIntent?.status === 'requires_action') {
                    setFormError('Autenticação adicional necessária. Siga as instruções do banco.');
                }
            }
        } catch (err: unknown) {
            const msg = getErrorMessage(err) || 'Erro inesperado.';
            setFormError(msg);
            onError(msg);
        } finally {
            setProcessing(false);
        }
    };

    return (
        <form onSubmit={handleSubmit} className="stripe-payment-form">
            {/* Payment Element */}
            <div className="stripe-element-wrapper">
                <PaymentElement
                    onReady={() => setFormReady(true)}
                    onChange={(e) => {
                        if (e.complete) setFormError('');
                    }}
                    options={{
                        layout: 'tabs',
                    }}
                />
            </div>

            {/* Save Card Checkbox */}
            {showSaveCard && formReady && (
                <label className="stripe-save-card">
                    <input
                        type="checkbox"
                        checked={saveCard}
                        onChange={(e) => {
                            setSaveCard(e.target.checked);
                            onSaveCardChange?.(e.target.checked);
                        }}
                    />
                    <span>Salvar cartão para futuras compras</span>
                </label>
            )}

            {/* Error Message */}
            {formError && (
                <div className="stripe-form-error">
                    {formError}
                </div>
            )}

            {/* Security Badge */}
            <div className="stripe-security-badge">
                <ShieldCheck size={14} />
                <span>Pagamento seguro processado por <strong>Stripe</strong></span>
                <Lock size={11} />
            </div>

            {/* Action Buttons */}
            <div className="stripe-form-actions">
                {onCancel && (
                    <button
                        type="button"
                        className="stripe-cancel-btn"
                        onClick={onCancel}
                        disabled={processing}
                    >
                        Voltar
                    </button>
                )}
                <button
                    type="submit"
                    className="stripe-submit-btn"
                    disabled={!stripe || !formReady || processing}
                >
                    {processing ? (
                        <span className="stripe-submit-loading">
                            <span className="spinner" aria-hidden="true" style={{ width: 16, height: 16 }} />
                            Processando...
                        </span>
                    ) : (
                        <>
                            <Lock size={14} />
                            {submitLabel || (mode === 'setup' ? 'Salvar Cartão' : 'Pagar')}
                        </>
                    )}
                </button>
            </div>
        </form>
    );
}

// ─── Main Component (Public API) ────────────────────────

interface StripeCardFormProps {
    mode: 'setup' | 'payment';
    clientSecret: string;
    onSuccess: () => void;
    onError: (msg: string) => void;
    onCancel?: () => void;
    submitLabel?: string;
    showSaveCard?: boolean;
    onSaveCardChange?: (save: boolean) => void;
}

export default function StripeCardForm(props: StripeCardFormProps) {
    const [stripe, setStripe] = useState<StripeType | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        getStripe().then(s => {
            setStripe(s);
            setLoading(false);
        });
    }, []);

    if (loading) {
        return (
            <div className="stripe-loading">
                <div className="spinner" style={{ width: 20, height: 20, margin: '0 auto 8px' }} />
                Carregando formulário de pagamento...
            </div>
        );
    }

    if (!stripe) {
        return (
            <div className="stripe-not-configured">
                Stripe não está configurado. Contate o administrador.
            </div>
        );
    }

    return (
        <Elements stripe={stripe} options={{
            clientSecret: props.clientSecret,
            appearance: {
                theme: 'night',
                variables: {
                    colorPrimary: '#635BFF',
                    colorBackground: 'rgba(15, 23, 42, 0.6)',
                    colorText: '#e2e8f0',
                    colorTextSecondary: '#94a3b8',
                    colorDanger: '#ef4444',
                    fontFamily: "'Inter', system-ui, sans-serif",
                    fontSizeBase: '14px',
                    borderRadius: '10px',
                    spacingUnit: '4px',
                    spacingGridRow: '16px',
                },
                rules: {
                    '.Input': {
                        border: '1px solid rgba(148, 163, 184, 0.2)',
                        backgroundColor: 'rgba(15, 23, 42, 0.8)',
                        boxShadow: 'none',
                        padding: '12px 14px',
                    },
                    '.Input:focus': {
                        border: '1px solid #635BFF',
                        boxShadow: '0 0 0 2px rgba(99, 91, 255, 0.15)',
                    },
                    '.Label': {
                        color: '#94a3b8',
                        fontWeight: '600',
                        fontSize: '12px',
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em',
                        marginBottom: '6px',
                    },
                    '.Tab': {
                        border: '1px solid rgba(148, 163, 184, 0.15)',
                        backgroundColor: 'rgba(15, 23, 42, 0.4)',
                    },
                    '.Tab--selected': {
                        border: '1px solid #635BFF',
                        backgroundColor: 'rgba(99, 91, 255, 0.08)',
                    },
                    '.Tab:hover': {
                        border: '1px solid rgba(99, 91, 255, 0.4)',
                    },
                },
            },
        }}>
            <CardFormInner {...props} />
        </Elements>
    );
}

// ─── Stripe Card Form ───────────────────────────────────
// Reusable component for adding cards and making payments inline
// Uses Stripe Elements for PCI-compliant card input

import React, { useState, useEffect } from 'react';
import { loadStripe, Stripe as StripeType } from '@stripe/stripe-js';
import { Elements, CardElement, useStripe, useElements } from '@stripe/react-stripe-js';
import { stripeApi } from '../api/client';
import { Lock } from 'lucide-react';

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

// ─── Card Element Styles ────────────────────────────────

const CARD_ELEMENT_OPTIONS = {
    style: {
        base: {
            fontSize: '15px',
            fontFamily: "'Inter', system-ui, sans-serif",
            color: 'var(--text-primary, #e2e8f0)',
            '::placeholder': { color: 'var(--text-muted, #64748b)' },
            iconColor: 'var(--text-secondary, #94a3b8)',
            lineHeight: '24px',
        },
        invalid: {
            color: '#ef4444',
            iconColor: '#ef4444',
        },
    },
    hidePostalCode: true,
};

// ─── Inner Form (needs Stripe Context) ──────────────────

interface CardFormInnerProps {
    mode: 'setup' | 'payment';
    clientSecret: string;
    onSuccess: () => void;
    onError: (msg: string) => void;
    onCancel?: () => void;
    submitLabel?: string;
    processing?: boolean;
}

function CardFormInner({ mode, clientSecret, onSuccess, onError, onCancel, submitLabel }: CardFormInnerProps) {
    const stripe = useStripe();
    const elements = useElements();
    const [processing, setProcessing] = useState(false);
    const [cardError, setCardError] = useState('');
    const [cardComplete, setCardComplete] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!stripe || !elements) return;

        const cardElement = elements.getElement(CardElement);
        if (!cardElement) return;

        setProcessing(true);
        setCardError('');

        try {
            if (mode === 'setup') {
                const { error } = await stripe.confirmCardSetup(clientSecret, {
                    payment_method: { card: cardElement },
                });
                if (error) {
                    setCardError(error.message || 'Erro ao salvar cartão.');
                    onError(error.message || 'Erro ao salvar cartão.');
                } else {
                    onSuccess();
                }
            } else {
                const { error, paymentIntent } = await stripe.confirmCardPayment(clientSecret, {
                    payment_method: { card: cardElement },
                });
                if (error) {
                    setCardError(error.message || 'Erro no pagamento.');
                    onError(error.message || 'Erro no pagamento.');
                } else if (paymentIntent?.status === 'succeeded') {
                    onSuccess();
                } else if (paymentIntent?.status === 'requires_action') {
                    // 3D Secure — Stripe handles automatically
                    setCardError('Autenticação adicional necessária. Siga as instruções do banco.');
                }
            }
        } catch (err: any) {
            setCardError(err.message || 'Erro inesperado.');
            onError(err.message || 'Erro inesperado.');
        } finally {
            setProcessing(false);
        }
    };

    return (
        <form onSubmit={handleSubmit}>
            {/* Card Input */}
            <div style={{
                padding: '14px 16px', borderRadius: '12px',
                background: 'var(--bg-primary)', border: '1px solid var(--border-color)',
                transition: 'border-color 0.2s',
            }}>
                <CardElement
                    options={CARD_ELEMENT_OPTIONS}
                    onChange={(e) => {
                        setCardComplete(e.complete);
                        if (e.error) setCardError(e.error.message);
                        else setCardError('');
                    }}
                />
            </div>

            {/* Error Message */}
            {cardError && (
                <div style={{
                    marginTop: '10px', padding: '8px 12px', borderRadius: '8px',
                    background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)',
                    color: '#ef4444', fontSize: '0.8125rem', fontWeight: 600,
                }}>
                    ⚠️ {cardError}
                </div>
            )}

            {/* Security Badge */}
            <div style={{
                marginTop: '10px', display: 'flex', alignItems: 'center', gap: '6px',
                fontSize: '0.6875rem', color: 'var(--text-muted)',
            }}>
                <Lock size={12} aria-hidden="true" style={{ color: 'var(--text-muted)' }} /> Seus dados estão protegidos com criptografia Stripe
            </div>

            {/* Action Buttons */}
            <div style={{
                display: 'flex', gap: '10px', marginTop: '16px', justifyContent: 'flex-end',
            }}>
                {onCancel && (
                    <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={onCancel}
                        disabled={processing}
                    >
                        Cancelar
                    </button>
                )}
                <button
                    type="submit"
                    className="btn btn-primary btn-sm"
                    disabled={!stripe || !cardComplete || processing}
                    style={{
                        padding: '10px 24px', fontWeight: 700,
                        opacity: (!stripe || !cardComplete || processing) ? 0.5 : 1,
                    }}
                >
                    {processing ? (
                        <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <span className="spinner" aria-hidden="true" style={{ width: 16, height: 16 }} />
                            Processando...
                        </span>
                    ) : (
                        submitLabel || (mode === 'setup' ? '💳 Salvar Cartão' : '💳 Pagar')
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
            <div style={{
                padding: '24px', textAlign: 'center',
                color: 'var(--text-muted)', fontSize: '0.8125rem',
            }}>
                <div className="spinner" style={{ width: 20, height: 20, margin: '0 auto 8px' }} />
                Carregando formulário de pagamento...
            </div>
        );
    }

    if (!stripe) {
        return (
            <div style={{
                padding: '16px', borderRadius: '10px',
                background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)',
                color: '#ef4444', fontSize: '0.8125rem', fontWeight: 600,
            }}>
                ⚠️ Stripe não está configurado. Contate o administrador.
            </div>
        );
    }

    return (
        <Elements stripe={stripe} options={{
            clientSecret: props.clientSecret,
            appearance: {
                theme: 'night',
                variables: {
                    colorPrimary: '#10b981',
                    colorBackground: '#1a1a2e',
                    colorText: '#e2e8f0',
                    colorDanger: '#ef4444',
                    fontFamily: "'Inter', system-ui, sans-serif",
                    borderRadius: '10px',
                },
            },
        }}>
            <CardFormInner {...props} />
        </Elements>
    );
}

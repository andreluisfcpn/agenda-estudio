// ─── PaymentModal — Unified Payment Modal Wrapper ─────────
// Single source of truth for payment modal UI across the system.
// Used in: DashboardPage, MyPaymentsPage, and anywhere a modal payment is needed.

import { X } from 'lucide-react';
import ModalOverlay from './ModalOverlay';
import InlineCheckout from './InlineCheckout';
import type { PaymentMethodKey } from '../constants/paymentMethods';

interface PaymentModalProps {
    /** Modal title shown in the header */
    title?: string;
    /** Total amount in cents */
    amount: number;
    /** Internal Payment record ID */
    paymentId: string;
    /** Human-readable description for the checkout */
    description: string;
    /** Contract duration in months (for installment calculation) */
    contractDuration?: number;
    /** Which methods to show */
    allowedMethods?: PaymentMethodKey[];
    /** Called when payment succeeds */
    onSuccess: () => void;
    /** Called when an error occurs */
    onError: (msg: string) => void;
    /** Called when user closes/cancels */
    onClose: () => void;
}

export default function PaymentModal({
    title = 'Pagar Fatura',
    amount,
    paymentId,
    description,
    contractDuration,
    allowedMethods = ['CARTAO', 'PIX'],
    onSuccess,
    onError,
    onClose,
}: PaymentModalProps) {
    return (
        <ModalOverlay onClose={onClose}>
            <div className="modal-content" style={{ maxWidth: 480, padding: 0 }}>
                {/* Header */}
                <div style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '20px 24px',
                    borderBottom: '1px solid var(--border-subtle)',
                }}>
                    <h2 style={{ fontSize: '1.125rem', fontWeight: 800, margin: 0 }}>
                        {title}
                    </h2>
                    <button
                        onClick={onClose}
                        aria-label="Fechar"
                        style={{
                            background: 'transparent',
                            border: 'none',
                            color: 'var(--text-secondary)',
                            cursor: 'pointer',
                            display: 'flex',
                            padding: '8px',
                            borderRadius: '50%',
                        }}
                    >
                        <X size={20} />
                    </button>
                </div>

                {/* Body */}
                <div style={{ padding: '20px 24px 24px' }}>
                    <InlineCheckout
                        amount={amount}
                        paymentId={paymentId}
                        description={description}
                        contractDuration={contractDuration}
                        allowedMethods={allowedMethods}
                        onSuccess={onSuccess}
                        onError={onError}
                        onCancel={onClose}
                    />
                </div>
            </div>
        </ModalOverlay>
    );
}

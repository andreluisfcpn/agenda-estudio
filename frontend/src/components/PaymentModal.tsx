// ─── PaymentModal — Unified Payment Modal Wrapper ─────────
// Single source of truth for payment modal UI across the system.
// Used in: DashboardPage, MyPaymentsPage, and anywhere a modal payment is needed.

import BottomSheetModal from './BottomSheetModal';
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
    // PaymentModal is now just a facade to BottomSheetModal
    // Note: We need to pass isOpen={true} because this component is only mounted when it should be open
    // based on how it's used in DashboardPage/ClientDashboard currently (e.g., {payingInvoice && <PaymentModal ... />})
    return (
        <BottomSheetModal isOpen={true} onClose={onClose} title={title}>
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
        </BottomSheetModal>
    );
}

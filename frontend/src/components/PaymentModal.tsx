// ─── PaymentModal — Unified Payment Modal Wrapper ─────────
// Single source of truth for payment modal UI across the system.
// Used in: DashboardPage, MyPaymentsPage, and anywhere a modal payment is needed.

import { Clock } from 'lucide-react';
import BottomSheetModal from './BottomSheetModal';
import InlineCheckout from './InlineCheckout';
import { useCountdown } from '../hooks/useCountdown';
import type { PaymentMethodKey } from '../constants/paymentMethods';
import '../styles/inline-checkout.css';

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
    /** Aba aberta primeiro (a forma de pagamento do contrato — um PIX abre no PIX). */
    initialMethod?: PaymentMethodKey | null;
    /** Release boleto for this checkout (per-contract authorization) */
    allowBoleto?: boolean;
    /**
     * Prazo da contratação "Aguardando pagamento" (reserva/serviço/personalizado: 10 min; renovação:
     * 3 dias). Mostra a contagem acima do checkout e chama `onDeadline` quando zera — a varredura do
     * backend desfaz a contratação, então a cobrança deixa de existir.
     */
    paymentDeadline?: string | null;
    /**
     * Status do contrato da cobrança. Quando informado, o prazo só vale enquanto for
     * AWAITING_PAYMENT — um paymentDeadline que ficou gravado num contrato já ativo não fecha o
     * checkout sozinho (regressoes-4).
     */
    contractStatus?: string | null;
    onDeadline?: () => void;
    /** Called when payment succeeds */
    onSuccess: () => void;
    /** Called when an error occurs */
    onError: (msg: string) => void;
    /** Called when user closes/cancels */
    onClose: () => void;
}

const pad = (n: number) => String(n).padStart(2, '0');

function DeadlineBar({ deadline, onExpire }: { deadline: string; onExpire?: () => void }) {
    const remaining = useCountdown(deadline, onExpire);
    if (remaining == null) return null;
    const h = Math.floor(remaining / 3600);
    const m = Math.floor((remaining % 3600) / 60);
    const s = remaining % 60;
    const clock = h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
    const level = remaining <= 60 ? 'danger' : remaining <= 180 ? 'warning' : 'calm';
    const d = new Date(deadline);
    const sameDay = d.toDateString() === new Date().toDateString();
    const until = sameDay
        ? d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
        : d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    return (
        <div className={`checkout-deadline checkout-deadline--${level}`}>
            <Clock size={16} aria-hidden="true" />
            <span className="checkout-deadline__text">Conclua o pagamento até {until}</span>
            <span className="checkout-deadline__clock" role="timer" aria-label={`Tempo restante: ${clock}`}>{clock}</span>
        </div>
    );
}

// D1: o valor do CARTÃO (sem o desconto PIX do à vista) e o aviso "o desconto vale só no PIX" são
// exibidos pelo próprio InlineCheckout (plano 1x de /stripe/installment-plans) — valor exibido = cobrado.

export default function PaymentModal({
    title = 'Pagar Fatura',
    amount,
    paymentId,
    description,
    contractDuration,
    allowedMethods = ['CARTAO', 'PIX'],
    initialMethod,
    allowBoleto = false,
    paymentDeadline,
    contractStatus,
    onDeadline,
    onSuccess,
    onError,
    onClose,
}: PaymentModalProps) {
    // regressoes-4: o prazo só vale para contratação que ainda aguarda pagamento.
    const deadline = paymentDeadline && (contractStatus == null || contractStatus === 'AWAITING_PAYMENT')
        ? paymentDeadline
        : null;
    // PaymentModal is now just a facade to BottomSheetModal
    // Note: We need to pass isOpen={true} because this component is only mounted when it should be open
    // based on how it's used in DashboardPage/ClientDashboard currently (e.g., {payingInvoice && <PaymentModal ... />})
    return (
        <BottomSheetModal isOpen={true} onClose={onClose} title={title}>
            {deadline && <DeadlineBar deadline={deadline} onExpire={onDeadline} />}
            <InlineCheckout
                amount={amount}
                paymentId={paymentId}
                description={description}
                contractDuration={contractDuration}
                allowedMethods={allowedMethods}
                initialMethod={initialMethod}
                allowBoleto={allowBoleto}
                context="invoice"
                onSuccess={onSuccess}
                onError={onError}
                onCancel={onClose}
            />
        </BottomSheetModal>
    );
}

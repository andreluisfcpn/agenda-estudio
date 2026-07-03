import BottomSheetModal from '../BottomSheetModal';
import InlineCheckout from '../InlineCheckout';

interface ChargeNowSheetProps {
    paymentId: string;
    /** Valor em centavos, já com cupom aplicado quando houver. */
    amount: number;
    description: string;
    title: string;
    subtitle: string;
    allowedMethods: ('CARTAO' | 'PIX' | 'BOLETO')[];
    allowBoleto?: boolean;
    context: 'avulso' | 'contract';
    contractDuration?: number;
    /** Mensagem de erro a exibir abaixo do checkout (opcional). */
    error?: string;
    onError: (msg: string) => void;
    onSuccess: () => void;
    /** Fechar / deixar pendente (backdrop, ESC e o botão inferior). */
    onDismiss: () => void;
    dismissLabel?: string;
}

/**
 * Sheet de cobrança imediata (admin) — embrulha o BottomSheetModal sm +
 * InlineCheckout que estava triplicado em CreateBookingModal,
 * CreateContractModal e CustomContractModal. Cobra o CLIENTE
 * (payment.userId): o backend resolve o pagador a partir do payment.
 * Apenas move JSX — as props do InlineCheckout permanecem idênticas.
 */
export default function ChargeNowSheet({
    paymentId,
    amount,
    description,
    title,
    subtitle,
    allowedMethods,
    allowBoleto,
    context,
    contractDuration,
    error,
    onError,
    onSuccess,
    onDismiss,
    dismissLabel = 'Deixar pendente (cliente paga depois)',
}: ChargeNowSheetProps) {
    return (
        <BottomSheetModal isOpen onClose={onDismiss} hideHeader size="sm" className="admin-sheet" title={title}>
            <div style={{ padding: '24px 28px' }}>
                <h3 style={{ fontSize: '1.0625rem', fontWeight: 800, margin: '0 0 4px' }}>{title}</h3>
                <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: '0 0 16px' }}>
                    {subtitle}
                </p>
                <InlineCheckout
                    amount={amount}
                    paymentId={paymentId}
                    description={description}
                    contractDuration={contractDuration}
                    allowedMethods={allowedMethods}
                    isAdmin
                    allowBoleto={allowBoleto}
                    context={context}
                    onSuccess={onSuccess}
                    onError={onError}
                    onCancel={onDismiss}
                />
                {error && <div className="admin-alert admin-alert--danger" role="alert" style={{ marginTop: 10, marginBottom: 0 }}>{error}</div>}
                <button onClick={onDismiss} className="btn-admin-ghost" style={{ marginTop: 12, width: '100%' }}>
                    {dismissLabel}
                </button>
            </div>
        </BottomSheetModal>
    );
}

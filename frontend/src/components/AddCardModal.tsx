import BottomSheetModal from './BottomSheetModal';
import StripeCardForm from './StripeCardForm';

interface AddCardModalProps {
    isOpen: boolean;
    clientSecret: string;
    onClose: () => void;
    /**
     * Cartão confirmado no Stripe. `setupIntentId` permite gravá-lo na hora (stripeApi.confirmSetupIntent),
     * sem esperar o webhook.
     */
    onSuccess: (setupIntentId?: string) => void;
    onError: (msg: string) => void;
}

export default function AddCardModal({ isOpen, clientSecret, onClose, onSuccess, onError }: AddCardModalProps) {
    return (
        <BottomSheetModal isOpen={isOpen} onClose={onClose} title="Adicionar Novo Cartão" maxWidth="400px">
            <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginBottom: '24px' }}>
                Mantenha um cartão salvo para facilitar compras e habilitar a cobrança automática das parcelas. Nenhuma cobrança é feita agora.
            </p>
            <StripeCardForm
                mode="setup"
                clientSecret={clientSecret}
                onSuccess={onSuccess}
                onError={onError}
                onCancel={onClose}
            />
        </BottomSheetModal>
    );
}

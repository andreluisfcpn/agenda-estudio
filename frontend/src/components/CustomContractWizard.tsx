import type { PricingConfig } from '../api/client';
import CustomContractFlow from './contracts/CustomContractFlow';

export interface CustomContractWizardProps {
    pricing: PricingConfig[];
    onClose: () => void;
    /** Contrato criado e fluxo encerrado (pago, ou saída sem pagar dentro do prazo de reserva). */
    onComplete: () => void;
}

/**
 * Plano personalizado — CLIENTE. Wrapper fino do fluxo compartilhado com o admin (D7):
 * mesma casca/etapas com opções restritas (só semanal, início a partir de amanhã, 1/3/6/9/12
 * ciclos), aceite de termos, CPF antes do PIX e checkout inline com o valor do backend (D9).
 */
export default function CustomContractWizard({ pricing, onClose, onComplete }: CustomContractWizardProps) {
    return <CustomContractFlow mode="client" pricing={pricing} onClose={onClose} onCreated={onComplete} />;
}

import type { PricingConfig, UserSummary } from '../../../api/client';
import CustomContractFlow from '../../contracts/CustomContractFlow';

interface CustomContractModalProps {
    isOpen: boolean;
    onClose: () => void;
    /** Chamado quando o contrato foi criado e o sheet de cobrança fechou (pago ou "Deixar pendente"). */
    onCreated: () => void;
    users: UserSummary[];
    pricing: PricingConfig[];
}

/**
 * Contrato personalizado — ADMIN. Wrapper fino do fluxo compartilhado com o cliente (D7):
 * mesma casca/etapas; o modo admin libera cliente, frequências, data de início, 1–12 ciclos,
 * plano Mensal/Integral e forma de pagamento, e termina no ChargeNowSheet (D9).
 */
export default function CustomContractModal({ isOpen, onClose, onCreated, users, pricing }: CustomContractModalProps) {
    if (!isOpen) return null;
    return <CustomContractFlow mode="admin" users={users} pricing={pricing} onClose={onClose} onCreated={onCreated} />;
}

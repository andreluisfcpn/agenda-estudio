import { Ban } from 'lucide-react';
import type { ContractWithStats } from '../api/client';
import DangerConfirmDialog from './ui/DangerConfirmDialog';
import { useBusinessConfig } from '../hooks/useBusinessConfig';
import { formatBRL } from '../utils/format';

interface CancelContractModalProps {
    isOpen: boolean;
    /** Contrato alvo — as consequências são montadas a partir dele (gravações, pagamentos, créditos). */
    contract: ContractWithStats | null;
    onClose: () => void;
    /**
     * Envia o pedido (POST /contracts/:id/request-cancellation). NÃO capture o erro:
     * se lançar, a mensagem aparece dentro do diálogo e ele continua aberto.
     */
    onConfirm: () => Promise<void>;
}

/** Gravações ainda por acontecer (o backend cancela as de hoje em diante). */
const UPCOMING_STATUSES = new Set(['RESERVED', 'CONFIRMED', 'HELD']);

/** Data-calendário de HOJE em São Paulo, 'YYYY-MM-DD'. */
const todaySP = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Cliente solicita o cancelamento antecipado do contrato (D3: ação destrutiva → tom danger).
 *
 * Consequências conforme o backend (contract.lifecycle.ts):
 *  - request-cancellation: contrato → PENDING_CANCELLATION e TODAS as gravações de hoje em
 *    diante são canceladas na hora (horários liberados) — não voltam, mesmo com isenção;
 *  - resolve-cancellation (estúdio): multa de `cancellation_fine_pct`% sobre a soma do VALOR (`amount`)
 *    das cobranças PAGAS do contrato — o valor contratado de cada uma, sem os juros do parcelamento nem a
 *    diferença do desconto PIX quando paga no cartão (sem nada pago → sem multa) — ou isenção; em ambos os
 *    casos as parcelas pendentes são anuladas. A multa exibida aqui é exatamente essa conta.
 */
export default function CancelContractModal({ isOpen, contract, onClose, onConfirm }: CancelContractModalProps) {
    const { get: getRule } = useBusinessConfig();
    const finePct = getRule('cancellation_fine_pct');

    const consequences: string[] = [];
    if (contract) {
        const today = todaySP();
        const upcoming = (contract.bookings || []).filter(b => UPCOMING_STATUSES.has(b.status) && b.date.slice(0, 10) >= today).length;
        // Mesma base do backend (contract.lifecycle.ts, resolve-cancellation): Σ amount das cobranças PAGAS.
        const paid = (contract.payments || []).filter(p => p.status === 'PAID').reduce((s, p) => s + p.amount, 0);
        const fine = Math.round(paid * finePct / 100);

        if (upcoming > 0) {
            consequences.push(
                `${plural(upcoming, 'gravação agendada', 'gravações agendadas')} de hoje em diante ${upcoming === 1 ? 'é cancelada' : 'são canceladas'} na hora e ${upcoming === 1 ? 'o horário fica livre' : 'os horários ficam livres'} para outros clientes — mesmo que o estúdio isente a multa, ${upcoming === 1 ? 'ela não volta' : 'elas não voltam'}.`,
            );
        }
        if (contract.type === 'FLEX' && (contract.flexCreditsRemaining ?? 0) > 0) {
            const n = contract.flexCreditsRemaining ?? 0;
            consequences.push(`${plural(n, 'crédito de gravação não usado deixa', 'créditos de gravação não usados deixam')} de valer.`);
        }
        consequences.push(
            fine > 0
                ? `O estúdio pode cobrar multa de ${finePct}% sobre o valor das parcelas já pagas deste contrato (${formatBRL(fine)}) ou isentá-la.`
                : 'Como não há pagamento confirmado neste contrato, não há multa a cobrar.',
        );
        consequences.push('O contrato fica como “Cancelamento pendente” até o estúdio concluir; nessa conclusão, as parcelas pendentes são anuladas.');
        consequences.push('Depois de enviado, o pedido não pode ser desfeito pelo app.');
    }

    return (
        <DangerConfirmDialog
            isOpen={isOpen && !!contract}
            tone="danger"
            icon={Ban}
            title="Solicitar o cancelamento?"
            description={contract ? `Contrato “${contract.name}”. O estúdio analisa o pedido e conclui o cancelamento.` : undefined}
            consequences={consequences}
            confirmLabel="Solicitar cancelamento"
            cancelLabel="Manter contrato"
            loadingLabel="Enviando pedido…"
            onConfirm={onConfirm}
            onClose={onClose}
        />
    );
}

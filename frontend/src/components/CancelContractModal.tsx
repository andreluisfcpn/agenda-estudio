import { Ban } from 'lucide-react';
import type { ContractWithStats } from '../api/client';
import DangerConfirmDialog from './ui/DangerConfirmDialog';
import { formatBRL } from '../utils/format';

interface CancelContractModalProps {
    isOpen: boolean;
    /** Contrato alvo — as consequências são montadas a partir dele (gravações, multa, créditos). */
    contract: ContractWithStats | null;
    onClose: () => void;
    /**
     * Envia o pedido (POST /contracts/:id/request-cancellation). NÃO capture o erro:
     * se lançar, a mensagem aparece dentro do diálogo e ele continua aberto.
     */
    onConfirm: () => Promise<void>;
}

/** Gravações que o pedido cancela: ainda por acontecer (nunca as realizadas/faltas). */
const UPCOMING_STATUSES = new Set(['RESERVED', 'CONFIRMED', 'HELD']);

/** Relógio de São Paulo agora: data 'YYYY-MM-DD' e hora 'HH:MM'. */
function nowSP(): { date: string; time: string } {
    const now = new Date();
    return {
        date: new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(now),
        time: new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now),
    };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Cliente solicita o cancelamento antecipado do contrato (D3: ação destrutiva → tom danger).
 *
 * Consequências conforme o backend (contract.lifecycle.ts — E13):
 *  - request-cancellation: contrato → PENDING_CANCELLATION; as gravações que ainda NÃO aconteceram (início
 *    futuro no relógio de SP, sem gravação iniciada) são canceladas na hora e não voltam, mesmo com isenção;
 *    o PERCENTUAL da multa é congelado neste pedido: `cancellation_fine_pct`% do que FALTA PAGAR do plano
 *    (parcelas do plano ainda não pagas; extras de gravação não entram). Parcela da base paga durante a análise
 *    sai da conta — a multa nunca aumenta. Plano quitado → sem multa e sem devolução automática; percentual
 *    em 0% → sem multa mesmo com parcelas em aberto.
 *  - enquanto o pedido está em análise, as parcelas do plano ficam suspensas (nem cobradas nem pagáveis);
 *  - resolve-cancellation (estúdio): cobra a multa (vira uma cobrança pendente em Pagamentos, nunca debitada
 *    sozinha) ou isenta; em ambos os casos as parcelas pendentes são anuladas.
 * A multa exibida é a do backend (`fineAmountPreview` / `fineBaseAmount` / `finePct` de GET /contracts/my).
 */
export default function CancelContractModal({ isOpen, contract, onClose, onConfirm }: CancelContractModalProps) {
    const consequences: string[] = [];
    if (contract) {
        const { date: today, time: nowTime } = nowSP();
        const upcoming = (contract.bookings || []).filter(b => {
            if (!UPCOMING_STATUSES.has(b.status) || b.recordingStartedAt) return false;
            const day = b.date.slice(0, 10);
            return day > today || (day === today && b.startTime > nowTime);
        }).length;
        const fine = contract.fineAmountPreview ?? 0;
        const base = contract.fineBaseAmount ?? 0;
        const pct = contract.finePct ?? 0;

        if (upcoming > 0) {
            consequences.push(
                `${plural(upcoming, 'gravação agendada', 'gravações agendadas')} que ainda não ${upcoming === 1 ? 'aconteceu é cancelada' : 'aconteceram são canceladas'} na hora e ${upcoming === 1 ? 'o horário fica livre' : 'os horários ficam livres'} para outros clientes — mesmo que o estúdio isente a multa, ${upcoming === 1 ? 'ela não volta' : 'elas não voltam'}.`,
            );
        }
        if (contract.type === 'FLEX' && (contract.flexCreditsRemaining ?? 0) > 0) {
            const n = contract.flexCreditsRemaining ?? 0;
            consequences.push(`${plural(n, 'crédito de gravação não usado deixa', 'créditos de gravação não usados deixam')} de valer.`);
        }
        // Multa zero tem dois motivos diferentes — só diz "não há parcelas em aberto" quando a base é mesmo zero
        // (com parcelas em aberto e multa zero, o percentual configurado é 0%).
        const noRefund = (contract.paidTotal ?? 0) > 0 ? ' O que já foi pago não é devolvido automaticamente.' : '';
        consequences.push(
            fine > 0
                ? `O estúdio pode cobrar multa de ${pct}% sobre o que falta pagar do plano: ${formatBRL(fine)} (${pct}% de ${formatBRL(base)}) — ou isentá-la. O percentual fica congelado neste pedido; se uma parcela for paga antes da decisão, ela sai da conta.`
                : base > 0
                    ? `Não há multa para este cancelamento.${noRefund}`
                    : `Não há multa: não há parcelas do plano em aberto neste contrato.${noRefund}`,
        );
        if (fine > 0) {
            consequences.push('Se o estúdio cobrar a multa, ela aparece em Pagamentos para você pagar por PIX ou cartão — não é debitada automaticamente.');
        }
        consequences.push('O contrato fica com o “cancelamento em análise” até o estúdio concluir: nesse período as parcelas do plano ficam suspensas (não são cobradas nem podem ser pagas) e, na conclusão, as pendentes são anuladas.');
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

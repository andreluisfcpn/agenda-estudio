import { bookingsApi, BookingWithUser } from '../../../api/client';
import { BOOKING_STATUS_META, getMeta } from '../../../constants/adminMeta';
import { makeupDeadlineDdmm } from '../../../utils/avulsoMakeup';

/**
 * Ações destrutivas de agendamento (D3) — textos de consequência e a chamada de cancelamento,
 * compartilhados por Agendamentos (select inline + excluir), Editar agendamento e Hoje.
 * As consequências espelham o que o backend faz de fato (booking.management.ts).
 */

/** Sessão ainda não realizada: cancelar devolve o horário (e o crédito, quando o contrato tem). */
const PRE_SESSION = new Set(['RESERVED', 'HELD', 'CONFIRMED']);
export const isPreSessionStatus = (status: string) => PRE_SESSION.has(status);

type DangerBooking = Pick<BookingWithUser, 'date' | 'startTime' | 'endTime' | 'status' | 'contract' | 'makeupStatus' | 'makeupDeadline'> & {
    user: { name: string };
};

const ddmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const ddmmyyyy = (iso: string) => `${ddmm(iso)}/${iso.slice(0, 4)}`;

/** "Ana Souza · 24/09/2026 às 10:00–12:00 · Plano Flex" (linha de identificação no diálogo). */
export function bookingSummary(b: DangerBooking): string {
    const when = `${ddmmyyyy(b.date)} às ${b.startTime}${b.endTime ? `–${b.endTime}` : ''}`;
    return [b.user.name, when, b.contract?.name].filter(Boolean).join(' · ');
}

/** Tipo do contrato como string (a união tipada do front não inclui CUSTOM, mas a API devolve). */
const contractType = (b: DangerBooking) => (b.contract?.type ?? null) as string | null;

/** Contratos que devolvem crédito ao cancelar/excluir uma sessão não realizada (restoreCredit). */
function creditBackLine(b: DangerBooking): string | null {
    if (!b.contract || !isPreSessionStatus(b.status)) return null;
    const t = contractType(b);
    if (t === 'FLEX' || t === 'AVULSO') return `1 crédito volta para o contrato "${b.contract.name}".`;
    if (t === 'CUSTOM') return `Se o contrato "${b.contract.name}" controla créditos, 1 crédito volta para ele.`;
    return null;
}

/**
 * Consequências de CANCELAR. Sessão não realizada (Reservado/Confirmado) vai pelo cancelamento
 * canônico (DELETE /bookings/:id: libera o horário e devolve o crédito); já realizada/falta/não
 * realizada vai pelo PATCH de status (não mexe em crédito, retira a remarcação aberta do avulso).
 */
export function cancelBookingConsequences(b: DangerBooking): string[] {
    const out: string[] = [];
    if (isPreSessionStatus(b.status)) {
        out.push('O agendamento passa para "Cancelado" e continua no histórico.');
        out.push(`O horário de ${ddmm(b.date)} às ${b.startTime} volta a ficar livre na agenda.`);
        const credit = creditBackLine(b);
        if (credit) out.push(credit);
    } else {
        out.push(`O agendamento passa de "${getMeta(BOOKING_STATUS_META, b.status).label}" para "Cancelado" (o registro continua no histórico).`);
        if (b.status === 'COMPLETED') out.push('A sessão deixa de contar como gravação realizada.');
        const t = contractType(b);
        // Avulso não entra: a "sessão" dele é o próprio valor pago (coberto pela linha de estorno abaixo).
        if (b.contract && (t === 'FLEX' || t === 'CUSTOM') && b.status !== 'NAO_REALIZADO') {
            out.push(`O crédito já usado por esta sessão não volta para o contrato "${b.contract.name}".`);
        }
        if (t === 'AVULSO' && b.makeupStatus === 'OPEN') {
            out.push(b.makeupDeadline
                ? `A remarcação liberada até ${makeupDeadlineDdmm(b.makeupDeadline)} é retirada.`
                : 'A remarcação liberada para o cliente é retirada.');
        }
    }
    out.push('Nenhum pagamento é estornado automaticamente.');
    return out;
}

/** Consequências da EXCLUSÃO PERMANENTE (DELETE /bookings/:id/hard-delete). */
export function hardDeleteConsequences(b: DangerBooking): string[] {
    const out = ['O agendamento é apagado de vez: some da agenda, do histórico do cliente e das métricas, como se nunca tivesse existido.'];
    if (b.status === 'RESERVED' || b.status === 'CONFIRMED') {
        out.push(`O horário de ${ddmm(b.date)} às ${b.startTime} volta a ficar livre na agenda.`);
    }
    const credit = creditBackLine(b);
    if (credit) out.push(credit);
    out.push('Se houver pagamento ligado a ele, o pagamento continua no Financeiro, sem o vínculo com a gravação.');
    return out;
}

/**
 * Executa o cancelamento pela rota certa (ver cancelBookingConsequences). Lança o erro da API
 * (o DangerConfirmDialog mostra dentro dele). `booking` vem só do PATCH (campos de remarcação atualizados).
 */
export async function cancelBookingRequest(b: Pick<BookingWithUser, 'id' | 'status'>): Promise<{ booking?: BookingWithUser }> {
    if (isPreSessionStatus(b.status)) {
        await bookingsApi.cancel(b.id);
        return {};
    }
    const res = await bookingsApi.update(b.id, { status: 'CANCELLED' });
    return { booking: res.booking };
}

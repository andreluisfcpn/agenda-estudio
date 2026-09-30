// ─── Visão do CLIENTE sobre a própria gravação ──────────
// Fonte ÚNICA do que as rotas do cliente devolvem de uma reserva (GET /my, GET /:id, myBookings do
// GET /availability e as respostas de client-update / reschedule / makeup). Tudo que é "do cliente"
// passa por CLIENT_BOOKING_SELECT + toClientBooking, para que:
//   - a nota INTERNA do admin (adminNotes) NUNCA saia para o cliente (E11) — ela simplesmente não
//     está no select; quem precisa dela usa as rotas do admin;
//   - todas as telas recebam os MESMOS campos de exibição (título/capa/contrato/métricas), e o card
//     da semana não regrida para o nome da faixa (E12);
//   - "gravando agora" e "pode editar" sejam derivados num lugar só (E11/E12).

import { BookingStatus, Prisma } from '../../generated/prisma/client.js';

export const CLIENT_BOOKING_SELECT = {
    id: true,
    date: true,
    startTime: true,
    endTime: true,
    status: true,
    tierApplied: true,
    price: true,
    contractId: true,
    // Feedback do estúdio ao cliente (escrito pelo admin na finalização). adminNotes fica DE FORA.
    clientNotes: true,
    // Episódio (editável pelo cliente enquanto a gravação não foi finalizada/cancelada).
    episodeTitle: true,
    episodeDescription: true,
    coverImageUrl: true,
    platforms: true,
    // Resultado da gravação (preenchido pelo estúdio ao finalizar).
    platformLinks: true,
    durationMinutes: true,
    peakViewers: true,
    chatMessages: true,
    audienceOrigin: true,
    isLivestream: true,
    streamMetrics: true,
    // "Iniciar Gravação" (o operador fica de fora: recordingStartedById/Name são internos).
    recordingStartedAt: true,
    addOns: true,
    holdExpiresAt: true,
    originalDate: true,
    // Motivo da falta/não realização + janela de remarcação do avulso (D4/D5).
    statusReason: true,
    makeupStatus: true,
    makeupDeadline: true,
    missedDate: true,
    contract: {
        select: { id: true, name: true, type: true, tier: true, discountPct: true, addOns: true },
    },
} satisfies Prisma.BookingSelect;

export type ClientBookingRow = Prisma.BookingGetPayload<{ select: typeof CLIENT_BOOKING_SELECT }>;

/**
 * Teto de segurança do "gravando agora": se o operador esquecer de finalizar, o selo "AO VIVO" do
 * cliente some sozinho depois deste tempo contado do "Iniciar Gravação" (uma sessão ocupa 2h de grade).
 */
export const RECORDING_LIVE_MAX_HOURS = 6;

/**
 * "Gravando agora" (E11): reserva CONFIRMED cuja gravação foi iniciada pelo estúdio ("Iniciar
 * Gravação") e ainda não foi finalizada (finalizar leva o status a COMPLETED). NÃO é o mesmo que
 * isLivestream — este é um atributo permanente ("foi transmitida ao vivo").
 */
export function isRecordingNow(
    b: { status: BookingStatus; recordingStartedAt: Date | null },
    now: Date = new Date(),
): boolean {
    if (b.status !== BookingStatus.CONFIRMED || !b.recordingStartedAt) return false;
    const elapsedMs = now.getTime() - b.recordingStartedAt.getTime();
    return elapsedMs < RECORDING_LIVE_MAX_HOURS * 3_600_000;
}

/** Status em que o cliente ainda pode editar as informações do episódio e a capa (E12). */
export const CLIENT_EDITABLE_STATUSES: BookingStatus[] = [
    BookingStatus.RESERVED,
    BookingStatus.HELD,
    BookingStatus.CONFIRMED,
];

/**
 * Por que o cliente NÃO pode mais editar as informações da gravação — ou null quando pode.
 * Regra (E12): só enquanto a reserva está RESERVED/HELD/CONFIRMED; finalizada, cancelada ou marcada
 * como falta/não realizada vira somente leitura. É a mensagem do 409 de client-update e cover-image.
 */
export function clientEditBlockReason(status: BookingStatus): string | null {
    switch (status) {
        case BookingStatus.RESERVED:
        case BookingStatus.HELD:
        case BookingStatus.CONFIRMED:
            return null;
        case BookingStatus.COMPLETED:
            return 'Esta gravação já foi finalizada pelo estúdio. As informações do episódio não podem mais ser alteradas.';
        case BookingStatus.CANCELLED:
            return 'Este agendamento foi cancelado. As informações do episódio não podem mais ser alteradas.';
        case BookingStatus.FALTA:
        case BookingStatus.NAO_REALIZADO:
            return 'Esta gravação não foi realizada. As informações do episódio só podem ser alteradas depois que ela for remarcada.';
        default:
            return 'As informações desta gravação não podem mais ser alteradas.';
    }
}

/** Reserva do cliente + campos derivados (mesma forma em todas as rotas do cliente). */
export function toClientBooking(b: ClientBookingRow, now: Date = new Date()) {
    const editBlockedReason = clientEditBlockReason(b.status);
    // Fim da gravação: não há coluna própria — a finalização grava a duração (derivada do intervalo
    // Iniciar→Finalizar, ou informada pelo operador). Logo fim = início + duração, só em COMPLETED.
    const recordingFinishedAt =
        b.status === BookingStatus.COMPLETED && b.recordingStartedAt && b.durationMinutes != null
            ? new Date(b.recordingStartedAt.getTime() + b.durationMinutes * 60_000)
            : null;
    return {
        ...b,
        isRecordingNow: isRecordingNow(b, now),
        recordingFinishedAt,
        canEditEpisode: editBlockedReason === null,
        editBlockedReason,
    };
}

export type ClientBooking = ReturnType<typeof toClientBooking>;

import { describe, it, expect } from 'vitest';
import {
    CLIENT_BOOKING_SELECT,
    RECORDING_LIVE_MAX_HOURS,
    clientEditBlockReason,
    isRecordingNow,
    toClientBooking,
    type ClientBookingRow,
} from '../src/modules/bookings/booking.clientView';
import { clientUpdateBookingSchema } from '../src/modules/bookings/validators';

// Unit puro (sem banco): a visão do cliente sobre a própria gravação — E11 (nota interna nunca sai,
// "gravando agora" só entre Iniciar e Finalizar) e E12 (quando o cliente pode editar o episódio).

const NOW = new Date('2026-09-30T15:00:00Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

function row(over: Partial<ClientBookingRow> = {}): ClientBookingRow {
    return {
        id: 'b1', date: new Date('2026-09-30T00:00:00Z'), startTime: '10:00', endTime: '12:00',
        status: 'CONFIRMED', tierApplied: 'COMERCIAL', price: 30000, contractId: 'c1',
        clientNotes: null, episodeTitle: null, episodeDescription: null, coverImageUrl: null,
        platforms: null, platformLinks: null, durationMinutes: null, peakViewers: null, chatMessages: null,
        audienceOrigin: null, isLivestream: null, streamMetrics: null, recordingStartedAt: null,
        addOns: [], holdExpiresAt: null, originalDate: null, statusReason: null,
        makeupStatus: null, makeupDeadline: null, missedDate: null,
        contract: { id: 'c1', name: 'Plano', type: 'FLEX', tier: 'COMERCIAL', discountPct: 30, addOns: [] },
        ...over,
    };
}

describe('CLIENT_BOOKING_SELECT', () => {
    it('não seleciona a nota interna nem os dados do operador', () => {
        const keys = Object.keys(CLIENT_BOOKING_SELECT);
        expect(keys).not.toContain('adminNotes');
        expect(keys).not.toContain('recordingStartedById');
        expect(keys).not.toContain('recordingStartedByName');
        expect(keys).not.toContain('userId');
    });

    it('traz o feedback do estúdio, o episódio, as métricas e o contrato do card', () => {
        expect(CLIENT_BOOKING_SELECT).toMatchObject({
            clientNotes: true, episodeTitle: true, episodeDescription: true, coverImageUrl: true,
            platforms: true, platformLinks: true, streamMetrics: true, isLivestream: true,
            durationMinutes: true, peakViewers: true, chatMessages: true, audienceOrigin: true,
            recordingStartedAt: true,
            contract: { select: { id: true, name: true, type: true, tier: true } },
        });
    });
});

describe('isRecordingNow', () => {
    it('só CONFIRMED com gravação iniciada', () => {
        expect(isRecordingNow({ status: 'CONFIRMED', recordingStartedAt: minutesAgo(30) }, NOW)).toBe(true);
        expect(isRecordingNow({ status: 'CONFIRMED', recordingStartedAt: null }, NOW)).toBe(false);
        for (const status of ['RESERVED', 'HELD', 'COMPLETED', 'FALTA', 'NAO_REALIZADO', 'CANCELLED'] as const) {
            expect(isRecordingNow({ status, recordingStartedAt: minutesAgo(30) }, NOW), status).toBe(false);
        }
    });

    it('teto de segurança: início esquecido deixa de contar depois de RECORDING_LIVE_MAX_HOURS', () => {
        const limit = RECORDING_LIVE_MAX_HOURS * 60;
        expect(isRecordingNow({ status: 'CONFIRMED', recordingStartedAt: minutesAgo(limit - 1) }, NOW)).toBe(true);
        expect(isRecordingNow({ status: 'CONFIRMED', recordingStartedAt: minutesAgo(limit) }, NOW)).toBe(false);
        expect(isRecordingNow({ status: 'CONFIRMED', recordingStartedAt: minutesAgo(limit + 600) }, NOW)).toBe(false);
    });
});

describe('clientEditBlockReason', () => {
    it('libera RESERVED/HELD/CONFIRMED e explica o bloqueio dos demais', () => {
        for (const s of ['RESERVED', 'HELD', 'CONFIRMED'] as const) expect(clientEditBlockReason(s)).toBeNull();
        expect(clientEditBlockReason('COMPLETED')).toMatch(/finalizada/);
        expect(clientEditBlockReason('CANCELLED')).toMatch(/cancelado/);
        expect(clientEditBlockReason('FALTA')).toMatch(/não foi realizada/);
        expect(clientEditBlockReason('NAO_REALIZADO')).toMatch(/não foi realizada/);
    });
});

describe('toClientBooking', () => {
    it('gravação em andamento: isRecordingNow, sem fim, ainda editável', () => {
        const v = toClientBooking(row({ recordingStartedAt: minutesAgo(10) }), NOW);
        expect(v).toMatchObject({ isRecordingNow: true, recordingFinishedAt: null, canEditEpisode: true, editBlockedReason: null });
    });

    it('finalizada: fim = início + duração; transmitida ao vivo não é "gravando agora"; somente leitura', () => {
        const start = minutesAgo(200);
        const v = toClientBooking(row({ status: 'COMPLETED', recordingStartedAt: start, durationMinutes: 95, isLivestream: true }), NOW);
        expect(v.isRecordingNow).toBe(false);
        expect(v.recordingFinishedAt?.toISOString()).toBe(new Date(start.getTime() + 95 * 60_000).toISOString());
        expect(v.canEditEpisode).toBe(false);
        expect(v.editBlockedReason).toMatch(/finalizada/);
    });

    it('sem duração ou sem início registrado não inventa o fim', () => {
        expect(toClientBooking(row({ status: 'COMPLETED', recordingStartedAt: minutesAgo(200) }), NOW).recordingFinishedAt).toBeNull();
        expect(toClientBooking(row({ status: 'COMPLETED', durationMinutes: 90 }), NOW).recordingFinishedAt).toBeNull();
        // Duração só vira "fim" depois de finalizar.
        expect(toClientBooking(row({ recordingStartedAt: minutesAgo(10), durationMinutes: 5 }), NOW).recordingFinishedAt).toBeNull();
    });
});

describe('clientUpdateBookingSchema', () => {
    it('normaliza título (uma linha), descrição (trim) e redes (conhecidas, sem repetição)', () => {
        expect(clientUpdateBookingSchema.parse({
            episodeTitle: '  Meu\n episódio \t 1 ', episodeDescription: '\n Linha 1\nLinha 2 \n',
            platforms: JSON.stringify(['FACEBOOK', 'YOUTUBE', 'FACEBOOK']),
        })).toEqual({
            episodeTitle: 'Meu episódio 1', episodeDescription: 'Linha 1\nLinha 2',
            platforms: JSON.stringify(['YOUTUBE', 'FACEBOOK']),
        });
    });

    it('vazio/null limpam; ausente fica ausente', () => {
        expect(clientUpdateBookingSchema.parse({ episodeTitle: ' ', episodeDescription: null })).toEqual({ episodeTitle: null, episodeDescription: null });
        const empty = clientUpdateBookingSchema.parse({});
        expect(empty.episodeTitle).toBeUndefined();
        expect(empty.episodeDescription).toBeUndefined();
        expect(empty.platforms).toBeUndefined();
    });

    it('descarta o que o cliente não pode escrever (feedback, nota interna, métricas, status)', () => {
        const parsed = clientUpdateBookingSchema.parse({
            episodeTitle: 'ok', clientNotes: 'x', adminNotes: 'y', durationMinutes: 10, peakViewers: 5,
            chatMessages: 5, audienceOrigin: 'z', streamMetrics: '{}', platformLinks: '{}', status: 'COMPLETED',
        });
        expect(parsed).toEqual({ episodeTitle: 'ok' });
    });

    it('recusa limites estourados e redes inválidas com mensagem em pt-BR', () => {
        const msg = (input: unknown) => {
            const r = clientUpdateBookingSchema.safeParse(input);
            return r.success ? null : r.error.errors[0].message;
        };
        expect(msg({ episodeTitle: 'x'.repeat(141) })).toMatch(/título.*140/i);
        // O limite conta o texto já normalizado.
        expect(msg({ episodeTitle: ` ${'x'.repeat(140)} ` })).toBeNull();
        expect(msg({ episodeDescription: 'x'.repeat(4001) })).toMatch(/descrição.*4000/i);
        expect(msg({ episodeTitle: 5 })).toBe('Título inválido.');
        for (const platforms of ['', 'YOUTUBE', '{"YOUTUBE":1}', '["ORKUT"]', '[1]', 'null', ['YOUTUBE'], 7]) {
            expect(msg({ platforms }), JSON.stringify(platforms)).toBe('Redes de transmissão inválidas.');
        }
        expect(msg({ platforms: '[]' })).toBeNull();
    });
});

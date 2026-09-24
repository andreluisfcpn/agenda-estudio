// ─── Booking Business Logic Service ─────────────────────
// Extracted from routes.ts — handles credit management,
// conflict detection, and booking lifecycle operations.

import { prisma } from '../../lib/prisma.js';
import { acquireMultiSlotLock, releaseMultiSlotLock } from '../../lib/redis.js';
import { BookingStatus, Tier } from '../../generated/prisma/client.js';
import { getPackageSlots, getSlotDuration, getSlotTier, isOperatingDay, calculateEndTime } from '../../utils/pricing.js';

// ─── Blocked Slots ─────────────────────────────────────

/**
 * Retorna true se algum dos `packageSlots` (["HH:mm", ...]) cai dentro de um intervalo
 * bloqueado (BlockedSlot) na data. Usado para revalidar bloqueios no MOMENTO da reserva —
 * a disponibilidade só os esconde na UI; sem esta checagem era possível reservar por cima
 * de um horário bloqueado (manutenção/double-booking).
 */
export async function hasBlockedConflict(dateObj: Date, packageSlots: string[]): Promise<boolean> {
    const blocked = await prisma.blockedSlot.findMany({
        where: { date: dateObj },
        select: { startTime: true, endTime: true },
    });
    if (blocked.length === 0) return false;
    const blockedSet = new Set<string>();
    for (const b of blocked) {
        const [sH, sM] = b.startTime.split(':').map(Number);
        const [eH, eM] = b.endTime.split(':').map(Number);
        let m = sH * 60 + sM;
        const end = eH * 60 + eM;
        while (m < end) {
            blockedSet.add(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
            m += 30;
        }
    }
    return packageSlots.some(s => blockedSet.has(s));
}

// ─── Credit Management ─────────────────────────────────

/** Restore a single credit to a Flex or Custom contract (atomic). */
export async function restoreCredit(contractId: string): Promise<boolean> {
    const contract = await prisma.contract.findUnique({
        where: { id: contractId },
        select: { type: true, customCreditsRemaining: true },
    });
    if (!contract) return false;

    if (contract.type === 'FLEX' || contract.type === 'AVULSO') {
        // Atomic increment avoids lost updates under concurrent cancellations.
        await prisma.contract.update({
            where: { id: contractId },
            data: { flexCreditsRemaining: { increment: 1 } },
        });
        return true;
    }

    if (contract.type === 'CUSTOM' && contract.customCreditsRemaining != null) {
        await prisma.contract.update({
            where: { id: contractId },
            data: { customCreditsRemaining: { increment: 1 } },
        });
        return true;
    }

    return false;
}

/** Deduct a single credit from a Flex or Custom contract (atomic, guarded > 0). */
export async function deductCredit(contractId: string): Promise<boolean> {
    const contract = await prisma.contract.findUnique({
        where: { id: contractId },
        select: { type: true },
    });
    if (!contract) return false;

    if (contract.type === 'FLEX' || contract.type === 'AVULSO') {
        const r = await prisma.contract.updateMany({
            where: { id: contractId, flexCreditsRemaining: { gt: 0 } },
            data: { flexCreditsRemaining: { decrement: 1 } },
        });
        return r.count > 0;
    }

    if (contract.type === 'CUSTOM') {
        const r = await prisma.contract.updateMany({
            where: { id: contractId, customCreditsRemaining: { gt: 0 } },
            data: { customCreditsRemaining: { decrement: 1 } },
        });
        return r.count > 0;
    }

    return false;
}

// ─── Conflict Detection ─────────────────────────────────

/** Check if a time slot conflicts with existing bookings on a date. */
export async function hasConflict(
    dateObj: Date,
    startTime: string,
    excludeBookingId?: string
): Promise<boolean> {
    const packageSlots = getPackageSlots(startTime);
    const where: any = {
        date: dateObj,
        status: { not: BookingStatus.CANCELLED },
        OR: packageSlots.map(slot => ({
            startTime: { lte: slot },
            endTime: { gt: slot },
        })),
    };

    if (excludeBookingId) {
        where.id = { not: excludeBookingId };
    }

    const conflicting = await prisma.booking.findFirst({ where });
    return !!conflicting;
}

// ─── Moving a booking (reschedule / makeup) ─────────────
// Shared by PATCH /:id/reschedule (cliente) and PATCH /:id/makeup (remarcação da falta do avulso,
// lib/avulsoMakeup.ts) so both apply the SAME slot rules, lock and conflict checks.

/** 409 ao mover uma reserva: trava do slot ocupada, conflito com outra reserva ou horário bloqueado. */
export class SlotUnavailableError extends Error {
    readonly httpStatus = 409;
    constructor(message: string) {
        super(message);
        this.name = 'SlotUnavailableError';
    }
}

/**
 * Valida o destino de uma movimentação de reserva: dia de funcionamento, horário da grade e MESMA
 * faixa da reserva original (o valor pago é o da faixa). Retorna a mensagem de erro (400) ou null.
 */
export async function checkMoveSlotTier(date: string, startTime: string, expectedTier: Tier): Promise<string | null> {
    const dayOfWeek = new Date(date + 'T00:00:00Z').getUTCDay();
    if (!(await isOperatingDay(dayOfWeek))) return 'O estúdio não funciona neste dia da semana.';
    const newTier = await getSlotTier(dayOfWeek, startTime);
    if (!newTier) return 'Horário fora da grade de operação.';
    if (newTier !== expectedTier) {
        return `O reagendamento deve manter a mesma faixa (${expectedTier}). O horário selecionado é ${newTier}.`;
    }
    return null;
}

/**
 * Tranca o slot de DESTINO (Redis, mesmo acquireMultiSlotLock do POST /), confere conflito com outras
 * reservas (excluindo a própria) e horário bloqueado, e só então executa `write`, liberando a trava
 * no fim. Fecha a janela TOCTOU entre a checagem e a gravação (B3). Lança SlotUnavailableError (409).
 */
export async function withMovableSlot<T>(
    opts: { date: string; startTime: string; lockOwner: string; excludeBookingId: string },
    write: (ctx: { dateObj: Date; endTime: string; packageSlots: string[] }) => Promise<T>,
): Promise<T> {
    const slotDur = await getSlotDuration();
    const packageSlots = getPackageSlots(opts.startTime, slotDur);
    const locked = await acquireMultiSlotLock(opts.date, packageSlots, opts.lockOwner);
    if (!locked) {
        throw new SlotUnavailableError('Este horário está sendo reservado por outra pessoa. Tente novamente em instantes.');
    }
    try {
        const dateObj = new Date(opts.date + 'T00:00:00Z');
        const conflicting = await prisma.booking.findFirst({
            where: {
                id: { not: opts.excludeBookingId },
                date: dateObj,
                status: { not: BookingStatus.CANCELLED },
                OR: packageSlots.map(slot => ({
                    startTime: { lte: slot },
                    endTime: { gt: slot },
                })),
            },
            select: { id: true },
        });
        if (conflicting) throw new SlotUnavailableError('O horário selecionado já está ocupado.');
        // Não mover para dentro de um horário bloqueado (manutenção).
        if (await hasBlockedConflict(dateObj, packageSlots)) {
            throw new SlotUnavailableError('Este horário está bloqueado (indisponível). Escolha outro.');
        }
        return await write({ dateObj, endTime: calculateEndTime(opts.startTime, slotDur), packageSlots });
    } finally {
        await releaseMultiSlotLock(opts.date, packageSlots, opts.lockOwner);
    }
}

// ─── Avulso: nome e vigência acompanham a gravação ──────

/** Nome do micro-contrato avulso: "Avulso DD/MM/AAAA às HH:MM" (`dateYmd` = "YYYY-MM-DD"). */
export function avulsoContractName(dateYmd: string, startTime: string, connector: 'às' | 'as' = 'às'): string {
    const [y, m, d] = dateYmd.slice(0, 10).split('-');
    return `Avulso ${d}/${m}/${y} ${connector} ${startTime}`;
}

/** Nome gerado automaticamente na criação do avulso (conector com ou sem acento). */
const AUTO_AVULSO_NAME = /^Avulso \d{2}\/\d{2}\/\d{4} (às|as) \d{2}:\d{2}$/;

/**
 * Avulso: quando a gravação muda de data/horário (PATCH admin com date/startTime, /reschedule e
 * /makeup), a vigência do micro-contrato (startDate = endDate = dia da gravação) e o nome gerado
 * ("Avulso DD/MM/AAAA às HH:MM") passam a refletir a gravação — a lista e o detalhe acompanham.
 *  - Só contrato AVULSO: qualquer outro tipo (inclusive o FLEX-1 legado) é no-op.
 *  - Nome fora do padrão gerado é mantido; o conector do nome atual ("às"/"as") é preservado, para
 *    não misturar formatos na lista.
 *  - Idempotente e best-effort: nunca lança (a gravação já foi movida). Retorna true se gravou algo.
 * `slot.date`: a data da gravação (@db.Date à 00:00Z) ou "YYYY-MM-DD".
 */
export async function syncAvulsoContractSchedule(
    contractId: string | null | undefined,
    slot: { date: Date | string; startTime: string },
): Promise<boolean> {
    if (!contractId) return false;
    try {
        const c = await prisma.contract.findUnique({
            where: { id: contractId },
            select: { type: true, name: true, startDate: true, endDate: true },
        });
        if (!c || c.type !== 'AVULSO') return false;

        const ymd = typeof slot.date === 'string' ? slot.date.slice(0, 10) : slot.date.toISOString().slice(0, 10);
        const day = new Date(ymd + 'T00:00:00Z');
        if (Number.isNaN(day.getTime())) return false;

        const data: { startDate?: Date; endDate?: Date; name?: string } = {};
        if (c.startDate.getTime() !== day.getTime()) data.startDate = day;
        if (c.endDate.getTime() !== day.getTime()) data.endDate = day;
        const auto = AUTO_AVULSO_NAME.exec(c.name);
        if (auto) {
            const name = avulsoContractName(ymd, slot.startTime, auto[1] as 'às' | 'as');
            if (name !== c.name) data.name = name;
        }
        if (Object.keys(data).length === 0) return false;

        const r = await prisma.contract.updateMany({ where: { id: contractId, type: 'AVULSO' }, data });
        return r.count > 0;
    } catch (err) {
        console.error(`[AVULSO] Falha ao sincronizar data/nome do contrato ${contractId}:`, err);
        return false;
    }
}

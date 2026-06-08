import { prisma } from '../lib/prisma.js';
import { createNotification } from '../modules/notifications/notificationService.js';
import { computeFlexState, targetForfeit } from '../lib/flexCredits.js';

/**
 * FLEX Credit Expiry Job — runs a few times a day.
 * For each active FLEX contract:
 *   1. Grandfather (first sight): set flexForfeitFloor = current shortfall, never
 *      forfeiting the past for existing contracts.
 *   2. Forfeit (monotonic): if the cumulative shortfall above the floor exceeds what
 *      we've already forfeited, mark the new credits as lost (banking/compensation).
 *   3. Warn: when the current 7-day window is closing without a recording.
 */
export async function runFlexCreditExpiryJob(): Promise<void> {
    const now = new Date();

    const contracts = await prisma.contract.findMany({
        where: { type: 'FLEX', status: 'ACTIVE' },
        include: {
            user: { select: { id: true, name: true } },
            bookings: { where: { status: { not: 'CANCELLED' } }, select: { date: true } },
        },
    });

    let forfeitedContracts = 0;
    let warned = 0;

    for (const c of contracts) {
        if (!c.flexCreditsTotal) continue;

        const state = computeFlexState({
            total: c.flexCreditsTotal,
            cycleStart: c.flexCycleStart,
            bookingDates: c.bookings.map(b => b.date),
            now,
        });

        // Cycle hasn't started (no recording yet) → nothing to forfeit.
        if (!state.started) continue;

        // ── 1. Grandfather existing contracts (no retroactive loss) ──
        if (c.flexForfeitFloor == null) {
            await prisma.contract.update({
                where: { id: c.id },
                data: { flexForfeitFloor: state.shortfall },
            });
            continue;
        }

        // ── 2. Forfeiture (monotonic) + canonical reconcile of flexCreditsRemaining ──
        const target = targetForfeit(state.shortfall, c.flexForfeitFloor, c.flexCreditsTotal, state.recordings);
        const newForfeited = Math.max(c.flexCreditsForfeited, target); // monotonic
        const canonicalRemaining = Math.max(0, c.flexCreditsTotal - state.recordings - newForfeited);
        const justForfeited = newForfeited > c.flexCreditsForfeited;

        if (newForfeited !== c.flexCreditsForfeited || canonicalRemaining !== c.flexCreditsRemaining) {
            // The cron is the canonical source for flexCreditsRemaining — self-heals any
            // drift from the optimistic booking decrement / cancel restore between runs.
            await prisma.contract.update({
                where: { id: c.id },
                data: { flexCreditsForfeited: newForfeited, flexCreditsRemaining: canonicalRemaining },
            });
        }

        if (justForfeited) {
            const lost = newForfeited - c.flexCreditsForfeited;
            forfeitedContracts++;
            try {
                await createNotification({
                    userId: c.user.id,
                    type: 'FLEX_CREDITS_LOW',
                    severity: 'critical',
                    title: '⚠️ Crédito de gravação perdido',
                    message: `Você perdeu ${lost} crédito(s) do contrato "${c.name}" por não gravar dentro da semana. Restam ${canonicalRemaining}.`,
                    entityType: 'CONTRACT',
                    // Distinct per forfeiture level so a later loss isn't deduped away.
                    entityId: `${c.id}:lvl${newForfeited}`,
                    actionUrl: '/my-contracts',
                    sendPush: true,
                });
            } catch (err) { console.error(`[FLEX-EXPIRY] notify forfeit ${c.id}:`, err); }
            continue;
        }

        // ── 3. At-risk warning: current window closing soon, no recording yet ──
        if (state.currentWindowIndex != null && (state.daysLeftInWindow ?? 99) <= 2
            && !state.recordedThisWindow && (c.flexCreditsRemaining ?? 0) > 0) {
            try {
                await createNotification({
                    userId: c.user.id,
                    type: 'FLEX_CREDITS_LOW',
                    severity: 'warning',
                    title: '⏳ Grave esta semana para não perder o crédito',
                    message: `Faltam ${state.daysLeftInWindow} dia(s) para fechar a semana do contrato "${c.name}". Agende sua gravação para não perder 1 crédito.`,
                    entityType: 'CONTRACT',
                    entityId: `${c.id}:w${state.currentWindowIndex}`,
                    actionUrl: '/my-contracts',
                    sendPush: true,
                });
                warned++;
            } catch (err) { console.error(`[FLEX-EXPIRY] notify risk ${c.id}:`, err); }
        }
    }

    if (forfeitedContracts > 0 || warned > 0) {
        console.log(`[FLEX-EXPIRY] forfeited on ${forfeitedContracts} contract(s), warned ${warned}.`);
    }
}

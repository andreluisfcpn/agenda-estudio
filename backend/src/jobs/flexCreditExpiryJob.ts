import { prisma } from '../lib/prisma.js';
import { notifyEvent } from '../modules/notifications/notificationService.js';
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
export async function runFlexCreditExpiryJob(now: Date = new Date()): Promise<void> {

    const contracts = await prisma.contract.findMany({
        where: { type: 'FLEX', status: 'ACTIVE' },
        include: {
            user: { select: { id: true, name: true } },
            // "não fizer → come 1 crédito": um no-show (FALTA) JÁ custa 1 crédito — a reserva consumiu
            // o crédito e ele NÃO é devolvido (diferente de CANCELLED/NAO_REALIZADO, que devolvem). Por
            // isso a FALTA CONTA como gravação aqui: o crédito já foi cobrado na reserva; NÃO aplicar
            // forfeiture extra (senão puniria 2× e, em semana bancada, o reconcile devolveria o crédito).
            bookings: { where: { status: { not: 'CANCELLED' } }, select: { date: true, originalDate: true } },
        },
    });

    let forfeitedContracts = 0;
    let warned = 0;

    for (const c of contracts) {
        if (!c.flexCreditsTotal) continue;

        // Anchor-aware: usa a data-ÂNCORA (originalDate) da reserva, não a data corrente. Assim uma
        // REMARCAÇÃO legítima (direito de até 7 dias) não empurra a gravação pra fora da janela de
        // origem e não confisca crédito indevido — resolve a colisão remarcação × forfeiture (regra 5).
        const anchorDates = c.bookings.map(b => b.originalDate ?? b.date);

        // "o contrato passa a valer a partir do 1º episódio que grava" (intenção do dono): o relógio
        // é RE-DERIVADO da MENOR âncora entre as reservas válidas (não canceladas / não no-show).
        // Assim (a) marcação em lote passa a ancorar (antes ficava null → nunca confiscava) e
        // (b) se a 1ª reserva-âncora for cancelada, o relógio acompanha a nova 1ª gravação (não fica
        // preso numa data cancelada). Trade-off: cancelar a 1ª pode adiar o relógio — aceitável pois
        // o contrato "vale a partir da 1ª gravação"; cancelamento não é o caminho comum.
        let cycleStart = c.flexCycleStart;
        if (anchorDates.length > 0) {
            const earliest = new Date(Math.min(...anchorDates.map(d => +d)));
            if (!cycleStart || +earliest !== +cycleStart) {
                cycleStart = earliest;
                await prisma.contract.update({ where: { id: c.id }, data: { flexCycleStart: earliest } });
            }
        }

        const state = computeFlexState({
            total: c.flexCreditsTotal,
            cycleStart,
            bookingDates: anchorDates,
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
                await notifyEvent('flex_credit_lost', {
                    userId: c.user.id,
                    vars: { quantidade: lost, contrato: c.name, restantes: canonicalRemaining },
                    entityType: 'CONTRACT',
                    // Distinct per forfeiture level so a later loss isn't deduped away.
                    entityId: `${c.id}:lvl${newForfeited}`,
                });
            } catch (err) { console.error(`[FLEX-EXPIRY] notify forfeit ${c.id}:`, err); }
            continue;
        }

        // ── 3. At-risk warning: current window closing soon, no recording yet ──
        if (state.currentWindowIndex != null && (state.daysLeftInWindow ?? 99) <= 2
            && !state.recordedThisWindow && (c.flexCreditsRemaining ?? 0) > 0) {
            try {
                await notifyEvent('flex_credit_at_risk', {
                    userId: c.user.id,
                    vars: { dias: state.daysLeftInWindow ?? 0, contrato: c.name },
                    entityType: 'CONTRACT',
                    entityId: `${c.id}:w${state.currentWindowIndex}`,
                });
                warned++;
            } catch (err) { console.error(`[FLEX-EXPIRY] notify risk ${c.id}:`, err); }
        }
    }

    if (forfeitedContracts > 0 || warned > 0) {
        console.log(`[FLEX-EXPIRY] forfeited on ${forfeitedContracts} contract(s), warned ${warned}.`);
    }
}

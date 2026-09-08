import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../../src/lib/prisma';
import { redis } from '../../src/lib/redis';
import { runFlexCreditExpiryJob } from '../../src/jobs/flexCreditExpiryJob';
import { mkUser, mkContract, mkBooking } from './factories';

// ─── FLEX credit expiry — TIME-TRAVEL integration ──────────────────────────
// Exercita o JOB REAL (runFlexCreditExpiryJob) contra o DB de teste, "correndo o
// tempo pro futuro" via o parâmetro `now` (seam de testabilidade). Prova o pedido
// do dono: "correr o tempo pro futuro e ver se come os créditos certinho".

const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;
const CS = Date.UTC(2026, 0, 1, 0, 0, 0); // cycleStart determinístico (UTC)
const at = (offsetDays: number) => new Date(CS + offsetDays * DAY);

// Contrato FLEX novo (não-grandfathered): floor 0 → o job já confisca na 1ª rodada.
async function seedFlex(overrides: Record<string, unknown> = {}) {
    const u = await mkUser();
    const c = await mkContract(u.id, {
        type: 'FLEX',
        status: 'ACTIVE',
        flexCreditsTotal: 12,
        flexCreditsRemaining: 12,
        flexCreditsForfeited: 0,
        flexForfeitFloor: 0,
        flexCycleStart: new Date(CS),
        ...overrides,
    });
    return { u, c };
}

const readContract = (id: string) =>
    prisma.contract.findUniqueOrThrow({
        where: { id },
        select: { flexCreditsForfeited: true, flexCreditsRemaining: true, flexForfeitFloor: true, flexCycleStart: true },
    });

const countFlexNotifs = (userId: string) =>
    prisma.notification.count({ where: { userId, type: 'FLEX_CREDITS_LOW' } });

beforeEach(async () => {
    // Belt-and-suspenders: a dedup do Redis (notif:dedup:*) não é limpa pelo setup.
    const keys = await redis.keys('notif:dedup:*');
    if (keys.length) await redis.del(...keys);
});

describe('runFlexCreditExpiryJob — time travel', () => {
    it('I1 core: contrato atrasado confisca na 1ª rodada e reconcilia remaining + notifica', async () => {
        const { u, c } = await seedFlex();
        await mkBooking(u.id, c.id, { date: at(0), status: 'CONFIRMED' }); // 1 gravação (dia 0)

        // 5 semanas depois: 5 janelas decorridas, 1 gravada → shortfall 4.
        await runFlexCreditExpiryJob(new Date(CS + 5 * WEEK));

        const after = await readContract(c.id);
        expect(after.flexCreditsForfeited).toBe(4);        // shortfall(4) - floor(0)
        expect(after.flexCreditsRemaining).toBe(7);        // 12 - 1 recording - 4 forfeited
        expect(await countFlexNotifs(u.id)).toBeGreaterThanOrEqual(1); // flex_credit_lost
    });

    it('banking: 5 gravações na 1ª semana bancam 5 semanas → NADA é confiscado', async () => {
        const { u, c } = await seedFlex();
        for (const d of [0, 1, 2, 3, 4]) await mkBooking(u.id, c.id, { date: at(d), status: 'CONFIRMED' });

        await runFlexCreditExpiryJob(new Date(CS + 5 * WEEK));

        const after = await readContract(c.id);
        expect(after.flexCreditsForfeited).toBe(0);        // 5 gravadas cobrem 5 semanas
        expect(after.flexCreditsRemaining).toBe(7);        // 12 - 5 recordings - 0 forfeited
        expect(await countFlexNotifs(u.id)).toBe(0);
    });

    it('I2 grandfather + monotônico: 1ª rodada só grava o floor; depois confisca 1/semana e é idempotente', async () => {
        const { u, c } = await seedFlex({ flexForfeitFloor: null }); // contrato pré-existente
        await mkBooking(u.id, c.id, { date: at(0), status: 'CONFIRMED' });

        // Rodada 1 (5 semanas): grandfather → grava floor = shortfall(4), SEM perda.
        await runFlexCreditExpiryJob(new Date(CS + 5 * WEEK));
        let s = await readContract(c.id);
        expect(s.flexForfeitFloor).toBe(4);
        expect(s.flexCreditsForfeited).toBe(0); // nada retroativo

        // Rodada 2 (6 semanas): shortfall 5, acima do floor 4 → confisca 1.
        await runFlexCreditExpiryJob(new Date(CS + 6 * WEEK));
        s = await readContract(c.id);
        expect(s.flexCreditsForfeited).toBe(1);
        expect(s.flexCreditsRemaining).toBe(10); // 12 - 1 - 1

        // Rodada 3 (mesmo instante): monotônico → nada muda.
        await runFlexCreditExpiryJob(new Date(CS + 6 * WEEK));
        s = await readContract(c.id);
        expect(s.flexCreditsForfeited).toBe(1);
        expect(s.flexCreditsRemaining).toBe(10);
    });

    it('I4 at-risk: janela fechando sem gravação avisa (sem confiscar)', async () => {
        const { u, c } = await seedFlex();
        await mkBooking(u.id, c.id, { date: at(0), status: 'CONFIRMED' });

        // now = dia 12.5 → janela 2 fechando em 2 dias, nada gravado nela.
        await runFlexCreditExpiryJob(new Date(CS + 12.5 * DAY));

        const after = await readContract(c.id);
        expect(after.flexCreditsForfeited).toBe(0); // shortfall 0, sem perda
        expect(await countFlexNotifs(u.id)).toBeGreaterThanOrEqual(1); // flex_credit_at_risk
    });

    // "não fizer → come 1 crédito": um no-show (FALTA) custa o crédito da PRÓPRIA reserva (consumido e
    // não devolvido) — conta como gravação, então NÃO leva forfeiture extra (senão puniria 2×).
    it('FALTA (no-show) custa o crédito da reserva, sem forfeiture extra', async () => {
        const { u, c } = await seedFlex(); // remaining 12
        for (const d of [0, 7, 14, 21, 28]) await mkBooking(u.id, c.id, { date: at(d), status: 'FALTA' });

        await runFlexCreditExpiryJob(new Date(CS + 5 * WEEK));

        const after = await readContract(c.id);
        expect(after.flexCreditsForfeited).toBe(0);   // sem forfeiture (o crédito já foi cobrado na reserva)
        expect(after.flexCreditsRemaining).toBe(7);   // 5 no-shows consumiram 5 créditos: 12 - 5 - 0
    });

    // "o contrato vale a partir do 1º episódio que grava": se a 1ª reserva-âncora foi cancelada,
    // o relógio re-deriva pra nova 1ª gravação (não fica preso numa data cancelada → sem over-forfeit).
    it('relógio re-deriva quando a 1ª reserva-âncora foi cancelada (não fica preso)', async () => {
        // cycleStart PRESO no dia 0 (a 1ª reserva foi cancelada), mas a 1ª gravação real é no dia 20.
        const { u, c } = await seedFlex({ flexCycleStart: new Date(CS) });
        await mkBooking(u.id, c.id, { date: at(20), status: 'CONFIRMED' });

        await runFlexCreditExpiryJob(new Date(CS + 6 * WEEK)); // dia 42

        const after = await readContract(c.id);
        expect(after.flexCycleStart?.getTime()).toBe(CS + 20 * DAY); // re-derivou pro dia 20
        // A partir do dia 20: 3 semanas decorridas, 1 gravação → shortfall 2 (não 5 do relógio preso).
        expect(after.flexCreditsForfeited).toBe(2);
    });

    // ── FIX #1: anchor-aware — remarcação legítima NÃO confisca (colisão remarcação × forfeiture) ──
    it('anchor-aware: gravação da semana 2 remarcada (dia 13 → 16) dentro do direito NÃO confisca', async () => {
        const { u, c } = await seedFlex();
        await mkBooking(u.id, c.id, { date: at(0), status: 'CONFIRMED' });                       // semana 1
        // Reserva da semana 2 (dia 13) remarcada para o dia 16 — originalDate mantém a âncora (13).
        await mkBooking(u.id, c.id, { date: at(16), originalDate: at(13), status: 'CONFIRMED' });

        await runFlexCreditExpiryJob(new Date(CS + 14 * DAY)); // fim da janela 2

        const after = await readContract(c.id);
        // A âncora (13) cai na janela 2 → on-pace → NADA confiscado (antes, pela data 16, confiscava 1).
        expect(after.flexCreditsForfeited).toBe(0);
    });

    it('anchor-aware (contraste): a MESMA gravação SEM âncora (originalDate null) no dia 16 confisca 1', async () => {
        const { u, c } = await seedFlex();
        await mkBooking(u.id, c.id, { date: at(0), status: 'CONFIRMED' });
        await mkBooking(u.id, c.id, { date: at(16), status: 'CONFIRMED' }); // sem originalDate

        await runFlexCreditExpiryJob(new Date(CS + 14 * DAY));

        const after = await readContract(c.id);
        // Sem âncora, a janela 2 fica "vazia" (o dia 16 é futuro no check) → shortfall 1 → confisca 1.
        expect(after.flexCreditsForfeited).toBe(1);
    });

    // ── FIX: marcação em LOTE não ancorava (flexCycleStart null) → o job nunca confiscava ──
    it('deriva flexCycleStart quando null (lote) e passa a confiscar', async () => {
        const { u, c } = await seedFlex({ flexCycleStart: null }); // lote não ancorou
        await mkBooking(u.id, c.id, { date: at(0), status: 'CONFIRMED' });

        await runFlexCreditExpiryJob(new Date(CS + 5 * WEEK));

        const after = await readContract(c.id);
        expect(after.flexCycleStart).not.toBeNull();          // ancorou no dia 0
        expect(after.flexCreditsForfeited).toBe(4);           // 5 semanas, 1 gravação → confisca 4
    });
});

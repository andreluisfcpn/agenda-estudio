// Quick sanity test for the FLEX weekly-window engine. Run: npx tsx src/scripts/testFlexCredits.ts
import { computeFlexState, targetForfeit } from '../lib/flexCredits.js';

const DAY = 24 * 60 * 60 * 1000;
const base = new Date('2026-01-01T12:00:00Z');
const at = (offsetDays: number) => new Date(+base + offsetDays * DAY);
const total = 12;

let pass = 0, fail = 0;
function check(name: string, got: unknown, want: unknown) {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    console.log(`${ok ? '✔' : '�’✗ FAIL'} ${name}: got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
    ok ? pass++ : fail++;
}

// cycleStart = 1st booking (day 0). now = day 21 → 3 windows elapsed.
const now21 = at(21);

// On-pace: a recording each week (day 0,7,14) → shortfall 0
check('on-pace shortfall', computeFlexState({ total, cycleStart: at(0), bookingDates: [at(0), at(7), at(14)], now: now21 }).shortfall, 0);

// Behind: only the 1st recording (day 0) → 3 elapsed, 1 recorded → shortfall 2
const behind = computeFlexState({ total, cycleStart: at(0), bookingDates: [at(0)], now: now21 });
check('behind weeksElapsed', behind.weeksElapsed, 3);
check('behind shortfall', behind.shortfall, 2);

// Banking ahead: 3 recordings in week 1 (day 0,1,2) → covers weeks 1-3 → shortfall 0
check('banking shortfall', computeFlexState({ total, cycleStart: at(0), bookingDates: [at(0), at(1), at(2)], now: now21 }).shortfall, 0);

// Not started: no persisted cycleStart yet → started=false (cycle begins on 1st recording)
check('not started', computeFlexState({ total, cycleStart: null, bookingDates: [], now: now21 }).started, false);
// Persisted cycleStart resists cancel: clock anchored even if the only booking is later
const cancelResist = computeFlexState({ total, cycleStart: at(0), bookingDates: [at(35)], now: at(28) });
check('cancel-resist shortfall', cancelResist.shortfall, 4); // 4 weeks elapsed, 0 recorded within them

// Current window: at day 21, the window containing now is window 4 ([21,28)); day left ~7
const curr = computeFlexState({ total, cycleStart: at(0), bookingDates: [at(0)], now: at(23) });
check('current window index (day23)', curr.currentWindowIndex, 4);
check('recordedThisWindow (none in w4)', curr.recordedThisWindow, false);

// ── Grandfather + monotonic forfeiture ──
// Existing contract behind by 2 at "go-live": floor=2 → no loss now.
check('grandfather no loss', targetForfeit(behind.shortfall, /*floor*/2, total, behind.recordings), 0);
// One more week passes (day 28 → 4 elapsed, still 1 recording → shortfall 3); floor 2 → forfeit 1
const day28 = computeFlexState({ total, cycleStart: at(0), bookingDates: [at(0)], now: at(28) });
check('day28 shortfall', day28.shortfall, 3);
check('forfeit beyond floor', targetForfeit(day28.shortfall, 2, total, day28.recordings), 1);
// New contract (floor 0), behind by 2 → forfeit 2
check('new contract forfeit', targetForfeit(behind.shortfall, 0, total, behind.recordings), 2);
// Clamp: cannot forfeit more than total-recordings
check('forfeit clamp', targetForfeit(99, 0, total, /*recordings*/10), 2);

console.log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ FAILURES'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

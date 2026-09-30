/**
 * Дежурства: the rotation's rules (lib/duty.ts; owner, 25 Sep 2026).
 * Pure, no database: people are numbers.
 *
 * September 2026 starts on a Tuesday, so its working days are
 * 1 (Tue) 2 3 4 · 7 8 9 10 11 · 14 …, so 1–8 September is six of them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applySwaps, dutyRota, monthBounds, rotaWithSwaps, monthOfRota, todayInSkopje, windowPayload, isIsoDate, workingDays, type DutyMember, type DutyState } from '../src/lib/duty.js';

const members = (...ids: number[]): DutyMember[] => ids.map((employeeId, i) => ({ employeeId, position: i + 1, joinedOn: null, leftOn: null }));
const rota = (opts: { members?: DutyMember[]; until?: string; days?: Array<[string, { closed?: boolean; note?: string; assigned?: number | null }]>; away?: Array<[string, number[]]> }) =>
    dutyRota({
        startsOn: '2026-09-01',
        until: opts.until || '2026-09-08',
        members: opts.members || members(1, 2, 3),
        days: new Map((opts.days || []).map(([d, m]) => [d, { closed: Boolean(m.closed), note: m.note || '', assigned: m.assigned ?? null }])),
        absences: new Map((opts.away || []).map(([d, ids]) => [d, new Set(ids)]))
    });
const who = (days: ReturnType<typeof dutyRota>) => days.map((d) => d.employeeId);

test('working days skip the weekend', () => {
    assert.deepEqual(workingDays('2026-09-04', '2026-09-08'), ['2026-09-04', '2026-09-07', '2026-09-08']);
});

test('the list goes round, one working day each', () => {
    assert.deepEqual(who(rota({})), [1, 2, 3, 1, 2, 3]);
});

test('somebody away loses the turn; the next uses their own turn once, then the list continues', () => {
    const days = rota({ away: [['2026-09-01', [1]]] });
    assert.deepEqual(who(days), [2, 3, 1, 2, 3, 1]);
    assert.deepEqual(days.map((d) => d.cycle), [1, 1, 2, 2, 2, 3]);
    assert.equal(days[0].how, 'cover');
    assert.deepEqual(days[0].covers, [1]);
    assert.deepEqual(days[0].absent, [1]);
});

test('a sick day in the middle moves following dates, not preceding dates or list order', () => {
    const sick = rota({ until: '2026-09-11', away: [['2026-09-08', [3]], ['2026-09-09', [1]]] });
    assert.deepEqual(who(sick), [1, 2, 3, 1, 2, 1, 2, 3, 1]);
});

test('the stand-in is the next on the list who is in', () => {
    const days = rota({ away: [['2026-09-01', [1, 2]]] });
    assert.deepEqual(who(days), [3, 1, 2, 3, 1, 2]);
    assert.deepEqual(days[0].covers, [1, 2]);
});

test('somebody away on a day that was not theirs changes nothing', () => {
    assert.deepEqual(who(rota({ away: [['2026-09-01', [3]]] })), [1, 2, 3, 1, 2, 3]);
});

test('a legacy named stand-in consumes their own turn, including after absence', () => {
    const days = rota({ days: [['2026-09-01', { assigned: 3 }]], away: [['2026-09-01', [1]]] });
    assert.deepEqual(who(days), [3, 2, 1, 2, 3, 1]);
    assert.equal(days[0].how, 'assigned');
    assert.deepEqual(days[0].covers, [1]);
});

test('a closed day has no duty and moves nobody: the list continues the next working day', () => {
    const days = rota({ days: [['2026-09-02', { closed: true, note: 'екскурзија' }]] });
    assert.deepEqual(who(days), [1, null, 2, 3, 1, 2]);
    assert.equal(days[1].employeeId, null);
    assert.equal(days[1].how, 'closed');
    assert.equal(days[1].note, 'екскурзија');
});

test('the same event can keep normal counting or explicitly pause it, including across months', () => {
    for (const note of ['екскурзија', 'приредба', 'празник']) {
        const plain = rota({ until: '2026-10-05' });
        const active = rota({ until: '2026-10-05', days: [['2026-09-30', { closed: false, note }]] });
        assert.deepEqual(who(active), who(plain), `${note} alone does not change anybody's turn`);
        const paused = rota({ until: '2026-10-05', days: [['2026-09-30', { closed: true, note }]] });
        const index = plain.findIndex((day) => day.date === '2026-09-30');
        assert.equal(paused[index].employeeId, null);
        assert.equal(paused[index].note, note);
        assert.equal(paused[index + 1].date, '2026-10-01');
        assert.equal(paused[index + 1].employeeId, plain[index].employeeId, 'nobody uses a turn during the pause');
        assert.deepEqual(who(paused).slice(0, index), who(plain).slice(0, index));
    }
});

test('a legacy assignment consumes one turn and next cycle restarts in the canonical order', () => {
    const days = rota({ days: [['2026-09-01', { assigned: 3 }]] });
    assert.deepEqual(who(days), [3, 1, 2, 1, 2, 3]);
    assert.equal(days[0].how, 'assigned');
});

test('a day given to somebody who is away falls back to the rotation', () => {
    const days = rota({ days: [['2026-09-01', { assigned: 3 }]], away: [['2026-09-01', [3]]] });
    assert.equal(days[0].employeeId, 1);
});

test('everyone away: no infinite loop; the rest of the cycle is skipped with no day owed', () => {
    const days = rota({ away: [['2026-09-01', [1, 2, 3]]] });
    assert.deepEqual(who(days), [null, 1, 2, 3, 1, 2]);
    assert.equal(days[0].how, 'nobody');
    assert.deepEqual(days[0].covers, [1, 2, 3]);
});

test('somebody joining during the year joins at the back and does not rewrite the days before', () => {
    const list = [...members(1, 2), { employeeId: 9, position: 3, joinedOn: '2026-09-07', leftOn: null }];
    const days = rota({ members: list, until: '2026-09-10' });
    // 9 joins on Monday 7th behind the two already in line.
    assert.deepEqual(who(days), [1, 2, 1, 2, 1, 2, 9, 1]);
});

test('somebody leaving is taken out from that day', () => {
    const list = [members(1)[0], { employeeId: 2, position: 2, joinedOn: null, leftOn: '2026-09-03' }, { employeeId: 3, position: 3, joinedOn: null, leftOn: null }];
    assert.deepEqual(who(rota({ members: list })), [1, 2, 3, 1, 3, 1]);
});

test('October continues where September ended', () => {
    const state: DutyState = {
        startsOn: '2026-09-01', yearStartsOn: '2026-09-01', yearEndsOn: '2027-08-31',
        members: members(1, 2, 3).map((m) => ({ ...m, name: 'x' })),
        days: new Map(), absences: new Map(), names: new Map(), swaps: []
    };
    const september = monthOfRota(state, monthBounds('2026-09')!);
    const october = monthOfRota(state, monthBounds('2026-10')!);
    const last = september[september.length - 1].employeeId!;
    assert.equal(october[0].employeeId, (last % 3) + 1);
    assert.equal(october[0].date, '2026-10-01');
});

test('before the rotation starts, a month has no duty', () => {
    const state: DutyState = {
        startsOn: '2026-09-15', yearStartsOn: '2026-09-01', yearEndsOn: '2027-08-31',
        members: members(1, 2).map((m) => ({ ...m, name: 'x' })), days: new Map(), absences: new Map(), names: new Map(), swaps: []
    };
    const september = monthOfRota(state, monthBounds('2026-09')!);
    assert.equal(september[0].employeeId, null);
    assert.equal(september.find((d) => d.date === '2026-09-15')!.employeeId, 1);
});

test('a month is named as YYYY-MM and nothing else', () => {
    assert.deepEqual(monthBounds('2026-02'), { first: '2026-02-01', last: '2026-02-28' });
    assert.equal(monthBounds('2026-13'), null);
    assert.equal(monthBounds('Septembar'), null);
});

test('today is counted in Skopje, not in the server\'s zone', () => {
    // 23:30 UTC on 30 Sep is already 1 October in Skopje (UTC+2 in summer).
    assert.equal(todayInSkopje(new Date('2026-09-30T23:30:00Z')), '2026-10-01');
});

const swap = (firstDay: string, first: number, secondDay: string, second: number) =>
    ({ id: 1, firstDay, firstEmployeeId: first, secondDay, secondEmployeeId: second, note: 'договор' });

test('after A is skipped, B and D may exchange: D/C/B, once each', () => {
    const base = rota({ members: members(1, 2, 3, 4), away: [['2026-09-01', [1]]] });
    const result = applySwaps(base, [swap('2026-09-01', 2, '2026-09-03', 4)]);
    assert.deepEqual(who(result.days), [4, 3, 2, 1, 2, 3]);
    assert.deepEqual(result.stale, []);
    assert.deepEqual(result.days[0].covers, [1]);
});

test('a cross-cycle swap is stale even when the named people and dates still match', () => {
    const base = rota({});
    const result = applySwaps(base, [swap('2026-09-02', 2, '2026-09-04', 1)]);
    assert.deepEqual(who(result.days), who(base));
    assert.equal(result.stale.length, 1);
});

test('a repeated legacy assignment is ignored and reported, never a second turn in one cycle', () => {
    const days = rota({ days: [['2026-09-01', { assigned: 3 }], ['2026-09-02', { assigned: 3 }]] });
    assert.deepEqual(who(days), [3, 1, 2, 1, 2, 3]);
    assert.equal(days[1].assignmentStale, true);
});

test('sick leave is checked on every return, with no catch-up duty after returning', () => {
    const days = rota({ away: [['2026-09-01', [1]], ['2026-09-03', [1]]] });
    assert.deepEqual(who(days), [2, 3, 2, 3, 1, 2]);
});

test('other-service coverage pauses the queue, even when the head is marked absent that day', () => {
    const days = rota({ days: [['2026-09-01', { closed: true, note: 'покрива друга служба' }]], away: [['2026-09-01', [1]]] });
    assert.deepEqual(who(days), [null, 1, 2, 3, 1, 2]);
});

test('an eight-person cycle, a swap, a sick last member and an override span September/October without repeats', () => {
    const state: DutyState = {
        startsOn: '2026-09-21', yearStartsOn: '2026-09-01', yearEndsOn: '2027-08-31',
        members: members(1, 2, 3, 4, 5, 6, 7, 8).map((m) => ({ ...m, name: 'Invented' })),
        days: new Map([['2026-09-30', { closed: false, note: '', assigned: 2 }],
            ['2026-10-01', { closed: true, note: 'покрива друга служба', assigned: null }]]),
        absences: new Map([['2026-09-30', new Set([8])]]), names: new Map(),
        swaps: [swap('2026-09-22', 2, '2026-09-24', 4)]
    };
    const result = rotaWithSwaps(state, '2026-10-13');
    assert.deepEqual(who(result.days).slice(0, 12), [1, 4, 3, 2, 5, 6, 7, 2, null, 1, 3, 4]);
    assert.deepEqual(result.stale, []);
    const seen = new Set<string>();
    for (const day of result.days) if (day.employeeId != null) {
        const key = `${day.cycle}:${day.employeeId}`;
        assert.ok(!seen.has(key), `${day.date}: duplicate turn ${key}`);
        seen.add(key);
    }
    assert.equal(result.days.find((d) => d.date === '2026-09-30')!.cycle, 2);
    assert.equal(result.days.find((d) => d.date === '2026-10-05')!.employeeId, 3);
});

test('a swap trades two days between two people, and the list goes on as if it had not happened', () => {
    const base = rota({});
    const { days, stale } = applySwaps(base, [swap('2026-09-01', 1, '2026-09-03', 3)]);
    assert.deepEqual(who(days), [3, 2, 1, 1, 2, 3]);
    assert.deepEqual(stale, []);
    assert.equal(days[0].how, 'swap');
    assert.deepEqual(days[0].swap, { id: 1, with: 1, date: '2026-09-03', note: 'договор' });
    assert.deepEqual(days[2].swap, { id: 1, with: 3, date: '2026-09-01', note: 'договор' });
});

test('a swap whose days no longer belong to the two who agreed it is not applied, and is reported', () => {
    // 3 takes the 1st by agreement: the rota moves, the 3rd is no longer 3's.
    const moved = rota({ days: [['2026-09-01', { assigned: 3 }]] });
    const { days, stale } = applySwaps(moved, [swap('2026-09-01', 1, '2026-09-03', 3)]);
    assert.deepEqual(who(days), who(moved));
    assert.equal(stale.length, 1);
});

test('a swap onto a closed day, or onto a day the taker is away, does not hold', () => {
    const closed = rota({ days: [['2026-09-03', { closed: true }]] });
    assert.equal(applySwaps(closed, [swap('2026-09-01', 1, '2026-09-03', 3)]).stale.length, 1);
    const away = rota({ away: [['2026-09-04', [2]]] });
    // 2 would take the 4th while marked away on it.
    assert.equal(applySwaps(rota({}), [swap('2026-09-02', 2, '2026-09-03', 3)]).stale.length, 0);
    assert.equal(applySwaps(away, [swap('2026-09-02', 2, '2026-09-07', 1)]).stale.length, 1);
});

test('a swap across the end of a month shows on both sides of it', () => {
    const state: DutyState = {
        startsOn: '2026-09-01', yearStartsOn: '2026-09-01', yearEndsOn: '2027-08-31',
        members: members(1, 2, 3).map((m) => ({ ...m, name: 'x' })), days: new Map(), absences: new Map(), names: new Map(),
        swaps: []
    };
    const plainSep = monthOfRota(state, monthBounds('2026-09')!);
    const plainOct = monthOfRota(state, monthBounds('2026-10')!);
    const a = plainSep[plainSep.length - 1];
    const b = plainOct.find((d) => d.employeeId !== a.employeeId)!;
    state.swaps = [swap(a.date, a.employeeId!, b.date, b.employeeId!)];
    assert.equal(monthOfRota(state, monthBounds('2026-09')!).slice(-1)[0].employeeId, b.employeeId);
    assert.equal(monthOfRota(state, monthBounds('2026-10')!).find((d) => d.date === b.date)!.employeeId, a.employeeId);
    assert.equal(rotaWithSwaps(state, '2026-09-30').stale.length, 0);
});

test('around a day: one turn of the list back and one forward, across the month (owner, 28 Sep 2026)', () => {
    const state: DutyState = {
        startsOn: '2026-09-01', yearStartsOn: '2026-09-01', yearEndsOn: '2027-08-31',
        members: members(1, 2, 3, 4, 5, 6, 7, 8).map((m) => ({ ...m, name: 'x' })),
        days: new Map(), absences: new Map([['2026-09-30', new Set([6])]]), names: new Map(), swaps: [] // 30.09 is day 22: the sixth is due
    };
    const w = windowPayload(state, '2026-09-28');
    assert.equal(w.cycle, 8, 'a turn is as long as the list');
    assert.deepEqual([w.from, w.to], ['2026-09-16', '2026-10-08'], 'eight working days either side of Monday 28 September');
    assert.deepEqual([w.prevAround, w.nextAround], ['2026-09-16', '2026-10-08'], '◀ ▶ move by one turn');
    // The same rota the month view shows, day for day, on both sides of the month's end.
    const months = [...monthOfRota(state, monthBounds('2026-09')!), ...monthOfRota(state, monthBounds('2026-10')!)];
    for (const d of w.days) assert.equal(d.employeeId, months.find((m) => m.date === d.date)!.employeeId, d.date);
    const sick = w.days.find((d) => d.date === '2026-09-30')!;
    assert.deepEqual(sick.covers.map((c) => c.employeeId), [6], 'the next one covers, shown covering the one away');
    assert.equal(sick.employeeId, 7);
});

test('the window stays inside the school year, and a day is a real date', () => {
    const state: DutyState = {
        startsOn: '2026-09-01', yearStartsOn: '2026-09-01', yearEndsOn: '2027-08-31',
        members: members(1, 2, 3).map((m) => ({ ...m, name: 'x' })),
        days: new Map(), absences: new Map(), names: new Map(), swaps: []
    };
    const w = windowPayload(state, '2026-09-02');
    assert.equal(w.from, '2026-09-01', 'never before the year');
    assert.equal(w.cycle, 5, 'a short list still shows a working week either side');
    assert.equal(windowPayload(state, '2025-01-01').around, '2026-09-01');
    assert.equal(isIsoDate('2026-02-30'), false);
    assert.equal(isIsoDate('2026-09-28'), true);
});

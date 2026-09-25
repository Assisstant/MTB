/**
 * Дежурства: the rotation's rules (lib/duty.ts; owner, 25 Sep 2026).
 * Pure, no database: people are numbers.
 *
 * September 2026 starts on a Tuesday, so its working days are
 * 1 (Tue) 2 3 4 · 7 8 9 10 11 · 14 …, so 1–8 September is six of them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dutyRota, monthBounds, monthOfRota, todayInSkopje, workingDays, type DutyMember, type DutyState } from '../src/lib/duty.js';

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

test('an absent person is covered and keeps their place: they are on duty the next day they are in', () => {
    const days = rota({ away: [['2026-09-01', [1]]] });
    assert.deepEqual(who(days), [2, 1, 3, 2, 1, 3]);
    assert.equal(days[0].how, 'cover');
    assert.deepEqual(days[0].covers, [1]);
    assert.deepEqual(days[0].absent, [1]);
});

test('over a whole cycle everyone does the same number of duties, absence or not', () => {
    const days = rota({ until: '2026-09-30', away: [['2026-09-01', [1]], ['2026-09-02', [1, 2]], ['2026-09-10', [3]]] });
    const count = (id: number) => days.filter((d) => d.employeeId === id).length;
    // 22 working days, three people: nobody is more than one duty apart.
    const counts = [count(1), count(2), count(3)];
    assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, String(counts));
});

test('a closed day has no duty and moves nobody', () => {
    const days = rota({ days: [['2026-09-02', { closed: true, note: 'екскурзија' }]] });
    assert.deepEqual(who(days), [1, null, 2, 3, 1, 2]);
    assert.equal(days[1].how, 'closed');
    assert.equal(days[1].note, 'екскурзија');
});

test('a day given by agreement: the stand-in goes to the back, whoever was next is still next', () => {
    const days = rota({ days: [['2026-09-01', { assigned: 3 }]] });
    assert.deepEqual(who(days), [3, 1, 2, 3, 1, 2]);
    assert.equal(days[0].how, 'assigned');
});

test('a day given to somebody who is away falls back to the rotation', () => {
    const days = rota({ days: [['2026-09-01', { assigned: 3 }]], away: [['2026-09-01', [3]]] });
    assert.equal(days[0].employeeId, 1);
});

test('everyone away: nobody, and the queue waits', () => {
    const days = rota({ away: [['2026-09-01', [1, 2, 3]]] });
    assert.deepEqual(who(days), [null, 1, 2, 3, 1, 2]);
    assert.equal(days[0].how, 'nobody');
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
        days: new Map(), absences: new Map(), names: new Map()
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
        members: members(1, 2).map((m) => ({ ...m, name: 'x' })), days: new Map(), absences: new Map(), names: new Map()
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

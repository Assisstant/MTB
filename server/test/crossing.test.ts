/**
 * The overlap model.
 *
 * The bug this exists to prevent is not a crash — it is a confident wrong
 * answer. Matching by ordinal looks right in every screenshot and is wrong by
 * one lesson everywhere, so the tests here are about real minutes.
 *
 *     npm run test:crossing
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { minutesOf, timeOf, overlapsFor, disruptedBy, normalizeClassLabel, slotBell, mergeAdjacent, type Bell } from '../src/lib/crossing.js';

const bell = (ordinal: number, startsAt: string, minutes = 40, label = String(ordinal)): Bell =>
    ({ ordinal, label, startsAt, minutes });

/** The school as its workbook describes it. */
const TEACHING = [
    bell(1, '07:30'), bell(2, '08:15'), bell(3, '09:10'),
    bell(4, '09:55'), bell(5, '10:40'), bell(6, '11:25'), bell(7, '12:10')
];

/** The cabinet as Rasporedi has always described it. */
const CABINET = [
    bell(1, '08:00', 40, 'I'), bell(2, '08:45', 40, 'II'), bell(3, '09:40', 40, 'III'),
    bell(4, '10:25', 40, 'IV'), bell(5, '11:10', 40, 'V'), bell(6, '11:55', 40, 'VI')
];

test('a clock is read, and a bad one is not silently zero', () => {
    assert.equal(minutesOf('08:45'), 525);
    assert.equal(minutesOf(' 7:05 '), 425);
    assert.ok(Number.isNaN(minutesOf('')));
    assert.ok(Number.isNaN(minutesOf('25:00')));
    assert.ok(Number.isNaN(minutesOf('08:70')));
    assert.equal(timeOf(525), '08:45');
    assert.equal(timeOf(minutesOf('08:00') + 40), '08:40');
});

test('the first cabinet block is mostly the SECOND lesson, not the first', () => {
    const found = overlapsFor(CABINET[0], TEACHING);
    assert.deepEqual(found.map((o) => [o.ordinal, o.minutes]), [[2, 25], [1, 10]]);
    // The whole point: ordinal matching would have said lesson 1.
    assert.equal(found[0].ordinal, 2);
});

test('every cabinet block straddles two lessons, and the long break makes one of them different', () => {
    // Written out rather than generated, because the interesting case is the
    // one a formula would smooth over: the break after lesson 2 is 55 minutes
    // instead of 45, so block II reaches only 15 minutes into lesson 3 while
    // every other block reaches 25. A rule of thumb would get that wrong.
    const expected: Record<string, [number, number][]> = {
        I:   [[2, 25], [1, 10]],
        II:  [[3, 15], [2, 10]],
        III: [[4, 25], [3, 10]],
        IV:  [[5, 25], [4, 10]],
        V:   [[6, 25], [5, 10]],
        VI:  [[7, 25], [6, 10]]
    };
    CABINET.forEach((block) => {
        const found = overlapsFor(block, TEACHING).map((o) => [o.ordinal, o.minutes]);
        assert.deepEqual(found, expected[block.label], `block ${block.label}`);
    });
});

test('align the bells and the same code gives one exact lesson', () => {
    const aligned = TEACHING.slice(0, 6).map((b) => bell(b.ordinal, b.startsAt, 40, b.label));
    aligned.forEach((block) => {
        const found = overlapsFor(block, TEACHING);
        assert.equal(found.length, 1);
        assert.equal(found[0].ordinal, block.ordinal);
        assert.equal(found[0].minutes, 40);
        assert.equal(found[0].share, 1);
    });
});

test('a session outside the teaching day is unplaced, not nearest-guessed', () => {
    assert.deepEqual(overlapsFor(bell(1, '19:30'), TEACHING), []);
    // An afternoon session against a morning timetable is the real case.
    assert.deepEqual(overlapsFor(bell(1, '14:30'), TEACHING), []);
});

test('a broken bell returns nothing rather than pretending', () => {
    assert.deepEqual(overlapsFor(bell(1, 'нема'), TEACHING), []);
    assert.deepEqual(overlapsFor({ ordinal: 1, label: 'I', startsAt: '08:00', minutes: 0 }, TEACHING), []);
    // A bad lesson in the list is skipped without taking the good ones down.
    const withJunk = [...TEACHING, { ordinal: 9, label: '9', startsAt: 'x', minutes: 40 }];
    assert.equal(overlapsFor(CABINET[0], withJunk).length, 2);
});

test('ten minutes of a lesson is not an absence; twenty-five is', () => {
    const kept = disruptedBy(CABINET[0], TEACHING);
    assert.deepEqual(kept.map((o) => o.ordinal), [2]);
    // Asking for everything touched still gives both, in order.
    assert.deepEqual(disruptedBy(CABINET[0], TEACHING, 0).map((o) => o.ordinal), [2, 1]);
});

test('a session that half-covers nothing still names where the child went', () => {
    // A 15-minute session inside one lesson: 15/40 is under half, but the
    // child is somewhere, and reporting nothing would hide them.
    const short = { ordinal: 1, label: 'кратко', startsAt: '09:20', minutes: 15 };
    const kept = disruptedBy(short, TEACHING);
    assert.equal(kept.length, 1);
    assert.equal(kept[0].ordinal, 3);
});

test('class labels fold on formatting only', () => {
    assert.equal(normalizeClassLabel('VI-а'), 'VI-а');
    assert.equal(normalizeClassLabel('vi а'), 'VI-а');
    assert.equal(normalizeClassLabel(' VI – А '), 'VI-а');
    assert.equal(normalizeClassLabel('VI/а'), 'VI-а');
    // Latin section letters, typed on a Latin keyboard.
    assert.equal(normalizeClassLabel('VI-a'), 'VI-а');
    assert.equal(normalizeClassLabel('IV-b'), 'IV-б');
    // Cyrillic numerals that look identical to the Latin ones.
    assert.equal(normalizeClassLabel('ІХ-а'), 'IX-а');
});

test('a class with no section is NOT folded into one that has one', () => {
    // VI and VI-а are different rooms full of different children. Guessing
    // between them would put a child in a lesson they never attended.
    assert.notEqual(normalizeClassLabel('VI'), normalizeClassLabel('VI-а'));
    assert.equal(normalizeClassLabel('VI'), 'VI');
    assert.equal(normalizeClassLabel(''), '');
});

test('a slot describes its own hours, including both halves of a term', () => {
    // The schedule stores one row per twenty-minute half. Matching those
    // against a table of period STARTS lost every second half, and with it
    // any child booked only in a second half.
    assert.deepEqual(slotBell('08:00-08:20'), { ordinal: 0, label: '08:00-08:20', startsAt: '08:00', minutes: 20 });
    assert.deepEqual(slotBell('08:20-08:40'), { ordinal: 0, label: '08:20-08:40', startsAt: '08:20', minutes: 20 });
    assert.deepEqual(slotBell('08:00-08:40'), { ordinal: 0, label: '08:00-08:40', startsAt: '08:00', minutes: 40 });
});

test('two terms worked as one session are one span, first clock to last', () => {
    const merged = slotBell('09:40-10:20 + 10:25-11:05');
    assert.equal(merged?.startsAt, '09:40');
    assert.equal(merged?.minutes, 85);            // 09:40 → 11:05
});

test('a slot that names no range is refused rather than assumed', () => {
    assert.equal(slotBell(''), null);
    assert.equal(slotBell('прв час'), null);
    assert.equal(slotBell('08:00'), null);        // one clock is not a range
    assert.equal(slotBell('08:40-08:00'), null);  // backwards
});

test('measured apart, the two halves of one session land on DIFFERENT lessons', () => {
    // This is the whole reason sessions are assembled before being measured.
    // 08:00-08:20 is mostly the first lesson; 08:20-08:40 is the second. Left
    // as two rows, one child out of one session is reported missing from two
    // lessons — from neither of which they are away for long.
    assert.equal(disruptedBy(slotBell('08:00-08:20')!, TEACHING)[0].ordinal, 1);
    assert.equal(disruptedBy(slotBell('08:20-08:40')!, TEACHING)[0].ordinal, 2);
});

test('assembled first, the same session is one lesson and the right one', () => {
    const halves = [slotBell('08:00-08:20')!, slotBell('08:20-08:40')!];
    const merged = mergeAdjacent(halves);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].startsAt, '08:00');
    assert.equal(merged[0].minutes, 40);

    const hit = disruptedBy(merged[0], TEACHING);
    assert.equal(hit.length, 1);
    assert.equal(hit[0].ordinal, 2);
    assert.equal(hit[0].minutes, 25);
});

test('a gap means the child went back to class, so the spans stay apart', () => {
    const apart = mergeAdjacent([slotBell('08:00-08:20')!, slotBell('08:45-09:05')!]);
    assert.equal(apart.length, 2);
    assert.deepEqual(apart.map((b) => b.startsAt), ['08:00', '08:45']);
});

test('assembling is order-independent and survives a single span', () => {
    const backwards = mergeAdjacent([slotBell('08:20-08:40')!, slotBell('08:00-08:20')!]);
    assert.equal(backwards.length, 1);
    assert.equal(backwards[0].startsAt, '08:00');
    assert.equal(mergeAdjacent([slotBell('09:40-10:20')!]).length, 1);
    assert.deepEqual(mergeAdjacent([]), []);
});

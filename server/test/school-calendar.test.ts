/**
 * The public holidays as the server reads them (lib/school-calendar.ts;
 * owner, 7 Oct 2026). Pure, no database; the calendar is invented.
 *
 * October 2026: the 11th is a Sunday, the 12th a Monday, the 17th a Saturday.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { holidayOn, holidaysBetween } from '../src/lib/school-calendar.js';
import { closedReason } from '../src/lib/cabinet-attendance.js';

const calendar = (...holidays: Array<[string, string, string, string?]>) => ({
    yearStart: '2026-09-01', yearEnd: '2027-06-10',
    holidays: holidays.map(([name, kind, start, end]) => ({ name, kind, start, end: end || start }))
});

test('a public holiday closes its own day, by name', () => {
    const c = calendar(['Измислен празник', 'praznik', '2026-10-23']);
    assert.equal(holidayOn(c, '2026-10-23'), 'Измислен празник');
    assert.equal(holidayOn(c, '2026-10-22'), null);
    assert.equal(holidayOn(c, '2026-10-26'), null, 'a Friday holiday says nothing about the Monday after');
});

test('a public holiday on a Sunday makes the Monday after it non-working', () => {
    const c = calendar(['Празник во недела', 'praznik', '2026-10-11']);
    assert.match(String(holidayOn(c, '2026-10-12')), /^Празник во недела \(празникот е во недела\)$/);
    assert.equal(holidayOn(c, '2026-10-13'), null, 'only the Monday');
    // A holiday S-Дневник already wrote as the Monday is not moved a second time.
    const written = calendar(['Веќе на понеделник', 'praznik', '2026-10-12']);
    assert.equal(holidayOn(written, '2026-10-12'), 'Веќе на понеделник');
    assert.equal(holidayOn(written, '2026-10-13'), null);
});

test('a Saturday holiday moves nothing, and only a praznik is a public holiday', () => {
    assert.equal(holidayOn(calendar(['Во сабота', 'praznik', '2026-10-17']), '2026-10-19'), null);
    const c = calendar(['Распуст', 'raspust', '2026-10-11', '2026-10-11'], ['Екскурзија', 'aktivnost', '2026-10-23']);
    assert.equal(holidayOn(c, '2026-10-12'), null, 'a break ending on a Sunday is not a holiday on a Sunday');
    assert.equal(holidayOn(c, '2026-10-23'), null, 'an excursion is a working day');
});

test('the working days a holiday closes, between two dates; nothing without a calendar', () => {
    const c = calendar(['А', 'praznik', '2026-10-11'], ['Б', 'praznik', '2026-10-17'], ['В', 'praznik', '2026-10-22', '2026-10-23']);
    assert.deepEqual([...holidaysBetween(c, '2026-10-01', '2026-10-31').keys()], ['2026-10-12', '2026-10-22', '2026-10-23']);
    assert.equal(holidaysBetween(null, '2026-10-01', '2026-10-31').size, 0);
    assert.equal(holidayOn(null, '2026-10-12'), null);
    assert.equal(holidayOn(c, 'вчера'), null);
});

test('attendance asks the same question: the Monday after a Sunday holiday is closed there too', () => {
    const context = { year: { starts_on: '2026-09-01', ends_on: '2027-08-31' }, calendar: calendar(['Празник во недела', 'praznik', '2026-10-11']) };
    assert.match(String(closedReason('2026-10-12', context)), /Празник во недела/);
    assert.equal(closedReason('2026-10-13', context), null);
    assert.equal(closedReason('2026-10-11', context), 'Викенд');
});

/**
 * Approximate name matching, on people who do not exist (rule 1).
 *
 * The cases here are the SHAPES the centre's own sheet actually produces — a
 * dropped letter, a keyboard left in the Latin layout, ѓ typed as г, the
 * surname first — written with invented names.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldName, nameKey, nameDistance, nearestNames, clearlyNearest } from '../src/lib/name-match.js';

const ROSTER = [
    { id: 'A', name: 'Михаил Бошевски' },
    { id: 'B', name: 'Мирко Долевски' },
    { id: 'C', name: 'Ѓеоргина Ѓоргиевска' },
    { id: 'D', name: 'Јована Пластовска' },
    { id: 'E', name: 'Јована Пластевска' }
];
const near = (q: string) => nearestNames(q, ROSTER, (r) => r.name);

test('the class prefix and the owner\'s marker are not part of the name', () => {
    assert.equal(foldName('V-а - Прва Пробна (над.)'), 'прва пробна');
    assert.equal(foldName('  ПРВА   ПРОБНА  '), 'прва пробна');
});

test('surname first is the same name', () => {
    assert.equal(nameKey('Бошевски Михаил'), nameKey('Михаил Бошевски'));
    assert.equal(nameDistance('Бошевски Михаил', 'Михаил Бошевски'), 0);
});

test('a dropped letter is distance 1 — the sheet really does this', () => {
    // „Михаил ошевски" appears in the centre's own workbook for „Бошевски".
    assert.equal(nameDistance('Михаил ошевски', 'Михаил Бошевски'), 1);
    assert.equal(near('Михаил ошевски')[0].row.id, 'A');
});

test('a name typed in the Latin layout still finds its owner', () => {
    assert.equal(nameDistance('Mихаил Бошевски', 'Михаил Бошевски'), 0);   // Latin M
});

test('ѓ typed as г is offered, never decided', () => {
    assert.equal(nameDistance('Георгина Горгиевска', 'Ѓеоргина Ѓоргиевска'), 0);
    // Folded to zero distance — and that is exactly why this file may only
    // SUGGEST: those two spellings can be two different people.
    assert.equal(near('Георгина Горгиевска')[0].row.id, 'C');
});

test('a missing surname is not a close match — half a name is not evidence', () => {
    assert.equal(near('Михаил').length, 0);
});

test('a genuinely different name offers nothing', () => {
    assert.deepEqual(near('Ана Тестова'), []);
});

test('two candidates one letter apart are a tie, and read as one', () => {
    const list = near('Јована Пластивска');
    assert.equal(list.length, 2);                       // both Пластовска and Пластевска
    assert.equal(list[0].distance, list[1].distance);
    assert.equal(clearlyNearest(list), false);          // must not be worded as an answer
});

test('one clear candidate is worded as one', () => {
    assert.equal(clearlyNearest(near('Мирко Долески')), true);
});

test('the exact spelling is not offered as a correction of itself', () => {
    assert.equal(near('Михаил Бошевски').some((c) => c.row.id === 'A'), false);
});

test('an empty name asks nothing', () => {
    assert.deepEqual(near(''), []);
    assert.equal(clearlyNearest([]), false);
});

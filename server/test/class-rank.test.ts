/** Pupils follow the arranged class order (owner, 28 Sep 2026). Pure. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderPupils } from '../src/lib/teaching.js';
import { classRank } from '../src/lib/roster-order.js';

const classes = [{ id: 1, label: 'I-а' }, { id: 2, label: 'II-б, III-б' }, { id: 3, label: 'III' }, { id: 4, label: 'IV' }];
const pupils = () => [
    { name: 'Ана', grade: 'IV' }, { name: 'Бојан', grade: 'II-б, III-б' }, { name: 'Вера', grade: 'III' },
    { name: 'Горан', grade: 'I-а' }, { name: 'Дана', grade: 'III' }, { name: 'Ѓорѓи', grade: null }
];

test('a combined class stands where it was placed — here after III, before IV', () => {
    // Podatoci → Одделенија: I-а, III, then the combined class, then IV.
    const rank = classRank(classes, new Map([['1', 0], ['3', 1], ['2', 2], ['4', 3]]));
    assert.deepEqual(orderPupils(pupils(), rank).map((p) => p.name), ['Горан', 'Вера', 'Дана', 'Бојан', 'Ана', 'Ѓорѓи'],
        'the class\'s pupils move together, by name inside it; nobody without a class goes first');
});

test('with nothing arranged, the order is the one by label, as before', () => {
    assert.deepEqual(orderPupils(pupils(), classRank(classes)).map((p) => p.name), orderPupils(pupils()).map((p) => p.name));
});

test('a class nobody placed follows the placed ones, by its label', () => {
    const rank = classRank(classes, new Map([['4', 0]]));
    assert.equal(orderPupils(pupils(), rank)[0].name, 'Ана', 'IV was placed first');
});

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

test('a therapist\'s list reads подготвителна, одделенска, предметна, then the externals (owner, 4 Oct 2026)', () => {
    const list = [
        { name: 'Екстерна', grade: null, kind: 'external' },
        { name: 'Комбинирана', grade: 'Комбинирана II, III, IV', kind: 'internal' },
        { name: 'Седмо', grade: 'VII', kind: 'internal' },
        { name: 'Петто', grade: 'V-а', kind: 'internal' },
        { name: 'Подготвителна', grade: 'подготвителна', kind: 'internal' },
        { name: 'Екстерна во одделение', grade: 'II-а', kind: 'external' },
        { name: 'Без одделение', grade: null, kind: 'internal' }
    ];
    const classesNow = [{ id: 1, label: 'V-а' }, { id: 2, label: 'Комбинирана II, III, IV' }, { id: 3, label: 'VII' },
        { id: 4, label: 'подготвителна' }, { id: 5, label: 'II-а' }];
    for (const rank of [undefined, classRank(classesNow)]) {
        assert.deepEqual(orderPupils(list.slice(), rank).map((p) => p.name),
            ['Подготвителна', 'Комбинирана', 'Петто', 'Седмо', 'Без одделение', 'Екстерна во одделение', 'Екстерна'],
            'a combined class goes up with its youngest grade; externals last whatever their class, by class among them');
    }
});

test('a class nobody placed follows the placed ones, by its label', () => {
    const rank = classRank(classes, new Map([['4', 0]]));
    assert.equal(orderPupils(pupils(), rank)[0].name, 'Ана', 'IV was placed first');
});

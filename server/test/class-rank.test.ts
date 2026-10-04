/**
 * The order a pupil list is read in. Pure.
 * Owner, 28 Sep 2026: the classes as arranged in Податоци. Owner, 4 Oct 2026:
 * the grade first — a combined class as its YOUNGEST — and the arrangement
 * only among classes of one grade.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderPupils } from '../src/lib/teaching.js';
import { classRank } from '../src/lib/roster-order.js';

const classes = [{ id: 1, label: 'I-а' }, { id: 2, label: 'II-б, III-б' }, { id: 3, label: 'III' }, { id: 4, label: 'IV' }];
const pupils = () => [
    { name: 'Ана', grade: 'IV' }, { name: 'Бојан', grade: 'II-б, III-б' }, { name: 'Вера', grade: 'III' },
    { name: 'Горан', grade: 'I-а' }, { name: 'Дана', grade: 'III' }, { name: 'Ѓорѓи', grade: null }
];

test('a combined class goes with its youngest grade, wherever it was placed (owner, 4 Oct 2026)', () => {
    // Podatoci → Одделенија placed it after III; it is II-б, III-б, so it is II.
    const rank = classRank(classes, new Map([['1', 0], ['3', 1], ['2', 2], ['4', 3]]));
    assert.deepEqual(orderPupils(pupils(), rank).map((p) => p.name), ['Горан', 'Бојан', 'Вера', 'Дана', 'Ана', 'Ѓорѓи'],
        'the class\'s pupils move together, by name inside it; nobody without a class goes first');
});

test('Комбинирана II, III, IV placed after V-а still comes before it — the owner\'s own list', () => {
    const now = [{ id: 1, label: 'V-а' }, { id: 2, label: 'Комбинирана II, III, IV' }, { id: 3, label: 'VI-а' }];
    const rank = classRank(now, new Map([['1', 0], ['2', 1], ['3', 2]]));
    const list = [{ name: 'Јана', grade: 'V-а' }, { name: 'Азире', grade: 'Комбинирана II, III, IV' }, { name: 'Алмедина', grade: 'VI-а' }];
    assert.deepEqual(orderPupils(list, rank).map((p) => p.name), ['Азире', 'Јана', 'Алмедина']);
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

test('among classes of ONE grade, the placed one comes first', () => {
    const fifth = [{ id: 1, label: 'V-а' }, { id: 2, label: 'V-б' }];
    const list = [{ name: 'Ана', grade: 'V-а' }, { name: 'Бојан', grade: 'V-б' }];
    assert.deepEqual(orderPupils(list.slice(), classRank(fifth, new Map([['2', 0]]))).map((p) => p.name), ['Бојан', 'Ана'], 'V-б was placed first');
    assert.deepEqual(orderPupils(list.slice(), classRank(fifth)).map((p) => p.name), ['Ана', 'Бојан'], 'nobody placed: by label');
});

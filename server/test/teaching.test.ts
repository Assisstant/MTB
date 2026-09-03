/**
 * Reading the timetable workbook.
 *
 * The grid below is the same SHAPE as the school's own sheet — two stacked
 * tables read in opposite directions — with invented teachers and invented
 * classes, because the real workbook never enters this repository (rules 1
 * and 6).
 *
 *     npm run test:crossing
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTeachingGrid, compareClassLabels, classSortKey, orderPupils } from '../src/lib/teaching.js';

/**
 * Two days is enough to prove the column→day carry-forward; seven periods is
 * enough to prove the trailing "/" cells are dropped.
 */
const GRID: unknown[][] = [
    // 0: header band — the day banner sits in the first column of its run
    ['ИМЕ И ПРЕЗИМЕ', 'ОДД.', 'ПОНЕДЕЛНИК', null, null, null, null, null, null, 'ВТОРНИК', null, null, null, null, null, null],
    // 1: the sheet also prints clock times here
    [null, null, '07:30 | 13:45', '08:15 | 14:30', '09:10 | 15:25', '09:55 | 16:10', '10:40 | 16:55', '11:25 | 17:40', '12:10 | 18:25',
                 '07:30 | 13:45', '08:15 | 14:30', '09:10 | 15:25', '09:55 | 16:10', '10:40 | 16:55', '11:25 | 17:40', '12:10 | 18:25'],
    // 2: period numbers
    [null, null, 1, 2, 3, 4, 5, 6, 7, 1, 2, 3, 4, 5, 6, 7],
    // 3..4: одделенска — the cell is the SUBJECT
    ['ПРВА ПРОБНА', 'I а', 'мак.', 'мат.', 'з.о.', '/', '/', '/', '/', 'мат.', 'мак.', '/', '/', '/', '/', '/'],
    ['ВТОРА ПРОБНА', 'I б', 'одд.', 'мак.', '/', '/', '/', '/', '/', 'мак.', 'мат.', 'муз.', '/', '/', '/', '/'],
    // 5: second header band — everything below is предметна
    ['ИМЕ И ПРЕЗИМЕ', 'ОДД.', 'ПОНЕДЕЛНИК', null, null, null, null, null, null, 'ВТОРНИК', null, null, null, null, null, null],
    [null, null, 1, 2, 3, 4, 5, 6, 7, 1, 2, 3, 4, 5, 6, 7],
    // 6..8: предметна — the cell is the CLASS
    ['ТРЕТА ПРОБНА', 'VI', 'VI', 'VII а', '/', '/', '/', '/', '/', 'VI', '/', '/', '/', '/', '/', '/'],
    ['ЧЕТВРТА ПРОБНА', 'АНГ.', '/', 'VI', 'VII а', '/', '/', '/', '/', '/', 'VII а', '/', '/', '/', '/', '/'],
    ['ПЕТТА ПРОБНА', 'ФЗО.', '/', '/', '/', 'I а', '/', '/', '/', '/', '/', 'I б', '/', '/', '/', '/']
];

test('the two halves of the sheet are read in opposite directions', () => {
    const out = parseTeachingGrid(GRID);
    assert.deepEqual(out.problems, []);

    const kinds = Object.fromEntries(out.teachers.map((t) => [t.name, t.kind]));
    assert.equal(kinds['ПРВА ПРОБНА'], 'odd');
    assert.equal(kinds['ВТОРА ПРОБНА'], 'odd');
    assert.equal(kinds['ТРЕТА ПРОБНА'], 'pred');
    assert.equal(kinds['ЧЕТВРТА ПРОБНА'], 'pred');

    // Class teaching: the class comes from the ОДД. column, the subject from the cell.
    const monday1 = out.lessons.filter((l) => l.day === 'понеделник' && l.ordinal === 1);
    const first = monday1.find((l) => l.teacher === 'ПРВА ПРОБНА');
    assert.equal(first?.classLabel, 'I-а');
    assert.equal(first?.subject, 'мак.');

    // Subject teaching: the class comes from the CELL.
    const third = monday1.find((l) => l.teacher === 'ТРЕТА ПРОБНА');
    assert.equal(third?.classLabel, 'VI');
});

test('the day banner carries across its columns', () => {
    const out = parseTeachingGrid(GRID);
    const days = new Set(out.lessons.map((l) => l.day));
    assert.deepEqual(Array.from(days).sort(), ['вторник', 'понеделник']);
    // Tuesday period 2 for the first class teacher is "мак.", from column 10.
    const tue2 = out.lessons.find((l) => l.day === 'вторник' && l.ordinal === 2 && l.teacher === 'ПРВА ПРОБНА');
    assert.equal(tue2?.subject, 'мак.');
    assert.equal(tue2?.dayOrder, 2);
});

test('"/" is a free period, not a lesson called slash', () => {
    const out = parseTeachingGrid(GRID);
    assert.equal(out.lessons.some((l) => l.subject === '/' || l.classLabel === '/'), false);
    // ПРВА has 3 subjects on Monday and 2 on Tuesday.
    assert.equal(out.lessons.filter((l) => l.teacher === 'ПРВА ПРОБНА').length, 5);
});

test('a subject teacher who also leads a class gets no invented subject', () => {
    const out = parseTeachingGrid(GRID);
    const third = out.teachers.find((t) => t.name === 'ТРЕТА ПРОБНА');
    assert.equal(third?.homeroom, 'VI');
    assert.equal(third?.subject, '');
    // and the lessons they teach carry no made-up subject either
    assert.equal(out.lessons.filter((l) => l.teacher === 'ТРЕТА ПРОБНА').every((l) => l.subject === ''), true);
    // but it IS reported, so somebody types it in
    assert.ok(out.notes.some((n) => n.includes('ТРЕТА ПРОБНА')), out.notes.join(' | '));
});

test('a subject teacher with a named subject carries it to every class', () => {
    const out = parseTeachingGrid(GRID);
    const fifth = out.lessons.filter((l) => l.teacher === 'ПЕТТА ПРОБНА');
    assert.equal(fifth.length, 2);
    assert.deepEqual(fifth.map((l) => l.classLabel).sort(), ['I-а', 'I-б']);
    assert.equal(fifth.every((l) => l.subject === 'ФЗО.'), true);
});

test('classes are collected from both halves and sorted like a school list', () => {
    const out = parseTeachingGrid(GRID);
    assert.deepEqual(out.classes, ['I-а', 'I-б', 'VI', 'VII-а']);
    assert.deepEqual(['X', 'II', 'IX-б', 'IX-а'].sort(compareClassLabels), ['II', 'IX-а', 'IX-б', 'X']);
    assert.equal(classSortKey('IV-б'), '04-б');
    assert.equal(classSortKey('VI'), '06-');
});

test('the pupil list reads like a roster, not like an alphabet', () => {
    // Exactly the order the pupil picker was showing: sorting the TEXT puts IX
    // between IV and V, because 'I' < 'V', and подготвителна after VIII because
    // Cyrillic sorts after Latin. A person reading a roster expects neither.
    const roster = [
        { grade: 'VIII', name: 'Рејхан' },
        { grade: 'IX-б', name: 'Јован' },
        { grade: 'I', name: 'Бајрам' },
        { grade: 'подготвителна', name: 'Кевин' },
        { grade: 'V', name: 'Јана' },
        { grade: 'IX-а', name: 'Мека' },
        { grade: 'II-б', name: 'Мирко' },
        { grade: 'II-а', name: 'Азире' },
        { grade: 'IV', name: 'Јана' },
        { grade: 'Подготвително', name: 'Лара' },
        { grade: null, name: 'Сарди' }
    ];
    assert.deepEqual(orderPupils(roster).map((r) => r.grade + ' ' + r.name), [
        'подготвителна Кевин',
        'Подготвително Лара',
        'I Бајрам',
        'II-а Азире',
        'II-б Мирко',
        'IV Јана',
        'V Јана',
        'VIII Рејхан',
        'IX-а Мека',
        'IX-б Јован',
        'null Сарди'          // no grade at all stays at the end, as NULLS LAST did
    ]);
});

test('two pupils in one grade are ordered by name, in Macedonian', () => {
    const same = [{ grade: 'VI', name: 'Рифат' }, { grade: 'VI', name: 'Алмедина' },
                  { grade: 'VI', name: 'Ѓорѓи' }, { grade: 'VI', name: 'Дејан' }];
    assert.deepEqual(orderPupils(same).map((r) => r.name),
        ['Алмедина', 'Дејан', 'Ѓорѓи', 'Рифат']);
});

test('the preparatory year is early for a class too, not only for a pupil', () => {
    // classSortKey feeds school_classes.sort_key, so the two must agree or the
    // class list and the pupil list disagree about the same school.
    assert.equal(classSortKey('подготвителна'), '00-');
    assert.deepEqual(['V', 'подготвителна', 'I'].sort(compareClassLabels),
        ['подготвителна', 'I', 'V']);
});

test('a sheet that is not the timetable says so instead of returning nothing', () => {
    const out = parseTeachingGrid([['Ученик', 'Оценка'], ['Проба', 5]]);
    assert.equal(out.lessons.length, 0);
    assert.equal(out.problems.length, 1);
    assert.match(out.problems[0], /header row/);
});

test('a class-teacher row whose ОДД. column is not a class is reported, not guessed', () => {
    const broken = GRID.map((r) => r.slice());
    broken[3] = ['ШЕСТА ПРОБНА', '???', 'мак.', '/', '/', '/', '/', '/', '/', '/', '/', '/', '/', '/', '/', '/'];
    const out = parseTeachingGrid(broken);
    assert.ok(out.problems.some((p) => p.includes('ШЕСТА ПРОБНА')), out.problems.join(' | '));
    assert.equal(out.lessons.some((l) => l.teacher === 'ШЕСТА ПРОБНА'), false);
});

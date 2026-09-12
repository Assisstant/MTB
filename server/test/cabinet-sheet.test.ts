/**
 * The cabinet workbook reader, on a centre that does not exist.
 *
 * Every name here is invented (rule 1). The shape is the real sheet's: a day
 * banner merged down its block, periods in Roman numerals, one column per
 * cabinet, and „А/Б" for a block split into two twenty-minute halves.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCabinetGrid, cabinetDay, cabinetPeriod, clashingPupils } from '../src/lib/cabinet-sheet.js';

const SHEET: string[][] = [
    ['', 'Час', 'КАБИНЕТ', '', '', ''],
    ['', '', 'Биофидбек', 'Сензорна', 'Логопед', 'Монтесори'],
    ['Понеделник', 'I.', 'Прва Пробна', 'Втор Пробен', 'Трета Пробна/Четврти Пробен', ''],
    ['', 'II.', 'Втор Пробен', '', '', 'Прва Пробна'],
    ['', 'III.', '', '', 'Петта Пробна', ''],
    ['Вторник', 'I.', 'Четврти Пробен', 'Прва Пробна', '', ''],
    ['', 'II.', '', 'Петта Пробна', '', '']
];

test('the day banner carries down its block', () => {
    const sheet = parseCabinetGrid(SHEET);
    const monday = sheet.cells.filter((c) => c.day === 'понеделник');
    const tuesday = sheet.cells.filter((c) => c.day === 'вторник');
    assert.equal(monday.length, 6);
    assert.equal(tuesday.length, 3);
    // The second Monday row carries no day of its own and must not be lost.
    assert.ok(monday.some((c) => c.period === 2 && c.cabinet === 'Монтесори'));
});

test('the cabinet names come from the second header row, not the banner', () => {
    const sheet = parseCabinetGrid(SHEET);
    assert.deepEqual(sheet.cabinets.map((c) => c.label),
        ['Биофидбек', 'Сензорна', 'Логопед', 'Монтесори']);
});

test('one name is the whole block, two names are its halves', () => {
    const sheet = parseCabinetGrid(SHEET);
    const whole = sheet.cells.find((c) => c.period === 1 && c.cabinet === 'Биофидбек')!;
    const split = sheet.cells.find((c) => c.period === 1 && c.cabinet === 'Логопед')!;
    assert.deepEqual(whole.pupils, ['Прва Пробна']);
    assert.deepEqual(split.pupils, ['Трета Пробна', 'Четврти Пробен']);
});

test('the day order is the one the crossing sorts by', () => {
    const sheet = parseCabinetGrid(SHEET);
    assert.equal(sheet.cells.find((c) => c.day === 'понеделник')!.dayOrder, 1);
    assert.equal(sheet.cells.find((c) => c.day === 'вторник')!.dayOrder, 2);
});

test('an empty cell is not a session', () => {
    const sheet = parseCabinetGrid(SHEET);
    assert.equal(sheet.cells.filter((c) => c.pupils.length === 0).length, 0);
    assert.equal(sheet.cells.some((c) => c.period === 3 && c.cabinet === 'Сензорна'), false);
});

test('three names in one cell are reported, not truncated to two', () => {
    const sheet = parseCabinetGrid([
        ['', 'Час', '', ''],
        ['', '', 'Логопед', 'Сензорна'],
        ['Среда', 'I.', 'Прва Пробна/Втор Пробен/Трета Пробна', '']
    ]);
    assert.equal(sheet.cells.length, 0);
    assert.equal(sheet.problems.length, 1);
    assert.match(sheet.problems[0], /3 имиња/);
});

test('a half-written split is reported rather than half-read', () => {
    const sheet = parseCabinetGrid([
        ['', 'Час', '', ''],
        ['', '', 'Логопед', 'Сензорна'],
        ['Среда', 'I.', 'Прва Пробна/', '']
    ]);
    assert.equal(sheet.cells.length, 0);
    assert.match(sheet.problems[0], /не можам да ги разделам/);
});

test('a row with terms but no period is reported, never attached to the row above', () => {
    const sheet = parseCabinetGrid([
        ['', 'Час', '', ''],
        ['', '', 'Логопед', 'Сензорна'],
        ['Среда', 'I.', 'Прва Пробна', ''],
        ['', '', 'Втор Пробен', '']
    ]);
    assert.equal(sheet.cells.length, 1);
    assert.equal(sheet.problems.length, 1);
    assert.match(sheet.problems[0], /нема час/);
});

test('Cyrillic look-alike numerals read as the periods they look like', () => {
    assert.equal(cabinetPeriod('ІІІ.'), 3);     // Cyrillic І
    assert.equal(cabinetPeriod('IV'), 4);
    assert.equal(cabinetPeriod('VI.'), 6);
    assert.equal(cabinetPeriod('7'), 0);        // Arabic is not this sheet's spelling
    assert.equal(cabinetPeriod(''), 0);
});

test('a day is recognised however it is typed, and nothing else is', () => {
    assert.equal(cabinetDay('Понеделник'), 'понеделник');
    assert.equal(cabinetDay('ВТОРНИК'), 'вторник');
    assert.equal(cabinetDay('пет.'), 'петок');
    assert.equal(cabinetDay('Сабота'), '');
    assert.equal(cabinetDay(''), '');
});

test('a duplicated cabinet column is reported', () => {
    const sheet = parseCabinetGrid([
        ['', 'Час', '', '', ''],
        ['', '', 'Логопед', 'Сензорна', 'Логопед'],
        ['Среда', 'I.', 'Прва Пробна', '', 'Втор Пробен']
    ]);
    assert.equal(sheet.problems.length, 1);
    assert.match(sheet.problems[0], /двапати/);
});

test('one pupil in two cabinets at the same time is reported', () => {
    const sheet = parseCabinetGrid([
        ['', 'Час', '', ''],
        ['', '', 'Логопед', 'Сензорна'],
        ['Среда', 'I.', 'Прва Пробна', 'Прва Пробна']
    ]);
    assert.equal(clashingPupils(sheet.cells).length, 1);
});

test('the two halves of a block are different times, so they are not a clash', () => {
    const sheet = parseCabinetGrid([
        ['', 'Час', '', ''],
        ['', '', 'Логопед', 'Сензорна'],
        ['Среда', 'I.', 'Прва Пробна/Втор Пробен', 'Втор Пробен/Прва Пробна']
    ]);
    // first half: Прва in Логопед, Втор in Сензорна; second half the other way
    assert.deepEqual(clashingPupils(sheet.cells), []);
});

test('a sheet with no periods at all says so instead of returning nothing', () => {
    const sheet = parseCabinetGrid([['', '', 'Логопед'], ['', '', 'Прва Пробна']]);
    assert.equal(sheet.cells.length, 0);
    assert.match(sheet.problems[0], /Ниту еден ред/);
});

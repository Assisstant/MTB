// Phase 5 of the action plan: what the евидентен лист may suggest, and what it
// must not claim (lib/pupil-plan-evidence.ts). Invented items and marks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { prioritiesOf, type EvidenceItem, type Period } from '../src/lib/pupil-plan-evidence.js';

const LEVEL = { code: 's4', title: 'IV. ГОВОРНО - ЈАЗИЧНО ПОДРАЧЈЕ', scale: 'level' as const };
const MARK = { code: 's7', title: 'VII. ПСИХОЛОШКО ПОДРАЧЈЕ', scale: 'mark' as const };
const item = (id: number, section: EvidenceItem['section'] = LEVEL): EvidenceItem => ({ id, label: 'Ставка ' + id, group: null, section });
// Stored out of order on purpose: the columns are compared by `ord`, never by id or position.
const PERIODS: Period[] = [{ id: 30, ord: 3, label: 'Трет', short: 'III' }, { id: 10, ord: 1, label: 'Прв', short: 'I' }, { id: 20, ord: 2, label: 'Втор', short: 'II' }];
const marks = (entries: Record<number, Record<number, string>>) =>
    new Map(Object.entries(entries).map(([id, byPeriod]) => [Number(id), new Map(Object.entries(byPeriod).map(([p, v]) => [Number(p), v]))]));

test('a level that fell between two assessed periods of the year is a decline; the latest at 1 is low', () => {
    const out = prioritiesOf([item(1), item(2), item(3), item(4)], PERIODS, marks({
        1: { 10: '3', 20: '2' },          // fell, not low
        2: { 10: '2', 20: '1' },          // fell to 1: both
        3: { 10: '1', 20: '1' },          // stays at 1: low, no decline
        4: { 10: '1', 20: '2', 30: '3' }  // rose: nothing to suggest
    }));
    assert.deepEqual(out.map((s) => [s.id, s.why]), [[1, ['decline']], [2, ['decline', 'low']], [3, ['low']]]);
    assert.deepEqual(out[0].marks, [{ period: 'I', value: '3' }, { period: 'II', value: '2' }], 'its marks in period order');
});

test('the columns are taken by their order, whatever order they come in', () => {
    const [s] = prioritiesOf([item(1)], PERIODS, marks({ 1: { 30: '1', 10: '3' } }));
    assert.deepEqual(s.why, ['decline', 'low']);
    assert.deepEqual(s.marks.map((m) => m.period), ['I', 'III']);
});

test('not assessed and „does not apply" are no mark at all', () => {
    assert.deepEqual(prioritiesOf([item(1), item(2), item(3)], PERIODS, marks({
        1: { 10: '3', 20: '/' },          // the later one does not apply: nothing fell
        2: { 10: '/', 20: '/' },
        3: { 10: '', 20: '' }
    })), []);
    const [s] = prioritiesOf([item(1)], PERIODS, marks({ 1: { 10: '3', 20: '/', 30: '2' } }));
    assert.deepEqual([s.why, s.marks.length], [['decline'], 2], 'compared across the period that did not apply, between two that did');
    assert.deepEqual(prioritiesOf([item(9)], PERIODS, marks({})), [], 'an item never assessed suggests nothing');
});

test('a changed √/X is a reason to look again, never a decline or a low level', () => {
    const out = prioritiesOf([item(1, MARK), item(2, MARK), item(3, MARK)], PERIODS, marks({
        1: { 10: '√', 20: 'X' }, 2: { 10: 'X', 20: 'X' }, 3: { 10: 'X' }
    }));
    assert.deepEqual(out.map((s) => [s.id, s.why]), [[1, ['changed']]]);
});

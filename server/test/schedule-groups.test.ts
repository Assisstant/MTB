// Group terms (063; owner, 14 Oct 2026): how a block of rows is read, what an
// old document's cell holds, and what is still a problem. Invented names.
import test from 'node:test';
import assert from 'node:assert/strict';
import { blockTogether, semanticBlock } from '../src/routes/schedule-write.js';
import { cellPupils } from '../src/lib/import-core.js';
import { scheduleProblems } from '../src/lib/schedule-conflicts.js';

const times = { full: '08:00-08:40', halves: ['08:00-08:20', '08:20-08:40'] as [string, string] };
const row = (time_slot: string, student_public_id: string | null) => ({ time_slot, student_public_id });

test('several rows with the whole bell are a group, in the order they were written', () => {
    const rows = [row('08:00-08:40', 'p-b'), row('08:00-08:40', 'p-a'), row('08:00-08:40', 'p-c')];
    assert.deepEqual(semanticBlock(rows, times), ['p-b', 'p-a', 'p-c']);
    assert.equal(blockTogether(rows, times), true);
});

test('one pupil, and two halves, read as before', () => {
    assert.deepEqual(semanticBlock([row('08:00-08:40', 'p-a')], times), ['p-a']);
    assert.equal(blockTogether([row('08:00-08:40', 'p-a')], times), false);
    const halves = [row('08:00-08:20', 'p-a'), row('08:20-08:40', 'p-b')];
    assert.deepEqual(semanticBlock(halves, times), ['p-a', 'p-b']);
    assert.equal(blockTogether(halves, times), false);
    assert.equal(blockTogether([row('08:00-08:40', 'p-a'), row('08:00-08:40', null)], times), false, 'a row without a pupil is nobody');
});

test('the whole bell beside a half is still a contradiction, never a guess', () => {
    assert.equal(semanticBlock([row('08:00-08:40', 'p-a'), row('08:00-08:40', 'p-b'), row('08:20-08:40', 'p-c')], times), null);
});

test('an old document cell: one pupil, or the whole group from the additive field', () => {
    assert.deepEqual(cellPupils({ assignments: { T: 'Ана' } }, 'T', 'Ана'), ['Ана']);
    assert.deepEqual(cellPupils({ assignments: { T: 'Ана' }, groups: { T: ['Ана', 'Бојан', 'Вера'] } }, 'T', 'Ана'), ['Ана', 'Бојан', 'Вера']);
    assert.deepEqual(cellPupils({ groups: { T: ['Ана'] } }, 'T', 'Бојан'), ['Бојан'], 'a group of one is no group: the cell says who');
    assert.deepEqual(cellPupils({ groups: { T: ['Ана', ' Ана ', ''] } }, 'T', 'Ана'), ['Ана'], 'blanks and repeats go');
    assert.deepEqual(cellPupils({}, 'T', 'Избери Ученик'), [], 'the placeholder of the old picker is nobody');
});

test('one cabinet at one time with several pupils is a group; overlapping different times still are not', () => {
    const term = (time: string, student: string) => ({ day: 'понеделник', time, therapist: 't', student, studentName: student });
    assert.deepEqual(scheduleProblems([term('08:00-08:40', 'a'), term('08:00-08:40', 'b'), term('08:00-08:40', 'c')], []), []);
    assert.equal(scheduleProblems([term('08:00-08:40', 'a'), term('08:20-08:40', 'b')], []).length, 1);
});

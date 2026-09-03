import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRosterConsistency, readArchive } from '../src/lib/import-core.js';

function report() {
    return { notes: [] as string[], problems: [] as string[] };
}

test('former caseload students still represent their attendance and progress', () => {
    const payload = {
        students: [{ id: 4101, name: 'Active Example', grade: 'V' }],
        formerCaseloadStudents: [{ id: 4102, name: 'Former Example', grade: 'VI' }],
        archivedStudents: [],
        attendance: {
            '2026-09-07': {
                4102: { 'monday-0': { status: 'present' } }
            }
        },
        studentProgress: { 4102: { 5101: [0] } },
        plans: []
    };
    const result = report();

    checkRosterConsistency(payload, readArchive(payload), result);

    assert.deepEqual(result.problems, []);
});

test('an unknown attendance owner is still reported', () => {
    const payload = {
        students: [{ id: 4201, name: 'Active Example', grade: 'V' }],
        formerCaseloadStudents: [],
        archivedStudents: [],
        attendance: {
            '2026-09-07': {
                4299: { 'monday-0': { status: 'present' } }
            }
        },
        studentProgress: {},
        plans: []
    };
    const result = report();

    checkRosterConsistency(payload, readArchive(payload), result);

    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /neither active, former caseload, nor archived/);
});

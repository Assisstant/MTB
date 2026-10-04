import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audiogramStudentId, audiogramStudentMap } from '../src/lib/records.js';

test('saving an audiogram under its recorded name follows an explicitly merged pupil', async () => {
    const db = { query: async () => ({ rows: [
        { id: 1, public_id: 'old', name: 'Invented Old', left_reason: 'merged:middle' },
        { id: 2, public_id: 'middle', name: 'Invented Middle', left_reason: 'merged:keep' },
        { id: 3, public_id: 'keep', name: 'Invented Kept', left_reason: null }
    ] }) };
    assert.equal(await audiogramStudentId(db, 'Invented Old'), 3);
    assert.equal(await audiogramStudentId(db, 'Invented Middle'), 3);
    assert.equal(await audiogramStudentId(db, 'Invented Kept'), 3);
});

test('ambiguous names and broken or circular merge links do not guess an identity', async () => {
    const db = { query: async () => ({ rows: [
        { id: 1, public_id: 'a', name: 'Same Name', left_reason: null },
        { id: 2, public_id: 'b', name: 'Same Name', left_reason: null },
        { id: 3, public_id: 'c', name: 'Missing Target', left_reason: 'merged:missing' },
        { id: 4, public_id: 'd', name: 'Circular Link', left_reason: 'merged:d' }
    ] }) };
    assert.deepEqual([...await audiogramStudentMap(db)].map(([, id]) => id), [null, null, null]);
});

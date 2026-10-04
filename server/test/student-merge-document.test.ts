import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeInDiaryDocument } from '../src/lib/student-merge.js';

test('merging duplicate pupils preserves both sets of current and archived plan progress', () => {
    const doc = {
        studentProgress: { 11: { 5: [0, 2], 6: [1] }, 22: { 5: [1, 2], 7: [3] } },
        progressArchive: { '2025/2026': { 11: { 5: [0] }, 22: { 5: [1] } } }
    };
    mergeInDiaryDocument(doc, { from: '22', to: '11', foldedPublicId: 'fold', keptPublicId: 'keep' });
    assert.deepEqual(doc.studentProgress, { 11: { 5: [0, 2, 1], 6: [1], 7: [3] } });
    assert.deepEqual(doc.progressArchive, { '2025/2026': { 11: { 5: [0, 1] } } });
});

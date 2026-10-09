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

test('real progress objects merge by activity index, preserving the kept record and archived years', () => {
    const kept = { index: 0, date: '2026-10-05', time: '08:00-08:40' };
    const later = { index: 1, date: '2026-10-06', time: '08:00-08:40' };
    const duplicate = { ...kept };
    const conflicting = { ...kept, date: '2026-10-07' };
    const doc = {
        studentProgress: { 11: { 5: [kept] }, 22: { 5: [duplicate, conflicting, later] } },
        progressArchive: { '2025/2026': { 11: { 5: [kept] }, 22: { 5: [duplicate, later] } } }
    };
    mergeInDiaryDocument(doc, { from: '22', to: '11', foldedPublicId: 'fold', keptPublicId: 'keep' });
    assert.deepEqual(doc.studentProgress, { 11: { 5: [kept, later] } });
    assert.deepEqual(doc.progressArchive, { '2025/2026': { 11: { 5: [kept, later] } } });
});

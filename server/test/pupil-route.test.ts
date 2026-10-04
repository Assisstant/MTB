import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

// One route for a pupil's facts (4 Oct 2026): `PUT /api/workspace/pupils`,
// which checks the year's class, programme and placement. `PATCH /api/students`
// checks less and stays only for the legacy Rasporedi.html (rule 4). A page
// that starts calling it again is a second set of rules for the same edit.
const ROOT = resolve(import.meta.dirname, '../..');
const LEGACY = new Set(['Rasporedi.html', 'Dnevnik-Rasporedi-SafeSync.html', 'РаспоредТерапевти.html']);

test('no current page saves a pupil through PATCH /api/students', () => {
    const pages = readdirSync(ROOT).filter((f) => /\.(html|js)$/.test(f) && !LEGACY.has(f));
    const offenders = pages.filter((f) => /['"]PATCH['"][^\n]{0,80}\/api\/students/.test(readFileSync(resolve(ROOT, f), 'utf8')));
    assert.deepEqual(offenders, []);
});

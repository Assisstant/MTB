/**
 * Stage B, against a real server and a real database.
 *
 * Not in `npm test` because it needs both running. Run it deliberately:
 *
 *     npm run start                # in one terminal
 *     npx tsx test/roster-write.e2e.ts
 *
 * What it is here to prove, in order of how much it would cost to get wrong:
 *
 *   1. Rasporedi cannot un-archive anyone. That is S-Dnevnik's decision and
 *      the roster arriving from a browser that has not pulled yet is not
 *      evidence against it.
 *   2. A rename keeps the row, so terms and diary entries follow it.
 *   3. Nothing here deletes a person.
 *   4. Stage A's hole is closed: a cell naming a brand-new student used to
 *      404 and vanish; with the roster written first it lands.
 */

import assert from 'node:assert/strict';
import { pool } from '../src/db.js';
import { stableStudentIdForName } from '../src/lib/import-core.js';

const BASE = process.env.API || 'http://127.0.0.1:3000';

// Invented names only — this repository is public (CLAUDE.md rule 1).
const STUDENT = 'Тест Ученикоски';
const RENAMED = 'Тест Ученикоска-Нова';
const THERAPIST = 'Тест Терапевтоски';
const T_RENAMED = 'Тест Терапевтоска-Нова';
const PUBLIC_ID = stableStudentIdForName(STUDENT);
const EXTERNAL_STUDENT = 'Тест Екстерен Ученик';
const EXTERNAL_ID = stableStudentIdForName(EXTERNAL_STUDENT);

let failures = 0;
function check(label: string, fn: () => void) {
    try { fn(); console.log(`  ok   ${label}`); }
    catch (err: any) { failures++; console.log(`  FAIL ${label}\n       ${err.message}`); }
}

async function call(method: string, path: string, body?: any) {
    const res = await fetch(BASE + path, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined
    });
    let json: any = null;
    try { json = await res.json(); } catch { /* empty body */ }
    return { status: res.status, body: json };
}

async function cleanup() {
    await pool.query(
        `DELETE FROM schedule_slots WHERE therapist_id IN
             (SELECT id FROM therapists WHERE name = ANY($1::text[]))`,
        [[THERAPIST, T_RENAMED]]
    );
    await pool.query('DELETE FROM student_enrollments WHERE student_id IN (SELECT id FROM students WHERE public_id = ANY($1::text[]))', [[PUBLIC_ID, EXTERNAL_ID]]);
    await pool.query('DELETE FROM students WHERE public_id = ANY($1::text[])', [[PUBLIC_ID, EXTERNAL_ID]]);
    await pool.query('DELETE FROM therapists WHERE name = ANY($1::text[])', [[THERAPIST, T_RENAMED]]);
}

async function main() {
    await cleanup();
    console.log(`\nStage B — roster writes  (${BASE})\n`);

    // ── students ──────────────────────────────────────────────────────────
    console.log('students');

    const add = await call('POST', '/api/students', { publicId: PUBLIC_ID, name: STUDENT, grade: 'III-а' });
    check('a new student is created', () => {
        assert.equal(add.status, 200);
        assert.equal(add.body.created, true);
        assert.equal(add.body.student.name, STUDENT);
    });

    const enrolled = await pool.query(
        `SELECT e.grade FROM student_enrollments e
           JOIN students s ON s.id = e.student_id
           JOIN school_years y ON y.id = e.school_year_id AND y.is_current
          WHERE s.public_id = $1`, [PUBLIC_ID]);
    check('and enrolled in the current year, like writeAll does', () => {
        assert.equal(enrolled.rowCount, 1);
        assert.equal(enrolled.rows[0].grade, 'III-а');
    });

    const addExternal = await call('POST', '/api/students',
        { publicId: EXTERNAL_ID, name: EXTERNAL_STUDENT, grade: 'III-б', kind: 'external' });
    const externalEnrollment = await pool.query(
        `SELECT e.grade, e.kind FROM student_enrollments e
           JOIN students s ON s.id = e.student_id
           JOIN school_years y ON y.id = e.school_year_id AND y.is_current
          WHERE s.public_id = $1`, [EXTERNAL_ID]);
    check('an external student is added to the external list, not a class', () => {
        assert.equal(addExternal.status, 200);
        assert.equal(externalEnrollment.rowCount, 1);
        assert.equal(externalEnrollment.rows[0].grade, null);
        assert.equal(externalEnrollment.rows[0].kind, 'external');
    });

    const again = await call('POST', '/api/students', { publicId: PUBLIC_ID, name: STUDENT, grade: 'III-а' });
    const rowCount = await pool.query('SELECT count(*)::int n FROM students WHERE public_id = $1', [PUBLIC_ID]);
    check('sending it twice does not make a second child', () => {
        assert.equal(again.body.created, false);
        assert.equal(rowCount.rows[0].n, 1);
    });

    const dbId = (await pool.query('SELECT id FROM students WHERE public_id = $1', [PUBLIC_ID])).rows[0].id;

    const rename = await call('PATCH', `/api/students/${encodeURIComponent(PUBLIC_ID)}`,
        { name: RENAMED, grade: 'IV-а', expected: STUDENT });
    const afterRename = await pool.query('SELECT id, name, grade FROM students WHERE public_id = $1', [PUBLIC_ID]);
    check('a rename keeps the same row — terms and diary follow it', () => {
        assert.equal(rename.status, 200);
        assert.equal(afterRename.rows[0].id, dbId, 'the row id moved; every foreign key would be orphaned');
        assert.equal(afterRename.rows[0].name, RENAMED);
        assert.equal(afterRename.rows[0].grade, 'IV-а');
    });

    const stale = await call('PATCH', `/api/students/${encodeURIComponent(PUBLIC_ID)}`,
        { name: 'Друго Име', expected: STUDENT });
    check('renaming from a name that is no longer there is refused', () => {
        assert.equal(stale.status, 409);
        assert.equal(stale.body.actual, RENAMED);
    });

    // The point of the whole stage. S-Dnevnik archives; Rasporedi still lists
    // them because that browser has not pulled. It must not switch them back.
    await pool.query(
        `UPDATE students SET active = false, left_at = now(), left_year = '2025/2026', left_reason = 'moved'
          WHERE public_id = $1`, [PUBLIC_ID]);

    const revive = await call('POST', '/api/students', { publicId: PUBLIC_ID, name: RENAMED, grade: 'IV-а' });
    const stillGone = await pool.query('SELECT active, left_reason FROM students WHERE public_id = $1', [PUBLIC_ID]);
    check('an archived student is NOT brought back by the roster', () => {
        assert.equal(revive.status, 409);
        assert.equal(revive.body.archived, true);
        assert.equal(stillGone.rows[0].active, false, 'Rasporedi re-enrolled someone S-Dnevnik retired');
        assert.equal(stillGone.rows[0].left_reason, 'moved', 'the reason S-Dnevnik recorded was overwritten');
    });

    const editArchived = await call('PATCH', `/api/students/${encodeURIComponent(PUBLIC_ID)}`, { grade: 'V-а' });
    check('nor edited behind S-Dnevnik\'s back', () => assert.equal(editArchived.status, 409));

    await pool.query('UPDATE students SET active = true, left_at = NULL, left_year = NULL, left_reason = NULL WHERE public_id = $1', [PUBLIC_ID]);

    const missing = await call('PATCH', '/api/students/RS-nothing-here', { name: 'X' });
    check('an unknown id is 404, not a silent insert', () => assert.equal(missing.status, 404));

    // ── therapists ────────────────────────────────────────────────────────
    console.log('\ntherapists');

    const tAdd = await call('POST', '/api/therapists', { name: THERAPIST });
    const tAgain = await call('POST', '/api/therapists', { name: THERAPIST });
    check('added once, idempotent after', () => {
        assert.equal(tAdd.status, 201);
        assert.equal(tAgain.body.created, false);
    });

    // Give them a term, so the rename has something to carry.
    const slot = await call('PUT', '/api/schedule/slot',
        { day: 'Понеделник', time: '08:00', therapist: THERAPIST, student: RENAMED });
    check('a cell for the student just added now lands (Stage A used to 404 here)', () => {
        assert.equal(slot.status, 200);
        assert.equal(slot.body.student, RENAMED);
    });

    const tRename = await call('PATCH', `/api/therapists/${encodeURIComponent(THERAPIST)}`, { name: T_RENAMED });
    const carried = await pool.query(
        `SELECT count(*)::int n FROM schedule_slots sl
           JOIN therapists t ON t.id = sl.therapist_id WHERE t.name = $1`, [T_RENAMED]);
    check('renaming a therapist carries their week with them', () => {
        assert.equal(tRename.status, 200);
        assert.equal(carried.rows[0].n, 1, 'the term was orphaned by the rename');
    });

    await call('POST', '/api/therapists', { name: THERAPIST });          // a second, real person
    const merge = await call('PATCH', `/api/therapists/${encodeURIComponent(T_RENAMED)}`, { name: THERAPIST });
    check('a rename onto an existing therapist is refused, not merged', () => {
        assert.equal(merge.status, 409);
    });

    // ── caseload links ────────────────────────────────────────────────────
    console.log('\ncaseload links');

    const link = await call('PUT', `/api/therapists/${encodeURIComponent(T_RENAMED)}/students/${encodeURIComponent(PUBLIC_ID)}`);
    const linked = await pool.query(
        `SELECT 1 FROM therapist_students ts JOIN therapists t ON t.id = ts.therapist_id
           JOIN students s ON s.id = ts.student_id WHERE t.name = $1 AND s.public_id = $2`, [T_RENAMED, PUBLIC_ID]);
    check('a ticked box links one therapist to one student', () => {
        assert.equal(link.status, 200);
        assert.equal(linked.rowCount, 1);
    });

    const unlink = await call('DELETE', `/api/therapists/${encodeURIComponent(T_RENAMED)}/students/${encodeURIComponent(PUBLIC_ID)}`);
    const gone = await pool.query(
        `SELECT 1 FROM therapist_students ts JOIN therapists t ON t.id = ts.therapist_id
           JOIN students s ON s.id = ts.student_id WHERE t.name = $1 AND s.public_id = $2`, [T_RENAMED, PUBLIC_ID]);
    check('unticking it removes the link — that IS Rasporedi\'s decision', () => {
        assert.equal(unlink.status, 200);
        assert.equal(gone.rowCount, 0);
    });

    const studentRow = await pool.query('SELECT active FROM students WHERE public_id = $1', [PUBLIC_ID]);
    check('and the child is still enrolled — a link is not a person',
        () => assert.equal(studentRow.rows[0]?.active, true));

    // ── the document may no longer restate what it does not own ───────────
    console.log('\nthe blob under per-cell writes');

    // A stale browser saving the whole document: the roster it carries is the
    // one it held when its tab was opened, with no `expected` to check against.
    //
    // The payload has to carry the WHOLE roster, or the near-empty-roster
    // safeguard skips projection and this test would pass without exercising
    // anything. (It did, the first time it was written.)
    const everyone = await pool.query('SELECT public_id, name, grade FROM students WHERE active');
    const staleNames: string[] = [];
    const staleMeta: Record<string, any> = {};
    for (const r of everyone.rows) {
        const asHeld = r.public_id === PUBLIC_ID ? RENAMED : r.name;   // our one is out of date
        staleNames.push(asHeld);
        staleMeta[asHeld] = { studentId: r.public_id, grade: r.public_id === PUBLIC_ID ? 'I-а' : (r.grade || '') };
    }
    const staleBlob = {
        rasporedi: {
            students: staleNames,
            studentMeta: staleMeta,
            therapists: [T_RENAMED],
            therapistStudents: { [T_RENAMED]: [RENAMED] },
            schedule: [],
            unifiedMeta: { schemaVersion: 1, revision: 1, slotWrites: true }
        }
    };
    await pool.query('UPDATE students SET name = $2, grade = $3 WHERE public_id = $1',
        [PUBLIC_ID, 'Име Од Друга Машина', 'VIII-а']);

    const current = await call('GET', '/api/state/unified');
    const put = await call('PUT', '/api/state/unified',
        { payload: staleBlob, baseVersion: current.status === 200 ? current.body.version : 0 });
    check('the payload was actually projected, not skipped by a safeguard', () => {
        assert.equal(put.status, 200);
        const problems: string[] = put.body?.projection?.report?.problems || put.body?.projection?.problems || [];
        assert.ok(!problems.some((p) => /projection skipped/i.test(p)),
            `projection was skipped, so this proves nothing: ${JSON.stringify(problems)}`);
    });
    const afterBlob = await pool.query('SELECT name, grade FROM students WHERE public_id = $1', [PUBLIC_ID]);
    check('a stale document cannot undo a rename made through the endpoint', () =>
        assert.equal(afterBlob.rows[0]?.name, 'Име Од Друга Машина',
            `name is now ${JSON.stringify(afterBlob.rows[0])} (PUT returned ${put.status})`));
    check('nor the grade', () => assert.equal(afterBlob.rows[0]?.grade, 'VIII-а'));

    // The caseload is left out of the document ENTIRELY, not merely protected
    // from being cleared by it. Add-only sounds like the safe half and is not:
    // a box unticked in Podatoci would be put straight back by the next save
    // from a tab that still remembers it, and nobody would be told.
    await pool.query(
        `DELETE FROM therapist_students WHERE therapist_id IN (SELECT id FROM therapists WHERE name = $1)`,
        [T_RENAMED]);
    const cur1b = await call('GET', '/api/state/unified');
    await call('PUT', '/api/state/unified', { payload: staleBlob, baseVersion: cur1b.body.version });
    const links = await pool.query(
        `SELECT count(*)::int n FROM therapist_students ts JOIN therapists t ON t.id = ts.therapist_id
          WHERE t.name = $1`, [T_RENAMED]);
    check('an unticked link is not put back by a document that still lists it',
        () => assert.equal(links.rows[0].n, 0));

    // The control, moved rather than dropped. It used to be the MARKER that
    // decided whether a document owned the roster — so the suite proved the
    // marker was what made the difference. Since `Podatoci.html` exists, every
    // save through the API is protected whether the app announces anything or
    // not, and the real distinction is between a save and a FILE import. The
    // save half is asserted here; the file half is
    // `projection.test.ts` → "a save from an app may add a person, and may not
    // restate one", which ends by importing the same document as a file and
    // watching everything come back.
    (staleBlob.rasporedi.unifiedMeta as any).slotWrites = false;
    const cur2 = await call('GET', '/api/state/unified');
    await call('PUT', '/api/state/unified', { payload: staleBlob, baseVersion: cur2.body.version });
    const afterPlain = await pool.query('SELECT name FROM students WHERE public_id = $1', [PUBLIC_ID]);
    check('a save is protected even without the marker, because the screen owns the roster now',
        () => assert.equal(afterPlain.rows[0]?.name, 'Име Од Друга Машина',
            'a document with no marker still restated the name'));

    // ── what must not exist ───────────────────────────────────────────────
    console.log('\nabsences');

    const del = await fetch(`${BASE}/api/students/${encodeURIComponent(PUBLIC_ID)}`, { method: 'DELETE' });
    check('there is no way to delete a student through this API', () => {
        assert.equal(del.status, 404, 'a DELETE route exists — Rasporedi could retire children');
    });
    const delT = await fetch(`${BASE}/api/therapists/${encodeURIComponent(THERAPIST)}`, { method: 'DELETE' });
    check('nor a therapist', () => assert.equal(delT.status, 404));

    await cleanup();
    await pool.end();

    console.log(failures ? `\n${failures} FAILED\n` : '\nall assertions held\n');
    process.exit(failures ? 1 : 0);
}

main().catch(async (err) => { console.error(err); await pool.end(); process.exit(1); });

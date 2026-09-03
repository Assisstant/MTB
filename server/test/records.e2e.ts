/**
 * Stage F, against a real server and a real database.
 *
 *     npm run start                # in one terminal
 *     npx tsx test/records.e2e.ts
 *
 * What it is here to prove, in order of how much it would cost to get wrong:
 *
 *   1. THE TWO PATHS AGREE. A record written through its endpoint and the same
 *      record projected from a whole document must produce an identical row.
 *      That is the risk the refactor was for, and asserting it is the only
 *      thing that makes the refactor worth anything.
 *   2. An audiogram gets the same id from the server and from the app's own
 *      copy of the calculation. If those two ever part company, every machine
 *      grows its own duplicate set.
 *   3. Audiograms are reconciled, not replaced: a record the document no longer
 *      carries goes, one it never mentioned in an empty list stays.
 *   4. Deleting a scale does not delete the assessments made with it.
 *   5. An audiogram naming someone off the roster is kept with the name and no
 *      link, never turned into a student.
 *   6. With the marker a whole-document save stops deciding the records;
 *      without it, it still decides them — the control.
 */

import { readFileSync } from 'node:fs';
import { pool } from '../src/db.js';
import { audiogramId } from '../src/lib/records.js';

const BASE = process.env.API || 'http://127.0.0.1:3000';

const FIXTURE = JSON.parse(
    readFileSync(new URL('../../sample-data/anonymized/diary-sample.json', import.meta.url), 'utf8')
);
const SDN_IDS = [9001, 9002, 9003];
const PLAN_SDN_ID = 7001;
const APP_KEY = 'sdnevnik-test';

let failures = 0;
function check(label: string, cond: boolean, detail = '') {
    if (cond) console.log(`  ok   ${label}`);
    else { failures++; console.log(`  FAIL ${label}${detail ? '\n       ' + detail : ''}`); }
}
function checkEq(label: string, actual: unknown, expected: unknown) {
    const same = JSON.stringify(actual) === JSON.stringify(expected);
    check(label, same, same ? '' : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function call(method: string, path: string, body?: any) {
    const res = await fetch(BASE + path, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined
    });
    let json: any = null;
    try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: json };
}

const one = async (sql: string, params: any[] = []) => (await pool.query(sql, params)).rows[0] ?? null;
const count = async (sql: string, params: any[] = []) => Number((await one(sql, params))?.n ?? 0);

async function cleanup() {
    for (const t of ['assessments', 'triage_tests', 'student_records', 'attendance', 'student_plan_progress', 'diary_schedule', 'student_enrollments']) {
        await pool.query(`DELETE FROM ${t} WHERE student_id IN (SELECT id FROM students WHERE sdnevnik_id = ANY($1::bigint[]))`, [SDN_IDS]);
    }
    await pool.query('DELETE FROM audiograms');
    await pool.query(`DELETE FROM scale_templates WHERE sdnevnik_id LIKE 'proba%'`);
    await pool.query('DELETE FROM students WHERE sdnevnik_id = ANY($1::bigint[])', [SDN_IDS]);
    await pool.query(`DELETE FROM plan_activities WHERE plan_id IN (SELECT id FROM plans WHERE sdnevnik_id = $1)`, [PLAN_SDN_ID]);
    await pool.query('DELETE FROM plans WHERE sdnevnik_id = $1', [PLAN_SDN_ID]);
    await pool.query('DELETE FROM app_state WHERE app = $1', [APP_KEY]);
}

async function seedRoster() {
    const yid = (await one('SELECT id FROM school_years WHERE is_current')).id;
    for (const s of FIXTURE.students) {
        const r = await one(
            `INSERT INTO students (public_id, sdnevnik_id, name, grade) VALUES ($1,$2,$3,$4)
             ON CONFLICT (public_id) DO UPDATE SET sdnevnik_id = EXCLUDED.sdnevnik_id RETURNING id`,
            [s.rasporediStudentId, s.id, s.name, s.grade]);
        await pool.query(
            `INSERT INTO student_enrollments (student_id, school_year_id, grade) VALUES ($1,$2,$3)
             ON CONFLICT DO NOTHING`, [r.id, yid, s.grade]);
    }
}

async function saveBlob(rowWrites: string[] | null) {
    const probe = await call('GET', `/api/state/${APP_KEY}`);
    const version = probe.status === 200 ? probe.body.version : 0;
    const payload = JSON.parse(JSON.stringify(FIXTURE));
    if (rowWrites) payload._meta.rowWrites = rowWrites;
    else delete payload._meta.rowWrites;
    return call('PUT', `/api/state/${APP_KEY}`, { baseVersion: version, payload, updated_by: 'records.e2e' });
}

/** Everything about one assessment row, for comparing two write paths. */
async function assessmentRow(id: number) {
    return one(
        `SELECT a.sdnevnik_id::text AS id, s.sdnevnik_id::text AS student, t.sdnevnik_id AS scale,
                a.date, a.period, a.scores, a.average::text AS average, a.comment
         FROM assessments a JOIN students s ON s.id = a.student_id
         LEFT JOIN scale_templates t ON t.id = a.template_id
         WHERE a.sdnevnik_id = $1`, [id]);
}
async function dossierRow(sdn: number) {
    return one(
        `SELECT r.first_name, r.last_name, r.birth_date, r.father_name, r.mother_name,
                r.address, r.residence, r.contact, r.findings, r.opinion, r.attachment_links
         FROM student_records r JOIN students s ON s.id = r.student_id WHERE s.sdnevnik_id = $1`, [sdn]);
}

async function main() {
    console.log(`Stage F against ${BASE}\n`);
    await cleanup();
    await seedRoster();

    // ── 1. The document still writes the records when nothing has moved ──────
    console.log('the blob still projects the records when nothing has moved');
    const first = await saveBlob(null);
    checkEq('the save is accepted', first.status, 200);
    checkEq('the dossier landed', (await dossierRow(9001))?.first_name, 'Проба');
    check('trailing whitespace in the findings is kept as typed',
        (await dossierRow(9001))?.findings === 'Наод за проба.\n\n',
        JSON.stringify((await dossierRow(9001))?.findings));
    checkEq('both assessments landed', await count('SELECT count(*)::int AS n FROM assessments'), 2);
    checkEq('and are linked to the scale', (await assessmentRow(8001))?.scale, 'proba_v1');
    checkEq('the triage test landed', await count('SELECT count(*)::int AS n FROM triage_tests'), 1);
    checkEq('both audiograms landed', await count('SELECT count(*)::int AS n FROM audiograms'), 2);
    checkEq('and every one has an id now',
        await count('SELECT count(*)::int AS n FROM audiograms WHERE sdnevnik_id IS NULL'), 0);

    // ── 2. Nobody was invented ───────────────────────────────────────────────
    console.log('\nan audiogram naming someone off the roster');
    const stranger = await one(`SELECT student_id, subject_name FROM audiograms WHERE subject_name = 'Некој Одамна'`);
    check('is kept, with the name', stranger != null, JSON.stringify(stranger));
    checkEq('and no student link', stranger?.student_id, null);
    checkEq('and no student was created for them',
        await count(`SELECT count(*)::int AS n FROM students WHERE name = 'Некој Одамна'`), 0);

    // ── 3. THE TWO PATHS AGREE ───────────────────────────────────────────────
    //
    // The point of moving the row-writing into lib/records.ts. Take a record
    // the document just wrote, write the SAME record through its endpoint, and
    // require the row to be untouched.
    console.log('\nthe two write paths produce the same row');
    const beforeAssessment = await assessmentRow(8001);
    const beforeDossier = await dossierRow(9001);

    const a = FIXTURE.assessments.find((x: any) => x.id === 8001);
    const viaEndpoint = await call('PUT', '/api/diary/record/assessment', {
        id: a.id, sdnevnikId: a.studentId, assessment: a
    });
    checkEq('the endpoint accepts it', viaEndpoint.status, 200);
    checkEq('and the row is byte for byte what the document wrote',
        await assessmentRow(8001), beforeAssessment);

    const d = FIXTURE.student_records[0];
    const dossierVia = await call('PUT', '/api/diary/record/dossier', { sdnevnikId: d.id, record: d });
    checkEq('same for the dossier', dossierVia.status, 200);
    checkEq('and its row is unchanged too', await dossierRow(9001), beforeDossier);

    const ag = FIXTURE.audiograms[0];
    const agBefore = await one('SELECT * FROM audiograms WHERE sdnevnik_id = $1', [audiogramId(ag)]);
    const agVia = await call('PUT', '/api/diary/record/audiogram', { audiogram: ag });
    checkEq('same for an audiogram', agVia.status, 200);
    checkEq('the endpoint derived the id the projection had already used', agVia.body?.id, audiogramId(ag));
    checkEq('and the row is unchanged', await one('SELECT * FROM audiograms WHERE sdnevnik_id = $1', [audiogramId(ag)]), agBefore);
    checkEq('writing it twice does not make a second one',
        await count('SELECT count(*)::int AS n FROM audiograms'), 2);

    // ── 4. The id is a pure function of the content ──────────────────────────
    console.log('\nthe audiogram id follows the content');
    const shifted = { ...ag, rightAir: { ...ag.rightAir, '250': 25 } };
    check('a changed curve is a different record', audiogramId(shifted) !== audiogramId(ag));
    const reordered = { ...ag, rightAir: { '1000': 30, '250': 20, '500': 25 } };
    checkEq('a reordered curve is the SAME record', audiogramId(reordered), audiogramId(ag));
    const asked = await call('POST', '/api/diary/record/audiogram/id', { audiogram: reordered });
    checkEq('and the server says so too', asked.body?.id, audiogramId(ag));

    // ── 5. Reconciled, not replaced ──────────────────────────────────────────
    console.log('\naudiograms are reconciled now, not deleted and re-added');
    const extra = {
        subjectName: 'Проба Втора', date: '2026-06-01', recordType: 'history',
        rightAir: { '250': 10 }, rightBone: {}, leftAir: {}, leftBone: {}
    };
    await call('PUT', '/api/diary/record/audiogram', { audiogram: extra });
    checkEq('a third one, written per record', await count('SELECT count(*)::int AS n FROM audiograms'), 3);

    await saveBlob(['attendance', 'schedule', 'records']);
    checkEq('with the marker, the document leaves it alone',
        await count('SELECT count(*)::int AS n FROM audiograms'), 3);

    console.log('\nTHE CONTROL — without the marker the document decides again');
    await saveBlob(null);
    checkEq('the one it does not carry is gone', await count('SELECT count(*)::int AS n FROM audiograms'), 2);
    checkEq('and the two it carries are still there, with their ids',
        await count('SELECT count(*)::int AS n FROM audiograms WHERE sdnevnik_id IS NOT NULL'), 2);

    // ── 6. Deleting a scale keeps the scores ─────────────────────────────────
    console.log('\ndeleting a scale does not delete the work done with it');
    const del = await call('DELETE', '/api/diary/record/scale/proba_v1');
    checkEq('the scale is removed', del.body?.removed, true);
    checkEq('and it says how many assessments it cut loose', del.body?.assessmentsUnlinked, 2);
    checkEq('the assessments are still there', await count('SELECT count(*)::int AS n FROM assessments'), 2);
    checkEq('with their scores intact', (await assessmentRow(8001))?.scores, { i1: 3, i2: 2 });
    checkEq('just no longer pointing at a scale', (await assessmentRow(8001))?.scale, null);

    // ── 7. Deleting the records the therapist meant to delete ────────────────
    console.log('\nrecords the therapist deletes are deleted');
    const delA = await call('DELETE', '/api/diary/record/assessment/8002');
    checkEq('an assessment goes', delA.body?.removed, true);
    checkEq('one left', await count('SELECT count(*)::int AS n FROM assessments'), 1);
    const delT = await call('DELETE', '/api/diary/record/triage/8101');
    checkEq('a triage test goes', delT.body?.removed, true);
    const delAg = await call('DELETE', `/api/diary/record/audiogram/${audiogramId(ag)}`);
    checkEq('an audiogram goes', delAg.body?.removed, true);
    checkEq('deleting one that is not there is not an error', (await call('DELETE', '/api/diary/record/assessment/999')).status, 200);

    // ── 8. An unlinked student is refused loudly ─────────────────────────────
    console.log('\na record for a student the database has never heard of');
    const orphan = await call('PUT', '/api/diary/record/dossier', { sdnevnikId: 999777, record: { id: 999777 } });
    checkEq('is 404', orphan.status, 404);
    check('and names the cure', /save the diary once/.test(String(orphan.body?.error)), String(orphan.body?.error));

    // ── 9. The read endpoint speaks the diary's own shapes ───────────────────
    console.log('\nthe read endpoint returns what the app already holds');
    await saveBlob(null);                       // put everything back
    const read = await call('GET', '/api/diary/records');
    checkEq('answers 200', read.status, 200);
    checkEq('the dossier is keyed by the diary\'s student id', read.body?.student_records?.[0]?.id, 9001);
    checkEq('an assessment carries studentId and scaleType, as the payload does',
        [read.body?.assessments?.[0]?.studentId, read.body?.assessments?.[0]?.scaleType], [9001, 'proba_v1']);
    check('an audiogram carries its derived id so the app can match it',
        typeof read.body?.audiograms?.[0]?._id === 'string' && read.body.audiograms[0]._id.startsWith('AG-'),
        JSON.stringify(read.body?.audiograms?.[0]?._id));

    await cleanup();
    await pool.end();
    console.log(failures ? `\n${failures} failed` : '\nall good');
    process.exit(failures ? 1 : 0);
}

main().catch(async (err) => {
    console.error(err);
    await pool.end().catch(() => {});
    process.exit(1);
});

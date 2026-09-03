/**
 * Stage D, against a real server and a real database.
 *
 * Not in `npm test` because it needs both running. Run it deliberately:
 *
 *     npm run start                # in one terminal
 *     npx tsx test/diary-write.e2e.ts
 *
 * What it is here to prove, in order of how much it would cost to get wrong:
 *
 *   1. A merged term is ONE session. Two slot keys share one time string, and
 *      progress counts sessions. Counting marks instead would credit an extra
 *      activity per merged term, for ever, and the number would look fine.
 *   2. Two machines marking two different days both survive. That is the whole
 *      reason for the stage: as one document, the second save wins the year.
 *   3. Nothing writes progress directly, and progress still ends up right.
 *   4. A mark for a student the database has not linked is refused loudly, not
 *      dropped quietly — Stage A's hole, in its S-Dnevnik shape.
 *   5. With the marker, a whole-document save stops deciding attendance.
 *      WITHOUT it, it still decides everything — the control, without which
 *      the guard proves nothing (CLAUDE.md rule 4).
 *   6. Progress is never cleared because the times are missing. That refusal
 *      is the difference between "no sessions" and "I cannot see the sessions".
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pool } from '../src/db.js';

const BASE = process.env.API || 'http://127.0.0.1:3000';

// Invented names only — this repository is public (CLAUDE.md rule 1).
const FIXTURE = JSON.parse(
    readFileSync(new URL('../../sample-data/anonymized/diary-sample.json', import.meta.url), 'utf8')
);
const SDN_IDS = [9001, 9002, 9003];
const PLAN_SDN_ID = 7001;
const APP_KEY = 'sdnevnik-test';        // never the real 'sdnevnik' blob

let failures = 0;
function check(label: string, cond: boolean, detail = '') {
    if (cond) console.log(`  ok   ${label}`);
    else { failures++; console.log(`  FAIL ${label}${detail ? '\n       ' + detail : ''}`); }
}
function checkEq(label: string, actual: unknown, expected: unknown) {
    let same = true;
    try { assert.deepEqual(actual, expected); } catch { same = false; }
    check(label, same, same ? '' : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
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

async function dbId(sdnevnikId: number): Promise<number> {
    const { rows } = await pool.query('SELECT id FROM students WHERE sdnevnik_id = $1', [sdnevnikId]);
    return rows[0].id;
}

/** Which activity positions this student is credited with, in order. */
async function credited(sdnevnikId: number): Promise<number[]> {
    const { rows } = await pool.query(
        `SELECT pa.position FROM student_plan_progress spp
         JOIN plan_activities pa ON pa.id = spp.activity_id
         JOIN students s ON s.id = spp.student_id
         WHERE s.sdnevnik_id = $1 ORDER BY pa.position`,
        [sdnevnikId]
    );
    return rows.map((r: any) => r.position);
}

async function marksOf(sdnevnikId: number) {
    const { rows } = await pool.query(
        `SELECT a.date, a.slot_key, a.status, a.time_slot FROM attendance a
         JOIN students s ON s.id = a.student_id
         WHERE s.sdnevnik_id = $1 ORDER BY a.date, a.slot_key`,
        [sdnevnikId]
    );
    return rows;
}

async function statusOf(sdnevnikId: number, date: string, slotKey: string): Promise<string | null> {
    const { rows } = await pool.query(
        `SELECT a.status FROM attendance a JOIN students s ON s.id = a.student_id
         WHERE s.sdnevnik_id = $1 AND a.date = $2 AND a.slot_key = $3`,
        [sdnevnikId, date, slotKey]
    );
    return rows.length ? rows[0].status : null;
}

async function cleanup() {
    await pool.query(
        `DELETE FROM attendance WHERE student_id IN (SELECT id FROM students WHERE sdnevnik_id = ANY($1::bigint[]))`, [SDN_IDS]);
    await pool.query(
        `DELETE FROM student_plan_progress WHERE student_id IN (SELECT id FROM students WHERE sdnevnik_id = ANY($1::bigint[]))`, [SDN_IDS]);
    await pool.query(
        `DELETE FROM student_enrollments WHERE student_id IN (SELECT id FROM students WHERE sdnevnik_id = ANY($1::bigint[]))`, [SDN_IDS]);
    await pool.query('DELETE FROM students WHERE sdnevnik_id = ANY($1::bigint[])', [SDN_IDS]);
    await pool.query(
        `DELETE FROM plan_activities WHERE plan_id IN (SELECT id FROM plans WHERE sdnevnik_id = $1)`, [PLAN_SDN_ID]);
    await pool.query('DELETE FROM plans WHERE sdnevnik_id = $1', [PLAN_SDN_ID]);
    await pool.query('DELETE FROM app_state WHERE app = $1', [APP_KEY]);
}

/**
 * The roster, seeded directly.
 *
 * The diary does not create students — it says so itself ("save Rasporedi once
 * so the roster is projected first"), and reconciliation has its own twenty
 * tests. Doing it here in SQL keeps this file about attendance.
 */
async function seedRoster() {
    const yid = (await pool.query('SELECT id FROM school_years WHERE is_current')).rows[0].id;
    for (const s of FIXTURE.students) {
        const { rows } = await pool.query(
            `INSERT INTO students (public_id, sdnevnik_id, name, grade)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (public_id) DO UPDATE SET sdnevnik_id = EXCLUDED.sdnevnik_id
             RETURNING id`,
            [s.rasporediStudentId, s.id, s.name, s.grade]
        );
        await pool.query(
            `INSERT INTO student_enrollments (student_id, school_year_id, grade)
             VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
            [rows[0].id, yid, s.grade]
        );
    }
}

/** Save the diary the ordinary way, optionally announcing Stage D. */
async function saveBlob(rowWrites: string[] | null) {
    const probe = await call('GET', `/api/state/${APP_KEY}`);
    const version = probe.status === 200 ? probe.body.version : 0;
    const payload = JSON.parse(JSON.stringify(FIXTURE));
    if (rowWrites) payload._meta.rowWrites = rowWrites;
    else delete payload._meta.rowWrites;
    return call('PUT', `/api/state/${APP_KEY}`, { baseVersion: version, payload, updated_by: 'diary-write.e2e' });
}

async function main() {
    console.log(`Stage D against ${BASE}\n`);
    await cleanup();
    await seedRoster();

    // ── 1. The whole-document save, as it works today ────────────────────────
    console.log('the blob still projects everything when nothing has moved');
    const first = await saveBlob(null);
    check('the save is accepted', first.status === 200, JSON.stringify(first.body));
    check('the projection ran', first.body?.projection?.ok === true, JSON.stringify(first.body?.projection));

    const seeded = await marksOf(9001);
    checkEq('all four of this student\'s marks landed', seeded.length, 4);
    const merged = seeded.filter((r: any) => r.date === '2026-05-12');
    check('the merged term stored one time against BOTH slot keys',
        merged.length === 2 && merged[0].time_slot === merged[1].time_slot && String(merged[0].time_slot).includes('+'),
        JSON.stringify(merged));

    // ── 2. Derivation: sessions, not marks ───────────────────────────────────
    console.log('\nprogress counts sessions, and a merged term is one session');
    const rebuilt = await call('POST', '/api/diary/progress/rebuild', { sdnevnikId: 9001 });
    check('rebuild answers', rebuilt.status === 200, JSON.stringify(rebuilt.body));
    checkEq('THREE present marks over two days credit TWO activities', await credited(9001), [0, 1]);
    checkEq('the absence on Wednesday credited nothing', (await marksOf(9001)).filter((r: any) => r.status === 'absent').length, 1);
    checkEq('a student with no plan is left alone, not errored over', await credited(9003), []);

    // ── 3. One mark at a time ────────────────────────────────────────────────
    console.log('\none mark at a time');
    const thu = await call('PUT', '/api/diary/attendance', {
        sdnevnikId: 9001, date: '2026-05-14', slotKey: 'thursday-0',
        status: 'present', time: '08:00-08:40'
    });
    check('the mark is accepted', thu.status === 200, JSON.stringify(thu.body));
    checkEq('progress moved with it, in the same answer', thu.body?.progress?.completed, 3);
    checkEq('and the database agrees', await credited(9001), [0, 1, 2]);

    // The third click: present → absent → not addressed.
    const cleared = await call('PUT', '/api/diary/attendance', {
        sdnevnikId: 9001, date: '2026-05-14', slotKey: 'thursday-0', status: null
    });
    check('clearing a mark is accepted', cleared.status === 200, JSON.stringify(cleared.body));
    checkEq('the mark is gone', await statusOf(9001, '2026-05-14', 'thursday-0'), null);
    checkEq('and the activity it credited goes with it', await credited(9001), [0, 1]);

    // ── 4. Two machines, two days ────────────────────────────────────────────
    console.log('\ntwo machines marking different days — the point of the stage');
    await call('PUT', '/api/diary/attendance', {
        sdnevnikId: 9002, date: '2026-05-18', slotKey: 'monday-1', status: 'present', time: '08:45-09:25'
    });
    await call('PUT', '/api/diary/attendance', {
        sdnevnikId: 9002, date: '2026-05-19', slotKey: 'tuesday-1', status: 'present', time: '08:45-09:25'
    });
    const days = (await marksOf(9002)).map((r: any) => r.date);
    check('the mark made at school survives', days.includes('2026-05-18'), JSON.stringify(days));
    check('and so does the one made at home', days.includes('2026-05-19'), JSON.stringify(days));
    checkEq('three sessions, so three activities', await credited(9002), [0, 1, 2]);

    // ── 5. Same mark, edited in two places ───────────────────────────────────
    console.log('\nthe same mark edited in two places is reported, not overwritten');
    const stale = await call('PUT', '/api/diary/attendance', {
        sdnevnikId: 9002, date: '2026-05-18', slotKey: 'monday-1',
        status: 'absent', time: '08:45-09:25', expected: null
    });
    checkEq('a stale `expected` is refused with 409', stale.status, 409);
    checkEq('and the answer says what is actually there', stale.body?.actual, 'present');
    checkEq('the stored mark was not touched', await statusOf(9002, '2026-05-18', 'monday-1'), 'present');

    const honest = await call('PUT', '/api/diary/attendance', {
        sdnevnikId: 9002, date: '2026-05-18', slotKey: 'monday-1',
        status: 'absent', time: '08:45-09:25', expected: 'present'
    });
    checkEq('a correct `expected` goes through', honest.status, 200);
    checkEq('and the change landed', await statusOf(9002, '2026-05-18', 'monday-1'), 'absent');

    // ── 6. An unlinked student is refused loudly ─────────────────────────────
    console.log('\na mark for a student the database has never heard of');
    const orphan = await call('PUT', '/api/diary/attendance', {
        sdnevnikId: 999777, date: '2026-05-11', slotKey: 'monday-0', status: 'present', time: '08:00-08:40'
    });
    checkEq('is 404, not a silent drop', orphan.status, 404);
    check('and names the cure', /save the diary once/.test(String(orphan.body?.error)), String(orphan.body?.error));

    // ── 7. The marker, and the control it needs ──────────────────────────────
    //
    // The sharp case: a mark the DOCUMENT disagrees with. The fixture says
    // Wednesday is an absence. Correct it per mark, then save the document.
    console.log('\nwith the marker, the document stops deciding attendance');
    await call('PUT', '/api/diary/attendance', {
        sdnevnikId: 9001, date: '2026-05-13', slotKey: 'wednesday-1',
        status: 'present', time: '08:45-09:25', expected: 'absent'
    });
    checkEq('the correction landed', await statusOf(9001, '2026-05-13', 'wednesday-1'), 'present');
    const beforeCount = (await marksOf(9001)).length;

    const marked = await saveBlob(['attendance']);
    checkEq('the save is still accepted', marked.status, 200);
    checkEq('the correction SURVIVED the whole-document save', await statusOf(9001, '2026-05-13', 'wednesday-1'), 'present');
    checkEq('and nothing else moved', (await marksOf(9001)).length, beforeCount);
    check('the projection said what it skipped', /PUT \/api\/diary\/attendance/.test(JSON.stringify(marked.body?.projection ?? {})) || marked.body?.projection?.ok === true);

    console.log('\nTHE CONTROL — without the marker the document still decides everything');
    const control = await saveBlob(null);
    checkEq('the save is accepted', control.status, 200);
    checkEq('the document reasserted itself: Wednesday is an absence again',
        await statusOf(9001, '2026-05-13', 'wednesday-1'), 'absent');
    checkEq('and the document\'s own progress list landed', await credited(9001), [0, 1]);

    // ── 8. Missing times must not clear a year ───────────────────────────────
    console.log('\nprogress is not cleared just because the times are missing');
    await pool.query('UPDATE attendance SET time_slot = NULL WHERE student_id = $1', [await dbId(9001)]);
    const beforeBlind = await credited(9001);
    const blind = await call('POST', '/api/diary/progress/rebuild', { sdnevnikId: 9001 });
    check('the rebuild refuses rather than clearing',
        /carry no time/.test(String(blind.body?.results?.[0]?.refused)), JSON.stringify(blind.body?.results?.[0]));
    checkEq('and the progress is exactly as it was', await credited(9001), beforeBlind);

    // ── 9. The read endpoint speaks the diary's own shape ────────────────────
    console.log('\nthe read endpoint returns what the app already holds');
    const read = await call('GET', '/api/diary/attendance');
    checkEq('answers 200', read.status, 200);
    check('keyed date → student → slot, like attendance[date][sid][key]',
        read.body?.['2026-05-12']?.['9001']?.['tuesday-2']?.status === 'present',
        JSON.stringify(read.body?.['2026-05-12'] ?? null));

    // ── 10. Migration 012's backfill, run against a real blob ────────────────
    //
    // The riskiest SQL in this stage: three lateral joins over jsonb, casts
    // guarded by regexes in a materialized CTE, and no way to notice it did
    // nothing. Run the migration's own text — not a copy of it, which would
    // drift — and check the times come back.
    console.log('\nmigration 012 puts the times back from the blob');
    const migration = readFileSync(new URL('../../database/migrations/012_attendance_time.sql', import.meta.url), 'utf8');
    const backfill = migration.slice(migration.indexOf('WITH marks AS'));
    check('the migration file still contains the backfill', backfill.startsWith('WITH marks AS'));

    // The migration looks for app='sdnevnik'; give it one, then take it away.
    const { rows: kept } = await pool.query(`SELECT payload FROM app_state WHERE app = 'sdnevnik'`);
    const doc = JSON.parse(JSON.stringify(FIXTURE));
    await pool.query(
        `INSERT INTO app_state (app, version, payload) VALUES ('sdnevnik', 999, $1)
         ON CONFLICT (app) DO UPDATE SET payload = EXCLUDED.payload`,
        [JSON.stringify(doc)]
    );
    await pool.query('UPDATE attendance SET time_slot = NULL WHERE student_id = $1', [await dbId(9001)]);
    const before = (await marksOf(9001)).filter((r: any) => r.time_slot).length;
    await pool.query(backfill);
    const after = (await marksOf(9001)).filter((r: any) => r.time_slot).length;
    check('before the backfill no mark had a time', before === 0, `${before} did`);
    check('afterwards the document\'s marks have theirs back', after >= 4, `${after} of them`);
    const mergedBack = (await marksOf(9001)).filter((r: any) => r.date === '2026-05-12');
    check('including the merged pair, both with the same label',
        mergedBack.length === 2 && mergedBack[0].time_slot === mergedBack[1].time_slot && String(mergedBack[0].time_slot).includes('+'),
        JSON.stringify(mergedBack));

    if (kept.length) {
        await pool.query(`UPDATE app_state SET payload = $1 WHERE app = 'sdnevnik'`, [JSON.stringify(kept[0].payload)]);
    } else {
        await pool.query(`DELETE FROM app_state WHERE app = 'sdnevnik'`);
    }

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

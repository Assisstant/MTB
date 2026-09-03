/**
 * Stage E, against a real server and a real database.
 *
 *     npm run start                # in one terminal
 *     npx tsx test/diary-schedule.e2e.ts
 *
 * What it is here to prove, in order of how much it would cost to get wrong:
 *
 *   1. The September transition. Rolling the database over first works; doing
 *      it the other way round is REFUSED with the command to run, rather than
 *      deleting the week of the year that is still going.
 *   2. Two students sharing a term keep their order. That is what `ordinal`
 *      exists for, and losing it is a silent change to the file.
 *   3. A slot naming an unlinked student is refused whole, not half applied.
 *   4. With the marker a whole-document save stops deciding the week; without
 *      it, it still replaces the week wholesale — the control.
 *   5. A week snapshot is written once and never restated.
 */

import { readFileSync } from 'node:fs';
import { pool } from '../src/db.js';

const BASE = process.env.API || 'http://127.0.0.1:3000';

const FIXTURE = JSON.parse(
    readFileSync(new URL('../../sample-data/anonymized/diary-sample.json', import.meta.url), 'utf8')
);
const SDN_IDS = [9001, 9002, 9003];
const PLAN_SDN_ID = 7001;
const APP_KEY = 'sdnevnik-test';
const NEXT_YEAR = '2026/2027-test';

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
    try { json = await res.json(); } catch { /* empty body */ }
    return { status: res.status, body: json };
}

/** The slot as the database holds it, in order. */
async function slotOf(day: string, position: number): Promise<string[]> {
    const { rows } = await pool.query(
        `SELECT s.sdnevnik_id::text AS id FROM diary_schedule d
           JOIN students s ON s.id = d.student_id
           JOIN school_years y ON y.id = d.school_year_id AND y.is_current
          WHERE d.day = $1 AND d.position = $2 ORDER BY d.ordinal`,
        [day, position]
    );
    return rows.map((r: any) => r.id);
}

async function weekSize(): Promise<number> {
    const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM diary_schedule d
           JOIN school_years y ON y.id = d.school_year_id AND y.is_current`);
    return rows[0].n;
}

async function currentYearLabel(): Promise<string> {
    const { rows } = await pool.query('SELECT label FROM school_years WHERE is_current');
    return rows[0]?.label ?? '';
}

async function cleanup() {
    await pool.query(`DELETE FROM diary_schedule WHERE student_id IN (SELECT id FROM students WHERE sdnevnik_id = ANY($1::bigint[]))`, [SDN_IDS]);
    await pool.query(`DELETE FROM attendance WHERE student_id IN (SELECT id FROM students WHERE sdnevnik_id = ANY($1::bigint[]))`, [SDN_IDS]);
    await pool.query(`DELETE FROM student_plan_progress WHERE student_id IN (SELECT id FROM students WHERE sdnevnik_id = ANY($1::bigint[]))`, [SDN_IDS]);
    await pool.query(`DELETE FROM student_enrollments WHERE student_id IN (SELECT id FROM students WHERE sdnevnik_id = ANY($1::bigint[]))`, [SDN_IDS]);
    await pool.query('DELETE FROM students WHERE sdnevnik_id = ANY($1::bigint[])', [SDN_IDS]);
    await pool.query(`DELETE FROM plan_activities WHERE plan_id IN (SELECT id FROM plans WHERE sdnevnik_id = $1)`, [PLAN_SDN_ID]);
    await pool.query('DELETE FROM plans WHERE sdnevnik_id = $1', [PLAN_SDN_ID]);
    await pool.query('DELETE FROM app_state WHERE app = $1', [APP_KEY]);
    // A snapshot is written once and never restated — which is the behaviour
    // section 6 asserts, and the reason this row has to go with the rest of the
    // fixture. Without it the suite passes once and fails ever after, because
    // "created: true" can only be true the first time.
    await pool.query('DELETE FROM diary_schedule_history WHERE week_of = $1', ['2026-05-11']);
    // The rehearsal year, and whatever it dragged with it.
    await pool.query('DELETE FROM diary_schedule WHERE school_year_id IN (SELECT id FROM school_years WHERE label = $1)', [NEXT_YEAR]);
    await pool.query('UPDATE school_years SET is_current = false WHERE label = $1', [NEXT_YEAR]);
    await pool.query('DELETE FROM school_years WHERE label = $1', [NEXT_YEAR]);
}

async function seedRoster() {
    const yid = (await pool.query('SELECT id FROM school_years WHERE is_current')).rows[0].id;
    for (const s of FIXTURE.students) {
        const { rows } = await pool.query(
            `INSERT INTO students (public_id, sdnevnik_id, name, grade) VALUES ($1,$2,$3,$4)
             ON CONFLICT (public_id) DO UPDATE SET sdnevnik_id = EXCLUDED.sdnevnik_id RETURNING id`,
            [s.rasporediStudentId, s.id, s.name, s.grade]);
        await pool.query(
            `INSERT INTO student_enrollments (student_id, school_year_id, grade) VALUES ($1,$2,$3)
             ON CONFLICT DO NOTHING`, [rows[0].id, yid, s.grade]);
    }
}

async function saveBlob(rowWrites: string[] | null) {
    const probe = await call('GET', `/api/state/${APP_KEY}`);
    const version = probe.status === 200 ? probe.body.version : 0;
    const payload = JSON.parse(JSON.stringify(FIXTURE));
    if (rowWrites) payload._meta.rowWrites = rowWrites;
    else delete payload._meta.rowWrites;
    return call('PUT', `/api/state/${APP_KEY}`, { baseVersion: version, payload, updated_by: 'diary-schedule.e2e' });
}

async function main() {
    console.log(`Stage E against ${BASE}\n`);
    await cleanup();
    await seedRoster();
    const startingYear = await currentYearLabel();

    // ── 1. The document still lays the week down when nothing has moved ──────
    console.log('the blob still projects the week when nothing has moved');
    const first = await saveBlob(null);
    checkEq('the save is accepted', first.status, 200);
    checkEq('monday slot 0 holds the student the fixture put there', await slotOf('monday', 0), ['9001']);
    checkEq('and an empty slot is empty', await slotOf('monday', 2), []);

    // ── 2. One slot at a time, and the order within it ───────────────────────
    console.log('\none slot at a time, and two students keep their order');
    const two = await call('PUT', '/api/diary/schedule/slot', {
        day: 'monday', position: 2, students: [9002, 9001]
    });
    checkEq('the slot is accepted', two.status, 200);
    checkEq('and comes back in the order it was sent', await slotOf('monday', 2), ['9002', '9001']);

    const flipped = await call('PUT', '/api/diary/schedule/slot', {
        day: 'monday', position: 2, students: [9001, 9002], expected: ['9002', '9001']
    });
    checkEq('reordering with a matching `expected` goes through', flipped.status, 200);
    checkEq('and the new order stands', await slotOf('monday', 2), ['9001', '9002']);

    const stale = await call('PUT', '/api/diary/schedule/slot', {
        day: 'monday', position: 2, students: [9003], expected: ['9002', '9001']
    });
    checkEq('a stale `expected` is refused with 409', stale.status, 409);
    checkEq('and the slot was not touched', await slotOf('monday', 2), ['9001', '9002']);

    const emptied = await call('PUT', '/api/diary/schedule/slot', {
        day: 'monday', position: 2, students: [], expected: ['9001', '9002']
    });
    checkEq('clearing a slot is accepted', emptied.status, 200);
    checkEq('and it is empty', await slotOf('monday', 2), []);

    // ── 3. Refused whole, not half applied ───────────────────────────────────
    console.log('\na slot naming someone the database has never heard of');
    const before = await slotOf('tuesday', 0);
    const orphan = await call('PUT', '/api/diary/schedule/slot', {
        day: 'tuesday', position: 0, students: [9001, 999777]
    });
    checkEq('is 404', orphan.status, 404);
    check('and names the cure', /save the diary once/.test(String(orphan.body?.error)), String(orphan.body?.error));
    checkEq('the slot is untouched — not half applied', await slotOf('tuesday', 0), before);

    // ── 4. The read endpoint speaks the diary's own shape ────────────────────
    console.log('\nthe read endpoint returns what the app already holds');
    await call('PUT', '/api/diary/schedule/slot', { day: 'monday', position: 2, students: [9001, 9002] });
    const read = await call('GET', '/api/diary/schedule');
    checkEq('answers 200', read.status, 200);
    checkEq('{ monday: [[…], …] }, five slots at least', read.body?.monday?.length >= 5, true);
    checkEq('with the shared slot in order', read.body?.monday?.[2], ['9001', '9002']);

    // ── 5. The marker, and its control ───────────────────────────────────────
    console.log('\nwith the marker the document stops deciding the week');
    const marked = await saveBlob(['attendance', 'schedule']);
    checkEq('the save is accepted', marked.status, 200);
    checkEq('the per-slot pairing SURVIVED it', await slotOf('monday', 2), ['9001', '9002']);

    console.log('\nTHE CONTROL — without the marker the document replaces the week');
    const control = await saveBlob(null);
    checkEq('the save is accepted', control.status, 200);
    checkEq('the document put its own week back', await slotOf('monday', 2), []);

    // ── 6. Week snapshots: first write wins ──────────────────────────────────
    console.log('\na week snapshot is written once and never restated');
    const snap = await call('PUT', '/api/diary/schedule/history/2026-05-11', {
        payload: { monday: [[9001], [], [], [], []] }
    });
    checkEq('the first snapshot is created', snap.body?.created, true);
    const again = await call('PUT', '/api/diary/schedule/history/2026-05-11', {
        payload: { monday: [[9002], [], [], [], []] }
    });
    checkEq('a second one for the same week is accepted but changes nothing', again.body?.created, false);
    const hist = await call('GET', '/api/diary/schedule/history');
    checkEq('and the week still reads as it was first recorded',
        hist.body?.['2026-05-11']?.monday?.[0], [9001]);
    const badWeek = await call('PUT', '/api/diary/schedule/history/not-a-date', { payload: {} });
    checkEq('a key that is not a week start is refused', badWeek.status, 400);

    // ── 7. September, both ways round ────────────────────────────────────────
    //
    // The one that matters. The app names the year it is CLOSING; the database
    // must already have moved on, or emptying the week empties the live year.
    console.log('\nSeptember — the wrong way round first');
    const weekBefore = await weekSize();
    check('there is a week to lose', weekBefore > 0, `${weekBefore} rows`);

    const tooEarly = await call('DELETE', '/api/diary/schedule', { closingYear: startingYear });
    checkEq('closing the year the database still calls current is REFUSED', tooEarly.status, 409);
    check('and it says what to run',
        /rollover/.test(String(tooEarly.body?.error)) && tooEarly.body?.rollFirst === true,
        JSON.stringify(tooEarly.body));
    checkEq('the week is exactly as it was', await weekSize(), weekBefore);

    console.log('\nand now the right way round');
    // Stand in for `npm run rollover`: a new year becomes current.
    await pool.query('UPDATE school_years SET is_current = false WHERE is_current');
    await pool.query(
        `INSERT INTO school_years (label, starts_on, ends_on, is_current)
         VALUES ($1, '2026-09-01', '2027-08-31', true)
         ON CONFLICT (label) DO UPDATE SET is_current = true`,
        [NEXT_YEAR]
    );
    checkEq('the database is in the new year', await currentYearLabel(), NEXT_YEAR);

    const proper = await call('DELETE', '/api/diary/schedule', { closingYear: startingYear });
    checkEq('now closing the old year is allowed', proper.status, 200);
    checkEq('the new year starts with an empty week', await weekSize(), 0);

    const oldStill = await pool.query(
        `SELECT count(*)::int AS n FROM diary_schedule d
           JOIN school_years y ON y.id = d.school_year_id
          WHERE y.label = $1`, [startingYear]);
    check('and last year\'s week is still there, filed under last year',
        oldStill.rows[0].n === weekBefore, `${oldStill.rows[0].n} of ${weekBefore}`);

    const noBody = await call('DELETE', '/api/diary/schedule');
    checkEq('a clear with no year named is refused, not a 500', noBody.status, 400);

    // Put the year back the way it was found.
    await pool.query('UPDATE school_years SET is_current = false WHERE is_current');
    await pool.query('UPDATE school_years SET is_current = true WHERE label = $1', [startingYear]);

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

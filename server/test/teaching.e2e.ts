/**
 * The crossing, against a real server and a real database.
 *
 *     npm run start                    # in one terminal
 *     npx tsx test/teaching.e2e.ts
 *
 * What it is here to prove, in order of how much it would cost to get wrong:
 *
 *   1. The off-by-one. A child taken at 08:00 is missing from the SECOND
 *      lesson, not the first, because the school rings at 07:30. Every screen
 *      built on ordinal matching looked correct and named the wrong lesson.
 *   2. A session that cannot be placed is listed as unplaced, with a reason —
 *      never quietly attached to the nearest class.
 *   3. VI and VI-а stay apart. Folding them would put a child in a room they
 *      were never in (rule 2).
 *   4. A subject typed in by hand survives a re-import of the workbook.
 *
 * The projection guard that keeps an experimental fork out of the shared
 * tables has its own suite: test/state-projection.e2e.ts.
 *
 * Everything it creates is invented and prefixed, and it removes itself.
 *
 * It also has to SHARE the database with a real school. Two earlier versions
 * of this file were broken by that, in different ways:
 *
 *   - asserting day totals, which met 76 real sessions where it expected 1;
 *   - writing its eight-lesson fixture into the CURRENT year, where the real
 *     451-lesson timetable already sat. `writeTeaching` refuses a timetable
 *     that shrinks by more than half — correctly — so the fixture silently did
 *     not land and every later assertion read the real school instead.
 *
 * Both are gone, because the suite now works in a school year of its OWN:
 * created here, dropped at the end, invisible to the real one. Timetables are
 * per-year since migration 015, so the fixture can no longer collide with the
 * school's, and nothing has to be snapshotted and put back.
 */

import { pool } from '../src/db.js';
import { parseTeachingGrid } from '../src/lib/teaching.js';
import { writeTeaching } from '../src/lib/teaching-write.js';

const BASE = process.env.API || 'http://127.0.0.1:3000';
const DAY = 'вторник';
const TAG = 'e2e-crossing';
/** A year of this suite's own. Dropped at the end; CASCADE takes its rows. */
const YEAR_LABEL = '1900/1901-e2e';

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

/**
 * An invented timetable, same shape as the school's own sheet.
 * Two class teachers, one subject teacher, one day.
 */
const GRID: unknown[][] = [
    ['ИМЕ И ПРЕЗИМЕ', 'ОДД.', DAY, null, null, null, null, null, null],
    [null, null, '07:30', '08:15', '09:10', '09:55', '10:40', '11:25', '12:10'],
    [null, null, 1, 2, 3, 4, 5, 6, 7],
    // IV-а keeps a fifth lesson on purpose: a child taken during a period their
    // class has free is placed but has no cell to appear in, which would make
    // the second-half case below untestable for the wrong reason.
    ['ЕДЕН ПРОБЕН', 'IV а', 'мак.', 'мат.', 'з.о.', 'лик.', 'физ.', '/', '/'],
    ['ДВА ПРОБЕН', 'VI', 'мак.', 'мат.', '/', '/', '/', '/', '/'],
    ['ИМЕ И ПРЕЗИМЕ', 'ОДД.', DAY, null, null, null, null, null, null],
    [null, null, 1, 2, 3, 4, 5, 6, 7],
    ['ТРИ ПРОБЕН', 'ФЗО.', '/', 'VI-а', '/', '/', '/', '/', '/']
];

const STUDENTS = [
    { pid: `${TAG}-s1`, name: 'Прв Пробен',   grade: 'IV-а' },
    { pid: `${TAG}-s2`, name: 'Втор Пробен',  grade: 'IV-а' },
    { pid: `${TAG}-s3`, name: 'Трет Пробен',  grade: 'VI'   },   // NOT VI-а
    { pid: `${TAG}-s4`, name: 'Четврт Пробен', grade: ''    },   // no class at all
    { pid: `${TAG}-s5`, name: 'Петти Пробен', grade: 'IV-а' }    // booked in a SECOND half only
];
const THERAPISTS = [`${TAG}-Терапевт А`, `${TAG}-Терапевт Б`];

/** The suite's year, created on first use. */
async function ownYear(): Promise<{ id: number; label: string }> {
    const { rows } = await pool.query(
        `INSERT INTO school_years (label, starts_on, ends_on, is_current)
         VALUES ($1, '1900-09-01', '1901-08-31', false)
         ON CONFLICT (label) DO UPDATE SET label = EXCLUDED.label
         RETURNING id, label`,
        [YEAR_LABEL]
    );
    return rows[0];
}

async function cleanup() {
    await pool.query(`DELETE FROM schedule_slots WHERE therapist_id IN (SELECT id FROM therapists WHERE name LIKE $1)`, [`${TAG}%`]);
    await pool.query(`DELETE FROM therapist_students WHERE therapist_id IN (SELECT id FROM therapists WHERE name LIKE $1)`, [`${TAG}%`]);
    await pool.query(`DELETE FROM therapists WHERE name LIKE $1`, [`${TAG}%`]);
    await pool.query(`DELETE FROM students WHERE public_id LIKE $1`, [`${TAG}%`]);
    await pool.query(`DELETE FROM app_state WHERE app LIKE $1`, [`${TAG}%`]);
}

/**
 * The year is dropped only at the END, never by `cleanup`.
 * `seed` calls `cleanup` first, and dropping the year there cascaded away the
 * timetable that had just been written into it — after which the suite held a
 * stale year id and every later write hit a foreign key.
 */
async function dropFixtureTeachers() {
    // Teachers are NOT per-year, and `writeTeaching` only ever fills a blank
    // subject — so a subject typed in by one run is still there in the next,
    // and the assertion that the workbook gave ДВА none fails on the second
    // run only. Cleared before the timetable is written, not after.
    //
    // Matched case-insensitively because that is now the identity of a
    // teacher: the workbook shouts, the database keeps one spelling, and this
    // suite deliberately renames one of them mid-run. A list of exact strings
    // would leave whichever spelling it did not guess behind for ever.
    await pool.query(
        `DELETE FROM teachers WHERE lower(btrim(name)) IN ('еден пробен', 'два пробен', 'три пробен')`
    );
}

async function dropOwnYear() {
    await pool.query('DELETE FROM school_years WHERE label = $1', [YEAR_LABEL]);
}

async function seed() {
    await cleanup();
    const year = await ownYear();
    const studentId = new Map<string, number>();
    for (const s of STUDENTS) {
        const { rows } = await pool.query(
            `INSERT INTO students (public_id, name, grade) VALUES ($1, $2, NULLIF($3, '')) RETURNING id`,
            [s.pid, s.name, s.grade]
        );
        studentId.set(s.pid, rows[0].id);
        await pool.query(
            `INSERT INTO student_enrollments (student_id, school_year_id, grade)
             VALUES ($1, $2, NULLIF($3, ''))`,
            [rows[0].id, year.id, s.grade]
        );
    }
    const therapistId = new Map<string, number>();
    for (const t of THERAPISTS) {
        const { rows } = await pool.query(`INSERT INTO therapists (name) VALUES ($1) RETURNING id`, [t]);
        therapistId.set(t, rows[0].id);
        // On this year's working list, which the crossing has required since
        // migration 018 — it joins `therapist_years` and takes only the
        // active ones. Without this the fixture's terms exist in
        // `schedule_slots` and the crossing reports zero sessions, which
        // reads as a broken overlap calculation and is not one. Eight
        // assertions were failing exactly this way, unnoticed, because this
        // suite had no npm script and nobody was running it.
        await pool.query(
            `INSERT INTO therapist_years (school_year_id, therapist_id, active) VALUES ($1, $2, true)`,
            [year.id, rows[0].id]
        );
    }
    // Both therapists work the first cabinet block; one also works the second.
    const book = async (therapist: string, slot: string, pid: string) => {
        await pool.query(
            `INSERT INTO schedule_slots (school_year_id, day, day_order, time_slot, therapist_id, student_id)
             VALUES ($1, $2, 2, $3, $4, $5)`,
            [year.id, DAY, slot, therapistId.get(therapist), studentId.get(pid)]
        );
    };
    // s1 is booked the way the real schedule stores a forty-minute session:
    // TWO twenty-minute rows. s2 gets the whole block in one row. Both must
    // come out as one child, in the same lesson, for the same minutes.
    await book(THERAPISTS[0], '08:00-08:20', `${TAG}-s1`);   // IV-а, first half
    await book(THERAPISTS[0], '08:20-08:40', `${TAG}-s1`);   // IV-а, second half
    await book(THERAPISTS[1], '08:00-08:40', `${TAG}-s2`);   // IV-а, one row
    await book(THERAPISTS[0], '08:45-09:25', `${TAG}-s3`);   // VI
    await book(THERAPISTS[1], '08:45-09:25', `${TAG}-s4`);   // no class
    // Twenty minutes, and it does NOT start when a cabinet period starts.
    // Matching slots against period starts made this child disappear.
    await book(THERAPISTS[1], '10:45-11:05', `${TAG}-s5`);   // IV-а
    return { studentId, therapistId, year };
}

const run = async () => {
    console.log(`crossing e2e against ${BASE}\n`);

    const health = await call('GET', '/api/health');
    if (health.status !== 200) {
        console.error('The server is not answering. Start it with `npm run start` first.');
        process.exit(1);
    }


    await dropFixtureTeachers();

    // ── the timetable ───────────────────────────────────────────────────────
    console.log('the workbook goes in');
    const parsed = parseTeachingGrid(GRID);
    checkEq('three teachers read', parsed.teachers.length, 3);
    checkEq('classes collected in school order', parsed.classes, ['IV-а', 'VI', 'VI-а']);
    check('VI-а arrived from the subject teacher\'s cell, not from a fold of VI',
        parsed.lessons.some((l) => l.classLabel === 'VI-а' && l.teacher === 'ТРИ ПРОБЕН'));

    const year = await ownYear();
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const written = await writeTeaching(client, parsed, year);
        check('the timetable was written', !written.skipped, written.problems.join(' | '));
        checkEq('every lesson landed', written.lessons, parsed.lessons.length);
        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }

    await seed();
    const Y = encodeURIComponent(year.label);

    // ── the off-by-one ──────────────────────────────────────────────────────
    console.log('\nwhich lesson a child is actually missing');
    const { body: cross } = await call('GET', `/api/teaching/crossing?year=${Y}&day=${encodeURIComponent(DAY)}`);

    /** Only what this suite booked — the real week shares these classes. */
    const mine = (list: any[]) => (list || []).filter((a: any) => String(a.therapist).startsWith(TAG));
    const cellOf = (cls: string, ordinal: number) => {
        const cell = cross.cells.find((c: any) => c.class === cls && c.ordinal === ordinal);
        return cell ? { ...cell, away: mine(cell.away), awayCount: mine(cell.away).length } : cell;
    };
    const unplacedMine = cross.unplaced.filter((u: any) => String(u.therapist).startsWith(TAG));

    checkEq('nobody is missing from the FIRST lesson', cellOf('IV-а', 1)?.awayCount, 0);
    checkEq('both children are missing from the SECOND', cellOf('IV-а', 2)?.awayCount, 2);
    check('and the second lesson is the one the school calls мат.', cellOf('IV-а', 2)?.subject === 'мат.',
        JSON.stringify(cellOf('IV-а', 2)));
    checkEq('for 25 of its 40 minutes', cellOf('IV-а', 2)?.away?.[0]?.minutes, 25);

    // The fault this replaced: the two halves were measured separately, so the
    // child stored as two rows was reported missing from the first lesson too,
    // and from the second for only twenty minutes. A session is assembled
    // before it is measured.
    const halves = cellOf('IV-а', 2)?.away?.filter((a: any) => a.student === 'Прв Пробен') || [];
    checkEq('the child stored as two halves appears ONCE', halves.length, 1);
    checkEq('for the whole session, not half of it', halves[0]?.minutes, 25);
    check('and is not also reported absent from the first lesson',
        !(cellOf('IV-а', 1)?.away || []).some((a: any) => a.student === 'Прв Пробен'),
        JSON.stringify(cellOf('IV-а', 1)?.away));

    // A child booked only in a second half starts at 10:45, which is nobody's
    // period start. Matched against a table of starts, they vanished from the
    // crossing entirely — present in the schedule, absent from the answer.
    const late = (cellOf('IV-а', 5)?.away || []).filter((a: any) => a.student === 'Петти Пробен');
    checkEq('a child booked only in a SECOND half is still found', late.length, 1);
    checkEq('and is not listed as unplaceable',
        unplacedMine.filter((u: any) => u.student === 'Петти Пробен').length, 0);

    const covers = cross.bells.cabinet.find((b: any) => b.label === 'I');
    checkEq('block I is reported as covering lessons 2 and 1, in that order',
        covers.covers.map((c: any) => [c.ordinal, c.minutes]), [[2, 25], [1, 10]]);

    // ── nothing is guessed ──────────────────────────────────────────────────
    console.log('\nwhat cannot be placed is said out loud');
    const reasons = unplacedMine.map((u: any) => u.reason);
    checkEq('one of ours could not be placed', unplacedMine.length, 1);
    check('and the reason names the missing class', /no class recorded/.test(reasons[0] || ''), reasons.join(' | '));
    check('the summary counts at least ours', cross.summary.sessions >= 4 && cross.summary.unplaced >= 1,
        JSON.stringify(cross.summary));

    console.log('\nVI and VI-а are different rooms');
    // Трет Пробен is in VI and was taken during block II, which lands on
    // lesson 3. VI has no third lesson, so nothing is disturbed there — and
    // VI-а, which DOES have one, must not have picked him up.
    const viA2 = cellOf('VI-а', 2);
    check('the child from VI never appears under VI-а',
        !cross.cells.some((c: any) => c.class === 'VI-а' && mine(c.away).some((a: any) => a.student === 'Трет Пробен')),
        JSON.stringify(viA2));
    check('and VI itself is present in the crossing', cross.cells.some((c: any) => c.class === 'VI'));

    // ── a hand-typed subject survives ───────────────────────────────────────
    console.log('\nwhat a person typed in is not overwritten by a re-import');
    const { body: table } = await call('GET', `/api/teaching/timetable?year=${Y}`);
    const three = table.teachers.find((t: any) => t.name === 'Три Пробен');
    const two = table.teachers.find((t: any) => t.name === 'Два Пробен');
    checkEq('the workbook gave ТРИ its subject', three?.subject, 'ФЗО.');
    checkEq('and gave ДВА none', two?.subject, null);

    const patched = await call('PUT', `/api/teaching/teacher/${two.id}`, { subject: 'македонски јазик' });
    checkEq('a subject can be typed in', patched.body?.subject, 'македонски јазик');

    const client2 = await pool.connect();
    try {
        await client2.query('BEGIN');
        await writeTeaching(client2, parseTeachingGrid(GRID), year);
        await client2.query('COMMIT');
    } finally { client2.release(); }
    const { rows: kept } = await pool.query(`SELECT subject FROM teachers WHERE name = 'Два Пробен'`);
    checkEq('and it is still there after importing the same workbook again', kept[0]?.subject, 'македонски јазик');

    // ── one spelling per person ─────────────────────────────────────────────
    // The workbook writes the staff in capitals. The database does not, or
    // every screen shouts — and `Podatoci.html` title-cases a name as it saves
    // it, so without one rule the same teacher is stored one way or the other
    // depending on which screen last pressed a button.
    checkEq('the workbook\'s capitals are not what is stored',
        (await pool.query(`SELECT count(*)::int AS n FROM teachers WHERE name = 'ДВА ПРОБЕН'`)).rows[0].n, 0);
    checkEq('one spelling is, title-cased',
        (await pool.query(`SELECT count(*)::int AS n FROM teachers WHERE name = 'Два Пробен'`)).rows[0].n, 1);

    // And the sharp end of it. Somebody corrects a teacher's name on a screen,
    // then the workbook — which still shouts — is imported again. The unique
    // key on `teachers.name` is the exact string, so an `ON CONFLICT (name)`
    // upsert would not have matched: a SECOND row for the same person, with
    // this year's lessons hanging off it while `teacher_classes` still pointed
    // at the first, and both of them listed on screen.
    await pool.query(`UPDATE teachers SET name = 'два пробен' WHERE name = 'Два Пробен'`);
    const client3 = await pool.connect();
    try {
        await client3.query('BEGIN');
        await writeTeaching(client3, parseTeachingGrid(GRID), year);
        await client3.query('COMMIT');
    } finally { client3.release(); }
    const { rows: after } = await pool.query(
        `SELECT name FROM teachers WHERE lower(btrim(name)) = 'два пробен'`
    );
    checkEq('a re-import adds no second row for a name spelt differently', after.length, 1);
    checkEq('and does not undo the spelling a person typed', after[0]?.name, 'два пробен');

    // ── put the database back ───────────────────────────────────────────────
    // Only this suite's own year has to go; dropping it cascades to every
    // lesson, slot and enrollment it created. The school's timetable was never
    // touched, so there is nothing to restore.
    await cleanup();
    await dropOwnYear();
    await dropFixtureTeachers();

    await pool.end();
    console.log(failures ? `\n${failures} failed` : '\nall good');
    process.exit(failures ? 1 : 0);
};

run().catch(async (e) => { console.error(e); await pool.end().catch(() => {}); process.exit(1); });

/**
 * Stage B in a real browser, against the real server and database.
 *
 * The server-side test proved the endpoints. This proves the thing that
 * actually breaks: whether the app NOTICES a roster change and sends it —
 * the same class of bug as the S-Dnevnik wrapper that never ran.
 * So every assertion here reads the DATABASE, never the app's own opinion.
 */
import { chromium } from 'playwright';
import pg from 'pg';

const BASE = process.env.API || 'http://127.0.0.1:3000';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL || 'postgresql://therapy:therapy_local@localhost:5432/therapy_dev' });

const NEW_STUDENT = 'Проба Ученикоски';
const NEW_STUDENT_RENAMED = 'Проба Преименуван';
const NEW_THERAPIST = 'Проба Терапевт';
const T_RENAMED = 'Проба Терапевтка';

const SRV = BASE;

let fails = 0;
const check = (label, cond, detail = '') => {
    if (cond) console.log(`  ok   ${label}`);
    else { fails++; console.log(`  FAIL ${label}${detail ? '\n       ' + detail : ''}`); }
};

async function clean() {
    await pool.query(`DELETE FROM schedule_slots WHERE therapist_id IN
        (SELECT id FROM therapists WHERE name = ANY($1::text[]))`, [[NEW_THERAPIST, T_RENAMED]]);
    await pool.query(`DELETE FROM student_enrollments WHERE student_id IN
        (SELECT id FROM students WHERE name = ANY($1::text[]))`, [[NEW_STUDENT, NEW_STUDENT_RENAMED]]);
    await pool.query('DELETE FROM students WHERE name = ANY($1::text[])', [[NEW_STUDENT, NEW_STUDENT_RENAMED]]);
    await pool.query('DELETE FROM therapists WHERE name = ANY($1::text[])', [[NEW_THERAPIST, T_RENAMED]]);
}

const run = async () => {
    await clean();
    const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    await page.goto(`${BASE}/Rasporedi.html`);
    await page.waitForTimeout(1500);

    // Turn Stage A+B on, the way the therapist would, and reload.
    await page.evaluate((srv) => {
        localStorage.setItem('rasporedi_slot_writes_v1', 'on');
        localStorage.setItem('local_server_url_v1', srv);
        localStorage.removeItem('rasporedi_roster_seen_v1');
    }, SRV);
    await page.reload();
    await page.waitForTimeout(2500);

    console.log('\nadding people in the app');

    // Add a therapist and a student through the app's own functions — the
    // same code path the buttons call, not a fabricated one.
    await page.evaluate(({ s, t }) => {
        document.getElementById('crudNewTherapistName').value = t;
        quickAddTherapistFromCrud();
        document.getElementById('quickStudentName').value = s;
        const g = document.getElementById('quickStudentGrade');
        if (g) {                       // it is a <select>; add the option if absent
            if (![...g.options].some(o => o.value === 'III-а')) g.add(new Option('III-а', 'III-а'));
            g.value = 'III-а';
        }
        quickAddStudent();
    }, { s: NEW_STUDENT, t: NEW_THERAPIST });
    await page.waitForTimeout(2500);

    const st = await pool.query('SELECT id, public_id, grade FROM students WHERE name = $1', [NEW_STUDENT]);
    check('a student added in the app reaches the database', st.rowCount === 1,
        `found ${st.rowCount} rows`);
    const th = await pool.query('SELECT id FROM therapists WHERE name = $1', [NEW_THERAPIST]);
    check('so does a therapist', th.rowCount === 1, `found ${th.rowCount} rows`);

    const enrol = await pool.query(
        `SELECT 1 FROM student_enrollments e JOIN school_years y ON y.id = e.school_year_id AND y.is_current
          WHERE e.student_id = $1`, [st.rows[0]?.id ?? -1]);
    check('and the student is enrolled in the current year', enrol.rowCount === 1);

    // A term for them — this is what used to 404 before the roster had a path.
    console.log('\nthe cell that used to be lost');
    await page.evaluate(({ s, t }) => {
        applyAssignment('Понеделник', '09:00', t, s);
        saveScheduleToLocal();
    }, { s: NEW_STUDENT, t: NEW_THERAPIST });
    await page.waitForTimeout(2000);

    const slot = await pool.query(
        `SELECT s.name FROM schedule_slots sl
           JOIN therapists t ON t.id = sl.therapist_id
           JOIN students s ON s.id = sl.student_id
          WHERE t.name = $1 AND sl.day = 'Понеделник' AND sl.time_slot = '09:00'`, [NEW_THERAPIST]);
    check('the term lands, naming the brand-new student', slot.rows[0]?.name === NEW_STUDENT,
        `database holds ${JSON.stringify(slot.rows)}`);

    // ── rename keeps the row ──────────────────────────────────────────────
    console.log('\nrenaming');
    const idBefore = st.rows[0]?.id;

    await page.evaluate(({ oldName, newName }) => {
        const state = currentStateSnapshot();
        stateRenameStudent(state, oldName, newName);
        installState(state);
    }, { oldName: NEW_STUDENT, newName: NEW_STUDENT_RENAMED });
    await page.waitForTimeout(3500);

    const after = await pool.query('SELECT id, name FROM students WHERE public_id = $1', [st.rows[0]?.public_id]);
    check('a rename in the app renames the same database row', after.rows[0]?.name === NEW_STUDENT_RENAMED,
        `row now: ${JSON.stringify(after.rows[0])}`);
    check('the row id did not move, so the term survived', after.rows[0]?.id === idBefore);

    const slotAfter = await pool.query(
        `SELECT s.name FROM schedule_slots sl
           JOIN therapists t ON t.id = sl.therapist_id
           JOIN students s ON s.id = sl.student_id
          WHERE t.name = $1 AND sl.day = 'Понеделник' AND sl.time_slot = '09:00'`, [NEW_THERAPIST]);
    check('and the term still points at them under the new name',
        slotAfter.rows[0]?.name === NEW_STUDENT_RENAMED, JSON.stringify(slotAfter.rows));

    // Therapist rename — the one the app must state, because a diff cannot see it.
    await page.evaluate(({ from, to }) => {
        RSlots.renameTherapist(from, to);
        therapists = therapists.map(t => t === from ? to : t);
        therapistStudents[to] = therapistStudents[from] || [];
        delete therapistStudents[from];
        (scheduleData.schedule || []).forEach(sl => {
            if (sl.assignments && from in sl.assignments) {
                sl.assignments[to] = sl.assignments[from];
                delete sl.assignments[from];
            }
        });
        saveScheduleToLocal();
    }, { from: NEW_THERAPIST, to: T_RENAMED });
    await page.waitForTimeout(2500);

    const tAfter = await pool.query('SELECT id, name FROM therapists WHERE name = ANY($1::text[])', [[NEW_THERAPIST, T_RENAMED]]);
    check('a therapist rename moves the row rather than making a second person',
        tAfter.rowCount === 1 && tAfter.rows[0].name === T_RENAMED,
        `therapists now: ${JSON.stringify(tAfter.rows)}`);
    check('and it is the same row, so their week came with them',
        tAfter.rows[0]?.id === th.rows[0]?.id);

    // ── what must NOT happen ──────────────────────────────────────────────
    console.log('\nwhat the app must not be able to do');

    await pool.query(`UPDATE students SET active = false, left_at = now(), left_reason = 'finished'
                       WHERE public_id = $1`, [st.rows[0]?.public_id]);
    // Force the app to resend the roster as if it had never sent it.
    await page.evaluate(() => { RSlots.noteBulkChange(); saveScheduleToLocal(); });
    await page.waitForTimeout(3000);

    const stillArchived = await pool.query('SELECT active, left_reason FROM students WHERE public_id = $1', [st.rows[0]?.public_id]);
    check('a student archived in S-Dnevnik stays archived, however Rasporedi is saved',
        stillArchived.rows[0]?.active === false && stillArchived.rows[0]?.left_reason === 'finished',
        JSON.stringify(stillArchived.rows[0]));

    // Deleting locally must not retire anyone in the database.
    await pool.query('UPDATE students SET active = true, left_at = NULL, left_reason = NULL WHERE public_id = $1', [st.rows[0]?.public_id]);
    await page.evaluate((name) => {
        students = students.filter(s => s !== name);
        delete studentMeta[name];
        (scheduleData.schedule || []).forEach(sl => {
            Object.keys(sl.assignments || {}).forEach(t => {
                if (sl.assignments[t] === name) {
                    delete sl.assignments[t];
                    RSlots.queue(sl.day, sl.time, t, '', name);
                }
            });
        });
        saveScheduleToLocal();
    }, NEW_STUDENT_RENAMED);
    await page.waitForTimeout(2500);

    const survived = await pool.query('SELECT active FROM students WHERE public_id = $1', [st.rows[0]?.public_id]);
    check('removing a student from Rasporedi does NOT retire them in the database',
        survived.rows[0]?.active === true,
        'Rasporedi decided enrolment — that belongs to S-Dnevnik alone');

    const clearedSlot = await pool.query(
        `SELECT count(*)::int n FROM schedule_slots sl JOIN therapists t ON t.id = sl.therapist_id
          WHERE t.name = $1 AND sl.day = 'Понеделник' AND sl.time_slot = '09:00'`, [T_RENAMED]);
    check('but their term IS cleared on the server, not left booked for ever',
        clearedSlot.rows[0].n === 0, `${clearedSlot.rows[0].n} terms still there`);

    check('no page errors', errors.length === 0, errors.join('\n       '));

    await browser.close();
    await clean();
    await pool.end();
    console.log(fails ? `\n${fails} FAILED\n` : '\nall assertions held\n');
    process.exit(fails ? 1 : 0);
};

run().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });

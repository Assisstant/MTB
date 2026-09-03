/**
 * Editing the timetable, against a real server and a real database.
 *
 *     npm run start                    # in one terminal
 *     npm run test:teaching-edit
 *
 * What this is here to prove, in order of what it would cost to get wrong:
 *
 *   1. A hand-entered lesson is crossed EXACTLY like an imported one. It is
 *      easy to write a row that exists, looks right in the editor, and never
 *      appears in the crossing because `day_order` or the day's spelling is
 *      one character off — and nothing would ever say so.
 *   2. Copying last year does not promote the classes. IV-б stays IV-б: the
 *      timetable belongs to the classroom, not to the children who moved up,
 *      and promoting the label would put the new fourth-graders on the fifth
 *      grade's timetable while looking entirely plausible.
 *   3. A stale tab cannot overwrite a cell somebody else changed.
 *   4. Nothing here can delete a class or a teacher, in any year.
 *
 * Like the crossing suite, it works in school years of its OWN and shares the
 * database with a real school without touching it. Its classes and teachers
 * are prefixed and invented (rule 1), and the one bell it edits is a bell it
 * created. The edit is scoped to its own year.
 */

import { pool } from '../src/db.js';

const BASE = process.env.API || 'http://127.0.0.1:3000';
const TAG = 'e2e-edit';
const SRC_YEAR = '1902/1903-edit';
const DST_YEAR = '1903/1904-edit';
const CLASS_A = 'ТЕСТ-А';
const CLASS_B = 'ТЕСТ-Б';
const T1 = `${TAG} Прв Наставник`;
const T2 = `${TAG} Втор Наставник`;
const DAY = 'четврток';

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

const q = async (text: string, args: any[] = []) => (await pool.query(text, args)).rows;

async function makeYear(label: string, from: string) {
    const rows = await q(
        `INSERT INTO school_years (label, starts_on, ends_on, is_current)
         VALUES ($1, $2::date, ($2::date + interval '1 year')::date, false)
         ON CONFLICT (label) DO UPDATE SET label = EXCLUDED.label
         RETURNING id, label`,
        [label, from]
    );
    return rows[0] as { id: number; label: string };
}

/**
 * Everything this suite made, removed in the order the foreign keys allow.
 * The school years go first: dropping one CASCADEs its lessons, enrollments
 * and therapy slots, which is most of the fixture.
 */
async function cleanup() {
    await q(`DELETE FROM school_years WHERE label IN ($1, $2)`, [SRC_YEAR, DST_YEAR]);
    await q(`DELETE FROM schedule_slots WHERE therapist_id IN (SELECT id FROM therapists WHERE name LIKE $1)`, [`${TAG}%`]);
    await q(`DELETE FROM therapist_students WHERE therapist_id IN (SELECT id FROM therapists WHERE name LIKE $1)`, [`${TAG}%`]);
    await q(`DELETE FROM therapists WHERE name LIKE $1`, [`${TAG}%`]);
    await q(`DELETE FROM students WHERE public_id LIKE $1`, [`${TAG}%`]);
    // Deleting the class cascades its lessons in every year; both are this
    // suite's own, and the labels cannot collide with a real class.
    await q(`DELETE FROM school_classes WHERE label IN ($1, $2, $3)`, [CLASS_A, CLASS_B, CLASS_B + '-ново']);
    // Case-insensitively: this suite deliberately creates a teacher whose
    // name is SHOUTED, and the server stores one spelling for everybody. A
    // case-sensitive LIKE would leave whichever form it did not guess behind.
    await q(`DELETE FROM teachers WHERE lower(btrim(name)) LIKE lower($1)`, [`${TAG}%`]);
    await q(`DELETE FROM bell_periods WHERE schedule = $1`, [`${TAG}-bells`]);
}

async function cellIn(yearId: number, day: string, ordinal: number, label: string) {
    const rows = await q(
        `SELECT l.id, l.subject, l.day_order, t.name AS teacher
         FROM lessons l JOIN school_classes c ON c.id = l.class_id
         LEFT JOIN teachers t ON t.id = l.teacher_id
         WHERE l.school_year_id = $1 AND l.day = $2 AND l.ordinal = $3 AND c.label = $4
         ORDER BY l.id`,
        [yearId, day, ordinal, label]
    );
    return rows as any[];
}

const run = async () => {
    await cleanup();
    const src = await makeYear(SRC_YEAR, '1902-09-01');
    const dst = await makeYear(DST_YEAR, '1903-09-01');

    console.log('classes and teachers are created, never invented on the fly');
    const madeA = await call('POST', '/api/teaching/class', { label: CLASS_A });
    const madeB = await call('POST', '/api/teaching/class', { label: CLASS_B });
    checkEq('a new class answers 201', madeA.status, 201);
    check('and it comes back with an id', Number.isInteger(madeA.body?.id), JSON.stringify(madeA.body));
    const again = await call('POST', '/api/teaching/class', { label: CLASS_A });
    checkEq('the same class again answers 200, not a second row', again.status, 200);
    checkEq('and it is the SAME row', again.body?.id, madeA.body?.id);
    const dupes = await q(`SELECT count(*)::int AS n FROM school_classes WHERE label = $1`, [CLASS_A]);
    checkEq('the database holds one row for it', dupes[0].n, 1);

    const t1 = await call('POST', '/api/teaching/teacher', { name: T1, kind: 'odd' });
    const t2 = await call('POST', '/api/teaching/teacher', { name: T2, kind: 'pred', subject: 'ФЗО.' });
    checkEq('a new teacher answers 201', t1.status, 201);
    const twice = await call('POST', '/api/teaching/teacher', { name: T1, kind: 'odd' });
    checkEq('the same teacher again is refused, not duplicated', twice.status, 409);
    const teacherRows = await q(`SELECT count(*)::int AS n FROM teachers WHERE name = $1`, [T1]);
    checkEq('and there is still one of them', teacherRows[0].n, 1);

    // One spelling per person, whichever screen types it. The workbook shouts
    // and this endpoint does not have to: a name typed in capitals here would
    // otherwise sit beside twenty title-cased ones and read as a different
    // kind of row — and, because the unique key is the exact string, the same
    // person could be created twice.
    const shouted = await call('POST', '/api/teaching/teacher',
        { name: `${TAG.toUpperCase()} ТРЕТ НАСТАВНИК`, kind: 'pred' });
    checkEq('a shouted name is accepted', shouted.status, 201);
    check('and stored as one spelling',
        String(shouted.body?.name).endsWith(' Трет Наставник'), String(shouted.body?.name));
    const otherCase = await call('POST', '/api/teaching/teacher',
        { name: `${TAG.toUpperCase()} трет наставник`, kind: 'pred' });
    checkEq('the same name in another case is the same teacher', otherCase.status, 409);

    console.log('\none cell of the timetable');
    const put = (body: any) => call('PUT', '/api/teaching/lesson', { year: DST_YEAR, day: DAY, ...body });

    const first = await put({ ordinal: 2, class: CLASS_A, subject: 'мат.', teacher: T1, expected: null });
    checkEq('writing into an empty cell answers 200', first.status, 200);
    checkEq('and says it inserted', first.body?.action, 'inserted');
    let row = await cellIn(dst.id, DAY, 2, CLASS_A);
    checkEq('the database holds exactly one lesson there', row.length, 1);
    checkEq('with the subject that was typed', row[0].subject, 'мат.');
    checkEq('and the teacher that was chosen', row[0].teacher, T1);
    // A row whose day_order is 0 exists, draws, and sorts before Monday in
    // every query that orders by it — including the crossing's.
    checkEq('day_order is filled in, so it sorts with the imported lessons', row[0].day_order, 4);

    const edited = await put({ ordinal: 2, class: CLASS_A, subject: 'мак.', teacher: T2, expected: { subject: 'мат.', teacher: T1 } });
    checkEq('editing with the right expectation answers 200', edited.status, 200);
    checkEq('and says it updated rather than inserting a second', edited.body?.action, 'updated');
    row = await cellIn(dst.id, DAY, 2, CLASS_A);
    checkEq('still one lesson in the cell', row.length, 1);
    checkEq('now with the new subject', row[0].subject, 'мак.');

    const stale = await put({ ordinal: 2, class: CLASS_A, subject: 'з.о.', teacher: T1, expected: { subject: 'мат.', teacher: T1 } });
    checkEq('a stale tab is refused with 409', stale.status, 409);
    check('and told what is really there', stale.body?.here?.subject === 'мак.', JSON.stringify(stale.body));
    row = await cellIn(dst.id, DAY, 2, CLASS_A);
    checkEq('the refused write changed nothing', row[0].subject, 'мак.');

    const wronglyEmpty = await put({ ordinal: 2, class: CLASS_A, subject: 'физ.', expected: null });
    checkEq('"I believe this cell is empty" is refused when it is not', wronglyEmpty.status, 409);

    const noCheck = await put({ ordinal: 2, class: CLASS_A, subject: 'мак.', teacher: null });
    checkEq('omitting expected skips the check', noCheck.status, 200);
    row = await cellIn(dst.id, DAY, 2, CLASS_A);
    checkEq('the teacher can be cleared without losing the subject', [row[0].teacher, row[0].subject], [null, 'мак.']);

    console.log('\nnothing is invented to make a write succeed');
    const ghostClass = await put({ ordinal: 3, class: 'НЕПОСТОЕЧКО-99', subject: 'мак.' });
    checkEq('an unknown class is a 404', ghostClass.status, 404);
    check('that says what to do about it', /class/i.test(String(ghostClass.body?.error)), JSON.stringify(ghostClass.body));
    const invented = await q(`SELECT count(*)::int AS n FROM school_classes WHERE label = $1`, ['НЕПОСТОЕЧКО-99']);
    checkEq('and no class was quietly created', invented[0].n, 0);

    const ghostTeacher = await put({ ordinal: 3, class: CLASS_A, subject: 'мак.', teacher: 'Никој Никаков' });
    checkEq('an unknown teacher is a 404 too', ghostTeacher.status, 404);
    const inventedT = await q(`SELECT count(*)::int AS n FROM teachers WHERE name = $1`, ['Никој Никаков']);
    checkEq('and no teacher was created', inventedT[0].n, 0);

    const notADay = await put({ day: 'недела', ordinal: 1, class: CLASS_A, subject: 'мак.' });
    checkEq('a day the school does not teach is refused', notADay.status, 400);

    console.log('\na cell that holds two lessons is not silently picked between');
    // A clash comes from the workbook, so it is made the way the workbook
    // makes it: two teachers, same class, same period.
    await q(
        `INSERT INTO lessons (school_year_id, day, day_order, ordinal, class_id, teacher_id, subject)
         SELECT $1, $2, 4, 5, c.id, t.id, $4 FROM school_classes c, teachers t
          WHERE c.label = $3 AND t.name = $5`,
        [dst.id, DAY, CLASS_A, 'лик.', T1]
    );
    await q(
        `INSERT INTO lessons (school_year_id, day, day_order, ordinal, class_id, teacher_id, subject)
         SELECT $1, $2, 4, 5, c.id, t.id, $4 FROM school_classes c, teachers t
          WHERE c.label = $3 AND t.name = $5`,
        [dst.id, DAY, CLASS_A, 'физ.', T2]
    );
    const clashed = await put({ ordinal: 5, class: CLASS_A, subject: 'мак.' });
    checkEq('writing over a clash is refused', clashed.status, 409);
    checkEq('and both lessons are named', (clashed.body?.here || []).length, 2);
    const stillTwo = await cellIn(dst.id, DAY, 5, CLASS_A);
    checkEq('neither was overwritten', stillTwo.length, 2);

    const dropped = await call('DELETE', '/api/teaching/lesson/' + stillTwo[0].id);
    checkEq('deleting one of them works', dropped.status, 200);
    checkEq('and leaves the other', (await cellIn(dst.id, DAY, 5, CLASS_A)).length, 1);
    const nowFine = await put({ ordinal: 5, class: CLASS_A, subject: 'мак.', teacher: null });
    checkEq('after which the cell can be written again', nowFine.status, 200);
    checkEq('deleting a lesson that is not there is a 404', (await call('DELETE', '/api/teaching/lesson/999999999')).status, 404);

    console.log('\npeople and classes cannot be deleted from here');
    const classId = madeA.body?.id;
    const teacherId = t1.body?.id;
    checkEq('there is no DELETE for a class', (await call('DELETE', '/api/teaching/class/' + classId)).status, 404);
    checkEq('there is no DELETE for a teacher', (await call('DELETE', '/api/teaching/teacher/' + teacherId)).status, 404);
    checkEq('the class is still there', (await q(`SELECT count(*)::int AS n FROM school_classes WHERE id = $1`, [classId]))[0].n, 1);
    checkEq('and so is the teacher', (await q(`SELECT count(*)::int AS n FROM teachers WHERE id = $1`, [teacherId]))[0].n, 1);

    console.log('\nrenaming a class moves its lessons with it, and cannot merge two');
    const renamed = await call('PATCH', '/api/teaching/class/' + madeB.body.id, { label: CLASS_B + '-ново' });
    checkEq('a rename answers 200', renamed.status, 200);
    const onto = await call('PATCH', '/api/teaching/class/' + madeB.body.id, { label: CLASS_A });
    checkEq('renaming onto an existing class is refused', onto.status, 409);
    checkEq('and it kept its own name', (await q(`SELECT label FROM school_classes WHERE id = $1`, [madeB.body.id]))[0].label, CLASS_B + '-ново');

    console.log('\nthe teacher fields the workbook cannot fill');
    const patched = await call('PUT', '/api/teaching/teacher/' + t2.body.id, { subject: 'АНГ.', kind: 'pred' });
    checkEq('subject and kind are set together', patched.status, 200);
    checkEq('and come back as they were written', [patched.body?.subject, patched.body?.kind], ['АНГ.', 'pred']);
    checkEq('nothing to change is a 400', (await call('PUT', '/api/teaching/teacher/' + t2.body.id, {})).status, 400);

    console.log('\na teacher has classes, plural, and they belong to a YEAR');
    // The old single column could hold one class and had no year. Both are
    // wrong here: комбинирани паралелки are several classes taught together,
    // and a homeroom changes every September.
    const both = await call('PUT', `/api/teaching/teacher/${t1.body.id}/classes`, {
        year: DST_YEAR,
        classes: [{ label: CLASS_A, role: 'homeroom' }, { label: CLASS_B + '-ново', role: 'subject' }]
    });
    checkEq('two classes at once answers 200', both.status, 200);
    checkEq('and both come back, homeroom first', (both.body?.classes || []).map((c: any) => `${c.label}:${c.role}`),
        [`${CLASS_A}:homeroom`, `${CLASS_B}-ново:subject`]);
    const stored = await q(
        `SELECT c.label, tc.role FROM teacher_classes tc JOIN school_classes c ON c.id = tc.class_id
          WHERE tc.school_year_id = $1 AND tc.teacher_id = $2 ORDER BY tc.role DESC, c.label`,
        [dst.id, t1.body.id]);
    checkEq('the database holds exactly those two', stored.length, 2);

    // The same teacher, a different year, a different class — which the old
    // column could not express at all, so importing one year rewrote the other.
    await call('PUT', `/api/teaching/teacher/${t1.body.id}/classes`, {
        year: SRC_YEAR, classes: [{ label: CLASS_B + '-ново', role: 'homeroom' }]
    });
    const inSrc = await q(`SELECT count(*)::int AS n FROM teacher_classes WHERE school_year_id = $1 AND teacher_id = $2`, [src.id, t1.body.id]);
    const stillDst = await q(`SELECT count(*)::int AS n FROM teacher_classes WHERE school_year_id = $1 AND teacher_id = $2`, [dst.id, t1.body.id]);
    checkEq('last year got its own assignment', inSrc[0].n, 1);
    checkEq('and this year kept both of its own', stillDst[0].n, 2);

    const halfBad = await call('PUT', `/api/teaching/teacher/${t1.body.id}/classes`, {
        year: DST_YEAR, classes: [{ label: CLASS_A, role: 'homeroom' }, { label: 'НЕПОСТОЕЧКО-99' }]
    });
    checkEq('one mistyped label refuses the whole list', halfBad.status, 404);
    const afterBad = await q(`SELECT count(*)::int AS n FROM teacher_classes WHERE school_year_id = $1 AND teacher_id = $2`, [dst.id, t1.body.id]);
    // Half-applying would leave the teacher holding one of their two classes,
    // with nothing on screen to say which one went missing.
    checkEq('and leaves the previous assignment untouched', afterBad[0].n, 2);

    const emptied = await call('PUT', `/api/teaching/teacher/${t1.body.id}/classes`, { year: DST_YEAR, classes: [] });
    checkEq('an empty list clears the assignment, which is a thing to mean', emptied.status, 200);
    checkEq('and it really is cleared',
        (await q(`SELECT count(*)::int AS n FROM teacher_classes WHERE school_year_id = $1 AND teacher_id = $2`, [dst.id, t1.body.id]))[0].n, 0);
    checkEq('an unknown teacher is a 404', (await call('PUT', '/api/teaching/teacher/999999999/classes', { classes: [] })).status, 404);

    console.log('\na class changes its homeroom without touching another year');
    const classStaff = await call('PUT', `/api/teaching/class/${madeA.body.id}/teachers`, {
        year: DST_YEAR,
        homeroomTeacherId: t2.body.id,
        subjectTeacherIds: [t1.body.id]
    });
    checkEq('the class-centred write answers 200', classStaff.status, 200);
    checkEq('and returns one homeroom followed by the subject teacher',
        (classStaff.body?.teachers || []).map((teacher: any) => `${teacher.name}:${teacher.role}`),
        [`${T2}:homeroom`, `${T1}:subject`]);
    const classStaffStored = await q(
        `SELECT t.name, tc.role FROM teacher_classes tc JOIN teachers t ON t.id = tc.teacher_id
          WHERE tc.school_year_id = $1 AND tc.class_id = $2
          ORDER BY (tc.role = 'homeroom') DESC, t.name`,
        [dst.id, madeA.body.id]
    );
    checkEq('the database holds exactly that class assignment',
        classStaffStored.map((teacher: any) => `${teacher.name}:${teacher.role}`),
        [`${T2}:homeroom`, `${T1}:subject`]);
    checkEq('the archived year did not receive the new homeroom',
        (await q(`SELECT count(*)::int AS n FROM teacher_classes WHERE school_year_id = $1 AND class_id = $2`,
            [src.id, madeA.body.id]))[0].n, 0);

    const badClassStaff = await call('PUT', `/api/teaching/class/${madeA.body.id}/teachers`, {
        year: DST_YEAR,
        homeroomTeacherId: 999999999,
        subjectTeacherIds: []
    });
    checkEq('an unknown replacement teacher refuses the whole change', badClassStaff.status, 404);
    checkEq('and the previous class assignment remains complete',
        (await q(`SELECT count(*)::int AS n FROM teacher_classes WHERE school_year_id = $1 AND class_id = $2`,
            [dst.id, madeA.body.id]))[0].n, 2);

    console.log('\nlast year as this year\'s starting point');
    // The source year gets a small timetable of its own, written the way the
    // importer writes one.
    for (const [ordinal, subject, label] of [[1, 'мак.', CLASS_A], [2, 'мат.', CLASS_A], [1, 'мак.', CLASS_B + '-ново']] as [number, string, string][]) {
        await q(
            `INSERT INTO lessons (school_year_id, day, day_order, ordinal, class_id, teacher_id, subject)
             SELECT $1, $2, 4, $3, c.id, (SELECT id FROM teachers WHERE name = $5), $4
               FROM school_classes c WHERE c.label = $6`,
            [src.id, DAY, ordinal, subject, T1, label]
        );
    }

    const dry = await call('POST', '/api/teaching/copy-year', { from: SRC_YEAR, to: DST_YEAR });
    checkEq('copying onto a year that already has lessons is refused', dry.status, 409);
    check('and says why, in a sentence with the numbers in it',
        /already has \d+ lessons/.test(String((dry.body?.problems || []).join(' '))), JSON.stringify(dry.body));

    const dstBefore = (await q(`SELECT count(*)::int AS n FROM lessons WHERE school_year_id = $1`, [dst.id]))[0].n;
    const dryReplace = await call('POST', '/api/teaching/copy-year', { from: SRC_YEAR, to: DST_YEAR, replace: true });
    checkEq('a dry run with replace answers 200', dryReplace.status, 200);
    checkEq('and does not claim to have applied anything', dryReplace.body?.applied, false);
    checkEq('it counts what is in the way', dryReplace.body?.existing, dstBefore);
    checkEq('nothing moved', (await q(`SELECT count(*)::int AS n FROM lessons WHERE school_year_id = $1`, [dst.id]))[0].n, dstBefore);

    const applied = await call('POST', '/api/teaching/copy-year', { from: SRC_YEAR, to: DST_YEAR, replace: true, apply: true });
    check(
        'applying answers 200',
        applied.status === 200,
        applied.status === 200 ? '' : `expected 200, got ${applied.status}: ${JSON.stringify(applied.body)}`
    );
    checkEq('and copies every lesson', applied.body?.lessons, 3);
    checkEq('reporting what it removed', applied.body?.removed, dstBefore);
    const after = await q(
        `SELECT c.label, l.ordinal FROM lessons l JOIN school_classes c ON c.id = l.class_id
          WHERE l.school_year_id = $1 ORDER BY c.label, l.ordinal`, [dst.id]);
    checkEq('the target year now holds exactly the source year', after.length, 3);
    // The one that would look plausible and be wrong: promoting the label.
    check('the classes are NOT promoted — they keep their own labels',
        after.every((r: any) => r.label === CLASS_A || r.label === CLASS_B + '-ново'),
        JSON.stringify(after));

    const sameYear = await call('POST', '/api/teaching/copy-year', { from: DST_YEAR, to: DST_YEAR, replace: true, apply: true });
    checkEq('copying a year onto itself is refused', sameYear.status, 409);
    const emptyYear = await makeYear('1904/1905-edit', '1904-09-01');
    const fromEmpty = await call('POST', '/api/teaching/copy-year', { from: '1904/1905-edit', to: DST_YEAR, replace: true, apply: true });
    checkEq('copying from a year with no timetable is refused, not reported as a success', fromEmpty.status, 409);
    checkEq('and the target is untouched', (await q(`SELECT count(*)::int AS n FROM lessons WHERE school_year_id = $1`, [dst.id]))[0].n, 3);
    await q(`DELETE FROM school_years WHERE id = $1`, [emptyYear.id]);

    console.log('\nemptying a year is one intention, stated once, with a count');
    const holds = (await q(`SELECT count(*)::int AS n FROM lessons WHERE school_year_id = $1`, [dst.id]))[0].n;
    const wrongCount = await call('DELETE', '/api/teaching/year-lessons', { year: DST_YEAR, expect: holds + 5 });
    checkEq('a count that does not match is refused', wrongCount.status, 409);
    checkEq('and nothing was thrown away', (await q(`SELECT count(*)::int AS n FROM lessons WHERE school_year_id = $1`, [dst.id]))[0].n, holds);
    const emptiedYear = await call('DELETE', '/api/teaching/year-lessons', { year: DST_YEAR, expect: holds });
    checkEq('the right count empties it', emptiedYear.status, 200);
    checkEq('and says how many went', emptiedYear.body?.removed, holds);
    checkEq('the year is empty', (await q(`SELECT count(*)::int AS n FROM lessons WHERE school_year_id = $1`, [dst.id]))[0].n, 0);
    checkEq('the other year is untouched', (await q(`SELECT count(*)::int AS n FROM lessons WHERE school_year_id = $1`, [src.id]))[0].n, 3);

    console.log('\na bell can be moved, and the endpoint says what it did');
    const [bell] = await q(
        `INSERT INTO bell_periods (schedule, ordinal, label, starts_at, minutes)
         VALUES ($1, 1, 'I', '08:00', 40) RETURNING id`, [`${TAG}-bells`]);
    const moved = await call('PUT', '/api/teaching/bell/' + bell.id, {
        year: DST_YEAR, startsAt: '7:30', minutes: 45
    });
    checkEq('moving a bell answers 200', moved.status, 200);
    checkEq('and normalises the clock', moved.body?.startsAt, '07:30');
    const [override] = await q(
        `SELECT to_char(o.starts_at, 'HH24:MI') AS s, o.minutes
         FROM bell_period_overrides o
         WHERE o.school_year_id = $1 AND o.bell_period_id = $2`,
        [dst.id, bell.id]
    );
    checkEq('the selected year agrees', override.s, '07:30');
    checkEq('and the duration is year-specific too', override.minutes, 45);
    checkEq('the base bell remains unchanged',
        (await q(`SELECT to_char(starts_at, 'HH24:MI') AS s FROM bell_periods WHERE id = $1`, [bell.id]))[0].s,
        '08:00');
    checkEq('the source year was not changed',
        (await q(`SELECT count(*)::int AS n FROM bell_period_overrides WHERE school_year_id = $1 AND bell_period_id = $2`, [src.id, bell.id]))[0].n,
        0);
    checkEq('a time that is not a time is refused',
        (await call('PUT', '/api/teaching/bell/' + bell.id, { year: DST_YEAR, startsAt: '99:99' })).status,
        400);

    console.log('\nand the whole point: a hand-entered lesson crosses like an imported one');
    // A child in ТЕСТ-А, taken at 08:00 — which is 25 minutes of the SECOND
    // teaching lesson, not the first.
    const [student] = await q(
        `INSERT INTO students (public_id, name, grade) VALUES ($1, $2, $3) RETURNING id`,
        [`${TAG}-s1`, `${TAG} Ученик Пробен`, CLASS_A]);
    await q(`INSERT INTO student_enrollments (student_id, school_year_id, grade) VALUES ($1, $2, $3)`,
        [student.id, dst.id, CLASS_A]);
    const [therapist] = await q(`INSERT INTO therapists (name) VALUES ($1) RETURNING id`, [`${TAG} Терапевт`]);
    await q(
        `INSERT INTO therapist_years (school_year_id, therapist_id, active) VALUES ($1, $2, true)`,
        [dst.id, therapist.id]
    );
    await q(`INSERT INTO schedule_slots (school_year_id, day, day_order, time_slot, therapist_id, student_id)
             VALUES ($1, $2, 4, '08:00-08:40', $3, $4)`, [dst.id, DAY, therapist.id, student.id]);

    // The lesson the child is missing is typed in through the editor, not imported.
    const typed = await put({ ordinal: 2, class: CLASS_A, subject: 'мат.', teacher: T1 });
    checkEq('the lesson is written through the editor', typed.status, 200);

    const crossing = await call('GET', `/api/teaching/crossing?year=${encodeURIComponent(DST_YEAR)}&day=${encodeURIComponent(DAY)}`);
    checkEq('the crossing answers', crossing.status, 200);
    const mine = (crossing.body?.cells || []).filter((c: any) => c.class === CLASS_A);
    const second = mine.find((c: any) => c.ordinal === 2);
    const firstLesson = mine.find((c: any) => c.ordinal === 1);
    check('the hand-entered lesson is in the crossing at all', !!second, JSON.stringify(mine));
    checkEq('the child taken at 08:00 is missing from the SECOND lesson', second?.awayCount, 1);
    checkEq('and not from the first', firstLesson ? firstLesson.awayCount : 0, 0);
    checkEq('for 25 minutes of it', second?.away?.[0]?.minutes, 25);
    checkEq('no session was left unplaced', (crossing.body?.unplaced || []).length, 0);

    console.log('\nan external child is not an omission, and a missing class still is');
    // Two children with no class, differing only in what the school calls them.
    // Different terms, because a therapist cannot hold two children in one:
    // (year, day, time, therapist) is unique, and that constraint is right.
    for (const [pid, name, kind, term] of [
        [`${TAG}-ext`, `${TAG} Екстерен Пробен`, 'external', '09:40-10:20'],
        [`${TAG}-gap`, `${TAG} Безкласен Пробен`, 'internal', '10:25-11:05']
    ] as [string, string, string, string][]) {
        const [st] = await q(`INSERT INTO students (public_id, name) VALUES ($1, $2) RETURNING id`, [pid, name]);
        await q(`INSERT INTO student_enrollments (student_id, school_year_id, grade, kind) VALUES ($1, $2, NULL, $3)`,
            [st.id, dst.id, kind]);
        await q(`INSERT INTO schedule_slots (school_year_id, day, day_order, time_slot, therapist_id, student_id)
                 VALUES ($1, $2, 4, $3, $4, $5)`, [dst.id, DAY, term, therapist.id, st.id]);
    }
    const crossed2 = await call('GET', `/api/teaching/crossing?year=${encodeURIComponent(DST_YEAR)}&day=${encodeURIComponent(DAY)}`);
    const ext = crossed2.body?.external || [];
    const gaps = crossed2.body?.unplaced || [];
    checkEq('the external child is listed apart', ext.map((r: any) => r.reasonCode), ['external']);
    check('and it is the external one', String(ext[0]?.student).includes('Екстерен'), JSON.stringify(ext));
    // The point of the split: this one is still work for a person.
    checkEq('the internal child with no class is still an omission', gaps.map((r: any) => r.reasonCode), ['no-class']);
    check('and it is the other one', String(gaps[0]?.student).includes('Безкласен'), JSON.stringify(gaps));
    checkEq('the summary counts them separately', crossed2.body?.summary?.external, 1);
    checkEq('and `placed` counts neither of them as placed',
        crossed2.body?.summary?.placed,
        crossed2.body?.summary?.sessions - crossed2.body?.summary?.unplaced - crossed2.body?.summary?.external);

    await cleanup();
    await pool.end();
    console.log(failures ? `\n${failures} failed` : '\nall good');
    process.exit(failures ? 1 : 0);
};

run().catch(async (err) => {
    console.error(err);
    await cleanup().catch(() => {});
    await pool.end().catch(() => {});
    process.exit(1);
});

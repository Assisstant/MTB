import pg from 'pg';
import 'dotenv/config';

/**
 * Категории на стручни лица and the action-plan catalogue, against a real
 * database.
 *
 * Same two cautions as `evidence.e2e.ts`. It works in school years of its own
 * so it can never read the real school, and it never touches the seeded
 * categories or the eleven prescribed sections beyond reading them —
 * everything it renames, retires and switches lives in rows it created itself.
 *
 * Every guard was written to FAIL first. Move `category_id` from
 * `therapist_years` onto `therapists` and the annual assertions break; drop the
 * class match and the teacher derivation breaks; drop the delete-on-agreement
 * branch and the deviation assertions break; drop `expected` on rename and one
 * more breaks.
 */

const BASE = process.env.API || 'http://127.0.0.1:3000';
const DB = process.env.DATABASE_URL;
if (!DB) throw new Error('DATABASE_URL is required; configure it in server/.env.');

const TAG = 'category-test';
/**
 * `createCategory` slugs a code to [a-z0-9_], so a hyphen comes back as an
 * underscore. The suite creates rows BOTH ways — directly in SQL, which keeps
 * the hyphen, and through the API, which does not — so every pattern it
 * cleans up with has to cover both alphabets.
 */
const CODE = TAG.replace(/-/g, '_');
const YEAR = '1911/1912-category';
const YEAR2 = '1912/1913-category';
const CLASS = 'IX-тест';
const PIN = '5813';
const pool = new pg.Pool({ connectionString: DB });

let fails = 0;
const check = (label: string, condition: boolean, detail = '') => {
    if (condition) console.log(`  ok   ${label}`);
    else { fails++; console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`); }
};
const same = (label: string, actual: unknown, expected: unknown) =>
    check(label, JSON.stringify(actual) === JSON.stringify(expected),
        `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
const q = async (text: string, args: unknown[] = []) => (await pool.query(text, args)).rows;

let token = '';
const api = async (method: string, path: string, body?: unknown, withToken = true) => {
    const headers: Record<string, string> = {};
    if (withToken && token) headers['X-MTB-Evidence-Token'] = token;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(BASE + path, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body)
    });
    let payload: any = null;
    try { payload = await res.json(); } catch { /* 204 or non-JSON */ }
    return { status: res.status, body: payload };
};

/** Anything global the suite created; a suite that asserts FIRST-ness must clean up. */
async function cleanup() {
    await q('DELETE FROM school_years WHERE label LIKE $1', [`%${TAG}`]);
    await q('DELETE FROM school_years WHERE label IN ($1, $2)', [YEAR, YEAR2]);
    await q('DELETE FROM students WHERE public_id LIKE $1', [TAG + '%']);
    await q('DELETE FROM evidence_sections WHERE code LIKE $1', [TAG + '%']);
    await q('DELETE FROM therapists WHERE name LIKE $1', [TAG + '%']);
    // Deleting the teacher cascades their login and any session with it.
    await q('DELETE FROM teachers WHERE name LIKE $1', [TAG + '%']);
    await q('DELETE FROM school_classes WHERE label = $1', [CLASS]);
    // The underscore is a LIKE wildcard, so the second pattern escapes it —
    // otherwise it would also match the hyphen form and read as one rule.
    await q(`DELETE FROM specialist_categories
              WHERE code LIKE $1 OR code LIKE $2 ESCAPE '!'`, [TAG + '%', CODE.replace(/_/g, '!_') + '%']);
}

async function seed() {
    await cleanup();
    const [year] = await q(
        `INSERT INTO school_years (label, starts_on, ends_on, is_current)
         VALUES ($1, '1911-09-01', '1912-08-31', false) RETURNING id`, [YEAR]);
    const [year2] = await q(
        `INSERT INTO school_years (label, starts_on, ends_on, is_current)
         VALUES ($1, '1912-09-01', '1913-08-31', false) RETURNING id`, [YEAR2]);
    const [attending] = await q(
        `INSERT INTO students (public_id, name, grade) VALUES ($1, $2, $3) RETURNING id`,
        [TAG, `${TAG} Пробен Ученик`, CLASS]);
    const [absent] = await q(
        `INSERT INTO students (public_id, name, grade) VALUES ($1, $2, 'III-т') RETURNING id`,
        [TAG + '-2', `${TAG} Втор Ученик`]);
    const [therapist] = await q(
        `INSERT INTO therapists (name) VALUES ($1) RETURNING id`, [`${TAG} therapist`]);
    const [teacher] = await q(
        `INSERT INTO teachers (name, kind) VALUES ($1, 'odd') RETURNING id`, [`${TAG} teacher`]);
    const [klass] = await q(
        `INSERT INTO school_classes (label, sort_key) VALUES ($1, 'zz') RETURNING id`, [CLASS]);

    await q(`INSERT INTO student_enrollments (student_id, school_year_id, grade, kind, active)
             VALUES ($1, $2, $3, 'internal', true)`, [attending.id, year.id, CLASS]);
    await q(`INSERT INTO student_enrollments (student_id, school_year_id, grade, kind, active)
             VALUES ($1, $2, 'III-т', 'internal', true)`, [absent.id, year.id]);
    for (const y of [year, year2]) {
        await q(`INSERT INTO therapist_years (school_year_id, therapist_id, active)
                 VALUES ($1, $2, true)`, [y.id, therapist.id]);
        await q(`INSERT INTO teacher_years (school_year_id, teacher_id, active)
                 VALUES ($1, $2, true)`, [y.id, teacher.id]);
    }
    await q(`INSERT INTO therapist_students (school_year_id, therapist_id, student_id)
             VALUES ($1, $2, $3)`, [year.id, therapist.id, attending.id]);
    // A catalogue edit has no sheet behind it, so ownership is judged against
    // the CURRENT year. The fixture therapist joins it — their own row only,
    // and `DELETE FROM therapists` in cleanup cascades it away. The school's
    // own lists are never touched.
    const [current] = await q('SELECT id FROM school_years WHERE is_current LIMIT 1');
    if (current) {
        await q(`INSERT INTO therapist_years (school_year_id, therapist_id, active)
                 VALUES ($1, $2, true) ON CONFLICT DO NOTHING`, [current.id, therapist.id]);
    }
    await q(`INSERT INTO teacher_classes (school_year_id, teacher_id, class_id, role)
             VALUES ($1, $2, $3, 'homeroom')`, [year.id, teacher.id, klass.id]);

    const [catA] = await q(
        `INSERT INTO specialist_categories (code, name, ord) VALUES ($1, $2, 900) RETURNING id`,
        [TAG + '-a', `${TAG} Категорија А`]);
    const [catB] = await q(
        `INSERT INTO specialist_categories (code, name, ord) VALUES ($1, $2, 901) RETURNING id`,
        [TAG + '-b', `${TAG} Категорија Б`]);
    const [catT] = await q(
        `INSERT INTO specialist_categories (code, name, ord) VALUES ($1, $2, 902) RETURNING id`,
        [TAG + '-t', `${TAG} Категорија Н`]);
    const mk = async (code: string, title: string, ord: number, catId: number) => (await q(
        `INSERT INTO evidence_sections (code, title, ord, scale, catalog, category_id)
         VALUES ($1, $2, $3, 'level', 'action', $4) RETURNING id`, [code, title, ord, catId]))[0];
    const secA = await mk(TAG + '-sec-a', `${TAG} Цели · А`, 900, catA.id);
    const secB = await mk(TAG + '-sec-b', `${TAG} Цели · Б`, 901, catB.id);
    const secT = await mk(TAG + '-sec-t', `${TAG} Цели · Н`, 902, catT.id);
    return { year, year2, current, attending, absent, therapist, teacher, klass, catA, catB, catT, secA, secB, secT };
}

async function run() {
    const f = await seed();
    console.log(`категории и акциски план — ${YEAR}\n`);

    // Fail fast and say what to do. A server started before these routes
    // existed answers 404 to everything here, and twenty confusing failures
    // are worse than one clear one.
    const alive = await api('GET', '/api/categories', undefined, false);
    if (alive.status === 404) {
        console.log('  FAIL /api/categories answers 404.\n'
            + '       The running server predates these routes. Restart it:\n'
            + '         powershell -ExecutionPolicy Bypass -File scripts\\server-control.ps1 restart\n'
            + '       (or stop and re-run `npm run dev`), then run this suite again.');
        await cleanup();
        await pool.end();
        process.exit(1);
    }

    console.log('schema guards');
    let threw = '';
    try {
        await q(`INSERT INTO evidence_sections (code, title, ord, scale, catalog)
                 VALUES ($1, 'x', 990, 'level', 'action')`, [TAG + '-bad-1']);
    } catch (err: any) { threw = err.constraint || err.message; }
    check('an action section without a category is refused', /category_ck/.test(threw), threw);
    threw = '';
    try {
        await q(`INSERT INTO evidence_sections (code, title, ord, scale, catalog, category_id)
                 VALUES ($1, 'x', 991, 'level', 'prescribed', $2)`, [TAG + '-bad-2', f.catA.id]);
    } catch (err: any) { threw = err.constraint || err.message; }
    check('a prescribed section WITH a category is refused', /category_ck/.test(threw), threw);

    console.log('\nthe catalogue is data, not code');
    let r = await api('POST', '/api/categories',
        { code: TAG + '-new', name: `${TAG} Нова`, ord: 903 }, false);
    check('a category can be added', r.status === 200 && !!r.body?.category?.id,
        JSON.stringify(r.body));
    // The rule, asserted rather than assumed: a code is a stable ASCII key, so
    // anything outside [a-z0-9_] becomes an underscore. Typed with hyphens by
    // a person, stored in one canonical shape.
    same('and its code is slugged to one canonical shape',
        r.body?.category?.code, CODE + '_new');
    const made = r.body?.category;
    // One failed assertion must not abort the run. Everything below needs the
    // category that POST was supposed to return; without it the suite would
    // throw on `made.id` and hide every later failure behind the first one.
    if (!made?.id) {
        fails++;
        console.log('  SKIP the rest of the catalogue block — POST returned no category.\n'
            + '       A 404 here means the running server predates these routes: restart it.');
    } else {
        r = await api('POST', '/api/categories', { code: CODE + '_new', name: 'пак' }, false);
        same('a duplicate code is refused', r.status, 409);
        r = await api('PATCH', '/api/categories',
            { id: made.id, name: `${TAG} Преименувана`, expected: `${TAG} Нова` }, false);
        same('it can be renamed', r.body?.category?.name, `${TAG} Преименувана`);
        r = await api('PATCH', '/api/categories',
            { id: made.id, name: 'нешто', expected: `${TAG} Нова` }, false);
        same('a stale expected name is refused and says what is there',
            [r.status, r.body?.actual], [409, `${TAG} Преименувана`]);

        // Hold a shared row lock so both requests observe the same starting
        // point. The expected value belongs in the UPDATE predicate itself:
        // after release, one rename wins and the other must report it.
        const renameLock = await pool.connect();
        let renameAttempts: Promise<any>[] = [];
        try {
            await renameLock.query('BEGIN');
            await renameLock.query(
                'SELECT id FROM specialist_categories WHERE id = $1 FOR SHARE', [made.id]);
            let settled = 0;
            renameAttempts = [
                api('PATCH', '/api/categories', {
                    id: made.id, name: `${TAG} Истовремена А`, expected: `${TAG} Преименувана`
                }, false),
                api('PATCH', '/api/categories', {
                    id: made.id, name: `${TAG} Истовремена Б`, expected: `${TAG} Преименувана`
                }, false)
            ].map((attempt) => attempt.finally(() => { settled++; }));
            await new Promise((resolve) => setTimeout(resolve, 150));
            same('both same-expected category renames reach the locked row', settled, 0);
            await renameLock.query('COMMIT');
        } catch (err) {
            await renameLock.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            renameLock.release();
        }
        const renamed = await Promise.all(renameAttempts);
        same('two same-expected category renames produce one save and one conflict',
            renamed.map((x) => x.status).sort(), [200, 409]);
        const [categoryAfterRace] = await q(
            'SELECT name FROM specialist_categories WHERE id = $1', [made.id]);
        same('the losing category rename reports the value that won',
            renamed.filter((x) => x.status === 409).map((x) => x.body?.actual),
            [categoryAfterRace.name]);
        r = await api('PUT', '/api/categories/active', { id: made.id, active: false }, false);
        same('it retires instead of being deleted', r.body?.category?.active, false);
        r = await api('GET', '/api/categories', undefined, false);
        check('a retired category is out of the default list',
            !(r.body?.categories ?? []).some((c: any) => c.id === made.id));
        r = await api('GET', '/api/categories?all=1', undefined, false);
        check('but still readable when asked for',
            (r.body?.categories ?? []).some((c: any) => c.id === made.id));
    }

    console.log('\nboth kinds of person hold one, and it is annual');
    r = await api('PUT', '/api/categories/holder',
        { year: YEAR, kind: 'therapist', personId: f.therapist.id, categoryId: f.catA.id }, false);
    check('a therapist holds a category', r.status === 200, JSON.stringify(r.body));
    r = await api('PUT', '/api/categories/holder',
        { year: YEAR, kind: 'teacher', personId: f.teacher.id, categoryId: f.catT.id }, false);
    check('a teacher holds one too', r.status === 200, JSON.stringify(r.body));
    r = await api('PUT', '/api/categories/holder',
        { year: YEAR2, kind: 'therapist', personId: f.therapist.id, categoryId: f.catB.id }, false);
    check('the same person can hold a different one next year', r.status === 200);

    r = await api('GET', `/api/categories/holders?year=${encodeURIComponent(YEAR)}`, undefined, false);
    same('the first year reports the first category',
        (r.body?.therapists ?? []).find((t: any) => t.personId === f.therapist.id)?.categoryId, f.catA.id);
    same('and the teacher is in the same answer',
        (r.body?.teachers ?? []).find((t: any) => t.personId === f.teacher.id)?.categoryId, f.catT.id);
    r = await api('GET', `/api/categories/holders?year=${encodeURIComponent(YEAR2)}`, undefined, false);
    same('the second year reports the second', (r.body?.therapists ?? [])
        .find((t: any) => t.personId === f.therapist.id)?.categoryId, f.catB.id);

    const [orphan] = await q(
        `INSERT INTO school_years (label, starts_on, ends_on, is_current)
         VALUES ($1, '1913-09-01', '1914-08-31', false) RETURNING id`, [`orphan-${TAG}`]);
    r = await api('PUT', '/api/categories/holder',
        { year: `orphan-${TAG}`, kind: 'therapist', personId: f.therapist.id, categoryId: f.catA.id }, false);
    same('somebody not on that year is refused, not silently added',
        [r.status, r.body?.notOnYear], [409, true]);
    await q('DELETE FROM school_years WHERE id = $1', [orphan.id]);

    console.log('\nwhich categories apply to a pupil');
    r = await api('GET',
        `/api/categories/pupil?year=${encodeURIComponent(YEAR)}&student=${TAG}`, undefined, false);
    const ids = (r.body?.categories ?? []).map((c: any) => c.id).sort((a: number, b: number) => a - b);
    same('the caseload brings the therapist\'s, the class brings the teacher\'s',
        ids, [f.catA.id, f.catT.id].sort((a, b) => a - b));
    same('and the team names the therapist with the category as occupation',
        (r.body?.therapists ?? []).map((t: any) => [t.name, t.profession]),
        [[`${TAG} therapist`, `${TAG} Категорија А`]]);
    same('and the full pupil team includes the class teacher too',
        (r.body?.team ?? []).map((person: any) => [person.kind, person.name, person.profession]),
        [
            ['therapist', `${TAG} therapist`, `${TAG} Категорија А`],
            ['teacher', `${TAG} teacher`, `${TAG} Категорија Н`]
        ]);

    r = await api('GET',
        `/api/categories/pupil?year=${encodeURIComponent(YEAR)}&student=${TAG}-2`, undefined, false);
    same('a pupil on no caseload and in no held class gets none', r.body?.categories, []);

    await q('UPDATE teacher_years SET active = false WHERE school_year_id = $1 AND teacher_id = $2',
        [f.year.id, f.teacher.id]);
    r = await api('GET',
        `/api/categories/pupil?year=${encodeURIComponent(YEAR)}&student=${TAG}`, undefined, false);
    same('a teacher taken off the year stops counting',
        (r.body?.categories ?? []).map((c: any) => c.id), [f.catA.id]);
    await q('UPDATE teacher_years SET active = true WHERE school_year_id = $1 AND teacher_id = $2',
        [f.year.id, f.teacher.id]);

    console.log('\nwhat a sheet carries');
    const [sheet] = await q(
        `INSERT INTO evidence_sheets (student_id, school_year_id) VALUES ($1, $2) RETURNING id`,
        [f.attending.id, f.year.id]);
    r = await api('GET', `/api/evidence/sheet-sections?sheet=${sheet.id}`, undefined, false);
    const secs: any[] = r.body?.sections ?? [];
    const byId = (id: number) => secs.find((s) => s.sectionId === id);
    check('every prescribed section is in',
        secs.filter((s) => s.catalog === 'prescribed').every((s) => s.included && s.source === 'derived'));
    same('the therapist\'s section is in', byId(f.secA.id)?.included, true);
    same('the teacher\'s section is in too', byId(f.secT.id)?.included, true);
    same('a category nobody holds for this pupil stays out', byId(f.secB.id)?.included, false);

    console.log('\nmanual deviation');
    await api('POST', '/api/evidence/pin', { therapistId: f.therapist.id, pin: PIN }, false);
    const login = await api('POST', '/api/evidence/login',
        { therapistId: f.therapist.id, pin: PIN }, false);
    token = login.body?.token ?? '';
    check('signed in for the write', token.length > 0, JSON.stringify(login.body));

    r = await api('PUT', '/api/evidence/sheet-section',
        { sheetId: sheet.id, sectionId: f.secB.id, included: true });
    same('a section can be switched on by hand', [r.status, r.body?.source], [200, 'manual']);
    same('only the deviation is stored', (await q(
        'SELECT included FROM evidence_sheet_sections WHERE sheet_id = $1', [sheet.id])).length, 1);
    r = await api('PUT', '/api/evidence/sheet-section',
        { sheetId: sheet.id, sectionId: f.secB.id, included: false });
    same('agreeing again returns to derived', r.body?.source, 'derived');
    same('and the row is removed rather than stored as agreement', (await q(
        'SELECT included FROM evidence_sheet_sections WHERE sheet_id = $1', [sheet.id])).length, 0);
    r = await api('PUT', '/api/evidence/sheet-section',
        { sheetId: sheet.id, sectionId: secs.find((s) => s.catalog === 'prescribed')!.sectionId,
          included: false });
    same('a prescribed section cannot be switched off', [r.status, r.body?.prescribed], [409, true]);
    r = await api('PUT', '/api/evidence/sheet-section',
        { sheetId: sheet.id, sectionId: f.secA.id, included: false }, false);
    check('an unsigned override is refused', r.status === 401 || r.status === 403,
        JSON.stringify([r.status, r.body]));

    console.log('\nwho may change a section');
    if (!f.current) {
        console.log('  SKIP no current school year in this database.');
    } else {
        await q('UPDATE therapist_years SET category_id = $3 WHERE school_year_id = $1 AND therapist_id = $2',
            [f.current.id, f.therapist.id, f.catA.id]);

        r = await api('POST', '/api/evidence/section', {
            title: `${TAG} без категорија`, catalog: 'action'
        });
        same('an action section must name its category',
            [r.status, r.body?.needsCategory], [400, true]);

        r = await api('POST', '/api/evidence/section', {
            title: `${TAG} погрешен образец`, catalog: 'prescribed', categoryId: f.catA.id
        });
        same('a prescribed section cannot accidentally carry a category',
            [r.status, r.body?.prescribed], [400, true]);

        r = await api('POST', '/api/evidence/section', {
            title: `${TAG} туѓа нова секција`, catalog: 'action', categoryId: f.catB.id
        });
        same('a non-holder cannot create a section for somebody else\'s category',
            [r.status, r.body?.notHolder], [403, true]);

        r = await api('POST', '/api/evidence/section', {
            title: `${TAG} Нова акциска секција`, catalog: 'action',
            categoryId: f.catA.id, scale: 'level'
        });
        check('the holder can create the first section for their category',
            r.status === 200 && r.body?.section?.catalog === 'action'
                && r.body?.section?.category_id === f.catA.id,
            JSON.stringify(r.body));
        const madeSection = r.body?.section;
        if (madeSection?.id) {
            r = await api('PATCH', `/api/evidence/section/${madeSection.id}`, {
                scale: 'mark', expected: `${TAG} Нова акциска секција`
            });
            same('its scale can be corrected before marks exist',
                [r.status, r.body?.section?.scale], [200, 'mark']);

            r = await api('POST', '/api/evidence/item', {
                sectionId: madeSection.id, label: `${TAG} акциска цел`
            });
            const madeItem = r.body?.item;
            check('the new action section accepts its first goal',
                r.status === 200 && !!madeItem?.id, JSON.stringify(r.body));

            await api('GET', `/api/evidence/sheets?year=${encodeURIComponent(YEAR)}`);
            const [madePeriod] = await q(
                'SELECT id FROM evidence_periods WHERE school_year_id = $1 AND active ORDER BY ord LIMIT 1',
                [f.year.id]);
            if (madeItem?.id && madePeriod) {
                r = await api('PUT', '/api/evidence/score', {
                    sheetId: sheet.id, itemId: madeItem.id, periodId: madePeriod.id,
                    value: '√', expected: ''
                });
                same('an included action goal can be assessed', r.status, 200);

                r = await api('PATCH', `/api/evidence/section/${madeSection.id}`, { scale: 'level' });
                same('a scale carrying marks is locked instead of reinterpreting history',
                    [r.status, r.body?.scaleLocked], [409, true]);

                await api('PUT', '/api/evidence/sheet-section', {
                    sheetId: sheet.id, sectionId: madeSection.id, included: false
                });
                r = await api('PUT', '/api/evidence/score', {
                    sheetId: sheet.id, itemId: madeItem.id, periodId: madePeriod.id,
                    value: 'X', expected: '√'
                });
                same('an excluded action section cannot still be assessed',
                    [r.status, r.body?.notIncluded], [409, true]);
                await api('PUT', '/api/evidence/sheet-section', {
                    sheetId: sheet.id, sectionId: madeSection.id, included: true
                });
            }
        }

        r = await api('POST', '/api/evidence/item',
            { sectionId: f.secA.id, label: `${TAG} моја ставка` });
        check('the holder can add an item to their own section', r.status === 200,
            JSON.stringify(r.body));
        const mine = r.body?.item?.id;

        r = await api('POST', '/api/evidence/item',
            { sectionId: f.secB.id, label: `${TAG} туѓа ставка` });
        same('somebody else\'s section is refused, and says whose it is',
            [r.status, r.body?.notHolder], [403, true]);

        // THE CONTROL. Without it the guard tests prove nothing: they would
        // also pass if the endpoint simply refused everybody.
        const prescribed = secs.find((x) => x.catalog === 'prescribed')!.sectionId;
        r = await api('POST', '/api/evidence/item',
            { sectionId: prescribed, label: `${TAG} пропишана ставка` });
        check('the prescribed form is NOT restricted — it is everybody\'s',
            r.status === 200, JSON.stringify(r.body));
        if (r.body?.item?.id) {
            await q('DELETE FROM evidence_items WHERE id = $1', [r.body.item.id]);
        }

        if (mine) {
            r = await api('PATCH', `/api/evidence/item/${mine}`, { label: `${TAG} преименувана` });
            same('renaming a line in your own section is allowed', r.status, 200);
            await q('DELETE FROM evidence_items WHERE id = $1', [mine]);
        }

        // A teacher signs in and writes in their OWN section (migration 025).
        await q(`INSERT INTO teacher_years (school_year_id, teacher_id, active, category_id)
                 VALUES ($1, $2, true, $3) ON CONFLICT (school_year_id, teacher_id)
                 DO UPDATE SET category_id = EXCLUDED.category_id, active = true`,
            [f.current.id, f.teacher.id, f.catT.id]);

        r = await api('GET', '/api/evidence/people', undefined, false);
        check('the picker offers teachers as well as therapists',
            (r.body?.people ?? []).some((p: any) => p.kind === 'teacher' && p.id === f.teacher.id),
            JSON.stringify((r.body?.people ?? []).length));

        const therapistToken = token;
        await api('POST', '/api/evidence/pin',
            { kind: 'teacher', personId: f.teacher.id, pin: PIN }, false);
        const tLogin = await api('POST', '/api/evidence/login',
            { kind: 'teacher', personId: f.teacher.id, pin: PIN }, false);
        check('a teacher can sign in', typeof tLogin.body?.token === 'string',
            JSON.stringify(tLogin.body));
        same('and the session says which kind of person it is',
            tLogin.body?.person?.kind, 'teacher');
        token = tLogin.body?.token ?? '';

        r = await api('GET', '/api/evidence/me');
        same('/me agrees', [r.body?.person?.kind, r.body?.person?.id], ['teacher', f.teacher.id]);

        r = await api('POST', '/api/evidence/item',
            { sectionId: f.secT.id, label: `${TAG} наставничка ставка` });
        check('the teacher can write in their own section', r.status === 200,
            JSON.stringify(r.body));
        if (r.body?.item?.id) await q('DELETE FROM evidence_items WHERE id = $1', [r.body.item.id]);

        r = await api('POST', '/api/evidence/item',
            { sectionId: f.secA.id, label: `${TAG} туѓа` });
        same('but not in the therapist\'s', [r.status, r.body?.notHolder], [403, true]);

        // Two people of different kinds can share an id, so a picker keyed on
        // the bare number would sign the wrong person in.
        r = await api('POST', '/api/evidence/login',
            { therapistId: f.therapist.id, pin: PIN }, false);
        same('the old therapistId spelling still works', r.status, 200);
        token = therapistToken;

        // A mark is the same permission, judged against the SHEET's year.
        const [otherItem] = await q(
            `INSERT INTO evidence_items (section_id, group_id, label, ord)
             VALUES ($1, NULL, $2, 0) RETURNING id`, [f.secB.id, `${TAG} туѓа`]);
        const [period] = await q(
            'SELECT id FROM evidence_periods WHERE school_year_id = $1 ORDER BY ord LIMIT 1', [f.year.id]);
        if (period) {
            r = await api('PUT', '/api/evidence/score',
                { sheetId: sheet.id, itemId: otherItem.id, periodId: period.id, value: '2' });
            same('and a mark in somebody else\'s section is refused too',
                [r.status, r.body?.notHolder], [403, true]);
        }
        await q('DELETE FROM evidence_items WHERE id = $1', [otherItem.id]);
    }

    await cleanup();
    console.log(`\n${fails ? `${fails} FAILED` : 'сите проверки поминаа'}`);
    await pool.end();
    process.exit(fails ? 1 : 0);
}

run().catch(async (err) => {
    console.error(err);
    await cleanup().catch(() => {});
    await pool.end().catch(() => {});
    process.exit(1);
});

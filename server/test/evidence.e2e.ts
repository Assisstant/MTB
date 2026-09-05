import pg from 'pg';
import 'dotenv/config';

/**
 * Евидентен лист, against a real database.
 *
 * TWO THINGS THIS SUITE IS CAREFUL ABOUT, both learned here the hard way.
 *
 * It works in a school year of its own, created at the start and dropped at
 * the end -- `teaching.e2e.ts` used to write its fixture into the CURRENT year,
 * where the real school already sat, and every later assertion then read the
 * real data.
 *
 * And the CATALOGUE is global rather than year-scoped, so this suite never
 * touches the eleven seeded sections beyond reading them. Everything it adds,
 * renames and deletes happens inside a section it created itself. A test that
 * hides „IV. ГОВОРНО - ЈАЗИЧНО ПОДРАЧЈЕ" from the real staff to prove a point
 * about deactivation would pass and would be a bug.
 */

const BASE = process.env.API || 'http://127.0.0.1:3000';
const DB = process.env.DATABASE_URL;
if (!DB) throw new Error('DATABASE_URL is required; configure it in server/.env.');

const TAG = 'evidence-test';
const YEAR = '1901/1902-evidence';
const OTHER_YEAR = '1902/1903-evidence';
const PIN = '4711';
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

/** A second signed-in browser uses its own session token. */
const apiWithToken = async (tokenValue: string, method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = { 'X-MTB-Evidence-Token': tokenValue };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(BASE + path, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body)
    });
    let payload: any = null;
    try { payload = await res.json(); } catch { /* non-JSON failure */ }
    return { status: res.status, body: payload };
};

/**
 * Put a delete behind the same row lock a score writer holds, write the score,
 * and then release it. A safe delete recounts after it acquires its lock; the
 * old check-then-delete implementation counted zero, waited only at DELETE,
 * and cascaded the newly committed mark away.
 */
async function raceDeleteAfterScore(options: {
    deletePath: string;
    locks: Array<{ sql: string; args: unknown[] }>;
    sheetId: number;
    itemId: number;
    periodId: number;
}) {
    const client = await pool.connect();
    let committed = false;
    try {
        await client.query('BEGIN');
        for (const held of options.locks) await client.query(held.sql, held.args);
        let settled = false;
        const deleting = api('DELETE', options.deletePath).finally(() => { settled = true; });
        await new Promise((resolve) => setTimeout(resolve, 150));
        const waited = !settled;
        await client.query(
            `INSERT INTO evidence_scores (sheet_id, item_id, period_id, value, updated_by)
             VALUES ($1, $2, $3, '1', $4)`,
            [options.sheetId, options.itemId, options.periodId, `${TAG} concurrent writer`]);
        await client.query('COMMIT');
        committed = true;
        return { response: await deleting, waited };
    } finally {
        if (!committed) await client.query('ROLLBACK').catch(() => {});
        client.release();
    }
}

async function cleanup() {
    await q('DELETE FROM school_years WHERE label IN ($1, $2)', [YEAR, OTHER_YEAR]);
    await q('DELETE FROM students WHERE public_id IN ($1, $2)', [TAG, TAG + '-2']);
    await q('DELETE FROM therapists WHERE name = $1', [`${TAG} therapist`]);
    await q(`DELETE FROM evidence_sections WHERE title LIKE '${TAG}%'`);
}

async function seed() {
    await cleanup();
    const [year] = await q(
        `INSERT INTO school_years (label, starts_on, ends_on, is_current)
         VALUES ($1, '1901-09-01', '1902-08-31', false) RETURNING id`, [YEAR]);
    const [other] = await q(
        `INSERT INTO school_years (label, starts_on, ends_on, is_current)
         VALUES ($1, '1902-09-01', '1903-08-31', false) RETURNING id`, [OTHER_YEAR]);
    const [student] = await q(
        `INSERT INTO students (public_id, name, grade) VALUES ($1, $2, 'IV-т') RETURNING id`,
        [TAG, `${TAG} Пробен Ученик`]);
    const [second] = await q(
        `INSERT INTO students (public_id, name, grade) VALUES ($1, $2, 'IV-т') RETURNING id`,
        [TAG + '-2', `${TAG} Втор Ученик`]);
    const [therapist] = await q(
        `INSERT INTO therapists (name) VALUES ($1) RETURNING id`, [`${TAG} therapist`]);
    for (const s of [student, second]) {
        await q(
            `INSERT INTO student_enrollments (student_id, school_year_id, grade, kind, active)
             VALUES ($1, $2, 'IV-т', 'internal', true)`, [s.id, year.id]);
    }
    await q('INSERT INTO therapist_years (school_year_id, therapist_id, active) VALUES ($1, $2, true)',
        [year.id, therapist.id]);
    return { year, other, student, second, therapist };
}

async function run() {
    const fixture = await seed();
    console.log(`евидентен лист — ${YEAR}\n`);

    // ── signing in ───────────────────────────────────────────────────────────
    console.log('signing in');
    let result = await api('GET', '/api/evidence/catalog', undefined, false);
    same('an unsigned read is refused', [result.status, result.body.signedOut], [401, true]);

    result = await api('POST', '/api/evidence/login', { therapistId: fixture.therapist.id, pin: PIN }, false);
    same('a name with no PIN is told to set one', [result.status, result.body.needsPin], [409, true]);

    result = await api('POST', '/api/evidence/pin', { therapistId: fixture.therapist.id, pin: PIN }, false);
    check('the first PIN is accepted', result.status === 200 && result.body.created === true,
        JSON.stringify(result.body));

    result = await api('POST', '/api/evidence/pin', { therapistId: fixture.therapist.id, pin: '9999' }, false);
    same('a second PIN without the first is refused', [result.status, result.body.needsCurrentPin], [403, true]);

    result = await api('POST', '/api/evidence/login', { therapistId: fixture.therapist.id, pin: 'word' }, false);
    check('a non-numeric PIN is refused before password hashing',
        result.status === 400 && result.body.invalidPin === true, JSON.stringify(result.body));

    result = await api('POST', '/api/evidence/login', { therapistId: fixture.therapist.id, pin: '0000' }, false);
    check('a wrong PIN answers 401', result.status === 401, JSON.stringify(result.body));

    result = await api('POST', '/api/evidence/login', { therapistId: fixture.therapist.id, pin: PIN }, false);
    check('the right PIN answers a token', result.status === 200 && typeof result.body.token === 'string',
        JSON.stringify(result.body));
    token = result.body.token;

    const [stored] = await q('SELECT pin_hash, pin_salt FROM evidence_logins WHERE therapist_id = $1',
        [fixture.therapist.id]);
    check('the PIN itself is not stored', stored.pin_hash !== PIN && stored.pin_salt.length >= 16);

    result = await api('GET', '/api/evidence/me');
    same('the session names the therapist', result.body.therapist.name, `${TAG} therapist`);

    // ── the catalogue and the year's columns ─────────────────────────────────
    console.log('\nthe catalogue and the year');
    result = await api('GET', `/api/evidence/catalog?year=${encodeURIComponent(YEAR)}`);
    const catalog = result.body;
    check('the eleven prescribed sections are seeded', catalog.sections.length >= 11,
        `got ${catalog.sections.length}`);
    const totalItems = catalog.sections.reduce((n: number, s: any) => n + s.items.length, 0);
    check('the whole form is present, item by item', totalItems >= 112, `got ${totalItems}`);
    same('a new year starts with four columns', catalog.periods.map((p: any) => p.ord), [1, 2, 3, 4]);
    const psych = catalog.sections.find((s: any) => s.code === 's7');
    same('the psychological section is a check scale, not an average', [psych.scale, psych.summary],
        ['mark', false]);
    check('its groups came across', psych.groups.length === 6, `got ${psych.groups.length}`);
    const secondaryOnly = catalog.sections.find((s: any) => s.code === 's11');
    check('the practical-teaching section is marked secondary-only', secondaryOnly.only_secondary === true);

    // Everything below edits the catalogue, so it edits a section of its own.
    result = await api('POST', '/api/evidence/section', { title: `${TAG} секција`, scale: 'level' });
    const section = result.body.section;
    check('a section can be added', result.status === 200 && section.id > 0, JSON.stringify(result.body));

    result = await api('POST', '/api/evidence/item', { sectionId: section.id, label: `${TAG} ставка А` });
    const itemA = result.body.item;
    result = await api('POST', '/api/evidence/item', { sectionId: section.id, label: `${TAG} ставка Б` });
    const itemB = result.body.item;
    same('items are numbered from zero, as the old score keys were',
        [itemA.ord, itemB.ord], [0, 1]);

    // ── one sheet ────────────────────────────────────────────────────────────
    console.log('\none sheet');
    result = await api('GET', `/api/evidence/sheets?year=${encodeURIComponent(YEAR)}`);
    same('both pupils are listed before either has a sheet',
        result.body.pupils.map((p: any) => [p.public_id, p.sheet_id]).sort(),
        [[TAG, null], [TAG + '-2', null]].sort());

    result = await api('POST', '/api/evidence/sheet', { publicId: TAG, year: YEAR });
    check('a sheet is created', result.status === 200 && result.body.sheetId > 0, JSON.stringify(result.body));
    const sheetId = result.body.sheetId;

    result = await api('POST', '/api/evidence/sheet', { publicId: TAG, year: YEAR });
    same('a second sheet for the same pupil and year is refused', result.status, 409);

    result = await api('GET', `/api/evidence/sheet/${sheetId}`);
    same('the class comes from the enrolment, split for the printed form',
        [result.body.grade, result.body.class_section], ['IV', 'т']);
    check('the sheet records who opened it', result.body.created_by === `${TAG} therapist`,
        result.body.created_by);

    // ── one cell ─────────────────────────────────────────────────────────────
    console.log('\none cell at a time');
    const periods = catalog.periods;
    result = await api('PUT', '/api/evidence/score',
        { sheetId, itemId: itemA.id, periodId: periods[0].id, value: '2', expected: '' });
    check('a mark is accepted', result.status === 200, JSON.stringify(result.body));

    let rows = await q(
        'SELECT value, updated_by FROM evidence_scores WHERE sheet_id = $1 AND item_id = $2',
        [sheetId, itemA.id]);
    same('the database holds it, with the author', [rows[0].value, rows[0].updated_by],
        ['2', `${TAG} therapist`]);

    result = await api('PUT', '/api/evidence/score',
        { sheetId, itemId: itemA.id, periodId: periods[0].id, value: '3', expected: '' });
    same('a stale expected value is refused and names what is really there and who wrote it',
        [result.status, result.body.actual, result.body.actualBy],
        [409, '2', `${TAG} therapist`]);
    rows = await q('SELECT value FROM evidence_scores WHERE sheet_id = $1 AND item_id = $2',
        [sheetId, itemA.id]);
    same('and the refused write changed nothing', rows[0].value, '2');

    result = await api('PUT', '/api/evidence/score',
        { sheetId, itemId: itemA.id, periodId: periods[0].id, value: '7', expected: '2' });
    same('a value outside the scale is refused', result.status, 400);

    // `/` — не се однесува на ова дете. The state that was missing: without it a
    // goal that was never this child's could only be left blank (reads as
    // unfinished) or scored 1 (reads as failing something nobody asked of them),
    // and on a `level` section that 1 went into ОПШТА ПРОЦЕНКА and out into a
    // signed report. It is legal on BOTH scales -- `mark` has allowed it since
    // the beginning and only the interface never offered it.
    result = await api('PUT', '/api/evidence/score',
        { sheetId, itemId: itemA.id, periodId: periods[0].id, value: '/', expected: '2' });
    same('a level section accepts / — does not apply to this child', result.status, 200);

    rows = await q('SELECT value, updated_by FROM evidence_scores WHERE sheet_id = $1 AND item_id = $2',
        [sheetId, itemA.id]);
    same('and it is stored', rows[0].value, '/');
    same('with the author who decided it', String(rows[0].updated_by || '').length > 0, true);

    // A decision with a name and a date on it is not an omission, so the column
    // counter must see it. The average must not: that is arithmetic over
    // achievement, and "not applicable" is not a low achievement.
    const listedWithSlash = await api('GET', '/api/evidence/sheets');
    const rowWithSlash = (listedWithSlash.body.pupils || []).find((x: any) => x.sheet_id === sheetId);
    same('a / counts as an answered cell, not an empty one',
        !rowWithSlash || Number((rowWithSlash.filled || {})[periods[0].id] || 0) >= 1, true);

    result = await api('PUT', '/api/evidence/score',
        { sheetId, itemId: itemA.id, periodId: periods[0].id, value: '2', expected: '/' });
    same('and it is an ordinary value to write over', result.status, 200);

    // A column belongs to a year: writing this year's mark into another year's
    // column would be accepted by the primary key and would quietly change an
    // archived printout.
    const [otherPeriod] = await q(
        `INSERT INTO evidence_periods (school_year_id, ord, label, short_label)
         VALUES ($1, 1, 'друга година', 'ДГ') RETURNING id`, [fixture.other.id]);
    result = await api('PUT', '/api/evidence/score',
        { sheetId, itemId: itemA.id, periodId: otherPeriod.id, value: '1' });
    same('a column from another school year is refused', result.status, 409);

    result = await api('PATCH', `/api/evidence/period/${periods[3].id}`, { active: false });
    same('a test column can be hidden', result.body?.period?.active, false);
    result = await api('PUT', '/api/evidence/score',
        { sheetId, itemId: itemA.id, periodId: periods[3].id, value: '1', expected: '' });
    same('a hidden assessment period cannot still be scored through the API',
        [result.status, result.body?.inactivePeriod], [409, true]);
    rows = await q(
        `SELECT value FROM evidence_scores
          WHERE sheet_id = $1 AND item_id = $2 AND period_id = $3`,
        [sheetId, itemA.id, periods[3].id]);
    same('the refused hidden-period write changed nothing', rows.length, 0);
    await api('PATCH', `/api/evidence/period/${periods[3].id}`, { active: true });

    result = await api('PUT', '/api/evidence/score',
        { sheetId, itemId: itemA.id, periodId: periods[0].id, value: '', expected: '2' });
    rows = await q('SELECT value FROM evidence_scores WHERE sheet_id = $1 AND item_id = $2',
        [sheetId, itemA.id]);
    same('clearing a cell removes the row rather than storing an empty one',
        [result.status, rows.length], [200, 0]);

    // An empty cell has no row for SELECT ... FOR UPDATE to lock. Hold the
    // route's key lock while two independent sessions arrive, then release
    // them together: exactly one may still believe the empty value.
    const secondLogin = await api(
        'POST', '/api/evidence/login', { therapistId: fixture.therapist.id, pin: PIN }, false);
    const secondToken = secondLogin.body?.token ?? '';
    check('a second session is ready for the empty-cell race', secondToken.length > 0,
        JSON.stringify(secondLogin.body));
    const lock = await pool.connect();
    let attempts: Promise<any>[] = [];
    try {
        await lock.query('BEGIN');
        const lockKey = `evidence-score:${sheetId}:${itemA.id}:${periods[0].id}`;
        await lock.query(
            'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [lockKey]);
        let settled = 0;
        attempts = [
            apiWithToken(token, 'PUT', '/api/evidence/score',
                { sheetId, itemId: itemA.id, periodId: periods[0].id, value: '1', expected: '' }),
            apiWithToken(secondToken, 'PUT', '/api/evidence/score',
                { sheetId, itemId: itemA.id, periodId: periods[0].id, value: '2', expected: '' })
        ].map((attempt) => attempt.finally(() => { settled++; }));
        await new Promise((resolve) => setTimeout(resolve, 150));
        same('both empty-cell writes wait behind one key', settled, 0);
        await lock.query('COMMIT');
    } catch (err) {
        await lock.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        lock.release();
    }
    const raced = await Promise.all(attempts);
    same('two writers who expected empty produce one save and one conflict',
        raced.map((r) => r.status).sort(), [200, 409]);
    const [racedRow] = await q(
        `SELECT value, updated_by FROM evidence_scores
          WHERE sheet_id = $1 AND item_id = $2 AND period_id = $3`,
        [sheetId, itemA.id, periods[0].id]);
    same('the losing response names the stored value and its author',
        raced.filter((r) => r.status === 409)
            .map((r) => [r.body?.actual, r.body?.actualBy]),
        [[racedRow.value, `${TAG} therapist`]]);
    result = await api('PUT', '/api/evidence/score', {
        sheetId, itemId: itemA.id, periodId: periods[0].id,
        value: '', expected: racedRow.value
    });
    same('the race fixture is cleared through the API', result.status, 200);

    // A score transaction already owns one client. Every permission and
    // section query must stay on that client: if it asks the shared pool for
    // another one, ten simultaneous requests occupy all ten default clients
    // and then wait forever for an eleventh. Hold the sheet lock until the
    // whole pool is queued, then release all requests together.
    const sheetLock = await pool.connect();
    let saturatedAttempts: Promise<any>[] = [];
    let waitingPids: number[] = [];
    try {
        await sheetLock.query('BEGIN');
        await sheetLock.query(
            'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
            [`evidence-sheet:${sheetId}`]);
        saturatedAttempts = Array.from({ length: 10 }, (_, index) =>
            api('PUT', '/api/evidence/score', {
                sheetId, itemId: itemB.id, periodId: periods[1].id,
                value: String(index % 3 + 1)
            }));
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
            const waiting = await q(
                `SELECT pid FROM pg_stat_activity
                  WHERE datname = current_database()
                    AND wait_event_type = 'Lock' AND wait_event = 'advisory'
                    AND query LIKE 'SELECT pg_advisory_xact_lock_shared%'`);
            waitingPids = waiting.map((entry) => entry.pid);
            if (waitingPids.length >= 10) break;
            await new Promise((resolve) => setTimeout(resolve, 40));
        }
        same('all ten score transactions occupy one server pool client before release',
            waitingPids.length, 10);
        await sheetLock.query('COMMIT');
    } catch (err) {
        await sheetLock.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        sheetLock.release();
    }
    const saturated = await Promise.race([
        Promise.all(saturatedAttempts),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000))
    ]);
    check('ten score transactions finish without borrowing an eleventh connection',
        Array.isArray(saturated) && saturated.every((attempt) => attempt.status === 200),
        saturated ? saturated.map((attempt) => attempt.status).join(', ') : 'timed out');
    if (!saturated && waitingPids.length) {
        // Let a failed regression finish and clean its invented fixtures rather
        // than leaving the test server permanently wedged after the assertion.
        await q(
            'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid = ANY($1::int[])',
            [waitingPids]);
        await Promise.allSettled(saturatedAttempts);
    }
    await q(
        'DELETE FROM evidence_scores WHERE sheet_id = $1 AND item_id = $2 AND period_id = $3',
        [sheetId, itemB.id, periods[1].id]);

    await api('PUT', '/api/evidence/score',
        { sheetId, itemId: itemA.id, periodId: periods[0].id, value: '3' });
    await api('PUT', '/api/evidence/score',
        { sheetId, itemId: itemB.id, periodId: periods[0].id, value: '3' });
    result = await api('GET', `/api/evidence/sheets?year=${encodeURIComponent(YEAR)}`);
    const mine = result.body.pupils.find((p: any) => p.public_id === TAG);
    same('the list counts filled cells per column', mine.filled[String(periods[0].ord)], 2);

    // ── the other halves of the form ─────────────────────────────────────────
    console.log('\npanels, examiners and contacts');
    result = await api('PUT', '/api/evidence/panel',
        { sheetId, panel: 'hearing', data: { enabled: true, surdologist: `${TAG} сурдолог` } });
    check('a panel is saved whole', result.status === 200, JSON.stringify(result.body));
    rows = await q(`SELECT data->>'surdologist' AS who FROM evidence_panels
                    WHERE sheet_id = $1 AND panel = 'hearing'`, [sheetId]);
    same('and the database holds it', rows[0].who, `${TAG} сурдолог`);

    const anyRole = catalog.sections.find((s: any) => s.examiners.length).examiners[0];
    result = await api('PUT', '/api/evidence/examiner',
        { sheetId, roleId: anyRole.id, name: `${TAG} испитувач` });
    check('an examiner line is saved', result.status === 200, JSON.stringify(result.body));

    result = await api('PUT', '/api/evidence/contacts', {
        sheetId,
        contacts: [{ name: `${TAG} лице`, profession: 'логопед' }, { name: '', profession: '' },
                   { name: '', phone: '070' }]
    });
    same('blank contact rows are dropped, filled ones kept in order',
        [result.status, result.body.kept], [200, 2]);
    rows = await q('SELECT ord, name FROM evidence_contacts WHERE sheet_id = $1 ORDER BY ord', [sheetId]);
    same('and they are renumbered without gaps', rows.map((r) => r.ord), [0, 1]);

    // ── the two „бришења" of the catalogue ───────────────────────────────────
    console.log('\ndeleting from the catalogue is two different requests');
    result = await api('DELETE', `/api/evidence/item/${itemB.id}`);
    same('an item that carries marks is refused, and says how many',
        [result.status, result.body.scores, result.body.deactivate], [409, 1, true]);

    result = await api('PATCH', `/api/evidence/item/${itemB.id}`, { active: false });
    same('hiding it instead works and keeps the marks',
        [result.status, result.body.item.active], [200, false]);
    rows = await q('SELECT count(*)::int AS n FROM evidence_scores WHERE item_id = $1', [itemB.id]);
    same('the marks are still there', rows[0].n, 1);

    result = await api('POST', '/api/evidence/item', { sectionId: section.id, label: `${TAG} грешка` });
    const typo = result.body.item;
    result = await api('DELETE', `/api/evidence/item/${typo.id}`);
    same('an item nobody has scored is deleted outright', result.status, 200);

    result = await api('POST', '/api/evidence/section', {
        title: `${TAG} секција со испитувач`, scale: 'level'
    });
    const examinerSection = result.body?.section;
    check('the examiner-history fixture has its own section',
        result.status === 200 && !!examinerSection?.id, JSON.stringify(result.body));
    if (examinerSection?.id) {
        const [role] = await q(
            `INSERT INTO evidence_examiner_roles (section_id, code, label, ord)
             VALUES ($1, $2, 'испитувач', 1) RETURNING id`,
            [examinerSection.id, `${TAG}-examiner-role`]);
        await q(
            `INSERT INTO evidence_examiners (sheet_id, role_id, name, updated_by)
             VALUES ($1, $2, $3, $3)`, [sheetId, role.id, `${TAG} испитувач`]);
        result = await api('DELETE', `/api/evidence/section/${examinerSection.id}`);
        same('a section with an examiner entry is hidden instead of cascading authored history',
            [result.status, result.body?.examinerHistory, result.body?.examiners,
             result.body?.deactivate], [409, true, 1, true]);
        rows = await q(
            `SELECT e.name FROM evidence_examiners e
              JOIN evidence_examiner_roles r ON r.id = e.role_id
             WHERE r.section_id = $1`, [examinerSection.id]);
        same('the refused section delete preserves the examiner entry',
            rows.map((r) => r.name), [`${TAG} испитувач`]);
    }

    console.log('\nscore-versus-delete races keep the new mark');
    result = await api('POST', '/api/evidence/item', {
        sectionId: section.id, label: `${TAG} атомска ставка`
    });
    const atomicItem = result.body?.item;
    if (atomicItem?.id) {
        const racedDelete = await raceDeleteAfterScore({
            deletePath: `/api/evidence/item/${atomicItem.id}`,
            locks: [{
                sql: 'SELECT id FROM evidence_items WHERE id = $1 FOR SHARE',
                args: [atomicItem.id]
            }],
            sheetId, itemId: atomicItem.id, periodId: periods[2].id
        });
        same('an item delete waits for the in-flight score', racedDelete.waited, true);
        same('and then refuses instead of cascading that score',
            [racedDelete.response.status, racedDelete.response.body?.scores], [409, 1]);
        rows = await q('SELECT value FROM evidence_scores WHERE item_id = $1', [atomicItem.id]);
        same('the score that beat the item delete remains', rows.map((r) => r.value), ['1']);
        await q('DELETE FROM evidence_scores WHERE item_id = $1', [atomicItem.id]);
        await api('DELETE', `/api/evidence/item/${atomicItem.id}`);
    }

    result = await api('POST', '/api/evidence/section', {
        title: `${TAG} атомска секција`, scale: 'level'
    });
    const atomicSection = result.body?.section;
    if (atomicSection?.id) {
        const made = await api('POST', '/api/evidence/item', {
            sectionId: atomicSection.id, label: `${TAG} ставка во атомска секција`
        });
        const atomicSectionItem = made.body?.item;
        if (atomicSectionItem?.id) {
            const racedDelete = await raceDeleteAfterScore({
                deletePath: `/api/evidence/section/${atomicSection.id}`,
                locks: [{
                    sql: 'SELECT id FROM evidence_sections WHERE id = $1 FOR SHARE',
                    args: [atomicSection.id]
                }],
                sheetId, itemId: atomicSectionItem.id, periodId: periods[2].id
            });
            same('a section delete waits for the in-flight score', racedDelete.waited, true);
            same('and then refuses instead of cascading that score',
                [racedDelete.response.status, racedDelete.response.body?.scores], [409, 1]);
            await q('DELETE FROM evidence_scores WHERE item_id = $1', [atomicSectionItem.id]);
            await api('DELETE', `/api/evidence/section/${atomicSection.id}`);
        }
    }

    result = await api('POST', '/api/evidence/group', {
        sectionId: section.id, label: `${TAG} атомска група`
    });
    const atomicGroup = result.body?.group;
    if (atomicGroup?.id) {
        const made = await api('POST', '/api/evidence/item', {
            sectionId: section.id, groupId: atomicGroup.id,
            label: `${TAG} ставка во атомска група`
        });
        const atomicGroupItem = made.body?.item;
        if (atomicGroupItem?.id) {
            const racedDelete = await raceDeleteAfterScore({
                deletePath: `/api/evidence/group/${atomicGroup.id}`,
                locks: [{
                    sql: 'SELECT id FROM evidence_items WHERE id = $1 FOR SHARE',
                    args: [atomicGroupItem.id]
                }],
                sheetId, itemId: atomicGroupItem.id, periodId: periods[2].id
            });
            same('a group delete waits for its in-flight item score', racedDelete.waited, true);
            same('and then refuses instead of cascading that score',
                [racedDelete.response.status, racedDelete.response.body?.scores], [409, 1]);
            await q('DELETE FROM evidence_scores WHERE item_id = $1', [atomicGroupItem.id]);
            await api('DELETE', `/api/evidence/group/${atomicGroup.id}`);
        }
    }

    result = await api('POST', '/api/evidence/period', {
        year: YEAR, label: `${TAG} атомски период`, shortLabel: 'АП'
    });
    const atomicPeriod = result.body?.period;
    const madeForPeriod = await api('POST', '/api/evidence/item', {
        sectionId: section.id, label: `${TAG} ставка за период`
    });
    const atomicPeriodItem = madeForPeriod.body?.item;
    if (atomicPeriod?.id && atomicPeriodItem?.id) {
        const racedDelete = await raceDeleteAfterScore({
            deletePath: `/api/evidence/period/${atomicPeriod.id}`,
            locks: [{
                sql: 'SELECT id FROM evidence_periods WHERE id = $1 FOR SHARE',
                args: [atomicPeriod.id]
            }],
            sheetId, itemId: atomicPeriodItem.id, periodId: atomicPeriod.id
        });
        same('a period delete waits for the in-flight score', racedDelete.waited, true);
        same('and then refuses instead of cascading that score',
            [racedDelete.response.status, racedDelete.response.body?.scores], [409, 1]);
        await q('DELETE FROM evidence_scores WHERE period_id = $1', [atomicPeriod.id]);
        await api('DELETE', `/api/evidence/period/${atomicPeriod.id}`);
        await api('DELETE', `/api/evidence/item/${atomicPeriodItem.id}`);
    }

    result = await api('POST', '/api/evidence/sheet', { publicId: TAG + '-2', year: YEAR });
    const atomicSheetId = result.body?.sheetId;
    if (atomicSheetId) {
        const racedDelete = await raceDeleteAfterScore({
            deletePath: `/api/evidence/sheet/${atomicSheetId}?expected=${encodeURIComponent(`${TAG} Втор Ученик`)}`,
            locks: [
                {
                    sql: 'SELECT pg_advisory_xact_lock_shared(hashtextextended($1::text, 0))',
                    args: [`evidence-sheet:${atomicSheetId}`]
                },
                {
                    sql: 'SELECT id FROM evidence_sheets WHERE id = $1 FOR SHARE',
                    args: [atomicSheetId]
                }
            ],
            sheetId: atomicSheetId, itemId: itemA.id, periodId: periods[2].id
        });
        same('a sheet delete waits for the in-flight score', racedDelete.waited, true);
        same('its response counts the score it deliberately removes',
            [racedDelete.response.status, racedDelete.response.body?.scoresRemoved], [200, 1]);
        rows = await q('SELECT active FROM students WHERE id = $1', [fixture.second.id]);
        same('the atomic sheet delete still leaves the pupil untouched',
            rows.map((r) => r.active), [true]);
    }

    result = await api('PATCH', `/api/evidence/item/${itemA.id}`,
        { label: 'нешто друго', expected: 'нешто што не пишува таму' });
    same('a reworded line refuses a stale expected label', result.status, 409);

    result = await api('POST', '/api/evidence/item', {
        sectionId: section.id, label: `${TAG} име пред трка`
    });
    const renameItem = result.body?.item;
    if (renameItem?.id) {
        const renameLock = await pool.connect();
        let renameAttempts: Promise<any>[] = [];
        try {
            await renameLock.query('BEGIN');
            await renameLock.query(
                'SELECT id FROM evidence_items WHERE id = $1 FOR SHARE', [renameItem.id]);
            let settled = 0;
            renameAttempts = [
                apiWithToken(token, 'PATCH', `/api/evidence/item/${renameItem.id}`, {
                    label: `${TAG} име А`, expected: `${TAG} име пред трка`
                }),
                apiWithToken(secondToken, 'PATCH', `/api/evidence/item/${renameItem.id}`, {
                    label: `${TAG} име Б`, expected: `${TAG} име пред трка`
                })
            ].map((attempt) => attempt.finally(() => { settled++; }));
            await new Promise((resolve) => setTimeout(resolve, 150));
            same('both same-expected item renames reach the locked row', settled, 0);
            await renameLock.query('COMMIT');
        } catch (err) {
            await renameLock.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            renameLock.release();
        }
        const renamed = await Promise.all(renameAttempts);
        same('two same-expected item renames produce one save and one conflict',
            renamed.map((r) => r.status).sort(), [200, 409]);
        const [renamedRow] = await q('SELECT label FROM evidence_items WHERE id = $1', [renameItem.id]);
        same('the losing item rename reports the value that won',
            renamed.filter((r) => r.status === 409).map((r) => r.body?.actual),
            [renamedRow.label]);
        await api('DELETE', `/api/evidence/item/${renameItem.id}`);
    }

    result = await api('DELETE', `/api/evidence/period/${periods[1].id}`);
    same('an unused column is deleted', result.status, 200);
    result = await api('DELETE', `/api/evidence/period/${periods[0].id}`);
    same('a column holding marks is refused', [result.status, result.body.deactivate], [409, true]);

    // ── the sheet is a document; the pupil is not ────────────────────────────
    console.log('\ndeleting a sheet does not delete a person');
    result = await api('DELETE', `/api/evidence/sheet/${sheetId}`);
    same('deleting without naming the pupil is refused', result.status, 400);

    result = await api('DELETE', `/api/evidence/sheet/${sheetId}?expected=${encodeURIComponent('некој друг')}`);
    same('a wrong name is refused and says whose it really is',
        [result.status, result.body.actual], [409, `${TAG} Пробен Ученик`]);

    result = await api('DELETE',
        `/api/evidence/sheet/${sheetId}?expected=${encodeURIComponent(`${TAG} Пробен Ученик`)}`);
    same('the right name deletes the sheet', result.status, 200);
    rows = await q('SELECT count(*)::int AS n FROM evidence_scores WHERE sheet_id = $1', [sheetId]);
    same('its cells go with it', rows[0].n, 0);
    rows = await q('SELECT active FROM students WHERE public_id = $1', [TAG]);
    same('the pupil is untouched', rows[0].active, true);
    rows = await q(
        `SELECT e.active FROM student_enrollments e JOIN students s ON s.id = e.student_id
         WHERE s.public_id = $1 AND e.school_year_id = $2`, [TAG, fixture.year.id]);
    same('and so is their place on the year list', rows[0].active, true);

    // The addresses that must never gain a delete: this file's own reader is
    // the one tempted to unify them.
    result = await api('DELETE', `/api/students/${TAG}`);
    same('there is still no way to delete a student through the roster API', result.status, 404);

    // ── the session ends ─────────────────────────────────────────────────────
    console.log('\nthe session');
    result = await api('POST', '/api/evidence/logout');
    same('logging out answers ok', result.status, 200);
    result = await api('GET', '/api/evidence/catalog');
    same('and the token stops working', [result.status, result.body.signedOut], [401, true]);

    await cleanup();
    console.log(`\n${fails ? `${fails} FAILED` : 'all assertions passed'}`);
    await pool.end();
    process.exit(fails ? 1 : 0);
}

run().catch(async (err) => {
    console.error(err);
    await cleanup().catch(() => {});
    await pool.end();
    process.exit(1);
});

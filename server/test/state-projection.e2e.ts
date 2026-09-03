/**
 * Which apps may write the shared tables.
 *
 *     npm run start                          # in one terminal
 *     npx tsx test/state-projection.e2e.ts
 *
 * `projectPayload` decides what a payload IS by looking at its shape, not at
 * who sent it. That was safe while only the two real apps existed. It stopped
 * being safe the moment an experimental fork appeared: a prototype carrying a
 * test roster is Rasporedi-shaped, so saving it once would have rewritten
 * `students`, `therapists` and `schedule_slots` — the tables every report and
 * both real apps read from.
 *
 * The near-empty-payload guard in import-core does NOT catch this, and the
 * second case below is the one that proves it: a payload with a plausible
 * number of invented students sails straight past a safeguard that only ever
 * looked for emptiness.
 *
 * Everything this creates is invented and prefixed, and it removes itself.
 */

import { pool } from '../src/db.js';

const BASE = process.env.API || 'http://127.0.0.1:3000';
const TAG = 'e2e-projection-guard';

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

const students = (n: number) =>
    ['Избери Ученик', ...Array.from({ length: n }, (_, i) => `Измислен Ученик ${i + 1}`)];

const payloadOf = (n: number) => ({
    students: students(n),
    therapists: ['Измислен Терапевт'],
    therapistStudents: { 'Измислен Терапевт': [`Измислен Ученик 1`] },
    studentMeta: {},
    schedule: []
});

async function rosterSize() {
    return (await pool.query('SELECT count(*)::int AS n FROM students')).rows[0].n as number;
}

const run = async () => {
    console.log(`projection guard against ${BASE}\n`);

    const health = await call('GET', '/api/health');
    if (health.status !== 200) {
        console.error('The server is not answering. Start it with `npm run start` first.');
        process.exit(1);
    }

    await pool.query('DELETE FROM app_state WHERE app LIKE $1', [`${TAG}%`]);

    // ── an unlisted app is stored, but reaches nothing ───────────────────────
    console.log('an unlisted app is stored as a blob and touches no table');
    const before = await rosterSize();
    const put = await call('PUT', `/api/state/${TAG}-experiment`, {
        baseVersion: 0, payload: payloadOf(2), updated_by: TAG
    });
    checkEq('the save succeeds', put.status, 200);
    checkEq('and is a real version', put.body?.version, 1);
    checkEq('but the projection is blob only', put.body?.projection?.kind, 'blob only');
    check('and it says why, rather than reporting a clean save',
        /not on the projection list/.test(put.body?.projection?.skipped || ''), JSON.stringify(put.body));
    checkEq('the roster is untouched', await rosterSize(), before);
    check('the blob reads back', (await call('GET', `/api/state/${TAG}-experiment`)).status === 200);
    check('no invented student reached the table',
        (await pool.query(`SELECT count(*)::int AS n FROM students WHERE name LIKE 'Измислен%'`)).rows[0].n === 0);

    // ── the case the old safeguard could not see ─────────────────────────────
    console.log('\na roster-sized payload is exactly what the emptiness guard misses');
    // import-core refuses a payload holding less than half the stored roster.
    // A fork carrying a test roster of its own is not empty, so that guard
    // never fires — which is why the slug has to decide instead.
    const big = Math.max(4, before);
    const put2 = await call('PUT', `/api/state/${TAG}-experiment`, {
        baseVersion: 1, payload: payloadOf(big), updated_by: TAG
    });
    checkEq('a full-sized invented roster also saves', put2.status, 200);
    checkEq('and is still blob only', put2.body?.projection?.kind, 'blob only');
    checkEq('the real roster is still the real roster', await rosterSize(), before);

    // ── the suites must keep working ─────────────────────────────────────────
    console.log('\na slug that declares itself a fixture still projects');
    // The e2e suites save under names like `sdnevnik-test` precisely so they
    // never touch the real blob, and what they assert afterwards is the state
    // of the tables. Declaring yourself a fixture in your own name is a
    // conscious act, and one a therapist opening a forked HTML file cannot
    // perform by accident.
    const asTest = await call('PUT', `/api/state/${TAG}-test`, {
        baseVersion: 0, payload: { students: ['Избери Ученик'], therapists: [], therapistStudents: {}, studentMeta: {}, schedule: [] }, updated_by: TAG
    });
    checkEq('it saves', asTest.status, 200);
    check('and reaches the projection', asTest.body?.projection?.kind !== 'blob only',
        JSON.stringify(asTest.body?.projection));
    check('which then refuses the near-empty roster on its own merits',
        /skipped|rasporedi/.test(String(asTest.body?.projection?.kind || '')), JSON.stringify(asTest.body?.projection));
    checkEq('so the roster survives that too', await rosterSize(), before);

    await pool.query('DELETE FROM app_state WHERE app LIKE $1', [`${TAG}%`]);
    await pool.end();
    console.log(failures ? `\n${failures} failed` : '\nall good');
    process.exit(failures ? 1 : 0);
};

run().catch(async (e) => { console.error(e); await pool.end().catch(() => {}); process.exit(1); });

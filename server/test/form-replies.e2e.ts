/**
 * The review queue for offline form answers (docs/PLAN-formulari.md): a
 * therapist's answer (version 1, and version 2 with its checklist), a homeroom
 * teacher's class answer, and a teacher's own week. Since 24 Sep 2026 what is
 * clean and the sender's own is written on import, in the sender's name; the
 * rest waits for the administrator.
 *
 * In-process, like colleague.e2e.ts: the app is built here with its own
 * MTB_ADMIN, so the rule "only the administrator, signed in" is exercised
 * without touching the running server's settings. It works in a school year
 * of its own with invented people (rule 1) and removes all of it afterwards.
 *
 *     npx tsx test/form-replies.e2e.ts     (DATABASE_URL from server/.env)
 */
import pg from 'pg';
import { createHmac, randomBytes, scryptSync } from 'node:crypto';
import Fastify from 'fastify';
import 'dotenv/config';
import { scheduleWriteRoutes } from '../src/routes/schedule-write.js';
import { rosterWriteRoutes } from '../src/routes/roster-write.js';
import { evidenceAuthRoutes } from '../src/routes/evidence-auth.js';
import { workspaceRoutes } from '../src/routes/workspace.js';
import { formReplyRoutes } from '../src/routes/form-replies.js';
import { teachingEditRoutes } from '../src/routes/teaching-edit.js';
import { installColleagueBoundary } from '../src/lib/colleague.js';

const DB = process.env.DATABASE_URL;
if (!DB) throw new Error('DATABASE_URL is required; configure it in server/.env.');
const pool = new pg.Pool({ connectionString: DB });
const q = async (text: string, args: unknown[] = []) => (await pool.query(text, args)).rows;

const YEAR = '1917/1918-forms';
const TAG = 'forms-test';
const ADMIN = 'Пробен Админ Формулари';
const A = 'Пробен Терапевт Формулар А';
const B = 'Пробен Терапевт Формулар Б';
const NEW_PUPIL = 'Сосема Нов Пробен Ученик';
const PEOPLE = [ADMIN, A, B];
const TA = 'Пробен Наставник Формулар А';
const TB = 'Пробен Наставник Формулар Б';
const TEACHERS = [TA, TB];
const C1 = 'ПФ-1';
const C2 = 'ПФ-2';

let fails = 0;
const check = (label: string, ok: boolean, detail = '') => {
    if (ok) console.log(`  ok   ${label}`);
    else { fails++; console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`); }
};
/** Sign an answer as the form does: HMAC(scrypt(PIN, salt), the answer with sorted keys). */
const sortKeys = (v: any): any => Array.isArray(v) ? v.map(sortKeys)
    : v && typeof v === 'object' ? Object.keys(v).sort().reduce((o: any, k) => { o[k] = sortKeys(v[k]); return o; }, {}) : v;
function signed<T extends Record<string, any>>(reply: T, kind: string, name: string, pin: string, salt: string | null): T {
    const body: any = { ...reply };
    delete body.signature;
    const create = !salt;
    const useSalt = salt || randomBytes(16).toString('hex');
    const key = scryptSync(pin, useSalt, 32).toString('hex');
    const value = createHmac('sha256', Buffer.from(key, 'hex')).update(JSON.stringify(sortKeys(body)), 'utf8').digest('hex');
    return { ...body, signature: { version: 1, by: { kind, name }, salt: useSalt, ...(create ? { newPin: key } : {}), value } };
}
const eq = (label: string, a: unknown, b: unknown) =>
    check(label, JSON.stringify(a) === JSON.stringify(b), `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

async function cleanup() {
    await q(`DELETE FROM lessons WHERE class_id IN (SELECT id FROM school_classes WHERE label = ANY($1::text[]))`, [[C1, C2]]);
    await q(`DELETE FROM school_years WHERE label = $1`, [YEAR]);
    await q(`DELETE FROM school_classes WHERE label = ANY($1::text[])`, [[C1, C2]]);
    await q(`DELETE FROM teachers WHERE name = ANY($1::text[])`, [TEACHERS]);
    await q(`DELETE FROM students WHERE public_id LIKE $1 OR name = $2`, [`${TAG}%`, NEW_PUPIL]);
    await q(`DELETE FROM therapists WHERE name = ANY($1::text[])`, [PEOPLE]);
    // Migration 035 keeps an employee identity when the profile goes; the
    // fixture's must go too, or check:names learns these invented names.
    await q(`DELETE FROM employees e WHERE e.name = ANY($1::text[])
              AND NOT EXISTS (SELECT 1 FROM teachers x WHERE x.employee_id = e.id)
              AND NOT EXISTS (SELECT 1 FROM therapists x WHERE x.employee_id = e.id)
              AND NOT EXISTS (SELECT 1 FROM employee_roles x WHERE x.employee_id = e.id)
              AND NOT EXISTS (SELECT 1 FROM employee_year_details x WHERE x.employee_id = e.id)
              AND NOT EXISTS (SELECT 1 FROM employee_identity_links x WHERE x.source_id = e.id OR x.target_id = e.id)
              AND NOT EXISTS (SELECT 1 FROM employees x WHERE x.superseded_by = e.id)`, [PEOPLE.concat(TEACHERS)]);
}

async function run() {
    const previous = { admin: process.env.MTB_ADMIN, signin: process.env.MTB_REQUIRE_SIGNIN, key: process.env.MTB_SERVICE_KEY };
    delete process.env.MTB_REQUIRE_SIGNIN;
    delete process.env.MTB_SERVICE_KEY;
    delete process.env.MTB_ADMIN;
    await cleanup();

    const app = Fastify({ logger: false });
    installColleagueBoundary(app);
    await app.register(evidenceAuthRoutes);
    await app.register(scheduleWriteRoutes);
    await app.register(rosterWriteRoutes);
    await app.register(workspaceRoutes);
    await app.register(teachingEditRoutes);
    await app.register(formReplyRoutes);
    await app.ready();

    try {
        // ── fixture ──
        const [year] = await q(`INSERT INTO school_years (label, starts_on, ends_on, is_current)
                                VALUES ($1, '1917-09-01', '1918-08-31', false) RETURNING id`, [YEAR]);
        const ids: Record<string, number> = {};
        for (const name of PEOPLE) {
            ids[name] = (await q(`INSERT INTO therapists (name) VALUES ($1) RETURNING id`, [name]))[0].id;
            await q(`INSERT INTO therapist_years (school_year_id, therapist_id, active) VALUES ($1, $2, true)`, [year.id, ids[name]]);
        }
        const pupil: Record<string, { id: number; pid: string }> = {};
        for (const [key, name] of [['p1', 'Пробно Дете Прво'], ['p2', 'Пробно Дете Второ'], ['p3', 'Пробно Дете Трето']]) {
            const pid = `${TAG}-${key}`;
            const [s] = await q(`INSERT INTO students (public_id, name, active) VALUES ($1, $2, true) RETURNING id`, [pid, name]);
            await q(`INSERT INTO student_enrollments (school_year_id, student_id, active, kind) VALUES ($1, $2, true, 'external')`, [year.id, s.id]);
            pupil[key] = { id: s.id, pid };
        }
        await q(`INSERT INTO therapist_students (therapist_id, student_id, school_year_id) VALUES ($1, $2, $3), ($1, $4, $3)`,
            [ids[A], pupil.p1.id, year.id, pupil.p2.id]);
        await q(`INSERT INTO therapist_students (therapist_id, student_id, school_year_id) VALUES ($1, $2, $3)`,
            [ids[B], pupil.p2.id, year.id]);
        const bells = (await q(`SELECT to_char(starts_at, 'HH24:MI') AS s FROM bell_periods
                                 WHERE schedule = 'kabinet' AND minutes = 40 ORDER BY ordinal LIMIT 2`)).map((b) => b.s);
        if (bells.length < 2) throw new Error('this database has fewer than two 40-minute cabinet bells');
        const block = (s: string) => { const [h, m] = s.split(':').map(Number); const e = h * 60 + m + 40;
            return `${s}-${String(Math.floor(e / 60)).padStart(2, '0')}:${String(e % 60).padStart(2, '0')}`; };
        const T1 = block(bells[0]); const T2 = block(bells[1]);
        const slot = (therapist: number, student: number, day: string, time: string) => q(
            `INSERT INTO schedule_slots (school_year_id, day, day_order, time_slot, therapist_id, student_id)
             VALUES ($1, $2, $3, $4, $5, $6)`, [year.id, day, day === 'понеделник' ? 1 : 2, time, therapist, student]);
        await slot(ids[A], pupil.p1.id, 'понеделник', T1);          // A's own term
        await slot(ids[B], pupil.p2.id, 'понеделник', T2);          // p2 is with B on Monday, 2nd block
        await slot(ids[A], pupil.p1.id, 'вторник', T2);             // will be changed behind the form's back

        for (const name of [ADMIN, B]) {
            await app.inject({ method: 'POST', url: '/api/evidence/pin', payload: { therapistId: ids[name], pin: '4321' } });
        }
        const login = async (name: string) => (await app.inject({ method: 'POST', url: '/api/evidence/login',
            payload: { therapistId: ids[name], pin: '4321' } })).json().token as string;
        const adminToken = await login(ADMIN);
        const bToken = await login(B);
        const as = (token?: string) => (token ? { 'x-mtb-evidence-token': token } : {});

        // The answer: A's week as the form showed it, and as A left it. A's
        // numeric id is wrong on purpose — a form made on another machine.
        const MON1 = `понеделник|${T1}`, MON2 = `понеделник|${T2}`, TUE1 = `вторник|${T1}`, TUE2 = `вторник|${T2}`;
        const answer = (savedAt: string, over: Record<string, unknown> = {}) => ({
            kind: 'mtb-schedule-reply', version: 1, year: YEAR, therapist: { id: 999999, name: A },
            formGeneratedAt: '1917-09-20T08:00:00.000Z', savedAt,
            baseline: { [MON1]: [pupil.p1.pid], [TUE2]: [pupil.p1.pid] },
            blocks: { [MON1]: [pupil.p1.pid], [MON2]: [pupil.p2.pid], [TUE1]: ['new:1'], [TUE2]: [] },
            newPupils: [{ id: 'new:1', name: NEW_PUPIL }], note: '', ...over
        });
        const aSalt = randomBytes(16).toString('hex');
        // A has no PIN yet: both files carry the same new one, as one form makes it.
        const asA = (r: any) => {
            const key = scryptSync('1111', aSalt, 32).toString('hex');
            const value = createHmac('sha256', Buffer.from(key, 'hex')).update(JSON.stringify(sortKeys(r)), 'utf8').digest('hex');
            return { ...r, signature: { version: 1, by: { kind: 'therapist', name: A }, salt: aSalt, newPin: key, value } };
        };
        const older = asA(answer('1917-09-21T10:00:00.000Z', { note: 'постар' }));
        const newer = asA(answer('1917-09-22T10:00:00.000Z'));
        const files = { replies: [
            { fileName: 'newer.json', reply: newer },
            { fileName: 'older.json', reply: older },
            { fileName: 'again.json', reply: JSON.parse(JSON.stringify(newer)) },
            { fileName: 'wrong.json', reply: { hello: 1 } }
        ] };

        console.log('only the administrator, signed in');
        let res = await app.inject({ method: 'POST', url: '/api/forms/replies', payload: files, headers: as(adminToken) });
        eq('without MTB_ADMIN nobody may, and the refusal says how to set it', [res.statusCode, /MTB_ADMIN/.test(res.json().error)], [403, true]);
        process.env.MTB_ADMIN = `therapist:${ADMIN}`;
        res = await app.inject({ method: 'POST', url: '/api/forms/replies', payload: files });
        eq('not signed in → 401', res.statusCode, 401);
        res = await app.inject({ method: 'POST', url: '/api/forms/replies', payload: files, headers: as(bToken) });
        eq('signed in, but not the administrator → 403', res.statusCode, 403);
        res = await app.inject({ method: 'GET', url: `/api/forms/replies?year=${encodeURIComponent(YEAR)}`, headers: as(bToken) });
        eq('and cannot even read the list', res.statusCode, 403);

        console.log('\nthe PIN decides whose answer it is');
        const probe = answer('1917-09-19T10:00:00.000Z', { note: 'проба' });
        const bSalt = (await q(`SELECT pin_salt FROM evidence_logins WHERE therapist_id = $1`, [ids[B]]))[0].pin_salt;
        const tries = [
            { fileName: 'unsigned.json', reply: probe },
            { fileName: 'as-b.json', reply: signed(probe, 'therapist', B, '4321', bSalt) },
            { fileName: 'b-wrong-pin.json', reply: signed({ ...probe, therapist: { id: 1, name: B } }, 'therapist', B, '9999', bSalt) },
            { fileName: 'b-new-pin.json', reply: signed({ ...probe, therapist: { id: 1, name: B } }, 'therapist', B, '5555', null) }
        ];
        res = await app.inject({ method: 'POST', url: '/api/forms/replies', payload: { replies: tries }, headers: as(adminToken) });
        const refusals = res.json().results.map((r: any) => [r.fileName, r.outcome, r.error]);
        eq('an unsigned answer, one signed by somebody else, a wrong PIN, and a "new" PIN over an existing one are all refused',
            refusals.map((r: any) => r[1]), ['refused', 'refused', 'refused', 'refused']);
        check('each says why', /не е потпишан/.test(refusals[0][2]) && /потписот е на/.test(refusals[1][2])
            && /PIN-от не се совпаѓа/.test(refusals[2][2]) && /сменет или создаден/.test(refusals[3][2]), JSON.stringify(refusals));
        eq('and none of them was stored', (await q(`SELECT count(*)::int AS n FROM form_replies r JOIN school_years y ON y.id = r.school_year_id WHERE y.label = $1`, [YEAR]))[0].n, 0);

        console.log('\nseveral files at once; the newest wins');
        // Behind the form's back: A's Tuesday term now holds p3, not p1.
        await q(`UPDATE schedule_slots SET student_id = $1 WHERE school_year_id = $2 AND therapist_id = $3 AND day = 'вторник'`,
            [pupil.p3.id, year.id, ids[A]]);
        res = await app.inject({ method: 'POST', url: '/api/forms/replies', payload: files, headers: as(adminToken) });
        const out = res.json().results as Array<{ fileName: string; outcome: string; id?: number }>;
        eq('each file gets its own outcome', out.map((r) => [r.fileName, r.outcome]),
            [['newer.json', 'stored'], ['older.json', 'superseded'], ['again.json', 'duplicate'], ['wrong.json', 'refused']]);
        check('the first answer created A\'s PIN', (out[0] as any).pinCreated === true, JSON.stringify(out[0]));
        const aLogin = await app.inject({ method: 'POST', url: '/api/evidence/login', payload: { therapistId: ids[A], pin: '1111' } });
        eq('and it is A\'s Евидентен лист PIN from now on', aLogin.statusCode, 200);
        const list = (await app.inject({ method: 'GET', url: `/api/forms/replies?year=${encodeURIComponent(YEAR)}`, headers: as(adminToken) })).json();
        eq('the list shows the newer pending first, the older kept as superseded',
            list.replies.map((r: any) => [r.fileName, r.status]), [['newer.json', 'pending'], ['older.json', 'superseded']]);
        const newerId = out[0].id!;
        const olderId = out[1].id!;
        res = await app.inject({ method: 'POST', url: `/api/forms/replies/${olderId}/decide`, payload: { accept: [`block:${MON2}`] }, headers: as(adminToken) });
        eq('a superseded answer cannot be decided', res.statusCode, 409);

        eq('nothing of A\'s answer was A\'s alone to write: a new child, a conflict, a term changed meanwhile',
            [(out[0] as any).applied, (out[0] as any).waiting], [0, 4]);

        console.log('\nthe review, against the database as it is now');
        const review = (await app.inject({ method: 'GET', url: `/api/forms/replies/${newerId}/review`, headers: as(adminToken) })).json();
        const item = (key: string) => review.items.find((i: any) => i.key === key);
        eq('the therapist is found by name although the file carried another id', review.therapist && review.therapist.name, A);
        eq('the child already with another therapist is a conflict', item(`block:${MON2}`)?.state, 'conflict');
        check('and it says with whom', /Формулар Б/.test((item(`block:${MON2}`)?.reasons || []).join(' ')), JSON.stringify(item(`block:${MON2}`)));
        eq('a term changed since the form was made is marked', item(`block:${TUE2}`)?.state, 'changed');
        eq('the new name is an item of its own', item(`pupil:${`new:${NEW_PUPIL}`.toLocaleLowerCase('mk-MK')}`)?.state, 'clean');
        eq('the block with the new pupil is clean', item(`block:${TUE1}`)?.state, 'clean');
        eq('an unchanged term is not an item', item(`block:${MON1}`), undefined);

        console.log('\naccepting writes through the owning routes');
        const pupilKey = `pupil:new:${NEW_PUPIL.toLocaleLowerCase('mk-MK')}`;
        res = await app.inject({ method: 'POST', url: `/api/forms/replies/${newerId}/decide`,
            payload: { accept: [pupilKey, `block:${TUE1}`] }, headers: as(adminToken) });
        eq('both accepted items are written', res.json().outcomes, { [pupilKey]: 'запишано', [`block:${TUE1}`]: 'запишано' });
        const created = await q(`SELECT s.public_id FROM students s WHERE s.name = $1`, [NEW_PUPIL]);
        eq('the new pupil exists once', created.length, 1);
        const tue1 = await q(`SELECT s.public_id FROM schedule_slots sl JOIN students s ON s.id = sl.student_id
                               WHERE sl.school_year_id = $1 AND sl.therapist_id = $2 AND sl.day = 'вторник' AND sl.time_slot = $3`,
            [year.id, ids[A], T1]);
        eq('and holds the Tuesday term', tue1.map((r) => r.public_id), created.map((r) => r.public_id));
        const listed = await q(`SELECT 1 FROM therapist_students ts JOIN students s ON s.id = ts.student_id
                                 WHERE ts.school_year_id = $1 AND ts.therapist_id = $2 AND s.name = $3`, [year.id, ids[A], NEW_PUPIL]);
        eq('and is on the therapist\'s list', listed.length, 1);
        const mon2 = await q(`SELECT 1 FROM schedule_slots WHERE school_year_id = $1 AND therapist_id = $2 AND day = 'понеделник' AND time_slot = $3`,
            [year.id, ids[A], T2]);
        eq('the conflict was not written', mon2.length, 0);
        let state = (await q(`SELECT status FROM form_replies WHERE id = $1`, [newerId]))[0].status;
        eq('the answer stays open while items are undecided', state, 'pending');

        console.log('\nthe rest is rejected, and the answer closes');
        res = await app.inject({ method: 'POST', url: `/api/forms/replies/${newerId}/decide`,
            payload: { reject: [`block:${MON2}`, `block:${TUE2}`] }, headers: as(adminToken) });
        eq('rejected', res.statusCode, 200);
        state = (await q(`SELECT status, closed_by FROM form_replies WHERE id = $1`, [newerId]))[0];
        eq('closed as done, by the administrator', [state.status, state.closed_by], ['done', ADMIN]);
        const tue2 = await q(`SELECT s.public_id FROM schedule_slots sl JOIN students s ON s.id = sl.student_id
                               WHERE sl.school_year_id = $1 AND sl.therapist_id = $2 AND sl.day = 'вторник' AND sl.time_slot = $3`,
            [year.id, ids[A], T2]);
        eq('the term changed meanwhile keeps what the database had', tue2.map((r) => r.public_id), [pupil.p3.pid]);
        const decisions = await q(`SELECT item_key, decision FROM form_reply_decisions WHERE reply_id = $1 ORDER BY item_key`, [newerId]);
        eq('every decision is recorded', decisions.length, 4);

        console.log('\nversion 2: the checklist');
        // B unticks p2 and clears the term p2 had; ticks p3.
        const v2 = signed({
            kind: 'mtb-schedule-reply', version: 2, year: YEAR, therapist: { id: 1, name: B },
            formGeneratedAt: '1917-09-20T08:00:00.000Z', savedAt: '1917-09-23T10:00:00.000Z',
            baseline: { [MON2]: [pupil.p2.pid] }, blocks: { [MON2]: [] }, newPupils: [],
            pupils: { baseline: [pupil.p2.pid], ticked: [pupil.p3.pid] }, note: ''
        }, 'therapist', B, '4321', bSalt);
        res = await app.inject({ method: 'POST', url: '/api/forms/replies', payload: { replies: [{ fileName: 'b.json', reply: v2 }] }, headers: as(adminToken) });
        const v2Id = res.json().results[0].id;
        eq('B\'s own clean changes are written on import, nothing waits', [res.json().results[0].applied, res.json().results[0].waiting], [3, 0]);
        const v2Review = (await app.inject({ method: 'GET', url: `/api/forms/replies/${v2Id}/review`, headers: as(adminToken) })).json();
        eq('a tick added, a tick removed and the cleared term are three items',
            v2Review.items.map((i: any) => [i.key, i.state]).sort(),
            [[`block:${MON2}`, 'clean'], [`caseload:${pupil.p3.pid}`, 'clean'], [`uncaseload:${pupil.p2.pid}`, 'clean']].sort());
        check('each is recorded as written, in B\'s name', v2Review.items.every((i: any) => i.decision && i.decision.outcome === 'запишано'
            && i.decision.decided_by === `${B} (од формулар)`), JSON.stringify(v2Review.items.map((i: any) => i.decision)));
        eq('and the answer is closed', (await q(`SELECT status FROM form_replies WHERE id = $1`, [v2Id]))[0].status, 'done');
        const bList = (await q(`SELECT s.public_id FROM therapist_students ts JOIN students s ON s.id = ts.student_id
                                  WHERE ts.school_year_id = $1 AND ts.therapist_id = $2 ORDER BY 1`, [year.id, ids[B]])).map((r) => r.public_id);
        eq('B\'s list is now exactly what B ticked', bList, [pupil.p3.pid]);

        console.log('\nthe class form');
        const cls: Record<string, number> = {};
        for (const label of [C1, C2]) {
            cls[label] = (await q(`INSERT INTO school_classes (label, sort_key) VALUES ($1, $1) RETURNING id`, [label]))[0].id;
            await q(`INSERT INTO class_years (school_year_id, class_id, active) VALUES ($1, $2, true)`, [year.id, cls[label]]);
        }
        const tid: Record<string, number> = {};
        for (const [name, kind] of [[TA, 'odd'], [TB, 'pred']]) {
            tid[name] = (await q(`INSERT INTO teachers (name, kind) VALUES ($1, $2) RETURNING id`, [name, kind]))[0].id;
            await q(`INSERT INTO teacher_years (school_year_id, teacher_id, active) VALUES ($1, $2, true)`, [year.id, tid[name]]);
        }
        const lesson = (label: string, day: string, ordinal: number, subject: string, teacher: string) => q(
            `INSERT INTO lessons (school_year_id, day, day_order, ordinal, class_id, teacher_id, subject)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`, [year.id, day, day === 'понеделник' ? 1 : 2, ordinal, cls[label], tid[teacher], subject]);
        await lesson(C1, 'понеделник', 1, 'Математика', TA);
        await lesson(C1, 'понеделник', 2, 'Македонски јазик', TA);
        await lesson(C2, 'вторник', 1, 'Англиски јазик', TB);           // TB is busy on Tuesday, 1st period

        const classAnswer = signed({
            kind: 'mtb-class-reply', version: 1, year: YEAR, class: { id: 99999, label: C1 }, homeroom: TA,
            formGeneratedAt: '1917-09-20T08:00:00.000Z', savedAt: '1917-09-23T11:00:00.000Z',
            baseline: { 'понеделник|1': { subject: 'Математика', teacher: TA }, 'понеделник|2': { subject: 'Македонски јазик', teacher: TA } },
            cells: {
                'понеделник|1': { subject: 'Ликовно образование', teacher: TA },   // a new subject
                'вторник|1': { subject: 'Музичко образование', teacher: TB },     // TB is in ПФ-2 then
                'среда|1': { subject: 'Физичко образование', teacher: null }      // a new lesson, no teacher
            },                                                                    // Monday 2nd: cleared
            subjects: ['Ликовно образование'],
            reports: [{ name: 'Пробно Дете Прво', generation: 'I', text: 'е во ПФ-2' }], note: 'од понеделник'
        }, 'teacher', TA, '2222', null);
        res = await app.inject({ method: 'POST', url: '/api/forms/replies', payload: { replies: [{ fileName: 'class.json', reply: classAnswer }] }, headers: as(adminToken) });
        eq('a class answer is stored, named by its class and homeroom', [res.json().results[0].outcome, res.json().results[0].about], ['stored', `${C1} · ${TA}`]);
        const classId = res.json().results[0].id;
        eq('its clean lessons are written on import; the conflict and the report wait', [res.json().results[0].applied, res.json().results[0].waiting], [3, 2]);
        eq('in the name of the teacher who signed it', (await q(`SELECT DISTINCT decided_by FROM form_reply_decisions WHERE reply_id = $1`, [res.json().results[0].id])).map((r) => r.decided_by), [`${TA} (од формулар)`]);
        const cr = (await app.inject({ method: 'GET', url: `/api/forms/replies/${classId}/review`, headers: as(adminToken) })).json();
        const citem = (key: string) => cr.items.find((i: any) => i.key === key);
        eq('the class is found by its label although the file carried another id', cr.class, C1);
        eq('a changed subject is clean, and was written', [citem('lesson:понеделник|1')?.state, citem('lesson:понеделник|1')?.decision?.outcome], ['clean', 'запишано']);
        eq('a cleared period is clean', [citem('lesson:понеделник|2')?.state, citem('lesson:понеделник|2')?.toCell], ['clean', null]);
        eq('a teacher already in another class is a conflict', citem('lesson:вторник|1')?.state, 'conflict');
        check('and it says where', /ПФ-2/.test((citem('lesson:вторник|1')?.reasons || []).join(' ')), JSON.stringify(citem('lesson:вторник|1')));
        const reportKey = cr.items.find((i: any) => i.type === 'report')?.key;
        eq('a pupil report is its own kind of item', cr.items.find((i: any) => i.type === 'report')?.state, 'report');

        res = await app.inject({ method: 'POST', url: `/api/forms/replies/${classId}/decide`,
            payload: { accept: [reportKey] }, headers: as(adminToken) });
        eq('the report is only noted', res.json().outcomes, { [reportKey]: 'забележано' });
        const week = (await q(`SELECT l.day || '|' || l.ordinal AS k, l.subject, t.name AS teacher FROM lessons l LEFT JOIN teachers t ON t.id = l.teacher_id
                                 WHERE l.school_year_id = $1 AND l.class_id = $2 ORDER BY l.day_order, l.ordinal`, [year.id, cls[C1]]))
            .map((r) => [r.k, r.subject, r.teacher]);
        eq('the class week is what was accepted, and nothing else', week,
            [['понеделник|1', 'Ликовно образование', TA], ['среда|1', 'Физичко образование', null]]);
        const moved = await q(`SELECT 1 FROM student_enrollments e JOIN students s ON s.id = e.student_id
                                WHERE e.school_year_id = $1 AND s.public_id = $2 AND e.grade = $3`, [year.id, pupil.p1.pid, C2]);
        eq('the report moved nobody', moved.length, 0);
        res = await app.inject({ method: 'POST', url: `/api/forms/replies/${classId}/decide`,
            payload: { reject: ['lesson:вторник|1'] }, headers: as(adminToken) });
        eq('once the conflict is rejected the answer closes', (await q(`SELECT status FROM form_replies WHERE id = $1`, [classId]))[0].status, 'done');
        const tb = await q(`SELECT 1 FROM lessons WHERE school_year_id = $1 AND class_id = $2 AND day = 'вторник'`, [year.id, cls[C1]]);
        eq('and the conflicting lesson was never written', tb.length, 0);

        console.log('\na teacher\'s own week');
        await lesson(C2, 'понеделник', 2, 'Математика', TA);             // TA is in ПФ-2 on Monday, 2nd
        const own = signed({
            kind: 'mtb-teacher-reply', version: 1, year: YEAR, teacher: { id: 424242, name: TB },
            formGeneratedAt: '1917-09-20T08:00:00.000Z', savedAt: '1917-09-23T12:00:00.000Z',
            baseline: { 'вторник|1': { class: C2, subject: 'Англиски јазик' } },
            cells: {
                'вторник|1': { class: C2, subject: 'Англиски јазик' },            // as it was: a confirmation
                'понеделник|1': { class: C1, subject: 'Ликовно образование' },    // TA teaches it then: together
                'среда|1': { class: C1, subject: 'Физичко образование' },         // a lesson nobody had named
                'четврток|1': { class: C1, subject: 'Музичко образование' },      // a new lesson
                'понеделник|2': { class: C2, subject: 'Англиски јазик' }          // TA has Maths there: a conflict
            }, note: ''
        }, 'teacher', TB, '3333', null);
        res = await app.inject({ method: 'POST', url: '/api/forms/replies', payload: { replies: [{ fileName: 'tb.json', reply: own }] }, headers: as(adminToken) });
        const ownResult = res.json().results[0];
        eq('stored as the teacher\'s own answer, three written, the conflict waits',
            [ownResult.outcome, ownResult.about, ownResult.applied, ownResult.waiting], ['stored', TB, 3, 1]);
        const at = async (day: string, ordinal: number, label: string) => (await q(
            `SELECT t.name, l.subject FROM lessons l LEFT JOIN teachers t ON t.id = l.teacher_id
              WHERE l.school_year_id = $1 AND l.class_id = $2 AND l.day = $3 AND l.ordinal = $4 ORDER BY t.name`,
            [year.id, cls[label], day, ordinal])).map((r) => [r.name, r.subject]);
        eq('two teachers of one subject in one class: both kept', await at('понеделник', 1, C1),
            [[TA, 'Ликовно образование'], [TB, 'Ликовно образование']]);
        eq('a lesson with no teacher gets this one\'s name, not a second row', await at('среда', 1, C1), [[TB, 'Физичко образование']]);
        eq('a new lesson is written', await at('четврток', 1, C1), [[TB, 'Музичко образование']]);
        eq('the conflict is not written', await at('понеделник', 2, C2), [[TA, 'Математика']]);
        const ownReview = (await app.inject({ method: 'GET', url: `/api/forms/replies/${ownResult.id}/review`, headers: as(adminToken) })).json();
        const conflict = ownReview.items.find((i: any) => i.key === 'mylesson:понеделник|2');
        check('the conflict names who is there', conflict?.state === 'conflict' && /Формулар А \(Математика\)/.test(conflict.reasons.join(' ')), JSON.stringify(conflict));
        eq('the confirmation is not an item', ownReview.unchanged, 1);
        const coverage = (await app.inject({ method: 'GET', url: `/api/forms/coverage?year=${encodeURIComponent(YEAR)}`, headers: as(adminToken) })).json();
        const cov = (name: string) => coverage.teachers.find((t: any) => t.name === name);
        check('coverage says who has answered and who has not', !!cov(TB)?.filledAt && cov(TA)?.filledAt === null, JSON.stringify(coverage.teachers));
        check('and counts each one\'s lessons', cov(TB)?.lessons === 4, JSON.stringify(cov(TB)));
    } finally {
        await app.close();
        await cleanup();
        for (const [k, v] of [['MTB_ADMIN', previous.admin], ['MTB_REQUIRE_SIGNIN', previous.signin], ['MTB_SERVICE_KEY', previous.key]] as const) {
            if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
        await pool.end();
    }
    console.log(fails ? `\n${fails} failed.` : '\nall good');
    process.exit(fails ? 1 : 0);
}

run().catch(async (err) => { console.error(err); await cleanup().catch(() => {}); process.exit(1); });

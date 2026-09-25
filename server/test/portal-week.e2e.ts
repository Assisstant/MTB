/**
 * A colleague's own week, against a real database (docs/PLAN-kolegi-online.md,
 * step 2): a clash is said before it is saved, „сепак запиши" keeps it and
 * tells the colleague it hits, and the notice closes by itself once one side
 * moves. Invented people in an invented year (rule 1), all removed afterwards.
 *
 *     npx tsx test/portal-week.e2e.ts     (DATABASE_URL from server/.env)
 */
import pg from 'pg';
import Fastify from 'fastify';
import 'dotenv/config';
import { portalRoutes } from '../src/routes/portal.js';

const DB = process.env.DATABASE_URL;
if (!DB) throw new Error('DATABASE_URL is required; configure it in server/.env.');
const pool = new pg.Pool({ connectionString: DB });
const q = async (text: string, args: unknown[] = []) => (await pool.query(text, args)).rows;

const YEAR = '1920/1921-week';
const A = 'Пробен Наставник Недела А';
const B = 'Пробен Наставник Недела Б';
const H = 'Пробна Раководителка Недела';
const T = 'Пробен Наставник Недела Т';
const R = 'Пробен Терапевт Недела';
const TEACHERS = [A, B, H, T];
const CLASS = 'ПН-1';
const OTHER = 'ПН-2';
const DAY = 'понеделник';
const KIDS = [
    { id: 'portal-week-1', name: 'Пробно Дете Недела Прво', class: 'ПН-1', odd: 'II' },
    { id: 'portal-week-2', name: 'Пробно Дете Недела Второ', class: 'ПН-1', odd: 'III' },
    { id: 'portal-week-3', name: 'Пробно Дете Недела Трето', class: 'ПН-2', odd: 'IV' }
];

let fails = 0;
const check = (label: string, ok: boolean, detail = '') => {
    if (ok) console.log(`  ok   ${label}`);
    else { fails++; console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`); }
};

async function cleanup() {
    const people = [...TEACHERS, R];
    const ids = (await q(`SELECT id FROM employees WHERE name = ANY($1::text[])`, [people])).map((r: any) => r.id);
    if (ids.length) {
        await q(`DELETE FROM staff_sessions WHERE employee_id = ANY($1::int[])`, [ids]);
        await q(`DELETE FROM staff_accounts WHERE employee_id = ANY($1::int[])`, [ids]);
    }
    await q(`DELETE FROM school_years WHERE label = $1`, [YEAR]);
    await q(`DELETE FROM students WHERE public_id LIKE 'portal-week-%'`);
    await q(`DELETE FROM teachers WHERE name = ANY($1::text[])`, [TEACHERS]);
    await q(`DELETE FROM therapists WHERE name = $1`, [R]);
    await q(`DELETE FROM school_classes WHERE label = ANY($1::text[])`, [[CLASS, OTHER]]);
    await q(`DELETE FROM employees e WHERE e.name = ANY($1::text[])
              AND NOT EXISTS (SELECT 1 FROM teachers x WHERE x.employee_id = e.id)
              AND NOT EXISTS (SELECT 1 FROM therapists x WHERE x.employee_id = e.id)`, [people]);
}

async function main() {
    await cleanup();
    const [y] = await q(`INSERT INTO school_years (label, starts_on, ends_on, is_current)
                         VALUES ($1, '1920-09-01', '1921-08-31', false) RETURNING id`, [YEAR]);
    const tid: Record<string, number> = {};
    for (const name of TEACHERS) {
        const [t] = await q(`INSERT INTO teachers (name, kind) VALUES ($1, 'pred') RETURNING id`, [name]);
        await q(`INSERT INTO teacher_years (school_year_id, teacher_id, active) VALUES ($1, $2, true)`, [y.id, t.id]);
        tid[name] = t.id;
    }
    const [th] = await q(`INSERT INTO therapists (name) VALUES ($1) RETURNING id`, [R]);
    await q(`INSERT INTO therapist_years (school_year_id, therapist_id, active) VALUES ($1, $2, true)`, [y.id, th.id]);
    const cid: Record<string, number> = {};
    for (const label of [CLASS, OTHER]) {
        const [c] = await q(`INSERT INTO school_classes (label, sort_key) VALUES ($1, $2) RETURNING id`, [label, 'zz-' + label]);
        await q(`INSERT INTO class_years (school_year_id, class_id, active) VALUES ($1, $2, true)`, [y.id, c.id]);
        cid[label] = c.id;
    }
    await q(`INSERT INTO teacher_classes (school_year_id, teacher_id, class_id, role) VALUES ($1, $2, $3, 'homeroom')`, [y.id, tid[H], cid[CLASS]]);
    for (const k of KIDS) {
        const [st] = await q(`INSERT INTO students (public_id, name, grade) VALUES ($1, $2, $3) RETURNING id`, [k.id, k.name, k.class]);
        await q(`INSERT INTO student_enrollments (student_id, school_year_id, grade, oddelenie) VALUES ($1, $2, $3, $4)`, [st.id, y.id, k.class, k.odd]);
    }
    // T already teaches the other class on Tuesday, 1st period.
    await q(`INSERT INTO lessons (school_year_id, day, day_order, ordinal, class_id, teacher_id, subject)
             VALUES ($1, 'вторник', 2, 1, $2, $3, 'Музичко')`, [y.id, cid[OTHER], tid[T]]);

    const app = Fastify();
    await app.register(portalRoutes, { year: YEAR });
    const call = async (method: string, url: string, token: string, body?: unknown) => {
        const res = await app.inject({ method: method as any, url, payload: body as any, headers: { 'x-mtb-portal-token': token } });
        let json: any = null;
        try { json = res.json(); } catch { /* not JSON */ }
        return { status: res.statusCode, body: json };
    };
    const signIn = async (name: string) => {
        const res = await app.inject({ method: 'POST', url: '/api/portal/login', payload: { username: name, password: 'ResursenCentar' } });
        return res.json().token as string;
    };
    const lessonsAt = (day: string, ordinal: number, label: string) => q(
        `SELECT l.subject, t.name AS teacher FROM lessons l JOIN school_classes c ON c.id = l.class_id LEFT JOIN teachers t ON t.id = l.teacher_id
          WHERE l.school_year_id = $1 AND l.day = $2 AND l.ordinal = $3 AND c.label = $4 ORDER BY t.name`, [y.id, day, ordinal, label]);

    try {
        const [ta, tb, th, tt, tr] = [await signIn(A), await signIn(B), await signIn(H), await signIn(T), await signIn(R)];

        console.log('a subject teacher\'s own week');
        const put = (token: string, body: unknown) => call('PUT', '/api/portal/my-lesson', token, body);
        const first = await put(ta, { day: DAY, ordinal: 2, class: CLASS, subject: 'Математика', expected: { class: null } });
        check('a free period is simply saved', first.status === 200 && first.body?.notified === 0, JSON.stringify(first.body));
        const clash = await put(tb, { day: DAY, ordinal: 2, class: CLASS, subject: 'Физичко', expected: { class: null } });
        check('another subject in the same class and period is a clash, said before saving',
            clash.status === 409 && clash.body?.clash === true && clash.body.error.includes(A) && clash.body.error.includes('Математика'),
            JSON.stringify(clash.body));
        check('and nothing was saved', (await lessonsAt(DAY, 2, CLASS)).length === 1);
        const forced = await put(tb, { day: DAY, ordinal: 2, class: CLASS, subject: 'Физичко', expected: { class: null }, force: true });
        check('„сепак запиши" saves it', forced.status === 200 && (await lessonsAt(DAY, 2, CLASS)).length === 2, JSON.stringify(forced.body));
        check('and tells both the teacher it hits and the class\'s homeroom teacher', forced.body?.notified === 2, JSON.stringify(forced.body));
        const together = await put(tb, { day: DAY, ordinal: 3, class: CLASS, subject: 'Физичко', expected: { class: null } });
        const together2 = await put(ta, { day: DAY, ordinal: 3, class: CLASS, subject: 'физичко', expected: { class: null } });
        check('the same subject together is not a clash (owner, 24 Sep)', together.status === 200 && together2.status === 200 && together2.body?.notified === 0,
            JSON.stringify(together2.body));
        const stale = await put(ta, { day: DAY, ordinal: 2, class: OTHER, subject: 'Математика', expected: { class: null } });
        check('a stale view is refused, as in Уреди настава', stale.status === 409 && stale.body?.stale === true, JSON.stringify(stale.body));

        console.log('\nwhat the colleague it hits sees');
        const weekA = await call('GET', '/api/portal/week', ta);
        const notice = (weekA.body?.notices || [])[0];
        check('a notice, with who did it and where', Boolean(notice) && notice.sentence.includes(B) && notice.sentence.includes(CLASS) && notice.open === true,
            JSON.stringify(weekA.body?.notices));
        check('and the clash stands in their week', (weekA.body?.clashes || []).some((c: any) => c.day === DAY && c.ordinal === 2 && c.class === CLASS));
        const weekH = await call('GET', '/api/portal/week', th);
        check('the homeroom teacher sees it too', (weekH.body?.notices || []).some((n: any) => n.sentence.includes('вашата паралелка')), JSON.stringify(weekH.body?.notices));
        check('marking it seen', (await call('POST', '/api/portal/notices/seen', ta, { ids: [notice.id] })).status === 200
            && (await call('GET', '/api/portal/week', ta)).body.notices[0].seen === true);
        const away = await put(tb, { day: DAY, ordinal: 2, class: null, expected: { class: CLASS } });
        check('one side moves away', away.status === 200 && (await lessonsAt(DAY, 2, CLASS)).length === 1, JSON.stringify(away.body));
        const after = await call('GET', '/api/portal/week', ta);
        check('and the notice closes by itself', after.body.notices[0].open === false);
        check('as does the clash', !(after.body.clashes || []).some((c: any) => c.day === DAY && c.ordinal === 2));

        console.log('\na homeroom teacher\'s class');
        const cls = (body: unknown, token = th) => call('PUT', '/api/portal/class-lesson', token, body);
        const busy = await cls({ class: CLASS, day: 'вторник', ordinal: 1, subject: 'Музичко', teacherId: tid[T], expected: null });
        check('a teacher who is in another class then is a clash', busy.status === 409 && busy.body.error.includes(OTHER), JSON.stringify(busy.body));
        const busyForced = await cls({ class: CLASS, day: 'вторник', ordinal: 1, subject: 'Музичко', teacherId: tid[T], expected: null, force: true });
        check('„сепак запиши" puts them there and tells them', busyForced.status === 200 && busyForced.body?.notified === 1, JSON.stringify(busyForced.body));
        const weekT = await call('GET', '/api/portal/week', tt);
        check('they see it, and that it is still open', (weekT.body?.notices || []).some((n: any) => n.open && n.sentence.includes(H)), JSON.stringify(weekT.body?.notices));
        const replace = await cls({ class: CLASS, day: DAY, ordinal: 2, subject: 'Англиски', teacherId: tid[H],
            expected: { subject: 'Математика', teacher: A } });
        check('taking another teacher\'s period is a clash', replace.status === 409 && replace.body.error.includes(A), JSON.stringify(replace.body));
        const replaced = await cls({ class: CLASS, day: DAY, ordinal: 2, subject: 'Англиски', teacherId: tid[H],
            expected: { subject: 'Математика', teacher: A }, force: true });
        check('and with „сепак" it is done, and they are told', replaced.status === 200 && replaced.body?.notified === 1, JSON.stringify(replaced.body));
        const both = await lessonsAt(DAY, 3, CLASS);
        check('a period with two lessons cannot be overwritten in one go', both.length === 2
            && (await cls({ class: CLASS, day: DAY, ordinal: 3, subject: 'Ликовно', teacherId: tid[H] })).body?.cellClash === true);
        const bLesson = (await q(`SELECT l.id FROM lessons l WHERE l.school_year_id = $1 AND l.day = $2 AND l.ordinal = 3 AND l.teacher_id = $3`,
            [y.id, DAY, tid[B]]))[0];
        const removeAsk = await call('POST', '/api/portal/class-lesson/remove', th, { lessonId: bLesson.id });
        check('taking one out asks first', removeAsk.status === 409, JSON.stringify(removeAsk.body));
        const removed = await call('POST', '/api/portal/class-lesson/remove', th, { lessonId: bLesson.id, force: true });
        check('then takes it out and tells that teacher', removed.status === 200 && removed.body?.notified === 1
            && (await lessonsAt(DAY, 3, CLASS)).length === 1, JSON.stringify(removed.body));

        console.log('\nthe owner\'s side');
        const overview = (await app.inject({ method: 'GET', url: '/api/staff-notices' })).json();
        check('the owner sees every notice, to whom', (overview.notices || []).length >= 5
            && overview.notices.some((n: any) => n.recipient === T && n.open === true), JSON.stringify(overview.notices?.map((n: any) => n.recipient)));
        check('and the clashes standing now: a teacher in two classes at once',
            (overview.teaching || []).some((c: any) => c.day === 'вторник' && c.ordinal === 1 && c.who.some((w: string) => w.includes(T))),
            JSON.stringify(overview.teaching));
        const [aEmployee] = await q(`SELECT employee_id FROM teachers WHERE name = $1`, [A]);
        const opened = (await app.inject({ method: 'POST', url: `/api/staff-accounts/${aEmployee.employee_id}/open` })).json();
        const look = String(opened.url || '').replace(/^.*#as=/, '');
        check('„Отвори го формуларот" gives a look, in the address fragment', /^\/Kolega\.html#as=[0-9a-f]{64}$/.test(opened.url || ''), JSON.stringify(opened));
        const asA = await call('GET', '/api/portal/me', look);
        check('which is that colleague\'s form, marked as the administrator\'s look', asA.body?.person?.name === A && asA.body?.acting === true, JSON.stringify(asA.body));
        check('the password is not the administrator\'s to change',
            (await call('POST', '/api/portal/password', look, { current: 'ResursenCentar', next: 'туѓа' })).status === 403);
        const fixed = await put(look, { day: 'среда', ordinal: 1, class: CLASS, subject: 'Математика', expected: { class: null } });
        check('the administrator writes in it', fixed.status === 200, JSON.stringify(fixed.body));
        const told = (await call('GET', '/api/portal/week', ta)).body?.notices || [];
        check('and the colleague is told, by the administrator', told.some((n: any) => n.author === 'Администраторот' && /среда/.test(n.sentence)),
            JSON.stringify(told.map((n: any) => n.sentence)));
        check('a made-up look opens nothing', (await call('GET', '/api/portal/me', 'e'.repeat(64))).status === 401);

        console.log('\nnobody else\'s class, and no pupils');
        check('a teacher who does not lead the class cannot change it',
            (await cls({ class: CLASS, day: 'среда', ordinal: 1, subject: 'x', teacherId: null }, ta)).status === 403);
        check('a therapist has no lessons of their own here', (await put(tr, { day: DAY, ordinal: 5, class: CLASS, subject: 'x' })).status === 403);
        const weekR = await call('GET', '/api/portal/week', tr);
        check('and is shown no timetable', weekR.status === 200 && (weekR.body?.lessons || []).length === 0);
        const kidsA = (await call('GET', '/api/portal/week', ta)).body?.classPupils || {};
        check('a teacher is shown the children of the class they teach, with their generation',
            JSON.stringify((kidsA[CLASS] || []).map((k: any) => `${k.name}|${k.oddelenie}`).sort())
                === JSON.stringify([`${KIDS[0].name}|II`, `${KIDS[1].name}|III`].sort()), JSON.stringify(kidsA));
        check('and not the children of any other class', !(OTHER in kidsA) && !JSON.stringify(kidsA).includes(KIDS[2].name));
        const kidsT = (await call('GET', '/api/portal/week', tt)).body?.classPupils || {};
        check('a teacher in two classes sees both', (kidsT[OTHER] || []).length === 1 && (kidsT[CLASS] || []).length === 2, JSON.stringify(Object.keys(kidsT)));
        check('the week never carries the id of a pupil', !JSON.stringify(weekA.body).includes('portal-week-'));
        check('a therapist gets no class list of children', JSON.stringify(weekR.body?.classPupils || {}) === '{}');
        check('without a sign-in, nothing', (await call('GET', '/api/portal/week', '')).status === 401);
    } finally {
        await app.close();
        await cleanup();
        await pool.end();
    }
    console.log(fails ? `\n${fails} failed` : '\nall good');
    process.exit(fails ? 1 : 0);
}

main().catch(async (err) => {
    console.error(err);
    await cleanup().catch(() => {});
    await pool.end().catch(() => {});
    process.exit(1);
});

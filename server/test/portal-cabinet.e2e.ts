/**
 * A therapist's own cabinet through the colleagues' door, against a real
 * database (docs/PLAN-kolegi-online.md, step 2): the same block writer as
 * Кабинети, a pupil already with another therapist is a clash said before
 * saving, „сепак запиши" books them anyway and tells that therapist, and the
 * notice closes by itself when one side moves. Only the therapist's own
 * pupils are ever named. Invented people in an invented year, all removed.
 *
 *     npx tsx test/portal-cabinet.e2e.ts     (DATABASE_URL from server/.env)
 */
import pg from 'pg';
import Fastify from 'fastify';
import 'dotenv/config';
import { portalRoutes } from '../src/routes/portal.js';

const DB = process.env.DATABASE_URL;
if (!DB) throw new Error('DATABASE_URL is required; configure it in server/.env.');
const pool = new pg.Pool({ connectionString: DB });
const q = async (text: string, args: unknown[] = []) => (await pool.query(text, args)).rows;

const YEAR = '1921/1922-cabinet';
const R1 = 'Пробна Терапевтка Кабинет Еден';
const R2 = 'Пробен Терапевт Кабинет Два';
const TAG = 'portal-cab';
const PUPILS = [
    { id: `${TAG}-1`, name: 'Пробен Ученик Кабинет Прв' },
    { id: `${TAG}-2`, name: 'Пробна Ученичка Кабинет Втора' },
    { id: `${TAG}-3`, name: 'Пробен Ученик Кабинет Трет' }
];
const CLASS = 'ПК-1';
const DAY = 'понеделник';
const BLOCK = '08:00-08:40';

let fails = 0;
const check = (label: string, ok: boolean, detail = '') => {
    if (ok) console.log(`  ok   ${label}`);
    else { fails++; console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`); }
};

async function cleanup() {
    const ids = (await q(`SELECT id FROM employees WHERE name = ANY($1::text[])`, [[R1, R2]])).map((r: any) => r.id);
    if (ids.length) {
        await q(`DELETE FROM staff_sessions WHERE employee_id = ANY($1::int[])`, [ids]);
        await q(`DELETE FROM staff_accounts WHERE employee_id = ANY($1::int[])`, [ids]);
    }
    await q(`DELETE FROM school_years WHERE label = $1`, [YEAR]);
    await q(`DELETE FROM students WHERE public_id LIKE $1`, [`${TAG}%`]);
    await q(`DELETE FROM therapists WHERE name = ANY($1::text[])`, [[R1, R2]]);
    await q(`DELETE FROM school_classes WHERE label = $1`, [CLASS]);
    await q(`DELETE FROM employees e WHERE e.name = ANY($1::text[])
              AND NOT EXISTS (SELECT 1 FROM teachers x WHERE x.employee_id = e.id)
              AND NOT EXISTS (SELECT 1 FROM therapists x WHERE x.employee_id = e.id)`, [[R1, R2]]);
}

async function main() {
    await cleanup();
    const [y] = await q(`INSERT INTO school_years (label, starts_on, ends_on, is_current)
                         VALUES ($1, '1921-09-01', '1922-08-31', false) RETURNING id`, [YEAR]);
    const [cls] = await q(`INSERT INTO school_classes (label, sort_key) VALUES ($1, 'zz-portal-cab') RETURNING id`, [CLASS]);
    await q(`INSERT INTO class_years (school_year_id, class_id, active) VALUES ($1, $2, true)`, [y.id, cls.id]);
    const rid: Record<string, number> = {};
    for (const name of [R1, R2]) {
        const [t] = await q(`INSERT INTO therapists (name) VALUES ($1) RETURNING id`, [name]);
        await q(`INSERT INTO therapist_years (school_year_id, therapist_id, active) VALUES ($1, $2, true)`, [y.id, t.id]);
        rid[name] = t.id;
    }
    const sid: Record<string, number> = {};
    for (const p of PUPILS) {
        const [s] = await q(`INSERT INTO students (public_id, name, grade) VALUES ($1, $2, $3) RETURNING id`, [p.id, p.name, CLASS]);
        await q(`INSERT INTO student_enrollments (student_id, school_year_id, grade) VALUES ($1, $2, $3)`, [s.id, y.id, CLASS]);
        sid[p.id] = s.id;
    }
    // R1 has pupils 1 and 2; R2 has pupils 1 and 3, and already sees pupil 1 on Monday at 08:00.
    for (const [therapist, pupil] of [[R1, PUPILS[0].id], [R1, PUPILS[1].id], [R2, PUPILS[0].id], [R2, PUPILS[2].id]]) {
        await q(`INSERT INTO therapist_students (school_year_id, therapist_id, student_id) VALUES ($1, $2, $3)`, [y.id, rid[therapist], sid[pupil]]);
    }
    await q(`INSERT INTO schedule_slots (school_year_id, day, day_order, time_slot, therapist_id, student_id, source)
             VALUES ($1, $2, 1, $3, $4, $5, 'api')`, [y.id, DAY, BLOCK, rid[R2], sid[PUPILS[0].id]]);

    const app = Fastify();
    await app.register(portalRoutes, { year: YEAR });
    const call = async (method: string, url: string, token: string, body?: unknown) => {
        const res = await app.inject({ method: method as any, url, payload: body as any, headers: { 'x-mtb-portal-token': token } });
        let json: any = null;
        try { json = res.json(); } catch { /* not JSON */ }
        return { status: res.statusCode, body: json };
    };
    const signIn = async (name: string) =>
        (await app.inject({ method: 'POST', url: '/api/portal/login', payload: { username: name, password: 'ResursenCentar' } })).json().token as string;
    const slotsOf = (therapist: string) => q(
        `SELECT sl.day, sl.time_slot, s.public_id FROM schedule_slots sl JOIN students s ON s.id = sl.student_id
          WHERE sl.school_year_id = $1 AND sl.therapist_id = $2 ORDER BY sl.day, sl.time_slot`, [y.id, rid[therapist]]);

    try {
        const [t1, t2] = [await signIn(R1), await signIn(R2)];

        console.log('the cabinet in the week');
        const week = await call('GET', '/api/portal/week', t1);
        const cab = week.body?.cabinet;
        check('a therapist gets their cabinet', week.status === 200 && Array.isArray(cab?.bells) && cab.bells.some((b: any) => b.time === BLOCK),
            JSON.stringify(cab?.bells));
        check('with their own pupils only', JSON.stringify((cab?.pupils || []).map((p: any) => p.publicId).sort())
            === JSON.stringify([PUPILS[0].id, PUPILS[1].id].sort()), JSON.stringify(cab?.pupils));
        check('and where those pupils are with somebody else', (cab?.elsewhere || []).some((e: any) => e.publicId === PUPILS[0].id && e.therapist === R2 && e.day === DAY));
        check('never another therapist\'s pupil', !JSON.stringify(week.body).includes(PUPILS[2].name) && !JSON.stringify(week.body).includes(PUPILS[2].id));

        console.log('\na block of one\'s own');
        const term = (token: string, body: unknown) => call('PUT', '/api/portal/term', token, body);
        const free = await term(t1, { day: DAY, time: '08:45-09:25', pupils: [PUPILS[1].id], expected: [] });
        check('a free block is simply saved', free.status === 200 && free.body?.notified === 0, JSON.stringify(free.body));
        const clash = await term(t1, { day: DAY, time: BLOCK, pupils: [PUPILS[0].id], expected: [] });
        check('a pupil with another therapist then is a clash, said before saving',
            clash.status === 409 && clash.body?.clash === true && clash.body.error.includes(R2) && clash.body.error.includes(PUPILS[0].name),
            JSON.stringify(clash.body));
        check('and nothing was saved', (await slotsOf(R1)).length === 1);
        const forced = await term(t1, { day: DAY, time: BLOCK, pupils: [PUPILS[0].id], expected: [], force: true });
        check('„сепак запиши" books them', forced.status === 200 && (await slotsOf(R1)).length === 2, JSON.stringify(forced.body));
        check('and tells the other therapist', forced.body?.notified === 1);
        const notices = (await call('GET', '/api/portal/week', t2)).body?.notices || [];
        check('who sees who did it, whom and when, and that it is open',
            notices.some((n: any) => n.kind === 'term' && n.open && n.sentence.includes(R1) && n.sentence.includes(PUPILS[0].name)),
            JSON.stringify(notices));
        const stranger = await term(t1, { day: DAY, time: '09:40-10:20', pupils: [PUPILS[2].id], expected: [] });
        check('a pupil from somebody else\'s list is refused', stranger.status === 409 && /вашиот список/.test(stranger.body?.error || ''), JSON.stringify(stranger.body));
        const stale = await term(t1, { day: DAY, time: '08:45-09:25', pupils: [], expected: [] });
        check('a stale view is refused', stale.status === 409 && stale.body?.stale === true, JSON.stringify(stale.body));

        console.log('\none side moves, and it closes');
        const moved = await term(t2, { day: DAY, time: BLOCK, pupils: [], expected: [PUPILS[0].id] });
        check('the other therapist clears their block', moved.status === 200, JSON.stringify(moved.body));
        const after = (await call('GET', '/api/portal/week', t2)).body?.notices || [];
        check('and the notice closes by itself', after.some((n: any) => n.kind === 'term' && n.open === false), JSON.stringify(after));

        console.log('\nnothing for somebody without a cabinet');
        check('a therapist\'s block written by nobody signed in is refused', (await term('', { day: DAY, time: BLOCK, pupils: [] })).status === 401);
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

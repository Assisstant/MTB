/**
 * Дежурства against a real database (migration 043; owner, 25 Sep 2026):
 * the administrator sets the list, closes a day, gives a day away and marks
 * anybody away; a colleague on the list sees the month and marks only their
 * OWN absence, from today on; a colleague who is not on it sees nothing.
 *
 * In-process like portal.e2e.ts, in a school year of its own far in the future
 * — so „today or later" is every day of it — with invented people (rule 1).
 * Everything it makes is removed afterwards.
 *
 *     npx tsx test/duty.e2e.ts     (DATABASE_URL from server/.env)
 */
import pg from 'pg';
import Fastify from 'fastify';
import 'dotenv/config';
import { portalRoutes } from '../src/routes/portal.js';
import { dutyRoutes } from '../src/routes/duty.js';
import { workingDays } from '../src/lib/duty.js';

const DB = process.env.DATABASE_URL;
if (!DB) throw new Error('DATABASE_URL is required; configure it in server/.env.');
const pool = new pg.Pool({ connectionString: DB });
const q = async (text: string, args: unknown[] = []) => (await pool.query(text, args)).rows;

const YEAR = '2098/2099-duty';
const A = 'Дежурна Прва';
const B = 'Дежурен Втор';
const C = 'Дежурна Трета';
const OUT = 'Надвор Дежурен';
const THERAPISTS = [A, B, C];
const TEACHERS = [OUT];
const PEOPLE = [...THERAPISTS, ...TEACHERS];

let fails = 0;
const check = (label: string, ok: boolean, detail = '') => {
    if (ok) console.log(`  ok   ${label}`);
    else { fails++; console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`); }
};
const checkEq = (label: string, actual: unknown, expected: unknown) => {
    const same = JSON.stringify(actual) === JSON.stringify(expected);
    check(label, same, same ? '' : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};

async function cleanup() {
    const ids = (await q(`SELECT id FROM employees WHERE name = ANY($1::text[])`, [PEOPLE])).map((r: any) => r.id);
    await q(`DELETE FROM school_years WHERE label = $1`, [YEAR]);
    if (ids.length) {
        await q(`DELETE FROM staff_sessions WHERE employee_id = ANY($1::int[])`, [ids]);
        await q(`DELETE FROM staff_accounts WHERE employee_id = ANY($1::int[])`, [ids]);
    }
    await q(`DELETE FROM therapists WHERE name = ANY($1::text[])`, [THERAPISTS]);
    await q(`DELETE FROM teachers WHERE name = ANY($1::text[])`, [TEACHERS]);
    // Migration 035 keeps a staff identity when the profile goes; the
    // fixture's must go too, or check:names learns these invented names.
    await q(`DELETE FROM employees e WHERE e.name = ANY($1::text[])
              AND NOT EXISTS (SELECT 1 FROM teachers x WHERE x.employee_id = e.id)
              AND NOT EXISTS (SELECT 1 FROM therapists x WHERE x.employee_id = e.id)`, [PEOPLE]);
}

async function main() {
    await cleanup();
    const [y] = await q(`INSERT INTO school_years (label, starts_on, ends_on, is_current)
                         VALUES ($1, '2098-09-01', '2099-08-31', false) RETURNING id`, [YEAR]);
    for (const name of THERAPISTS) {
        const [t] = await q(`INSERT INTO therapists (name) VALUES ($1) RETURNING id`, [name]);
        await q(`INSERT INTO therapist_years (school_year_id, therapist_id, active) VALUES ($1, $2, true)`, [y.id, t.id]);
    }
    for (const name of TEACHERS) {
        const [t] = await q(`INSERT INTO teachers (name, kind) VALUES ($1, 'pred') RETURNING id`, [name]);
        await q(`INSERT INTO teacher_years (school_year_id, teacher_id, active) VALUES ($1, $2, true)`, [y.id, t.id]);
    }
    const emp = new Map((await q(`SELECT id, name FROM employees WHERE name = ANY($1::text[])`, [PEOPLE]))
        .map((r: any) => [r.name, Number(r.id)]));

    const app = Fastify({ trustProxy: false });
    await app.register(portalRoutes, { year: YEAR });
    await app.register(dutyRoutes);
    const call = async (method: string, url: string, body?: unknown, token?: string) => {
        const res = await app.inject({ method: method as any, url, payload: body as any,
            headers: token ? { 'x-mtb-portal-token': token } : {} });
        let json: any = null;
        try { json = res.json(); } catch { /* not JSON */ }
        return { status: res.statusCode, body: json };
    };
    const days = workingDays('2098-09-01', '2098-09-30');
    const month = async () => (await call('GET', `/api/duty?year=${encodeURIComponent(YEAR)}&month=2098-09`)).body;
    const names = (m: any) => m.days.slice(0, 6).map((d: any) => d.name);

    try {
        console.log('the administrator sets the list');
        const empty = await month();
        check('an empty list first, with everybody who works this year to choose from',
            empty.members.length === 0 && PEOPLE.every((n) => empty.candidates.some((c: any) => c.name === n)),
            JSON.stringify(empty.candidates));
        const setup = await call('PUT', '/api/duty/setup', { year: YEAR, startsOn: '2098-09-01',
            members: [A, B, C].map((n) => ({ employeeId: emp.get(n) })) });
        checkEq('the list is saved in its order', [setup.status, setup.body?.members], [200, 3]);
        let m = await month();
        checkEq('and the month goes round it, a working day each', names(m), [A, B, C, A, B, C]);
        checkEq('with each person\'s number on the list', m.days.slice(0, 3).map((d: any) => d.number), [1, 2, 3]);
        checkEq('twice on the list is refused',
            (await call('PUT', '/api/duty/setup', { year: YEAR, startsOn: '2098-09-01',
                members: [{ employeeId: emp.get(A) }, { employeeId: emp.get(A) }] })).status, 400);

        console.log('\nclosed days, days given away, anybody away');
        await call('PUT', '/api/duty/day', { year: YEAR, date: days[1], closed: true, note: 'екскурзија' });
        m = await month();
        checkEq('a closed day has no duty and moves nobody', names(m), [A, null, B, C, A, B]);
        checkEq('and says why', m.days[1].note, 'екскурзија');
        checkEq('a weekend is refused', (await call('PUT', '/api/duty/day',
            { year: YEAR, date: '2098-09-06', closed: true })).status, 400);
        await call('PUT', '/api/duty/day', { year: YEAR, date: days[1], closed: false });
        checkEq('clearing it puts the day back', names(await month()), [A, B, C, A, B, C]);

        await call('PUT', '/api/duty/absence', { year: YEAR, date: days[0], employeeId: emp.get(A), absent: true });
        m = await month();
        checkEq('somebody away is covered, and keeps their place', names(m), [B, A, C, B, A, C]);
        check('the cover says whom it covers', m.days[0].how === 'cover' && m.days[0].covers[0]?.name === A,
            JSON.stringify(m.days[0]));
        await call('PUT', '/api/duty/absence', { year: YEAR, date: days[0], employeeId: emp.get(A), absent: false });

        await call('PUT', '/api/duty/day', { year: YEAR, date: days[0], closed: false, assignedEmployeeId: emp.get(C) });
        m = await month();
        checkEq('a day given by agreement: whoever was next is still next', names(m), [C, A, B, C, A, B]);
        await call('PUT', '/api/duty/day', { year: YEAR, date: days[0], closed: false, assignedEmployeeId: null });

        const october = await call('GET', `/api/duty?year=${encodeURIComponent(YEAR)}&month=2098-10`);
        const september = await month();
        const lastSept = september.days[september.days.length - 1].name;
        const order = [A, B, C];
        checkEq('October continues where September ended', october.body.days[0].name,
            order[(order.indexOf(lastSept) + 1) % 3]);

        console.log('\na colleague on the list');
        const loginA = await call('POST', '/api/portal/login', { username: 'ДежурнаПрва', password: 'ResursenCentar' });
        const tokenA = loginA.body?.token;
        check('signs in', loginA.status === 200 && Boolean(tokenA), JSON.stringify(loginA.body));
        checkEq('is told they are on the duty list', (await call('GET', '/api/portal/me', undefined, tokenA)).body?.duty, true);
        const seen = await call('GET', '/api/portal/duty?month=2098-09', undefined, tokenA);
        checkEq('sees the same month the administrator sees', seen.body?.days?.slice(0, 6).map((d: any) => d.name), [A, B, C, A, B, C]);
        checkEq('and knows which days are theirs', seen.body?.me, emp.get(A));
        check('does not get the list of everybody who could be on it', seen.body && !('candidates' in seen.body));

        const mine = await call('PUT', '/api/portal/duty/absence', { date: days[0], absent: true }, tokenA);
        checkEq('marks themselves away on a day', mine.status, 200);
        checkEq('and the rota moves for everyone',
            (await call('GET', '/api/portal/duty?month=2098-09', undefined, tokenA)).body?.days?.slice(0, 3).map((d: any) => d.name), [B, A, C]);
        checkEq('the mark says who made it',
            (await q(`SELECT marked_by FROM duty_absences a JOIN school_years y ON y.id = a.school_year_id
                       WHERE y.label = $1 AND a.employee_id = $2`, [YEAR, emp.get(A)]))[0]?.marked_by, A);
        await call('PUT', '/api/portal/duty/absence', { date: days[0], absent: false }, tokenA);
        checkEq('and can take it back', (await call('GET', '/api/portal/duty?month=2098-09', undefined, tokenA)).body?.days?.[0]?.name, A);
        checkEq('a weekend is refused here too', (await call('PUT', '/api/portal/duty/absence',
            { date: '2098-09-06', absent: true }, tokenA)).status, 400);
        checkEq('and a day outside the year', (await call('PUT', '/api/portal/duty/absence',
            { date: '2100-01-04', absent: true }, tokenA)).status, 400);

        console.log('\na colleague who is not on it');
        const loginOut = await call('POST', '/api/portal/login', { username: 'НадворДежурен', password: 'ResursenCentar' });
        const tokenOut = loginOut.body?.token;
        checkEq('is told they are not on the duty list', (await call('GET', '/api/portal/me', undefined, tokenOut)).body?.duty, false);
        checkEq('and cannot read it', (await call('GET', '/api/portal/duty?month=2098-09', undefined, tokenOut)).status, 403);
        checkEq('nor mark anything in it', (await call('PUT', '/api/portal/duty/absence', { date: days[2], absent: true }, tokenOut)).status, 403);
        checkEq('without a sign-in, nothing', (await call('GET', '/api/portal/duty?month=2098-09')).status, 401);
    } finally {
        await app.close();
        await cleanup();
        await pool.end();
    }
    console.log(fails ? `\n${fails} failed` : '\nall good');
    process.exit(fails ? 1 : 0);
}

main().catch(async (err) => { console.error(err); await cleanup().catch(() => {}); await pool.end().catch(() => {}); process.exit(1); });

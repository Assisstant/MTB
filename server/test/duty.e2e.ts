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
import { readFile } from 'node:fs/promises';
import { portalRoutes } from '../src/routes/portal.js';
import { dutyRoutes } from '../src/routes/duty.js';
import { workingDays } from '../src/lib/duty.js';
import { installColleagueBoundary } from '../src/lib/colleague.js';
import { installCloudAuth } from '../src/lib/cloud-auth.js';

const DB = process.env.DATABASE_URL;
if (!DB) throw new Error('DATABASE_URL is required; configure it in server/.env.');
const pool = new pg.Pool({ connectionString: DB });
const tokenDb = new pg.Client({ connectionString: DB });
const tokenSchema = `duty_link_routes_test_${process.pid}`;
const q = async (text: string, args: unknown[] = []) => (await pool.query(text, args)).rows;

const YEAR = '2098/2099-duty';
const A = 'Дежурна Прва';
const B = 'Дежурен Втор';
const C = 'Дежурна Трета';
const OUT = 'Надвор Дежурен';
const THERAPISTS = [A, B, C];
const TEACHERS = [OUT];
const PEOPLE = [...THERAPISTS, ...TEACHERS];
const CLOUD = { MTB_CLOUD_AUTH: 'basic', MTB_CLOUD_USER: 'invented-duty-owner',
    MTB_CLOUD_PASSWORD: 'invented-duty-password-only-for-tests', MTB_CLOUD_ORIGIN: 'https://duty.example' };
const AUTHORIZATION = 'Basic ' + Buffer.from(`${CLOUD.MTB_CLOUD_USER}:${CLOUD.MTB_CLOUD_PASSWORD}`).toString('base64');
const SERVICE = 'invented-duty-service-key-only-for-tests';

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
    const previousSignin = process.env.MTB_REQUIRE_SIGNIN;
    const previousService = process.env.MTB_SERVICE_KEY;
    delete process.env.MTB_REQUIRE_SIGNIN;
    process.env.MTB_SERVICE_KEY = SERVICE;
    // Test new credentials only in a disposable schema, not this installation.
    await tokenDb.connect();
    await tokenDb.query(`CREATE SCHEMA ${tokenSchema}`);
    await tokenDb.query(`SET search_path=${tokenSchema}`);
    await tokenDb.query(await readFile(new URL('../../database/migrations/048_duty_admin_links.sql', import.meta.url), 'utf8'));
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
    await installCloudAuth(app, CLOUD);
    installColleagueBoundary(app);
    await app.register(portalRoutes, { year: YEAR });
    await app.register(dutyRoutes, { year: YEAR, delegationDb: tokenDb });
    const call = async (method: string, url: string, body?: unknown, token?: string, dutyAdminToken?: string) => {
        const res = await app.inject({ method: method as any, url, payload: body as any,
            headers: {
                origin: CLOUD.MTB_CLOUD_ORIGIN,
                // Only the simulated owner's calls carry the outer credentials.
                ...(!token && !dutyAdminToken ? { authorization: AUTHORIZATION, 'x-mtb-service-key': SERVICE } : {}),
                ...(token ? { 'x-mtb-portal-token': token } : {}),
                ...(dutyAdminToken ? { 'x-mtb-duty-admin-token': dutyAdminToken } : {})
            } });
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
        const flag = (n: string) => empty.candidates.find((c: any) => c.name === n)?.cabinet;
        check('the cabinets are marked as such, a teacher is not',
            THERAPISTS.every((n) => flag(n) === true) && TEACHERS.every((n) => flag(n) === false),
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
        await call('PUT', '/api/duty/day', { year: YEAR, date: days[1], closed: false, note: 'екскурзија' });
        checkEq('an excursion with duty keeps the normal count', names(await month()), [A, B, C, A, B, C]);
        await call('PUT', '/api/duty/day', { year: YEAR, date: days[1], closed: true, note: 'екскурзија' });
        m = await month();
        checkEq('a closed day has no duty and moves nobody', names(m), [A, null, B, C, A, B]);
        checkEq('and says why', m.days[1].note, 'екскурзија');
        checkEq('a weekend is refused', (await call('PUT', '/api/duty/day',
            { year: YEAR, date: '2098-09-06', closed: true })).status, 400);
        await call('PUT', '/api/duty/day', { year: YEAR, date: days[1], closed: false, note: 'екскурзија' });
        checkEq('removing only the pause restores normal counting while retaining the event', names(await month()), [A, B, C, A, B, C]);
        checkEq('the event note is unchanged when duty resumes', (await month()).days[1].note, 'екскурзија');

        await call('PUT', '/api/duty/absence', { year: YEAR, date: days[0], employeeId: emp.get(A), absent: true });
        m = await month();
        checkEq('somebody away is skipped and the next uses their own turn once', names(m), [B, C, A, B, C, A]);
        check('the cover says whom it covers', m.days[0].how === 'cover' && m.days[0].covers[0]?.name === A,
            JSON.stringify(m.days[0]));
        await call('PUT', '/api/duty/absence', { year: YEAR, date: days[0], employeeId: emp.get(A), absent: false });

        checkEq('a new one-sided agreement is refused in favour of a two-date swap',
            (await call('PUT', '/api/duty/day', { year: YEAR, date: days[0], closed: false, assignedEmployeeId: emp.get(C) })).status, 400);
        // An existing installation may still carry this legacy shape.
        await q('INSERT INTO duty_days(school_year_id,day,closed,assigned_employee_id) VALUES($1,$2,false,$3)', [y.id, days[0], emp.get(C)]);
        checkEq('a stored legacy assignment may be retained when editing its note',
            (await call('PUT', '/api/duty/day', { year: YEAR, date: days[0], closed: false, assignedEmployeeId: emp.get(C), note: 'стар запис' })).status, 200);
        m = await month();
        checkEq('the legacy assignment consumes its turn; next cycle uses the original list', names(m), [C, A, B, A, B, C]);
        checkEq('the stored assignment is returned independently of its displayed name', m.days[0].assignedEmployeeId, emp.get(C));
        await call('PUT', '/api/duty/day', { year: YEAR, date: days[0], closed: false, assignedEmployeeId: null });

        console.log('\na swap between two colleagues');
        const sw = await call('PUT', '/api/duty/swap', { year: YEAR, note: 'договор',
            first: { date: days[2], employeeId: emp.get(C) }, second: { date: days[0], employeeId: emp.get(A) } });
        checkEq('two colleagues trade days', sw.status, 200);
        m = await month();
        checkEq('the two days trade names, and the list goes on untouched', names(m), [C, B, A, A, B, C]);
        check('each day says whom it was traded with, and on which day',
            m.days[0].how === 'swap' && m.days[0].swap?.name === A && m.days[0].swap?.date === days[2] && m.days[0].swap?.note === 'договор',
            JSON.stringify(m.days[0]));
        checkEq('a day already traded is refused', (await call('PUT', '/api/duty/swap', { year: YEAR,
            first: { date: days[0], employeeId: emp.get(C) }, second: { date: days[1], employeeId: emp.get(B) } })).status, 409);
        checkEq('a swap stating the wrong person for a day is refused — the deal is between those two',
            (await call('PUT', '/api/duty/swap', { year: YEAR,
                first: { date: days[1], employeeId: emp.get(A) }, second: { date: days[4], employeeId: emp.get(B) } })).status, 409);
        await call('PUT', '/api/duty/absence', { year: YEAR, date: days[0], employeeId: emp.get(A), absent: true });
        m = await month();
        check('when a day of the swap is no longer theirs, the swap stops applying and is reported',
            m.days.every((d: any) => d.how !== 'swap') && m.staleSwaps?.length === 1 && m.staleSwaps[0].first.name === A,
            JSON.stringify(m.staleSwaps));
        await call('PUT', '/api/duty/absence', { year: YEAR, date: days[0], employeeId: emp.get(A), absent: false });
        checkEq('a swap is taken back', (await call('POST', '/api/duty/swap/remove', { year: YEAR, id: sw.body.id })).status, 200);
        checkEq('and the days are as before', names(await month()), [A, B, C, A, B, C]);
        checkEq('a swap across cycles cannot introduce a duplicate colleague',
            (await call('PUT', '/api/duty/swap', { year: YEAR,
                first: { date: days[1], employeeId: emp.get(B) }, second: { date: days[3], employeeId: emp.get(A) } })).status, 409);
        await call('PUT', '/api/duty/absence', { year: YEAR, date: days[0], employeeId: emp.get(A), absent: true });
        const afterAbsence = await call('PUT', '/api/duty/swap', { year: YEAR,
            first: { date: days[0], employeeId: emp.get(B) }, second: { date: days[1], employeeId: emp.get(C) } });
        checkEq('the next colleague after a skip can exchange within that cycle', afterAbsence.status, 200);
        checkEq('neither colleague is repeated by that exchange', names(await month()), [C, B, A, B, C, A]);
        await call('POST', '/api/duty/swap/remove', { year: YEAR, id: afterAbsence.body.id });
        await call('PUT', '/api/duty/absence', { year: YEAR, date: days[0], employeeId: emp.get(A), absent: false });

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

        console.log('\na permanent, revocable duty-administrator link');
        process.env.MTB_REQUIRE_SIGNIN = '1';
        const made = await call('POST', '/api/duty/delegations', { hours: null });
        const capability = String(made.body?.url || '').match(/#duty-admin=([A-Za-z0-9_-]{43})$/)?.[1] || '';
        check('the owner can create a link whose token stays in the URL fragment',
            made.status === 200 && Boolean(capability) && Boolean(made.body?.link?.id));
        const listed = await call('GET', '/api/duty/delegations');
        checkEq('the permanent link has no expiry', made.body?.link?.expiresAt, null);
        check('the server lists its lifetime but never returns the raw token again',
            listed.body?.links?.length === 1 && !JSON.stringify(listed.body).includes(capability), JSON.stringify(listed.body));
        checkEq('the capability alone is not a sign-in',
            (await call('GET', '/api/portal/duty-admin?month=2098-09', undefined, undefined, capability)).status, 401);
        checkEq('an ordinary colleague session alone is not an administrator',
            (await call('GET', '/api/portal/duty-admin?month=2098-09', undefined, tokenA)).status, 403);
        for (const method of ['GET', 'POST', 'DELETE']) {
            checkEq(`a colleague cannot ${method} the owner's links`,
                (await call(method, '/api/duty/delegations', method === 'POST' ? { hours: 168 } : undefined, tokenA, capability)).status, 401);
        }
        checkEq('the capability grants no access to account administration',
            (await call('GET', '/api/staff-accounts', undefined, tokenA, capability)).status, 401);
        // Even with the owner's outer cloud cookie, an enforced installation
        // still requires its separate inner administrator identity.
        checkEq('outer credentials and a duty link cannot mint further admin links',
            (await app.inject({ method: 'POST', url: '/api/duty/delegations', payload: { hours: 168 },
                headers: { authorization: AUTHORIZATION, origin: CLOUD.MTB_CLOUD_ORIGIN,
                    'x-mtb-portal-token': tokenA, 'x-mtb-duty-admin-token': capability } })).statusCode, 401);
        const delegatedMonth = await call('GET', '/api/portal/duty-admin?month=2098-09', undefined, tokenA, capability);
        check('together they open only the duty administrator view', delegatedMonth.status === 200
            && delegatedMonth.body?.adminMode?.kind === 'link' && delegatedMonth.body?.candidates?.length === PEOPLE.length,
            JSON.stringify(delegatedMonth.body));
        const delegatedSwap = await call('PUT', '/api/portal/duty-admin/swap', { year: YEAR, note: 'временски линк',
            first: { date: days[0], employeeId: emp.get(A) }, second: { date: days[2], employeeId: emp.get(C) } }, tokenA, capability);
        checkEq('the delegated administrator can make a swap', delegatedSwap.status, 200);
        checkEq('and can take that same swap back', (await call('POST', '/api/portal/duty-admin/swap/remove',
            { year: YEAR, id: delegatedSwap.body?.id }, tokenA, capability)).status, 200);
        await call('PUT', '/api/portal/duty-admin/absence',
            { year: YEAR, date: days[0], employeeId: emp.get(B), absent: true }, tokenA, capability);
        checkEq('delegated absence changes name the colleague who made them',
            (await q('SELECT marked_by FROM duty_absences WHERE school_year_id = $1 AND employee_id = $2', [y.id, emp.get(B)]))[0]?.marked_by, A);
        await call('PUT', '/api/portal/duty-admin/absence',
            { year: YEAR, date: days[0], employeeId: emp.get(B), absent: false }, tokenA, capability);
        const revoked = await call('DELETE', '/api/duty/delegations');
        checkEq('the owner can revoke every shared link immediately', revoked.body?.revoked, 1);
        checkEq('a revoked link stops at the server even if the browser kept it',
            (await call('GET', '/api/portal/duty-admin?month=2098-09', undefined, tokenA, capability)).status, 403);
        for (const [method, path] of [['PUT', 'setup'], ['PUT', 'day'], ['PUT', 'absence'], ['PUT', 'swap'], ['POST', 'swap/remove']]) {
            checkEq(`a revoked link cannot write ${path}`, (await call(method, '/api/portal/duty-admin/' + path,
                { year: YEAR }, tokenA, capability)).status, 403);
        }

        const mine = await call('PUT', '/api/portal/duty/absence', { date: days[0], absent: true }, tokenA);
        checkEq('marks themselves away on a day', mine.status, 200);
        checkEq('and everybody sees the skipped turn with no duplicate stand-in',
            (await call('GET', '/api/portal/duty?month=2098-09', undefined, tokenA)).body?.days?.slice(0, 3).map((d: any) => d.name), [B, C, A]);
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
        const trusted = await call('POST', '/api/duty/delegations', { hours: 2 });
        const trustedToken = trusted.body.url.split('#duty-admin=')[1];
        checkEq('an explicit admin link lets a trusted colleague outside the rota manage it',
            (await call('GET', '/api/portal/duty-admin?month=2098-09', undefined, tokenOut, trustedToken)).status, 200);
        await q('UPDATE teacher_years SET active = false WHERE school_year_id = $1', [y.id]);
        checkEq('the link does not outlive the colleague\'s active employment this year',
            (await call('GET', '/api/portal/duty-admin?month=2098-09', undefined, tokenOut, trustedToken)).status, 403);
        checkEq('without a sign-in, nothing', (await call('GET', '/api/portal/duty?month=2098-09')).status, 401);
    } finally {
        await app.close();
        await tokenDb.query(`DROP SCHEMA ${tokenSchema} CASCADE`);
        await tokenDb.end();
        if (previousSignin === undefined) delete process.env.MTB_REQUIRE_SIGNIN;
        else process.env.MTB_REQUIRE_SIGNIN = previousSignin;
        if (previousService === undefined) delete process.env.MTB_SERVICE_KEY;
        else process.env.MTB_SERVICE_KEY = previousService;
        await cleanup();
        await pool.end();
    }
    console.log(fails ? `\n${fails} failed` : '\nall good');
    process.exit(fails ? 1 : 0);
}

main().catch(async (err) => {
    console.error(err);
    await tokenDb.query(`DROP SCHEMA IF EXISTS ${tokenSchema} CASCADE`).catch(() => {});
    await tokenDb.end().catch(() => {});
    await cleanup().catch(() => {});
    await pool.end().catch(() => {});
    process.exit(1);
});

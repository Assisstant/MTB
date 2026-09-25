/**
 * The colleagues' door against a real database (docs/PLAN-kolegi-online.md):
 * signing in with your own name in either script, the initial password, the
 * offered change, the administrator's reset, and the limits.
 *
 * In-process like form-replies.e2e.ts, with the portal told to use a school
 * year of its own, so no invented person is ever put on the real year's
 * lists (rule 1). Everything it makes is removed afterwards.
 *
 *     npx tsx test/portal.e2e.ts     (DATABASE_URL from server/.env)
 */
import pg from 'pg';
import Fastify from 'fastify';
import 'dotenv/config';
import { portalRoutes } from '../src/routes/portal.js';

const DB = process.env.DATABASE_URL;
if (!DB) throw new Error('DATABASE_URL is required; configure it in server/.env.');
const pool = new pg.Pool({ connectionString: DB });
const q = async (text: string, args: unknown[] = []) => (await pool.query(text, args)).rows;

const YEAR = '1919/1920-portal';
const TEACHER = 'Пробна Наставничка Портал';
const THERAPIST = 'Пробен Терапевт Портал';
const TWICE = 'Двојно Пробно Име';
const OFF_LIST = 'Надвор Пробен Портал';
const CLASS = 'ПП-1';
const TEACHERS = [TEACHER, TWICE, OFF_LIST];
const THERAPISTS = [THERAPIST, TWICE];

let fails = 0;
const check = (label: string, ok: boolean, detail = '') => {
    if (ok) console.log(`  ok   ${label}`);
    else { fails++; console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`); }
};

async function cleanup() {
    const people = [...TEACHERS, ...THERAPISTS];
    const ids = (await q(`SELECT id FROM employees WHERE name = ANY($1::text[])`, [people])).map((r: any) => r.id);
    if (ids.length) {
        await q(`DELETE FROM staff_sessions WHERE employee_id = ANY($1::int[])`, [ids]);
        await q(`DELETE FROM staff_accounts WHERE employee_id = ANY($1::int[])`, [ids]);
        await q(`DELETE FROM schedule_notices WHERE recipient_employee_id = ANY($1::int[]) OR author_employee_id = ANY($1::int[])`, [ids]);
    }
    await q(`DELETE FROM school_years WHERE label = $1`, [YEAR]);
    await q(`DELETE FROM teachers WHERE name = ANY($1::text[])`, [TEACHERS]);
    await q(`DELETE FROM therapists WHERE name = ANY($1::text[])`, [THERAPISTS]);
    await q(`DELETE FROM school_classes WHERE label = $1`, [CLASS]);
    await q(`DELETE FROM employees e WHERE e.name = ANY($1::text[])
              AND NOT EXISTS (SELECT 1 FROM teachers x WHERE x.employee_id = e.id)
              AND NOT EXISTS (SELECT 1 FROM therapists x WHERE x.employee_id = e.id)`, [people]);
}

async function main() {
    await cleanup();
    const [y] = await q(`INSERT INTO school_years (label, starts_on, ends_on, is_current)
                         VALUES ($1, '1919-09-01', '1920-08-31', false) RETURNING id`, [YEAR]);
    for (const name of TEACHERS) {
        const [t] = await q(`INSERT INTO teachers (name, kind) VALUES ($1, 'odd') RETURNING id`, [name]);
        if (name !== OFF_LIST) await q(`INSERT INTO teacher_years (school_year_id, teacher_id, active) VALUES ($1, $2, true)`, [y.id, t.id]);
    }
    for (const name of THERAPISTS) {
        const [t] = await q(`INSERT INTO therapists (name) VALUES ($1) RETURNING id`, [name]);
        await q(`INSERT INTO therapist_years (school_year_id, therapist_id, active) VALUES ($1, $2, true)`, [y.id, t.id]);
    }
    const [cls] = await q(`INSERT INTO school_classes (label, sort_key) VALUES ($1, 'zz-portal') RETURNING id`, [CLASS]);
    const [teacher] = await q(`SELECT id, employee_id FROM teachers WHERE name = $1`, [TEACHER]);
    await q(`INSERT INTO teacher_classes (school_year_id, teacher_id, class_id, role) VALUES ($1, $2, $3, 'homeroom')`, [y.id, teacher.id, cls.id]);

    const app = Fastify({ trustProxy: false });
    await app.register(portalRoutes, { year: YEAR });
    const call = async (method: string, url: string, body?: unknown, token?: string) => {
        const res = await app.inject({
            method: method as any, url, payload: body as any,
            headers: token ? { 'x-mtb-portal-token': token } : {}
        });
        let json: any = null;
        try { json = res.json(); } catch { /* not JSON */ }
        return { status: res.statusCode, body: json };
    };
    const login = (username: string, password: string) => call('POST', '/api/portal/login', { username, password });

    try {
        console.log('signing in with your own name');
        const latin = await login('ProbnaNastavnichkaPortal', 'ResursenCentar');
        check('the name in Latin, with the initial password', latin.status === 200 && /^[0-9a-f]{64}$/.test(latin.body?.token || ''), JSON.stringify(latin.body));
        check('says the initial password is still in use', latin.body?.initialPassword === true);
        check('and hands out the username in both scripts',
            latin.body?.usernames?.latin === 'ProbnaNastavnichkaPortal' && latin.body?.usernames?.cyrillic === 'ПробнаНаставничкаПортал',
            JSON.stringify(latin.body?.usernames));
        const cyr = await login('ПробнаНаставничкаПортал', 'РесурсенЦентар');
        check('the name in Cyrillic, with the Cyrillic password', cyr.status === 200);
        check('in any letter case', (await login('probnanastavnickaportal', 'resursencentar')).status === 200);
        check('a wrong password is refused', (await login('ProbnaNastavnichkaPortal', 'Resursen')).status === 401);
        check('a stranger is refused the same way', (await login('NekojDrug', 'ResursenCentar')).status === 401);
        const twice = await login('DvojnoProbnoIme', 'ResursenCentar');
        check('two people with one name: neither is signed in, and it says why', twice.status === 409 && twice.body?.ambiguous === true, JSON.stringify(twice.body));
        check('somebody on no list of the year cannot sign in', (await login('NadvorProbenPortal', 'ResursenCentar')).status === 401);

        console.log('\nwho you are, and what your form is made of');
        const me = await call('GET', '/api/portal/me', undefined, latin.body.token);
        check('the session says who', me.status === 200 && me.body?.person?.name === TEACHER, JSON.stringify(me.body));
        check('a teacher who leads a class has both roles', JSON.stringify(me.body?.roles) === JSON.stringify(['teacher', 'homeroom']), JSON.stringify(me.body?.roles));
        check('with the class', (me.body?.teacher?.classes || []).some((c: any) => c.label === CLASS && c.role === 'homeroom'));
        const therapist = await login('ProbenTerapevtPortal', 'ResursenCentar');
        const tme = await call('GET', '/api/portal/me', undefined, therapist.body?.token);
        check('a therapist is a therapist', JSON.stringify(tme.body?.roles) === JSON.stringify(['therapist']), JSON.stringify(tme.body?.roles));
        check('without a token there is nobody', (await call('GET', '/api/portal/me')).status === 401);
        check('nor with a made-up one', (await call('GET', '/api/portal/me', undefined, 'f'.repeat(64))).status === 401);

        console.log('\nchanging the password is offered, never required');
        const token = latin.body.token;
        check('the current one must be right', (await call('POST', '/api/portal/password', { current: 'nope', next: 'moja1' }, token)).status === 403);
        check('a new one of fewer than 4 characters is refused', (await call('POST', '/api/portal/password', { current: 'ResursenCentar', next: 'abc' }, token)).status === 400);
        check('otherwise it is changed', (await call('POST', '/api/portal/password', { current: 'ResursenCentar', next: 'моја-лозинка' }, token)).status === 200);
        check('the sign-in that changed it goes on', (await call('GET', '/api/portal/me', undefined, token)).status === 200);
        check('the other sign-ins of that person end', (await call('GET', '/api/portal/me', undefined, cyr.body.token)).status === 401);
        check('the initial password no longer opens it', (await login('ProbnaNastavnichkaPortal', 'ResursenCentar')).status === 401);
        const own = await login('ProbnaNastavnichkaPortal', 'моја-лозинка');
        check('the new one does', own.status === 200 && own.body?.initialPassword === false, JSON.stringify(own.body));
        const stored = await q(`SELECT password_hash FROM staff_accounts a JOIN employees e ON e.id = a.employee_id WHERE e.name = $1`, [TEACHER]);
        check('and only its hash is stored', Boolean(stored[0]?.password_hash) && !String(stored[0].password_hash).includes('лозинка'));

        console.log('\nthe administrator puts it back');
        const list = await call('GET', '/api/staff-accounts');
        const row = (list.body?.accounts || []).find((a: any) => a.name === TEACHER);
        check('the list shows the account, its username and its own password', row?.ownPassword === true && row?.usernames?.latin === 'ProbnaNastavnichkaPortal', JSON.stringify(row));
        check('and marks the two with one name', (list.body?.accounts || []).filter((a: any) => a.name === TWICE && a.ambiguous).length === 2);
        check('the reset answers', (await call('POST', `/api/staff-accounts/${row.employeeId}/reset`)).status === 200);
        check('every sign-in of that person ends', (await call('GET', '/api/portal/me', undefined, own.body.token)).status === 401);
        check('and the initial password opens it again', (await login('ProbnaNastavnichkaPortal', 'ResursenCentar')).status === 200);

        console.log('\nsigning out, and the limits');
        const out = await login('ProbenTerapevtPortal', 'ResursenCentar');
        await call('POST', '/api/portal/logout', undefined, out.body.token);
        check('a signed-out token opens nothing', (await call('GET', '/api/portal/me', undefined, out.body.token)).status === 401);
        for (let i = 0; i < 5; i++) await login('ProbenTerapevtPortal', 'погрешна');
        const locked = await login('ProbenTerapevtPortal', 'ResursenCentar');
        check('five wrong passwords stop that name for a while, even the right one', locked.status === 429, JSON.stringify(locked.body));
        const sessions = await q(`SELECT token_hash FROM staff_sessions s JOIN employees e ON e.id = s.employee_id WHERE e.name = ANY($1::text[])`, [[TEACHER, THERAPIST]]);
        check('no session is stored as its token', sessions.every((r: any) => r.token_hash !== latin.body.token && /^[0-9a-f]{64}$/.test(r.token_hash)));
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

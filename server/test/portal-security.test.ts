import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import Fastify from 'fastify';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import 'dotenv/config';

// The door under the owner's control (052). No production rows, accounts or
// sessions: every migration and every call uses this schema and an invented year.
const schema = `portal_security_test_${process.pid}`, label = '1931/1932-door';
const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const admin = new pg.Client({ connectionString });
let db: pg.Pool, app: ReturnType<typeof Fastify>;
const people: Record<string, number> = {};
const owner = { 'x-mtb-service-key': 'door-test-owner-service-key-1234567890' };
const portalRoutes: Array<{ method: string; url: string }> = [];
let key = '';
const call = (method: any, url: string, token = '', payload?: any, headers: any = {}) => app.inject({ method, url,
    headers: { ...(token ? { 'x-mtb-portal-token': token } : {}), ...(key ? { 'x-mtb-portal-key': key } : {}), ...headers }, payload });
const login = (name: string) => call('POST', '/api/portal/login', '', { username: name, password: 'ResursenCentar' });
const tokenOf = async (name: string) => { const r = await login(name); assert.equal(r.statusCode, 200, r.body); return r.json().token as string; };
const ownerCall = (method: any, url: string, payload?: any) => call(method, url, '', payload, owner);
const mark = (who: string, body: any) => ownerCall('PUT', `/api/staff-security/accounts/${people[who]}`, body);
const maintenance = (on: boolean, message: string | null = null) => ownerCall('PUT', '/api/staff-security/maintenance', { on, message });

before(async () => {
    await admin.connect(); await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(connectionString!); url.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.href;
    db = (await import('../src/db.js')).pool;
    assert.equal((await db.query('SELECT current_schema() AS s')).rows[0].s, schema);
    const dir = resolve(import.meta.dirname, '../../database/migrations');
    for (const file of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) await db.query(readFileSync(resolve(dir, file), 'utf8'));
    const year = (await db.query("INSERT INTO school_years(label,starts_on,ends_on,is_current) VALUES($1,'1931-09-01','1932-08-31',false) RETURNING id", [label])).rows[0].id;
    for (const [who, name] of [['colleague', 'Измислен Колега Врата'], ['tester', 'Измислен Тестер Врата'], ['mine', 'Измислен Сопственик Врата']]) {
        const t = (await db.query('INSERT INTO therapists(name) VALUES($1) RETURNING id,employee_id', [name])).rows[0];
        await db.query('INSERT INTO therapist_years(therapist_id,school_year_id,active) VALUES($1,$2,true)', [t.id, year]);
        people[who] = t.employee_id;
    }
    process.env.MTB_REQUIRE_SIGNIN = '1'; process.env.MTB_SERVICE_KEY = owner['x-mtb-service-key'];
    delete process.env.MTB_MAINTENANCE;
    app = Fastify();
    (await import('../src/lib/colleague.js')).installColleagueBoundary(app);
    (await import('../src/lib/portal-security.js')).installPortalDoor(app);
    app.addHook('onRoute', route => {
        for (const method of Array.isArray(route.method) ? route.method : [route.method])
            if (route.url.startsWith('/api/portal/') && method !== 'HEAD') portalRoutes.push({ method, url: route.url });
    });
    await app.register((await import('../src/routes/portal.js')).portalRoutes, { year: label });
    await app.register((await import('../src/routes/duty.js')).dutyRoutes, { year: label });
});
after(async () => {
    if (app) await app.close(); if (db) await db.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
});

test('nothing changes until the owner uses it: no link, no maintenance, nobody locked', async () => {
    assert.deepEqual((await call('GET', '/api/portal/door')).json(), { ok: true, maintenance: false });
    const token = await tokenOf('Измислен Колега Врата');
    assert.equal((await call('GET', '/api/portal/me', token)).statusCode, 200);
    const page = (await ownerCall('GET', '/api/staff-security')).json();
    assert.equal(page.maintenance.on, false); assert.equal(page.link, null); assert.deepEqual(page.archive, []);
    assert.equal(page.accounts.length, 3); assert.ok(page.accounts.every((a: any) => !a.locked && !a.tester && !a.owner));
});

test('the security page and its writes are the owner\'s alone', async () => {
    const token = await tokenOf('Измислен Колега Врата');
    for (const [method, url, body] of [['GET', '/api/staff-security'], ['PUT', '/api/staff-security/maintenance', { on: true }],
        ['PUT', `/api/staff-security/accounts/${people.colleague}`, { tester: true }], ['POST', '/api/staff-security/link', {}],
        ['DELETE', '/api/staff-security/link'], ['POST', '/api/staff-security/unlock-all', {}]] as const) {
        assert.ok([401, 403].includes((await call(method, url, token, body)).statusCode), `${method} ${url} with a colleague's token`);
        assert.equal((await call(method, url, '', body)).statusCode, 401, `${method} ${url} with nothing`);
    }
    assert.equal((await db.query('SELECT count(*)::int AS n FROM portal_security_log')).rows[0].n, 0);
});

test('maintenance stops everybody but the owner\'s account and the testers, on every portal route, and keeps their sign-ins', async () => {
    const colleague = await tokenOf('Измислен Колега Врата');
    const tester = await tokenOf('Измислен Тестер Врата');
    const mine = await tokenOf('Измислен Сопственик Врата');
    assert.equal((await mark('tester', { tester: true })).statusCode, 200);
    assert.equal((await mark('mine', { owner: true })).statusCode, 200);
    assert.equal((await maintenance(true, 'Се враќаме   во 14 часот.')).statusCode, 200);

    const door = (await call('GET', '/api/portal/door')).json();
    assert.equal(door.maintenance, true); assert.equal(door.message, 'Се враќаме во 14 часот.');
    const me = await call('GET', '/api/portal/me', colleague);
    assert.equal(me.statusCode, 423); assert.equal(me.json().door, 'maintenance'); assert.equal(me.json().error, 'Се враќаме во 14 часот.');
    assert.equal((await call('GET', '/api/portal/me', tester)).statusCode, 200);
    assert.equal((await call('GET', '/api/portal/me', mine)).statusCode, 200);
    // Only the owner's own account is told so: the page offers it the way to the work space.
    assert.equal((await call('GET', '/api/portal/me', mine)).json().owner, true);
    assert.equal((await call('GET', '/api/portal/me', tester)).json().owner, false);

    // Every route of the door, in both files, present and future.
    const open = ['/api/portal/login', '/api/portal/logout', '/api/portal/door'];
    const held = portalRoutes.filter(r => !open.includes(r.url));
    assert.ok(held.length > 20 && held.some(r => r.url.startsWith('/api/portal/duty-admin')), 'the duty routes are counted too');
    for (const { method, url } of held) {
        const r = await call(method, url, colleague, ['GET', 'DELETE'].includes(method) ? undefined : {});
        assert.equal(r.statusCode, 423, `${method} ${url}: ${r.body}`);
    }

    // A correct password is told why; a wrong one learns nothing.
    const refused = await login('Измислен Колега Врата');
    assert.equal(refused.statusCode, 423); assert.equal(refused.json().door, 'maintenance');
    assert.equal((await call('POST', '/api/portal/login', '', { username: 'Измислен Колега Врата', password: 'not-it' })).statusCode, 401);
    assert.equal((await login('Измислен Тестер Врата')).statusCode, 200);

    // The owner's two-hour look is the owner.
    const look = (await ownerCall('POST', `/api/staff-accounts/${people.colleague}/open`)).json().url.split('#as=')[1];
    assert.equal((await call('GET', '/api/portal/me', look)).statusCode, 200);

    assert.equal((await maintenance(false)).statusCode, 200);
    assert.equal((await call('GET', '/api/portal/me', colleague)).statusCode, 200, 'the same sign-in carries on');

    process.env.MTB_MAINTENANCE = '1';
    try {
        assert.equal((await call('GET', '/api/portal/me', colleague)).statusCode, 423, 'the server setting closes the door by itself');
        assert.equal((await ownerCall('GET', '/api/staff-security')).json().maintenance.forced, true);
    } finally { delete process.env.MTB_MAINTENANCE; }
});

test('a locked account is out at once and cannot come back; the owner\'s account cannot be locked', async () => {
    const colleague = await tokenOf('Измислен Колега Врата');
    assert.equal((await mark('colleague', { locked: true })).statusCode, 200);
    assert.equal((await call('GET', '/api/portal/me', colleague)).statusCode, 401, 'the sign-in is gone');
    const again = await login('Измислен Колега Врата');
    assert.equal(again.statusCode, 423); assert.equal(again.json().door, 'locked');
    assert.equal((await call('POST', '/api/portal/login', '', { username: 'Измислен Колега Врата', password: 'not-it' })).statusCode, 401,
        'a stranger is not told the account is locked');
    assert.equal((await db.query("SELECT count(*)::int AS n FROM portal_security_log WHERE action='refused_locked' AND employee_id=$1", [people.colleague])).rows[0].n, 1);
    assert.equal((await mark('mine', { locked: true })).statusCode, 409);
    assert.equal((await login('Измислен Сопственик Врата')).statusCode, 200);
    assert.equal((await ownerCall('POST', '/api/staff-security/unlock-all', {})).json().unlocked, 1);
    assert.equal((await login('Измислен Колега Врата')).statusCode, 200);
    assert.equal((await mark('colleague', { locked: true, extra: 1 })).statusCode, 400);
    assert.equal((await ownerCall('PUT', '/api/staff-security/accounts/999999', { locked: true })).statusCode, 404);
});

test('a new link stops the old address, signs everybody out but the owner, and the old one is archived with its later use', async () => {
    const colleague = await tokenOf('Измислен Колега Врата');
    const mine = await tokenOf('Измислен Сопственик Врата');
    const first = (await ownerCall('POST', '/api/staff-security/link', { note: 'прв' })).json();
    assert.match(first.code, /^[a-z0-9]{4}-[a-z0-9]{4}$/); assert.equal(first.url, '/kolegi/' + first.code);
    assert.equal((await call('GET', '/kolegi/' + first.code)).statusCode !== 404, true, 'the address with a code is served');

    // The plain address: the page loads, and every call is refused.
    for (const [method, url, body] of [['GET', '/api/portal/door'], ['GET', '/api/portal/me'],
        ['POST', '/api/portal/login', { username: 'Измислен Колега Врата', password: 'ResursenCentar' }]] as const) {
        const r = await call(method, url, mine, body);
        assert.equal(r.statusCode, 423, `${method} ${url}`); assert.equal(r.json().door, 'link');
    }
    assert.equal((await call('POST', '/api/portal/logout', mine)).statusCode, 200, 'signing out is always possible');

    key = first.code;
    assert.equal((await call('GET', '/api/portal/me', colleague)).statusCode, 401, 'a remembered sign-in does not outlive the link');
    const fresh = await tokenOf('Измислен Колега Врата');
    assert.equal((await call('GET', '/api/portal/me', fresh)).statusCode, 200);
    const duty = (await ownerCall('POST', '/api/duty/delegations', { hours: 2 })).json();
    assert.ok(duty.url.startsWith(`/kolegi/${first.code}#duty-admin=`), 'the duty link opens on a device that never had the link');

    const second = (await ownerCall('POST', '/api/staff-security/link', {})).json();
    assert.notEqual(second.code, first.code);
    assert.equal((await login('Измислен Колега Врата')).statusCode, 423, 'the replaced link is dead');
    assert.equal((await login('Измислен Колега Врата')).statusCode, 423);
    const page = (await ownerCall('GET', '/api/staff-security')).json();
    assert.equal(page.link.code, second.code);
    assert.equal(page.archive.length, 1); assert.equal(page.archive[0].code, first.code); assert.equal(page.archive[0].note, 'прв');
    assert.equal(page.archive[0].refused, 2); assert.ok(page.archive[0].lastRefusedAt);
    assert.deepEqual(page.log.filter((l: any) => l.action === 'link_new').length, 2);

    // The owner puts the old link back in use by hand, and stops it again.
    const old = (allowed: boolean) => ownerCall('PUT', `/api/staff-security/links/${first.code}`, { allowed });
    assert.equal(page.archive[0].allowed, false, 'nothing comes back by itself');
    assert.equal((await old(true)).statusCode, 200);
    assert.equal((await old(true)).statusCode, 409, 'a stale page cannot do it twice');
    const viaOld = await login('Измислен Колега Врата');
    assert.equal(viaOld.statusCode, 200, 'the old link works again');
    key = second.code;
    const viaNew = await tokenOf('Измислен Тестер Врата');
    assert.equal((await call('GET', '/api/portal/me', viaNew)).statusCode, 200, 'and the current one still does');
    const shown = (await ownerCall('GET', '/api/staff-security')).json();
    assert.equal(shown.link.code, second.code, 'the link to hand out is still the current one');
    assert.equal(shown.archive[0].allowed, true); assert.ok(shown.archive[0].allowedAt);
    assert.equal((await old(false)).statusCode, 200);
    key = first.code;
    assert.equal((await call('GET', '/api/portal/me', viaOld.json().token)).statusCode, 423, 'stopped again, the old link is dead');
    key = second.code;
    assert.equal((await call('GET', '/api/portal/me', viaOld.json().token)).statusCode, 401, 'and whoever came in through it signs in again');
    assert.equal((await call('GET', '/api/portal/me', viaNew)).statusCode, 200, 'whoever came in through the current link stays in (055)');
    // A sign-in from before 055 has no link recorded. Made after the old link
    // was put back in use, it may have come through it; made before, it cannot have.
    const unrecorded = async (made: string) => {
        const token = await tokenOf('Измислен Тестер Врата');
        await db.query(`UPDATE staff_sessions SET link_id = NULL, created_at = now() + $1::interval WHERE link_id IS NOT NULL
                         AND created_at = (SELECT max(created_at) FROM staff_sessions)`, [made]);
        return token;
    };
    const earlier = await unrecorded('-1 hour');
    assert.equal((await old(true)).statusCode, 200);
    const later = await unrecorded('1 hour');
    assert.equal((await old(false)).statusCode, 200);
    assert.equal((await call('GET', '/api/portal/me', earlier)).statusCode, 200, 'older than the link being back: not through it');
    assert.equal((await call('GET', '/api/portal/me', later)).statusCode, 401, 'unrecorded and newer: out, to be safe');
    assert.equal((await call('GET', '/api/portal/me', viaNew)).statusCode, 200);
    assert.equal((await ownerCall('PUT', '/api/staff-security/links/zzzz-9999', { allowed: true })).statusCode, 409);
    assert.equal((await ownerCall('PUT', `/api/staff-security/links/${second.code}`, { allowed: true })).statusCode, 409, 'the current link has no such switch');
    assert.equal((await call('PUT', `/api/staff-security/links/${first.code}`, viaNew, { allowed: true })).statusCode, 401, "the owner's alone");

    key = second.code.toUpperCase();
    const through = await login('Измислен Колега Врата');
    assert.equal(through.statusCode, 200, 'the code is not case-sensitive');
    const mineAgain = await tokenOf('Измислен Сопственик Врата');
    assert.equal((await ownerCall('DELETE', '/api/staff-security/link')).json().retired, true);
    key = '';
    assert.equal((await call('GET', '/api/portal/me', through.json().token)).statusCode, 401, 'taking the link away signs its colleagues out');
    assert.equal((await call('GET', '/api/portal/me', mineAgain)).statusCode, 200, 'but not the owner');
    assert.equal((await ownerCall('DELETE', '/api/staff-security/link')).json().retired, false, 'nothing to take away twice');
    assert.equal((await login('Измислен Колега Врата')).statusCode, 200, 'back to the plain address');
    const end = (await ownerCall('GET', '/api/staff-security')).json();
    assert.equal(end.link, null); assert.equal(end.archive.length, 2);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM portal_links WHERE retired_at IS NULL')).rows[0].n, 0);
});

test('every change is in the record, with who it was about', async () => {
    const log = (await ownerCall('GET', '/api/staff-security')).json().log;
    const actions = new Set(log.map((l: any) => l.action));
    for (const action of ['link_allow', 'link_stop', 'maintenance_on', 'maintenance_off', 'lock', 'unlock_all', 'tester_on', 'owner_on', 'link_new', 'link_off', 'refused_locked']) {
        assert.ok(actions.has(action), action);
    }
    assert.equal(log.find((l: any) => l.action === 'lock').name, 'Измислен Колега Врата');
    assert.equal(log.find((l: any) => l.action === 'maintenance_on').detail, 'Се враќаме во 14 часот.');
});

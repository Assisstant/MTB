import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import Fastify from 'fastify';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import 'dotenv/config';

// No production rows, roles or sessions: all migrations and calls use this schema.
const schema = `portal_reader_test_${process.pid}`, label = '1921/1922-reader';
const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const admin = new pg.Client({ connectionString });
let db: pg.Pool, app: ReturnType<typeof Fastify>, year: number, employee: number, cabinetEmployee: number;
let regular: string, reader: string;
const owner = { 'x-mtb-service-key': 'read-only-test-owner-service-1234567890' };
const writes: Array<{ method: string; url: string }> = [];
const call = (method: any, url: string, token = '', payload?: any, headers: any = {}) => app.inject({ method, url,
    headers: { ...(token ? { 'x-mtb-portal-token': token } : {}), ...headers }, payload });
const login = async (name: string, password = 'ResursenCentar') => (await call('POST', '/api/portal/login', '', { username: name, password })).json().token;
const access = (id: number, readOnly: boolean, expected: boolean) => call('PUT', `/api/staff-accounts/${id}/access`, '', { readOnly, expected }, owner);

before(async () => {
    await admin.connect(); await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(connectionString!); url.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.href;
    db = (await import('../src/db.js')).pool;
    assert.equal((await db.query('SELECT current_schema() AS s')).rows[0].s, schema);
    const dir = resolve(import.meta.dirname, '../../database/migrations');
    for (const file of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) await db.query(readFileSync(resolve(dir, file), 'utf8'));
    year = (await db.query("INSERT INTO school_years(label,starts_on,ends_on,is_current) VALUES($1,'1921-09-01','1922-08-31',false) RETURNING id", [label])).rows[0].id;
    const therapist = (await db.query("INSERT INTO therapists(name) VALUES('Измислен Кабинет Читач') RETURNING id,employee_id")).rows[0];
    cabinetEmployee = therapist.employee_id;
    await db.query('INSERT INTO therapist_years(therapist_id,school_year_id,active) VALUES($1,$2,true)', [therapist.id,year]);
    const student = (await db.query("INSERT INTO students(public_id,name) VALUES('reader-fake','Измислен Ученик Читач') RETURNING id")).rows[0].id;
    await db.query("INSERT INTO student_enrollments(student_id,school_year_id,grade,enrollment_type) VALUES($1,$2,'ТЕСТ','external')",[student,year]);
    await db.query('INSERT INTO therapist_students(student_id,school_year_id,therapist_id) VALUES($1,$2,$3)',[student,year,therapist.id]);
    await db.query("INSERT INTO schedule_slots(school_year_id,day,day_order,time_slot,therapist_id,student_id,source) VALUES($1,'понеделник',1,'08:00-08:40',$2,$3,'api')",[year,therapist.id,student]);
    process.env.MTB_REQUIRE_SIGNIN = '1'; process.env.MTB_SERVICE_KEY = owner['x-mtb-service-key'];
    app = Fastify();
    (await import('../src/lib/colleague.js')).installColleagueBoundary(app);
    app.addHook('onRoute', (route: any) => {
        for (const method of Array.isArray(route.method) ? route.method : [route.method])
            if (route.url.startsWith('/api/portal/') && ['POST','PUT','PATCH','DELETE'].includes(method)) writes.push({method,url:route.url});
    });
    await app.register((await import('../src/routes/portal.js')).portalRoutes,{year:label});
    await app.register((await import('../src/routes/duty.js')).dutyRoutes,{year:label});
    await app.register((await import('../src/routes/workspace.js')).workspaceRoutes);
    app.put('/api/future-system-write', async () => { throw Error('read-only request crossed the boundary'); });
    regular = await login('Измислен Кабинет Читач'); assert.ok(regular);
});
after(async () => {
    if (app) await app.close(); if (db) await db.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
});

test('owner creates an administration profile with the existing directory writer and explicitly grants read access', async () => {
    const made = await call('POST','/api/workspace/employees','',{year:label,name:'Измислена Администрација Читач',identifier:null,roles:['administration'],teacherKind:'none'},owner);
    assert.equal(made.statusCode,200,made.body); employee=made.json().employee.id;
    assert.equal(await login('Измислена Администрација Читач'),undefined,'directory administration is not an admin permission');
    const list=(await call('GET','/api/staff-accounts','',undefined,owner)).json();
    assert.ok(list.candidates.some((c:any)=>c.employeeId===employee));
    assert.ok(!list.accounts.some((c:any)=>c.employeeId===employee));
    assert.equal((await call('PUT',`/api/staff-accounts/${employee}/access`,regular,{readOnly:true,expected:false})).statusCode,401);
    assert.equal((await access(employee,true,false)).statusCode,200);
    assert.equal((await access(employee,false,false)).statusCode,409,'stale owner tab cannot undo a grant');
    reader=await login('IzmislenaAdministracijaChitach'); assert.ok(reader);
    const me=(await call('GET','/api/portal/me',reader)).json();
    assert.equal(me.readOnly,true); assert.equal(me.therapist,null); assert.equal(me.teacher,null); assert.equal(me.initialPassword,true);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM therapists WHERE employee_id=$1',[employee])).rows[0].n,0);
});

test('only assigned readers can inspect other cabinets, pupil lists and transport; unauthenticated and normal accounts cannot', async () => {
    for(const path of ['/api/portal/read-only/staff','/api/portal/read-only/pupils','/api/portal/read-only/transport?month=1921-09']) {
        assert.equal((await call('GET',path)).statusCode,401,path);
        assert.equal((await call('GET',path,regular)).statusCode,403,path);
        const r=await call('GET',path,reader); assert.equal(r.statusCode,200,r.body);
    }
    const pupils=(await call('GET','/api/portal/read-only/pupils',reader)).json().pupils;
    assert.equal(pupils.length,1); assert.equal(pupils[0].therapists[0].employeeId,cabinetEmployee);
    const path='/api/portal/week?employeeId='+cabinetEmployee;
    assert.equal((await call('GET',path,regular)).statusCode,403);
    const week=(await call('GET',path,reader)).json();
    assert.equal(week.viewedPerson.employeeId,cabinetEmployee); assert.ok(week.cabinet.pupils.length); assert.deepEqual(week.notices,[]);
    assert.equal((await call('GET','/api/portal/week?employeeId=999999',reader)).statusCode,404);
    const att='/api/portal/attendance?from=1921-09-05&to=1921-09-05&employeeId='+cabinetEmployee;
    assert.equal((await call('GET',att,regular)).statusCode,403);
    const response=await call('GET',att,reader); assert.equal(response.statusCode,200,response.body);
    assert.equal(response.json().readOnly,true); assert.equal(response.json().days[0].sessions.length,1);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM cabinet_attendance_days')).rows[0].n,0,'reads never freeze an attendance plan');
});

test('every business write is denied with a reader token in both enforcement modes, including a duty capability and future APIs', async () => {
    const except = ['/api/portal/login','/api/portal/logout','/api/portal/password'];
    const before=(await db.query("SELECT md5(string_agg(row_to_json(s)::text,'' ORDER BY id)) AS hash FROM schedule_slots s")).rows[0].hash;
    for(const mode of ['0','1']) {
        process.env.MTB_REQUIRE_SIGNIN=mode;
        for(const {method,url} of [...writes,{method:'PUT',url:'/api/future-system-write'},{method:'POST',url:'/api/workspace/employees'}].filter(r=>!except.includes(r.url))) {
            const r=await call(method,url,reader,{}, {'x-mtb-duty-admin-token':'c'.repeat(43)});
            assert.equal(r.statusCode,403,`${mode} ${method} ${url}: ${r.body}`); assert.equal(r.json().readOnly,true);
        }
        for(const path of ['/api/staff-accounts','/api/attendance/transport?month=1921-09']) assert.equal((await call('GET',path,reader)).statusCode,mode==='0'?403:401);
    }
    process.env.MTB_REQUIRE_SIGNIN='1';
    assert.equal((await db.query("SELECT md5(string_agg(row_to_json(s)::text,'' ORDER BY id)) AS hash FROM schedule_slots s")).rows[0].hash,before);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM cabinet_attendance_changes')).rows[0].n,0);
    assert.equal((await call('POST','/api/portal/password',reader,{current:'ResursenCentar',next:'reader-own-test'})).statusCode,200);
    assert.ok(await login('Измислена Администрација Читач','reader-own-test'),'own password remains available');
});

test('reset preserves read-only; revocation ends sessions and active annual membership is always required', async () => {
    assert.equal((await call('POST',`/api/staff-accounts/${employee}/reset`,'',{},owner)).statusCode,200);
    reader=await login('Измислена Администрација Читач'); assert.ok(reader);
    assert.equal((await call('GET','/api/portal/me',reader)).json().readOnly,true);
    await db.query('UPDATE employee_roles SET active=false WHERE employee_id=$1',[employee]);
    assert.equal((await call('GET','/api/portal/read-only/pupils',reader)).statusCode,403);
    await db.query('UPDATE employee_roles SET active=true WHERE employee_id=$1 AND role=$2',[employee,'administration']);
    assert.equal((await access(employee,false,true)).statusCode,200);
    assert.equal((await call('GET','/api/portal/me',reader)).statusCode,401);
    assert.equal(await login('Измислена Администрација Читач'),undefined);
    assert.equal((await access(cabinetEmployee,true,false)).statusCode,200);
    assert.equal((await call('GET','/api/portal/me',regular)).statusCode,401,'old editing session is revoked');
    regular=await login('Измислен Кабинет Читач');
    assert.equal((await call('PUT','/api/portal/term',regular,{})).statusCode,403,'existing therapist is also read-only');
    assert.equal((await access(cabinetEmployee,false,true)).statusCode,200);
    regular=await login('Измислен Кабинет Читач');
    assert.equal((await call('GET','/api/portal/me',regular)).json().readOnly,false);
});

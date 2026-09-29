import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import Fastify from 'fastify';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import 'dotenv/config';
import { sessionsOf, closedReason, overlaps } from '../src/lib/cabinet-attendance.js';

// All API calls and migrations run inside a disposable schema, never public.
const schema = `cabinet_attendance_test_${process.pid}`;
const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) throw Error('Configure a test database connection.');
const admin = new pg.Client({ connectionString });
let db: pg.Pool, app: ReturnType<typeof Fastify>, year: number, a: number, b: number;
let one: string, two: string, teacher: string;
const call = async (method: any, token: string, body?: any, query = '') => {
    const r = await app.inject({ method, url: '/api/portal/attendance' + query,
        headers: { 'x-mtb-portal-token': token }, payload: body });
    return { status: r.statusCode, body: r.json() };
};
const read = (token = one, from = '1921-09-05', to = from) => call('GET', token, undefined, `?from=${from}&to=${to}`);
const mark = (day: any, index = 0, status: any = 'present') => ({ date: day.date, key: day.sessions[index].key,
    expected: day.sessions[index].status, status, revision: day.revision, planToken: day.planToken });

before(async () => {
    pg.types.setTypeParser(1082, v => v);
    await admin.connect(); await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(connectionString!); url.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.href;
    const module = await import('../src/db.js'); db = module.pool;
    assert.equal((await db.query('SELECT current_schema() AS s')).rows[0].s, schema);
    const dir = resolve(import.meta.dirname, '../../database/migrations');
    for (const f of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) await db.query(readFileSync(resolve(dir, f), 'utf8'));
    year = (await db.query("INSERT INTO school_years(label, starts_on,ends_on,is_current) VALUES('1921/1922-att','1921-09-01','1922-08-31',false) RETURNING id")).rows[0].id;
    const names = ['Измислен Кабинет Алфа', 'Измислен Кабинет Бета'];
    const ids: number[] = [];
    for (const name of names) {
        const id = (await db.query('INSERT INTO therapists(name) VALUES($1) RETURNING id', [name])).rows[0].id;
        ids.push(id); await db.query('INSERT INTO therapist_years(school_year_id,therapist_id,active) VALUES($1,$2,true)', [year,id]);
    }
    [a,b] = ids;
    const tid = (await db.query("INSERT INTO teachers(name,kind) VALUES('Измислен Наставник Гама','pred') RETURNING id")).rows[0].id;
    await db.query('INSERT INTO teacher_years(school_year_id,teacher_id,active) VALUES($1,$2,true)', [year,tid]);
    for (const [pid, name, therapist, time] of [['att-a','Измислен Ученик Алфа',a,'08:00-08:40'],['att-b','Измислен Ученик Бета',a,'08:45-09:05'],['att-c','Измислен Ученик Гама',b,'08:00-08:40']] as const) {
        const id = (await db.query('INSERT INTO students(public_id,name,grade) VALUES($1,$2,$3) RETURNING id', [pid,name,'ТЕСТ'])).rows[0].id;
        await db.query('INSERT INTO student_enrollments(student_id,school_year_id,grade) VALUES($1,$2,$3)', [id,year,'ТЕСТ']);
        await db.query('INSERT INTO therapist_students(student_id,school_year_id,therapist_id) VALUES($1,$2,$3)', [id,year,therapist]);
        await db.query("INSERT INTO schedule_slots(school_year_id,day,day_order,time_slot,therapist_id,student_id,source) VALUES($1,'понеделник',1,$2,$3,$4,'api')", [year,time,therapist,id]);
    }
    app = Fastify();
    process.env.MTB_REQUIRE_SIGNIN = '1';
    (await import('../src/lib/colleague.js')).installColleagueBoundary(app);
    await app.register((await import('../src/routes/portal.js')).portalRoutes, { year:'1921/1922-att' });
    const login = async (username: string) => (await app.inject({ method:'POST',url:'/api/portal/login',payload:{username,password:'ResursenCentar'} })).json().token;
    one = await login(names[0]); two = await login(names[1]); teacher = await login('Измислен Наставник Гама');
    assert.ok(one && two && teacher);
});
after(async () => {
    if (app) await app.close(); if (db) await db.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
});

test('half sessions, holiday rules, activity and Sunday are explicit', () => {
    const row = (time_slot: string, public_id='x') => ({ time_slot, public_id, name:'Измислен',grade:'Т' });
    assert.equal(sessionsOf([row('08:00-08:20'),row('08:20-08:40')])[0].time,'08:00-08:40');
    assert.equal(sessionsOf([row('08:20-08:40')])[0].time,'08:20-08:40');
    assert.equal(sessionsOf([row('08:00-08:20'),row('08:20-08:40','y')]).length,2);
    assert.ok(overlaps(sessionsOf([row('08:00-08:40'),row('08:20-08:40','y')])));
    const c = { year:{starts_on:'1921-09-01',ends_on:'1922-08-31'},calendar:{yearStart:'1921-09-01',yearEnd:'1922-06-10',holidays:[{start:'1921-09-05',end:'1921-09-05',kind:'aktivnost'}]} };
    assert.equal(closedReason('1921-09-05',c),null);
    c.calendar.holidays[0].kind='praznik'; assert.ok(closedReason('1921-09-05',c));
    assert.ok(closedReason('1921-09-04',c)); assert.ok(closedReason('1921-02-30',c));
});
test('portal scope, validation, immutable snapshots, races and diary isolation', async () => {
    for (const table of ['cabinet_attendance_days','cabinet_attendance_changes','cabinet_attendance_pupils']) {
        assert.equal((await db.query('SELECT relrowsecurity FROM pg_class WHERE oid=$1::regclass',[table])).rows[0].relrowsecurity,true);
    }
    assert.equal((await read('')).status,401);
    assert.equal((await read(teacher)).status,403);
    assert.equal((await read(one,'1921-02-30')).status,400);
    assert.equal((await read(one,'1921-09-01','1922-09-01')).status,400);
    const day = (await read()).body.days[0];
    assert.equal(day.sessions.length,2); assert.equal(day.frozen,false);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM cabinet_attendance_days')).rows[0].n,0,'GET never freezes');
    assert.ok(!JSON.stringify(day).includes('att-c'));
    assert.equal((await call('PUT',two,mark(day))).status,409,'another cabinet cannot use this plan');
    assert.equal((await call('PUT',one,{...mark(day),therapistId:b})).status,400,'scope cannot be supplied');
    assert.equal((await call('PUT',one,{...mark(day),key:'att-c|08:00-08:40'})).status,403);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM cabinet_attendance_days')).rows[0].n,0,'refusal rolls back snapshot');
    await db.query("UPDATE schedule_slots SET time_slot='09:40-10:00' WHERE school_year_id=$1 AND therapist_id=$2 AND time_slot='08:45-09:05'",[year,a]);
    assert.equal((await call('PUT',one,mark(day))).status,409,'changed recurring schedule rejects the old preview');
    await db.query("UPDATE schedule_slots SET time_slot='08:45-09:05' WHERE school_year_id=$1 AND therapist_id=$2 AND time_slot='09:40-10:00'",[year,a]);
    const concurrent = await Promise.all([call('PUT',one,mark(day)),call('PUT',one,mark(day,1))]);
    assert.deepEqual(concurrent.map(r=>r.status).sort(),[200,409]);
    let saved = (await read()).body.days[0];
    assert.equal(saved.frozen,true); assert.equal(saved.sessions.filter((s:any)=>s.status).length,1);
    const markedIndex = saved.sessions.findIndex((s:any)=>s.status);
    assert.equal((await call('PUT',one,mark(saved,markedIndex,'absent'))).status,200);
    saved = (await read()).body.days[0];
    assert.equal(saved.sessions[markedIndex].status,'absent');
    assert.equal((await call('PUT',one,mark(saved,markedIndex,null))).status,200);
    await db.query('DELETE FROM schedule_slots WHERE school_year_id=$1 AND therapist_id=$2', [year,a]);
    saved = (await read()).body.days[0];
    assert.equal(saved.sessions.length,2,'later timetable edit cannot rewrite frozen plan');
    assert.equal(saved.sessions.filter((s:any)=>s.status).length,0,'clearing does not erase snapshot');
    assert.equal((await read(one,'1921-09-12')).body.days[0].sessions.length,0,'unfrozen day uses current timetable');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM attendance')).rows[0].n,0,'personal diary untouched');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM cabinet_attendance_changes')).rows[0].n,3);
    const c = await db.connect();
    try {
        await c.query('BEGIN');
        await c.query('DELETE FROM therapist_students WHERE school_year_id=$1 AND therapist_id=$2',[year,a]);
        await assert.rejects(c.query("DELETE FROM students WHERE public_id='att-a'"), /cabinet_attendance_pupils_student_id_fkey/,
            'frozen plans protect even cleared or unmarked pupils from typo deletion');
    } finally { await c.query('ROLLBACK'); c.release(); }
    assert.equal((await call('PUT',one,{...mark(saved),date:'1921-09-04'})).status,400);
    await db.query("INSERT INTO app_state(app,version,payload) VALUES('sdnevnik',1,$1::jsonb)", [JSON.stringify({schoolCalendar:{yearStart:'1921-09-01',yearEnd:'1922-06-10',holidays:[{start:'1921-09-05',end:'1921-09-05',kind:'raspust',name:'Пробен распуст'}]}})]);
    assert.equal((await call('PUT',one,mark(saved))).status,400,'closed days cannot be marked');
    assert.equal((await read()).body.days[0].sessions.length,2,'calendar edit does not erase history');
});

test('owner account picker reuses protected list and acting grants; ordinary staff cannot impersonate', async () => {
    const serviceKey='owner-picker-test-service-key-123456789';
    process.env.MTB_SERVICE_KEY=serviceKey;
    const headers={'x-mtb-service-key':serviceKey};
    try {
        const { isPortalRequest }=await import('../src/lib/cloud-auth.js');
        assert.equal(isPortalRequest({method:'GET',url:'/api/staff-accounts'}),false);
        const list=await app.inject({method:'GET',url:'/api/staff-accounts',headers});
        assert.equal(list.statusCode,200);
        const account=list.json().accounts.find((x:any)=>x.therapist);
        assert.ok(account);
        const url='/api/staff-accounts/'+account.employeeId+'/open';
        assert.equal(isPortalRequest({method:'POST',url}),false);
        for(const staffHeaders of [{'x-mtb-portal-token':one},{'x-mtb-portal-token':two,'x-mtb-duty-admin-token':'not-a-general-admin'}]) {
            assert.equal((await app.inject({method:'GET',url:'/api/staff-accounts',headers:staffHeaders})).statusCode,401);
            assert.equal((await app.inject({method:'POST',url,headers:staffHeaders,payload:{}})).statusCode,401);
        }
        const grant=await app.inject({method:'POST',url,headers,payload:{}});
        assert.equal(grant.statusCode,200);
        const actingToken=grant.json().url.split('#as=')[1];
        const view=await app.inject({method:'GET',url:'/api/portal/me',headers:{'x-mtb-portal-token':actingToken}});
        assert.equal(view.statusCode,200);assert.equal(view.json().acting,true);
        assert.equal(view.json().person.employeeId,account.employeeId);
        assert.equal((await app.inject({method:'GET',url:'/api/staff-accounts',headers:{'x-mtb-portal-token':actingToken}})).statusCode,401,'acting grant cannot grant more owner views');
    } finally { delete process.env.MTB_SERVICE_KEY; }
});

test('transport: external annual membership, distinct days across cabinets, corrections and owner-only access', async () => {
    const serviceKey = 'transport-test-only-service-key-123456789';
    process.env.MTB_SERVICE_KEY = serviceKey;
    const ownerHeaders = { 'x-mtb-service-key': serviceKey };
    const url = '/api/attendance/transport?month=1921-09&year=1921%2F1922-att';
    const { isPortalRequest } = await import('../src/lib/cloud-auth.js');
    assert.equal(isPortalRequest({method:'GET',url}),false,'cloud owner gate must protect the cross-cabinet report');
    assert.equal(isPortalRequest({method:'GET',url:'/api/attendance/transport/access'}),false);
    for (const path of [url, '/api/attendance/transport/access']) {
        for (const headers of [{}, {'x-mtb-portal-token':one}, {'x-mtb-portal-token':two,'x-mtb-duty-admin-token':'not-a-transport-permission'}]) {
            assert.equal((await app.inject({method:'GET',url:path,headers})).statusCode,401);
        }
    }
    assert.equal((await app.inject({method:'GET',url:'/api/attendance/transport/access',headers:ownerHeaders})).statusCode,200);
    assert.equal((await app.inject({method:'GET',url:'/api/portal/attendance/transport',headers:{'x-mtb-portal-token':one}})).statusCode,404);
    const ids = (await db.query("SELECT id,public_id FROM students WHERE public_id LIKE 'att-%' ORDER BY public_id")).rows;
    const [alpha,beta,internal] = ids.map(r=>r.id);
    await db.query("UPDATE student_enrollments SET enrollment_type='external',grade='VI-тест' WHERE school_year_id=$1 AND student_id=ANY($2::int[])",[year,[alpha,beta]]);
    const twin = (await db.query("INSERT INTO students(public_id,name,grade) SELECT 'att-twin',name,'ТЕСТ' FROM students WHERE id=$1 RETURNING id",[alpha])).rows[0].id;
    await db.query("INSERT INTO student_enrollments(student_id,school_year_id,enrollment_type,grade) VALUES($1,$2,'external','VII-тест')",[twin,year]);
    const save = async (therapist:number,date:string,items:[number,string|null][]) => {
        const plan=items.map(([id],i)=>({key:`${id}|slot-${i}`,studentId:id}));
        const marks=Object.fromEntries(items.map(([id,s],i)=>[`${id}|slot-${i}`,s]).filter(([,s])=>s));
        await db.query('INSERT INTO cabinet_attendance_days(school_year_id,therapist_id,day,plan,marks) VALUES($1,$2,$3,$4,$5)',[year,therapist,date,JSON.stringify(plan),JSON.stringify(marks)]);
        for(const id of new Set(items.map(([id])=>id))) await db.query('INSERT INTO cabinet_attendance_pupils(school_year_id,therapist_id,day,student_id) VALUES($1,$2,$3,$4)',[year,therapist,date,id]);
    };
    await save(a,'1921-09-06',[[alpha,'present'],[alpha,'present'],[beta,'absent'],[internal,'present'],[twin,null]]);
    await save(b,'1921-09-06',[[alpha,'present'],[beta,'present']]);
    await save(a,'1921-09-07',[[alpha,'absent'],[beta,null]]);
    await save(b,'1921-09-08',[[alpha,'present']]);
    await save(b,'1921-10-03',[[alpha,'present']]);
    // Persisted records from another school year must not leak into this year.
    const otherYear=(await db.query("INSERT INTO school_years(label,starts_on,ends_on) VALUES('1921/1922-other','1921-09-01','1922-08-31') RETURNING id")).rows[0].id;
    await db.query("INSERT INTO cabinet_attendance_days(school_year_id,therapist_id,day,plan,marks) VALUES($1,$2,'1921-09-09',$3,$4)",[otherYear,a,JSON.stringify([{key:'other',studentId:alpha}]),JSON.stringify({other:'present'})]);
    await db.query("INSERT INTO cabinet_attendance_pupils VALUES($1,$2,'1921-09-09',$3)",[otherYear,a,alpha]);
    const fetch = async () => {
        const r=await app.inject({method:'GET',url,headers:ownerHeaders}); assert.equal(r.statusCode,200,r.body);
        assert.equal(r.headers['cache-control'],'no-store'); return r.json();
    };
    let data=await fetch();
    assert.equal(data.pupils.length,3,'internal pupil excluded; same-name external pupils not merged');
    assert.deepEqual(data.pupils.find((p:any)=>p.studentId===alpha).dates,['1921-09-06','1921-09-08']);
    assert.equal(data.pupils.find((p:any)=>p.studentId===alpha).daysPresent,2,'three sessions across two cabinets on one date count once');
    assert.equal(data.pupils.find((p:any)=>p.studentId===beta).daysPresent,1,'present wins over another cabinet absence');
    assert.equal(data.pupils.find((p:any)=>p.studentId===twin).daysPresent,0,'unmarked never means attended');
    await db.query("UPDATE student_enrollments SET active=false WHERE school_year_id=$1 AND student_id=$2",[year,alpha]);
    await db.query("UPDATE cabinet_attendance_days SET marks='{}' WHERE school_year_id=$1 AND day='1921-09-08'",[year]);
    data=await fetch();
    assert.equal(data.pupils.find((p:any)=>p.studentId===alpha).daysPresent,1,'correction recomputes count; inactive pupil retains confirmed history');
    for(const month of ['1921-13','1920-09']) assert.equal((await app.inject({method:'GET',url:url.replace('1921-09',month),headers:ownerHeaders})).statusCode,400);
    delete process.env.MTB_SERVICE_KEY;
});

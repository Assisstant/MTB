// Run only through with-scratch: the test owns this schema and diary.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { chromium, type Browser } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { pool } from '../src/db.js';
import { activateOngoing, monday, DAYS } from '../src/lib/diary-cabinet-plan.js';
import { todayInSkopje } from '../src/lib/duty.js';
if (process.env.MTB_SCRATCH_DB !== '1') throw new Error('Use npm run test:scratch -- test/diary-ongoing.e2e.ts');
const BASE = process.env.API!;
const q = async (sql: string, args: any[] = []) => (await pool.query(sql, args)).rows;
const call = async (path: string, body?: any) => {
    const r = await fetch(BASE + path, body ? { method:'PUT', headers:{'Content-Type':'application/json'},body:JSON.stringify(body) } : {});
    return { status:r.status, body:await r.json() as any };
};
const empty = () => Object.fromEntries(DAYS.map(d => [d,[[],[],[],[],[]]])) as Record<string, any[][]>;
const shift = (date: string, days: number) => { const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10); };
const current=monday(todayInSkopje());
const times=['08:00-08:40','08:45-09:25','09:40-10:20','10:25-11:05','11:10-11:50'];
const stored=async () => (await q("SELECT * FROM app_state WHERE app='sdnevnik'"))[0];
const slots=async () => q('SELECT day,time_slot,therapist_id,student_id FROM schedule_slots ORDER BY day,time_slot,therapist_id');
let passed=0;
let browser: Browser | undefined;
function check(label:string, truth:unknown) { assert.ok(truth,label); console.log('  ok '+label);passed++; }
try {
    const [year]=await q("UPDATE school_years SET starts_on='2000-09-01',ends_on='2100-08-31' WHERE is_current RETURNING id");
    const [me]=await q("INSERT INTO therapists(name) VALUES('Измислен Терапевт Неделен') RETURNING id");
    const [other]=await q("INSERT INTO therapists(name) VALUES('Измислен Втор Терапевт') RETURNING id");
    for (const t of [me,other]) await q('INSERT INTO therapist_years(school_year_id,therapist_id,active) VALUES($1,$2,true)',[year.id,t.id]);
    const students=[];
    for (let i=1;i<=2;i++) {
        const [s]=await q('INSERT INTO students(public_id,sdnevnik_id,name,grade) VALUES($1,$2,$3,$4) RETURNING id', ['ongoing-'+i,9000+i,'Пробен Неделен '+i,'V']);
        await q('INSERT INTO student_enrollments(school_year_id,student_id,grade,active) VALUES($1,$2,$3,true)',[year.id,s.id,'V']);
        for (const t of [me,other]) await q('INSERT INTO therapist_students(school_year_id,therapist_id,student_id) VALUES($1,$2,$3)',[year.id,t.id,s.id]);
        students.push({id:9000+i,name:'Пробен Неделен '+i,grade:'V',kind:'internal',rasporediStudentId:'ongoing-'+i});
    }
    const week=empty();week.monday[0]=[9001];
    const earlier=empty();earlier.monday[0]=[9002];
    const payload={students,schedule:week,scheduleHistory:{[shift(current,-14)]:earlier},planFrom:{},
        attendance:{[shift(current,-7)]:{'9001':{'monday-0':{status:'present',time:'08:00-08:40'}}}},
        plans:[],studentProgress:{},links:[],assessments:[],audiograms:[],student_records:[],trijazenTestovi:[],scaleTemplates:[]};
    check('seed diary', (await call('/api/state/sdnevnik',{baseVersion:0,payload})).status===200);
    const first={id:randomUUID(),baseVersion:(await stored()).version,fromWeek:current,therapistId:me.id,week,times,expected:empty()};
    const start=await call('/api/diary/ongoing-plan',first);
    check('whole ongoing week accepted',start.status===200);
    check('shared timetable reads the same pupil', (await call('/api/schedule/sessions')).body.sessions[0].student_public_id==='ongoing-1');
    check('repeat acknowledgement writes no new diary version',(await call('/api/diary/ongoing-plan',first)).body.version===start.body.version);
    const next=empty();next.monday[0]=[9002];
    const baseline=empty();baseline.monday[0]=['ongoing-1'];
    const past=await call('/api/diary/ongoing-plan',{...first,id:randomUUID(),baseVersion:start.body.version,fromWeek:shift(current,-7),week:next,expected:baseline});
    check('past onward becomes current shared timetable',past.status===200 && (await call('/api/schedule/sessions')).body.sessions[0].student_public_id==='ongoing-2');
    check('earlier week unchanged',isDeepStrictEqual(past.body.payload.scheduleHistory[shift(current,-14)],earlier));
    check('all weeks from the start replaced',past.body.payload.scheduleHistory[shift(current,-7)].monday[0][0]===9002 && past.body.payload.schedule.monday[0][0]===9002);
    check('attendance untouched',isDeepStrictEqual(past.body.payload.attendance,payload.attendance));
    check('recovery copy retained',(await q('SELECT before_diary FROM diary_cabinet_changes WHERE id=$1',[first.id]))[0].before_diary.students.length===2);
    await call('/api/schedule/block',{therapistId:other.id,day:'петок',time:times[1],studentPublicIds:['ongoing-1'],expectedStudentPublicIds:[]});
    const before=await slots(), docBefore=await stored();
    const clash=empty();clash.monday[0]=[9001];clash.friday[1]=[9001];
    const base2=empty();base2.monday[0]=['ongoing-2'];
    const failed=await call('/api/diary/ongoing-plan',{...first,id:randomUUID(),baseVersion:docBefore.version,week:clash,expected:base2});
    check('Friday clash refuses the whole request',failed.status===409 && failed.body.doubleBooked);
    check('Monday write rolled back too',JSON.stringify(await slots())===JSON.stringify(before));
    check('refusal did not change diary',(await stored()).version===docBefore.version);
    const stale=structuredClone(base2);stale.friday[0]=['ongoing-1'];
    const refused=await call('/api/diary/ongoing-plan',{...first,id:randomUUID(),baseVersion:docBefore.version,week,expected:stale});
    check('stale last-day expectation refuses all',refused.status===409 && JSON.stringify(await slots())===JSON.stringify(before));
    const future=shift(current,14);
    const futureInput={...first,id:randomUUID(),baseVersion:(await stored()).version,fromWeek:future,expected:base2};
    const queued=await call('/api/diary/ongoing-plan',futureInput);
    check('future week persisted for activation',queued.status===200 && queued.body.scheduled);
    check('future plan does not change today',JSON.stringify(await slots())===JSON.stringify(before) && queued.body.payload.schedule.monday[0][0]===9002);
    await activateOngoing(future);
    check('server activates with diary closed',(await stored()).payload.schedule.monday[0][0]===9001);
    check('activation also reaches shared timetable',(await call('/api/schedule/sessions')).body.sessions.find((s:any)=>s.therapist_id===me.id).student_public_id==='ongoing-1');
    const activeVersion=(await stored()).version;
    await activateOngoing(future);
    check('activation is idempotent',(await stored()).version===activeVersion);
    const later=shift(current,28);
    const queued2=await call('/api/diary/ongoing-plan',{...first,id:randomUUID(),baseVersion:activeVersion,fromWeek:later,week:next,expected:baseline});
    check('another future plan accepted',queued2.status===200);
    await call('/api/schedule/block',{therapistId:me.id,day:'понеделник',time:times[0],studentPublicIds:[],expectedStudentPublicIds:['ongoing-1']});
    await activateOngoing(later);
    const status=await call('/api/diary/ongoing-plan');
    check('activation refuses changes made after confirmation',status.body.plans.some((p:any)=>p.from_week===later && p.status==='blocked'));
    check('blocked activation preserves diary version',(await stored()).version===queued2.body.version);
    const bad=await call('/api/diary/ongoing-plan',{...first,id:randomUUID(),baseVersion:0});
    check('stale diary cannot be overwritten',bad.status===409 && bad.body.diaryConflict);
    console.log('\nThe real diary: in-cell dropdowns and the confirmed onward choice');
    browser=await chromium.launch();
    const context=await browser.newContext({viewport:{width:1440,height:1000}});
    await context.addInitScript(()=>{
        localStorage.setItem('my_therapist_v1','Измислен Терапевт Неделен');
        localStorage.setItem('sdn_local_server_autosync_v1','0');
    });
    const page=await context.newPage();
    const errors:string[]=[], dialogs:string[]=[];
    page.on('pageerror',e=>errors.push(String(e)));
    page.on('dialog',async d=>{dialogs.push(d.message());await d.accept();});
    await page.goto(BASE+'/S-Dnevnik.html');
    await page.waitForFunction(()=>!!(window as any).SdnLocalSrv && !!(window as any).SdnV3);
    await page.waitForTimeout(1000);
    await page.evaluate(()=>(window as any).SdnLocalSrv.sync({auto:true}));
    await page.waitForFunction(()=>(window as any).students.length===2);
    await page.evaluate(()=>{(window as any).switchTab('schedule');(window as any).renderSchedule();});
    check('the assignment modal is removed',await page.locator('#assignModal').count()===0);
    await page.locator('.schedule-cell[data-day="monday"][data-time="0"] .schedule-pick-button').click();
    check('the cell opens pupil dropdowns',await page.locator('.schedule-pickers select').count()===2);
    check('the dropdown stays inside its timetable cell', await page.locator('.schedule-pickers').evaluate(e => {
        const box=e.getBoundingClientRect(), parent=e.parentElement!.getBoundingClientRect();
        return box.left>=parent.left && box.right<=parent.right && document.querySelector('.schedule-grid')!.getBoundingClientRect().right<=innerWidth;
    }));
    await page.locator('.schedule-pickers select').nth(1).selectOption('9001');
    await page.locator('.schedule-pickers [data-save-slot]').click();
    check('a duplicate pupil is refused',dialogs.some(d=>d.includes('различни ученици')) && await page.locator('.schedule-pickers').count()===1);
    await mkdir('../backups/qa',{recursive:true});
    await page.screenshot({path:'../backups/qa/diary-dropdown.png'});
    await page.locator('.schedule-pickers button').filter({hasText:'Откажи'}).click();
    check('cancel leaves the slot unchanged',await page.evaluate(()=>(window as any).schedule.monday[0][0]===9001));
    await page.evaluate(()=>{(window as any).openSchedulePicker('monday',0);});
    await page.locator('.schedule-pickers select').nth(0).selectOption('9002');
    await page.locator('.schedule-pickers [data-save-slot]').click();
    check('dropdown save changes only the selected term',await page.evaluate(()=>(window as any).schedule.monday[0][0]===9002));
    await page.waitForSelector('#planSyncModal.active');
    await page.click('#planSyncClose');
    await page.evaluate(()=>{(window as any).copyShownWeek();(window as any).changeWeek(1);});
    const countBefore=(await q('SELECT count(*)::int AS n FROM diary_cabinet_changes'))[0].n;
    await page.click('#weekPasteBtn');
    await page.click('#weekChoiceModal [data-choice="onward"]');
    await page.waitForFunction(()=>document.querySelector('#weekChoiceModal h2')?.textContent==='Потврди постојан распоред');
    await page.screenshot({path:'../backups/qa/diary-onward-confirm.png'});
    await page.click('#weekChoiceModal [data-choice=""]');
    check('cancelling final confirmation creates no shared change',(await q('SELECT count(*)::int AS n FROM diary_cabinet_changes'))[0].n===countBefore);
    // Lose the acknowledgement after the transaction committed. The browser
    // must retain and resend the exact UUID, not create another version.
    let committedVersion=0;
    await page.route('**/api/diary/ongoing-plan',async route=>{
        if(route.request().method()!=='PUT') return route.continue();
        const response=await route.fetch();
        const body=await response.json();
        check('browser onward request accepted',response.status()===200);
        committedVersion=body.version;
        await route.abort('internetdisconnected');
    });
    await page.click('#weekPasteBtn');
    await page.click('#weekChoiceModal [data-choice="onward"]');
    await page.waitForFunction(()=>document.querySelector('#weekChoiceModal h2')?.textContent==='Потврди постојан распоред');
    await page.click('#weekChoiceModal [data-choice="confirm"]');
    await page.waitForFunction(()=>localStorage.getItem('sdn_confirmed_ongoing_plan_v1')!==null && ((window as any).__MTB_DATA_STATE__||{}).state==='pending');
    while(!committedVersion) await page.waitForTimeout(50);
    await page.unroute('**/api/diary/ongoing-plan');
    const wrongServer = await page.evaluate(async () => {
        const key='sdn_confirmed_ongoing_plan_v1', saved=localStorage.getItem(key)!;
        const queued=JSON.parse(saved);queued.server='https://another-installation.invalid';
        localStorage.setItem(key,JSON.stringify(queued));
        const result=await (window as any).SdnLocalSrv.sync({auto:true});
        const retained=localStorage.getItem(key)!==null;
        localStorage.setItem(key,saved);
        return result==='conflict' && retained;
    });
    check('a confirmed request never moves to another server',wrongServer && (await stored()).version===committedVersion);
    await page.reload();
    await page.waitForFunction(()=>!!(window as any).SdnLocalSrv && !!(window as any).SdnV3);
    await page.waitForTimeout(1000);
    await page.evaluate(()=>(window as any).SdnLocalSrv.sync({auto:true}));
    await page.waitForFunction(()=>localStorage.getItem('sdn_confirmed_ongoing_plan_v1')===null);
    check('retry after reopening does not save the confirmed plan twice',(await stored()).version===committedVersion);
    check('the browser receives its future plan after the lost acknowledgement',await page.evaluate(k=>(window as any).planFrom[k]?.monday[0][0]===9002,shift(current,7)));
    const backupRace=await page.evaluate(async () => {
        const w=window as any, original=w.SdnV3.backup;
        w.SdnV3.backup=async (...args:any[]) => {
            await original(...args);
            w.schedule.tuesday[0]=[9001];
            w.saveData();
        };
        try {
            const result=await w.SdnLocalSrv.publishOngoing({});
            return result===false && w.schedule.tuesday[0][0]===9001 && localStorage.getItem('sdn_confirmed_ongoing_plan_v1')===null;
        } finally { w.SdnV3.backup=original; }
    });
    check('an edit during the confirmation backup is preserved and requires confirmation again',backupRace && (await stored()).version===committedVersion);
    check('no browser errors',errors.length===0);
    console.log(`${passed} checks passed`);
} finally { await browser?.close(); await pool.end(); }

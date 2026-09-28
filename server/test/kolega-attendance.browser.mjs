import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '../..'), origin = 'http://localhost:3990';
const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
const context = await browser.newContext({ viewport:{width:1400,height:1000},serviceWorkers:'block' });
const marks = new Map(), revisions = new Map(), errors = [], writes = [];
let failWrite = false;
await context.addInitScript(() => {
    localStorage.setItem('mtb_portal_token_v1','a'.repeat(64));
    window.print = () => { window.printClasses = document.body.className; };
});
const days = ['понеделник','вторник','среда','четврток','петок'];
await context.route('**/*', async route => {
    const req = route.request(), u = new URL(req.url());
    const json = (status, body) => route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
    if (u.pathname === '/Kolega.html') return route.fulfill({contentType:'text/html; charset=utf-8',body:await readFile(resolve(root,'Kolega.html'))});
    if (u.pathname === '/api/portal/me') return json(200,{person:{employeeId:7,name:'Измислен Терапевт'},usernames:{latin:'Test',cyrillic:'Тест'},year:'2026/2027',roles:['therapist'],therapist:{id:5},teacher:null,duty:true});
    if (u.pathname === '/api/portal/week') return json(200,{year:'2026/2027',days,periods:[],me:{teacherId:null,therapistId:5,homeroom:[]},classes:[],teachers:[],lessons:[],clashes:[],notices:[],
        cabinet:{bells:[{ordinal:1,label:'I',time:'08:00-08:40'}],pupils:[{publicId:'fake',name:'Измислен Ученик',class:'Тест'}],names:{},elsewhere:[],terms:[{day:days[0],time:'08:00-08:40',pupils:['fake']}]}});
    if (u.pathname === '/api/duty') return json(403,{});
    if (u.pathname === '/api/portal/duty') return json(200,{year:'2026/2027',month:'2026-09',today:'2026-09-28',startsOn:'2026-09-01',yearStartsOn:'2026-09-01',yearEndsOn:'2027-08-31',members:[{employeeId:7,name:'Измислен Терапевт',position:1}],days:[
        {date:'2026-09-07',weekday:1,name:'Измислен Терапевт',employeeId:7,closed:false,how:'rotation',note:'',covers:[],absent:[]},
        {date:'2026-09-28',weekday:1,name:'Измислен Терапевт',employeeId:7,closed:false,how:'rotation',note:'',covers:[],absent:[]}],staleSwaps:[]});
    if (u.pathname === '/api/portal/attendance') {
        assert.equal(req.headers()['x-mtb-portal-token'],'a'.repeat(64));
        if (req.method() === 'PUT') {
            const b = req.postDataJSON(); writes.push(b);
            if (failWrite) { failWrite=false; return json(409,{error:'Пробен судир: освежете.'}); }
            marks.set(b.date+'|'+b.key,b.status); revisions.set(b.date,(revisions.get(b.date)||0)+1); return json(200,{ok:true});
        }
        const from=u.searchParams.get('from'), to=u.searchParams.get('to'), result=[];
        for(let time=Date.parse(from+'T00:00:00Z');time<=Date.parse(to+'T00:00:00Z');time+=86400000){
            const date=new Date(time).toISOString().slice(0,10), wd=new Date(time).getUTCDay();
            result.push({date,dayName:days[wd-1]||'Викенд',closed:wd===0||wd===6?'Викенд':null,future:date>'2026-09-28',conflict:false,
                frozen:revisions.has(date),revision:revisions.get(date)||0,planToken:'b'.repeat(64),sessions:wd===1?['08:00-08:40','08:45-09:05'].map(time=>({
                    key:'fake|'+time,publicId:'fake',name:'Измислен Ученик',grade:'Тест',time,status:marks.get(date+'|fake|'+time)||null})):[]});
        }
        return json(200,{from,to,year:'2026/2027',today:'2026-09-28',yearStart:'2026-09-01',yearEnd:'2027-08-31',calendarAvailable:true,days:result});
    }
    return json(404,{});
});
const p = await context.newPage(); p.on('pageerror',e=>errors.push(e.message));
const ready = () => p.waitForSelector('#attendanceSheet table');
try {
    await p.goto(origin+'/Kolega.html');
    await p.click('[data-tab="attendance"]');
    await p.locator('#attendanceDate').fill('2026-09-28'); await ready();
    const cell = p.locator('[data-att-date="2026-09-28"]').first();
    for(const status of ['present','absent',null]){
        await cell.click(); await ready();
        assert.equal(writes.at(-1).status,status);
        assert.equal(await cell.getAttribute('class'),'attendance-mark '+(status||'blank'));
    }
    failWrite=true; await cell.click(); await ready();
    assert.match(await p.locator('#weekMsg').innerText(),/Пробен судир/);
    assert.match(await cell.getAttribute('class'),/blank/,'failed mark never shown as saved');
    await cell.click(); await ready();
    await p.reload(); await p.click('[data-tab="attendance"]');
    await p.locator('#attendanceDate').fill('2026-09-28'); await ready();
    assert.match(await cell.getAttribute('class'),/present/,'mark survives reload');
    await p.click('[data-att-mode="month"]'); await ready();
    assert.equal(await p.locator('.attendance-table tbody tr').count(),1);
    const totals = await p.locator('.attendance-table tbody tr td').allTextContents();
    assert.deepEqual(totals.slice(-4),['8','1','0','7'],'two treatments per date counted separately');
    const [attPng] = await Promise.all([p.waitForEvent('download'),p.click('[data-att-png]')]);
    assert.match(attPng.suggestedFilename(),/^Prisustvo-.*\.png$/);
    const artifacts=resolve(root,'backups/test-artifacts');await mkdir(artifacts,{recursive:true});
    await attPng.saveAs(resolve(artifacts,'attendance-month.png'));
    await p.click('[data-att-print]'); assert.match(await p.evaluate(()=>window.printClasses),/printing-attendance/);
    await p.emulateMedia({media:'print'});
    assert.equal(await p.locator('#days').isVisible(),false);
    assert.equal(await p.locator('#attendanceSheet').isVisible(),true);
    await p.screenshot({path:resolve(artifacts,'attendance-print.png'),fullPage:true});
    await p.pdf({path:resolve(artifacts,'attendance-print.pdf'),preferCSSPageSize:true,printBackground:true});
    await p.evaluate(()=>window.dispatchEvent(new Event('afterprint')));await p.emulateMedia({media:'screen'});
    await p.setViewportSize({width:400,height:850});
    assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'mobile page does not overflow; table scrolls inside');
    await p.click('[data-tab="duty"]'); await p.waitForSelector('#dutyPng');
    const [dutyPng] = await Promise.all([p.waitForEvent('download'),p.click('#dutyPng')]);
    await dutyPng.saveAs(resolve(artifacts,'duty.png'));
    await p.click('#dutyPrint'); assert.match(await p.evaluate(()=>window.printClasses),/printing-duty/);
    await p.evaluate(()=>window.dispatchEvent(new Event('afterprint')));
    await p.click('[data-tab="cabinet"]');await p.click('[data-week]');
    const [weekPng] = await Promise.all([p.waitForEvent('download'),p.click('#pngWeek')]);
    assert.match(weekPng.suggestedFilename(),/Licen-raspored/);
    await p.click('#printWeek');assert.match(await p.evaluate(()=>window.printClasses),/printing-week/);
    assert.deepEqual(errors,[]);
    console.log('PASS: attendance cycle, conflict, reload, monthly totals, mobile, print/PDF and all three PNG exports.');
} finally { await browser.close(); }

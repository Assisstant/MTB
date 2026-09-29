import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const root=resolve(import.meta.dirname,'../..'), out=resolve(root,'backups/reader-ui-test');
await mkdir(out,{recursive:true});
const browser=await chromium.launch({...(process.env.CHROME?{executablePath:process.env.CHROME}:{})});
const context=await browser.newContext({viewport:{width:1300,height:950},serviceWorkers:'block'});
const errors=[],writes=[];
const days=['понеделник','вторник','среда','четврток','петок'];
const pupils=[{name:'Измислен Ученик Алфа',class:'Т-А',className:'Прва тест',oddelenie:'I',type:'internal',therapists:[{employeeId:2,name:'Измислен Кабинет'}]},
    {name:'Измислен Ученик Бета',class:'Т-Б',className:'Втора тест',oddelenie:'II',type:'external',therapists:[]}];
await context.addInitScript(()=>{localStorage.setItem('mtb_portal_token_v1','a'.repeat(64));window.print=()=>{window.printed=document.body.className;};});
await context.route('**/*',async route=>{
    const req=route.request(),u=new URL(req.url()),p=u.pathname;
    const json=(status,body)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
    if(p==='/Kolega.html') return route.fulfill({contentType:'text/html; charset=utf-8',body:await readFile(resolve(root,'Kolega.html'))});
    if(req.method()!=='GET') writes.push(p);
    if(p==='/api/portal/me') return json(200,{person:{employeeId:1,name:'Измислена Администрација'},readOnly:true,usernames:{latin:'Reader',cyrillic:'Читач'},year:'2026/2027',roles:[],teacher:null,therapist:null});
    if(p==='/api/portal/read-only/staff') return json(200,{staff:[{employeeId:2,name:'Измислен Кабинет',therapist:true},{employeeId:3,name:'Измислен Наставник',teacher:true}]});
    if(p==='/api/portal/read-only/pupils') return json(200,{year:'2026/2027',pupils});
    if(p==='/api/portal/week') {
        const cabinet=u.searchParams.get('employeeId')==='2';
        return json(200,{year:'2026/2027',readOnly:true,viewedPerson:{name:cabinet?'Измислен Кабинет':'Измислен Наставник'},days,
            periods:[{ordinal:1,label:'1',startsAt:'08:00'}],me:{teacherId:cabinet?null:3,therapistId:cabinet?2:null,homeroom:[]},classes:[],teachers:[],classPupils:{},classAway:[],notices:[],clashes:[],
            lessons:[{day:days[0],ordinal:1,teacherId:3,class:'Т-А',subject:'Пробен предмет'}],
            cabinet:cabinet?{bells:[{ordinal:1,label:'1',time:'08:00-08:40'}],pupils:[{publicId:'fake',name:pupils[0].name}],names:{},elsewhere:[],terms:[{day:days[0],time:'08:00-08:40',pupils:['fake']}]}:null});
    }
    if(p==='/api/portal/attendance') {
        assert.equal(u.searchParams.get('employeeId'),'2');
        const from=u.searchParams.get('from'),to=u.searchParams.get('to');
        return json(200,{year:'2026/2027',from,to,readOnly:true,calendarAvailable:true,days:[{date:from,dayName:days[0],frozen:true,revision:1,planToken:'a'.repeat(64),sessions:[
            {key:'fake|08:00',publicId:'fake',name:pupils[0].name,grade:'I',time:'08:00-08:40',status:'present'}]}]});
    }
    if(p==='/api/portal/read-only/transport') return json(200,{year:'2026/2027',month:u.searchParams.get('month'),note:'Зачувана евиденција',generatedAt:'2026-09-29T10:00:00Z',pupils:[{studentId:1,name:pupils[1].name,dates:['2026-09-28'],daysPresent:1}]});
    return json(403,{error:'Нема пристап'});
});
const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
const docx=async(selector,file,text)=>{
    const [download]=await Promise.all([page.waitForEvent('download'),page.click(selector)]);
    assert.match(download.suggestedFilename(),/\.docx$/); const path=resolve(out,file+'.docx');await download.saveAs(path);
    const data=await readFile(path);assert.equal(data.readUInt32LE(0),0x04034b50);
    assert.ok(data.toString('utf8').includes(text),'DOCX contains selected report data');
};
try {
    await page.goto('http://localhost:3987/Kolega.html');await page.click('#welcomeContinue');
    await page.waitForSelector('#weekSheet .sheet');
    assert.match(await page.textContent('#homeRoles'),/Само преглед/);
    assert.equal(await page.locator('[data-edit-term]:visible,[data-edit]:visible,#myLists:visible,#caseload:visible').count(),0);
    assert.equal(await page.locator('#weekSheet [data-go-day]').count(),0);
    await docx('#docxWeek','schedule',pupils[0].name);
    const [image]=await Promise.all([page.waitForEvent('download'),page.click('#pngWeek')]);assert.match(image.suggestedFilename(),/\.png$/);
    await page.click('#printWeek');assert.match(await page.evaluate(()=>window.printed),/printing-week/);
    await page.evaluate(()=>window.dispatchEvent(new Event('afterprint')));
    await page.click('[data-tab="reader-list"]');
    await page.selectOption('[data-reader-filter="type"]','external');
    assert.equal(await page.locator('#weekSheet tbody tr').count(),1);assert.match(await page.textContent('#weekSheet tbody'),/Бета/);
    await docx('#docxWeek','pupils',pupils[1].name);
    await page.click('[data-tab="attendance"]');await page.waitForSelector('[data-att-key]');
    assert.equal(await page.locator('[data-att-key]:enabled').count(),0);
    await docx('[data-att-docx]','attendance',pupils[0].name);
    await page.selectOption('#attendanceScope','transport');await page.waitForSelector('.transport-dates');
    await docx('[data-att-docx]','transport',pupils[1].name);
    await page.selectOption('#readerStaff','3');await page.click('[data-tab="mine"]');
    await page.waitForFunction(()=>document.querySelector('#weekSheet')?.textContent.includes('Пробен предмет'));
    await docx('#docxWeek','teacher','Пробен предмет');
    for(const theme of ['light','dark']) {
        await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
        await page.setViewportSize({width:390,height:844});
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),'page fits phone; report scrolls inside');
        await page.screenshot({path:resolve(out,'reader-'+theme+'.png'),fullPage:true});
    }
    assert.deepEqual(writes,[],'viewing and every export sends no mutation');assert.deepEqual(errors,[]);
    console.log('PASS read-only cabinet/teacher, filtered pupil lists, disabled attendance, print/PNG/DOCX and phone themes');
} finally {await browser.close();}

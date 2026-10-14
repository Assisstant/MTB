import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const root=resolve(import.meta.dirname,'../..'),out=resolve(root,'backups/stay-ui-test');
await mkdir(out,{recursive:true});
const browser=await chromium.launch();
const context=await browser.newContext({viewport:{width:412,height:900},serviceWorkers:'block'});
await context.addInitScript(()=>localStorage.setItem('mtb_portal_token_v1','a'.repeat(64)));
const pupils=[{publicId:'test-a',name:'Пробен Ученик Алфа',grade:'Пробна А',selected:false},
    {publicId:'test-b',name:'Пробен Ученик Бета',grade:'Пробна Б',selected:false}];
let marks=[],fail=false;
const writes=[],errors=[];
await context.route('**/*',async route=>{
    const req=route.request(),u=new URL(req.url()),p=u.pathname;
    const json=(status,body)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
    if(p==='/Kolega.html')return route.fulfill({contentType:'text/html; charset=utf-8',body:await readFile(resolve(root,'Kolega.html'))});
    if(p==='/api/portal/me')return json(200,{person:{employeeId:4,name:'Пробен Вработен Престој'},year:'2026/2027',roles:['stay'],teacher:null,therapist:null,usernames:{latin:'Test',cyrillic:'Пробен'},initialPassword:true});
    if(p==='/api/portal/week')return json(200,{days:[],periods:[],me:{teacherId:null,therapistId:null,homeroom:[]},classes:[],teachers:[],lessons:[],clashes:[],notices:[],cabinet:null});
    if(p==='/api/portal/stay/pupils')return json(200,{pupils});
    if(p==='/api/portal/stay') {
        const month=u.searchParams.get('month');
        const days=Array.from({length:31},(_,i)=>{const date=month+'-'+String(i+1).padStart(2,'0');return {date,closed:[0,6].includes(new Date(date+'T12:00:00Z').getUTCDay())?'Викенд':null,future:false};});
        return json(200,{year:'2026/2027',month,pupils:pupils.filter(p=>p.selected||marks.some(m=>m.publicId===p.publicId)),marks,days,readOnly:false});
    }
    if(p.startsWith('/api/portal/stay/')&&req.method()==='PUT') {
        const b=req.postDataJSON();writes.push(b);
        if(fail){fail=false;return json(409,{error:'Ознаката е сменета во друг прозорец.'});}
        if(p.endsWith('/pupil'))pupils.find(p=>p.publicId===b.publicId).selected=b.active;
        else {marks=marks.filter(m=>m.publicId!==b.publicId||m.date!==b.date);if(b.status)marks.push({publicId:b.publicId,date:b.date,status:b.status});}
        return json(200,{ok:true});
    }
    return json(404,{});
});
const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
const idle=()=>page.waitForFunction(()=>document.querySelector('#stayMonth')&&!document.querySelector('#stayMonth').disabled);
try {
    await page.goto('http://localhost:3990/Kolega.html');await page.click('#welcomeContinue');
    await page.waitForSelector('#stayMonth');
    await page.fill('#stayMonth','2026-10');await idle();
    assert.equal(await page.locator('#tabs [data-tab]').count(),1,'only the stay category');
    await page.click('[data-stay-list]');
    await page.check('[data-stay-pupil="test-a"]');await idle();
    const cell='[data-stay-mark="test-a"][data-stay-date="2026-10-01"]';
    await page.click(cell);await idle();assert.equal(await page.locator(cell).innerText(),'✓');
    await page.click(cell);await idle();assert.equal(await page.locator(cell).innerText(),'✕');
    fail=true;await page.click(cell);await idle();
    assert.equal(await page.locator(cell).innerText(),'✕','refused writes do not pretend success');
    assert.match(await page.locator('#stay [role=status]').innerText(),/друг прозорец/);
    await page.click(cell);await idle();assert.equal(await page.locator(cell).innerText(),'—');
    await page.click(cell);await idle();
    await page.uncheck('[data-stay-pupil="test-a"]');await idle();
    assert.equal(await page.locator(cell).innerText(),'✓','removing from own list keeps marks');
    assert.match(await page.locator('.stay-table tbody th').innerText(),/Претходни ознаки/);
    await page.check('[data-stay-pupil="test-a"]');await idle();
    await page.fill('#staySearch','Бета');
    assert.equal(await page.locator('[data-stay-label]:visible').count(),1);
    await page.click('[data-stay-list]');
    assert.equal(await page.locator('[data-stay-date="2026-10-03"]').isDisabled(),true);
    for(const theme of ['light','dark']) {
        await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'phone scroll stays inside the table');
        const style=await page.locator('.stay-table td.closed').first().evaluate(e=>{const s=getComputedStyle(e);return {bg:s.backgroundColor,pattern:s.backgroundImage,border:s.borderTopWidth};});
        assert.equal(style.border,'1px');assert.match(style.pattern,/gradient/);
        if(theme==='dark')assert.ok(style.bg.match(/\d+/g).slice(0,3).every(n=>+n<130),JSON.stringify(style));
        await page.screenshot({path:resolve(out,'stay-phone-'+theme+'.png'),fullPage:true});
    }
    await page.setViewportSize({width:1440,height:900});
    await page.screenshot({path:resolve(out,'stay-desktop-dark.png'),fullPage:true});
    assert.ok(writes.length>=7);assert.deepEqual(errors,[]);
    console.log('PASS: stay phone/desktop, own list, three marks, conflict, history, search and themes');
}finally{await browser.close();}

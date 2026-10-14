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
    if(p==='/api/portal/stay/pupils'&&req.method()==='GET')return json(200,{pupils});
    if(p==='/api/portal/stay') {
        const month=u.searchParams.get('month');
        const days=Array.from({length:31},(_,i)=>{const date=month+'-'+String(i+1).padStart(2,'0');return {date,closed:[0,6].includes(new Date(date+'T12:00:00Z').getUTCDay())?'Викенд':null,future:false};});
        return json(200,{year:'2026/2027',month,pupils:pupils.filter(p=>p.selected||marks.some(m=>m.publicId===p.publicId)),marks,days,readOnly:false});
    }
    if(p.startsWith('/api/portal/stay/')&&req.method()==='PUT') {
        const b=req.postDataJSON();writes.push(b);
        if(fail){fail=false;return json(409,{error:'Ознаката е сменета во друг прозорец.'});}
        if(p.endsWith('/pupils')) {
            // The whole list, refused when it was not what the screen opened with.
            const now=pupils.filter(x=>x.selected).map(x=>x.publicId);
            if(now.length!==b.expected.length||now.some(id=>!b.expected.includes(id)))return json(409,{error:'Списокот е сменет во меѓувреме.'});
            pupils.forEach(x=>{x.selected=b.publicIds.includes(x.publicId);});
        }
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
    // „Мој список" as „Ученици по терапевт" in Кабинети: ticked in a draft, written by „Зачувај список" (owner, 14 Oct 2026).
    const openList=async()=>{await page.click('[data-stay-list]');await page.waitForSelector('#stayPickCount');};
    const saveList=async()=>{await page.click('[data-stay-list-save]');await idle();};
    await openList();
    await page.check('[data-stay-pupil="test-a"]');
    assert.equal(await page.locator('#stayPickCount').innerText(),'1 избран ученик');
    assert.equal(writes.length,0,'a tick is not a save');
    const look=await page.locator('.pick-item').first().evaluate(row=>{const box=row.querySelector('input').getBoundingClientRect(),name=row.querySelector('span').getBoundingClientRect();
        return {box:Math.round(box.width),left:box.right<=name.left,row:Math.abs(box.top-name.top)<16,number:row.querySelector('.pick-no').textContent};});
    assert.deepEqual(look,{box:18,left:true,row:true,number:'1.'},'a small box left of the numbered name');
    await saveList();
    assert.deepEqual(writes.at(-1),{publicIds:['test-a'],expected:[]});
    assert.equal(await page.locator('.pick-panel').count(),0,'a saved list closes');
    assert.match(await page.locator('#stay [role=status]').innerText(),/Зачувано: \+1 \/ −0/);
    const cell='[data-stay-mark="test-a"][data-stay-date="2026-10-01"]';
    await page.click(cell);await idle();assert.equal(await page.locator(cell).innerText(),'✓');
    await page.click(cell);await idle();assert.equal(await page.locator(cell).innerText(),'✕');
    fail=true;await page.click(cell);await idle();
    assert.equal(await page.locator(cell).innerText(),'✕','refused writes do not pretend success');
    assert.match(await page.locator('#stay [role=status]').innerText(),/друг прозорец/);
    await page.click(cell);await idle();assert.equal(await page.locator(cell).innerText(),'—');
    await page.click(cell);await idle();
    await openList();await page.uncheck('[data-stay-pupil="test-a"]');await saveList();
    assert.equal(await page.locator(cell).innerText(),'✓','removing from own list keeps marks');
    assert.match(await page.locator('.stay-table tbody th').innerText(),/Претходни ознаки/);
    await openList();await page.check('[data-stay-pupil="test-a"]');await saveList();
    await openList();
    await page.fill('#staySearch','Бета');
    assert.equal(await page.locator('.pick-item:visible').count(),1);
    assert.equal(await page.locator('.pick-item:visible .pick-no').innerText(),'1.','the shown are numbered again');
    const before=writes.length;
    await page.check('[data-stay-pupil="test-b"]');await page.click('.pick-foot [data-stay-list-cancel]');
    assert.equal(writes.length,before,'„Откажи" writes nothing');
    await openList();
    assert.equal(await page.isChecked('[data-stay-pupil="test-b"]'),false,'and the tick is gone');
    // A refused save keeps the list open, as it was ticked.
    await page.check('[data-stay-pupil="test-b"]');pupils.find(x=>x.publicId==='test-b').selected=true;await saveList();
    assert.match(await page.locator('#stay [role=status]').innerText(),/Не е зачувано\. Списокот е сменет/);
    assert.equal(await page.isChecked('[data-stay-pupil="test-b"]'),true);
    pupils.find(x=>x.publicId==='test-b').selected=false;
    await page.click('.pick-foot [data-stay-list-cancel]');await page.click('[data-stay-refresh]');await idle();
    assert.equal(await page.locator('[data-stay-date="2026-10-03"]').isDisabled(),true);
    // Owner, 14 Oct 2026: green and red as in S-Дневник, and the standard ways out.
    await page.click('[data-stay-mark="test-a"][data-stay-date="2026-10-02"]');await idle();
    await page.click('[data-stay-mark="test-a"][data-stay-date="2026-10-02"]');await idle();
    for(const theme of ['light','dark']) {
        await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
        const fill=s=>page.locator('[data-stay-mark="test-a"][data-stay-date="2026-10-0'+s+'"]').evaluate(e=>getComputedStyle(e).backgroundColor);
        assert.equal(await fill(1),'rgb(72, 187, 120)',theme+': present is green');
        assert.equal(await fill(2),'rgb(245, 101, 101)',theme+': absent is red');
    }
    for(const [button,name] of [['data-stay-png',/^Prestoj-2026-10\.png$/],['data-stay-pdf',/^Prestoj-2026-10\.pdf$/],['data-stay-docx',/^Prestoj-2026-10\.docx$/]]) {
        const download=page.waitForEvent('download');await page.click('['+button+']');
        assert.match((await download).suggestedFilename(),name,button);
    }
    // The browser's print dialog is not opened in a test: the page's own print steps are run and the print layout is looked at.
    await page.evaluate(()=>{window.print=()=>{window.__printed=true;};});
    await page.click('[data-stay-print]');
    await page.evaluate(()=>window.dispatchEvent(new Event('beforeprint')));
    await page.emulateMedia({media:'print'});
    const printed=await page.evaluate(()=>({asked:window.__printed===true,stay:getComputedStyle(document.getElementById('stay')).display,
        tools:getComputedStyle(document.querySelector('#stay .row')).display,table:getComputedStyle(document.querySelector('.stay-table')).display,
        green:getComputedStyle(document.querySelector('.stay-table td.mark-present')).backgroundColor,preparer:document.querySelector('#staySheet .print-preparer')!==null}));
    assert.deepEqual(printed,{asked:true,stay:'block',tools:'none',table:'table',green:'rgb(232, 245, 236)',preparer:true});
    await page.emulateMedia({media:'screen'});await page.evaluate(()=>window.dispatchEvent(new Event('afterprint')));
    assert.match(await page.locator('#staySheet h2').innerText(),/^Престој — Пробен Вработен Престој$/);
    assert.match(await page.locator('#staySheet > p:not(.print-preparer)').innerText(),/октомври 2026 · учебна 2026\/2027/);
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
    await openList();await page.screenshot({path:resolve(out,'stay-list-desktop-dark.png')});
    await page.evaluate(()=>document.documentElement.dataset.theme='light');await page.screenshot({path:resolve(out,'stay-list-desktop-light.png')});
    await page.setViewportSize({width:412,height:900});await page.screenshot({path:resolve(out,'stay-list-phone-light.png')});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'the list fits the phone');
    assert.ok(writes.length>=7);assert.deepEqual(errors,[]);
    console.log('PASS: stay phone/desktop, own list, three marks, conflict, history, search and themes');
}finally{await browser.close();}

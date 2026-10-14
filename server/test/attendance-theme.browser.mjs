import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname, basename } from 'node:path';
import { chromium } from 'playwright';
const root=resolve(import.meta.dirname,'../..'),out=resolve(root,'backups/stay-ui-test');
await mkdir(out,{recursive:true});
const browser=await chromium.launch();
const context=await browser.newContext({viewport:{width:1440,height:900},serviceWorkers:'block'});
await context.addInitScript(()=>localStorage.setItem('sdn_local_server_autosync_v1','0'));
await context.route('**/*',async route=>{
    const u=new URL(route.request().url());
    if(u.origin!=='http://localhost:4614'||u.pathname.startsWith('/api/'))return route.fulfill({status:404,body:'{}'});
    const name=basename(u.pathname);
    if(name==='mtb-runtime.js')return route.fulfill({contentType:'application/javascript',body:'window.MTB_CLOUD_SAME_ORIGIN=false;window.MTB_MIRROR_READONLY=false;'});
    try{return route.fulfill({contentType:{'.html':'text/html; charset=utf-8','.js':'application/javascript','.css':'text/css'}[extname(name)]||'application/octet-stream',body:await readFile(resolve(root,name))});}
    catch{return route.fulfill({status:404,body:''});}
});
const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
page.on('dialog',d=>d.accept());
try {
    await page.goto('http://localhost:4614/S-Dnevnik.html');
    await page.waitForFunction(()=>window.SdnV3);
    await page.evaluate(()=>{
        students=[{id:1001,name:'Пробен Ученик Алфа',grade:'Пробна А'},{id:1002,name:'Пробен Ученик Бета',grade:'Пробна Б'}];
        attendance={'2026-10-01':{1001:{'monday-0':{status:'present'}}}};
        schoolCalendar=calendarFromStored({yearStart:'2026-09-01',yearEnd:'2027-06-10',firstHalfEnd:'2027-01-31',holidays:[{name:'Пробен празник',start:'2026-10-12',end:'2026-10-12',kind:'praznik'}]});
        document.getElementById('monthSelector').value='2026-10';
        generateMonthlyAttendance();
        // Inspect only this rendered report; its original hidden tab is not part of this theme check.
        const report=document.getElementById('monthlyAttendanceTable');document.body.appendChild(report);
        for(const child of document.body.children)if(child!==report&&child.tagName!=='SCRIPT')child.style.display='none';
        report.style.display='block';
    });
    for(const theme of ['light','dark']) {
        await page.evaluate(t=>{document.documentElement.dataset.theme=t;document.body.classList.toggle('dark-mode',t==='dark');},theme);
        const style=await page.locator('#monthlyAttendanceTable td.attendance-weekend').first().evaluate(e=>{const s=getComputedStyle(e);return {bg:s.backgroundColor,image:s.backgroundImage,border:s.borderTopWidth};});
        assert.match(style.image,/gradient/);assert.equal(style.border,'1px');
        if(theme==='dark')assert.ok(style.bg.match(/\d+/g).slice(0,3).every(n=>+n<130),JSON.stringify(style));
        const holiday=await page.locator('#monthlyAttendanceTable td.attendance-holiday').first().evaluate(e=>getComputedStyle(e).backgroundColor);
        if(theme==='dark')assert.ok(holiday.match(/\d+/g).slice(0,3).every(n=>+n<130),holiday);
        assert.equal(await page.locator('#monthlyAttendanceTable .date-cell').innerText(),'✓');
        await page.screenshot({path:resolve(out,'diary-attendance-'+theme+'.png'),fullPage:true});
    }
    assert.deepEqual(errors,[]);console.log('PASS: diary light grid and dark weekends/holidays, marks unchanged');
}finally{await browser.close();}

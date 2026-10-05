import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '../..'), origin = 'http://localhost:3990';
const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
const context = await browser.newContext({ viewport:{width:1400,height:1000},serviceWorkers:'block' });
const marks = new Map(), revisions = new Map(), errors = [], writes = [];
let failWrite = false, transportAllowed = true, transportReads = 0, attendanceReads = 0, extendedTransport = false, denyTransport = false;
await context.addInitScript(() => {
    localStorage.setItem('mtb_portal_token_v1','a'.repeat(64));
    window.print = () => { window.printClasses = document.body.className; };
});
const days = ['понеделник','вторник','среда','четврток','петок'];
await context.route('**/*', async route => {
    const req = route.request(), u = new URL(req.url());
    const json = (status, body) => route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
    if (u.pathname === '/Kolega.html') return route.fulfill({contentType:'text/html; charset=utf-8',body:await readFile(resolve(root,'Kolega.html'))});
    if (u.pathname === '/api/portal/me') return json(200,{person:{employeeId:7,name:'Измислен Терапевт'},usernames:{latin:'Test',cyrillic:'Тест'},year:'2026/2027',roles:['therapist'],therapist:{id:5},teacher:null,duty:true,author:'Измислен Автор'});
    if (u.pathname === '/api/attendance/transport/access') return json(transportAllowed?200:403,{allowed:transportAllowed});
    if (u.pathname === '/api/attendance/transport') {
        assert.equal(req.method(),'GET'); transportReads++;
        assert.equal(req.headers()['x-mtb-duty-admin-token'],undefined);
        if(denyTransport) return json(403,{error:'Пробно одбиен пристап.'});
        const month=u.searchParams.get('month');
        if(extendedTransport) return json(200,{month,year:'2026/2027',generatedAt:'2026-09-28T12:00:00Z',note:'Само потврдени различни датуми.',pupils:
            Array.from({length:15},(_,i)=>{
                const count=[0,4,5,8,9,22,31][i%7];
                return {studentId:100+i,name:'Измислен Ученик '+(i+1)+' & <тест>',daysPresent:count,
                    dates:Array.from({length:count},(_,j)=>month+'-'+String(j+1).padStart(2,'0'))};
            })});
        return json(200,{month,from:month+'-01',to:month+'-30',year:'2026/2027',generatedAt:'2026-09-28T12:00:00Z',note:'Само потврдени различни датуми.',pupils:[
            {studentId:11,name:'Измислен Надворешен Алфа',grade:'VI-тест',dates:[month+'-07',month+'-14'],daysPresent:2},
            {studentId:12,name:'Измислен Надворешен Бета',grade:'',dates:[],daysPresent:0}]});
    }
    if (u.pathname === '/api/portal/week') return json(200,{year:'2026/2027',days,periods:[],me:{teacherId:null,therapistId:5,homeroom:[]},classes:[],teachers:[],lessons:[],clashes:[],notices:[],
        cabinet:{bells:[{ordinal:1,label:'I',time:'08:00-08:40'}],pupils:[{publicId:'fake',name:'Измислен Ученик',class:'Тест'}],names:{},elsewhere:[],terms:[{day:days[0],time:'08:00-08:40',pupils:['fake']}]}});
    if (u.pathname === '/api/duty') return json(403,{});
    if (u.pathname === '/api/portal/duty') return json(200,{year:'2026/2027',month:'2026-09',today:'2026-09-28',startsOn:'2026-09-01',yearStartsOn:'2026-09-01',yearEndsOn:'2027-08-31',members:[{employeeId:7,name:'Измислен Терапевт',position:1}],days:[
        {date:'2026-09-07',weekday:1,name:'Измислен Терапевт',employeeId:7,number:1,cycle:1,closed:false,how:'rotation',note:'',covers:[],absent:[]},
        {date:'2026-09-28',weekday:1,name:'Измислен Терапевт',employeeId:7,number:1,cycle:2,closed:false,how:'rotation',note:'',covers:[],absent:[]}],staleSwaps:[]});
    if (u.pathname === '/api/portal/attendance') {
        assert.equal(req.headers()['x-mtb-portal-token'],'a'.repeat(64));
        if (req.method() === 'PUT') {
            const b = req.postDataJSON(); writes.push(b);
            await new Promise(resolve=>setTimeout(resolve,120));
            if (failWrite) { failWrite=false; return json(409,{error:'Пробен судир: освежете.'}); }
            marks.set(b.date+'|'+b.key,b.status); revisions.set(b.date,(revisions.get(b.date)||0)+1); return json(200,{ok:true,revision:revisions.get(b.date)});
        }
        attendanceReads++;
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
const saved = () => p.waitForFunction(()=>!document.querySelector('.attendance-mark[aria-busy="true"]'));
const docxParts = bytes => {
    const parts={};let offset=0;
    while(bytes.readUInt32LE(offset)===0x04034b50) {
        const size=bytes.readUInt32LE(offset+18),n=bytes.readUInt16LE(offset+26),extra=bytes.readUInt16LE(offset+28);
        const start=offset+30+n+extra;
        parts[bytes.subarray(offset+30,offset+30+n).toString()]=bytes.subarray(start,start+size).toString();offset=start+size;
    }
    return parts;
};
const onePagePdf = async path => {
    const pdf=await p.pdf({path,preferCSSPageSize:true,printBackground:true});
    assert.equal((pdf.toString('latin1').match(/\/Type\s*\/Page\b/g)||[]).length,1,'complete report fits one PDF page: '+path);
};
// „⬇ PDF" (owner, 5 Oct 2026): a file the page writes itself. It must be a
// real PDF — every cross-reference pointing at its object — on pages of exactly
// A4, with nothing on them but the drawing: no address, date or page number.
const cleanA4Pdf = async (download, landscape, label) => {
    assert.match(download.suggestedFilename(), /\.pdf$/, label);
    const bytes = Buffer.from(await (await import('node:fs/promises')).readFile(await download.path()));
    const text = bytes.toString('latin1');
    assert.ok(text.startsWith('%PDF-1.4') && text.trimEnd().endsWith('%%EOF'), label + ': a PDF file');
    const start = Number(/startxref\n(\d+)/.exec(text)[1]);
    assert.equal(text.slice(start, start + 4), 'xref', label + ': startxref points at the table');
    const entries = text.slice(start).split('\n').slice(2).filter((l) => / 00000 n $/.test(l)).map((l) => Number(l.slice(0, 10)));
    entries.forEach((offset, i) => assert.equal(text.slice(offset, offset + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`, label + ': object ' + (i + 1)));
    const boxes = [...text.matchAll(/\/MediaBox\[0 0 ([\d.]+) ([\d.]+)\]/g)].map((m) => [Math.round(m[1]), Math.round(m[2])]);
    assert.ok(boxes.length >= 1, label + ': at least one page');
    boxes.forEach((b) => assert.deepEqual(b, landscape ? [842, 595] : [595, 842], label + ': A4'));
    assert.ok(!/https?:|localhost|Мој распоред|\/Font/.test(text), label + ': no address, title or text from the browser on the page');
    return boxes.length;
};
try {
    await p.goto(origin+'/Kolega.html');
    await p.click('#welcomeContinue');
    assert.ok((await p.locator('main').boundingBox()).width>=1200,'desktop workspace uses available width');
    await p.click('[data-tab="attendance"]');
    await p.locator('#attendanceDate').fill('2026-09-28'); await ready();
    const cell = p.locator('[data-att-date="2026-09-28"]').first();
    for(const status of ['present','absent',null]){
        await p.evaluate(()=>{window.originalAttendanceTable=document.querySelector('.attendance-table');window.originalAttendanceButton=document.querySelector('[data-att-date="2026-09-28"]');});
        const readsBefore=attendanceReads;
        await cell.click();
        assert.equal(await p.evaluate(()=>document.querySelector('.attendance-table')===window.originalAttendanceTable),true,'table stays visible during server save');
        await saved();
        assert.equal(writes.at(-1).status,status);
        assert.equal(await cell.getAttribute('class'),'attendance-mark '+(status||'blank'));
        assert.equal(await cell.locator('..').getAttribute('class'),status ? 'mark-'+status : '','cell shade follows confirmed status');
        assert.equal(attendanceReads,readsBefore,'successful toggle needs no full table reload');
        assert.equal(await p.evaluate(()=>document.querySelector('[data-att-date="2026-09-28"]')===window.originalAttendanceButton),true,'focused cell is not replaced');
    }
    failWrite=true; await cell.click(); await saved(); await ready();
    assert.match(await p.locator('#weekMsg').innerText(),/Пробен судир/);
    assert.match(await cell.getAttribute('class'),/blank/,'failed mark never shown as saved');
    await cell.click(); await saved(); await ready();
    await p.reload(); await p.click('#welcomeContinue'); await p.click('[data-tab="attendance"]');
    await p.locator('#attendanceDate').fill('2026-09-28'); await ready();
    assert.match(await cell.getAttribute('class'),/present/,'mark survives reload');
    await p.click('[data-att-mode="month"]'); await ready();
    assert.equal(await p.locator('.attendance-table tbody tr').count(),1);
    const totals = await p.locator('.attendance-table tbody tr td').allTextContents();
    assert.deepEqual(totals.slice(-4),['8','1','0','7'],'two treatments per date counted separately');
    const secondCell=p.locator('[data-att-date="2026-09-28"]').nth(1);
    await secondCell.click();await saved();await secondCell.click();await saved();
    assert.match(await secondCell.locator('..').getAttribute('class'),/mark-mixed/,'mixed treatment statuses keep both symbols and an amber cell');
    const [attPng] = await Promise.all([p.waitForEvent('download'),p.click('[data-att-png]')]);
    assert.match(attPng.suggestedFilename(),/^Prisustvo-.*\.png$/);
    const artifacts=resolve(root,'backups/test-artifacts');await mkdir(artifacts,{recursive:true});
    await attPng.saveAs(resolve(artifacts,'attendance-month.png'));
    const [attPdf] = await Promise.all([p.waitForEvent('download'),p.click('[data-att-pdf]')]);
    assert.match(attPdf.suggestedFilename(),/^Prisustvo-.*\.pdf$/); await cleanA4Pdf(attPdf,true,'attendance PDF');
    await p.evaluate(()=>{
        const body=document.querySelector('.attendance-table tbody'),row=body.rows[0];
        for(let i=2;i<=35;i++){const copy=row.cloneNode(true);copy.cells[0].textContent='Измислен Ученик '+i+'\nVIII-тест';body.append(copy);}
    });
    await p.click('[data-att-print]'); assert.match(await p.evaluate(()=>window.printClasses),/printing-attendance/);
    await p.emulateMedia({media:'print'});
    await p.evaluate(()=>window.dispatchEvent(new Event('beforeprint')));
    assert.equal(await p.locator('#days').isVisible(),false);
    assert.equal(await p.locator('#attendanceSheet').isVisible(),true);
    assert.equal(await p.locator('#mtbCredit').isVisible(),false,'author watermark never appears in printed reports');
    assert.equal(await p.locator('#attendanceSheet .print-preparer').innerText(),'Изработил: Измислен Терапевт','print attribution uses signed-in person, not configured app author');
    await p.screenshot({path:resolve(artifacts,'attendance-print.png'),fullPage:true});
    await onePagePdf(resolve(artifacts,'attendance-print.pdf'));
    await p.evaluate(()=>window.dispatchEvent(new Event('afterprint')));await p.emulateMedia({media:'screen'});
    await p.selectOption('#attendanceScope','transport'); await ready();
    assert.equal(await p.locator('.attendance-table tbody tr').count(),2);
    assert.deepEqual(await p.locator('.attendance-table thead th').allTextContents(),['Ученик','Датуми на присуство во училиштето'],'transport report has only name and confirmed dates, no calendar or count columns');
    assert.deepEqual(await p.locator('.attendance-table tbody tr td:last-child').allTextContents(),['07.09.2026\n14.09.2026','—'],'confirmed dates form a vertical column in the pupil row');
    assert.equal(await p.locator('.attendance-mark').count(),0,'transport report is read-only');
    assert.equal(await p.locator('[data-att-mode="week"]').count(),0,'monthly-only transport does not show an unusable week switch');
    assert.equal(await p.locator('[data-transport-certificate="12"]').isDisabled(),true,'zero days cannot issue attendance certificate');
    const beforeReads=transportReads;
    await p.click('[data-transport-certificate="11"]');
    await p.waitForFunction(()=>document.body.classList.contains('printing-transport-certificate'));
    assert.equal(transportReads,beforeReads+1,'certificate refreshes confirmed marks before printing');
    assert.match(await p.locator('#transportCertificate').innerText(),/2 различни денови/);
    assert.ok(!(await p.locator('#transportCertificate').innerText()).includes('Бета'),'only selected pupil on certificate');
    await p.emulateMedia({media:'print'});
    assert.equal(await p.locator('#attendance').isVisible(),false);
    assert.equal(await p.locator('#transportCertificate').isVisible(),true);
    assert.equal(await p.locator('#mtbCredit').isVisible(),false);
    await p.screenshot({path:resolve(artifacts,'transport-certificate.png'),fullPage:true});
    await onePagePdf(resolve(artifacts,'transport-certificate.pdf'));
    await p.evaluate(()=>window.dispatchEvent(new Event('afterprint')));await p.emulateMedia({media:'screen'});
    const [transportPng]=await Promise.all([p.waitForEvent('download'),p.click('[data-att-png]')]);
    assert.match(transportPng.suggestedFilename(),/^Prevoz-/);
    await transportPng.saveAs(resolve(artifacts,'transport.png'));
    await p.screenshot({path:resolve(artifacts,'kolega-fluent-desktop.png'),fullPage:true});
    const nav=await p.locator('.period-controls > *').evaluateAll(nodes=>nodes.map(n=>({x:n.getBoundingClientRect().x,b:n.getBoundingClientRect().bottom})));
    assert.ok(nav[0].x<nav[1].x && nav[1].x<nav[2].x && Math.max(...nav.map(n=>n.b))-Math.min(...nav.map(n=>n.b))<2,'arrows bracket and align with the period');
    const readsBeforeDocx=transportReads;
    const [word]=await Promise.all([p.waitForEvent('download'),p.click('[data-att-docx]')]);
    await word.saveAs(resolve(artifacts,'transport.docx'));
    assert.equal(word.suggestedFilename(),'Prevoz-2026-09.docx');
    assert.equal(transportReads,readsBeforeDocx+1,'Word export rechecks owner rights and refreshes data');
    const bytes=await readFile(resolve(artifacts,'transport.docx'));
    const parts=docxParts(bytes);
    assert.ok(parts['[Content_Types].xml'],'real zipped DOCX, not renamed HTML');
    assert.match(parts['word/document.xml'],/w:orient="landscape"/);
    assert.match(parts['word/document.xml'],/Изработил: Измислен Терапевт/);
    assert.match(parts['word/document.xml'],/<w:tblHeader\/>/);
    assert.ok(!parts['word/document.xml'].includes('Измислен Автор'),'no app-author watermark');
    assert.ok(!Object.values(parts).join('').includes('TargetMode="External"'),'no external references');
    for(const xml of Object.values(parts)) assert.equal(await p.evaluate(text=>new DOMParser().parseFromString(text,'application/xml').querySelector('parsererror')?.textContent||'',xml),'');
    denyTransport=true;
    let deniedDownload=false;const onDeniedDownload=()=>{deniedDownload=true;};p.on('download',onDeniedDownload);
    await p.click('[data-att-docx]');await p.waitForFunction(()=>document.querySelector('#weekMsg').textContent.includes('Пробно одбиен'));
    p.off('download',onDeniedDownload);assert.equal(deniedDownload,false,'revoked access never exports cached data');denyTransport=false;
    denyTransport=true;await p.click('[data-att-refresh]');await p.waitForSelector('.access-help');
    assert.match(await p.locator('#weekMsg').innerText(),/сопственичка најава/);
    assert.equal(await p.locator('.access-help a').getAttribute('href'),'/MTB-Workspace.html');
    assert.equal(await p.locator('[data-att-print]').isDisabled(),true,'no cached export after refused report read');
    denyTransport=false;await p.click('[data-att-refresh]');await ready();
    assert.equal(await p.locator('.access-help').count(),0,'successful retry clears access help');
    for(const width of [360,400]) {
        await p.setViewportSize({width,height:850});
        assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'transport list and controls fit narrow phones');
        const mobileNav=await p.locator('.period-controls > *').evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect().x));
        assert.ok(mobileNav[0]<mobileNav[1] && mobileNav[1]<mobileNav[2],'phone keeps previous, period, next in order');
        for(const control of ['#attendanceDate','#attendanceScope','[data-att-print]','[data-att-png]','[data-att-docx]','[data-transport-certificate="11"]']) {
            assert.ok((await p.locator(control).boundingBox()).height>=44,'touch target at least 44px: '+control);
        }
    }
    await p.screenshot({path:resolve(artifacts,'transport-mobile.png'),fullPage:true});
    await p.evaluate(()=>document.documentElement.dataset.theme='dark');
    await p.screenshot({path:resolve(artifacts,'transport-mobile-dark.png'),fullPage:true});
    await p.evaluate(()=>document.documentElement.dataset.theme='light');
    await p.setViewportSize({width:1400,height:1000});
    await p.click('[data-att-print]');await p.emulateMedia({media:'print'});
    await p.evaluate(()=>window.dispatchEvent(new Event('beforeprint')));
    assert.equal(await p.locator('#transportCertificate').isVisible(),false);
    assert.equal(await p.locator('[data-transport-certificate="11"]').isVisible(),false);
    assert.ok(await p.locator('.transport-dates td').first().evaluate(n=>parseFloat(getComputedStyle(n).fontSize)>=14),'print body type stays at least 10.5pt, not calendar-size text');
    assert.equal(await p.locator('#attendance').evaluate(n=>getComputedStyle(n).zoom),'1','transport list is never auto-shrunk');
    await p.evaluate(()=>{
        const body=document.querySelector('.transport-dates tbody'),row=body.rows[1];
        for(let i=3;i<=15;i++){const copy=row.cloneNode(true);copy.cells[0].textContent='Измислен Ученик '+i;body.append(copy);}
    });
    await p.screenshot({path:resolve(artifacts,'transport-readable-print.png'),fullPage:true});
    await onePagePdf(resolve(artifacts,'transport-month.pdf'));
    await p.evaluate(()=>window.dispatchEvent(new Event('afterprint')));await p.emulateMedia({media:'screen'});
    // Dates fill columns of four, including partial and full months, without loss.
    extendedTransport=true;
    await p.locator('#attendanceDate').fill('2026-10');await ready();
    assert.equal(await p.locator('.transport-dates tbody tr').count(),15);
    assert.deepEqual(await p.locator('.transport-dates tbody tr').nth(2).locator('.transport-date-column').allTextContents(),['01.10.2026\n02.10.2026\n03.10.2026\n04.10.2026','05.10.2026']);
    assert.equal(await p.locator('.transport-dates tbody tr').nth(6).locator('.transport-date-column').count(),8,'31 dates use eight columns');
    assert.ok(await p.locator('.transport-date-column').evaluateAll(cols=>cols.every(c=>c.textContent.split('\n').length<=4)));
    const [longWord]=await Promise.all([p.waitForEvent('download'),p.click('[data-att-docx]')]);
    await longWord.saveAs(resolve(artifacts,'transport-columns.docx'));
    const longXml=docxParts(await readFile(resolve(artifacts,'transport-columns.docx')))['word/document.xml'];
    const wordRows=await p.evaluate(xml=>{
        const doc=new DOMParser().parseFromString(xml,'application/xml');
        if(doc.querySelector('parsererror')) throw Error('Malformed Word XML');
        return [...doc.getElementsByTagName('w:tr')].slice(1).map(tr=>{
            const cells=tr.getElementsByTagName('w:tc');
            return {name:cells[0].textContent,lines:cells[1].getElementsByTagName('w:p').length,
                dates:[...cells[1].getElementsByTagName('w:t')].map(n=>n.textContent).filter(s=>s && s!=='—').sort()};
        });
    },longXml);
    assert.equal(wordRows.length,15);
    wordRows.forEach((row,i)=>{
        const count=[0,4,5,8,9,22,31][i%7];
        assert.equal(row.name,'Измислен Ученик '+(i+1)+' & <тест>','names escaped without altering content');
        assert.ok(row.lines<=4,'Word pupil row has at most four date lines');
        assert.deepEqual(row.dates,Array.from({length:count},(_,j)=>String(j+1).padStart(2,'0')+'.10.2026'),'all confirmed dates exported exactly once');
    });
    for(const width of [360,400]) {
        await p.setViewportSize({width,height:850});
        assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'many date columns scroll inside the cell on phones');
    }
    await p.screenshot({path:resolve(artifacts,'transport-columns-mobile.png'),fullPage:true});
    await p.setViewportSize({width:1400,height:1000});
    // Several full months paginate without reducing the readable type.
    await p.click('[data-att-print]');await p.emulateMedia({media:'print'});
    await p.evaluate(()=>window.dispatchEvent(new Event('beforeprint')));
    assert.ok(await p.locator('.transport-date-columns').evaluateAll(cells=>cells.every(c=>c.scrollWidth<=c.clientWidth+1)),'all date columns fit landscape print width');
    const longPdf=await p.pdf({path:resolve(artifacts,'transport-long.pdf'),preferCSSPageSize:true,printBackground:true});
    assert.ok((longPdf.toString('latin1').match(/\/Type\s*\/Page\b/g)||[]).length>1,'long lists continue on another page at readable size');
    await p.evaluate(()=>window.dispatchEvent(new Event('afterprint')));await p.emulateMedia({media:'screen'});
    await p.setViewportSize({width:400,height:850});
    assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'mobile page does not overflow; table scrolls inside');
    await p.click('[data-tab="duty"]'); await p.waitForSelector('#dutyPng');
    assert.deepEqual(await p.locator('.duty-table thead th').allTextContents(),['Ден и датум','Стручен соработник','Ред на листата']);
    await p.screenshot({path:resolve(artifacts,'kolega-fluent-duty-mobile.png'),fullPage:true});
    await p.setViewportSize({width:1400,height:1000});
    await p.screenshot({path:resolve(artifacts,'kolega-fluent-duty-desktop.png'),fullPage:true});
    const [dutyPng] = await Promise.all([p.waitForEvent('download'),p.click('#dutyPng')]);
    await dutyPng.saveAs(resolve(artifacts,'duty.png'));
    const [dutyPdf] = await Promise.all([p.waitForEvent('download'),p.click('#dutyPdf')]);
    await cleanA4Pdf(dutyPdf,false,'duty PDF'); await dutyPdf.saveAs(resolve(artifacts,'duty-clean.pdf'));
    await p.click('#dutyPrint'); assert.match(await p.evaluate(()=>window.printClasses),/printing-duty/);
    // „Ред на листата" says what it is, and „✍ Изработил" is chosen once for every document (owner, 5 Oct 2026).
    assert.match(await p.locator('.duty-table tbody td.num').first().innerText(),/\d+\. од \d+/,'the place reads „N. од M"');
    assert.match(await p.locator('.duty-legend').innerText(),/круг/,'a legend says what a round is');
    const preparerText=()=>p.evaluate(()=>{window.dispatchEvent(new Event('beforeprint'));const n=document.querySelector('.print-preparer');return n&&!n.hidden?n.textContent:'';});
    assert.equal(await preparerText(),'Изработил: Измислен Терапевт','by default the signed-in person');
    await p.click('#duty [data-preparer]'); await p.waitForSelector('#preparerDialog[open]');
    await p.selectOption('#preparerDialog select[name="word"]','Изготвил');
    await p.fill('#preparerDialog input[name="name"]','Стручна служба');
    assert.match(await p.locator('#preparerDialog .preparer-sample').innerText(),/Изготвил: Стручна служба/,'the dialog shows what will be written');
    await p.click('#preparerDialog button[value="save"]');
    assert.equal(await preparerText(),'Изготвил: Стручна служба','the choice reaches the printed sheet');
    await p.click('#duty [data-preparer]'); await p.uncheck('#preparerDialog input[name="show"]'); await p.click('#preparerDialog button[value="save"]');
    assert.equal(await preparerText(),'','and can be switched off');
    await p.click('#duty [data-preparer]'); await p.check('#preparerDialog input[name="show"]'); await p.fill('#preparerDialog input[name="name"]',''); await p.selectOption('#preparerDialog select[name="word"]','Изработил'); await p.click('#preparerDialog button[value="save"]');
    await p.evaluate(()=>window.dispatchEvent(new Event('afterprint')));
    // A full month first (23 working days is the most a month has), then the
    // print layout: the sheet is fitted when the browser switches to print, as
    // in a real print. It is not shrunk below what reads, so this is a month,
    // not an arbitrary pile of rows.
    await p.evaluate(()=>{
        const body=document.querySelector('.duty-table tbody'),row=body.querySelector('tr[data-date]');
        while(body.querySelectorAll('tr[data-date]').length<23) body.append(row.cloneNode(true));
    });
    await p.emulateMedia({media:'print'});
    await onePagePdf(resolve(artifacts,'duty-print.pdf'));
    await p.evaluate(()=>window.dispatchEvent(new Event('afterprint')));
    await p.emulateMedia({media:'screen'});
    await p.click('[data-tab="cabinet"]');await p.click('[data-week]');
    const [weekPng] = await Promise.all([p.waitForEvent('download'),p.click('#pngWeek')]);
    assert.match(weekPng.suggestedFilename(),/Licen-raspored/);
    const [weekPdf] = await Promise.all([p.waitForEvent('download'),p.click('#pdfWeek')]);
    assert.match(weekPdf.suggestedFilename(),/^Licen-raspored-.*\.pdf$/); await cleanA4Pdf(weekPdf,true,'week PDF');
    await p.click('#printWeek');assert.match(await p.evaluate(()=>window.printClasses),/printing-week/);
    await p.emulateMedia({media:'print'});await onePagePdf(resolve(artifacts,'week-print.pdf'));
    await p.emulateMedia({media:'screen'});
    transportAllowed=false;
    await p.reload();await p.click('#welcomeContinue');await p.click('[data-tab="attendance"]');await ready();
    assert.equal(await p.locator('#attendanceScope').count(),0,'ordinary colleague sees no school-wide filter');
    assert.deepEqual(errors,[]);
    console.log('PASS: attendance cycle, conflict, reload, monthly totals, mobile, owner-only transport filter, certificate refresh, watermark-free print/PDF and PNG exports, clean A4 PDF files.');
} finally { await browser.close(); }

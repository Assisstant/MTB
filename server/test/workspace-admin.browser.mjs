/** Browser regression with invented records and intercepted APIs only. */
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'../..');
const files=new Set(['MTB-Workspace.html','workspace-admin.js','workspace-admin.css','app-navigation.js','mtb-theme.js','mtb-runtime.js']);
const server=createServer(async(req,res)=>{const file=new URL(req.url,'http://local').pathname.slice(1);if(!files.has(file)){res.writeHead(404).end();return;}res.setHeader('Content-Type',file.endsWith('.css')?'text/css':file.endsWith('.js')?'text/javascript':'text/html');res.end(await readFile(resolve(root,file)));});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({...(process.env.CHROME?{executablePath:process.env.CHROME}:{})});
try{
 for(const width of [1500,390]){
  const context=await browser.newContext({viewport:{width,height:1000},serviceWorkers:'block'});
  const p={public_id:'invented-a',name:'Измислен Ученик Алфа',globally_active:true,annual_active:true,enrolled:true,grade:'К-1',oddelenie:'II',enrollment_type:'internal',boarding:false,programme:'unknown',placement:'unknown',therapists:[],expected:'a'.repeat(64)};
  const employee={id:1,name:'Измислен Вработен Бета',teacher_id:null,therapist_id:3,teacher_active:false,therapist_active:true,additional_roles:[],expected:'b'.repeat(64)};
  const data={year:'2026/2027',pupils:[p],employees:[employee],classes:[{id:1,label:'К-1'}],
   staffProfessions:{unknown:'Непотврдено',pedagog:'Педагог',spec_edukator:'Специјален едукатор / дефектолог',vospituvac:'Воспитувач'},
   staffDuties:{teaching:'Настава',modified_teaching:'Настава · модифицирана програма (и со надворешни)',preparatory_group:'Групна рехабилитација · подготвителна',
    individual_rehabilitation:'Индивидуална рехабилитација',counselling:'Советодавна работа',assistant_coordination:'Координација на образовни асистенти',mentoring:'Менторство',administration:'Администрација',boarding:'Воспитна работа / интернат'}};
  let fail=false,writes=0,lastEmployee=null;const errors=[];
  await context.route('**/*',async route=>{const req=route.request(),u=new URL(req.url()),path=u.pathname;const json=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
   if(u.origin!==base)return route.abort();
   if(req.method()!=='GET'){
    writes++;if(fail)return json({error:'Конфликт · внесот е задржан'},409);
    const body=req.postDataJSON();assert.equal(body.year,data.year);
    if(path.startsWith('/api/workspace/employees/')){lastEmployee=body;
     // The server refuses a scheduled teacher with no profile; the stub says so
     // in the same words, or the page would look as if it had been accepted.
     if(body.roles.includes('teacher')&&body.teacherKind==='none')return json({error:'Наставник во распоред мора да биде одделенски или предметен. „Не е наставник“ е за вработен без настава.'},400);
     Object.assign(employee,{name:body.name,profession_code:body.professionCode,job_title:body.jobTitle,duties:body.duties,
     teacher_kind:body.teacherKind==='none'?null:body.teacherKind,
     teacher_active:body.roles.includes('teacher'),therapist_active:body.roles.includes('therapist'),additional_roles:body.roles.filter(r=>r!=='teacher'&&r!=='therapist'),expected:'d'.repeat(64)});return json({employee});}
    if(path.endsWith('/therapists')){p.therapists=body.therapistIds.map(id=>({id,name:employee.name}));return json({pupil:p});}
    p.name=body.name;p.expected='c'.repeat(64);return json({pupil:p});
   }
   if(path==='/api/workspace')return json(data);
   if(path.startsWith('/api/workspace/employees/')&&path.endsWith('/history'))return json({history:[{year:data.year,profession_code:employee.profession_code,job_title:employee.job_title,duties:employee.duties}]});
   if(path.endsWith('/history'))return json({history:[{year:'2025/2026',grade:'К-0',oddelenie:'I',active:true,programme:'unknown',placement:'unknown'}]});
   if(path==='/api/years')return json([{id:1,label:data.year,is_current:true}]);
   if(path==='/api/health')return json({ok:true,server:{label:'ПРОБНА БАЗА'}});
   if(path==='/api/roster')return json({year:data.year,students:[{...p,kind:'internal',active:true}],teachers:[],therapists:[],classes:data.classes});
   if(path==='/api/categories')return json({categories:[]});
   if(path==='/api/categories/holders')return json({teachers:[],therapists:[]});
   if(path.startsWith('/api/'))return json({signed:null},401);
   if(path.endsWith('.html')&&path!=='/MTB-Workspace.html')return route.fulfill({contentType:'text/html',body:'<label>Draft<input id="fixtureDraft"></label>'});
   return route.continue();
  });
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/MTB-Workspace.html');await page.locator('[data-ma-id="invented-a"]').click();
  await page.locator('#maForm input[name=name]').fill('Измислен Нов Алфа');
  fail=true;await page.locator('#maForm button[type=submit]').click();await page.getByText('Конфликт · внесот е задржан',{exact:true}).waitFor();
  assert.equal(await page.locator('#maForm input[name=name]').inputValue(),'Измислен Нов Алфа');
  await page.locator('#maClose').click();await page.locator('#openMasterAdmin').click();
  assert.equal(await page.locator('#maForm input[name=name]').inputValue(),'Измислен Нов Алфа');
  fail=false;await page.locator('#maForm button[type=submit]').click();await page.getByText('Зачувано и потврдено од PostgreSQL.',{exact:true}).waitFor();
  await page.locator('#maCaseload input').check();await page.locator('#maCaseload button').click();
  await page.waitForFunction(()=>document.querySelector('#maStatus').textContent.includes('потврдено'));
  assert.equal(p.therapists.length,1);
  await page.locator('#maHistory').click();await page.getByText(/2025\/2026 · К-0/).waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.equal(await page.evaluate(()=>Object.values(localStorage).some(v=>/Измислен|invented-a/.test(v))),false);
  await mkdir(resolve(root,'backups/workspace-release-qa'),{recursive:true});
  await page.screenshot({path:resolve(root,`backups/workspace-release-qa/admin-${width}.png`)});
  await page.locator('[data-ma-tab=employees]').click();await page.locator('[data-ma-id="1"]').click();
  assert.equal(await page.locator('#maForm input[name=roles]:checked').count(),1);
  assert.equal(writes,3);assert.deepEqual(errors,[]);
  await page.locator('[name=professionCode]').selectOption('pedagog');
  assert.equal(await page.locator('[name=roles][value=therapist]').isChecked(),true,'profession must not change existing participation');
  await page.locator('[name=roles][value=therapist]').uncheck();await page.locator('[name=roles][value=specialist]').check();
  await page.locator('[name=jobTitle]').fill('Пробна служба');
  await page.locator('[name=duties][value=modified_teaching]').check();await page.locator('[name=duties][value=preparatory_group]').check();
  fail=true;await page.locator('#maForm button[type=submit]').click();await page.getByText('Конфликт · внесот е задржан',{exact:true}).waitFor();
  assert.equal(await page.locator('[name=professionCode]').inputValue(),'pedagog');
  assert.equal(await page.locator('[name=duties]:checked').count(),2);
  fail=false;await page.locator('#maForm button[type=submit]').click();await page.getByText('Зачувано и потврдено од PostgreSQL.',{exact:true}).waitFor();
  assert.equal(employee.therapist_active,false);assert.deepEqual(employee.additional_roles,['specialist']);
  await page.locator('#maReload').click();await page.waitForFunction(()=>document.querySelector('#maStatus').textContent.includes('активни ученици'));
  assert.equal(await page.locator('[name=professionCode]').inputValue(),'pedagog');
  await page.locator('#maProfession').selectOption('vospituvac');assert.equal(await page.locator('[data-ma-id="1"]').count(),0);
  await page.locator('#maProfession').selectOption('pedagog');await page.locator('#maDuty').selectOption('preparatory_group');assert.equal(await page.locator('[data-ma-id="1"]').count(),1);
  await page.locator('#maEmployeeHistory').click();await page.locator('#maEmployeeHistoryResult li').waitFor();
  assert.ok((await page.locator('#maEmployeeHistoryResult').textContent()).includes('Педагог'));
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.equal(await page.locator('.ma-filters').evaluate(n=>n.scrollWidth>n.clientWidth),false,'filter options must not overflow the sidebar');
  assert.equal(await page.evaluate(()=>Object.values(localStorage).some(v=>/Пробна служба|Измислен|invented-a/.test(v))),false);
  await page.locator('#maDetail').evaluate(n=>n.scrollTop=0);
  if(width<760)await page.locator('[name=professionCode]').scrollIntoViewIfNeeded();
  await page.screenshot({path:resolve(root,`backups/workspace-release-qa/staff-${width}.png`)});
  /* A cabinet or service employee is NEITHER одделенски NOR предметен, and
   * that is the absence of a teaching profile rather than a third kind of
   * teacher. The refusal in the other direction is what keeps it honest: the
   * timetable is read one way for a class row and the other way for a subject
   * row, so a teacher in it cannot be neither. */
  assert.deepEqual(await page.locator('[name=teacherKind] option').allTextContents(),
   ['Не е наставник · кабинет или служба','Одделенски','Предметен']);
  assert.equal(await page.locator('[name=teacherKind]').inputValue(),'none','an employee with no teaching profile must not read as предметен');
  await page.locator('[name=roles][value=teacher]').check();
  await page.getByText('Со „Учествува во настава“ изберете одделенски или предметен — инаку зачувувањето ќе биде одбиено.').waitFor();
  await page.locator('#maForm button[type=submit]').click();
  await page.getByText(/мора да биде одделенски или предметен/).first().waitFor();
  assert.equal(await page.locator('[name=teacherKind]').inputValue(),'none','the refused choice must be kept, not reset');
  await page.locator('[name=teacherKind]').selectOption('odd');
  assert.equal(await page.locator('#maKindNote').textContent(),'');
  await page.locator('#maForm button[type=submit]').click();await page.getByText('Зачувано и потврдено од PostgreSQL.',{exact:true}).waitFor();
  assert.equal(lastEmployee.teacherKind,'odd');assert.equal(employee.teacher_kind,'odd');
  await page.locator('[name=roles][value=teacher]').uncheck();
  await page.locator('[name=teacherKind]').selectOption('none');
  await page.locator('#maForm button[type=submit]').click();await page.getByText('Зачувано и потврдено од PostgreSQL.',{exact:true}).waitFor();
  assert.equal(lastEmployee.teacherKind,'none');assert.equal(employee.teacher_active,false);
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('mtb:server-state',{detail:{mirror:{mode:'readonly'}}})));
  assert.equal(await page.locator('[name=professionCode]').isDisabled(),true);
  assert.equal(writes,8);assert.deepEqual(errors,[]);
  await context.close();console.log(`PASS master administration at ${width}px: save, conflict, drafts, caseload, history, teaching profile, layout, privacy`);
 }
}finally{await browser.close();await new Promise(r=>server.close(r));}

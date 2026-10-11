/** Default work plans and private diary → public content links. All pupils/API responses invented. */
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { chromium } from 'playwright';

const root=resolve(import.meta.dirname,'../..'), origin='http://localhost:4646';
const browser=await chromium.launch({...process.env.CHROME ? {executablePath:process.env.CHROME}: {}});
let checks=0;
const check=(name,ok)=>{assert.ok(ok,name); checks++; console.log('  ok '+name);};
const week=()=>Object.fromEntries(['monday','tuesday','wednesday','thursday','friday'].map(d=>[d,Array.from({length:6},()=>[])]));
const pupil=(id,type,planId=null)=>({id,name:'Пробен Ученик '+id,grade:'V',disabilityType:type,planId});
const payload={students:[pupil(1001,'deaf',9001),pupil(1002,'deaf'),pupil(1003,'autism'),pupil(1004,''),pupil(1005,'deaf',9999)],
    plans:[{id:9001,name:'Постоечки план',activities:['Вежби со зборови. П','Вежби со зборови. Б','<b>Самостојна активност</b>']}],
    schedule:week(),scheduleHistory:{},planFrom:{},attendance:{},studentProgress:{},links:[],
    archivedStudents:[],formerCaseloadStudents:[],trijazenTestovi:[],student_records:[],audiograms:[],assessments:[],scaleTemplates:[]};
payload.attendance['2026-10-05']={1002:{a:{status:'present',time:'08:00-08:40'},b:{status:'present',time:'08:00-08:40'},c:{status:'absent',time:'08:45-09:25'},d:{status:'present'}}};
payload.attendance['2025-10-05']={1002:{a:{status:'present',time:'08:00-08:40'}}};
let stored=null; const writes=[],errors=[],dialogs=[];
try {
    const context=await browser.newContext({viewport:{width:1366,height:900}});
    await context.addInitScript(()=>localStorage.setItem('sdn_local_server_autosync_v1','0'));
    await context.route('**/*',async route=>{
        const u=new URL(route.request().url());
        if(u.origin!==origin)return route.abort();
        const json=(data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
        if(u.pathname.startsWith('/api/')){
            const method=route.request().method();
            if(method!=='GET')writes.push(u.pathname);
            if(u.pathname==='/api/state/sdnevnik'){
                if(method==='GET')return json(stored||{},stored?200:404);
                stored={version:(stored?.version||0)+1,payload:route.request().postDataJSON().payload};return json({version:stored.version});
            }
            if(u.pathname==='/api/health')return json({ok:true});
            return json({},404);
        }
        if(u.pathname==='/mtb-runtime.js')return route.fulfill({body:'window.MTB_CLOUD_SAME_ORIGIN=false;window.MTB_MIRROR_READONLY=false;'});
        const file=resolve(root,'.'+decodeURIComponent(u.pathname));
        if(!file.startsWith(root))return route.abort();
        try{return route.fulfill({contentType:({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css'})[extname(file)]||'application/octet-stream',body:await readFile(file)});}
        catch{return route.fulfill({status:404,body:''});}
    });
    const page=await context.newPage();
    await page.clock.install({time:new Date('2026-10-10T12:00:00')});
    page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>{dialogs.push(d.message());d.accept();});
    await page.goto(origin+'/S-Dnevnik.html');
    await page.waitForFunction(()=>window.SdnV3&&window.loadStudentProgress);
    // Wait for the initial IndexedDB hydrate before supplying the invented diary.
    await page.evaluate(()=>SdnV3.hydrate());
    await page.waitForTimeout(150);
    await page.evaluate(p=>{SdnV3.applyPayload(p);renderAll();switchTab('progress');},payload);
    const show=async id=>page.evaluate(id=>{document.getElementById('progressStudentSelect').value=id;loadStudentProgress();},String(id));
    const snapshot=()=>page.evaluate(()=>JSON.stringify({students,plans,attendance,studentProgress}));
    await show(1001);
    check('old deaf activity gets a letter link next to its attendance checkbox',await page.locator('.progress-item').first().locator('a').getAttribute('href')==='vezbi/index.html#vezbi?library=sounds&deck=p');
    check('clinical text is rendered as text, never executable markup',await page.locator('.progress-item-text b').count()===0&&(await page.locator('.progress-item-text').last().textContent()).includes('<b>'));
    const before=await snapshot(), popPromise=page.waitForEvent('popup');
    await page.locator('.progress-item a').first().click();const exercise=await popPromise;
    await exercise.waitForFunction(()=>typeof state!=='undefined'&&!!db);
    check('the real link opens the original P deck, with no pupil information',await exercise.evaluate(()=>state.library==='sounds'&&currentDeck().file==='p')&&!/1001|student|pupil/.test(exercise.url()));
    check('the link retains the original diary for returning to the selected pupil',await exercise.evaluate(()=>!!opener&&!opener.closed&&opener.location.pathname.endsWith('/S-Dnevnik.html')));
    check('opening exercises leaves plans, progress and attendance unchanged',await snapshot()===before);
    check('all default sound and theme targets exist in the public catalogue',await exercise.evaluate(data=>data.s.every(s=>GLASOVI.some(g=>g.file===s[1]&&g.letter.toUpperCase()===s[0]))&&data.t.every(t=>VEZBI_THEMES.some(g=>g.file===t[1]&&g.title===t[0])),await page.evaluate(()=>({s:SDN_EXERCISE_SOUNDS,t:SDN_EXERCISE_THEMES}))));
    check('changing assistance keeps the same content',await exercise.evaluate(()=>{const before=JSON.stringify(WORDS);state.step=2;draw();return before===JSON.stringify(WORDS)&&currentDeck().file==='p';}));
    await exercise.goto(origin+'/vezbi/index.html#vezbi?library=themes&deck=theme-fruit');
    await exercise.waitForFunction(()=>typeof state!=='undefined'&&!!db);
    check('specific theme link opens fruit words without syllables',await exercise.evaluate(()=>currentDeck().file==='theme-fruit'&&state.stage==='0'));
    await exercise.goto(origin+'/vezbi/index.html#vezbi?library=themes');
    await exercise.waitForFunction(()=>typeof state!=='undefined'&&!!db);
    check('generic concept link opens the theme chooser',await exercise.locator('#m-sound').evaluate(e=>e.classList.contains('open')));
    await exercise.goto(origin+'/vezbi/index.html#vezbi?library=sounds&deck=missing');
    await exercise.waitForFunction(()=>typeof state!=='undefined'&&!!db);
    check('unknown content is reported instead of silently selecting another deck',(await exercise.textContent('#note')).includes('не е пронајдена'));
    await exercise.goto(origin+'/vezbi/index.html#vezbi');
    await exercise.waitForFunction(()=>typeof state!=='undefined'&&!!db);
    check('old exercise links still open the default 26-sound catalogue',await exercise.evaluate(()=>GLASOVI.length===26&&state.library==='sounds'));
    const closed=exercise.waitForEvent('close');await exercise.locator('#apps a.diary').click();await closed;
    check('the diary button closes the exercise tab and preserves the selected pupil',await page.locator('#progressStudentSelect').inputValue()==='1001');
    await show(1002);const previewBefore=await snapshot();
    check('missing plan immediately displays a 76-row preview with attendance-derived progress',await page.locator('.progress-item').count()===76&&await page.locator('.progress-item.completed').count()===1);
    await show(1002);
    check('viewing the preview never writes a plan',await snapshot()===previewBefore);
    await page.getByRole('button',{name:'Зачувај почетен план',exact:true}).click();
    check('saving the preview gives a personal 76-activity plan, merged visits count once and last year is excluded',await page.evaluate(()=>{const s=getStudentById(1002);return getPlanById(s.planId).activities.length===76&&studentProgress[s.id][s.planId].length===1;}));
    check('all 26 sounds have at least two planned treatments',await page.evaluate(()=>{const a=getPlanById(getStudentById(1002).planId).activities;return SDN_EXERCISE_SOUNDS.every(s=>a.filter(t=>t.endsWith('Глас '+s[0])).length>=2);}));
    await page.evaluate(async()=>{schedule.monday[0]=[1003];await saveData();});
    check('saving a schedule automatically assigns concepts for another type',await page.evaluate(()=>getPlanById(getStudentById(1003).planId).activities.length===76&&sdnActivityResource(getStudentById(1003),getPlanById(getStudentById(1003).planId).activities[0]).href.includes('theme-body')));
    check('automatic defaults preserve an existing plan byte for byte',await page.evaluate(p=>JSON.stringify(getPlanById(9001))===JSON.stringify(p),payload.plans[0]));
    await page.evaluate(async()=>{planFrom['2026-10-19']=JSON.parse(JSON.stringify(schedule));planFrom['2026-10-19'].monday[0]=[1004];await saveData();});
    check('future schedule also assigns the unknown-type concept default without a diagnosis',await page.evaluate(()=>getStudentById(1004).disabilityType===''&&getPlanById(getStudentById(1004).planId).activities.length===76));
    check('each new pupil owns a separate editable plan',await page.evaluate(()=>new Set(students.slice(1,4).map(s=>s.planId)).size===3));
    const count=await page.evaluate(()=>plans.length);await page.evaluate(()=>saveData());
    check('repeated saves create no duplicate templates',await page.evaluate(()=>plans.length)===count);
    await show(1005);
    check('a missing referenced plan is reported and never replaced',await page.locator('.progress-item').count()===0&&(await page.textContent('#progressActivitiesList')).includes('недостига')&&await page.evaluate(()=>getStudentById(1005).planId===9999));
    await page.evaluate(()=>{const s=admitAnnualStudent({sdnevnik_id:1010,name:'Пробен Нов',grade:'подготвителна',kind:'internal',public_id:'test-new'});window.testNewId=s.id;});
    check('a newly admitted pupil immediately has a concept plan',await page.evaluate(()=>getPlanById(getStudentById(testNewId).planId).activities.length===76));
    await page.evaluate(()=>{editStudent(students.findIndex(s=>s.id===testNewId));document.getElementById('studentDisabilityType').value='deaf';saveStudent();});
    check('entering the deaf type updates only an untouched unused default through the pupil form',await page.evaluate(()=>getPlanById(getStudentById(testNewId).planId).activities[0].endsWith('Глас П')));
    await page.evaluate(()=>{getPlanById(getStudentById(testNewId).planId).activities[0]+=' · Личен избор';editStudent(students.findIndex(s=>s.id===testNewId));document.getElementById('studentDisabilityType').value='other';saveStudent();});
    check('a manual change to a default plan prevents later automatic replacement',await page.evaluate(()=>getPlanById(getStudentById(testNewId).planId).activities[0].endsWith('Личен избор')));
    // Actual attendance toggle, not a direct call to the progress helper.
    await page.evaluate(()=>{schedule.monday[0]=[1003];currentWeek=0;toggleAttendance(1003,'monday',0);});
    check('actual attendance still advances the default plan',await page.evaluate(()=>studentProgress[1003][getStudentById(1003).planId].length===1));
    await page.evaluate(()=>toggleAttendance(1003,'monday',0));
    check('removing attendance removes its credited activity',await page.evaluate(()=>studentProgress[1003][getStudentById(1003).planId].length===0));
    await page.evaluate(()=>{editPlan(plans.findIndex(p=>p.id===getStudentById(1002).planId));document.getElementById('planActivities').value='Сменет прв третман\n'+getPlanById(getStudentById(1002).planId).activities.slice(1).join('\n');savePlan();});
    check('editing a completed activity is refused',dialogs.some(s=>s.includes('Реализираните активности')));
    await page.evaluate(()=>{closeModal('addPlanModal');saveData();});
    // A visit can be another activity, or several activities, without duplicate
    // attendance or changing another pupil's copy of a once-shared template.
    await page.evaluate(()=>{students.push({id:1011,name:'Пробен Друг',grade:'V',disabilityType:'deaf',planId:9001});updateProgressStudentList();});
    await show(1001);await page.locator('.progress-item').first().getByRole('button',{name:'Активности…',exact:true}).click();
    await page.check('[data-session-type="triage"]');await page.getByRole('button',{name:'Зачувај активности',exact:true}).click();
    check('a combined activity makes a personal copy of a shared plan, leaving the other pupil untouched',await page.evaluate(p=>getStudentById(1001).planId!==9001&&getStudentById(1011).planId===9001&&JSON.stringify(getPlanById(9001))===JSON.stringify(p),payload.plans[0]));
    check('a combined exercise/test row retains P and offers the separate test form',await page.locator('.progress-item').first().locator('a').getAttribute('href')==='vezbi/index.html#vezbi?library=sounds&deck=p'&&await page.locator('.progress-item').first().getByRole('button',{name:'Отвори: Тријажен тест',exact:true}).count()===1);
    await page.evaluate(()=>{schedule.thursday[2]=[1001];toggleAttendance(1001,'thursday',2);});await show(1001);
    check('exercise plus test in one attended slot credits just one treatment',await page.evaluate(()=>studentProgress[1001][getStudentById(1001).planId].length===1));
    const beforeForm=await snapshot();
    await page.locator('.progress-item').first().getByRole('button',{name:'Отвори: Тријажен тест',exact:true}).click();
    check('test form selects the same pupil without inventing a result or attendance',await page.locator('#trijazenStudentSelect').inputValue()==='1001'&&await snapshot()===beforeForm&&await page.evaluate(()=>trijazenTestovi.length===0));
    await page.evaluate(()=>switchTab('progress'));await show(1003);
    await page.locator('.progress-item').first().getByRole('button',{name:'Активности…',exact:true}).click();
    await page.uncheck('[data-session-type="exercise"]');await page.check('[data-session-type="triage"]');
    await page.getByRole('button',{name:'Зачувај активности',exact:true}).click();
    check('a test-only slot preserves the exercise for later when requested',await page.evaluate(()=>{const p=getPlanById(getStudentById(1003).planId);return p.activities.length===77&&p.activities[0]==='[Тријажен тест]'&&p.activities[1].endsWith('Тема: Делови на телото');}));
    check('test-only slot has no speech exercise link',await page.locator('.progress-item').first().locator('a').count()===0);
    await page.evaluate(()=>{toggleAttendance(1003,'monday',0);toggleAttendance(1003,'monday',0);});await show(1003);
    check('test attendance completes the test row, leaving the deferred exercise incomplete',await page.locator('.progress-item.completed').count()===1&&(await page.locator('.progress-item.completed .progress-item-text').textContent()).includes('Тријажен тест')&&await page.evaluate(()=>studentProgress[1003][getStudentById(1003).planId][0].index===0));
    const marksBefore=await page.evaluate(()=>JSON.stringify(attendance));
    await page.locator('.progress-item').first().getByRole('button',{name:'Активности…',exact:true}).click();
    await page.check('[data-session-type="audio"]');await page.getByRole('button',{name:'Зачувај активности',exact:true}).click();
    check('adding audiometry to an already recorded test changes its description, not the number or dates of visits',await page.evaluate(before=>JSON.stringify(attendance)===before&&studentProgress[1003][getStudentById(1003).planId].length===1,marksBefore)&&await page.locator('.progress-item').first().getByRole('button',{name:'Отвори: Аудиометрија',exact:true}).count()===1);
    await page.getByRole('button',{name:'+ Додај третман',exact:true}).click();
    await page.getByRole('textbox',{name:'Опис на активноста'}).fill('  Советување со родител  ');
    await page.getByRole('button',{name:'Зачувај активности',exact:true}).click();
    check('the initial 76 is flexible; another activity can be added with untrimmed description',await page.evaluate(()=>{const p=getPlanById(getStudentById(1003).planId);return p.activities.length===78&&p.activities.at(-1)==='[Друга активност]   Советување со родител  '&&studentProgress[1003][p.id].length===1;}));
    const beforeCancel=await snapshot();await page.locator('.progress-item').nth(1).getByRole('button',{name:'Активности…',exact:true}).click();
    await page.check('[data-session-type="audio"]');await page.getByRole('button',{name:'Откажи',exact:true}).click();
    check('cancelling session changes writes nothing',await snapshot()===beforeCancel);
    await page.locator('.progress-item').nth(1).getByRole('button',{name:'Активности…',exact:true}).click();
    await page.evaluate(()=>{const p=getPlanById(getStudentById(1003).planId);window.beforeConcurrent=p.activities[1];p.activities[1]+=' · понов внес';});
    await page.getByRole('button',{name:'Зачувај активности',exact:true}).click();
    check('a stale session editor cannot overwrite a changed plan',(await page.locator('.session-editor [role="status"]').textContent()).includes('сменет'));
    await page.getByRole('button',{name:'Откажи',exact:true}).click();await page.evaluate(()=>getPlanById(getStudentById(1003).planId).activities[1]=beforeConcurrent);
    await page.locator('.progress-item').nth(2).getByRole('button',{name:'Активности…',exact:true}).click();
    await page.uncheck('[data-session-type="exercise"]');await page.check('[data-session-type="audio"]');
    await page.getByLabel('Задржи ја заменетата вежба за подоцна').uncheck();await page.getByRole('button',{name:'Зачувај активности',exact:true}).click();
    check('the therapist may replace an exercise outright without increasing the planned total',await page.evaluate(()=>{const p=getPlanById(getStudentById(1003).planId);return p.activities.length===78&&p.activities[2]==='[Аудиометрија]';}));
    // Export/import through the real full JSON interface, not a hand-built payload.
    const downloadPromise=page.waitForEvent('download');await page.evaluate(()=>exportData());
    const exported=JSON.parse(await readFile(await (await downloadPromise).path(),'utf8'));
    check('legacy string activity format survives full export with exact content targets',exported.plans.filter(p=>p.activities.length>=76).length>=3&&exported.plans.every(p=>p.activities.every(a=>typeof a==='string')));
    await page.reload();await page.waitForFunction(()=>window.SdnV3&&students.some(s=>s.id===1002&&s.planId));
    await show(1002);
    check('personal plan and links survive IndexedDB reload',await page.locator('.progress-item').count()===76&&await page.locator('.progress-item.completed').count()===1);
    await page.evaluate(p=>{SdnV3.applyPayload(p);renderAll();switchTab('progress');},exported);await show(1003);
    check('JSON re-import preserves the concept link',(await page.locator('.progress-item a').first().getAttribute('href')).includes('theme-body'));
    check('combined session types and other activities survive export/import',await page.evaluate(()=>{const p=getPlanById(getStudentById(1003).planId);return p.activities[0]==='[Тријажен тест + Аудиометрија]'&&p.activities.at(-1).endsWith('Советување со родител  ');}));
    await page.setViewportSize({width:390,height:844});
    check('phone rows fit and resource controls are touch-sized',await page.locator('.progress-item').first().evaluate(e=>{const a=e.querySelector('.progress-resource').getBoundingClientRect();return e.getBoundingClientRect().right<=innerWidth&&a.width>=44&&a.height>=44;}));
    await mkdir(resolve(root,'backups/plan-exercise-review'),{recursive:true});
    await page.locator('.progress-item').first().scrollIntoViewIfNeeded();
    await page.screenshot({path:resolve(root,'backups/plan-exercise-review/phone.png')});
    await page.locator('.progress-item').first().getByRole('button',{name:'Активности…',exact:true}).click();
    check('session editor fits a phone and exposes a named dialog',await page.getByRole('dialog',{name:'Активности во третман 1',exact:true}).evaluate(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.height<=innerHeight;}));
    await page.screenshot({path:resolve(root,'backups/plan-exercise-review/session-phone.png')});
    await page.getByRole('button',{name:'Откажи',exact:true}).click();
    await page.setViewportSize({width:1366,height:900});await show(1001);
    await page.evaluate(()=>window.scrollTo(0,0));
    await page.screenshot({path:resolve(root,'backups/plan-exercise-review/desktop.png')});
    await page.evaluate(()=>{document.documentElement.dataset.theme='dark';document.body.classList.add('dark-mode');});
    await page.screenshot({path:resolve(root,'backups/plan-exercise-review/dark.png')});
    await page.evaluate(()=>{MTB_MIRROR_READONLY=true;getStudentById(1004).planId=null;});const mirror=await snapshot();
    await page.evaluate(()=>ensureScheduledExercisePlans());await show(1004);
    check('read-only mirror cannot create a default plan',await snapshot()===mirror&&await page.getByRole('button',{name:'Зачувај почетен план',exact:true}).isDisabled());
    check('no real API or attendance endpoint was written',writes.every(p=>p==='/api/state/sdnevnik'));
    check('no browser exceptions',errors.length===0);
    console.log(`\n${checks} exercise-plan checks passed`);
} finally {await browser.close();}

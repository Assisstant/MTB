/**
 * S-Dnevnik's „🧩 Состави план од ниво": an existing plan is a level; a text that
 * repeats with another letter is offered once as a type; a new plan is put
 * together from one level (owner, 11 Oct 2026). Invented plans, every API call
 * invented; the page is read from the disk.
 *
 *   npm run test:plan-builder            (CHROME=<path> optional, SHOT=<dir> for pictures)
 */
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname, join } from 'node:path';
import { chromium } from 'playwright';

const root=resolve(import.meta.dirname,'../..'), origin='http://localhost:4647';
const browser=await chromium.launch({...process.env.CHROME ? {executablePath:process.env.CHROME}: {}});
let checks=0;
const check=(name,ok,detail='')=>{assert.ok(ok,name+(detail?' — '+detail:'')); checks++; console.log('  ok '+name);};
const week=()=>Object.fromEntries(['monday','tuesday','wednesday','thursday','friday'].map(d=>[d,Array.from({length:6},()=>[])]));
const LETTERS=['А','Б','В','Г'];
// „Прво ниво": a theme, then a letter, in turn; the themes start again when they run out.
const first=[]; ['-Семејство','-Училиште-говорна вежба','Мебел'].forEach((t,i)=>{first.push(t);first.push('Читање и пишување на зборови со буквата '+LETTERS[i]);});
first.push('-Семејство');first.push('Читање и пишување на зборови со буквата Г');
// „Трето ниво": two single items, then three kinds of exercise for each sound, the sound at the end of the line.
const third=['-Проценка на слушниот статус','-Проценка на говорот'];
for(const s of ['П','Б','М']) third.push('- Дополнување на испуштени букви. '+s,'-Акустичка дискриминација. '+s,'-Вежби на гласот во реченици. '+s);
const payload={students:[],plans:[{id:9001,name:'Прво ниво',activities:first},{id:9003,name:'Трето ниво',activities:third},{id:9004,name:'Трето ниво',activities:third}],
    schedule:week(),scheduleHistory:{},planFrom:{},attendance:{},studentProgress:{},links:[],
    archivedStudents:[],formerCaseloadStudents:[],trijazenTestovi:[],student_records:[],audiograms:[],assessments:[],scaleTemplates:[]};
let stored=null; const errors=[],dialogs=[]; let answer=true;
try {
    const context=await browser.newContext({viewport:{width:1366,height:900}});
    await context.addInitScript(()=>localStorage.setItem('sdn_local_server_autosync_v1','0'));
    await context.route('**/*',async route=>{
        const u=new URL(route.request().url());
        if(u.origin!==origin)return route.abort();
        const json=(data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
        if(u.pathname.startsWith('/api/')){
            if(u.pathname==='/api/state/sdnevnik'){
                if(route.request().method()==='GET')return json(stored||{},stored?200:404);
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
    page.on('pageerror',e=>errors.push(e.message));
    page.on('dialog',d=>{dialogs.push(d.message());answer?d.accept():d.dismiss();});
    await page.goto(origin+'/S-Dnevnik.html');
    await page.waitForFunction(()=>window.SdnV3&&window.loadStudentProgress);
    await page.evaluate(()=>SdnV3.hydrate());
    await page.waitForTimeout(150);
    await page.evaluate(p=>{SdnV3.applyPayload(p);renderAll();switchTab('plans');},payload);

    console.log('\nwhat a level offers');
    const levels=await page.evaluate(()=>SdnPlanBuilder.levels().map(l=>l.name));
    check('each plan is a level once: the same plan given to two pupils is one',levels.join('|')==='Прво ниво|Трето ниво');
    const lib1=await page.evaluate(()=>SdnPlanBuilder.library('Прво ниво'));
    check('a text that repeats with another letter is ONE type',lib1.types.length===1&&lib1.types[0].text==='Читање и пишување на зборови со буквата {буква}'
        &&lib1.types[0].values.join('')==='АБВГ',JSON.stringify(lib1.types));
    check('what does not repeat stays as its own text, once',lib1.singles.join('|')==='-Семејство|-Училиште-говорна вежба|Мебел');
    const lib3=await page.evaluate(()=>SdnPlanBuilder.library('Трето ниво'));
    check('a sound at the end of the line makes three types with the sounds in the level\'s order',
        lib3.types.length===3&&lib3.types.every(t=>t.kind==='sound'&&t.values.join('')==='ПБМ')&&lib3.singles.length===2,JSON.stringify(lib3));

    console.log('\nputting a plan together');
    await page.click('button:has-text("Состави план од ниво")');
    await page.waitForSelector('#planBuildDialog[open]');
    const items=()=>page.$$eval('#planBuildPreview li',l=>l.map(x=>x.textContent));
    await page.fill('#planBuildTotal','0');
    check('the way the level itself is ordered is chosen for it',await page.isChecked('[name="planBuildMode"][value="alternate"]'));
    check('the first level, in turn, comes out as it was written',JSON.stringify(await items())===JSON.stringify(first),JSON.stringify(await items()));
    await page.fill('#planBuildPerWeek','2');
    const weeks=await page.evaluate(()=>SdnPlanBuilder.schoolWeeks());
    check('treatments a week × the calendar\'s working weeks is the number of items',(await page.inputValue('#planBuildTotal'))===String(2*weeks)
        &&(await items()).length===2*weeks,`${weeks} weeks`);
    const long=await items();
    check('past the letters the themes go on in turn, as in the old sheets',long[8]==='-Училиште-говорна вежба'&&long[9]==='Мебел'&&!long.slice(8).some(x=>x.includes('буквата')));

    await page.selectOption('#planBuildLevel','Трето ниво');
    await page.fill('#planBuildTotal','0');
    check('the third level: the single items first, then every type for each sound',JSON.stringify(await items())===JSON.stringify(third),JSON.stringify(await items()));
    await page.locator('[data-type="0"] [data-list]').selectOption('kostic');
    await page.locator('[data-type="1"] [data-list]').selectOption('kostic');
    await page.locator('[data-type="2"] [data-list]').selectOption('kostic');
    const kostic=await items();
    check('the sounds can follow Костиќ\'s order, all 26',kostic.length===2+26*3&&kostic[2].endsWith(' П')&&kostic[5].endsWith(' Б')&&kostic.at(-1).endsWith(' Ѕ'));
    await page.fill('#planBuildExtra','Свој текст за проба');
    check('a text of one\'s own is one more item',(await items()).includes('Свој текст за проба'));
    if(process.env.SHOT){await mkdir(process.env.SHOT,{recursive:true});await page.screenshot({path:join(process.env.SHOT,'plan-builder.png')});}

    console.log('\nsaving, and a changed type');
    const before=JSON.stringify(await page.evaluate(()=>plans.slice(0,3)));
    await page.locator('[data-type="1"] [data-text]').fill('-Акустичка дискриминација на зборови. {глас}');
    await page.fill('#planBuildName','Трето ниво · проба');
    answer=false;dialogs.length=0;                       // „Откажи“: keep it as a NEW type
    await page.click('#planBuildSave');
    await page.waitForSelector('#planBuildDialog',{state:'detached'});
    check('a changed text asks: change the existing type, or keep it as a new one',dialogs.length===1&&/зачувај го како нов тип/.test(dialogs[0]));
    const made=await page.evaluate(()=>plans[plans.length-1]);
    check('the new plan is saved with the changed text',made.name==='Трето ниво · проба'&&made.activities.length===2+26*3+1&&made.activities[4]==='-Акустичка дискриминација на зборови. П');
    check('and the plans it was read from are exactly as they were',JSON.stringify(await page.evaluate(()=>plans.slice(0,3)))===before);
    let lib=await page.evaluate(()=>SdnPlanBuilder.library('Трето ниво'));
    check('as a new type the old one stays beside it, and the own text is kept for the level',lib.types.length===4&&lib.types[1].text==='-Акустичка дискриминација. {глас}'
        &&lib.types[3].text==='-Акустичка дискриминација на зборови. {глас}'&&lib.singles.includes('Свој текст за проба'),JSON.stringify(lib.types));
    await page.click('button:has-text("Состави план од ниво")');
    await page.selectOption('#planBuildLevel','Прво ниво');
    await page.locator('[data-type="0"] [data-text]').fill('Читање на зборови со буквата {буква}');
    answer=true;dialogs.length=0;                        // OK: change the existing type
    await page.click('#planBuildSave');
    await page.waitForSelector('#planBuildDialog',{state:'detached'});
    lib=await page.evaluate(()=>SdnPlanBuilder.library('Прво ниво'));
    check('changing the existing type leaves one type, with the new text',lib.types.length===1&&lib.types[0].text==='Читање на зборови со буквата {буква}');
    await page.waitForTimeout(300);
    const kept=await page.evaluate(()=>SdnV3.currentPayload('test').planLibrary);
    check('the changes travel in the document, and only the changed levels',Object.keys(kept).sort().join('|')==='Прво ниво|Трето ниво');
    await page.evaluate(()=>SdnV3.applyPayload(SdnV3.currentPayload('test')));
    check('and come back with it',(await page.evaluate(()=>SdnPlanBuilder.library('Прво ниво').types[0].text))==='Читање на зборови со буквата {буква}');

    check('no browser exceptions',errors.length===0,errors.join(' | '));
    console.log(`\n${checks} plan-builder checks passed`);
} finally {await browser.close();}

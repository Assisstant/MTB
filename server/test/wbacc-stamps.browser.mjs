/**
 * WBACC Studio's stamps: a frame that is a real shape, „Мои печати" kept in
 * this browser, the file that carries them to another one, and a card from
 * ComuniBoard's „Креирај картичка" arriving as a stamp (owner, 11 Oct 2026).
 * Serves files only, as test:vezbi does; no database, invented content.
 *
 *   npm run test:wbacc-stamps            (CHROME=<path> optional, SHOT=<dir> for pictures)
 */
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {chromium} from 'playwright';
import {mkdir, readFile, writeFile, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve, join} from 'node:path';
import {installPublicStatic} from '../src/lib/public-static.js';

const server=Fastify({logger:false});
installPublicStatic(server,resolve(import.meta.dirname,'../..'));
await server.listen({host:'127.0.0.1',port:0});
const origin=`http://127.0.0.1:${server.server.address().port}`;
const browser=await chromium.launch(process.env.CHROME?{executablePath:process.env.CHROME}:{});
let checks=0;
const check=(name,value)=>{assert.ok(value,name);checks++;console.log('  ok '+name);};
const shots=process.env.SHOT;
if(shots) await mkdir(shots,{recursive:true});
const work=await mkdtemp(join(tmpdir(),'mtb-stamps-'));

const openStudio=async context=>{
  const page=await context.newPage();
  page.errors=[];page.on('pageerror',e=>page.errors.push(e.message));
  await page.goto(origin+'/WBACC.html');await page.waitForSelector('.excalidraw');
  await page.getByRole('button',{name:'Stamps',exact:true}).click();
  return page;
};
const kv=(page,key)=>page.evaluate(key=>new Promise((done,fail)=>{
  const r=indexedDB.open('wbacc-studio');r.onerror=()=>fail(r.error);r.onsuccess=()=>{
    const db=r.result,q=db.transaction('kv').objectStore('kv').get(key);
    q.onsuccess=()=>{db.close();done(q.result);};q.onerror=()=>fail(q.error);
  };
}),key);
// The drawing as it is saved, once it holds exactly n live elements.
const drawing=async(page,n)=>{
  for(let i=0;i<50;i++){const s=await kv(page,'scene-v1');const live=(s?.elements||[]).filter(e=>!e.isDeleted);if(live.length===n)return live;await new Promise(r=>setTimeout(r,100));}
  const s=await kv(page,'scene-v1');throw Error('expected '+n+' elements, saved: '+(s?.elements||[]).filter(e=>!e.isDeleted).map(e=>e.type).join(','));
};
const mine=page=>page.locator('.wbacc-stamps select').first().selectOption('mine');
const stamps=page=>page.locator('.wbacc-stamp');
const status=page=>page.locator('.wbacc-stamps [role="status"]').textContent();
const upload=async(page,name,text)=>{
  const path=join(work,name);await writeFile(path,text);
  await page.locator('.wbacc-file input').setInputFiles(path);
};

try {
  const context=await browser.newContext({viewport:{width:1366,height:900},acceptDownloads:true});
  await context.route(u=>u.origin!==origin,r=>r.abort());
  const studio=await openStudio(context);

  console.log('\na frame is a shape of the card');
  await stamps(studio).first().click();
  check('a card starts without a frame',await studio.locator('[data-frame="0"]').getAttribute('aria-pressed')==='true'
    && await studio.locator('.wbacc-swatch').count()===0);
  await studio.locator('.wbacc-primary').click();
  let live=await drawing(studio,2);
  check('the control: without a frame it is a picture and a word',live.map(e=>e.type).join()==='image,text');
  await studio.locator('[data-frame="8"]').click();
  await studio.locator('[data-colour="#dc2626"]').click();
  await studio.locator('.wbacc-primary').click();
  live=await drawing(studio,5);
  const [box,image,word]=live.slice(2);
  check('with one it is a rectangle, a picture and a word in ONE group, the rectangle underneath',
    box.type==='rectangle'&&image.type==='image'&&word.type==='text'&&box.groupIds[0]===image.groupIds[0]&&box.groupIds[0]===word.groupIds[0]);
  check('in the colour and thickness chosen, a clean line on white',box.strokeColor==='#dc2626'&&box.strokeWidth===8&&box.roughness===0&&box.backgroundColor==='#ffffff');
  const inside=e=>e.x>=box.x&&e.y>=box.y&&e.x+e.width<=box.x+box.width&&e.y+e.height<=box.y+box.height;
  check('and it goes round the picture and the word',inside(image)&&inside(word));
  if(shots) await studio.screenshot({path:join(shots,'frame.png')});
  await studio.locator('.wbacc-x').click();
  await studio.waitForFunction(()=>document.activeElement.matches('.excalidraw'));
  await studio.keyboard.press('Control+z');
  live=await drawing(studio,2);
  check('one Undo takes the whole framed card away',live.every(e=>e.type!=='rectangle'));

  console.log('\na stamp of one\'s own');
  await studio.getByRole('button',{name:'Stamps',exact:true}).click();
  check('the frame chosen last is remembered',await studio.locator('.wbacc-stamp').first().click().then(()=>studio.locator('[data-frame="8"]').getAttribute('aria-pressed'))==='true');
  await studio.locator('.wbacc-card-form input:not([type])').fill('Пробен збор');
  await studio.locator('[data-frame="4"]').click();
  await studio.locator('[data-colour="#16a34a"]').click();
  await studio.getByRole('button',{name:'★ Save to My stamps',exact:true}).click();
  await studio.waitForFunction(()=>document.querySelector('.wbacc-stamps [role="status"]').textContent.includes('★'));
  await mine(studio);
  check('it is in „Мои печати" with its word',await stamps(studio).count()===1&&(await stamps(studio).first().textContent())==='Пробен збор');
  await stamps(studio).first().click();
  check('and opens with the frame it was saved with',await studio.locator('[data-frame="4"]').getAttribute('aria-pressed')==='true'
    &&await studio.locator('[data-colour="#16a34a"]').getAttribute('aria-pressed')==='true');
  await studio.locator('[data-frame="2"]').click();
  await studio.getByRole('button',{name:'💾 Save',exact:true}).click();
  await studio.waitForFunction(()=>document.querySelector('.wbacc-stamps [role="status"]').textContent.includes('★'));
  await studio.reload();await studio.waitForSelector('.excalidraw');
  await studio.getByRole('button',{name:'Stamps',exact:true}).click();
  await mine(studio);
  await stamps(studio).first().click();
  check('a change is saved over the same stamp and survives reopening',await stamps(studio).count()===1
    &&await studio.locator('[data-frame="2"]').getAttribute('aria-pressed')==='true');
  if(shots) await studio.screenshot({path:join(shots,'mine.png')});

  console.log('\nthe file to another browser');
  const wait=studio.waitForEvent('download');
  await studio.getByRole('button',{name:'📤 Export',exact:true}).click();
  const file=join(work,'pack.json');await (await wait).saveAs(file);
  const pack=JSON.parse(await readFile(file,'utf8'));
  check('the export is a pack with the picture inside',pack.format==='mtb-stamps'&&pack.version===1&&pack.stamps.length===1
    &&pack.stamps[0].image.startsWith('data:image/png;base64,')&&pack.stamps[0].text==='Пробен збор');

  const other=await browser.newContext({viewport:{width:1366,height:900}});
  await other.route(u=>u.origin!==origin,r=>r.abort());
  const second=await openStudio(other);
  await mine(second);
  check('another browser starts with none',await stamps(second).count()===0);
  await upload(second,'pack.json',JSON.stringify(pack));
  await second.waitForFunction(()=>document.querySelectorAll('.wbacc-stamp').length===1);
  check('the import brings it, picture and frame',/Imported: 1\./.test(await status(second))
    &&(await kv(second,'stamp:'+pack.stamps[0].id)).frame.width===2);
  await upload(second,'again.json',JSON.stringify(pack));
  await second.waitForFunction(()=>/Already here: 1/.test(document.querySelector('.wbacc-stamps [role="status"]').textContent));
  check('the same file twice adds nothing',await stamps(second).count()===1);
  const changed=structuredClone(pack);changed.stamps[0].text='Друг збор';
  await upload(second,'changed.json',JSON.stringify(changed));
  await second.waitForFunction(()=>document.querySelectorAll('.wbacc-stamp').length===2);
  check('a known id with other content comes as a COPY, never over what is here',/As a copy: 1/.test(await status(second))
    &&(await kv(second,'stamp:'+pack.stamps[0].id)).text==='Пробен збор');

  console.log('\na file that must change nothing');
  const svg=structuredClone(pack);svg.stamps.push({...pack.stamps[0],id:'mine-svg1',image:'data:image/svg+xml;base64,PHN2Zy8+'});
  for(const [name,text,why] of [
    ['broken.json','{ not json','a file that is not JSON'],
    ['other.json',JSON.stringify({format:'something-else',version:1,stamps:pack.stamps}),'another format'],
    ['empty.json',JSON.stringify({format:'mtb-stamps',version:1,stamps:[]}),'an empty pack'],
    ['svg.json',JSON.stringify(svg),'a pack with one SVG among good stamps']
  ]) {
    await second.locator('.wbacc-stamps input[type="search"]').fill('');
    await upload(second,name,text);
    await second.waitForFunction(()=>/nothing was (changed|imported)/.test(document.querySelector('.wbacc-stamps [role="status"]').textContent));
    check(why+' is refused whole',await stamps(second).count()===2);
  }

  console.log('\ndeleting one');
  second.once('dialog',d=>d.accept());
  await stamps(second).first().click();
  await second.getByRole('button',{name:'Delete',exact:true}).click();
  await second.waitForFunction(()=>document.querySelectorAll('.wbacc-stamp').length===1);
  check('a deleted stamp is gone from the library',await stamps(second).count()===1);

  console.log('\na card from „Креирај картичка"');
  const board=await context.newPage();
  await board.goto(origin+'/ComuniBoard.html');
  await board.click('.nav-tab[data-target="card"]');
  const maker=board.frameLocator('#cardFrame');
  await maker.locator('#save-stamp-btn').click();
  await maker.locator('#save-stamp-btn').filter({hasText:'✓'}).waitFor();
  check('the card maker says so only after the store took it',true);
  if(shots) await board.screenshot({path:join(shots,'creator.png')});
  await studio.locator('.wbacc-x').click();
  await studio.getByRole('button',{name:'Stamps',exact:true}).click();
  await mine(studio);
  await studio.waitForFunction(()=>document.querySelectorAll('.wbacc-stamp').length===2);
  const made=studio.locator('.wbacc-stamp',{hasText:'Здраво'});
  check('WBACC shows it in „Мои печати" when the panel opens again',await made.count()===1);
  await made.click();
  check('with the card\'s thick frame in the card\'s colour',await studio.locator('[data-frame="8"]').getAttribute('aria-pressed')==='true'
    &&await studio.locator('[data-colour="#a8d4ff"]').getAttribute('aria-pressed')==='true');
  await studio.locator('.wbacc-primary').click();
  live=await drawing(studio,5);
  const placed=live.slice(2);
  check('and it is placed as a frame, a picture and its word — three parts, not one flat picture',
    placed.map(e=>e.type).join()==='rectangle,image,text'&&placed[0].strokeColor==='#a8d4ff'&&placed[2].text==='Здраво');
  if(shots) await studio.screenshot({path:join(shots,'from-creator.png')});

  check('no page errors: '+[...studio.errors,...second.errors].join(' | '),!studio.errors.length&&!second.errors.length);
}finally{await browser.close();await server.close();await rm(work,{recursive:true,force:true});}
console.log(checks+' checks passed');

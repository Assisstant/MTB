/** Word-based letter exercises and the SAME offline stamp catalogue. No DB. */
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { chromium } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { installPublicStatic } from '../src/lib/public-static.js';

const root = resolve(import.meta.dirname, '../..');
const app = Fastify({logger:false}); installPublicStatic(app,root);
await app.listen({host:'127.0.0.1',port:0});
const origin = `http://127.0.0.1:${app.server.address().port}`;
const browser = await chromium.launch({...process.env.CHROME ? {executablePath:process.env.CHROME} : {}});
let checks=0;
const check=(name,ok)=>{assert.ok(ok,name);checks++;console.log('  ok '+name);};
const shots=resolve(root,'backups/letters-review');await mkdir(shots,{recursive:true});
try {
  const context=await browser.newContext({viewport:{width:1366,height:800}});
  await context.route(u=>u.origin!==origin,route=>route.abort());
  await context.addInitScript(()=>{
    window.played=[];const play=HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play=function(){played.push(this);return play.call(this);};
  });
  const page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin+'/vezbi/index.html#vezbi');
  await page.waitForFunction(()=>typeof audio!=='undefined'&&!!db);
  const original=await page.evaluate(()=>JSON.stringify(GLASOVI));
  check('old sounds remain the default and nothing speaks on opening',await page.evaluate(()=>state.library==='sounds'&&GLASOVI.length===26&&played.length===0));
  await page.click('#m-sound .opener');await page.click('[data-library="letters"]');
  check('a separate section offers all 31 letters and starts with Word words',await page.evaluate(()=>alphabetic()&&state.stage==='home'&&document.querySelectorAll('#sound button').length===31&&!document.querySelector('#stage [data-v="syll"]')));
  await page.getByRole('button',{name:'Буква А',exact:true}).click();
  check('A has the five Word concepts',await page.evaluate(()=>shown().map(i=>WORDS[i].w).join('|')==='астронаут|авион|автомобил|ајкула|ананас'));
  const counts=await page.evaluate(async()=>{
    let images=0,clips=0;const ctx=new AudioContext(),pack=await audio.load(currentDeck());
    try {for(const w of LETTER_CATALOG.items){
      const img=new Image();img.src=w.image;await img.decode();if(img.naturalWidth<100)throw Error('Small '+w.text);images++;
      const buffer=await ctx.decodeAudioData(await(await fetch(pack.items[w.text])).arrayBuffer());
      if(buffer.duration<.3||buffer.duration>10)throw Error('Bad audio '+w.text);clips++;
    }}finally{await ctx.close();}return {images,clips};
  });
  check('all 149 ARASAAC pictures and Macedonian clips decode offline',counts.images===149&&counts.clips===149);
  check('positions handle repeated letters, Cyrillic letters and word boundaries',await page.evaluate(()=>
    JSON.stringify(letterPositions('ананас','а'))==='["start","middle"]'&&
    JSON.stringify(letterPositions('коњ','њ'))==='["end"]'&&
    letterPositions('Нова година','г').includes('start')&&!letterPositions('коњ','н').length));
  await page.evaluate(()=>{pick(VEZBI_LETTERS.findIndex(g=>g.letter==='њ'));stage('end');draw();});
  check('NJ at the end finds horse from the new catalogue',await page.evaluate(()=>shown().some(i=>WORDS[i].w==='коњ')&&shown().every(i=>WORDS[i].positions.includes('end'))));
  await page.evaluate(()=>{stage('middle');draw();});
  check('NJ in the middle finds quince and lightning',await page.evaluate(()=>['дуња','молња'].every(w=>shown().some(i=>WORDS[i].w===w))&&!shown().some(i=>WORDS[i].w==='коњ')));
  await page.evaluate(()=>{pick(VEZBI_LETTERS.findIndex(g=>g.letter==='ќ'));stage('end');state.view='one';draw();move(1);});
  check('an empty position is explained without broken cards or navigation',(await page.textContent('#out')).includes('сè уште нема зборови'));
  await page.evaluate(()=>{pick(0);state.view='one';state.step=1;state.kb=true;draw();});
  check('the target-letter exercise is available in the new section',await page.evaluate(()=>!document.querySelector('#step [data-v="1"]').hidden&&document.querySelectorAll('.card .drop').length>0));
  const needed=await page.locator('.card .drop').count();
  for(let i=0;i<needed;i++)await page.locator('#keys [data-ch="а"]').click();
  check('the existing keyboard completes the new target-letter exercise',await page.locator('.card .star').count()===1);
  await page.evaluate(()=>audio.edit('авион'));await page.click('#audio-listen');
  await page.waitForFunction(()=>played.some(p=>p.src.startsWith('data:audio/mpeg')));
  check('new recordings use default 0.75 and preserve pitch',await page.evaluate(()=>played.at(-1).playbackRate===.75&&played.at(-1).preservesPitch));
  await page.click('#audio-close');
  const pack=await page.evaluate(async()=>({format:'mtb-vezbi-audio',version:1,sound:currentDeck().file,locale:'mk-MK',items:{авион:(await audio.load(currentDeck())).items.авион}}));
  await page.setInputFiles('#audio-pack-file',{name:'letters.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(pack))});
  await page.waitForFunction(()=>!!recs['letters-01:авион']);
  check('letter recordings do not replace old sound recordings',await page.evaluate(()=>!recs['авион']));
  const download=page.waitForEvent('download');await page.evaluate(()=>exportSound());
  const exported=await readFile(await(await download).path(),'utf8');const sandbox={window:{}};
  vm.runInNewContext(exported,sandbox);vm.runInNewContext(exported,sandbox);
  check('export replaces a letter deck without adding to the original sounds',sandbox.window.VEZBI_LETTERS.length===1&&!sandbox.GLASOVI&&sandbox.window.VEZBI_LETTERS[0].words.some(w=>w.home));
  await page.evaluate(()=>{chooseLibrary('sounds');draw();});
  check('the original decks and group definitions remain byte-for-byte unchanged',await page.evaluate(()=>JSON.stringify(GLASOVI))===original);
  await page.evaluate(()=>{chooseLibrary('themes');draw();});
  check('all eleven themes remain separately available',await page.locator('#sound button').count()===11);
  await page.evaluate(()=>{chooseLibrary('letters');pick(17);state.view='grid';draw();});
  await page.screenshot({path:resolve(shots,'letters-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:resolve(shots,'letters-phone.png'),fullPage:true});
  check('new letter controls fit a phone',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.screenshot({path:resolve(shots,'letters-phone.png'),fullPage:true});

  const studio=await context.newPage();studio.on('pageerror',e=>errors.push(e.message));
  await studio.goto(origin+'/WBACC.html');await studio.waitForSelector('.excalidraw');
  await studio.getByRole('button',{name:'Stamps',exact:true}).click();
  check('WBACC offers the same 31 letter categories',await studio.locator('.wbacc-stamps select').first().locator('option').count()===32);
  check('the first stamp category has the same five images',await studio.locator('.wbacc-stamp').count()===5);
  await studio.getByRole('button',{name:'авион',exact:true}).click();
  await studio.getByRole('button',{name:'🔊 Listen',exact:true}).click();
  await studio.waitForFunction(()=>played.length>0);
  check('stamp pronunciation uses the same real MP3 and default speed',await studio.evaluate(()=>played.at(-1).src===VEZBI_AUDIO.letters.items.авион&&played.at(-1).playbackRate===.75));
  await studio.getByRole('button',{name:'Mute',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#mute').getAttribute('aria-pressed')==='true');
  check('stamp mute stops playback and reaches the open exercises',await studio.evaluate(()=>played.at(-1).paused));
  await studio.getByRole('button',{name:'Unmute',exact:true}).click();
  await studio.getByRole('button',{name:'➕ Into the drawing',exact:true}).click();
  const getScene=()=>studio.evaluate(()=>new Promise((resolve,reject)=>{
    const r=indexedDB.open('wbacc-studio');r.onerror=()=>reject(r.error);r.onsuccess=()=>{
      const db=r.result,q=db.transaction('kv').objectStore('kv').get('scene-v1');
      q.onsuccess=()=>{db.close();resolve(q.result);};q.onerror=()=>reject(q.error);
    };
  }));
  const waitCount=async n=>{
    for(let i=0;i<35;i++){const s=await getScene();if(s?.elements.filter(e=>!e.isDeleted).length===n)return s;await new Promise(r=>setTimeout(r,100));}
    const s=await getScene();await studio.screenshot({path:resolve(shots,'failure.png')});
    throw Error('Expected '+n+' saved elements; actual '+s?.elements.filter(e=>!e.isDeleted).map(e=>e.type+':'+e.id).join(','));
  };
  let scene=await waitCount(2);
  check('stamp is one editable image/text group with embedded picture',scene.elements[0].groupIds[0]===scene.elements[1].groupIds[0]&&Object.values(scene.files)[0].dataURL.startsWith('data:image/png'));
  await studio.getByRole('button',{name:'➕ Into the drawing',exact:true}).click();scene=await waitCount(4);
  check('reusing the stamp creates independent copies',new Set(scene.elements.map(e=>e.id)).size===4&&new Set(scene.elements.flatMap(e=>e.groupIds)).size===2);
  await studio.getByRole('button',{name:'Close',exact:true}).click();
  await studio.waitForFunction(()=>document.activeElement.matches('.excalidraw'));
  await studio.keyboard.press('Control+z');await waitCount(2);
  check('one Undo removes the whole last stamp',true);
  await studio.getByRole('button',{name:'Redo',exact:true}).click();await waitCount(4);
  check('Redo restores image and word together',true);
  await studio.reload();await studio.waitForSelector('.excalidraw');await waitCount(4);
  await studio.getByRole('button',{name:'Stamps',exact:true}).click();
  check('saved drawing and ready stamps survive reopening',await studio.locator('.wbacc-stamp').count()===5);
  await studio.getByRole('button',{name:'авион',exact:true}).click();
  await studio.getByRole('button',{name:'Place by tapping',exact:true}).click();
  await studio.mouse.click(250,260);scene=await waitCount(6);
  const last=scene.elements.filter(e=>e.type==='image').at(-1);
  check('tap places the stamp at the chosen canvas point',Math.abs(last.x+90-250)<5&&Math.abs(last.y+90-260)<5);
  await studio.mouse.move(400,300);await studio.mouse.down();await studio.mouse.move(470,350);await studio.mouse.up();
  await studio.mouse.click(650,320);await waitCount(8);
  check('a drag places nothing; repeat tap places one more stamp',true);
  await studio.keyboard.press('Escape');
  check('Escape exits stamp placement',await studio.locator('.wbacc-stamp-area').count()===0);
  await studio.getByRole('button',{name:'Stamps',exact:true}).click();
  await studio.screenshot({path:resolve(shots,'stamps-desktop.png'),fullPage:true});
  await studio.setViewportSize({width:390,height:844});
  check('stamp panel fits a phone',await studio.evaluate(()=>{const r=document.querySelector('.wbacc-panel').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;}));
  await studio.screenshot({path:resolve(shots,'stamps-phone.png'),fullPage:true});
  check('no browser errors',errors.length===0);

  const touch=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  await touch.route(u=>u.origin!==origin,r=>r.abort());
  const tablet=await touch.newPage();await tablet.goto(origin+'/WBACC.html');await tablet.waitForSelector('.excalidraw');
  await tablet.getByTestId('main-menu-trigger').click();
  await tablet.getByTestId('dropdown-menu').getByRole('button',{name:'Stamps',exact:true}).click();
  await tablet.getByRole('button',{name:'авион',exact:true}).click();
  await tablet.getByRole('button',{name:'Place by tapping',exact:true}).click();
  await tablet.touchscreen.tap(180,260);
  check('a real touch places one stamp',await tablet.locator('.wbacc-stamp-instructions [role="status"]').textContent()==='1');
  const cdp=await touch.newCDPSession(tablet);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:100,y:300}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:170,y:370}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  check('a real finger drag creates no accidental stamp',await tablet.locator('.wbacc-stamp-instructions [role="status"]').textContent()==='1');
  await tablet.getByRole('button',{name:'Done',exact:true}).click();
  check('the visible Done button exits on touch devices',await tablet.locator('.wbacc-stamp-area').count()===0);
  await touch.close();

  const offline=await browser.newContext();await offline.route(/^https?:/,r=>r.abort());
  const file=await offline.newPage();await file.goto(pathToFileURL(resolve(root,'vezbi/index.html')).href+'#vezbi');
  await file.waitForFunction(()=>typeof audio!=='undefined');
  check('letter exercises and bundled audio load from file://',await file.evaluate(async()=>{chooseLibrary('letters');draw();return shown().length===5&&!!(await audio.load(currentDeck())).items.авион;}));
  await file.goto(pathToFileURL(resolve(root,'WBACC.html')).href);await file.waitForSelector('.excalidraw');
  await file.getByRole('button',{name:'Stamps',exact:true}).click();
  check('standalone WBACC embeds the stamps with no companion files',await file.locator('.wbacc-stamp').count()===5);
  await offline.close();await context.close();
  console.log(`${checks} checks passed.`);
} finally {await browser.close();await app.close();}

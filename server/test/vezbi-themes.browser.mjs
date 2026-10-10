/** Theme catalogue, real offline assets, scoped recordings and child-facing controls. No database. */
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { chromium } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installPublicStatic } from '../src/lib/public-static.js';

const root = resolve(import.meta.dirname, '../..');
const app = Fastify({logger:false});
installPublicStatic(app, root);
await app.listen({host:'127.0.0.1',port:0});
const origin = `http://127.0.0.1:${app.server.address().port}`;
const browser = await chromium.launch({...process.env.CHROME ? {executablePath:process.env.CHROME} : {}});
let checks = 0;
const check = (name, ok) => { assert.ok(ok,name); checks++; console.log('  ok ' + name); };
try {
  const context = await browser.newContext({viewport:{width:1366,height:768}});
  await context.route(url=>url.origin!==origin, route=>route.abort());
  await context.addInitScript(()=>{
    const play=HTMLMediaElement.prototype.play;
    window.played=[];
    HTMLMediaElement.prototype.play=function(){window.played.push(this);return play.call(this);};
  });
  const page = await context.newPage(), errors=[], failed=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('response',r=>{if(r.status()>=400&&!r.url().includes('/api/'))failed.push(r.url());});
  page.on('dialog',d=>d.accept());
  await page.goto(origin+'/vezbi/index.html#vezbi');
  await page.waitForFunction(()=>typeof audio!=='undefined'&&!!db);
  check('original 26 sound decks remain the default, without autoplay',await page.evaluate(()=>GLASOVI.length===26&&!thematic()&&played.length===0));
  await page.click('#m-sound .opener');
  await page.click('[data-library="themes"]');
  check('the existing picker lists 11 named themes',await page.locator('#sound button').count()===11);
  await page.getByRole('button',{name:'Делови на телото',exact:true}).click();
  check('a theme starts with words and has no syllable or target-letter step',await page.evaluate(()=>state.stage==='0'&&WORDS.length===15&&document.querySelector('#step [data-v="1"]').hidden&&!document.querySelector('#stage [data-v="syll"]')));
  const validated=await page.evaluate(async()=>{
    const ctx=new AudioContext();let pictures=0,clips=0,author=0,marija=0;
    try {
      for(const g of VEZBI_THEMES){
        const pack=await audio.load(g);
        if(audio.terms(g).length!==g.words.length)throw new Error('Unexpected syllables');
        for(const w of g.words){
          const img=new Image();img.src=g.img[w.img];await img.decode();if(img.naturalWidth<100)throw new Error('Small picture');pictures++;
          const clip=pack.items[w.w];if(!clip)throw new Error('Missing '+w.w);
          const decoded=await ctx.decodeAudioData(await (await fetch(clip)).arrayBuffer());
          if(decoded.duration<0.35||decoded.duration>8)throw new Error('Bad length '+w.w);
          clips++;if(g.audioSources[w.w].kind==='author')author++;else marija++;
        }
      }
    }finally{await ctx.close();}
    return {pictures,clips,author,marija};
  });
  check('all 152 embedded pictures and MP3s decode offline',validated.pictures===152&&validated.clips===152);
  check('sources distinguish 121 author clips and 31 Marija clips',validated.author===121&&validated.marija===31);
  await page.evaluate(()=>{audio.edit('глава');});
  check('author narration is labelled correctly',(await page.textContent('#audio-source')).includes('авторското видео'));
  await page.click('#audio-listen');
  await page.waitForFunction(()=>played.length>0);
  check('a theme plays the embedded recording',await page.evaluate(()=>played.at(-1).src.startsWith('data:audio/mpeg')));
  await page.evaluate(()=>{const e=document.querySelector('[data-speech-speed]');e.value='.75';e.dispatchEvent(new Event('input'));});
  check('theme playback shares the pitch-preserving speed control',await page.evaluate(()=>played.at(-1).playbackRate===.75&&played.at(-1).preservesPitch));
  await page.click('#audio-close');
  await page.click('#mute');
  check('mute stops the theme clip and prevents another',await page.evaluate(async()=>{const n=played.length;await audio.play('глава');return played.length===n&&played.at(-1).paused;}));
  await page.click('#mute');
  await page.evaluate(()=>{state.view='one';state.step=2;state.kb=true;fresh();draw();});
  for(const letter of ['г','л','а','в','а'])await page.locator(`#keys [data-ch="${letter}"]`).click();
  check('the existing keyboard completes a thematic word',await page.locator('.card .star').count()===1);
  const shotdir=resolve(root,'backups/theme-review');await mkdir(shotdir,{recursive:true});
  await page.screenshot({path:resolve(shotdir,'body-desktop.png'),fullPage:true});

  // Reuse one real bundled clip as an import fixture; never record a person.
  const pack=await page.evaluate(async()=>{const g=VEZBI_THEMES.find(g=>g.file==='theme-hygiene');return {format:'mtb-vezbi-audio',version:1,sound:g.file,locale:'mk-MK',items:{'четка':(await audio.load(g)).items['четка']}};});
  await page.evaluate(()=>{pick(VEZBI_THEMES.findIndex(g=>g.file==='theme-hygiene'));draw();});
  await page.setInputFiles('#audio-pack-file',{name:'hygiene.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(pack))});
  await page.waitForFunction(()=>!!recs['theme-hygiene:четка']);
  check('theme imports are isolated from the same word in other themes and sounds',await page.evaluate(()=>!recs['theme-school:четка']&&!recs['четка']));
  await page.reload();await page.waitForFunction(()=>!!db);
  check('the scoped recording survives reload',await page.evaluate(()=>!!recs['theme-hygiene:четка']));
  await page.evaluate(()=>{chooseLibrary('themes');pick(VEZBI_THEMES.findIndex(g=>g.file==='theme-school'));draw();audio.edit('четка');});
  check('the other brush still uses its own built-in narration',!(await page.textContent('#audio-source')).includes('Твоја снимка'));
  await page.click('#audio-close');
  await page.setInputFiles('#audio-pack-file',{name:'wrong-theme.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(pack))});
  await page.waitForFunction(()=>document.querySelector('#note').textContent.includes('Училиштен прибор'));
  check('a different theme pack is refused without changing recordings',await page.evaluate(()=>!recs['theme-school:четка']&&!!recs['theme-hygiene:четка']));
  await page.evaluate(()=>{pick(VEZBI_THEMES.findIndex(g=>g.file==='theme-hygiene'));draw();});
  const download=page.waitForEvent('download');await page.evaluate(()=>exportSound());
  const exported=await readFile(await (await download).path(),'utf8');
  const sandbox={window:{VEZBI_THEMES:[]}};
  vm.runInNewContext(exported,sandbox);vm.runInNewContext(exported,sandbox);
  check('theme export can replace itself without duplicate decks or incorrect voice attribution',sandbox.window.VEZBI_THEMES.length===1&&sandbox.window.VEZBI_THEMES[0].audioSources['четка'].kind==='replacement'&&Object.keys(sandbox.window.VEZBI_THEMES[0].audio).length===16);
  await page.evaluate(()=>audio.edit('четка'));await page.click('#audio-reset');
  await page.waitForFunction(()=>!recs['theme-hygiene:четка']);
  check('reset restores the original theme voice',(await page.textContent('#audio-source')).includes('авторското видео'));
  await page.click('#audio-close');
  await page.evaluate(()=>{chooseLibrary('themes');pick(VEZBI_THEMES.findIndex(g=>g.file==='theme-clothes'));draw();audio.edit('маица');});
  check('unavailable narration is explicitly labelled as Marija',(await page.textContent('#audio-source')).includes('Марија'));
  await page.click('#audio-close');
  await page.setViewportSize({width:390,height:844});
  for(const file of ['theme-home','theme-hygiene','theme-clothes']){
    await page.evaluate(file=>{pick(VEZBI_THEMES.findIndex(g=>g.file===file));state.view='grid';draw();},file);
    check(file+' fits a phone without horizontal overflow',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  }
  await page.evaluate(()=>{state.view='one';state.at=WORDS.findIndex(w=>w.w==='кратки пантолони');draw();});
  check('multiword terms wrap between words and letters remain within the card',await page.evaluate(()=>{
    const card=document.querySelector('.card').getBoundingClientRect();
    return document.querySelectorAll('.word.phrase .grp').length===2&&[...document.querySelectorAll('.card .ltr')].every(el=>{const r=el.getBoundingClientRect();return r.left>=card.left&&r.right<=card.right&&parseFloat(getComputedStyle(el).fontSize)<=r.width*1.2;});
  }));
  await page.screenshot({path:resolve(shotdir,'phrase-phone.png')});
  await page.click('#m-sound .opener');
  const bounds=await page.locator('#m-sound .pop').boundingBox();
  check('theme picker stays within a phone viewport',bounds.x>=0&&bounds.x+bounds.width<=391&&bounds.y+bounds.height<=844);
  await page.screenshot({path:resolve(shotdir,'theme-phone.png')});
  await page.click('[data-library="sounds"]');
  check('switching back restores all sound choices and syllables',await page.evaluate(()=>document.querySelectorAll('#sound button').length===26&&state.stage==='syll'&&!document.querySelector('#step [data-v="1"]').hidden));
  check('server allowlist serves every required asset',failed.length===0);
  check('no page errors',errors.length===0);
  const disk=await browser.newPage();
  await disk.route(url=>url.protocol==='http:'||url.protocol==='https:',r=>r.abort());
  await disk.goto(pathToFileURL(resolve(root,'vezbi/index.html')).href+'#vezbi');
  check('themes and audio work by double-click without a server',await disk.evaluate(async()=>{chooseLibrary('themes');const p=await audio.load(currentDeck());return Object.keys(p.items).length===15&&currentDeck().img[currentDeck().words[0].img].startsWith('data:');}));
  console.log(`\n${checks} theme checks passed. Screenshots: backups/theme-review/`);
} finally {await browser.close();await app.close();}

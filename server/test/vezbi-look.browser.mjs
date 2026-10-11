/**
 * The look of the exercise page and two things kept beside it (owner, 11 Oct
 * 2026): the theme and „Скриј лента" of the strip, the board's own colour in
 * ComuniBoard, and Excalidraw's library surviving a reopening in WBACC.
 * Serves files only; no database, invented content.
 *
 *   npm run test:vezbi-look            (CHROME=<path> optional, SHOT=<dir> for pictures)
 */
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {chromium} from 'playwright';
import {mkdir} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {installPublicStatic} from '../src/lib/public-static.js';

const server=Fastify({logger:false});
server.get('/api/health',async()=>({ok:true,cloudAuth:'google'}));
installPublicStatic(server,resolve(import.meta.dirname,'../..'));
await server.listen({host:'127.0.0.1',port:0});
const origin=`http://127.0.0.1:${server.server.address().port}`;
const browser=await chromium.launch(process.env.CHROME?{executablePath:process.env.CHROME}:{});
let checks=0;
const check=(name,value)=>{assert.ok(value,name);checks++;console.log('  ok '+name);};
const shots=process.env.SHOT;
if(shots) await mkdir(shots,{recursive:true});
const shot=async(page,name)=>{ if(shots) await page.screenshot({path:join(shots,name+'.png')}); };

// WCAG contrast of an element's own text on its own (opaque) background colour.
const contrast=(page,selector)=>page.$eval(selector,el=>{
  const lum=c=>{const [r,g,b]=c.match(/[\d.]+/g).slice(0,3).map(v=>{v/=255;return v<=.03928?v/12.92:((v+.055)/1.055)**2.4;});return .2126*r+.7152*g+.0722*b;};
  let node=el,bg='rgba(0, 0, 0, 0)';
  while(node&&/rgba\(\d+, \d+, \d+, 0\)|transparent/.test(bg)){bg=getComputedStyle(node).backgroundColor;node=node.parentElement;}
  const a=lum(getComputedStyle(el).color),b=lum(bg);
  return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
});

try {
  const context=await browser.newContext({viewport:{width:1366,height:900}});
  await context.route(u=>u.origin!==origin,r=>r.abort());
  const page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin+'/vezbi/index.html#vezbi');
  await page.waitForFunction(()=>typeof audio!=='undefined');
  await page.evaluate(()=>{state.stage='0';draw();});
  await page.waitForSelector('#out .card');
  const readable=async theme=>{
    for(const [what,sel] of [['a tool of the strip','#apps button[data-v="tabla"]'],['the chosen tool','#apps button[aria-pressed="true"]'],
      ['a section','#subs [data-library="themes"]'],['the chosen section','#subs [aria-pressed="true"]'],
      ['a button of the bar','#stage button:not([aria-pressed="true"])'],['a chosen button','#stage button[aria-pressed="true"]'],
      ['the diary link','#apps .diary'],
      ['a letter','.card .ltr:not(.t)'],['the hint','#hint']]) {
      const ratio=await contrast(page,sel);
      check(theme+': '+what+' reads ('+ratio.toFixed(1)+':1)',ratio>=4.5);
    }
  };

  console.log('\nthe light theme');
  await page.waitForSelector('#apps .diary');
  check('the page opens light, with a light strip',!(await page.evaluate(()=>document.body.classList.contains('dark'))));
  await readable('light');
  await shot(page,'light');

  console.log('\nthe dark theme');
  await page.click('#theme');
  check('one button turns the page dark',await page.evaluate(()=>document.body.classList.contains('dark')));
  await readable('dark');
  check('a picture keeps a light plate, so its black lines show',
    await page.$eval('.card .pics img',i=>getComputedStyle(i).backgroundColor)==='rgb(244, 246, 248)');
  await shot(page,'dark');
  await page.reload();await page.waitForFunction(()=>typeof audio!=='undefined');
  check('and it is still dark after reopening',await page.evaluate(()=>document.body.classList.contains('dark')));
  await page.click('#theme');

  console.log('\n„Скриј лента"');
  await page.click('#hidebar');
  check('all three rows go, including exercise controls; one thin line stays',
    !(await page.isVisible('#apps'))&&!(await page.isVisible('#subs'))&&!(await page.isVisible('#bar'))&&await page.isVisible('#showbar')
    &&(await page.$eval('#showbar',b=>b.getBoundingClientRect().height))<=24);
  await shot(page,'strip-hidden');
  await page.reload();await page.waitForFunction(()=>typeof audio!=='undefined');
  check('all rows stay hidden after reopening',!(await page.isVisible('#apps'))&&!(await page.isVisible('#bar'))&&await page.isVisible('#showbar'));
  // Virtual time proves 300 ms, rather than a flaky wall-clock sleep.
  await page.clock.install();
  await page.mouse.move(600,450);
  await page.locator('#showbar').hover();await page.clock.runFor(299);
  check('a brief hover does not reveal the rows',!(await page.isVisible('#bar')));
  await page.mouse.move(600,450);await page.clock.runFor(400);
  check('leaving early cancels the pending reveal',!(await page.isVisible('#bar')));
  const cardTop=await page.locator('#out').evaluate(e=>e.getBoundingClientRect().top);
  await page.locator('#showbar').hover();await page.clock.runFor(300);
  check('after 300 ms all three rows appear temporarily',await page.isVisible('#apps')&&await page.isVisible('#subs')&&await page.isVisible('#bar'));
  check('hover does not move the cards or change the saved hide preference',
    await page.locator('#out').evaluate(e=>e.getBoundingClientRect().top)===cardTop&&await page.evaluate(()=>localStorage.getItem('vezbi_strip_v1'))==='hidden');
  await page.locator('#deck-opener').hover();await page.clock.runFor(400);
  check('hovering a menu still does not open it',!(await page.locator('#m-sound').evaluate(e=>e.classList.contains('open'))));
  await page.locator('#deck-opener').click();
  check('the menu opens by click as before',await page.locator('#m-sound').evaluate(e=>e.classList.contains('open')));
  await page.mouse.move(600,450);await page.clock.runFor(400);
  check('a clicked menu remains usable after leaving the toolbar',await page.isVisible('#bar'));
  await page.mouse.click(600,450);await page.clock.runFor(300);
  check('leaving and dismissing the menu folds the rows again',!(await page.isVisible('#bar')));
  await page.locator('#showbar').hover();await page.clock.runFor(300);
  await shot(page,'strip-hover');
  await page.keyboard.press('Escape');
  check('Escape dismisses the temporary rows and focuses their return button',!(await page.isVisible('#bar'))&&await page.locator('#showbar').evaluate(e=>e===document.activeElement));
  await page.keyboard.press('Enter');
  check('keyboard activation pins all three rows open',await page.isVisible('#bar')&&await page.evaluate(()=>localStorage.getItem('vezbi_strip_v1'))==='shown');
  await page.click('#hidebar');await page.mouse.move(600,450);await page.clock.runFor(400);
  await page.click('#showbar');
  check('„Прикажи лента" pins all three rows back',await page.isVisible('#apps')&&await page.isVisible('#subs')&&await page.isVisible('#bar')&&!(await page.isVisible('#showbar')));
  await page.clock.resume();
  const phone=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
  const mobile=await phone.newPage();await mobile.goto(origin+'/vezbi/index.html#vezbi');
  await mobile.locator('#hidebar').tap();
  check('touch hides the exercise row too',!(await mobile.isVisible('#bar')));
  await mobile.locator('#showbar').tap();
  check('touch restores all rows without hover',await mobile.isVisible('#apps')&&await mobile.isVisible('#subs')&&await mobile.isVisible('#bar'));
  await mobile.locator('#theme').tap();await shot(mobile,'phone-dark');
  await phone.close();

  console.log('\nthe board\'s own colour');
  const board=await context.newPage();
  await board.goto(origin+'/ComuniBoard.html');
  const white=board.frameLocator('#whiteboardFrame');
  await white.locator('#tbMoreBtn').click();
  const before=await white.locator('#canvas').evaluate(c=>getComputedStyle(c).backgroundColor);
  await white.locator('#boardBgInput').fill('#fff7d6');
  check('a colour chosen in ⋯ is the board\'s background',await white.locator('#canvas').evaluate(c=>getComputedStyle(c).backgroundColor)==='rgb(255, 247, 214)');
  await shot(board,'board-colour');
  await board.reload();
  check('and is kept for the next visit',await board.frameLocator('#whiteboardFrame').locator('#canvas').evaluate(c=>getComputedStyle(c).backgroundColor)==='rgb(255, 247, 214)');
  await board.frameLocator('#whiteboardFrame').locator('#tbMoreBtn').click();
  await board.frameLocator('#whiteboardFrame').locator('#boardBgReset').click();
  check('↺ gives the theme\'s colour back',await board.frameLocator('#whiteboardFrame').locator('#canvas').evaluate(c=>getComputedStyle(c).backgroundColor)===before);

  console.log('\nExcalidraw\'s library is kept');
  const kv=(p,key)=>p.evaluate(key=>new Promise((done,fail)=>{
    const r=indexedDB.open('wbacc-studio');r.onerror=()=>fail(r.error);r.onsuccess=()=>{
      const db=r.result,q=db.transaction('kv').objectStore('kv').get(key);
      q.onsuccess=()=>{db.close();done(q.result);};q.onerror=()=>fail(q.error);
    };
  }),key);
  const studio=await context.newPage();
  await studio.goto(origin+'/WBACC.html');await studio.waitForSelector('.excalidraw');
  // a rectangle drawn by hand, left selected, then added to the library
  const canvas=await (await studio.waitForSelector('canvas.interactive')).boundingBox();
  await studio.mouse.click(canvas.x+200,canvas.y+500);
  await studio.keyboard.press('r');
  await studio.mouse.move(canvas.x+300,canvas.y+300);await studio.mouse.down();
  await studio.mouse.move(canvas.x+420,canvas.y+380,{steps:5});await studio.mouse.up();
  await studio.locator('.sidebar-trigger').click();
  await studio.locator('.library-unit').first().click();
  let library;
  for(let i=0;i<40&&!(library?.length);i++){library=await kv(studio,'library-v1');await new Promise(r=>setTimeout(r,100));}
  check('a shape added to the library is written beside the drawing',library?.length===1&&library[0].elements[0].type==='rectangle');
  await studio.reload();await studio.waitForSelector('.excalidraw');
  await studio.locator('.sidebar-trigger').click();
  await studio.waitForSelector('.library-unit__dragger');
  check('and is in the library again after reopening',(await kv(studio,'library-v1')).length===1
    &&await studio.locator('.library-unit__dragger').count()>=1);
  await shot(studio,'library');

  check('no page errors: '+errors.join(' | '),errors.length===0);
}finally{await browser.close();await server.close();}
console.log(checks+' checks passed');

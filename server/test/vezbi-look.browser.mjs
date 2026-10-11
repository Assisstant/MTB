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
      ['a letter','.card .ltr:not(.t)'],['the hint','#hint']]) {
      const ratio=await contrast(page,sel);
      check(theme+': '+what+' reads ('+ratio.toFixed(1)+':1)',ratio>=4.5);
    }
  };

  console.log('\nthe light theme');
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
  check('the strip and the row of sections go, one thin line stays',
    !(await page.isVisible('#apps'))&&!(await page.isVisible('#subs'))&&await page.isVisible('#showbar')
    &&(await page.$eval('#showbar',b=>b.getBoundingClientRect().height))<=24);
  await shot(page,'strip-hidden');
  await page.reload();await page.waitForFunction(()=>typeof audio!=='undefined');
  check('it stays hidden after reopening',!(await page.isVisible('#apps'))&&await page.isVisible('#showbar'));
  await page.click('#showbar');
  check('„Прикажи лента" brings both back',await page.isVisible('#apps')&&await page.isVisible('#subs')&&!(await page.isVisible('#showbar')));

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

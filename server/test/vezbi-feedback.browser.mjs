/** Child interaction regression tests: stable cards, quiet rewards and deliberate board drags. */
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
const browser=await chromium.launch();
let checks=0;
const check=(name,value)=>{assert.ok(value,name);checks++;console.log('  ok '+name);};
try {
  const context=await browser.newContext({viewport:{width:1366,height:900},hasTouch:true});
  await context.route(u=>u.origin!==origin,r=>r.abort());
  const page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin+'/vezbi/index.html#vezbi');
  await page.waitForFunction(()=>typeof audio!=='undefined');
  await page.click('#mute');
  const prepare=async(view,kb,index=0)=>{
    await page.evaluate(({view,kb,index})=>{
      pick(0);state.step=2;state.stage='0';state.view=view;state.kb=kb;state.at=index;state.edit=false;draw();
    },{view,kb,index});
    await page.waitForFunction(()=>[...document.querySelectorAll('#out img')].every(i=>i.complete));
  };
  const geometry=()=>page.evaluate(()=>({
    scroll:scrollY,mainScroll:document.querySelector('main').scrollTop,
    cards:[...document.querySelectorAll('#out .card')].map(c=>({i:c.dataset.i,x:c.offsetLeft,y:c.offsetTop,w:c.offsetWidth,h:c.offsetHeight})),
    keys:document.querySelector('#keys').hidden
  }));
  const finish=async(i,kb,touch=false)=>{
    while(await page.locator(`.card[data-i="${i}"] .drop`).count()){
      const ch=(await page.locator(`.card[data-i="${i}"] .drop`).first().textContent()).toLowerCase();
      const key=kb?page.locator(`#keys [data-ch="${ch}"]`):page.locator(`.card[data-i="${i}"] .tile:not(.gone)`).filter({hasText:new RegExp('^'+ch+'$')}).first();
      if(touch)await key.tap();else await key.click();
    }
  };
  await prepare('grid',false);
  const before=await geometry();
  await page.evaluate(()=>{window.neighbor=document.querySelector('.card[data-i="1"]');});
  await finish(0,false);
  check('completion leaves every grid card in exactly the same layout',JSON.stringify(await geometry())===JSON.stringify(before));
  check('other cards are not rebuilt',await page.evaluate(()=>neighbor===document.querySelector('.card[data-i="1"]')));
  check('the completed card is visible and has its star',await page.locator('.card[data-i="0"] .star').isVisible());
  check('completion uses a local reward, not popup positioning',await page.locator('.card[data-i="0"]').evaluate(c=>getComputedStyle(c).position==='relative' && !c.classList.contains('pop')));
  // This layout test must detect the original class-name collision.
  await page.evaluate(()=>document.querySelector('.card[data-i="0"]').classList.add('pop'));
  check('control: the former popup class really displaces cards',JSON.stringify(await geometry())!==JSON.stringify(before));
  await page.evaluate(()=>document.querySelector('.card[data-i="0"]').classList.remove('pop'));
  await page.locator('.card[data-i="0"] .pic').click();
  check('tapping the completed picture keeps the answer',await page.locator('.card[data-i="0"] .ltr.got').count()===4);
  await page.locator('.card[data-i="0"]').getByRole('button',{name:'Почни ја картичката одново'}).click();
  check('only explicit repeat clears the answer',await page.locator('.card[data-i="0"] .drop').count()===4);
  // A wrong letter gives a hint after two tries, without losing correct work.
  const wrong=page.locator('.card[data-i="0"] .tile').filter({hasText:/^[^па]$/}).first();
  await wrong.click();await wrong.click();
  check('two wrong tries reveal a gentle hint',await page.locator('.card[data-i="0"] .drop.faint').count()===1);
  await page.setViewportSize({width:1366,height:650});
  await prepare('one',true);
  const laptop=await geometry();
  await finish(0,true);
  check('the final keyboard letter does not resize or shift the card',JSON.stringify(await geometry())===JSON.stringify(laptop));
  // Inspect an exact point in the real CSS animation without a timing race.
  await page.evaluate(()=>{for(const a of document.querySelector('.card').getAnimations({subtree:true})){a.pause();a.currentTime=300;}});
  check('the reward gently turns the card in place',await page.locator('.card').evaluate(c=>getComputedStyle(c).transform!=='none'));
  if(process.env.SHOT){await mkdir(process.env.SHOT,{recursive:true});await page.screenshot({path:join(process.env.SHOT,'reward-desktop.png')});}
  await page.evaluate(()=>{for(const a of document.querySelector('.card').getAnimations({subtree:true}))a.finish();});
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('.card')).transform==='none');
  check('the reward ends at the original position',JSON.stringify(await geometry())===JSON.stringify(laptop));
  await page.evaluate(()=>draw());
  check('a redraw after success keeps the keyboard space too',JSON.stringify(await geometry())===JSON.stringify(laptop));
  await page.setViewportSize({width:390,height:844});
  await prepare('grid',false);
  await page.locator('.card[data-i="6"]').scrollIntoViewIfNeeded();
  const phone=await geometry();
  await finish(6,false,true);
  check('touch completion lower on the phone page preserves scroll and all card positions',JSON.stringify(await geometry())===JSON.stringify(phone));
  if(process.env.SHOT){
    await page.evaluate(()=>{for(const a of document.querySelector('.card[data-i="6"]').getAnimations({subtree:true})){a.pause();a.currentTime=300;}});
    await page.screenshot({path:join(process.env.SHOT,'reward-phone.png')});
  }
  await page.evaluate(()=>document.querySelector('#calm').click());
  await page.reload();await page.waitForFunction(()=>typeof audio!=='undefined');
  await prepare('one',true);
  await finish(0,true,true);
  check('calm mode persists and leaves the reward star without movement',await page.evaluate(()=>
    document.body.classList.contains('calm') && document.querySelector('.star') && document.querySelector('.card').getAnimations({subtree:true}).length===0));
  await page.evaluate(()=>document.querySelector('#calm').click());
  await page.emulateMedia({reducedMotion:'reduce'});
  await prepare('one',true);await finish(0,true);
  check('system reduced-motion also disables the reward movement',await page.locator('.card').evaluate(c=>c.getAnimations({subtree:true}).length===0));
  await page.emulateMedia({reducedMotion:'no-preference'});
  // Real pointer dragging still fills a box.
  await page.setViewportSize({width:1366,height:900});await prepare('grid',false);
  const tile=page.locator('.card[data-i="0"] .tile').filter({hasText:/^п$/}).first();
  const t=await tile.boundingBox(),b=await page.locator('.card[data-i="0"] .drop').first().boundingBox();
  await page.mouse.move(t.x+t.width/2,t.y+t.height/2);await page.mouse.down();
  await page.mouse.move(b.x+b.width/2,b.y+b.height/2,{steps:8});await page.mouse.up();
  check('dragging a tile still fills exactly one letter',await page.locator('.card[data-i="0"] .ltr.got').count()===1);

  await page.goto(origin+'/ComuniBoard.html');
  const board=await (await page.waitForSelector('#whiteboardFrame')).contentFrame();
  await board.waitForFunction(()=>typeof state!=='undefined' && typeof renderElements==='function');
  for(const type of ['letter','image','card']){
    await board.evaluate(type=>{
      setMode(null);state.autoSnap=false;state.history={past:[],future:[]};state.selectedIds=[];
      state.elements=[{id:'fixture',type,content:type==='letter'?'а':'',label:'тест',x:100,y:100,width:90,height:100,fontSize:60}];
      renderElements();updateSelectionTools();
    },type);
    let r=await board.locator('[data-id="fixture"]').boundingBox();
    await page.mouse.move(r.x+30,r.y+30);await page.mouse.down();await page.mouse.move(r.x+33,r.y+32);await page.mouse.up();
    check(type+': a small tap wobble neither moves it nor adds undo steps',await board.evaluate(()=>state.elements[0].x===100 && state.elements[0].y===100 && state.history.past.length===0));
    r=await board.locator('[data-id="fixture"]').boundingBox();
    await page.mouse.move(r.x+30,r.y+30);await page.mouse.down();await page.mouse.move(r.x+70,r.y+50,{steps:4});await page.mouse.up();
    check(type+': a deliberate drag moves it once',await board.evaluate(()=>state.elements[0].x===140 && state.elements[0].y===120 && state.history.past.length===1));
    await board.locator('#undoBtn').click();
    check(type+': one undo restores the original position',await board.evaluate(()=>state.elements[0].x===100 && state.elements[0].y===100));
    await board.locator('#redoBtn').click();
    check(type+': redo restores the deliberate move',await board.evaluate(()=>state.elements[0].x===140 && state.elements[0].y===120));
  }
  await board.waitForFunction(()=>JSON.parse(localStorage.getItem('wbacc-board-v2') || '{}').elements?.[0]?.x===140);
  await board.locator('#undoBtn').click();
  await board.waitForFunction(()=>JSON.parse(localStorage.getItem('wbacc-board-v2') || '{}').elements?.[0]?.x===100);
  check('undo is automatically saved after the drag was already saved',true);
  await board.locator('#redoBtn').click();
  await board.waitForFunction(()=>JSON.parse(localStorage.getItem('wbacc-board-v2') || '{}').elements?.[0]?.x===140);
  check('redo is automatically saved too',true);
  check('no page errors: '+errors.join(' | '),errors.length===0);
}finally{await browser.close();await server.close();}
console.log(checks+' checks passed');

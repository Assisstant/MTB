/**
 * One letter size for every card of „Сите заедно", and a single card as wide
 * as its word needs (owner, 11 Oct 2026). Before, each card chose its own
 * size: a word of five letters stood in 42px boxes beside a word of nine in
 * small ones. Serves files only, as test:vezbi does; no database.
 *
 *   npm run test:vezbi-size            (CHROME=<path> optional, SHOT=<dir> for pictures)
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

try {
  const context=await browser.newContext({viewport:{width:1366,height:900}});
  await context.route(u=>u.origin!==origin,r=>r.abort());
  const page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin+'/vezbi/index.html#vezbi');
  await page.waitForFunction(()=>typeof audio!=='undefined');
  await page.click('#mute');

  // „Букви и зборови · А · Од Word": words of five, six and nine letters.
  const open=async(view,step=0,at=0)=>{
    await page.evaluate(({view,step,at})=>{
      if(state.library!=='letters') chooseLibrary('letters');
      state.stage='home';state.view=view;state.step=step;state.kb=false;state.edit=false;state.own={};state.at=at;wipe();draw();
    },{view,step,at});
    await page.waitForFunction(()=>[...document.querySelectorAll('#out img')].every(i=>i.complete));
  };
  // Every card's boxes: size, letter size, and whether they stay inside the card.
  const measure=()=>page.evaluate(()=>[...document.querySelectorAll('#out .card')].map(card=>{
    const c=card.getBoundingClientRect(), boxes=[...card.querySelectorAll('.word .ltr')], tiles=[...card.querySelectorAll('.tile')];
    const r=boxes.map(b=>b.getBoundingClientRect());
    return {
      letters:boxes.length, card:Math.round(c.width),
      box:Math.round(r[0].width*10)/10, same:r.every(x=>Math.abs(x.width-r[0].width)<.6),
      font:parseFloat(getComputedStyle(boxes[0]).fontSize),
      inside:r.every(x=>x.left>=c.left-.5 && x.right<=c.right+.5),
      glyph:boxes.every(b=>b.scrollWidth<=b.clientWidth+1),
      tile:tiles.length?Math.round(tiles[0].getBoundingClientRect().width*10)/10:null
    };
  }));
  const one=(list,key)=>new Set(list.map(x=>x[key])).size===1;

  console.log('\nall the cards together');
  await open('grid');
  let cards=await measure();
  const lengths=cards.map(c=>c.letters);
  check('the control: the words on screen differ in length ('+lengths.join(', ')+')',Math.min(...lengths)<=5 && Math.max(...lengths)>=9);
  check('every card has the same letter box ('+cards[0].box+'px)',one(cards,'box') && cards.every(c=>c.same));
  check('and the same letter size ('+cards[0].font+'px)',one(cards,'font'));
  check('the longest word did not make them small: a column grew instead',cards[0].box>=34 && cards[0].card>250);
  check('every box is inside its card and holds its letter',cards.every(c=>c.inside && c.glyph));
  if(shots) await page.screenshot({path:join(shots,'grid-desktop.png')});

  await open('grid',1);
  cards=await measure();
  check('the tiles to drag are one size in every card ('+cards[0].tile+'px), no smaller than a finger needs',one(cards,'tile') && cards[0].tile>=40);
  check('and the boxes they go to are still one size',one(cards,'box'));
  if(shots) await page.screenshot({path:join(shots,'grid-desktop-tiles.png')});

  console.log('\none word far longer than the rest');
  await page.evaluate(()=>{
    WORDS.push({w:'аеродинамичност',img:WORDS[0].img,home:true,positions:['start']});   // 15 letters, an invented outlier
    state.order=WORDS.map((_,i)=>i);state.step=0;draw();
  });
  cards=await measure();
  const rest=cards.filter(c=>c.letters<15), outlier=cards.find(c=>c.letters===15);
  check('the others keep one readable size ('+rest[0].box+'px)',one(rest,'box') && rest[0].box>=26);
  check('only the outlier narrows ('+outlier.box+'px), and still inside its card',outlier.box<rest[0].box && outlier.inside && outlier.same);
  if(shots) await page.screenshot({path:join(shots,'grid-desktop-outlier.png')});
  await page.evaluate(()=>{WORDS.pop();state.order=WORDS.map((_,i)=>i);draw();});

  console.log('\none card at a time');
  const nine=await page.evaluate(()=>shown().findIndex(i=>[...WORDS[i].w].length===9));
  const five=await page.evaluate(()=>shown().findIndex(i=>[...WORDS[i].w].length===5));
  await open('one',0,five);
  const short=(await measure())[0];
  await open('one',0,nine);
  const long=(await measure())[0];
  check('a word of nine letters has the box of a word of five ('+long.box+'px)',Math.abs(long.box-short.box)<.6 && long.font===short.font);
  check('because its card grew ('+short.card+' → '+long.card+'px); the short word\'s card is as before',short.card===640 && long.card>640 && long.inside);
  if(shots) await page.screenshot({path:join(shots,'one-desktop.png')});

  console.log('\na phone');
  await page.setViewportSize({width:390,height:844});
  await open('grid');
  cards=await measure();
  check('one size on a phone too ('+cards[0].box+'px), every box inside its card',one(cards,'box') && one(cards,'font') && cards.every(c=>c.inside && c.same));
  check('the page does not scroll sideways',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  if(shots) await page.screenshot({path:join(shots,'grid-phone.png')});
  await open('one',0,nine);
  const phone=(await measure())[0];
  check('the single long word narrows to the phone ('+phone.box+'px) and stays inside',phone.inside && phone.same && phone.glyph && phone.box>=20);
  if(shots) await page.screenshot({path:join(shots,'one-phone.png')});

  check('no page errors: '+errors.join(' | '),errors.length===0);
}finally{await browser.close();await server.close();}
console.log(checks+' checks passed');

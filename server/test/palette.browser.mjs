/** Real page styles on invented controls: theme parity, readable gradients,
 * subdued selection, semantic exceptions and print. No API or database. */
import assert from 'node:assert/strict';
import {readFile, mkdir} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {chromium} from 'playwright';
const root=resolve(import.meta.dirname,'../..');
const files=['S-Dnevnik.html','RasporediFusion.html','Nastava.html','NastavaUredi.html','Podatoci.html','Pregled-Baza.html','AkciskiPlan.html','Kolega.html','Sinhronizacija.html','MTB-Workspace.html'];
const luma=rgb=>{const c=rgb.slice(0,3).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return .2126*c[0]+.7152*c[1]+.0722*c[2];};
const rgb=s=>s.match(/[\d.]+/g).map(Number);
const contrast=(a,b)=>(Math.max(luma(a),luma(b))+.05)/(Math.min(luma(a),luma(b))+.05);
const browser=await chromium.launch(process.env.CHROME?{executablePath:process.env.CHROME}:{});
try {
 for(const file of files){
  const html=await readFile(join(root,file),'utf8');
  const head=html.slice(0,html.indexOf('</head>')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<link\b[^>]*>/gi,m=>m.includes('mtb-look.css')?m:'');
  const context=await browser.newContext({viewport:{width:1100,height:780},colorScheme:'light'});
  await context.route('**/*',async r=>r.fulfill({contentType:r.request().url().endsWith('.css')?'text/css':'text/html',body:r.request().url().endsWith('.css')?await readFile(join(root,'mtb-look.css')):head+`<style>body{padding:20px;overflow:auto}table{width:100%;border-collapse:collapse;margin-top:20px}td,th{padding:14px;border:1px solid var(--mtb-line)}.panel{padding:20px;margin-top:20px}</style></head><body><h2>Измислен приказ · ${file}</h2><div class="panel"><div class="mtb-tabs mtb-tabs-flat"><button id="off" class="btn soft" aria-pressed="false">Ученици</button><button id="on" class="btn soft" aria-pressed="true">Одделенија</button><label class="number-toggle"><input type="checkbox" checked> Редни броеви</label></div><p>Пробна содржина во работниот екран.</p><button id="danger" class="btn btn-danger">Тргни од листата</button><input id="field" value="Пробен внес"><table><thead><tr><th>Термин</th><th>Понеделник</th><th>Вторник</th></tr></thead><tbody><tr><th>08:00–08:40</th><td>Пробен запис</td><td>—</td></tr></tbody></table><table><tr><th id="status" style="background:#2f855a;color:white">Оценка 4</th></tr></table><table data-mtb-plain><tr><th id="paper" style="background:#eee;color:black">Печатен лист</th></tr></table></div></body></html>`}));
  const page=await context.newPage();await page.goto('http://palette.local/'+file);
  for(const theme of ['light','dark']){
   await page.evaluate(t=>{document.documentElement.dataset.theme=t;document.body.classList.toggle('dark-mode',t==='dark');document.body.classList.toggle('dark',t==='dark');},theme);
   await page.waitForTimeout(350);
   const styles=await page.evaluate(()=>Object.fromEntries(['body','.panel','#off','#on','.number-toggle','#danger','#field','thead th','#status','#paper'].map(q=>{
    const n=document.querySelector(q),s=getComputedStyle(n);let bg=s.backgroundColor,ancestor=n.parentElement;
    while(bg==='rgba(0, 0, 0, 0)'&&ancestor){bg=getComputedStyle(ancestor).backgroundColor;ancestor=ancestor.parentElement;}
    return[q,{color:s.color,bg,image:s.backgroundImage,shadow:s.textShadow}];
   })));
   assert.equal(styles.body.bg,theme==='dark'?'rgb(24, 24, 24)':'rgb(236, 238, 240)',file+' page');
   assert.equal(styles['.panel'].bg,theme==='dark'?'rgb(31, 31, 31)':'rgb(244, 245, 246)',file+' panel');
   for(const q of ['body','.panel','#off','#on','.number-toggle','#danger','#field','thead th']){
    const s=styles[q],stops=s.image.match(/rgb\([^)]+\)/g)||[s.bg];
    for(const stop of stops)assert(contrast(rgb(s.color),rgb(stop))>=4.5,`${file} ${theme} ${q}: ${s.color} on ${stop}`);
   }
   assert.notEqual(styles['#off'].image,styles['#on'].image,file+' selection remains visible');
   const lightest=s=>Math.max(...(s.image.match(/rgb\([^)]+\)/g)||[s.bg]).map(v=>luma(rgb(v))));
   // Owner, 8 Oct, later: the chosen control stands out by colour under glass (the faces differ, above), never by text-shadow.
   assert.equal(styles['#on'].shadow,'none',file+' a chosen control carries a text-shadow');
   assert.equal(styles['#status'].bg,'rgb(47, 133, 90)');assert.equal(styles['#paper'].image,'none');
   if(process.env.SHOT){await mkdir(process.env.SHOT,{recursive:true});await page.screenshot({path:join(process.env.SHOT,file.replace('.html','')+'-'+theme+'.png')});}
  }
  await page.emulateMedia({media:'print'});
  assert.equal(await page.$eval('body',n=>getComputedStyle(n).getPropertyValue('--mtb-page')),'',file+' screen palette does not leak into print');
  await context.close();console.log('PASS '+file+' light/dark contrast, selection, semantic fills and print');
 }
} finally {await browser.close();}

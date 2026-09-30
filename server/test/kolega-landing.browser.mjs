import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const root=resolve(import.meta.dirname,'../..'), origin='http://localhost:3990';
const browser=await chromium.launch({...(process.env.CHROME?{executablePath:process.env.CHROME}:{})});
const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
const token='a'.repeat(64), acting='b'.repeat(64), password='invented-secret-password';
let valid=false, owner=false, issued=false, logins=0;
const errors=[];
context.on('page',p=>p.on('pageerror',e=>errors.push(e.message)));
await context.route('**/*',async route=>{
  const r=route.request(),u=new URL(r.url()), t=r.headers()['x-mtb-portal-token'];
  const json=(status,body)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  if(['/Kolega.html','/kolegi'].includes(u.pathname)) return route.fulfill({contentType:'text/html; charset=utf-8',body:await readFile(resolve(root,'Kolega.html'))});
  if(u.pathname==='/api/portal/login') { logins++; valid=true; return json(200,{token,person:{name:'Измислен Корисник'},initialPassword:false}); }
  if(u.pathname==='/api/portal/logout') { valid=false; return json(200,{ok:true}); }
  if(u.pathname==='/api/portal/me') {
    if(!((t===token&&valid)||(t===acting&&issued))) return json(401,{error:'Најавата е истечена.'});
    return json(200,{person:{employeeId:t===acting?8:7,name:t===acting?'Измислен Колега Бета':'Измислен Корисник'},acting:t===acting,
      year:'2026/2027',usernames:{latin:'Invented',cyrillic:'Измислен'},roles:['therapist'],therapist:{id:t===acting?6:5},teacher:null,duty:false});
  }
  if(u.pathname==='/api/portal/week') return json(200,{year:'2026/2027',days:['понеделник'],periods:[],me:{teacherId:null,therapistId:t===acting?6:5,homeroom:[]},lessons:[],clashes:[],notices:[],cabinet:{bells:[],terms:[],pupils:[],names:{},elsewhere:[]}});
  if(u.pathname==='/api/staff-accounts') return owner ? json(200,{year:'2026/2027',accounts:[{employeeId:8,name:'Измислен Колега Бета',therapist:true},{employeeId:9,name:'Измислен Колега Гама',teacher:true}]}) : json(403,{error:'Само сопственикот.'});
  if(u.pathname==='/api/staff-accounts/8/open') {
    assert.equal(r.headers()['x-mtb-duty-admin-token'],undefined,'duty credentials never grant account-view permission');
    if(!owner) return json(403,{error:'Сопственичкиот пристап е истечен.'});
    issued=true; return json(200,{url:'/Kolega.html#as='+acting,hours:2});
  }
  return json(403,{error:'Не е дозволено.'});
});
const p=await context.newPage();
const artifacts=resolve(root,'backups/test-artifacts'); await mkdir(artifacts,{recursive:true});
const login=async remember=>{
  await p.fill('#loginForm [name=username]','Invented');
  await p.fill('#loginForm [name=password]',password);
  await p.locator('#rememberSession').setChecked(remember);
  await p.click('#loginForm button[type=submit]');
  await p.waitForSelector('#welcome:not([hidden])');
};
async function checkThemeControl() {
  assert.equal(await p.locator('#themeToggle').count(),1);
  assert.match(await p.locator('#themeToggle').innerText(),/Светла тема|Темна тема/);
  await p.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight));
  assert.ok(await p.locator('#themeToggle').evaluate(n=>{
    const r=n.getBoundingClientRect();
    return r.top>=0 && r.top<20 && r.right<=innerWidth && r.height>=48
      && document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===n;
  }),'theme switch stays reachable at the top, with a touch-sized target');
  await p.evaluate(()=>window.scrollTo(0,0));
}
try {
  await p.goto(origin+'/kolegi');
  await p.waitForSelector('#login:not([hidden])');
  await checkThemeControl();
  await p.screenshot({path:resolve(artifacts,'kolega-login-mobile.png'),fullPage:true});
  await login(true);
  await checkThemeControl();
  assert.equal(await p.locator('#home').isVisible(),false);
  assert.equal(await p.locator('#ownerDoor').isVisible(),false);
  assert.equal(await p.locator('#welcomeName').innerText(),'Измислен Корисник');
  assert.equal(await p.evaluate(()=>localStorage.getItem('mtb_portal_token_v1')),token);
  assert.ok(!(await p.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}))).includes(password),'application never persists a password');
  await p.click('[data-accent="teal"]'); await p.selectOption('#welcomeText','large');
  await p.click('#welcomeTheme');
  await p.reload();await p.waitForSelector('#welcome:not([hidden])');
  assert.equal(logins,1,'remembered session needs no password submission');
  assert.equal(await p.evaluate(()=>document.documentElement.dataset.accent),'teal');
  assert.equal(await p.evaluate(()=>document.documentElement.dataset.text),'large');
  assert.equal(await p.evaluate(()=>document.documentElement.dataset.theme),'dark');
  assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await p.screenshot({path:resolve(artifacts,'kolega-welcome-dark.png'),fullPage:true});
  await p.click('#welcomeTheme');await p.click('[data-accent="blue"]');
  await p.selectOption('#welcomeText','standard');
  await p.evaluate(()=>window.scrollTo(0,0));
  await p.screenshot({path:resolve(artifacts,'kolega-welcome-light.png'),fullPage:true});
  await p.click('#welcomeContinue');await p.waitForSelector('#home:not([hidden])');
  await checkThemeControl();
  await p.emulateMedia({media:'print'});
  assert.equal(await p.locator('.theme-bar').isVisible(),false,'theme controls do not enter printouts');
  await p.emulateMedia({media:'screen'});
  await p.click('#openWelcome');await p.click('#welcomeSwitch');
  await p.waitForSelector('#login:not([hidden])');
  assert.equal(await p.evaluate(()=>localStorage.getItem('mtb_portal_token_v1')),null);
  await login(false);
  assert.equal(await p.evaluate(()=>localStorage.getItem('mtb_portal_token_v1')),null);
  assert.equal(await p.evaluate(()=>sessionStorage.getItem('mtb_portal_token_v1')),token);
  await p.reload();await p.waitForSelector('#welcome:not([hidden])');
  const fresh=await context.newPage();await fresh.goto(origin+'/kolegi');
  await fresh.waitForSelector('#login:not([hidden])');await fresh.close();
  valid=false;await p.click('#welcomeContinue');await p.waitForSelector('#login:not([hidden])');
  assert.equal(await p.evaluate(()=>sessionStorage.getItem('mtb_portal_token_v1')),null,'expired session is cleared');
  await login(true);
  owner=true;await p.reload();await p.waitForSelector('#ownerDoor:not([hidden])');
  assert.match(await p.locator('#welcomeRole').innerText(),/Суперадминистратор/);
  await p.fill('#ownerAccountSearch','Бета');assert.equal(await p.locator('[data-open-account]').count(),1);
  await p.screenshot({path:resolve(artifacts,'kolega-owner-list.png'),fullPage:true});
  const loginCount=logins;
  const [popup]=await Promise.all([context.waitForEvent('page'),p.click('[data-open-account="8"]')]);
  await popup.waitForSelector('#home:not([hidden])');
  assert.equal(await popup.locator('#actingBanner').isVisible(),true);
  assert.equal(await popup.locator('#homeName').innerText(),'Измислен Колега Бета');
  assert.equal(new URL(popup.url()).hash,'','acting capability removed from URL');
  assert.equal(logins,loginCount,'selection never asks for the colleague password');
  assert.equal(await p.evaluate(()=>localStorage.getItem('mtb_portal_token_v1')),token,'owner session stays separate');
  issued=false;await popup.reload();await popup.waitForSelector('#login:not([hidden])');
  assert.equal(await p.evaluate(()=>localStorage.getItem('mtb_portal_token_v1')),token,'expired acting view cannot clear the owner login');
  assert.equal(await popup.evaluate(()=>sessionStorage.getItem('mtb_portal_acting_v1')),null);
  await popup.close();
  owner=false;
  await p.click('[data-open-account="8"]');
  await p.waitForSelector('#ownerDoor[hidden]',{state:'attached'});
  assert.match(await p.locator('#welcomeMsg').innerText(),/не е потврден/,'revocation removes stale owner controls');
  assert.deepEqual(errors,[]);
  console.log('PASS: landing, remember/session-only login, expiry, themes, phone layout, owner-only account selection and acting isolation.');
} finally { await browser.close(); }

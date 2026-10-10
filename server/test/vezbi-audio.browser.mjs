/** Real MP3 playback and persistence, using only exercise words and generated test sound. */
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {chromium} from 'playwright';
import {readFile, mkdir} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {installPublicStatic} from '../src/lib/public-static.js';

const ROOT = resolve(import.meta.dirname, '../..');
const server = Fastify({logger:false});
installPublicStatic(server, ROOT);
await server.listen({host:'127.0.0.1',port:0});
const origin = `http://127.0.0.1:${server.server.address().port}`;
const browser = await chromium.launch({args:['--use-fake-device-for-media-stream']});
let checks = 0;
const check = (name, value) => { assert.ok(value, name); checks++; console.log('  ok ' + name); };
// A short WAV, generated here; no voice or person is recorded by this test.
const wav = Buffer.alloc(44 + 1600);
wav.write('RIFF'); wav.writeUInt32LE(wav.length-8,4); wav.write('WAVEfmt ',8);
wav.writeUInt32LE(16,16); wav.writeUInt16LE(1,20); wav.writeUInt16LE(1,22);
wav.writeUInt32LE(8000,24); wav.writeUInt32LE(16000,28); wav.writeUInt16LE(2,32); wav.writeUInt16LE(16,34);
wav.write('data',36); wav.writeUInt32LE(1600,40);
for (let n=0;n<800;n++) wav.writeInt16LE(Math.round(Math.sin(n*2*Math.PI*440/8000)*1000),44+n*2);
const upload = {name:'test-tone.wav',mimeType:'audio/wav',buffer:wav};
try {
  const context = await browser.newContext({viewport:{width:1366,height:650},permissions:['microphone']});
  await context.route(url=>url.origin!==origin, route=>route.abort());
  await context.addInitScript(()=>{
    window.plays=[]; window.tracks=[];
    const play=HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play=function(){ window.plays.push(this.src.slice(0,35)); window.lastPlayback=this; return play.call(this); };
    const get=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia=async c=>{try {const s=await get(c); window.tracks.push(...s.getTracks()); return s;} catch(e){window.captureError=String(e);throw e;}};
  });
  const page=await context.newPage(), errors=[];
  page.on('pageerror', e=>errors.push(e.message)); page.on('dialog', d=>d.accept());
  await page.goto(origin+'/vezbi/index.html#vezbi');
  await page.waitForFunction(()=>typeof audio!=='undefined' && !!db);
  check('no audio is loaded or played on opening',await page.evaluate(()=>plays.length===0 && !window.VEZBI_AUDIO));
  check('a fresh browser defaults to 0.75 in both speed controls',await page.evaluate(()=>
    document.querySelector('#speed-now').textContent==='0,75×' && [...document.querySelectorAll('[data-speech-speed]')].every(e=>e.value==='0.75')));
  await page.evaluate(()=>{stage('0');state.view='one';state.at=0;draw();});
  await page.click('#m-speed .opener');
  await page.locator('#speech-speed').focus();
  await page.keyboard.press('Home');
  for(let i=0;i<5;i++)await page.keyboard.press('ArrowRight');
  check('the keyboard slider selects 0.75 and synchronizes both controls',await page.evaluate(()=>
    document.querySelector('#speed-now').textContent==='0,75×' && [...document.querySelectorAll('[data-speech-speed]')].every(e=>e.value==='0.75')));
  check('slider arrow keys do not advance the exercise card',await page.evaluate(()=>state.at===0));
  await page.click('#m-speed .opener');
  await page.evaluate(()=>{state.view='grid';stage('syll');draw();});
  await page.locator('.syll button').first().click();
  await page.waitForFunction(()=>plays.length===1);
  check('a syllable plays its real offline MP3',await page.evaluate(()=>plays[0].startsWith('data:audio/mpeg;base64,')));
  check('bundled audio uses the chosen rate and preserves pitch',await page.evaluate(()=>lastPlayback.playbackRate===0.75 && lastPlayback.preservesPitch));
  check('changing speed updates the current player immediately',await page.evaluate(()=>{
    const input=document.querySelector('#speech-speed');input.value='1.25';input.dispatchEvent(new Event('input'));
    return lastPlayback.playbackRate===1.25;
  }));
  await page.click('#mute');
  const count=await page.evaluate(()=>plays.length);
  await page.locator('.syll button').nth(1).click();
  check('mute prevents another syllable and stops the active player',await page.evaluate(n=>plays.length===n && [...document.querySelectorAll('[data-speaking]')].length===0,count));
  await page.reload(); await page.waitForFunction(()=>!!db);
  check('mute survives reopening',await page.getAttribute('#mute','aria-pressed')==='true');
  check('speech speed survives reopening',await page.inputValue('#speech-speed')==='1.25');
  await page.click('#mute');
  await page.evaluate(()=>{stage('0');state.edit=true;draw();});
  await page.locator('.card').first().getByRole('button',{name:/Уреди го аудиото/}).click();
  await page.setInputFiles('#audio-file',upload);
  await page.waitForFunction(()=>document.querySelector('#audio-message').textContent.includes('зачувана'));
  const word=await page.textContent('#audio-title');
  check('uploaded file is persisted under the exact term',await page.evaluate(t=>recs[t]?.size===1644,word));
  await page.click('#audio-listen');
  check('a personal file takes priority over Marija',await page.evaluate(()=>plays.at(-1).startsWith('blob:')));
  check('uploaded recordings use the same speed and preserve pitch',await page.evaluate(()=>lastPlayback.playbackRate===1.25 && lastPlayback.preservesPitch));
  await page.locator('#audio-editor [data-speed-reset]').click();
  check('default speed resets both controls to 0.75',await page.evaluate(()=>
    [...document.querySelectorAll('[data-speech-speed]')].every(e=>e.value==='0.75') && document.querySelector('#speed-now').textContent==='0,75×'));
  const next=page.waitForEvent('download'); await page.click('#audio-download');
  check('one term can be downloaded as its actual audio format',(await next).suggestedFilename().endsWith('.wav'));
  await page.setInputFiles('#audio-file',{name:'broken.mp3',mimeType:'audio/mpeg',buffer:Buffer.from('not audio')});
  await page.waitForFunction(()=>document.querySelector('#audio-message').textContent.includes('не е читлива'));
  check('a corrupt replacement leaves the good file intact',await page.evaluate(t=>recs[t]?.size===1644,word));
  // Phone layout is always checked; screenshots are optional evidence only.
  await page.setViewportSize({width:390,height:844});
  check('the audio editor fits a phone',await page.locator('#audio-editor').evaluate(e=>{
    const r=e.getBoundingClientRect();return r.left>=0 && r.right<=innerWidth && e.scrollWidth<=e.clientWidth;
  }));
  if(process.env.SHOT){await mkdir(process.env.SHOT,{recursive:true});await page.screenshot({path:join(process.env.SHOT,'audio-phone.png')});}
  await page.setViewportSize({width:1366,height:650});
  if(process.env.SHOT)await page.screenshot({path:join(process.env.SHOT,'audio-desktop.png')});
  await page.click('#audio-close');
  await page.setViewportSize({width:390,height:844});
  await page.click('#m-speed .opener');
  check('the speed popup fits a phone',await page.locator('#m-speed .pop').evaluate(e=>{
    const r=e.getBoundingClientRect();return r.left>=0 && r.right<=innerWidth && r.width>0;
  }));
  if(process.env.SHOT)await page.screenshot({path:join(process.env.SHOT,'speed-phone.png')});
  await page.click('#m-speed .opener');
  await page.setViewportSize({width:1366,height:650});
  await page.reload(); await page.waitForFunction(()=>!!db);
  check('the replacement survives a real reload',await page.evaluate(t=>recs[t]?.size===1644,word));
  const pack={format:'mtb-vezbi-audio',version:1,sound:'p',locale:'mk-MK',items:{[word]:'data:audio/wav;base64,'+wav.toString('base64')}};
  const other=await browser.newContext(); const second=await other.newPage();
  await second.goto(origin+'/vezbi/index.html#vezbi');await second.waitForFunction(()=>!!db);
  check('a fresh device starts without the personal recording',await second.evaluate(t=>!recs[t],word));
  await second.setInputFiles('#audio-pack-file',{name:'p.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(pack))});
  await second.waitForFunction(()=>document.querySelector('#note').textContent.includes('Внесени'));
  check('a pack transfers the recording to another device',await second.evaluate(t=>recs[t]?.size===1644,word));
  const wrong={...pack,sound:'b'};
  await second.setInputFiles('#audio-pack-file',{name:'b.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(wrong))});
  await second.waitForFunction(()=>document.querySelector('#note').textContent.includes('тековниот глас'));
  check('the wrong sound pack changes nothing',await second.evaluate(()=>Object.keys(recs).length===1));
  const poisoned={...pack,items:{[word]:pack.items[word],unknown:'data:audio/wav;base64,'+wav.toString('base64')}};
  await second.setInputFiles('#audio-pack-file',{name:'bad.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(poisoned))});
  await second.waitForFunction(()=>document.querySelector('#note').textContent.includes('непознати поими'));
  check('an invalid pack is refused in full',await second.evaluate(()=>Object.keys(recs).length===1));
  await other.close();
  // Browser automation on Windows cannot always provide a capture device.
  // Feed a generated MediaStream through the REAL MediaRecorder instead.
  await page.bringToFront();
  await page.evaluate(()=>{
    navigator.mediaDevices.getUserMedia=async()=>{
      const ctx=new AudioContext(), oscillator=ctx.createOscillator(), dest=ctx.createMediaStreamDestination();
      oscillator.connect(dest);oscillator.start();
      const stream=dest.stream;
      window.tracks.push(...stream.getTracks());
      for(const track of stream.getTracks()){
        const stop=track.stop.bind(track);let ended=false;track.stop=()=>{if(ended)return;ended=true;stop();oscillator.stop();ctx.close();};
      }
      return stream;
    };
  });
  await page.evaluate(t=>audio.edit(t),word); await page.click('#audio-record');
  await page.waitForFunction(()=>document.querySelector('#audio-record').textContent.includes('Зачувај') || document.querySelector('#audio-message').textContent.includes('не е достапен'));
  check('the real MediaRecorder starts on a synthetic stream',await page.locator('#audio-record').textContent().then(t=>t.includes('Зачувај')));
  await page.click('#audio-close');
  check('closing cancels capture and releases every microphone track',await page.evaluate(()=>tracks.length>0 && tracks.every(t=>t.readyState==='ended')));
  check('cancelled capture does not replace the uploaded file',await page.evaluate(t=>recs[t]?.size===1644,word));
  await page.evaluate(t=>audio.edit(t),word); await page.click('#audio-record');
  await page.waitForFunction(()=>document.querySelector('#audio-record').textContent.includes('Зачувај'));
  await page.waitForTimeout(250); // collect actual MediaRecorder data before stopping
  await page.click('#audio-record');
  await page.waitForFunction(t=>recs[t]?.type.includes('webm') && recs[t].size>0,word);
  check('stopping a recording saves real audio and releases the stream',await page.evaluate(()=>tracks.every(t=>t.readyState==='ended')));
  await page.click('#audio-close');
  await page.evaluate(t=>audio.edit(t),word); await page.click('#audio-reset');
  await page.waitForFunction(t=>!recs[t],word);
  await page.click('#audio-listen'); await page.waitForFunction(()=>plays.at(-1)?.startsWith('data:audio/mpeg;base64,'));
  check('reset restores the bundled Macedonian pronunciation',true);
  await page.click('#audio-close');
  const exported=page.waitForEvent('download'); await page.evaluate(()=>document.querySelector('#audio-export').click());
  const saved=await exported, body=JSON.parse(await readFile(await saved.path(),'utf8'));
  check('export includes every word, sentence and syllable of the sound',Object.keys(body.items).length===await page.evaluate(()=>audio.terms(GLASOVI[0]).length));
  // Every bundle must contain exactly its sound's terms, and a real decodable sample.
  const bundles=await page.evaluate(async()=>{
    const ac=new AudioContext();let checked=0,total=0;
    try { for(const g of GLASOVI){const p=await audio.load(g), expected=audio.terms(g);
      if(expected.length!==Object.keys(p.items).length || expected.some(t=>!p.items[t]))throw new Error('Missing audio: '+g.file);
      const bytes=Uint8Array.from(atob(p.items[expected[0]].split(',')[1]),c=>c.charCodeAt(0));
      const a=await ac.decodeAudioData(bytes.buffer);if(a.duration<=0 || a.duration>60)throw new Error('Bad audio');
      checked++;total+=expected.length;
    }}finally{await ac.close();}return {checked,total};
  });
  check('all 26 offline bundles have complete terms and decodable MP3 audio',bundles.checked===26);
  console.log('  Audio entries including repeated terms: '+bundles.total);
  // No fetch/CORS dependency: the same sound opens from a double-click.
  const disk=await browser.newPage();await disk.goto(pathToFileURL(join(ROOT,'vezbi/index.html')).href+'#vezbi');
  const fileAudio=await disk.evaluate(async()=>Object.keys((await audio.load(GLASOVI[0])).items).length);
  check('bundled audio loads from file:// without a server',fileAudio>0);
  check('no page errors: '+errors.join(' | '),errors.length===0);
} finally {await browser.close();await server.close();}
console.log(`${checks} checks passed`);

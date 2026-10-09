// Offline audio for the exercise page. Bundles are lazy scripts so file://
// works too. Personal replacements stay in IndexedDB until explicitly exported.
window.createVezbiAudio = function ({ sound, recordings, save, note }) {
  const $ = id => document.getElementById(id);
  const loads = new Map();
  const MAX_FILE = 10 * 1024 * 1024;
  let muted = false, player = null, playerUrl = '', generation = 0;
  let editing = null, recording = null, capture = 0, busy = false;
  let rate = 1;
  try { muted = localStorage.getItem('vezbi_muted_v1') === '1'; } catch (_) {}
  try { const stored = Number(localStorage.getItem('vezbi_speech_rate_v1')); if (Number.isFinite(stored) && stored >= 0.5 && stored <= 1.5) rate = stored; } catch (_) {}

  function updateRate(value = rate) {
    const number = Number(value);
    rate = Number.isFinite(number) ? Math.round(Math.max(0.5, Math.min(1.5, number)) * 20) / 20 : 1;
    const label = String(rate).replace('.', ',') + '×';
    $('speed-now').textContent = label;
    document.querySelectorAll('[data-speed-value]').forEach(el => el.textContent = label);
    document.querySelectorAll('[data-speech-speed]').forEach(el => {
      el.value = rate; el.setAttribute('aria-valuetext', String(rate).replace('.', ',') + ' пати');
    });
    if (player) { player.preservesPitch = true; player.playbackRate = rate; }
  }

  function terms(g) {
    return [...new Set([...g.words, ...(g.sentences || [])].map(x => (x.w || x.s).replace(/[{}]/g, ''))
      .concat([...'ауеио'].flatMap(v => [g.letter + v, v + g.letter + v, v + g.letter])))];
  }
  function load(g) {
    if (window.VEZBI_AUDIO?.[g.file]) return Promise.resolve(window.VEZBI_AUDIO[g.file]);
    if (loads.has(g.file)) return loads.get(g.file);
    const promise = new Promise((resolve, reject) => {
      const tag = document.createElement('script');
      tag.src = 'audio/' + encodeURIComponent(g.file) + '.js';
      const timer = setTimeout(() => fail(), 15000);
      function fail() { clearTimeout(timer); tag.remove(); loads.delete(g.file); reject(new Error('Аудиопакетот не се вчита. Пробај повторно.')); }
      tag.onerror = fail;
      tag.onload = () => {
        clearTimeout(timer);
        const pack = window.VEZBI_AUDIO?.[g.file];
        if (!pack?.items) { fail(); return; }
        resolve(pack);
      };
      document.head.appendChild(tag);
    });
    loads.set(g.file, promise);
    return promise;
  }
  function updateMute() {
    $('mute').textContent = muted ? '🔇' : '🔊';
    $('mute').setAttribute('aria-pressed', String(muted));
    $('mute').setAttribute('aria-label', muted ? 'Вклучи звук' : 'Исклучи звук');
    $('mute').title = muted ? 'Звукот е исклучен — вклучи' : 'Исклучи звук';
  }
  function stop() {
    generation++;
    if (player) { player.pause(); player.removeAttribute('src'); player.load(); player = null; }
    if (playerUrl) { URL.revokeObjectURL(playerUrl); playerUrl = ''; }
    if (window.speechSynthesis) speechSynthesis.cancel();
    document.querySelectorAll('[data-speaking]').forEach(el => el.removeAttribute('data-speaking'));
  }
  function message(text) { if ($('audio-editor').open) $('audio-message').textContent = text; else note(text); }
  async function play(text, quiet = false, button = null, g = sound()) {
    stop();
    if (muted) { if (!quiet) message('Звукот е исклучен. Вклучи го со 🔇 во лентата.'); return; }
    const ticket = generation;
    let source = recordings[text] || g.audio?.[text];
    if (!source) {
      try { source = (await load(g)).items[text]; } catch (_) { /* a native Macedonian voice can still work */ }
    }
    if (ticket !== generation || muted) return;
    if (source) {
      if (source instanceof Blob) { playerUrl = URL.createObjectURL(source); source = playerUrl; }
      const audio = new Audio(source);
      audio.preservesPitch = true;
      audio.playbackRate = rate;
      player = audio;
      if (button) button.dataset.speaking = 'true';
      audio.onended = () => { if (player === audio) stop(); };
      audio.onerror = () => { if (player === audio) { stop(); if (!quiet) message('Снимката не може да се прочита. Во „Аудио“ внеси друга датотека.'); } };
      try { await audio.play(); } catch (_) {
        if (ticket === generation) { stop(); if (!quiet) message('Не можам да пуштам звук. Допри „Слушни“ повторно.'); }
      }
      return;
    }
    // A neighbouring language is not a Macedonian pronunciation model.
    const voice = window.speechSynthesis?.getVoices().find(v => /^mk(?:-|$)/i.test(v.lang));
    if (!voice) { if (!quiet) message('Нема снимка за овој поим. Во „Уреди → Аудио“ внеси датотека или сними го изговорот.'); return; }
    const utterance = new SpeechSynthesisUtterance(text.replace(/-/g, ' '));
    utterance.voice = voice; utterance.lang = 'mk-MK'; utterance.rate = 0.85 * rate;
    speechSynthesis.speak(utterance);
  }
  function download(blob, name) {
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  const asData = blob => new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob);
  });
  function fromData(value) {
    if (typeof value !== 'string' || value.length > MAX_FILE * 1.4) throw new Error('Невалидна или преголема снимка.');
    const match = /^data:(audio\/[a-z0-9.+-]+)(?:;codecs=[a-z0-9.,-]+)?;base64,([A-Za-z0-9+/=]+)$/i.exec(value);
    if (!match) throw new Error('Пакетот содржи нешто што не е аудиоснимка.');
    const bytes = Uint8Array.from(atob(match[2]), c => c.charCodeAt(0));
    return new Blob([bytes], {type: match[1]});
  }
  async function validate(blob) {
    if (!blob.size || blob.size > MAX_FILE) throw new Error('Избери аудиодатотека до 10 MB.');
    const Context = window.AudioContext || window.webkitAudioContext;
    const context = new Context();
    try {
      const decoded = await context.decodeAudioData(await blob.arrayBuffer());
      if (!Number.isFinite(decoded.duration) || decoded.duration <= 0 || decoded.duration > 60)
        throw new Error('Снимката треба да трае најмногу 60 секунди.');
    } catch (e) {
      throw new Error(e.message.includes('60 секунди') ? e.message : 'Ова не е читлива аудиодатотека. Пробај MP3 или WAV.');
    } finally { await context.close(); }
  }
  function refresh() {
    if (!editing) return;
    const own = !!recordings[editing.text];
    $('audio-source').textContent = own ? 'Твоја снимка · зачувана на овој уред' : 'Марија · македонски · вградена снимка';
    $('audio-reset').hidden = !own;
    $('audio-record').textContent = recording ? '⏹ Зачувај ја снимката' : '🎙 Сними со микрофон';
    $('audio-file').disabled = busy || !!recording;
    $('audio-pick').disabled = busy || !!recording;
    $('audio-record').disabled = busy;
    $('audio-reset').disabled = busy || !!recording;
    $('audio-listen').disabled = busy || !!recording;
  }
  function cancelRecording() {
    capture++;
    const active = recording; recording = null;
    if (active) { active.cancelled = true; clearTimeout(active.timer); if (active.recorder.state !== 'inactive') active.recorder.stop(); active.stream.getTracks().forEach(t => t.stop()); }
  }
  function close() { stop(); cancelRecording(); editing = null; $('audio-editor').close(); }
  function edit(text) {
    stop(); cancelRecording(); editing = {text, g: sound()};
    $('audio-title').textContent = text;
    $('audio-message').textContent = '';
    $('audio-file').value = '';
    refresh(); $('audio-editor').showModal();
  }
  async function record() {
    if (recording) { if (recording.recorder.state !== 'inactive') recording.recorder.stop(); return; }
    if (!editing || busy) return;
    stop(); const target = editing, ticket = ++capture;
    busy = true; refresh(); $('audio-message').textContent = 'Дозволи пристап до микрофонот.';
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({audio:true});
      if (ticket !== capture || editing !== target) { stream.getTracks().forEach(t => t.stop()); return; }
      const recorder = new MediaRecorder(stream), chunks = [];
      const active = {recorder, stream, cancelled:false, timer:null};
      recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
      recorder.onerror = () => { active.cancelled = true; clearTimeout(active.timer); stream.getTracks().forEach(t => t.stop()); if (recording === active) recording = null; refresh(); message('Снимањето не успеа. Пробај повторно.'); };
      recorder.onstop = async () => {
        clearTimeout(active.timer); stream.getTracks().forEach(t => t.stop());
        if (recording === active) recording = null;
        if (!active.cancelled && chunks.length) {
          busy = true; refresh();
          try { await save({[target.text]:new Blob(chunks, {type:recorder.mimeType})}); message('Снимката е зачувана. Допри „Слушни“ за проверка.'); }
          catch (_) { message('Снимката не се зачува. Провери го просторот во прелистувачот.'); }
          finally { busy = false; }
        }
        refresh();
      };
      recording = active; recorder.start();
      active.timer = setTimeout(() => { if (recorder.state !== 'inactive') recorder.stop(); }, 30000);
      $('audio-message').textContent = 'Снимам… до 30 секунди. „Зачувај ја снимката“ завршува порано.';
    } catch (_) {
      if (stream) stream.getTracks().forEach(t => t.stop());
      message('Микрофонот не е достапен. Дозволи го или внеси готова аудиодатотека.');
    } finally { busy = false; refresh(); }
  }
  async function allAudio(g = sound()) {
    const pack = await load(g), items = {};
    for (const text of terms(g)) {
      const value = recordings[text] || g.audio?.[text] || pack.items[text];
      if (value) items[text] = value instanceof Blob ? await asData(value) : value;
    }
    return items;
  }
  async function exportPack() {
    try {
      const g = sound(), items = await allAudio(g);
      const pack = {format:'mtb-vezbi-audio', version:1, sound:g.file, locale:'mk-MK', items};
      download(new Blob([JSON.stringify(pack)], {type:'application/json'}), 'audio-' + g.file + '.json');
      note('Аудиопакетот е преземен. На друг уред избери „Внеси аудиопакет“ за истиот глас.');
    } catch (e) { note(e.message); }
  }
  async function importPack(file) {
    if (!file) return;
    try {
      if (file.size > 60 * 1024 * 1024) throw new Error('Пакетот е преголем (до 60 MB).');
      const pack = JSON.parse(await file.text()), g = sound(), allowed = new Set(terms(g));
      if (pack.format !== 'mtb-vezbi-audio' || pack.version !== 1 || pack.sound !== g.file || pack.locale !== 'mk-MK'
        || !pack.items || typeof pack.items !== 'object' || Array.isArray(pack.items))
        throw new Error('Избери аудиопакет за тековниот глас ' + g.letter.toUpperCase() + '.');
      const entries = Object.entries(pack.items);
      if (!entries.length || entries.length > allowed.size || entries.some(([text]) => !allowed.has(text)))
        throw new Error('Пакетот содржи непознати поими. Ништо не е сменето.');
      note('Ги проверувам снимките…');
      const replacements = {};
      for (const [text, data] of entries) { const blob = fromData(data); await validate(blob); replacements[text] = blob; }
      await save(replacements);
      note('Внесени се ' + entries.length + ' снимки на овој уред.');
    } catch (e) { note(e instanceof SyntaxError ? 'Ова не е валиден аудиопакет.' : e.message); }
  }
  $('mute').addEventListener('click', () => {
    muted = !muted; stop(); try { localStorage.setItem('vezbi_muted_v1', muted ? '1' : '0'); } catch (_) {}
    updateMute(); message(muted ? 'Звукот е исклучен.' : 'Звукот е вклучен. Допри 🔊 за слушање.');
  });
  $('audio-close').addEventListener('click', close);
  $('audio-editor').addEventListener('cancel', e => { e.preventDefault(); close(); });
  $('audio-listen').addEventListener('click', e => { if (editing) play(editing.text, false, e.currentTarget, editing.g); });
  $('audio-stop').addEventListener('click', stop);
  $('audio-record').addEventListener('click', record);
  $('audio-pick').addEventListener('click', () => $('audio-file').click());
  $('audio-file').addEventListener('change', async e => {
    const file = e.target.files[0], target = editing; if (!file || !target) return;
    busy = true; refresh(); stop();
    try { await validate(file); await save({[target.text]:file}); message('Датотеката е зачувана на овој уред. Допри „Слушни“.'); }
    catch (err) { message(err.message); }
    finally { busy = false; e.target.value = ''; refresh(); }
  });
  $('audio-reset').addEventListener('click', async () => {
    if (!editing || busy) return;
    if (!confirm('Да се тргне твојата снимка за овој поим и да се врати вградената?')) return;
    try { stop(); await save({[editing.text]:undefined}); refresh(); message('Вратена е вградената снимка.'); }
    catch (_) { message('Промената не се зачува.'); }
  });
  $('audio-download').addEventListener('click', async () => {
    if (!editing) return;
    const {text, g} = editing;
    try {
      const source = recordings[text] || g.audio?.[text] || (await load(g)).items[text];
      if (!source) throw new Error('Нема снимка за преземање.');
      const blob = source instanceof Blob ? source : fromData(source);
      const ext = /mpeg|mp3/.test(blob.type) ? 'mp3' : /wav/.test(blob.type) ? 'wav' : /mp4|m4a/.test(blob.type) ? 'm4a' : /ogg/.test(blob.type) ? 'ogg' : 'webm';
      download(blob, text.replace(/[^\p{L}\p{N}-]/gu, '_').slice(0,70) + '.' + ext);
    } catch (e) { message(e.message); }
  });
  $('audio-export').addEventListener('click', exportPack);
  $('audio-import').addEventListener('click', () => $('audio-pack-file').click());
  $('audio-pack-file').addEventListener('change', e => { importPack(e.target.files[0]); e.target.value = ''; });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { stop(); cancelRecording(); refresh(); } });
  function setRate(value) {
    updateRate(value);
    try { localStorage.setItem('vezbi_speech_rate_v1', String(rate)); } catch (_) {}
  }
  document.querySelectorAll('[data-speech-speed]').forEach(el => el.addEventListener('input', () => setRate(el.value)));
  document.querySelectorAll('[data-speed-reset]').forEach(el => el.addEventListener('click', () => setRate(1)));
  updateMute(); updateRate();
  return {play, stop, edit, close, allAudio, terms, load, importPack};
};

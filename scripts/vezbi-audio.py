"""Build offline Macedonian audio from the public exercise vocabulary only.

Requires edge-tts (https://github.com/rany2/edge-tts). No credentials, recordings
or pupil data are read. Dry-run by default; --apply contacts the speech service.
MP3 originals, importable packs and a ZIP stay in ignored backups/. Only the
complete per-sound playback bundles are written under vezbi/audio/.
"""
import argparse
import asyncio
import base64
import hashlib
import html
import json
from pathlib import Path
import re
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]
VOICE = 'mk-MK-MarijaNeural'
RATE = '-10%'


def catalogue():
    sounds = []
    # The original hand-written decks are JS object literals, not JSON.
    # Evaluate only the repository's public data in a context with no I/O.
    extracted = subprocess.check_output(['node', '-e', """
const fs=require('node:fs'),vm=require('node:vm'); const ctx={GLASOVI:[]};
for(const f of fs.readdirSync('vezbi/glasovi').filter(f=>/^[a-z]+\\.js$/.test(f)).sort())
  vm.runInNewContext(fs.readFileSync('vezbi/glasovi/'+f,'utf8'),ctx,{timeout:1000});
process.stdout.write(JSON.stringify(ctx.GLASOVI));
"""], cwd=ROOT)
    for g in json.loads(extracted):
        terms = [re.sub(r'[{}]', '', x.get('w') or x['s'])
                 for x in g['words'] + g.get('sentences', [])]
        for v in 'ауеио':
            terms.extend([g['letter'] + v, v + g['letter'] + v, v + g['letter']])
        sounds.append((g['file'], list(dict.fromkeys(terms))))
    return sounds


async def build(sounds):
    import edge_tts
    cache = ROOT / 'backups/vezbi-audio/marija'
    cache.mkdir(parents=True, exist_ok=True)
    terms = list(dict.fromkeys(t for _, items in sounds for t in items))
    paths = {}
    completed = 0
    sem = asyncio.Semaphore(3)

    async def one(text):
        nonlocal completed
        digest = hashlib.sha256((VOICE + RATE + text).encode()).hexdigest()[:24]
        path = cache / (digest + '.mp3')
        async with sem:
            if not path.exists() or path.stat().st_size < 100:
                for attempt in range(3):
                    try:
                        temp = path.with_suffix('.part')
                        await edge_tts.Communicate(text.replace('-', ' '), VOICE, rate=RATE).save(str(temp))
                        if temp.stat().st_size < 100:
                            raise ValueError('Empty speech response')
                        temp.replace(path)
                        break
                    except Exception:
                        if attempt == 2:
                            raise
                        await asyncio.sleep(2 * (attempt + 1))
            paths[text] = path
            completed += 1
            if completed % 25 == 0 or completed == len(terms):
                print(f'Audio ready: {completed}/{len(terms)}', flush=True)

    await asyncio.gather(*(one(t) for t in terms))
    target = ROOT / 'vezbi/audio'
    target.mkdir(exist_ok=True)
    manifest = {'voice': VOICE, 'locale': 'mk-MK', 'rate': RATE, 'source': 'Microsoft Edge online TTS via edge-tts',
                'terms': [{'text': t, 'file': paths[t].name} for t in terms]}
    (cache / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    packs = []
    for name, items in sounds:
        pack = {'format': 'mtb-vezbi-audio', 'version': 1, 'sound': name,
                'voice': VOICE, 'locale': 'mk-MK',
                'items': {t: 'data:audio/mpeg;base64,' + base64.b64encode(paths[t].read_bytes()).decode() for t in items}}
        encoded = json.dumps(pack, ensure_ascii=False, separators=(',', ':'))
        (target / (name + '.js')).write_text(
            '// Generated Macedonian exercise audio; regenerate with scripts/vezbi-audio.py.\n'
            'window.VEZBI_AUDIO = window.VEZBI_AUDIO || {};\n'
            f'window.VEZBI_AUDIO[{json.dumps(name)}] = {encoded};\n', encoding='utf-8')
        exported = cache / (name + '.json')
        exported.write_text(encoded, encoding='utf-8')
        packs.append(exported)
    with zipfile.ZipFile(cache.parent / 'Vezbi-Marija-audio.zip', 'w', zipfile.ZIP_DEFLATED) as z:
        for path in list(dict.fromkeys(paths.values())) + [cache / 'manifest.json']:
            z.write(path, 'mp3/' + path.name)
        for path in packs:
            z.write(path, 'packs/' + path.name)
        rows = ''.join('<li><span>' + html.escape(t) + '</span><audio controls preload="none" src="mp3/'
                       + paths[t].name + '"></audio><a download="' + html.escape(t[:70], quote=True)
                       + '.mp3" href="mp3/' + paths[t].name + '">Преземи MP3</a></li>' for t in terms)
        z.writestr('index.html', '<!doctype html><html lang="mk"><meta charset="utf-8">'
                   '<meta name="viewport" content="width=device-width,initial-scale=1"><title>Марија — аудиотека</title>'
                   '<style>body{font:16px system-ui;max-width:960px;margin:30px auto;padding:16px;background:#f4f6f8;color:#1d2733}'
                   'input{padding:12px;width:90%;font:inherit}ul{padding:0}li{list-style:none;display:flex;align-items:center;gap:16px;'
                   'padding:12px;border-bottom:1px solid #ccd3db;flex-wrap:wrap}li span{flex:1;min-width:160px}audio{max-width:100%}'
                   'li[hidden]{display:none}</style><h1>Марија — македонска аудиотека</h1>'
                   '<p>Отпакувај го ZIP-от пред слушање. Во Вежби внеси MP3 преку „Уреди → Аудио“, '
                   'или JSON од packs/ преку „Внеси аудиопакет“.</p>'
                   '<p>Синтетички изговор: преслушај го поимот пред користење во вежба.</p>'
                   '<input type="search" aria-label="Барај поим" placeholder="Барај збор, реченица или слог…">'
                   '<ul>' + rows + '</ul><script>document.querySelector("input").oninput=e=>{const q=e.target.value.toLocaleLowerCase();'
                   'document.querySelectorAll("li").forEach(x=>x.hidden=!x.firstElementChild.textContent.toLocaleLowerCase().includes(q));};'
                   'document.addEventListener("play",e=>document.querySelectorAll("audio").forEach(a=>{if(a!==e.target)a.pause();}),true);</script></html>')
    print(f'Complete: {len(sounds)} sound bundles, {len(terms)} separate MP3s and an importable ZIP.', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    sounds = catalogue()
    print(f'{len(sounds)} sounds; {len(set(t for _, items in sounds for t in items))} unique terms; {VOICE}, rate {RATE}.', flush=True)
    if args.apply:
        asyncio.run(build(sounds))
    else:
        print('Dry run. Add --apply to generate the audio.')

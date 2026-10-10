import { useEffect, useRef, useState } from 'react';
import { insertCard } from './scene.js';
import { useT } from './i18n.js';
import '../../vezbi/bukvi.js';
import '../../vezbi/letters.js';
import '../../vezbi/audio/letters.js';

// The same frozen catalogue as the separate Word exercises, embedded in the
// standalone WBACC build. No ARASAAC request or second maintained word list.
const catalogue = window.LETTER_CATALOG;
export default function Stamps({ api, onClose, onPlace }) {
    const t = useT();
    const [category, setCategory] = useState('а');
    const [position, setPosition] = useState('home');
    const [query, setQuery] = useState('');
    const [picked, setPicked] = useState(null);
    const [label, setLabel] = useState('');
    const [withWord, setWithWord] = useState(true);
    const [size, setSize] = useState(180);
    const [status, setStatus] = useState('');
    const [muted, setMuted] = useState(() => {
        try { return localStorage.getItem('vezbi_muted_v1') === '1'; } catch { return false; }
    });
    const player = useRef(null);
    const stop = () => { player.current?.pause(); player.current = null; };
    useEffect(() => {
        const changed = e => { if (e.key === 'vezbi_muted_v1') {player.current?.pause();setMuted(e.newValue === '1');} };
        window.addEventListener('storage',changed);
        return () => {player.current?.pause();window.removeEventListener('storage',changed);};
    }, []);
    const reset = () => { stop(); setPicked(null); setStatus(''); };
    const words = catalogue.items.filter(item =>
        (!category || (position === 'home' ? item.category === category : window.letterPositions(item.text, category).includes(position)))
        && item.text.toLocaleLowerCase('mk').includes(query.trim().toLocaleLowerCase('mk')));
    const pick = item => { stop(); setPicked(item); setLabel(item.text); setStatus(''); };
    const insert = () => {
        if (!api || !picked) return;
        insertCard(api, {dataURL: picked.image, mimeType: 'image/png', label: withWord ? label : '', size: Number(size), undoable: true});
        setStatus(t('✓ Картичката е во цртежот.'));
        if (window.innerWidth < 700) onClose();
    };
    const listen = async () => {
        stop();
        if (!picked || muted) return;
        const src = window.VEZBI_AUDIO.letters.items[picked.text];
        if (!src) { setStatus(t('За овој поим сè уште нема снимка.')); return; }
        const audio = new Audio(src); player.current = audio;
        let rate = .75;
        try { const stored = Number(localStorage.getItem('vezbi_speech_rate_v1')); if (stored >= .5 && stored <= 1.5) rate = stored; } catch { /* default */ }
        audio.playbackRate = rate; audio.preservesPitch = true;
        try { await audio.play(); } catch { setStatus(t('Снимката не се пушти. Пробај повторно.')); }
    };
    const mute = () => {
        stop(); setMuted(!muted);
        try { localStorage.setItem('vezbi_muted_v1', muted ? '0' : '1'); } catch { /* this visit */ }
    };
    return <div className="wbacc-panel__body wbacc-stamps" onKeyDown={e => {if(e.key==='Escape'){e.stopPropagation();onClose();}}}>
        <div className="wbacc-panel__head"><strong>{t('Печати · Букви и зборови')}</strong>
            <button type="button" className="wbacc-x" onClick={onClose} aria-label={t('Затвори')}>✕</button></div>
        <p className="wbacc-status">{t('Избери слика, па постави ја во цртежот. Може да ја користиш повеќепати.')}</p>
        <label>{t('Категорија по буква')}
            <select value={category} onChange={e => {setCategory(e.target.value); reset();}}>
                <option value="">{t('Сите печати')}</option>
                {catalogue.categories.map(c => <option key={c.letter} value={c.letter}>{c.letter.toUpperCase()}</option>)}
            </select></label>
        <label>{t('Место на гласот')}
            <select value={position} disabled={!category} onChange={e => {setPosition(e.target.value); reset();}}>
                {[['home','Од Word'],['start','На почеток'],['middle','Во средина'],['end','На крај']].map(([id,name]) => <option key={id} value={id}>{t(name)}</option>)}
            </select></label>
        <input type="search" aria-label={t('Барај печат')} placeholder={t('Барај печат')} value={query}
            onChange={e => {setQuery(e.target.value); reset();}} />
        {picked && <div className="wbacc-card-form">
            <strong>{picked.text}</strong>
            <label className="wbacc-check"><input type="checkbox" checked={withWord} onChange={e => setWithWord(e.target.checked)} />{t('Со збор')}</label>
            {withWord && <label>{t('Збор на картичката')}<input value={label} onChange={e => setLabel(e.target.value)} /></label>}
            <label>{t('Големина')} · {size}<input type="range" aria-label={t('Големина')} min="80" max="320" step="20" value={size} onChange={e => setSize(e.target.value)} /></label>
            <button type="button" className="wbacc-primary" onClick={insert}>{t('➕ Во цртежот')}</button>
            <button type="button" onClick={() => onPlace({dataURL:picked.image,mimeType:'image/png',label:withWord?label:'',size:Number(size)})}>{t('Постави со допир')}</button>
            <div className="wbacc-row">
                <button type="button" onClick={listen} disabled={muted}>{t('🔊 Слушни')}</button>
                <button type="button" onClick={stop}>{t('Стоп')}</button>
                <button type="button" aria-pressed={muted} onClick={mute}>{t(muted ? 'Вклучи звук' : 'Исклучи звук')}</button>
            </div>
            {withWord && label !== picked.text && <p className="wbacc-fine">{t('Снимката го изговара оригиналниот поим.')}</p>}
        </div>}
        <p role="status" className="wbacc-status">{status || `${words.length} ${t('печати')}`}</p>
        <div className="wbacc-stamp-grid">
            {words.map(item => <button type="button" className="wbacc-stamp" key={item.id}
                aria-pressed={picked?.id === item.id} onClick={() => pick(item)}>
                <img src={item.image} alt="" loading="lazy" /><span>{item.text}</span>
            </button>)}
        </div>
        {!words.length && <p>{t('Нема печати за овој избор. Избери друга буква или место.')}</p>}
        <p className="wbacc-fine">{t('Пиктограми: Sergio Palao / ARASAAC (arasaac.org), Влада на Арагон, лиценца CC BY-NC-SA — само за некомерцијална употреба.')}</p>
    </div>;
}

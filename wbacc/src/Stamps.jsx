import { useEffect, useRef, useState } from 'react';
import { insertCard } from './scene.js';
import { useT } from './i18n.js';
import CardLook, { useLook } from './CardLook.jsx';
import { listMine, saveMine, removeMine, exportPack, importPack, newId } from './mine.js';
import '../../vezbi/bukvi.js';
import '../../vezbi/letters.js';
import '../../vezbi/audio/letters.js';

// The same frozen catalogue as the separate Word exercises, embedded in the
// standalone WBACC build. No ARASAAC request or second maintained word list.
const catalogue = window.LETTER_CATALOG;
// „Мои печати" is one more category of the same panel (owner, 11 Oct 2026):
// cards made here, in „Пиктограми" or in ComuniBoard's „Креирај картичка".
const MINE = 'mine';
const typeOf = (dataURL) => dataURL.slice(5, dataURL.indexOf(';')) || 'image/png';
const IMPORT_ERRORS = {
    'not-json': 'Ова не е датотека со печати — ништо не е сменето.',
    'not-a-pack': 'Ова не е датотека со печати — ништо не е сменето.',
    'empty': 'Датотеката е празна — ништо не е сменето.',
    'too-many': 'Во датотеката има премногу печати — ништо не е увезено.',
    'bad-stamp': 'Во датотеката има печат што не може да се прочита — ништо не е увезено.'
};

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
    const [look, setLook] = useLook();
    const [mine, setMine] = useState([]);
    const [muted, setMuted] = useState(() => {
        try { return localStorage.getItem('vezbi_muted_v1') === '1'; } catch { return false; }
    });
    const player = useRef(null);
    const stop = () => { player.current?.pause(); player.current = null; };
    // Read again every time the panel opens: ComuniBoard may have added a card since.
    const refresh = () => listMine().then(setMine).catch(() => setStatus(t('„Мои печати“ не можат да се прочитаат во овој прелистувач.')));
    useEffect(() => {
        refresh();
        const changed = e => { if (e.key === 'vezbi_muted_v1') {player.current?.pause();setMuted(e.newValue === '1');} };
        window.addEventListener('storage',changed);
        return () => {player.current?.pause();window.removeEventListener('storage',changed);};
    }, []);
    const reset = () => { stop(); setPicked(null); setStatus(''); };
    const own = category === MINE;
    const asked = query.trim().toLocaleLowerCase('mk');
    const words = own
        ? mine.filter(item => item.text.toLocaleLowerCase('mk').includes(asked))
        : catalogue.items.filter(item =>
            (!category || (position === 'home' ? item.category === category : window.letterPositions(item.text, category).includes(position)))
            && item.text.toLocaleLowerCase('mk').includes(asked));
    const pick = item => {
        stop(); setPicked(item); setLabel(item.text); setStatus('');
        // a stamp of one's own comes with the look it was saved with
        if (item.frame) { setLook(item.frame); setWithWord(Boolean(item.text)); }
    };
    const card = () => ({dataURL: picked.image, mimeType: typeOf(picked.image), label: withWord ? label : '', size: Number(size),
        frame: look, textColor: picked.textColor, labelOnTop: picked.labelOnTop});
    const insert = () => {
        if (!api || !picked) return;
        insertCard(api, {...card(), undoable: true});
        setStatus(t('✓ Картичката е во цртежот.'));
        if (window.innerWidth < 700) onClose();
    };
    // The word and the frame as they stand in the form. A ready stamp becomes a
    // new stamp of one's own; one's own stamp is saved over itself.
    const keep = async () => {
        if (!picked) return;
        try {
            const saved = await saveMine({id: picked.frame ? picked.id : newId(), text: withWord ? label : '', image: picked.image,
                frame: look, textColor: picked.textColor, labelOnTop: picked.labelOnTop, created: picked.frame ? picked.created : Date.now()});
            await refresh();
            if (picked.frame) setPicked(saved);
            setStatus(t('★ Зачувано во „Мои печати“.'));
        } catch { setStatus(t('Печатот не се зачува. Провери го просторот во прелистувачот.')); }
    };
    const remove = async () => {
        if (!picked?.frame || !confirm(t('Да се избрише печатот „{0}“? Веќе поставените копии остануваат во цртежите.', picked.text || '…'))) return;
        try { await removeMine(picked.id); reset(); await refresh(); setStatus(t('Печатот е избришан.')); }
        catch { setStatus(t('Печатот не се избриша.')); }
    };
    const exportFile = () => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([exportPack(mine)], {type: 'application/json'}));
        a.download = 'moi-pecati-' + new Date().toISOString().slice(0, 10) + '.json';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
        setStatus(t('Извезени: {0}. Датотеката е во преземањата.', mine.length));
    };
    const importFile = async (e) => {
        const file = e.target.files[0]; e.target.value = '';
        if (!file) return;
        try {
            const done = await importPack(await file.text());
            await refresh(); reset();
            setStatus(t('Увезени: {0}. Веќе ги има: {1}. Како копија: {2}.', done.added, done.skipped, done.copies));
        } catch (err) { setStatus(t(IMPORT_ERRORS[err.message] || 'Увозот не успеа — ништо не е сменето.')); }
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
                <option value={MINE}>{t('★ Мои печати')}{mine.length ? ' · ' + mine.length : ''}</option>
                {catalogue.categories.map(c => <option key={c.letter} value={c.letter}>{c.letter.toUpperCase()}</option>)}
            </select></label>
        {!own && <label>{t('Место на гласот')}
            <select value={position} disabled={!category} onChange={e => {setPosition(e.target.value); reset();}}>
                {[['home','Од Word'],['start','На почеток'],['middle','Во средина'],['end','На крај']].map(([id,name]) => <option key={id} value={id}>{t(name)}</option>)}
            </select></label>}
        {own && <div className="wbacc-row">
            <label className="wbacc-file">{t('📥 Увези')}<input type="file" accept=".json,application/json" onChange={importFile} hidden /></label>
            <button type="button" onClick={exportFile} disabled={!mine.length}>{t('📤 Извези')}</button>
        </div>}
        <input type="search" aria-label={t('Барај печат')} placeholder={t('Барај печат')} value={query}
            onChange={e => {setQuery(e.target.value); reset();}} />
        {picked && <div className="wbacc-card-form">
            <strong>{picked.text}</strong>
            <label className="wbacc-check"><input type="checkbox" checked={withWord} onChange={e => setWithWord(e.target.checked)} />{t('Со збор')}</label>
            {withWord && <label>{t('Збор на картичката')}<input value={label} onChange={e => setLabel(e.target.value)} /></label>}
            <label>{t('Големина')} · {size}<input type="range" aria-label={t('Големина')} min="80" max="320" step="20" value={size} onChange={e => setSize(e.target.value)} /></label>
            <CardLook look={look} setLook={setLook} />
            <button type="button" className="wbacc-primary" onClick={insert}>{t('➕ Во цртежот')}</button>
            <button type="button" onClick={() => onPlace(card())}>{t('Постави со допир')}</button>
            <div className="wbacc-row">
                <button type="button" onClick={keep}>{t(picked.frame ? '💾 Зачувај' : '★ Зачувај во „Мои печати“')}</button>
                {picked.frame && <button type="button" onClick={remove}>{t('Избриши')}</button>}
            </div>
            <div className="wbacc-row">
                <button type="button" onClick={listen} disabled={muted}>{t('🔊 Слушни')}</button>
                <button type="button" onClick={stop}>{t('Стоп')}</button>
                <button type="button" aria-pressed={muted} onClick={mute}>{t(muted ? 'Вклучи звук' : 'Исклучи звук')}</button>
            </div>
            {withWord && label !== picked.text && !picked.frame && <p className="wbacc-fine">{t('Снимката го изговара оригиналниот поим.')}</p>}
        </div>}
        <p role="status" className="wbacc-status">{status || `${words.length} ${t('печати')}`}</p>
        <div className="wbacc-stamp-grid">
            {words.map(item => <button type="button" className="wbacc-stamp" key={item.id}
                aria-pressed={picked?.id === item.id} onClick={() => pick(item)}
                style={item.frame?.width ? {border: Math.min(item.frame.width, 4) + 'px solid ' + item.frame.color} : undefined}>
                <img src={item.image} alt="" loading="lazy" /><span>{item.text}</span>
            </button>)}
        </div>
        {!words.length && <p>{t(own ? 'Сè уште нема твои печати. Избери печат или пиктограм и стисни „★ Зачувај во Мои печати“, или направи картичка во ComuniBoard → Картички.'
            : 'Нема печати за овој избор. Избери друга буква или место.')}</p>}
        <p className="wbacc-fine">{t(own ? '„Мои печати“ се чуваат само во овој прелистувач. За друг уред: „Извези“ тука, „Увези“ таму.'
            : 'Пиктограми: Sergio Palao / ARASAAC (arasaac.org), Влада на Арагон, лиценца CC BY-NC-SA — само за некомерцијална употреба.')}</p>
    </div>;
}

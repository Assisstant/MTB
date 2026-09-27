import { useState } from 'react';
import { insertCard, readAsDataURL } from './scene.js';
import { useT } from './i18n.js';

// ARASAAC pictograms, as ComuniBoard searched them: Macedonian first, then
// English. Searching needs the Internet by nature; a card once made keeps its
// picture in the drawing and shows offline.
const API = 'https://api.arasaac.org/api/pictograms/';
const imageUrl = (id) => `https://static.arasaac.org/pictograms/${id}/${id}_300.png`;

async function search(locale, word) {
    const r = await fetch(API + locale + '/search/' + encodeURIComponent(word));
    if (r.status === 404) return [];
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    return Array.isArray(data) ? data : [];
}

const wordOf = (p, fallback) => {
    const w = (p.keywords && p.keywords[0] && p.keywords[0].keyword) || fallback;
    return w ? w.charAt(0).toUpperCase() + w.slice(1) : '';
};

export default function Pictograms({ api, onClose }) {
    const t = useT();
    const [query, setQuery] = useState('');
    const [results, setResults] = useState([]);
    const [status, setStatus] = useState('');
    const [label, setLabel] = useState('');
    const [picked, setPicked] = useState(null);
    const [onTop, setOnTop] = useState(false);

    const run = async (e) => {
        e?.preventDefault();
        const word = query.trim();
        if (!word) return;
        setStatus(t('⏳ Барам…'));
        setResults([]);
        setPicked(null);
        try {
            let found = await search('mk', word);
            if (!found.length) found = await search('en', word);
            setResults(found.slice(0, 60));
            setStatus(found.length ? '' : t('Нема пиктограм за „{0}“.', word));
        } catch {
            setStatus(t('Пиктограмите бараат интернет — ARASAAC не одговара.'));
        }
    };

    const pick = (p) => {
        setPicked(p);
        setLabel(wordOf(p, query.trim()));
    };

    const insert = async () => {
        if (!picked || !api) return;
        setStatus(t('⏳ Го преземам пиктограмот…'));
        try {
            const blob = await (await fetch(imageUrl(picked._id))).blob();
            insertCard(api, { dataURL: await readAsDataURL(blob), mimeType: blob.type || 'image/png', label, labelOnTop: onTop });
            setStatus(t('✓ Картичката е во цртежот.'));
        } catch {
            setStatus(t('Сликата не се презеде — провери го интернетот.'));
        }
    };

    return (
        <div className="wbacc-panel__body">
            <div className="wbacc-panel__head">
                <strong>{t('🖼 Пиктограми')}</strong>
                <button type="button" className="wbacc-x" onClick={onClose} aria-label={t('Затвори')}>✕</button>
            </div>
            <form className="wbacc-row" onSubmit={run}>
                <input type="search" placeholder={t('збор, пр. куќа, јаде, мачка')} value={query}
                       onChange={(e) => setQuery(e.target.value)} aria-label={t('Барај пиктограм')} autoFocus />
                <button type="submit">{t('Барај')}</button>
            </form>
            {status && <p className="wbacc-status">{status}</p>}
            <div className="wbacc-pictos">
                {results.map((p) => (
                    <button type="button" key={p._id} className={'wbacc-picto' + (picked && picked._id === p._id ? ' on' : '')}
                            onClick={() => pick(p)} title={wordOf(p, '')}>
                        <img src={imageUrl(p._id)} alt={wordOf(p, '')} loading="lazy" />
                    </button>
                ))}
            </div>
            {picked && (
                <div className="wbacc-card-form">
                    <label>{t('Збор на картичката')}
                        <input value={label} onChange={(e) => setLabel(e.target.value)} />
                    </label>
                    <label className="wbacc-check">
                        <input type="checkbox" checked={onTop} onChange={(e) => setOnTop(e.target.checked)} /> {t('текстот над сликата')}
                    </label>
                    <button type="button" className="wbacc-primary" onClick={insert}>{t('➕ Во цртежот')}</button>
                </div>
            )}
            <p className="wbacc-fine">{t('Пиктограми: Sergio Palao / ARASAAC (arasaac.org), Влада на Арагон, лиценца CC BY-NC-SA — само за некомерцијална употреба.')}</p>
        </div>
    );
}

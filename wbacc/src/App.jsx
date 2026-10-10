import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Excalidraw, MainMenu, THEME, languages } from '@excalidraw/excalidraw';
import { load, save } from './store.js';
import Credit from './Credit.jsx';
import Pictograms from './Pictograms.jsx';
import Stamps from './Stamps.jsx';
import StampPlacement from './StampPlacement.jsx';
import Bookmarks from './Bookmarks.jsx';
import { wordsToSpeak } from './scene.js';
import { exportDrawingImage } from './image.js';
import { LangContext, translator } from './i18n.js';

const SCENE_KEY = 'scene-v1';
const LANG_KEY = 'wbacc-lang';
const SAVE_DELAY = 800;
// What of the view is worth keeping between visits; the rest is Excalidraw's.
const KEEP = ['viewBackgroundColor', 'theme', 'gridModeEnabled', 'scrollX', 'scrollY', 'zoom'];

// English for the owner, Macedonian on request (owner, 28 Sep 2026). Excalidraw
// has no Macedonian of its own: `mk-MK` is our translation, added at build
// time (vite.config.js); what it lacks falls back to English.
const LANGS = ['en', 'mk-MK'];
// Opened alone this page was a dead end. The exercise page (vezbi/) shows this
// same tool under one strip with the exercises, ComuniBoard and the way to
// S-Дневник; inside its frame the strip is already there, so no link here.
const ALONE = window.parent === window;

function storedLang() {
    try { const l = localStorage.getItem(LANG_KEY); return LANGS.includes(l) ? l : 'en'; } catch { return 'en'; }
}

export default function App() {
    const [lang, setLang] = useState(storedLang);
    const [dark, setDark] = useState(false);
    const [excalidraw, setExcalidraw] = useState(null);
    const [panel, setPanel] = useState('');          // '', 'pictos', 'bookmarks'
    const [stamp, setStamp] = useState(null);
    const pending = useRef(null);
    const timer = useRef(null);

    // The last drawing, from this browser. A board that cannot be read opens
    // empty rather than not at all, and says so in the console.
    const initialData = useMemo(() => load(SCENE_KEY)
        .then((scene) => scene || null)
        .catch((err) => { console.warn('WBACC: the saved board could not be read', err); return null; }), []);

    const flush = useCallback(() => {
        clearTimeout(timer.current);
        const scene = pending.current;
        pending.current = null;
        if (scene) save(SCENE_KEY, scene).catch((err) => console.warn('WBACC: the board was not saved', err));
    }, []);

    const onChange = useCallback((elements, appState, files) => {
        setDark(appState.theme === THEME.DARK);
        const view = {};
        KEEP.forEach((k) => { view[k] = appState[k]; });
        pending.current = { elements, appState: view, files };
        clearTimeout(timer.current);
        timer.current = setTimeout(flush, SAVE_DELAY);
    }, [flush]);

    // Leaving the page must not lose the last stroke waiting for its delay.
    useEffect(() => {
        const leave = () => { if (document.visibilityState === 'hidden') flush(); };
        window.addEventListener('pagehide', flush);
        document.addEventListener('visibilitychange', leave);
        return () => { window.removeEventListener('pagehide', flush); document.removeEventListener('visibilitychange', leave); };
    }, [flush]);

    // „🔊 Изговори", as in ComuniBoard: the selected words, or all of them, in
    // a Macedonian voice when the system has one, else the nearest Slavic.
    const speak = () => {
        if (!excalidraw || !window.speechSynthesis) return;
        const words = wordsToSpeak(excalidraw);
        if (!words) return;
        speechSynthesis.cancel();
        const say = new SpeechSynthesisUtterance(words);
        const voices = speechSynthesis.getVoices();
        const voice = voices.find((v) => /^mk/i.test(v.lang)) || voices.find((v) => /^(sr|bg|hr|sl|ru)/i.test(v.lang));
        if (voice) { say.voice = voice; say.lang = voice.lang; } else say.lang = 'mk-MK';
        speechSynthesis.speak(say);
    };
    const toggle = (name) => { setStamp(null); setPanel((now) => (now === name ? '' : name)); };
    const focusCanvas = () => requestAnimationFrame(() => document.querySelector('.excalidraw')?.focus());
    const closePanel = () => { setPanel(''); focusCanvas(); };
    const closeStamp = () => { setStamp(null); focusCanvas(); };
    const t = useMemo(() => translator(lang), [lang]);

    const saveImage = async () => {
        if (!excalidraw) return;
        try {
            const done = await exportDrawingImage(excalidraw);
            const message = done.empty ? t('Цртежот е празен — нема што да се зачува.')
                : (done.partial ? t('📷 Означеното е зачувано како слика.') : t('📷 Цртежот е зачуван како слика.')) +
                  (done.embeds ? ' ' + t('Вградените веб-страници се во сликата само како рамка.') : '');
            excalidraw.setToast({ message, duration: done.embeds ? 6000 : 3000 });
        } catch (err) {
            console.warn('WBACC: the picture was not made', err);
            excalidraw.setToast({ message: t('Сликата не се направи: {0}', err && err.message ? err.message : String(err)), duration: 6000 });
        }
    };

    const chooseLang = (code) => {
        setLang(code);
        try { localStorage.setItem(LANG_KEY, code); } catch { /* this visit only */ }
    };

    return (
        <LangContext.Provider value={t}>
        <div className="wbacc">
            <Excalidraw initialData={initialData} onChange={onChange} langCode={lang} name="WBACC Studio"
                        excalidrawAPI={setExcalidraw}
                        renderTopRightUI={() => (
                            <div className="wbacc-tools">
                                <button type="button" className={panel === 'stamps' ? 'on' : ''} onClick={() => toggle('stamps')}>{t('Печати')}</button>
                                <button type="button" className={panel === 'pictos' ? 'on' : ''} onClick={() => toggle('pictos')} title={t('Пиктограми (ARASAAC)')}>{t('🖼 Пиктограми')}</button>
                                <button type="button" className={panel === 'bookmarks' ? 'on' : ''} onClick={() => toggle('bookmarks')} title={t('Обележувачи')}>{t('🔖 Обележувачи')}</button>
                                <button type="button" onClick={saveImage} title={t('Зачувај слика (PNG): означеното, или целиот цртеж')}>{t('📷 Слика')}</button>
                                <button type="button" onClick={speak} title={t('Изговори го означениот текст')}>🔊</button>
                                {ALONE && <a className="wbacc-out" href="vezbi/index.html#crtanje" title={t('Оваа алатка во една лента со Вежби за изговор и ComuniBoard, и со патот до S-Дневник')}>{t('🗣 Вежби')}</a>}
                            </div>
                        )}>
                <MainMenu>
                    <MainMenu.Item onSelect={() => toggle('stamps')}>{t('Печати')}</MainMenu.Item>
                    {/* A phone has no row of buttons on top; the menu is there on every screen. */}
                    {ALONE && (
                        <MainMenu.ItemCustom>
                            <a className="wbacc-out" href="vezbi/index.html#crtanje">{t('🗣 Вежби')}</a>
                        </MainMenu.ItemCustom>
                    )}
                    <MainMenu.DefaultItems.LoadScene />
                    <MainMenu.DefaultItems.SaveToActiveFile />
                    <MainMenu.DefaultItems.Export />
                    <MainMenu.DefaultItems.SaveAsImage />
                    <MainMenu.DefaultItems.ClearCanvas />
                    <MainMenu.Separator />
                    <MainMenu.DefaultItems.ToggleTheme />
                    <MainMenu.DefaultItems.ChangeCanvasBackground />
                    <MainMenu.ItemCustom>
                        <select className="wbacc-lang" aria-label={t('Јазик')} value={lang} onChange={(e) => chooseLang(e.target.value)}>
                            {LANGS.map((code) => {
                                const known = languages.find((l) => l.code === code);
                                return <option key={code} value={code}>{known ? known.label : code}</option>;
                            })}
                        </select>
                    </MainMenu.ItemCustom>
                </MainMenu>
            </Excalidraw>
            {panel && (
                <aside className={'wbacc-panel' + (dark ? ' dark' : '')} aria-label={t(panel === 'stamps' ? 'Печати' : panel === 'pictos' ? 'Пиктограми' : 'Обележувачи')}>
                    {panel === 'stamps' ? <Stamps api={excalidraw} onClose={closePanel} onPlace={value => {setStamp(value);setPanel('');}} /> : panel === 'pictos'
                        ? <Pictograms api={excalidraw} onClose={() => setPanel('')} />
                        : <Bookmarks api={excalidraw} onClose={() => setPanel('')} />}
                </aside>
            )}
            {stamp && excalidraw && <StampPlacement api={excalidraw} stamp={stamp} onClose={closeStamp} />}
            <Credit dark={dark} />
        </div>
        </LangContext.Provider>
    );
}

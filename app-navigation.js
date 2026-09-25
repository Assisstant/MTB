/**
 * Shared navigation and trustworthy working-state strip.
 *
 * The server identity answers "which installation is this?". The data state
 * answers a different question: "has this screen's work reached that server?".
 * Keeping the two separate prevents a green connection light from pretending
 * that a local-only edit has already been written to PostgreSQL.
 */
(function () {
    'use strict';

    const APPS = [
        { file: 'start.html', label: 'Сите', title: 'Сите апликации' },
        { file: 'S-Dnevnik.html', label: 'S-Дневник', title: 'Електронски дневник' },
        { file: 'RasporediFusion.html', label: 'Кабинети', title: 'Распоред на терапевтски кабинети' },
        { file: 'Nastava.html', label: 'Настава ↔ терапии', title: 'Настава и терапии — кој е отсутен од кој час' },
        { file: 'NastavaUredi.html', label: 'Уреди настава', title: 'Внесување и менување на распоредот на настава' },
        { file: 'Podatoci.html', label: 'Податоци', title: 'Поставување на учебната година и списоците' },
        { file: 'AkciskiPlan.html', label: 'Евидентен лист', title: 'Евидентен лист и акциски план — следење на развојот, и кварталниот план по категории' }
    ];
    const PUBLISHED_HOST = 'assisstant.github.io';
    const SELECTED_SERVER_KEY = 'mtb_podatoci_server_v1';
    const SERVERS_KEY = 'mtb_servers_v1';
    const SERVER_DEFAULTS = [
        'https://pcw.tailc8965f.ts.net',
        'https://zenpc-1.tailc8965f.ts.net',
        'https://zenpc.tailc8965f.ts.net'
    ];
    const SERVER_TIMEOUT = 4000;
    let serverMenu = null;
    let probed = [];
    const HEALTH_TIMEOUT = 4500;
    const HEALTH_INTERVAL = 15000;
    const TOKEN_KEY = 'evidence_token_v1';
    const LOCAL_FIRST = new Set(['s-dnevnik.html', 'rasporedi.html']);
    const READ_ONLY = new Set(['nastava.html', 'pregled-baza.html', 'sinhronizacija.html']);

    let healthTimer = null;
    let healthRequest = 0;
    let serverState = { state: 'checking', label: 'Ја проверувам базата…', title: '' };
    let dataState = normalizeDataState(window.__MTB_DATA_STATE__ || defaultDataState());
    let userState = null;
    let cloudGoogle = false;
    const nativeFetch = window.fetch.bind(window);

    function isPublished() {
        return window.location.hostname === PUBLISHED_HOST;
    }

    function selectedServer() {
        if (!isPublished()) return '';
        try {
            const file = currentFile();
            const fallbackKey = file === 's-dnevnik.html' ? 'sdn_local_server_url_v1'
                : (file === 'rasporedi.html' || file === 'pregled-baza.html') ? 'local_server_url_v1' : '';
            const value = localStorage.getItem(SELECTED_SERVER_KEY)
                || (fallbackKey ? localStorage.getItem(fallbackKey) : '');
            if (!value) return '';
            const url = new URL(value);
            if (url.protocol !== 'https:' || !url.hostname.endsWith('.ts.net')) return '';
            return url.origin;
        } catch (_) {
            return '';
        }
    }

    function serverName(base) {
        try {
            const host = new URL(base).hostname.split('.')[0].toLowerCase();
            if (host === 'pcw') return 'PCW';
            if (host === 'zenpc-1') return 'ZenPC-1';
            if (host === 'zenpc') return 'ZenPC';
            return host || base;
        } catch (_) { return base; }
    }

    /** The hand-edited list wins over the built-in one, exactly as start.html reads it. */
    function configuredServers() {
        let values = SERVER_DEFAULTS;
        try {
            const stored = JSON.parse(localStorage.getItem(SERVERS_KEY));
            if (Array.isArray(stored) && stored.length) values = stored;
        } catch (_) { /* private mode, or an old invalid preference */ }
        return [...new Set(values.map((value) => {
            try {
                const url = new URL(String(value).trim());
                return url.protocol === 'https:' && url.hostname.endsWith('.ts.net') ? url.origin : null;
            } catch (_) { return null; }
        }).filter(Boolean))];
    }

    async function probeServer(base) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), SERVER_TIMEOUT);
        try {
            const res = await nativeFetch(base + '/api/health', {
                signal: controller.signal, cache: 'no-store'
            });
            const body = res.ok ? await res.json() : null;
            return body && body.ok ? base : null;
        } catch (_) {
            return null;
        } finally {
            clearTimeout(timer);
        }
    }

    function rememberServer(base) {
        try { localStorage.setItem(SELECTED_SERVER_KEY, base); }
        catch (_) { /* the choice still works for this tab */ }
        window.dispatchEvent(new CustomEvent('mtb:server-selected'));
    }

    function activeServer() {
        if (isPublished()) return selectedServer();
        return /^https?:$/.test(window.location.protocol) ? window.location.origin : '';
    }

    /**
     * Every screen shares the same signed-in session.  Keeping the header here
     * means an administrator who signs in once can use the database-backed
     * editors too; individual pages do not each have to grow a second auth
     * implementation.  Never send the token to a host other than the selected
     * MTB server.
     */
    function installAuthenticatedFetch() {
        if (window.__MTB_AUTH_FETCH_INSTALLED__) return;
        window.__MTB_AUTH_FETCH_INSTALLED__ = true;
        window.fetch = function (input, init) {
            let target;
            let server;
            try {
                const raw = typeof input === 'string' || input instanceof URL ? input : input.url;
                target = new URL(raw, window.location.href);
                server = new URL(activeServer());
            } catch (_) {
                return nativeFetch(input, init);
            }
            if (target.origin !== server.origin || !target.pathname.startsWith('/api/')) {
                return nativeFetch(input, init);
            }
            // Every write to the database passes this one line, whichever page
            // or form made it — so this is where the other windows are told.
            const method = String((init && init.method)
                || (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET')).toUpperCase();
            const topic = changeTopic(target.pathname, method);
            const sent = withToken(input, init);
            if (!topic) return sent;
            return sent.then((res) => {
                if (res && res.ok) announceChange(topic);
                return res;
            });
        };
    }

    function withToken(input, init) {
        let token = '';
        try { token = localStorage.getItem(TOKEN_KEY) || ''; } catch (_) {}
        if (!token) return nativeFetch(input, init);
        const sourceHeaders = init && init.headers
            ? init.headers
            : (typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined);
        const headers = new Headers(sourceHeaders || {});
        if (!headers.has('x-mtb-evidence-token')) headers.set('x-mtb-evidence-token', token);
        if (typeof Request !== 'undefined' && input instanceof Request) {
            return nativeFetch(new Request(input, Object.assign({}, init || {}, { headers })));
        }
        return nativeFetch(input, Object.assign({}, init || {}, { headers }));
    }

    /* ── Една промена, сите прозорци ─────────────────────────────────────
     *
     * Сопственикот, 24 септември: „ако нешто се промени на едно место, треба
     * да биде истото и во паѓачкото мени и на другите места каде се појавува
     * податокот". Не беше. Секој екран ги чита списоците ЕДНАШ, кога ќе се
     * отвори, а работниот простор држи неколку отворени одеднаш — паралелка
     * додадена во „Податоци" не постоеше во паѓачкото мени на „Администрација"
     * до рачно освежување, а белешката таму го велеше тоа како упатство.
     * Само формуларот ✏️ им кажуваше на другите, и само за своите зачувувања.
     *
     * Затоа известувањето е ТУКА, во единствениот `fetch` низ кој минува секое
     * запишување, а не во секоја функција за зачувување: правило што секој
     * нов екран мора да се сети да го повика е правило што ќе се заборави
     * точно еднаш — токму така настана ова.
     *
     * Се праќа само ТЕМАТА (`teaching`, `students`…), никогаш идентификатор или
     * име: истото правило како за изборот на лице подолу.
     */
    const CHANGE_TYPE = 'mtb:data-changed';
    const CHANGE_SETTLE = 700;      // неколку запишувања по ред се едно освежување
    const CHANGE_RETRY = 1500;      // колку често се прашува „дали уште пишува"
    const changeChannel = (() => {
        try { return 'BroadcastChannel' in window ? new BroadcastChannel('mtb-data') : null; }
        catch (_) { return null; }
    })();
    const changeListeners = [];
    const changeHeard = new Set();
    let changeTimer = null;
    let changeWarned = false;

    /**
     * Што е промена на ЗАЕДНИЧКИТЕ податоци. Евидентниот лист и клиничките
     * записи на дневникот имаат свои екрани и никој друг не ги прикажува, а
     * најавата не е податок; нив другите прозорци не треба да ги слушаат.
     */
    function changeTopic(pathname, method) {
        if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return null;
        const parts = pathname.split('/').filter(Boolean);
        if (parts[0] !== 'api' || !parts[1]) return null;
        if (parts[1] === 'evidence') return null;
        if (parts[1] === 'diary') return parts[2] === 'schedule' ? 'schedule' : null;
        return parts[1];
    }

    function announceChange(topic) {
        const msg = { type: CHANGE_TYPE, topic };
        if (changeChannel) { try { changeChannel.postMessage(msg); } catch (_) { /* the other windows refresh on their next load */ } }
        // A frame of the workspace can be another origin, where the channel
        // does not reach; the shell passes it on to its other frames.
        if (window.parent !== window) { try { window.parent.postMessage(msg, '*'); } catch (_) { /* no shell */ } }
        window.dispatchEvent(new CustomEvent('mtb:data-announced', { detail: { topic } }));
        heardChange(topic, true);
    }

    function heardChange(topic, local) {
        const mine = (l) => { try { return Boolean(l.mine()); } catch (_) { return false; } };
        const wanted = changeListeners.filter((l) =>
            (!local || (l.sameWindow && !mine(l))) && !l.ignore.includes(topic));
        if (!wanted.length) return;
        wanted.forEach((l) => changeHeard.add(l));
        clearTimeout(changeTimer);
        changeTimer = setTimeout(runChange, CHANGE_SETTLE);
    }

    /** Somebody is typing or choosing here: a redraw now would take it away. */
    function typingHere() {
        const node = document.activeElement;
        if (!node || node === document.body) return false;
        if (node.isContentEditable || node.tagName === 'TEXTAREA' || node.tagName === 'SELECT') return true;
        if (node.tagName !== 'INPUT') return false;
        return !['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'file', 'color', 'image']
            .includes(String(node.type || 'text').toLowerCase());
    }

    async function runChange() {
        changeTimer = null;
        if (!changeHeard.size || document.hidden) return;   // visibilitychange comes back here
        const waiting = [...changeHeard];
        const busy = typingHere() || waiting.some((l) => { try { return Boolean(l.busy()); } catch (_) { return false; } });
        if (busy) {
            if (!changeWarned) {
                changeWarned = true;
                showToast('Во друг прозорец е сменето нешто. Оваа страница ќе се освежи сама штом ќе го зачувате или откажете тоа што го уредувате.', 'warning');
            }
            changeTimer = setTimeout(runChange, CHANGE_RETRY);
            return;
        }
        changeHeard.clear();
        changeWarned = false;
        for (const l of waiting) {
            try { await l.reload(); } catch (_) { /* the page reports its own failure */ }
        }
    }

    /**
     * A page that draws the shared lists registers how it re-reads them.
     *   busy       — true while it holds unsaved input; the reload waits
     *   sameWindow — also for writes made in THIS window by another part of it
     *                (the workspace shell has two editors side by side)
     *   mine       — true while that part is writing itself: it redraws from
     *                its own answer, and a second redraw would only replace
     *                „Зачувано" with „Вчитувам…"
     *   ignore     — topics that page does not show
     */
    function onDataChange(reload, options) {
        const o = options || {};
        changeListeners.push({
            reload,
            busy: typeof o.busy === 'function' ? o.busy : () => false,
            mine: typeof o.mine === 'function' ? o.mine : () => false,
            sameWindow: Boolean(o.sameWindow),
            ignore: Array.isArray(o.ignore) ? o.ignore : []
        });
    }

    if (changeChannel) {
        changeChannel.onmessage = (event) => {
            const msg = event.data;
            if (msg && msg.type === CHANGE_TYPE && typeof msg.topic === 'string') heardChange(msg.topic.slice(0, 40), false);
        };
    }
    // From the shell only, as for the focus below: a frame of another origin
    // hears the change through its parent.
    window.addEventListener('message', (event) => {
        if (event.source !== window.parent || event.source === window) return;
        const msg = event.data;
        if (msg && msg.type === CHANGE_TYPE && typeof msg.topic === 'string') heardChange(msg.topic.slice(0, 40), false);
    });
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && changeHeard.size && !changeTimer) changeTimer = setTimeout(runChange, CHANGE_SETTLE);
    });

    function currentFile() {
        return (window.location.pathname.split('/').pop() || 'start.html').toLowerCase();
    }

    function fallbackServerLabel(base) {
        if (!base) return '';
        try {
            const name = new URL(base).hostname.split('.')[0].toLowerCase();
            if (name === 'localhost' || name === '127') return 'ЛОКАЛЕН СЕРВЕР';
            return 'СЕРВЕР · ' + name;
        } catch (_) {
            return '';
        }
    }

    function defaultDataState() {
        const file = currentFile();
        try {
            if (file === 's-dnevnik.html' && localStorage.getItem('sdn_local_server_pending_v1') === '1') {
                return { state: 'pending', text: 'Локално зачувано · чека сервер' };
            }
            if (file === 'rasporedi.html' && localStorage.getItem('rasporedi_local_server_pending_v1') === '1') {
                return { state: 'pending', text: 'Локално зачувано · чека сервер' };
            }
        } catch (_) { /* storage may be unavailable */ }
        if (READ_ONLY.has(file)) return { state: 'readonly', text: 'Само читање од базата' };
        if (LOCAL_FIRST.has(file)) return { state: 'loading', text: 'Се проверува синхронизацијата…' };
        return { state: 'loading', text: 'Се вчитуваат податоците…' };
    }

    function normalizeDataState(detail) {
        const allowed = new Set(['idle', 'loading', 'saving', 'synced', 'pending', 'warning', 'error', 'readonly']);
        const source = detail && typeof detail === 'object' ? detail : {};
        return {
            state: allowed.has(source.state) ? source.state : 'idle',
            text: String(source.text || ''),
            title: String(source.title || source.text || ''),
            action: typeof source.action === 'function' ? source.action : null,
            actionLabel: String(source.actionLabel || 'Синхронизирај сега')
        };
    }

    function addStyles() {
        if (document.getElementById('mtbAppNavStyles')) return;
        const style = document.createElement('style');
        style.id = 'mtbAppNavStyles';
        style.textContent = `
            .mtb-app-nav {
                width: 100%; max-width: 100%; background: #18202c;
                border-bottom: 1px solid #303b4b; color: #f8fafc;
                font: 600 13px/1.2 system-ui, -apple-system, "Segoe UI", sans-serif;
                position: relative; z-index: 9000;
            }
            .mtb-app-nav__shell { min-height: 44px; display: flex; align-items: stretch; }
            .mtb-app-nav__links-scroll {
                min-width: 0; flex: 1 1 auto; overflow-x: auto; overflow-y: hidden;
                scrollbar-width: thin; scrollbar-color: #617084 #18202c;
            }
            .mtb-app-nav__links {
                width: max-content; min-width: 100%; min-height: 44px; padding: 5px 10px;
                display: flex; align-items: center; gap: 3px;
            }
            .mtb-app-nav a {
                min-height: 34px; padding: 0 10px; border: 1px solid transparent;
                border-radius: 6px; display: inline-flex; align-items: center;
                color: #dce4ee; text-decoration: none; white-space: nowrap;
            }
            .mtb-app-nav a:hover, .mtb-app-nav a:focus-visible {
                background: #273346; color: #fff; outline: none; border-color: #52637b;
            }
            .mtb-app-nav a[aria-current="page"] {
                background: #e7f6f1; color: #0d594a; border-color: #a5d8ca;
            }
            .mtb-app-nav__state {
                flex: 0 0 auto; min-width: auto; padding: 5px 11px;
                border-left: 1px solid #465469; display: flex; align-items: center;
                justify-content: flex-end; gap: 15px; background: #151c27;
            }
            .mtb-app-nav__status {
                min-width: 0; display: grid; grid-template-columns: 8px minmax(0, auto);
                column-gap: 7px; align-items: center; white-space: nowrap;
            }
            .mtb-app-nav__dot {
                grid-row: 1 / span 2; width: 8px; height: 8px; border-radius: 50%;
                background: #8a99a6;
            }
            .mtb-app-nav__eyebrow {
                color: #8f9bab; font-size: 9px; font-weight: 700; line-height: 1;
                text-transform: uppercase;
            }
            .mtb-app-nav__value {
                max-width: 230px; overflow: hidden; text-overflow: ellipsis;
                color: #eef3f8; font-size: 12px; line-height: 1.25;
            }
            .mtb-app-nav__status--user .mtb-app-nav__dot { background: #818cf8; }
            .mtb-app-nav__status[data-state="online"] .mtb-app-nav__dot,
            .mtb-app-nav__status[data-state="synced"] .mtb-app-nav__dot,
            .mtb-app-nav__status[data-state="readonly"] .mtb-app-nav__dot { background: #46c2a5; }
            .mtb-app-nav__status[data-state="checking"] .mtb-app-nav__dot,
            .mtb-app-nav__status[data-state="loading"] .mtb-app-nav__dot,
            .mtb-app-nav__status[data-state="saving"] .mtb-app-nav__dot { background: #7fb7f0; }
            .mtb-app-nav__status[data-state="pending"] .mtb-app-nav__dot,
            .mtb-app-nav__status[data-state="warning"] .mtb-app-nav__dot { background: #e4a34b; }
            .mtb-app-nav__status[data-state="offline"] .mtb-app-nav__dot,
            .mtb-app-nav__status[data-state="error"] .mtb-app-nav__dot { background: #f07878; }
            .mtb-app-nav__status[data-state="pending"] .mtb-app-nav__value,
            .mtb-app-nav__status[data-state="warning"] .mtb-app-nav__value { color: #ffd18a; }
            .mtb-app-nav__status[data-state="offline"] .mtb-app-nav__value,
            .mtb-app-nav__status[data-state="error"] .mtb-app-nav__value { color: #ffaaaa; }
            .mtb-app-nav__retry, .mtb-app-nav__theme {
                width: 28px; height: 28px; padding: 0; border: 1px solid #52637b;
                border-radius: 6px; background: #273346; color: #fff; cursor: pointer;
                font: 700 17px/1 system-ui, sans-serif;
            }
            .mtb-app-nav__retry:hover, .mtb-app-nav__retry:focus-visible,
            .mtb-app-nav__theme:hover, .mtb-app-nav__theme:focus-visible {
                border-color: #9fe3cf; outline: none; background: #33435b;
            }
            .mtb-app-nav__theme { flex: 0 0 auto; font-size: 14px; }
            .mtb-app-nav__editing {
                flex: 0 0 auto; height: 28px; padding: 0 9px; border: 1px solid #52637b; border-radius: 6px;
                background: #273346; color: #fff; cursor: pointer; font: 700 12px/1 system-ui, sans-serif;
                white-space: nowrap;
            }
            .mtb-app-nav__editing:hover, .mtb-app-nav__editing:focus-visible {
                border-color: #9fe3cf; outline: none; background: #33435b;
            }
            .mtb-app-nav__editing[aria-pressed="true"] { border-color: #e4a34b; background: #5a4217; color: #fff; }
            .mtb-app-nav__logout {
                padding: 3px 8px; border: 1px solid #52637b; border-radius: 4px;
                background: rgba(255,255,255,0.1); color: #e2e8f0; font-size: 11px;
                cursor: pointer; font-weight: 600; line-height: 1; margin-left: -5px;
            }
            .mtb-app-nav__logout:hover { background: rgba(255,255,255,0.22); color: #fff; }
            @media (max-width: 900px) {
                .mtb-app-nav__shell { display: block; }
                .mtb-app-nav__links { min-height: 42px; padding: 4px 7px; }
                .mtb-app-nav a { min-height: 34px; padding: 0 9px; }
                .mtb-app-nav__state {
                    width: 100%; min-width: 0; min-height: 34px; padding: 4px 9px;
                    border-left: 0; border-top: 1px solid #303b4b;
                    justify-content: flex-start; gap: 18px;
                }
                .mtb-app-nav__status { flex: 1 1 50%; }
                .mtb-app-nav__value { max-width: calc(50vw - 34px); }
            }
            .mtb-app-nav__status--pick { cursor: pointer; }
            .mtb-app-nav__status--pick:hover .mtb-app-nav__value { text-decoration: underline; }
            .mtb-app-nav__menu {
                position: fixed; z-index: 9999; min-width: 210px; max-width: 88vw;
                background: #18202c; color: #e9eef5; border: 1px solid #33414f;
                border-radius: 10px; padding: 7px; box-shadow: 0 12px 32px rgba(0,0,0,.42);
                font: 500 12px/1.35 Inter, "Segoe UI", system-ui, sans-serif;
            }
            .mtb-app-nav__menu-title {
                font-size: 10px; letter-spacing: .06em; text-transform: uppercase;
                opacity: .62; padding: 4px 8px 7px;
            }
            .mtb-app-nav__menu-row {
                display: block; width: 100%; text-align: left; border: 0; border-radius: 7px;
                background: transparent; color: inherit; font: inherit; padding: 8px 9px; cursor: pointer;
            }
            .mtb-app-nav__menu-row:hover { background: #243244; }
            .mtb-app-nav__menu-row[data-current="1"] { background: #2b3a4d; font-weight: 800; }
            a.mtb-app-nav__menu-row { box-sizing: border-box; margin-top: 6px; text-decoration: none; border-top: 1px solid #33414f; border-radius: 0 0 7px 7px; }
            .mtb-app-nav__menu-note { font-size: 10px; opacity: .55; padding: 7px 9px 3px; }
            @media print { .mtb-app-nav__menu { display: none !important; } }
            .mtb-toast {
                position: fixed; right: 18px; bottom: 18px; z-index: 9500;
                max-width: min(430px, calc(100vw - 36px));
                display: flex; align-items: flex-start; gap: 10px;
                padding: 11px 14px; border-radius: 9px;
                background: #18202c; color: #eef3f8;
                border: 1px solid #303b4b; border-left: 4px solid #46c2a5;
                box-shadow: 0 8px 26px rgba(0, 0, 0, .34);
                font: 600 13px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif;
                cursor: pointer; opacity: 0; transform: translateY(10px);
                transition: opacity .16s ease, transform .16s ease;
            }
            .mtb-toast--on { opacity: 1; transform: none; }
            .mtb-toast__mark { flex: 0 0 auto; line-height: 1.3; }
            .mtb-toast__text { min-width: 0; overflow-wrap: anywhere; }
            .mtb-toast[data-kind="warning"], .mtb-toast[data-kind="pending"] {
                border-left-color: #e4a34b; color: #ffd18a;
            }
            .mtb-toast[data-kind="error"] { border-left-color: #f07878; color: #ffc9c9; }
            @media (max-width: 620px) {
                .mtb-toast { right: 12px; left: 12px; bottom: 12px; max-width: none; }
            }
            @media (prefers-reduced-motion: reduce) {
                .mtb-toast { transition: none; transform: none; }
            }
            @media print { .mtb-toast { display: none !important; } }
            @media print { .mtb-app-nav { display: none !important; } }
        `;
        document.head.appendChild(style);
    }

    function statusNode(kind, eyebrow) {
        const item = document.createElement('div');
        item.className = 'mtb-app-nav__status mtb-app-nav__status--' + kind;
        item.dataset.state = kind === 'server' ? serverState.state : dataState.state;
        const dot = document.createElement('span');
        dot.className = 'mtb-app-nav__dot';
        dot.setAttribute('aria-hidden', 'true');
        const overline = document.createElement('span');
        overline.className = 'mtb-app-nav__eyebrow';
        overline.textContent = eyebrow;
        const value = document.createElement('span');
        value.className = 'mtb-app-nav__value';
        item.append(dot, overline, value);
        return item;
    }

    /**
     * Embedded inside `MTB-Workspace.html`, which carries its own tabs.
     *
     * Two rows of the same links, one above the other, is the thing the owner
     * called confusing — so the shell says so in the address (`?embed=1`) and
     * the bar does not draw. Everything BEHIND it stays: the health check, the
     * session, the authenticated fetch and the server choice are the same
     * module, because a second copy of any of those is what this project keeps
     * paying for. Only the strip of buttons is left out.
     */
    function embedded() {
        try { return new URLSearchParams(window.location.search).has('embed'); }
        catch (_) { return false; }
    }

    /**
     * Inside the workspace, a link to ANOTHER app opens that app's own window.
     *
     * Left alone, „Настава" in Fusion navigated the Распоред window itself to
     * Nastava.html: the Распоред tab stayed highlighted over a different page,
     * and pressing it did nothing, because the window it shows was the one that
     * had wandered off. So the click is handed to the shell, which owns the
     * windows. Only the file name travels — no pupil, no person — and only for
     * the apps the shell has tabs for; every other link, a modified click and
     * `target=_blank` behave exactly as before.
     */
    const SHELL_APPS = new Set(['rasporedifusion.html', 'nastava.html', 'nastavauredi.html',
        'podatoci.html', 'akciskiplan.html', 's-dnevnik.html', 'pregled-baza.html']);

    function appFileOf(link) {
        const href = link.getAttribute('href') || '';
        if (!href || href.startsWith('#') || /^(mailto|tel|javascript):/i.test(href)) return '';
        let url;
        try { url = new URL(href, window.location.href); } catch (_) { return ''; }
        const file = decodeURIComponent(url.pathname.split('/').pop() || '');
        return SHELL_APPS.has(file.toLowerCase()) ? file : '';
    }

    function handOverAppLinks() {
        document.addEventListener('click', (event) => {
            if (event.defaultPrevented || event.button !== 0 ||
                event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
            const link = event.target && event.target.closest && event.target.closest('a[href]');
            if (!link || (link.target && link.target !== '_self')) return;
            const file = appFileOf(link);
            if (!file || window.parent === window) return;
            event.preventDefault();
            // A file name only; the shell checks the sender is one of its own frames.
            window.parent.postMessage({ type: 'mtb:open-app', file }, '*');
        });
    }

    function mount() {
        addFocusStyles();
        if (embedded()) {
            // No bar, but the state still has to reach whoever asks for it —
            // the shell's own БАЗА chip listens for exactly this event.
            handOverAppLinks();
            checkHealth();
            checkUser();
            return;
        }
        addStyles();
        let nav = document.getElementById('mtbAppNav');
        if (!nav) {
            nav = document.createElement('nav');
            nav.id = 'mtbAppNav';
            nav.className = 'mtb-app-nav';
            nav.setAttribute('aria-label', 'MTB апликации и состојба');
            document.body.insertBefore(nav, document.body.firstChild);
        }
        render();
        checkHealth();
        checkUser();
        window.dispatchEvent(new CustomEvent('mtb:navigation-mounted'));
    }

    function closeServerMenu() {
        if (serverMenu && serverMenu.parentNode) serverMenu.parentNode.removeChild(serverMenu);
        serverMenu = null;
    }

    /**
     * Choosing the database, from any screen.
     *
     * Landing on one address and staying there is still the rule — so on a
     * server's own origin this NAVIGATES to the same page on the other
     * machine rather than quietly pointing one open tab at two databases.
     * Only the published copy, which has no server of its own, stores a
     * choice; it stores it under the key every screen already reads, so the
     * whole suite moves together.
     */
    function toggleServerMenu() {
        if (serverMenu) { closeServerMenu(); return; }
        const here = currentFile();
        const mine = activeServer();
        const menu = document.createElement('div');
        menu.className = 'mtb-app-nav__menu';
        const title = document.createElement('div');
        title.className = 'mtb-app-nav__menu-title';
        title.textContent = 'Во која база се работи';
        menu.appendChild(title);

        const list = configuredServers();
        if (!list.length) {
            const empty = document.createElement('div');
            empty.className = 'mtb-app-nav__menu-note';
            empty.textContent = 'Нема запишани адреси. Отвори „Сите“ за да ги поставиш.';
            menu.appendChild(empty);
        }
        list.forEach((base) => {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'mtb-app-nav__menu-row';
            const known = probed.find((p) => p.base === base);
            const mark = !known ? '…' : known.live ? '●' : '○';
            row.textContent = mark + ' ' + serverName(base);
            if (base === mine) row.dataset.current = '1';
            row.title = base + (known && !known.live ? ' · не одговара' : '');
            row.addEventListener('click', () => {
                closeServerMenu();
                if (base === mine) return;
                rememberServer(base);
                // A page served BY a server belongs to that server. Moving
                // database means moving address, not re-pointing this tab.
                if (!isPublished()) window.location.href = base + '/' + here;
            });
            menu.appendChild(row);
        });

        const note = document.createElement('div');
        note.className = 'mtb-app-nav__menu-note';
        note.textContent = '● одговара · ○ не одговара';
        menu.appendChild(note);

        // "Which database" and "has my work reached it / the other machine"
        // are asked together, so the page that answers the second one is
        // reachable from the chip that answers the first, on every screen.
        if (here !== 'sinhronizacija.html') {
            const sync = document.createElement('a');
            sync.className = 'mtb-app-nav__menu-row';
            sync.href = 'Sinhronizacija.html';
            sync.textContent = 'Синхронизација →';
            menu.appendChild(sync);
        }
        document.body.appendChild(menu);
        serverMenu = menu;

        const chip = document.querySelector('.mtb-app-nav__status--server');
        if (chip) {
            const box = chip.getBoundingClientRect();
            menu.style.top = (box.bottom + 6) + 'px';
            menu.style.right = Math.max(8, window.innerWidth - box.right) + 'px';
        }
        // Probe in the background; redraw the menu when the answers land.
        Promise.all(list.map(async (base) => ({ base, live: !!(await probeServer(base)) })))
            .then((results) => {
                probed = results;
                if (serverMenu === menu) { closeServerMenu(); toggleServerMenu(); }
            });
    }

    document.addEventListener('click', (event) => {
        if (!serverMenu) return;
        if (event.target.closest('.mtb-app-nav__menu, .mtb-app-nav__status--server')) return;
        closeServerMenu();
    });
    window.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeServerMenu(); });

    function render() {
        if (embedded()) return;
        const nav = document.getElementById('mtbAppNav');
        if (!nav) return;
        const base = selectedServer();
        const here = currentFile();
        const shell = document.createElement('div');
        shell.className = 'mtb-app-nav__shell';
        const scroller = document.createElement('div');
        scroller.className = 'mtb-app-nav__links-scroll';
        const links = document.createElement('div');
        links.className = 'mtb-app-nav__links';

        for (const app of APPS) {
            const link = document.createElement('a');
            link.textContent = app.label;
            link.title = app.title;
            link.href = base ? `${base}/${app.file}` : app.file;
            if (app.file.toLowerCase() === here) link.setAttribute('aria-current', 'page');
            links.appendChild(link);
        }
        scroller.appendChild(links);

        const state = document.createElement('div');
        state.className = 'mtb-app-nav__state';
        state.setAttribute('aria-live', 'polite');
        const server = statusNode('server', isPublished() ? 'ИЗБРАНА БАЗА' : 'БАЗА');
        server.querySelector('.mtb-app-nav__value').textContent = serverState.label;
        server.title = (serverState.title || serverState.label) + ' · кликни за да избереш база';
        server.classList.add('mtb-app-nav__status--pick');
        server.setAttribute('role', 'button');
        server.setAttribute('tabindex', '0');
        server.addEventListener('click', toggleServerMenu);
        server.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleServerMenu(); }
        });
        const data = statusNode('data', 'ПОДАТОЦИ');
        data.querySelector('.mtb-app-nav__value').textContent = dataState.text || 'Статусот не е познат';
        data.title = dataState.title || dataState.text;
        state.append(server, data);
        if (cloudGoogle) {
            const logout = document.createElement('button');
            logout.type = 'button';
            logout.className = here === 'mtb-workspace.html' ? 'soft compact' : 'mtb-app-nav__logout';
            logout.id = 'mtbCloudLogout';
            logout.textContent = 'Одјава од MTB';
            logout.addEventListener('click', async () => {
                if (!window.confirm('Зачувај ги отворените измени пред одјава. Продолжи со одјава?')) return;
                logout.disabled = true;
                try {
                    const response = await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
                    if (!response.ok && response.status !== 401) throw new Error();
                    try { localStorage.removeItem(TOKEN_KEY); } catch (_) { /* logout still succeeds */ }
                    window.top.location.href = '/auth/login';
                } catch (_) { logout.disabled = false; window.alert('Одјавата не успеа. Обиди се повторно.'); }
            });
            if (here === 'mtb-workspace.html') {
                document.getElementById('mtbCloudLogout')?.remove();
                document.querySelector('.topbar')?.appendChild(logout);
            } else state.appendChild(logout);
        }
        if (userState) {
            const user = statusNode('user', 'НАЈАВЕН');
            user.querySelector('.mtb-app-nav__value').textContent = userState.name;
            user.title = userState.name + (userState.kind ? ' · ' + userState.kind : '');
            user.dataset.state = 'online';
            state.append(user);

            const logout = document.createElement('button');
            logout.type = 'button';
            logout.className = 'mtb-app-nav__logout';
            logout.textContent = 'Одјава';
            logout.title = 'Одјави се од системот';
            logout.addEventListener('click', logoutUser);
            state.appendChild(logout);
        }
        if (dataState.action) {
            const retry = document.createElement('button');
            retry.type = 'button';
            retry.className = 'mtb-app-nav__retry';
            retry.textContent = '↻';
            retry.title = dataState.actionLabel;
            retry.setAttribute('aria-label', dataState.actionLabel);
            retry.addEventListener('click', () => dataState.action());
            state.appendChild(retry);
        }
        // One light/dark switch for the suite (`mtb-theme.js`). A screen that
        // already carries its own switch keeps it, and the bar does not draw
        // a second one beside it.
        if (window.MTBTheme && !document.querySelector('[data-mtb-theme-control]')) {
            const theme = document.createElement('button');
            theme.type = 'button';
            theme.className = 'mtb-app-nav__theme';
            state.appendChild(window.MTBTheme.bind(theme));
        }
        // The editing switch, only on a screen that has doors to open
        // (`mtb-forms.js`). A switch that changes nothing on this page would
        // teach people that it does nothing anywhere.
        if (window.MTBForms) {
            const editing = document.createElement('button');
            editing.className = 'mtb-app-nav__editing';
            state.appendChild(window.MTBForms.bindSwitch(editing));
        }
        shell.append(scroller, state);
        nav.replaceChildren(shell);

        const active = nav.querySelector('[aria-current="page"]');
        if (active) {
            const left = active.offsetLeft;
            const right = left + active.offsetWidth;
            if (left < scroller.scrollLeft) scroller.scrollLeft = left;
            else if (right > scroller.scrollLeft + scroller.clientWidth) {
                scroller.scrollLeft = right - scroller.clientWidth;
            }
        }
    }

    /**
     * A confirmation you can actually see.
     *
     * Every screen already says whether PostgreSQL accepted the write. It says
     * it in the strip at the top of the page — and the page scrolls. Someone
     * editing the thirtieth row presses Save and the green sentence is written
     * a screen and a half above the eyes, so the honest answer arrives and is
     * never read. This puts the same sentence in a fixed corner, where the work
     * is happening.
     *
     * Only a deliberate write reaches here: a screen opts in per action with
     * `toast: true` on the data-state detail. Loading noise stays out, because
     * a confirmation that appears for everything confirms nothing.
     */
    let toastNode = null;
    let toastTimer = null;
    let toastWaiting = null;

    function hideToast() {
        if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
        if (toastWaiting) {
            document.removeEventListener('visibilitychange', toastWaiting);
            toastWaiting = null;
        }
        if (toastNode) toastNode.classList.remove('mtb-toast--on');
    }

    function showToast(text, kind) {
        const message = String(text == null ? '' : text).trim();
        if (!message || !document.body) return;
        addStyles();
        if (!toastNode) {
            toastNode = document.createElement('div');
            toastNode.className = 'mtb-toast';
            toastNode.setAttribute('role', 'status');
            toastNode.setAttribute('aria-live', 'polite');
            toastNode.title = 'Кликни за да се затвори';
            toastNode.addEventListener('click', hideToast);
            const mark = document.createElement('span');
            mark.className = 'mtb-toast__mark';
            mark.setAttribute('aria-hidden', 'true');
            const body = document.createElement('span');
            body.className = 'mtb-toast__text';
            toastNode.append(mark, body);
            document.body.appendChild(toastNode);
        }
        const state = normalizeDataState({ state: kind, text: message }).state;
        const soft = state === 'warning' || state === 'pending';
        toastNode.dataset.kind = state;
        toastNode.querySelector('.mtb-toast__mark').textContent =
            state === 'error' ? '\u2715' : soft ? '!' : '\u2713';
        toastNode.querySelector('.mtb-toast__text').textContent = message;
        toastNode.classList.remove('mtb-toast--on');
        // Not requestAnimationFrame: a hidden tab paints no frames, so a
        // confirmation that lands while the tab is in the background would never
        // become visible and would then time out unseen — the same failure as
        // writing it off the top of the screen. Forcing layout starts the
        // transition whether or not anyone is looking.
        void toastNode.offsetWidth;
        toastNode.classList.add('mtb-toast--on');
        if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
        if (toastWaiting) {
            document.removeEventListener('visibilitychange', toastWaiting);
            toastWaiting = null;
        }
        // A refusal stays until it is read or replaced. Success may leave — but
        // its countdown runs only while the page is actually on screen.
        if (state === 'error') return;
        const linger = soft ? 5200 : 3200;
        if (!document.hidden) { toastTimer = setTimeout(hideToast, linger); return; }
        toastWaiting = () => {
            if (document.hidden) return;
            document.removeEventListener('visibilitychange', toastWaiting);
            toastWaiting = null;
            toastTimer = setTimeout(hideToast, linger);
        };
        document.addEventListener('visibilitychange', toastWaiting);
    }

    function reportDataState(detail) {
        dataState = normalizeDataState(detail);
        window.__MTB_DATA_STATE__ = dataState;
        render();
        // `normalizeDataState` drops unknown keys, so the opt-in is read from
        // the raw detail rather than from the normalised copy.
        if (detail && typeof detail === 'object' && detail.toast) showToast(dataState.text, dataState.state);
    }

    async function checkHealth() {
        const request = ++healthRequest;
        const base = activeServer();
        if (healthTimer) clearTimeout(healthTimer);
        if (!base) {
            serverState = {
                state: 'offline',
                label: 'САМО ОВОЈ ПРЕЛИСТУВАЧ',
                title: 'Не е избрана или достапна PostgreSQL база.'
            };
            if (LOCAL_FIRST.has(currentFile()) && dataState.state === 'loading') {
                reportDataState({ state: 'warning', text: 'Локална копија · не е на сервер' });
            } else render();
            return;
        }

        serverState = { state: 'checking', label: fallbackServerLabel(base) || 'Ја проверувам базата…', title: base };
        render();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT);
        try {
            const response = await fetch(base + '/api/health', { cache: 'no-store', signal: controller.signal });
            const body = response.ok ? await response.json().catch(() => null) : null;
            if (!response.ok || !body || body.ok !== true) throw new Error('health check failed');
            if (request !== healthRequest) return;
            const identity = body.server && typeof body.server === 'object' ? body.server : {};
            const mirror = body.mirror && typeof body.mirror === 'object' ? body.mirror : null;
            cloudGoogle = body.cloudAuth === 'google';
            // A user can switch servers without reloading the page. Clear a
            // previous mirror flag as deliberately as setting a new one.
            window.MTB_MIRROR_READONLY = Boolean(mirror);
            const mirrorTime = mirror && mirror.dataAt ? String(mirror.dataAt).replace('T', ' ').slice(0, 16) : '';
            const mirrorSuffix = mirror
                ? (mirror.pending ? ' · КОПИЈА БЕЗ ПОДАТОЦИ' : ' · КОПИЈА ' + mirrorTime)
                : '';
            serverState = {
                state: body.warning ? 'warning' : (mirror ? 'readonly' : 'online'),
                label: String(identity.label || fallbackServerLabel(base) || 'ПОВРЗАНА БАЗА')
                    + mirrorSuffix + (body.warning ? ' · ПРОВЕРИ' : ''),
                title: [base, body.database ? 'PostgreSQL: ' + body.database : '',
                    mirror ? 'Само читање; извор: ' + String(mirror.source || 'Supabase') : '',
                    mirror && mirror.lastAppliedAt ? 'последен sync: ' + String(mirror.lastAppliedAt) : '',
                    mirror && mirror.lastError ? 'последна грешка: ' + String(mirror.lastError) : '',
                    body.warning || ''].filter(Boolean).join(' · ')
            };
            window.dispatchEvent(new CustomEvent('mtb:server-state', { detail: {
                state: serverState.state,
                base,
                identity,
                database: body.database || '',
                instance: body.instance || '',
                warning: body.warning || '',
                mirror
            } }));
        } catch (_) {
            if (request !== healthRequest) return;
            serverState = {
                state: 'offline',
                label: (fallbackServerLabel(base) || 'БАЗАТА') + ' · НЕМА ВРСКА',
                title: 'Серверот не одговара: ' + base
            };
        } finally {
            clearTimeout(timeout);
            if (request === healthRequest) {
                render();
                healthTimer = setTimeout(checkHealth, HEALTH_INTERVAL);
            }
        }
    }

    async function checkUser() {
        let token = '';
        try { token = localStorage.getItem(TOKEN_KEY) || ''; } catch (_) {}
        if (!token) {
            if (userState !== null) {
                userState = null;
                render();
            }
            return;
        }
        const base = activeServer();
        if (!base) return;
        try {
            const response = await nativeFetch(base + '/api/evidence/me', {
                headers: { 'x-mtb-evidence-token': token },
                cache: 'no-store'
            });
            if (response.ok) {
                const body = await response.json().catch(() => null);
                userState = body && body.person
                    ? Object.assign({}, body.person, { permissions: body.permissions || {} })
                    : null;
            } else if (response.status === 401) {
                try { localStorage.removeItem(TOKEN_KEY); } catch (_) {}
                userState = null;
            }
        } catch (_) {
            // Keep existing userState if offline or network glitch
        }
        render();
    }

    async function logoutUser() {
        let token = '';
        try { token = localStorage.getItem(TOKEN_KEY) || ''; } catch (_) {}
        const base = activeServer();
        if (token && base) {
            try {
                await nativeFetch(base + '/api/evidence/logout', {
                    method: 'POST',
                    headers: { 'x-mtb-evidence-token': token },
                    cache: 'no-store'
                });
            } catch (_) {
                // Local logout must still work while the server is unavailable;
                // the short-lived server session will expire on its own.
            }
        }
        try { localStorage.removeItem(TOKEN_KEY); } catch (_) {}
        userState = null;
        render();
        window.dispatchEvent(new CustomEvent('mtb:auth-changed'));
        window.location.reload();
    }

    installAuthenticatedFetch();
    /* ── Едно избрано лице, низ сите прозорци ─────────────────────────
     *
     * Работниот простор држи список на луѓе покрај распоредот. Избирањето на
     * човек таму досега не значеше ништо за прозорецот до него — а тоа е токму
     * прашањето што се поставува: го избирам ова дете, КАДЕ Е ТОА во неделата.
     *
     * Школката праќа само ИДЕНТИФИКАТОР, никогаш име. Прозорецот и онака ги има
     * имињата; праќањето име низ `postMessage` би значело личен податок што
     * патува кон origin што испраќачот не го контролира (правило 6), а тука не
     * добива ништо.
     *
     * Секоја страница само ги ОБЕЛЕЖУВА своите елементи со `data-focus`, а
     * осветлувањето го прави ова место — една копија, па двата екрана не можат
     * да осветлат различно. Ќелија во која има повеќе луѓе носи повеќе клучеви,
     * одделени со празно место.
     */
    let focusKey = '';

    /**
     * Осветлувањето мора да постои и кога лентата НЕ се црта: вгнездена во
     * школката токму тогаш и се користи. Затоа свој блок, а не во `addStyles`.
     */
    function addFocusStyles() {
        if (document.getElementById('mtbFocusStyles')) return;
        const style = document.createElement('style');
        style.id = 'mtbFocusStyles';
        style.textContent = `
            .mtb-focused {
                outline: 2px solid #f6c453 !important;
                outline-offset: -2px;
                box-shadow: 0 0 0 3px rgba(246, 196, 83, .35) !important;
            }
            /* Останатото се повлекува наместо да се крие: она што НЕ е
               осветлено е и понатаму одговор — колку часа има тој ден, каде има
               празно — и криењето би направило распоред што лаже. */
            .mtb-has-focus [data-focus]:not(.mtb-focused) { opacity: .38; }
            @media print { .mtb-focused { outline: 1px solid #000 !important; box-shadow: none !important; }
                           .mtb-has-focus [data-focus]:not(.mtb-focused) { opacity: 1; } }
        `;
        (document.head || document.documentElement).appendChild(style);
    }

    /**
     * One element, one or several people.
     *
     * A list is written as JSON, a single key as itself. Splitting on spaces
     * was the obvious form and it is wrong: a `public_id` is only USUALLY the
     * generated `RS-…` shape, and one carrying a space split into two keys that
     * matched nothing — the highlight silently did not appear, which is the
     * hardest kind of fault to notice because nothing goes red.
     */
    function focusKeysOf(el) {
        const raw = String(el.dataset.focus || '');
        if (raw.charAt(0) !== '[') return raw ? [raw] : [];
        try {
            const list = JSON.parse(raw);
            return Array.isArray(list) ? list.map(String) : [];
        } catch (_) { return [raw]; }
    }

    /**
     * The rest fades only when the chosen person is actually ON this page.
     * A pupil with no term in the week shown matched nothing, and the whole
     * grid still went to .38 — every name grey, nothing lit, and no reason
     * visible anywhere. The owner read it as "why are these letters grey".
     */
    function applyFocus() {
        let matched = 0;
        document.querySelectorAll('[data-focus]').forEach((el) => {
            const on = !!focusKey && focusKeysOf(el).includes(focusKey);
            el.classList.toggle('mtb-focused', on);
            if (on) matched += 1;
        });
        document.documentElement.classList.toggle('mtb-has-focus', matched > 0);
    }

    function setFocus(key) {
        focusKey = String(key || '');
        applyFocus();
        window.dispatchEvent(new CustomEvent('mtb:focus', { detail: { key: focusKey } }));
    }

    window.addEventListener('message', (event) => {
        // Само од школката што ја вгнездила оваа страница, и само облик што
        // ништо не менува: ова е приказ, не команда.
        if (event.source !== window.parent || event.source === window) return;
        const msg = event.data;
        if (!msg || msg.type !== 'mtb:focus') return;
        setFocus(typeof msg.key === 'string' ? msg.key.slice(0, 120) : '');
    });

    /* ── Предметите на еден наставник ───────────────────────────────────────
     *
     * Еден наставник предава ПОВЕЌЕ предмети — кажано од сопственикот и
     * видливо во работната книга. Дотогаш „Предмет" беше едно поле за пишување
     * во три екрана, па списокот немаше како да се внесе, а каталогот на МОН
     * (`teaching_subjects`, миграција 032) се нудеше само во ќелиите на
     * распоредот.
     *
     * ЕДНА КОЛОНА, СПИСОК ВО НЕА. `teachers.subject` останува слободен текст, а
     * повеќе предмети се пишуваат разделени со запирка. Втора табела би барала
     * миграција, увозот од работната книга и трите екрана да се преместат
     * ОДЕДНАШ, а овој проект веќе измери колку чини таква селидба. Она што го
     * чита како ФАКТ е точно една функција — `teacherHandles` во
     * `lib/teaching-demo.ts` — и таа сега го дели списокот; сѐ друго само го
     * печати. Кога предметот ќе почне да носи СВОЈ факт (фонд часови, наставен
     * план, во која паралелка), тој ден е денот за табела, не порано.
     *
     * Проверено пред да се одбере разделувачот: ниту еден од 39-те предмети во
     * каталогот не содржи запирка, па делењето не може да пресече име.
     *
     * И ЕДНА КОПИЈА, ТУКА. Истиот избирач стои во НаставаУреди, во Податоци и
     * во работниот простор. Три копии би се разишле за еден разделувач или за
     * едно зборче, што е грешката за која овој проект постојано плаќа — истата
     * причина поради која изборот на сервер живее во оваа датотека.
     */
    const SUBJECT_CATALOGUES = new Map();

    /** „Физичко, Ликовно" → ['Физичко', 'Ликовно']. Празно и повторено паѓа. */
    function parseSubjects(value) {
        const out = [];
        String(value == null ? '' : value).split(',').forEach((part) => {
            const name = part.trim();
            if (name && !out.some((had) => had.toLowerCase() === name.toLowerCase())) out.push(name);
        });
        return out;
    }

    function joinSubjects(list) {
        return (list || []).join(', ');
    }

    /**
     * Каталогот на МОН, целиот. Без `?class=` endpoint-от враќа сѐ — што е
     * точно за наставник, зашто наставник не припаѓа на едно одделение.
     * Кеширано по (сервер, година): список од четириесет не се бара по ред.
     */
    function subjectCatalogue(year) {
        const base = activeServer();
        const key = base + '|' + String(year || '');
        if (!SUBJECT_CATALOGUES.has(key)) {
            const url = base + '/api/teaching/subjects'
                + (year ? '?year=' + encodeURIComponent(year) : '');
            SUBJECT_CATALOGUES.set(key, window.fetch(url, { headers: { accept: 'application/json' } })
                .then((res) => (res.ok ? res.json() : { subjects: [] }))
                .then((body) => (body.subjects || []).map((row) => row.subject).filter(Boolean))
                // Постар сервер без овој endpoint едноставно не нуди ништо;
                // „друго…" и понатаму прима што ќе се напише, па ништо не се
                // губи — понуда што ја нема не е ѕид.
                .catch(() => []));
        }
        return SUBJECT_CATALOGUES.get(key);
    }

    function addSubjectStyles() {
        if (document.getElementById('mtbSubjectStyles')) return;
        const style = document.createElement('style');
        style.id = 'mtbSubjectStyles';
        style.textContent = `
            .mtb-subjects { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
            .mtb-subjects .mtb-subj {
                display: inline-flex; align-items: center; gap: 3px;
                padding: 1px 4px 1px 8px; border-radius: 10px; font-size: 12px;
                /* Името на предметот не се крши на два реда: се крши РЕДОТ од
                   чипови, инаку „Македонски јазик" изгледа како два предмети. */
                white-space: nowrap;
                background: var(--chip, var(--soft, var(--panel2, rgba(125, 125, 160, .20))));
                border: 1px solid var(--border, var(--line, rgba(125, 125, 160, .45)));
                /* ИЗРЕЧНО, и тоа е правило од скапо искуство: копче НЕ наследува
                   боја на текст — прелистувачот му дава buttontext, што е црно
                   и во темна тема се губи. Чипот ја кажува својата, а ✕ во него
                   изречно ја наследува. */
                color: var(--text, inherit);
            }
            .mtb-subjects .mtb-subj button {
                border: 0; background: transparent; color: inherit; cursor: pointer;
                font-size: 12px; line-height: 1; padding: 2px 3px; opacity: .8;
            }
            .mtb-subjects .mtb-subj button:hover { opacity: 1; }
            .mtb-subjects select, .mtb-subjects .mtb-subj-free {
                font-size: 12px; padding: 2px 4px; max-width: 170px; min-width: 90px;
            }
            .mtb-subjects .mtb-none { opacity: .85; font-size: 12px; }
            .mtb-subjects.is-locked .mtb-subj { opacity: .75; }
        `;
        (document.head || document.documentElement).appendChild(style);
    }

    /**
     * Го исполнува `host` со чипови и едно „+ предмет…" мени, и го држи
     * зачуваниот СТРИНГ во скриено поле внатре.
     *
     * Скриеното поле е намерно: секој од трите екрана веќе чита
     * `row.querySelector('.t-subject').value` кога зачувува, па патот на
     * зачувување НЕ се менува воопшто — се менува само како човек го внесува.
     * Затоа се праќаат и `input` и `change`, зашто по нив страницата знае дека
     * редот има непратена измена.
     *
     * Заклучено (одделенски наставник) значи: се ПОКАЖУВА зачуваното и не се
     * менува. Празнењето на екранот беше тивко бришење — истата стапица што
     * веќе беше затворена во работниот простор.
     */
    function mountSubjectPicker(host, options) {
        if (!host) return null;
        const opts = options || {};
        addSubjectStyles();

        let chosen = parseSubjects(opts.value);
        let catalogue = null;

        const field = document.createElement('input');
        field.type = 'hidden';
        if (opts.id) field.id = opts.id;
        if (opts.className) field.className = opts.className;
        field.value = joinSubjects(chosen);

        host.classList.add('mtb-subjects');
        host.classList.toggle('is-locked', !!opts.disabled);

        function commit() {
            const was = field.value;
            field.value = joinSubjects(chosen);
            if (field.value === was) return;
            field.dispatchEvent(new Event('input', { bubbles: true }));
            field.dispatchEvent(new Event('change', { bubbles: true }));
        }

        function add(name) {
            const clean = String(name || '').trim();
            if (!clean) return;
            if (chosen.some((had) => had.toLowerCase() === clean.toLowerCase())) return;
            chosen = chosen.concat(clean);
            commit();
        }

        function draw() {
            host.textContent = '';
            host.appendChild(field);

            chosen.forEach((name) => {
                const chip = document.createElement('span');
                chip.className = 'mtb-subj';
                chip.appendChild(document.createTextNode(name));
                if (!opts.disabled) {
                    const off = document.createElement('button');
                    off.type = 'button';
                    off.textContent = '✕';
                    off.title = 'тргни го предметот';
                    off.addEventListener('click', () => {
                        chosen = chosen.filter((had) => had !== name);
                        commit();
                        draw();
                    });
                    chip.appendChild(off);
                }
                host.appendChild(chip);
            });

            if (opts.disabled) {
                if (!chosen.length) {
                    const none = document.createElement('span');
                    none.className = 'mtb-none';
                    none.textContent = opts.lockedNote || 'нема';
                    host.appendChild(none);
                }
                return;
            }

            const pick = document.createElement('select');
            pick.className = 'mtb-subj-add';
            pick.title = 'Понуда од каталогот на МОН. Кратенка како „ФЗО." се пишува преку „друго…" и останува како што е напишана.';
            const first = document.createElement('option');
            first.value = '';
            first.textContent = chosen.length ? '+ уште еден…' : '+ предмет…';
            pick.appendChild(first);
            (catalogue || []).forEach((name) => {
                if (chosen.some((had) => had.toLowerCase() === name.toLowerCase())) return;
                const option = document.createElement('option');
                option.value = name;
                option.textContent = name;
                pick.appendChild(option);
            });
            const other = document.createElement('option');
            other.value = '';
            other.dataset.other = '1';
            other.textContent = '✎ друго…';
            pick.appendChild(other);

            pick.addEventListener('change', () => {
                const option = pick.selectedOptions[0];
                const value = pick.value;
                const wantsFree = !!(option && option.dataset.other);
                pick.selectedIndex = 0;
                if (!wantsFree) {
                    if (!value) return;
                    add(value);
                    draw();
                    return;
                }
                // Слободен текст, зашто каталогот е ПОНУДА: работната книга
                // пишува „ФЗО." и еден избор од мени не смее да го замени.
                const free = document.createElement('input');
                free.type = 'text';
                free.className = 'mtb-subj-free';
                free.placeholder = 'напиши предмет';
                const finish = (keep) => {
                    if (keep) add(free.value);
                    draw();
                };
                free.addEventListener('keydown', (event) => {
                    if (event.key === 'Enter') { event.preventDefault(); finish(true); }
                    if (event.key === 'Escape') { event.preventDefault(); finish(false); }
                });
                free.addEventListener('blur', () => finish(true));
                pick.replaceWith(free);
                free.focus();
            });
            host.appendChild(pick);
        }

        draw();
        if (!opts.disabled) {
            subjectCatalogue(opts.year).then((list) => {
                catalogue = list;
                // Нацртај пак само ако избирачот сѐ уште стои во страницата:
                // редот може да е прецртан во меѓувреме.
                if (host.isConnected && list.length) draw();
            });
        }
        return { value: () => field.value, subjects: () => chosen.slice() };
    }

    /**
     * ▲▼ that repeat while held (owner, 24 Sep 2026): one press is one step,
     * and a held button steps again every 300 ms until it is let go.
     *
     * `step(info)` moves ON SCREEN only and answers false when there is
     * nowhere further to go; `done(info)` runs ONCE, after the last step, so a
     * row held for six places is one save rather than six reloads racing each
     * other. `info` is the button's dataset as it was when pressed — the page
     * redraws under the pointer after every step, and the next step must still
     * move the same row, not whichever button now sits under the mouse.
     *
     * Enter and Space on a focused arrow are one step and one save, so the
     * arrows stay usable without a mouse. Installed once per root: a page that
     * redraws its lists must not stack a listener per redraw.
     */
    /* ── Паралелката, онака како што ја кажува училиштето ───────────────
     *
     * Сопственикот, 25 септември: во училиштето паралелката се препознава по
     * НАСТАВНИКОТ и по зборовите од нивната табела — „Комбинирана II, III, IV“,
     * „ученици со аутизам“ — а не по ознаката што ја изведовме од распоредот.
     * „Каде учи тоа дете? — Кај наставничката.“ И му требаат сите врски: понекогаш
     * наставникот, понекогаш одделението, понекогаш децата.
     *
     * Затоа секое паѓачко мени за паралелка ја пишува истата реченица:
     * ознака · раководител · описот за годинава (`class_years.description`,
     * колоната „Одделение“ од табелата). На лебдење се гледа целиот ред:
     * наставник, одделение, колку деца, од кои генерации и кои се.
     * Ознаката останува вредноста што се зачувува и по која се поврзува
     * распоредот; ова е само како се чита. ЕДНА копија, за паралелката да
     * изгледа исто каде и да се бира — истата причина како за предметите.
     */
    const CLASS_ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX'];
    const oneLine = (value) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    const escAttr = (value) => String(value == null ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    /** A name written in capitals reads as a name, as on every screen. */
    function properName(value) {
        const clean = oneLine(value);
        const letters = clean.replace(/[^\p{L}]/gu, '');
        if (!letters || letters !== letters.toLocaleUpperCase('mk-MK')) return clean;
        return clean.toLocaleLowerCase('mk-MK').replace(/(^|[\s\-‐‑–—'’])(\p{L})/gu,
            (_, before, letter) => before + letter.toLocaleUpperCase('mk-MK'));
    }

    /**
     * label → { label, description, homeroom, pupils }, out of whichever list
     * the page already holds: `/api/roster` (classes, teachers, students),
     * `/api/workspace` (classes, pupils) or the timetable (classes, teachers).
     * A pupil who is not on this year's list is not counted.
     */
    function classIndex(source) {
        const s = source || {};
        const index = new Map();
        const people = s.students || s.pupils;
        (s.classes || []).forEach((c) => {
            if (!c || !c.label) return;
            index.set(c.label, {
                label: c.label,
                description: oneLine(c.description),
                homeroom: properName(c.homeroom),
                pupils: [],
                pupilsKnown: Array.isArray(people)
            });
        });
        (s.teachers || []).forEach((t) => (t.classes || []).forEach((x) => {
            const info = index.get(x && x.label);
            if (info && x.role === 'homeroom' && !info.homeroom) info.homeroom = properName(t.name);
        }));
        (people || []).forEach((p) => {
            const info = p && index.get(p.grade);
            if (!info || p.annual_active === false) return;
            info.pupils.push({ name: properName(p.name), oddelenie: oneLine(p.oddelenie).toUpperCase() });
        });
        index.forEach((info) => info.pupils.sort((a, b) => a.name.localeCompare(b.name, 'mk')));
        return index;
    }

    /** „II-б · Ана Измислена · Комбинирана II, III, IV" — the line in a picker. */
    function classText(info) {
        return info ? [info.label, info.homeroom, info.description].filter(Boolean).join(' · ') : '';
    }

    /** The whole row of the school's table, for hovering over a class. */
    function classHover(info) {
        if (!info) return '';
        const lines = [
            info.label + (info.description ? ' — ' + info.description : ''),
            'Раководител: ' + (info.homeroom || 'не е одреден')
        ];
        if (info.pupilsKnown) {
            const count = new Map();
            info.pupils.forEach((p) => { if (p.oddelenie) count.set(p.oddelenie, (count.get(p.oddelenie) || 0) + 1); });
            const gens = CLASS_ROMAN.filter((g) => count.has(g)).map((g) => `${g} (${count.get(g)})`).join(', ');
            const n = info.pupils.length;
            lines.push(n ? `${n} ${n === 1 ? 'ученик' : 'ученици'}${gens ? ' · одд. ' + gens : ''}` : 'Нема ученици на листата');
            info.pupils.forEach((p) => lines.push('• ' + p.name + (p.oddelenie ? ' — ' + p.oddelenie : '')));
        }
        return lines.join('\n');
    }

    /**
     * The <option>s of a class picker, as HTML; the value stays the label.
     *   empty — the first, empty choice's text, or false for none
     *   extra — [[value, text], …] right after it (a filter's „Без паралелка")
     *   more  — [[value, text], …] after the classes (last year's, in a suggestion)
     * A chosen label that is not on the year's list stays, marked „неактивна",
     * rather than reading as no class at all. Mark the <select> with
     * `data-class-picker` and its closed face hovers the same as its line.
     */
    function classOptionsHtml(index, selected, options) {
        const o = options || {};
        const want = selected == null ? '' : String(selected);
        const opt = (value, text, title) => `<option value="${escAttr(value)}"${value === want ? ' selected' : ''}`
            + `${title ? ` title="${escAttr(title)}"` : ''}>${escAttr(text)}</option>`;
        const offered = new Set();
        let html = '';
        if (o.empty !== false) { html += opt('', o.empty || '— без паралелка —'); offered.add(''); }
        (o.extra || []).forEach(([value, text]) => { html += opt(value, text); offered.add(value); });
        (index || new Map()).forEach((info) => {
            if (offered.has(info.label)) return;
            html += opt(info.label, classText(info), classHover(info));
            offered.add(info.label);
        });
        (o.more || []).forEach(([value, text]) => {
            if (offered.has(value)) return;
            html += opt(value, text);
            offered.add(value);
        });
        if (want && !offered.has(want)) html += opt(want, want + ' · неактивна', 'Оваа паралелка не е на листата за годинава.');
        return html;
    }

    // A closed class picker says on hover what its chosen line says in the list.
    ['mouseover', 'focusin', 'change'].forEach((type) => document.addEventListener(type, (event) => {
        const select = event.target && event.target.closest ? event.target.closest('select[data-class-picker]') : null;
        if (!select) return;
        const chosen = select.options[select.selectedIndex];
        select.title = chosen && chosen.title ? chosen.title : '';
    }, true));

    const holdRoots = new WeakSet();
    function holdRepeat(root, selector, handlers) {
        if (!root || holdRoots.has(root)) return;
        holdRoots.add(root);
        const every = handlers.interval || 300;
        let timer = null;
        let held = null;
        const stop = () => {
            if (!held) return;
            clearInterval(timer);
            timer = null;
            const info = held;
            held = null;
            handlers.done(info);
        };
        root.addEventListener('pointerdown', (event) => {
            const button = event.target.closest && event.target.closest(selector);
            if (!button || button.disabled || event.button !== 0 || held) return;
            event.preventDefault();
            held = Object.assign({}, button.dataset);
            if (handlers.step(held) === false) { held = null; return; }
            timer = setInterval(() => { if (held && handlers.step(held) === false) stop(); }, every);
        });
        ['pointerup', 'pointercancel', 'blur'].forEach((name) => window.addEventListener(name, stop));
        // Enter, Space and a screen reader all arrive as a click with
        // `detail` 0: one step and one save. A mouse or touch click (detail
        // ≥ 1) was already handled by its pointerdown above and is ignored.
        root.addEventListener('click', (event) => {
            if (event.detail !== 0) return;
            const button = event.target.closest && event.target.closest(selector);
            if (!button || button.disabled) return;
            const info = Object.assign({}, button.dataset);
            if (handlers.step(info) !== false) handlers.done(info);
        });
    }

    window.MTBAppNavigation = {
        refresh: render, checkHealth, checkUser, logout: logoutUser,
        reportDataState, toast: showToast, hideToast,
        /**
         * Where this page's API calls should go.
         *
         * Served BY a local server it is that origin, which is what the
         * teaching pages relied on with a bare relative path. Opened from
         * GitHub Pages it is the SELECTED server — one choice, shared by every
         * screen through one key, so no two screens can be looking at
         * different databases at the same time.
         */
        apiBase: activeServer,
        servers: configuredServers,
        selectServer: rememberServer,
        // The scan itself, and the short name a person recognises. The bar uses
        // both already; the workspace shell hides the bar and still has to be
        // able to ask „кој компјутер е вклучен", which is the one question a
        // two-machine system may never answer by guessing.
        probe: probeServer,
        serverName,
        // Re-run after a redraw: a fresh grid has new elements, and nothing
        // else knows that the page has just rebuilt itself.
        applyFocus,
        setFocus,
        focusKey: () => focusKey,
        // Предметите на еден наставник: ЕДНА копија на разделувачот, на
        // каталогот и на избирачот, за трите екрана што го внесуваат.
        subjects: {
            parse: parseSubjects,
            join: joinSubjects,
            catalogue: subjectCatalogue,
            mount: mountSubjectPicker
        },
        holdRepeat,
        // Паралелката онака како што ја кажува училиштето: ознака · раководител
        // · опис, и целиот ред на лебдење. Една копија за секој избирач.
        classes: { index: classIndex, text: classText, hover: classHover, optionsHtml: classOptionsHtml },
        // Една промена, сите прозорци: страницата кажува како се препрочитува,
        // а школката на работниот простор ги пренесува промените од рамките.
        onDataChange,
        dataChanged: (topic) => heardChange(String(topic || '').slice(0, 40), false)
    };
    window.addEventListener('mtb:data-state', (event) => reportDataState(event.detail));
    window.addEventListener('mtb:server-selected', () => { render(); checkHealth(); checkUser(); });
    window.addEventListener('mtb:auth-changed', () => checkUser());
    window.addEventListener('online', () => { checkHealth(); checkUser(); });
    window.addEventListener('storage', (event) => {
        if (event.key === SELECTED_SERVER_KEY) { render(); checkHealth(); checkUser(); }
        if (event.key === TOKEN_KEY) { checkUser(); }
    });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') { checkHealth(); checkUser(); }
    });

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
    else mount();
})();

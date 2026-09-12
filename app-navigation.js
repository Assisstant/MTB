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
        { file: 'RasporediFusion.html', label: 'Распоред', title: 'Распоред на терапевтски кабинети' },
        { file: 'Nastava.html', label: 'Настава', title: 'Настава и терапии — кој е отсутен од кој час' },
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
    const READ_ONLY = new Set(['nastava.html', 'pregled-baza.html']);

    let healthTimer = null;
    let healthRequest = 0;
    let serverState = { state: 'checking', label: 'Ја проверувам базата…', title: '' };
    let dataState = normalizeDataState(window.__MTB_DATA_STATE__ || defaultDataState());
    let userState = null;
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
            let token = '';
            try { token = localStorage.getItem(TOKEN_KEY) || ''; } catch (_) {}
            if (!token) return nativeFetch(input, init);

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

            const sourceHeaders = init && init.headers
                ? init.headers
                : (typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined);
            const headers = new Headers(sourceHeaders || {});
            if (!headers.has('x-mtb-evidence-token')) headers.set('x-mtb-evidence-token', token);
            if (typeof Request !== 'undefined' && input instanceof Request) {
                return nativeFetch(new Request(input, Object.assign({}, init || {}, { headers })));
            }
            return nativeFetch(input, Object.assign({}, init || {}, { headers }));
        };
    }

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
            .mtb-app-nav__retry {
                width: 28px; height: 28px; padding: 0; border: 1px solid #52637b;
                border-radius: 6px; background: #273346; color: #fff; cursor: pointer;
                font: 700 17px/1 system-ui, sans-serif;
            }
            .mtb-app-nav__retry:hover, .mtb-app-nav__retry:focus-visible {
                border-color: #9fe3cf; outline: none; background: #33435b;
            }
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

    function mount() {
        addFocusStyles();
        if (embedded()) {
            // No bar, but the state still has to reach whoever asks for it —
            // the shell's own БАЗА chip listens for exactly this event.
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
            serverState = {
                state: body.warning ? 'warning' : 'online',
                label: String(identity.label || fallbackServerLabel(base) || 'ПОВРЗАНА БАЗА')
                    + (body.warning ? ' · ПРОВЕРИ' : ''),
                title: [base, body.database ? 'PostgreSQL: ' + body.database : '', body.warning || ''].filter(Boolean).join(' · ')
            };
            window.dispatchEvent(new CustomEvent('mtb:server-state', { detail: {
                state: serverState.state,
                base,
                identity,
                database: body.database || '',
                instance: body.instance || '',
                warning: body.warning || ''
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

    function applyFocus() {
        const root = document.documentElement;
        root.classList.toggle('mtb-has-focus', !!focusKey);
        document.querySelectorAll('[data-focus]').forEach((el) => {
            el.classList.toggle('mtb-focused', !!focusKey && focusKeysOf(el).includes(focusKey));
        });
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
        focusKey: () => focusKey
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

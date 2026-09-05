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
        { file: 'Nastava.html', label: 'Настава', title: 'Настава и терапии' },
        { file: 'Podatoci.html', label: 'Податоци', title: 'Поставување на учебната година и списоците' },
        { file: 'AkciskiPlan.html', label: 'Евидентен лист', title: 'Евидентен лист и акциски план — следење на развојот, и кварталниот план по категории' }
    ];
    const PUBLISHED_HOST = 'assisstant.github.io';
    const SELECTED_SERVER_KEY = 'mtb_podatoci_server_v1';
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

    function mount() {
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

    function render() {
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
        server.title = serverState.title || serverState.label;
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

    function reportDataState(detail) {
        dataState = normalizeDataState(detail);
        window.__MTB_DATA_STATE__ = dataState;
        render();
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
    window.MTBAppNavigation = { refresh: render, checkHealth, checkUser, logout: logoutUser, reportDataState };
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

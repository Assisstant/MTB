/**
 * One light/dark choice for the whole MTB suite.
 *
 * Loaded in <head>, before the page paints, so a screen never flashes the
 * other theme first. It only sets `<html data-theme="light|dark">`; each page
 * owns its colours. Pages styled with CSS variables read that attribute
 * directly. The two older-styled apps (S-Dnevnik, Fusion: `body.dark-mode`)
 * and AkciskiPlan (`body.dark`) listen for the `mtb:theme` event instead.
 *
 * THE KEY IS `theme`, because that is what S-Dnevnik has always written and
 * Fusion already shares. A therapist's existing choice therefore carries over
 * to every screen instead of being asked for again. The stored values stay
 * `dark-mode` / `light-mode` so an older copy of S-Dnevnik reads them too.
 *
 * NOTHING IS STORED UNTIL SOMEBODY CHOOSES. With no choice the suite follows
 * the operating system, and pages that promise to keep nothing in the browser
 * (Nastava, NastavaUredi, Podatoci) still keep nothing. A theme is a viewer's
 * convenience, like the chosen server — never data.
 *
 * EMBEDDED SCREENS FOLLOW THE SHELL. MTB-Workspace loads its windows from the
 * selected server, which from GitHub Pages is another origin with its own
 * storage. So the shell also sends `{ type: 'mtb:theme' }` to its frames; a
 * frame applies it without storing it, exactly like the focus message.
 */
(function () {
    'use strict';

    const KEY = 'theme';
    const media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    const buttons = new Set();
    let pushed = '';
    let last = '';

    function normalize(value) {
        const v = String(value || '').toLowerCase();
        if (v === 'dark' || v === 'dark-mode' || v === '1' || v === 'true') return 'dark';
        if (v === 'light' || v === 'light-mode' || v === '0' || v === 'false') return 'light';
        return '';
    }

    function stored() {
        try { return normalize(localStorage.getItem(KEY)); } catch (_) { return ''; }
    }

    /** The explicit choice, if anybody made one; '' means "follow the system". */
    function choice() { return pushed || stored(); }

    function current() { return choice() || (media && media.matches ? 'dark' : 'light'); }

    function apply() {
        const theme = current();
        document.documentElement.dataset.theme = theme;
        if (theme === last) return;
        last = theme;
        buttons.forEach(paint);
        window.dispatchEvent(new CustomEvent('mtb:theme', { detail: { theme } }));
    }

    function set(theme) {
        const next = normalize(theme);
        if (!next) return;
        pushed = '';
        try { localStorage.setItem(KEY, next === 'dark' ? 'dark-mode' : 'light-mode'); }
        catch (_) { pushed = next; /* storage blocked: the choice still holds for this tab */ }
        apply();
    }

    function toggle() { set(current() === 'dark' ? 'light' : 'dark'); }

    /**
     * The icon shows where a click LEADS, the way a light switch does, and the
     * title says it in words.
     */
    function paint(button) {
        const dark = current() === 'dark';
        button.textContent = dark ? '☀️' : '🌙';
        button.title = dark ? 'Светла тема' : 'Темна тема';
        button.setAttribute('aria-label', button.title);
    }

    /**
     * Makes a button the theme switch and keeps it in step. The shared bar is
     * redrawn every few seconds, so buttons that have left the page are
     * forgotten here rather than piling up one listener per redraw.
     */
    function bind(button) {
        if (!button || buttons.has(button)) return button;
        buttons.forEach((b) => { if (!b.isConnected) buttons.delete(b); });
        buttons.add(button);
        paint(button);
        button.addEventListener('click', toggle);
        return button;
    }

    // Another tab, or a same-origin frame, changed the choice.
    window.addEventListener('storage', (event) => {
        if (event.key === KEY || event.key === null) apply();
    });
    // No choice made: the system setting is the answer, including when it
    // changes at sunset.
    if (media) {
        const follow = () => apply();
        if (media.addEventListener) media.addEventListener('change', follow);
        else if (media.addListener) media.addListener(follow);
    }
    // Only from the shell that embedded this page, and only a shape that
    // changes how it looks.
    window.addEventListener('message', (event) => {
        if (event.source !== window.parent || event.source === window) return;
        const msg = event.data;
        if (!msg || msg.type !== 'mtb:theme') return;
        const next = normalize(msg.theme);
        if (!next) return;
        pushed = next;
        apply();
    });

    window.MTBTheme = { KEY, get: current, choice, set, toggle, bind };
    apply();
})();

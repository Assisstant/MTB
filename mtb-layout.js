/*
 * One behaviour for every tab strip, table head and section (owner, 27 Sep 2026).
 *
 * „Секоја страница се однесува различно" — a strip wrapped onto two rows on
 * one page and slid sideways on the next; one list kept its header row on
 * screen and the one beside it did not; one page folded its sections and the
 * others could not. The owner asked for the editor's „sticky scroll": on every
 * tab strip a checkbox that keeps it at the top, on every table's header row
 * a pin that keeps the row on screen, and a fold on every section.
 *
 * ONE COPY, LOADED BY `app-navigation.js`, so no page has to remember to ask
 * for it — a rule every new screen must remember is how the pages drifted
 * apart in the first place. The Workspace shell is skipped; its windows are
 * pages of their own and each loads this for itself.
 *
 *   strips    `.mtb-tabs`, `.view-tabs`, `.tabs` of `.tab`, Fusion's day band:
 *             one row that slides sideways, never a second row, and
 *             „📌 Замрзни" at its right end.
 *   tables    a table with a <thead> and at least three rows gets 📌 and ▾ in
 *             the first header cell. A header the page already keeps on screen
 *             itself (a list in its own scrolling box, CSS `sticky`) starts
 *             pinned and can be unpinned; any other is pinned by a copy of its
 *             header row that rides at the top while the table passes under.
 *             ▾ folds the rows away and leaves the header.
 *   sections  a `.panel`/`.card` whose first child is its heading gets ▾.
 *             Преглед на базата folds its own (`data-fold`) and is left alone.
 *
 * The glyphs are drawn by CSS (::before), so no header's textContent changes:
 * pages and tests that read a header's words keep reading the same words.
 *
 * What is remembered is LAYOUT only — pinned or not, folded or not — in this
 * browser, under one key, written only when the person clicks. No school data
 * goes near it, and a browser that stores nothing still works, for the visit.
 */
(function () {
    'use strict';
    if (window.MTBLayout) return;
    const file = decodeURIComponent(window.location.pathname.split('/').pop() || '').toLowerCase();
    // ONE look for every tab, in both themes (owner, 27 Sep 2026: „овие се
    // црни, овие се сиви"). Кабинети and S-Dnevnik turned their tabs black on
    // a grey band in the dark theme while every other strip, and the
    // Workspace's own row, stayed grey on the dark band. The strip is the same
    // band in both themes, so the tabs need no dark variant. The
    // colours are `!important` on purpose: this is their one owner, and a
    // page's own dark rule („body.dark-mode .x > .btn") must not win again.
    // A PAGE's band is the owner's blue scale (7 Oct 2026): the band #1DA3E2,
    // a tab #082E3F under light words (10:1), the chosen one #46B4E7. White on
    // #46B4E7 is under 3:1, so the chosen tab's words are the scale's darkest
    // (8:1).
    // The WORKSPACE's own row (`.app-tabs`: Кабинети, Настава ↔ терапии …)
    // stays the dark band with the indigo chosen tab — the owner, the same
    // day: „this stays same … the bars differ, that was the initial idea".
    // Two rows of tabs one under the other must not read as one.
    // `.mtb-tabs-flat` is a page's own row of plain tab buttons (mtb-look.css,
    // owner 1 Oct 2026): it keeps the one row and the 📌, not the band.
    const STRIP = '.mtb-tabs:not(.mtb-tabs-flat), .view-tabs:not(.mtb-tabs-flat), .tabs:has(> .tab):not(.mtb-tabs-flat), .day-tabs-band:not(.mtb-tabs-flat)';
    const TAB = '.mtb-tabs:not(.mtb-tabs-flat) > .btn, .view-tabs:not(.mtb-tabs-flat) > .view-tab, .tabs:not(.mtb-tabs-flat) > .tab, .day-tabs-band:not(.mtb-tabs-flat) .day-tab';
    const SHELL = '.app-tabs';
    const SHELL_TAB = '.app-tabs > button';
    const ON = '.active, [aria-pressed="true"], [aria-selected="true"]';
    function addTabLook() {
        if (document.getElementById('mtbTabLook')) return;
        const style = document.createElement('style');
        style.id = 'mtbTabLook';
        style.textContent = `
            html body :is(${STRIP}) { background: #1DA3E2 !important; border-bottom-color: #1886B9 !important; }
            html body .day-tabs-band:not(.mtb-tabs-flat) .band__inner { background: transparent !important; }
            html body :is(${TAB}) {
                background: #082E3F !important; color: #C0E5F7 !important; border-top-color: #136990 !important;
            }
            html body :is(${TAB}):hover { background: #0D4B68 !important; color: #E8F6FC !important; }
            html body :is(${TAB}):is(${ON}), html body :is(${TAB}):is(${ON}):hover {
                background: #46B4E7 !important; color: #031017 !important; border-top-color: #E8F6FC !important; box-shadow: none !important;
            }
            html body ${SHELL} { background: linear-gradient(to bottom, #1a1a2e 0%, #16213e 100%) !important; border-bottom-color: #0f3460 !important; }
            html body ${SHELL_TAB} {
                background: linear-gradient(to bottom, #2d3748 0%, #1a202c 100%) !important; color: #a0aec0 !important; border-top-color: #4a5568 !important;
            }
            html body ${SHELL_TAB}:hover { background: linear-gradient(to bottom, #4a5568 0%, #2d3748 100%) !important; color: #e2e8f0 !important; }
            html body ${SHELL_TAB}:is(${ON}), html body ${SHELL_TAB}:is(${ON}):hover {
                background: linear-gradient(to bottom, #667eea 0%, #5568d3 100%) !important; color: #ffffff !important; border-top-color: #818cf8 !important;
            }
        `;
        document.head.appendChild(style);
    }
    // The shell arranges windows; each window is a page and loads this itself.
    // The shell takes the look of its own row of tabs, nothing else.
    if (file === 'mtb-workspace.html') {
        window.MTBLayout = { refresh() {} };
        if (document.head) addTabLook(); else document.addEventListener('DOMContentLoaded', addTabLook);
        return;
    }

    const KEY = 'mtb_layout_v1';
    let prefs = {};
    try { prefs = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (_) { prefs = {}; }
    const prefKey = (kind, sig) => file + '|' + kind + '|' + sig;
    function pref(kind, sig, field, fallback) {
        const p = prefs[prefKey(kind, sig)];
        return p && Object.prototype.hasOwnProperty.call(p, field) ? p[field] : fallback;
    }
    function remember(kind, sig, field, value, fallback) {
        const key = prefKey(kind, sig);
        const p = Object.assign({}, prefs[key]);
        if (value === fallback) delete p[field]; else p[field] = value;
        if (Object.keys(p).length) prefs[key] = p; else delete prefs[key];
        try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch (_) { /* this visit only */ }
    }

    const UI = 'mtb-ui';
    const ownText = (node) => {
        let out = '';
        (function walk(n) {
            n.childNodes.forEach((c) => {
                if (c.nodeType === 3) out += c.nodeValue;
                else if (c.nodeType === 1 && !c.classList.contains(UI)) walk(c);
            });
        })(node);
        return out.replace(/\s+/g, ' ').trim();
    };

    function addStyles() {
        if (document.getElementById('mtbLayoutStyles')) return;
        const style = document.createElement('style');
        style.id = 'mtbLayoutStyles';
        style.textContent = `
            /* ONE row for every strip: the tabs slide sideways on a narrow
               window instead of wrapping into a second band twice as tall. */
            .mtb-tabs, .view-tabs, .tabs:has(> .tab) {
                flex-wrap: nowrap !important; overflow-x: auto; overflow-y: hidden; scrollbar-width: thin;
            }
            .mtb-tabs > .btn, .view-tabs > .view-tab, .tabs > .tab { flex: 0 0 auto; white-space: nowrap; }

            .mtb-pin {
                position: sticky; right: 0; z-index: 2; flex: 0 0 auto; align-self: center;
                margin: 5px 0 5px auto !important; padding: 4px 10px 4px 8px;
                display: inline-flex; align-items: center; gap: 6px;
                border: 1px solid #89CFF0; border-radius: 999px; background: #E8F6FC; color: #0D4B68;
                box-shadow: -12px 0 10px -4px #1DA3E2;
                font: 600 12px/1.2 system-ui, -apple-system, 'Segoe UI', sans-serif;
                letter-spacing: 0; text-transform: none; white-space: nowrap; cursor: pointer; user-select: none;
            }
            .mtb-pin::after { content: '📌 Замрзни'; }
            /* On a phone the strip is narrower than its tabs, and a pin riding
               at the right edge sat ON the tabs: it had to be scrolled away to
               reach the one under it (owner, 1 Oct 2026). There it is the last
               thing on the strip, reached by sliding to the end. */
            @media (max-width: 720px) {
                .mtb-pin { position: static; box-shadow: none; }
            }
            .mtb-pin input { width: auto; height: auto; margin: 0; accent-color: #136990; cursor: pointer; }
            .mtb-pin:has(input:checked) { background: #0D4B68; border-color: #E8F6FC; color: #fff; }
            .mtb-pin:has(input:focus-visible) { outline: 2px solid #f6c453; outline-offset: 1px; }
            .mtb-fixed { position: fixed !important; z-index: 8000 !important; margin: 0 !important; box-sizing: border-box; }
            .mtb-ph { display: block; flex: none; }

            .mtb-hctl { display: inline-flex; gap: 3px; margin: 0 6px 0 0; vertical-align: middle;
                        white-space: nowrap; text-transform: none; letter-spacing: 0; }
            .mtb-hctl button {
                all: unset; box-sizing: border-box; display: inline-grid; place-items: center;
                width: 20px; height: 20px; border: 1px solid currentColor; border-radius: 5px;
                color: inherit; opacity: .45; cursor: pointer; font: 400 11px/1 system-ui, sans-serif;
            }
            .mtb-hctl button:hover, .mtb-hctl button:focus-visible { opacity: 1; }
            .mtb-hctl button:focus-visible { outline: 2px solid currentColor; outline-offset: 1px; }
            .mtb-hctl button[aria-pressed="true"] { opacity: 1; background: color-mix(in srgb, currentColor 22%, transparent); }
            .mtb-hctl .mtb-hpin::before { content: '📌'; font-size: 10px; }
            .mtb-hctl .mtb-hfold::before { content: '▾'; font-size: 12px; }
            .mtb-hctl .mtb-hfold[aria-expanded="false"]::before { content: '▸'; }
            table.mtb-folded > tbody, table.mtb-folded > tfoot { display: none; }
            .schedule-grid.mtb-folded > :not(.schedule-header) { display: none !important; }
            table.mtb-unfrozen > thead th, table.mtb-unfrozen > thead td { position: static !important; }
            .mtb-float-head { position: fixed; z-index: 7000; overflow: hidden;
                              box-shadow: 0 8px 10px -8px rgba(0, 0, 0, .45); }
            .mtb-float-head[hidden] { display: none !important; }
            .mtb-float-head > table { margin: 0 !important; }

            .mtb-fold {
                all: unset; box-sizing: border-box; display: inline-grid; place-items: center;
                width: 1.35em; height: 1.35em; margin: 0 .4em 0 0; vertical-align: .05em;
                border-radius: 5px; color: inherit; opacity: .55; cursor: pointer; font-size: .85em; line-height: 1;
            }
            .mtb-fold::before { content: '▾'; }
            .mtb-fold[aria-expanded="false"]::before { content: '▸'; }
            .mtb-fold:hover, .mtb-fold:focus-visible { opacity: 1; background: color-mix(in srgb, currentColor 12%, transparent); }
            .mtb-fold:focus-visible { outline: 2px solid currentColor; }
            .mtb-sec-folded > :not(.mtb-sec-head) { display: none !important; }
            .mtb-sec-folded > .mtb-sec-head { margin-bottom: 0 !important; }

            @media print {
                .mtb-ui { display: none !important; }
                .mtb-fixed { position: static !important; width: auto !important; }
                table.mtb-folded > tbody { display: table-row-group; }
                .schedule-grid.mtb-folded > :not(.schedule-header) { display: revert !important; }
            }
        `;
        document.head.appendChild(style);
    }

    // ── registries ───────────────────────────────────────────────────────
    const strips = [];
    const tables = [];
    const stripOf = new WeakMap();
    const tableOf = new WeakMap();
    const sectionOf = new WeakMap();

    // ── tab strips ───────────────────────────────────────────────────────
    const STRIPS = [
        { sel: '.mtb-tabs, .view-tabs' },
        { sel: '.tabs', ok: (s) => s.querySelector(':scope > .tab') },
        // Кабинети's day band: the band is what freezes, the row inside holds the pin.
        { sel: '.day-tabs-band', inner: (s) => s.querySelector('.band__inner') }
    ];

    function stripSig(strip) {
        if (strip.id) return '#' + strip.id;
        const words = [...strip.querySelectorAll('button, a')].slice(0, 3).map(ownText).join('¦');
        return words.slice(0, 80) || String(strips.length);
    }

    function enhanceStrip(strip, def) {
        if (def.ok && !def.ok(strip)) return;
        if (strip.closest('.mtb-app-nav, .' + UI)) return;
        const inner = (def.inner && def.inner(strip)) || strip;
        let r = stripOf.get(strip);
        if (!r) {
            r = { el: strip, inner, sig: stripSig(strip), ph: null, frozen: false };
            r.frozen = Boolean(pref('strip', r.sig, 'frozen', false));
            stripOf.set(strip, r);
            strips.push(r);
        }
        r.inner = inner;
        // A strip drawn again (innerHTML) lost its pin; it comes back.
        if (!r.pin || !inner.contains(r.pin)) {
            const label = document.createElement('label');
            label.className = 'mtb-pin ' + UI;
            label.title = 'Лентата останува горе додека се лизга страницата';
            const box = document.createElement('input');
            box.type = 'checkbox';
            box.setAttribute('aria-label', 'Замрзни ја лентата горе');
            box.checked = r.frozen;
            box.addEventListener('change', () => {
                r.frozen = box.checked;
                remember('strip', r.sig, 'frozen', r.frozen, false);
                schedule();
            });
            label.appendChild(box);
            inner.appendChild(label);
            r.pin = label;
        }
    }

    function unfix(r) {
        if (!r.ph) return;
        r.ph.remove();
        r.ph = null;
        r.el.classList.remove('mtb-fixed');
        r.el.style.top = r.el.style.left = r.el.style.width = '';
    }

    const shown = (node) => Boolean(node.offsetParent || (node.getClientRects && node.getClientRects().length));

    /** A pinned strip: in its place until it would scroll past the line, then on the line. */
    function placeStrip(r, line) {
        const strip = r.el;
        if (!r.frozen || !strip.isConnected || !shown(r.ph || strip)) { unfix(r); return line; }
        const top = (r.ph || strip).getBoundingClientRect().top;
        if (top >= line) { unfix(r); return line; }
        if (!r.ph) {
            const cs = getComputedStyle(strip);
            const ph = document.createElement('div');
            ph.className = 'mtb-ph ' + UI;
            ph.style.height = strip.offsetHeight + 'px';
            ph.style.margin = cs.marginTop + ' ' + cs.marginRight + ' ' + cs.marginBottom + ' ' + cs.marginLeft;
            strip.parentNode.insertBefore(ph, strip);
            r.ph = ph;
            strip.classList.add('mtb-fixed');
        }
        const box = r.ph.getBoundingClientRect();
        strip.style.top = line + 'px';
        strip.style.left = box.left + 'px';
        strip.style.width = box.width + 'px';
        return line + strip.offsetHeight;
    }

    // ── tables ───────────────────────────────────────────────────────────
    // Two shapes of table: a real <table> with a <thead>, and the schedule's
    // CSS grid (Кабинети, S-Dnevnik: `.schedule-grid`, its first row
    // `.schedule-header` cells). One set of controls for both, through these.
    const isGrid = (t) => t.classList.contains('schedule-grid');
    const headCells = (t) => isGrid(t)
        ? [...t.children].filter((c) => c.classList.contains('schedule-header'))
        : [...t.tHead.querySelectorAll('th, td')];
    const firstHeadCell = (t) => isGrid(t) ? headCells(t)[0] : t.tHead.rows[0] && t.tHead.rows[0].cells[0];
    function headHeight(t) {
        if (!isGrid(t)) return t.tHead.getBoundingClientRect().height;
        const top = t.getBoundingClientRect().top;
        return Math.max(0, ...headCells(t).map((c) => c.getBoundingClientRect().bottom - top));
    }

    function tableSig(t) {
        const anchor = t.id ? t : t.parentElement && t.parentElement.closest('[id]');
        const first = firstHeadCell(t);
        // The anchor and the first header word, not the whole row: a header
        // that carries counts („22 ученици") would otherwise forget the choice
        // every time a number changed, and every teacher's sheet on Личен
        // распоред shares one choice rather than each keeping its own.
        return (anchor ? '#' + anchor.id : '') + '/' + (first ? ownText(first).slice(0, 40) : '');
    }

    function bodyRows(t) {
        if (isGrid(t)) {
            const heads = headCells(t).length;
            return heads ? Math.floor((t.children.length - heads) / heads) : 0;
        }
        let n = 0;
        for (const b of t.tBodies) n += b.rows.length;
        return n;
    }

    function enhanceTable(t) {
        if (isGrid(t) ? !headCells(t).length : (!t.tHead || !t.tHead.rows.length || !t.tHead.rows[0].cells.length)) return;
        if (t.closest('.' + UI + ', dialog, [role="dialog"], [data-mtb-plain], .mtb-app-nav')) return;
        let r = tableOf.get(t);
        if (!r) {
            if (bodyRows(t) < 3) return;
            const firstCell = firstHeadCell(t);
            const native = getComputedStyle(firstCell).position === 'sticky';
            r = { el: t, native, sig: tableSig(t), float: null, headSig: '' };
            r.frozen = Boolean(pref('table', r.sig, 'frozen', native));
            r.folded = Boolean(pref('table', r.sig, 'folded', false));
            tableOf.set(t, r);
            tables.push(r);
        }
        const cell = firstHeadCell(t);
        if (!r.ctl || !cell.contains(r.ctl)) {
            const ctl = document.createElement('span');
            ctl.className = 'mtb-hctl ' + UI;
            const pin = document.createElement('button');
            pin.type = 'button';
            pin.className = 'mtb-hpin';
            pin.addEventListener('click', (event) => {
                event.stopPropagation();
                r.frozen = !r.frozen;
                remember('table', r.sig, 'frozen', r.frozen, r.native);
                paintTable(r);
                schedule();
            });
            const fold = document.createElement('button');
            fold.type = 'button';
            fold.className = 'mtb-hfold';
            fold.addEventListener('click', (event) => {
                event.stopPropagation();
                r.folded = !r.folded;
                remember('table', r.sig, 'folded', r.folded, false);
                paintTable(r);
                schedule();
            });
            ctl.append(pin, fold);
            cell.insertBefore(ctl, cell.firstChild);
            r.ctl = ctl;
        }
        const headSig = headCells(t).map(ownText).join('¦');
        if (headSig !== r.headSig) { r.headSig = headSig; dropFloat(r); }
        paintTable(r);
    }

    function paintTable(r) {
        const t = r.el;
        t.classList.toggle('mtb-folded', r.folded);
        t.classList.toggle('mtb-unfrozen', r.native && !r.frozen);
        const [pin, fold] = r.ctl ? r.ctl.children : [];
        if (pin) {
            pin.setAttribute('aria-pressed', String(r.frozen));
            pin.setAttribute('aria-label', r.frozen ? 'Одзамрзни го насловниот ред' : 'Замрзни го насловниот ред');
            pin.title = r.frozen ? 'Насловниот ред останува горе при лизгање — клик за да не останува'
                : 'Замрзни го насловниот ред: останува горе додека се лизга табелата';
        }
        if (fold) {
            const n = bodyRows(t);
            fold.setAttribute('aria-expanded', String(!r.folded));
            fold.setAttribute('aria-label', r.folded ? 'Отвори ги редовите' : 'Собери ги редовите');
            fold.title = r.folded ? 'Собрано: ' + n + (n === 1 ? ' ред' : ' реда') + ' — клик за да се отвори'
                : 'Собери ги редовите, остави го само насловот';
        }
        if (r.folded || !r.frozen || r.native) dropFloat(r);
    }

    function dropFloat(r) {
        if (r.float) { r.float.remove(); r.float = null; }
    }

    /** The first colour that is not see-through, from the cell outwards. */
    function solidBehind(node) {
        for (let n = node; n && n.nodeType === 1; n = n.parentElement) {
            const c = getComputedStyle(n).backgroundColor;
            if (c && c !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(c)) return c;
        }
        return document.documentElement.dataset.theme === 'dark' ? '#1a202c' : '#ffffff';
    }

    /**
     * The header row, copied. Beside the table, not at the end of <body>, so
     * the page's own rules for its header („.personal .p-grid thead th") still
     * reach it; the measured widths and colours are written on as well, for
     * the rules that do not.
     */
    function buildFloat(r) {
        const t = r.el;
        dropFloat(r);
        const width = t.getBoundingClientRect().width;
        const cs = getComputedStyle(t);
        const box = document.createElement('div');
        box.className = 'mtb-float-head ' + UI;
        box.setAttribute('aria-hidden', 'true');
        box.hidden = true;
        box.style.backgroundColor = solidBehind(t);
        const grid = isGrid(t);
        const copy = document.createElement(grid ? 'div' : 'table');
        copy.className = [...t.classList].filter((c) => !c.startsWith('mtb-')).join(' ');
        copy.style.cssText = `width:${width}px;min-width:${width}px;max-width:${width}px;margin:0;font-size:${cs.fontSize};`
            + (grid ? `grid-template-columns:${cs.gridTemplateColumns};border-radius:0;`
                : `table-layout:auto;border-collapse:${cs.borderCollapse};border-spacing:${cs.borderSpacing};`);
        const src = headCells(t);
        const head = grid ? document.createDocumentFragment() : t.tHead.cloneNode(true);
        if (grid) src.forEach((c) => head.appendChild(c.cloneNode(true)));
        const dst = grid ? [...head.children] : [...head.querySelectorAll('th, td')];
        dst.forEach((d) => { d.removeAttribute('id'); d.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id')); });
        src.forEach((cell, i) => {
            const d = dst[i];
            if (!d) return;
            const b = cell.getBoundingClientRect();
            const s = getComputedStyle(cell);
            Object.assign(d.style, {
                boxSizing: 'border-box', width: b.width + 'px', minWidth: b.width + 'px', maxWidth: b.width + 'px',
                height: b.height + 'px', position: 'static', color: s.color, padding: s.padding,
                textAlign: s.textAlign, verticalAlign: s.verticalAlign, fontWeight: s.fontWeight, fontSize: s.fontSize,
                borderBottom: s.borderBottom, whiteSpace: s.whiteSpace,
                backgroundColor: /rgba\(.*,\s*0\)$|transparent/.test(s.backgroundColor) ? solidBehind(cell) : s.backgroundColor,
                backgroundImage: s.backgroundImage
            });
        });
        copy.appendChild(head);
        box.appendChild(copy);
        // A click on the copy is a click on the original: a therapist's name
        // in Кабинети's head, a sort, the 📌 itself.
        box.addEventListener('click', (event) => {
            const cell = dst.find((d) => d.contains(event.target));
            const i = dst.indexOf(cell);
            if (i < 0) return;
            const path = [];
            for (let n = event.target; n && n !== cell; n = n.parentNode) path.unshift([...n.parentNode.childNodes].indexOf(n));
            let target = src[i];
            for (const k of path) { if (target && target.childNodes[k]) target = target.childNodes[k]; }
            event.preventDefault();
            event.stopPropagation();
            (target && target.nodeType === 1 ? target : src[i]).click();
        });
        t.parentNode.insertBefore(box, t.nextSibling);
        r.float = box;
        r.floatWidth = width;
    }

    /** What of the screen a node can be seen in: the window, cut by every box that clips it. */
    function visibleRect(node) {
        const rect = { top: 0, left: 0, right: window.innerWidth, bottom: window.innerHeight };
        for (let n = node.parentElement; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
            const s = getComputedStyle(n);
            if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
            const b = n.getBoundingClientRect();
            rect.top = Math.max(rect.top, b.top + n.clientTop);
            rect.left = Math.max(rect.left, b.left + n.clientLeft);
            rect.right = Math.min(rect.right, b.left + n.clientLeft + n.clientWidth);
            rect.bottom = Math.min(rect.bottom, b.top + n.clientTop + n.clientHeight);
        }
        return rect;
    }

    /** A pinned header that its page does not keep on screen itself: the copy rides the line. */
    function placeTable(r, line) {
        const t = r.el;
        if (!t.isConnected || r.native || !r.frozen || r.folded) { dropFloat(r); return; }
        const box = t.getBoundingClientRect();
        if (!box.height) { if (r.float) r.float.hidden = true; return; }
        const clip = visibleRect(t);
        const top = Math.max(line, clip.top);
        const headH = headHeight(t);
        if (box.top >= top || box.bottom - headH <= top || clip.right - clip.left < 40) {
            if (r.float) r.float.hidden = true;
            return;
        }
        if (!r.float || Math.abs(r.floatWidth - box.width) > 1) buildFloat(r);
        const f = r.float;
        // The last rows push the header up and away, as in an editor.
        const room = box.bottom - top;
        f.style.top = (room < headH * 2 ? top - (headH * 2 - room) : top) + 'px';
        f.style.left = clip.left + 'px';
        f.style.width = Math.max(0, clip.right - clip.left) + 'px';
        f.firstChild.style.marginLeft = (box.left - clip.left) + 'px';
        f.hidden = false;
    }

    // ── sections ─────────────────────────────────────────────────────────
    const SECTIONS = '.panel, .card';

    function enhanceSection(c) {
        if (c.hasAttribute('data-fold') || c.closest('.' + UI + ', dialog, [role="dialog"], [data-mtb-plain], table, .mtb-app-nav')) return;
        const h = c.firstElementChild;
        if (!h || !h.matches('h2, h3, .section-header') || c.children.length < 2) return;
        let r = sectionOf.get(c);
        if (!r) {
            const words = (c.id ? '#' + c.id : '') + '/' + ownText(h).slice(0, 60);
            r = { el: c, sig: words, folded: Boolean(pref('section', words, 'folded', false)) };
            sectionOf.set(c, r);
        }
        h.classList.add('mtb-sec-head');
        if (!r.btn || r.btn.parentNode !== h) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'mtb-fold ' + UI;
            b.addEventListener('click', (event) => {
                event.stopPropagation();
                r.folded = !r.folded;
                remember('section', r.sig, 'folded', r.folded, false);
                paintSection(r);
                schedule();
            });
            h.insertBefore(b, h.firstChild);
            r.btn = b;
        }
        paintSection(r);
    }

    function paintSection(r) {
        r.el.classList.toggle('mtb-sec-folded', r.folded);
        r.btn.setAttribute('aria-expanded', String(!r.folded));
        r.btn.setAttribute('aria-label', r.folded ? 'Отвори го делот' : 'Собери го делот');
        r.btn.title = r.folded ? 'Собрано — клик за да се отвори' : 'Собери го делот';
    }

    // ── one pass over the page, and one placement per frame ───────────────
    function scan() {
        if (!document.body) return;
        STRIPS.forEach((def) => document.querySelectorAll(def.sel).forEach((s) => enhanceStrip(s, def)));
        document.querySelectorAll('table, .schedule-grid').forEach(enhanceTable);
        document.querySelectorAll(SECTIONS).forEach(enhanceSection);
        for (let i = strips.length - 1; i >= 0; i--) {
            if (!strips[i].el.isConnected) { unfix(strips[i]); strips.splice(i, 1); }
        }
        for (let i = tables.length - 1; i >= 0; i--) {
            if (!tables[i].el.isConnected) { dropFloat(tables[i]); tables.splice(i, 1); }
        }
        schedule();
    }

    function layout() {
        // Strips stack in the order they stand on the page; the header copies
        // ride under whatever is stacked above them.
        const ordered = strips.slice().sort((a, b) =>
            (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1);
        let line = 0;
        ordered.forEach((r) => { line = placeStrip(r, line); });
        tables.forEach((r) => placeTable(r, line));
    }

    let frame = 0;
    function schedule() {
        if (frame) return;
        frame = requestAnimationFrame(() => { frame = 0; layout(); });
    }

    let scanTimer = 0;
    const isOurs = (n) => n.nodeType === 1 && (n.classList.contains(UI) || Boolean(n.closest && n.closest('.' + UI)));
    const observer = new MutationObserver((records) => {
        const foreign = records.some((m) => {
            if (m.target.nodeType === 1 && m.target.closest && m.target.closest('.' + UI)) return false;
            const nodes = [...m.addedNodes, ...m.removedNodes];
            return !nodes.length || !nodes.every(isOurs);
        });
        if (!foreign) return;
        clearTimeout(scanTimer);
        scanTimer = setTimeout(scan, 120);
    });

    function start() {
        addTabLook();
        addStyles();
        scan();
        observer.observe(document.body, { childList: true, subtree: true });
        window.addEventListener('scroll', schedule, { capture: true, passive: true });
        window.addEventListener('resize', () => { tables.forEach(dropFloat); schedule(); });
        window.addEventListener('load', schedule);
        window.addEventListener('beforeprint', () => strips.forEach(unfix));
    }

    window.MTBLayout = { refresh: scan };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
})();

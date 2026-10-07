/**
 * One teacher's week, as a sheet — read, or edited in the cell.
 *
 * It was written for Настава's „Наставник · недела" (owner, 27 Sep 2026) and
 * moved here unchanged when Податоци asked for the same week (owner,
 * 28 Sep 2026: „во Податоци да постои истата можност како кај колеги").
 * Two screens with two copies of these rules would disagree the first time
 * one of them was corrected — which is exactly the rule the owner had to
 * repeat three times:
 *
 *   ОДДЕЛЕНСКИ наставник — the class is theirs and fixed; only the subject is
 *     picked, out of everything that class learns.
 *   ПРЕДМЕТЕН наставник — picks the паралелка (their own first, the others
 *     under „Други"), then one of their own subjects; the catalogue only while
 *     none is recorded.
 *   An одделенски with no homeroom yet picks a class, like a предметен.
 *
 * 🔒/🔓 in the corner of the sheet, beside 📌 ▾, is the suite's one edit
 * switch (`mtb-forms.js`), not a second mode: locked, the sheet is paper that
 * can be printed and handed out; open, every period is its pickers.
 *
 * NO SECOND WRITER. A change goes to `PUT /api/teaching/teacher-lesson`, the
 * route Уреди настава and Kolega already write through, with the class the
 * cell showed as `expected` — so a lesson changed in the meantime is refused,
 * not overwritten. Nothing is kept in the browser.
 *
 *   MTBTeacherWeek.week(data)                      rows per teacher, from /api/teaching/crossing
 *   MTBTeacherWeek.sheetHtml(week, data, name, o)  one <section class="personal">
 *   MTBTeacherWeek.attach(root, ctx)               pickers and 🔒 inside root
 *   MTBTeacherWeek.loadOffers(data, base, done)    the catalogue per class, once per year
 */
(function () {
    'use strict';
    if (window.MTBTeacherWeek) return;

    const DAYS = ['понеделник', 'вторник', 'среда', 'четврток', 'петок'];
    const SCHOOL = 'ОУРЦ „Кочо Рацин“ – Битола';
    const NOBODY = '— без наставник —';

    const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const tidy = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
    const cap = (d) => String(d || '').charAt(0).toUpperCase() + String(d || '').slice(1);
    const clock = (slots) => (slots || []).join(', ').replace(/-/g, '–');
    const editing = () => Boolean(window.MTBForms && window.MTBForms.editing());

    // ── the look: a sheet of paper, fixed colours in both themes ────────────
    // Printed and handed to the person, so every text states its own colour
    // (CLAUDE.md, the button that did not inherit it). White small text on
    // #5a67d8 is 4.8:1.
    function addLook() {
        if (document.getElementById('mtbTeacherWeekLook')) return;
        const style = document.createElement('style');
        style.id = 'mtbTeacherWeekLook';
        style.textContent = `
    .personal { margin: 0 0 26px; padding: 14px; border-radius: 12px; background: #ffffff; color: #1a202c;
        border: 1px solid #d8dbe8; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .personal .p-head { padding: 14px 18px; border-radius: 12px; text-align: center; color: #ffffff;
        background: linear-gradient(90deg, #5a67d8, #6b46c1); }
    .personal .p-head h3 { margin: 0; font-size: 22px; color: #ffffff; }
    .personal .p-sub { margin-top: 4px; font-size: 13px; color: #ffffff; }
    .personal .p-grid { width: 100%; margin-top: 12px; border-collapse: separate; border-spacing: 2px; table-layout: fixed; font-size: 12.5px; }
    .personal .p-grid thead th { padding: 8px 6px; background: #4c51bf; color: #ffffff; font-weight: 700; text-align: center; }
    .personal .p-grid thead th:first-child, .personal .p-grid tbody th { width: 84px; }
    .personal .p-grid.lockable thead th:first-child, .personal .p-grid.lockable tbody th { width: 104px; }
    .personal .p-grid tbody th { padding: 6px; background: #2d3748; color: #ffffff; text-align: center; vertical-align: middle; }
    .personal .p-grid tbody th b { display: block; font-size: 15px; }
    .personal .p-grid tbody th small { display: block; color: #cbd5e0; font-size: 11px; }
    .personal .p-grid td { padding: 4px; vertical-align: top; background: #f7fafc; color: #1a202c; }
    .personal .p-grid tbody tr:nth-child(even) td { background: #ffffff; }
    .personal .p-lesson, .personal .p-away { margin: 0 0 3px; padding: 4px 6px 4px 8px; border-radius: 6px; line-height: 1.2; }
    .personal .p-lesson { background: #e6fffa; border-left: 4px solid #319795; color: #1a202c; }
    .personal .p-away { background: #fff5e6; border-left: 4px solid #c05621; color: #1a202c; }
    .personal .p-lesson b, .personal .p-away b { display: block; font-size: 12.5px; color: #1a202c; overflow-wrap: anywhere; }
    .personal .p-lesson small, .personal .p-away small { display: block; font-size: 11px; color: #4a5568; }
    .personal .p-away small { color: #7b341e; }
    .personal .p-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px;
        margin-top: 8px; font-size: 12px; color: #4a5568; }
    .personal .quiet { color: #4a5568; }
    .personal .p-edit { display: grid; gap: 3px; margin: 0 0 3px; }
    .personal .p-edit select { width: 100%; min-width: 0; padding: 4px 6px; border: 1px dashed #a0aec0; border-radius: 6px;
        background: #ffffff; color: #1a202c; font-family: inherit; font-size: 12px; font-weight: 600; line-height: 1.25; cursor: pointer; }
    .personal .p-edit select.has { border: 1px solid #81e6d9; border-left: 4px solid #319795; background: #e6fffa; }
    .personal .p-edit select.p-subj { font-weight: 500; }
    .personal .p-edit select.p-subj.none { color: #4a5568; }
    .personal .p-edit select:disabled { opacity: .55; cursor: default; }
    .personal .p-edit select:hover:not(:disabled) { border-color: #4c51bf; }
    .personal .p-edit select:focus-visible { outline: 2px solid #4c51bf; outline-offset: 1px; }
    .personal .p-edit input.p-other { width: 100%; min-width: 0; padding: 4px 6px; border: 1px solid #4c51bf; border-radius: 6px;
        background: #ffffff; color: #1a202c; font-family: inherit; font-size: 12px; }
    .personal .p-cell.saving { opacity: .55; }
    .personal .p-warn { display: block; color: #9c4221; font-size: 11px; font-weight: 600; }
    .personal.editing .p-lesson { display: none; }
    .personal .p-edithint { margin: 8px 2px 0; color: #4a5568; font-size: 12.5px; }
    /* 🔒/🔓 — the glyph is CSS, so the header's text (which mtb-layout.js
       remembers the 📌 choice by) does not change when the mode does. */
    .personal .p-lock { width: 22px; height: 20px; margin: 0 4px 0 0; padding: 0; border: 1px solid #a3bffa; border-radius: 5px;
        background: #434190; color: #ffffff; cursor: pointer; vertical-align: middle; line-height: 1; }
    .personal .p-lock::before { content: '🔒'; font-size: 11px; }
    .personal .p-lock[aria-pressed="true"] { background: #276749; border-color: #9ae6b4; }
    .personal .p-lock[aria-pressed="true"]::before { content: '🔓'; }
    .personal .p-lock:focus-visible { outline: 2px solid #ffffff; outline-offset: 1px; }
    @media print {
        .personal .p-edit, .personal .p-edithint, .personal .p-lock { display: none !important; }
        .personal.editing .p-lesson { display: block; }
    }
    /* What the sheet shows (owner, 1 Oct 2026, as on the colleagues' page):
       lessons and who leaves for a cabinet, only the lessons, or only the cabinets. */
    .personal .p-modes { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0 8px; }
    .personal .p-modes button { font: 700 14px/1.2 system-ui, -apple-system, 'Segoe UI', sans-serif; padding: 6px 14px; min-height: 34px;
        border: 1px solid #c9ced8; border-radius: 999px; background: #f7f7fc; color: #1a202c; cursor: pointer; }
    .personal .p-modes button:hover { border-color: #0f6cbd; }
    .personal .p-modes button[aria-pressed="true"] { background: #0f6cbd; border-color: #0f6cbd; color: #ffffff; }
    .personal.show-subjects .p-away { display: none !important; }
    .personal.show-cabinets .p-lesson { display: none !important; }
    /* The fixed cell (readCellHtml). Height is the cell's, whatever it holds:
       a lesson line, and one row of therapies side by side. */
    .personal:not(.editing) .p-grid td { height: 82px; padding: 3px; }
    .personal.show-subjects:not(.editing) .p-grid td { height: 54px; } /* the lesson and its strip */
    .personal.show-cabinets:not(.editing) .p-grid td { height: 50px; }
    .personal .p-box { display: flex; flex-direction: column; gap: 3px; height: 100%; min-width: 0; }
    .personal .p-row { display: flex; gap: 3px; min-width: 0; }
    .personal .p-row > div { flex: 1 1 0; min-width: 0; margin: 0; }
    .personal .p-row b, .personal .p-row small { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; overflow-wrap: normal; }
    .personal .p-row .p-away { border-left-color: var(--who, #c05621); padding-left: 6px; }
    .personal .p-row .p-more { flex: 0 0 auto; display: flex; align-items: center; padding: 0 6px; border-radius: 6px;
        background: #edf2f7; color: #2d3748; font-weight: 700; font-size: 12px; cursor: default; }
    .personal .p-strip { display: none; gap: 2px; height: 7px; margin-top: auto; border-radius: 4px; overflow: hidden; }
    .personal .p-strip i { flex: 1 1 0; }
    .personal.show-subjects .p-strip { display: flex; }
    .personal.show-subjects .p-aways, .personal.show-cabinets .p-lessons { display: none !important; }
    @media print { .personal .p-modes { display: none !important; } }
    @page personal { size: A4 landscape; margin: 9mm; }
    @media print {
        .personal { page: personal; border: 0; padding: 0; margin: 0; break-after: page; page-break-after: always; }
        .personal:last-of-type { break-after: auto; page-break-after: auto; }
        .personal .p-foot .btn { display: none !important; }
    }`;
        (document.head || document.documentElement).appendChild(style);
    }
    addLook();

    // ── reading the crossing ────────────────────────────────────────────────
    /**
     * A row for everybody on the year's list, then anybody the timetable names
     * who is not on it. „Who are the people" and „what is timetabled" are two
     * questions; reading the first out of the second hid every teacher who had
     * no lesson yet.
     */
    function teacherRows(data) {
        const rows = new Map();
        (data.teachers || []).forEach((t) => rows.set(t.name, new Map()));
        const offStaff = new Set();
        (data.cells || []).forEach((c) => {
            const name = c.teacher || NOBODY;
            if (c.teacher && c.teacherOnStaff === false) offStaff.add(c.teacher);
            if (!rows.has(name)) rows.set(name, new Map());
        });
        const order = Array.from(rows.keys()).sort((a, b) => a.localeCompare(b, 'mk'));
        return { rows, offStaff, order };
    }

    function week(data) {
        const periods = (data.bells && data.bells.teaching) || [];
        const days = DAYS.filter((d) => (data.cells || []).some((c) => c.day === d));
        const { rows, offStaff, order } = teacherRows(data);
        (data.cells || []).forEach((c) => {
            const slot = rows.get(c.teacher || NOBODY);
            const at = c.day + '|' + c.ordinal;
            if (!slot.has(at)) slot.set(at, []);
            slot.get(at).push(c);
        });
        const kindOf = new Map((data.teachers || []).map((t) => [t.name, t.kind]));
        return { periods, days, rows, offStaff, kindOf, names: order.filter((n) => n !== NOBODY) };
    }

    /** What one period of one teacher says: the lesson, then who leaves it. */
    function entries(list) {
        const out = [];
        list.forEach((c) => {
            out.push({ kind: 'lesson', text: c.subject || 'без предмет', sub: c.class });
            (c.away || []).forEach((a) => out.push({
                kind: 'away', text: '↳ ' + a.student, sub: a.therapist + (a.slots && a.slots.length ? ' · ' + clock(a.slots) : ''),
                who: a.therapist
            }));
        });
        return out;
    }

    /*
     * One read-only cell, the same size whatever is in it (owner, 3 Oct 2026):
     * „fixed cell size is always cool". The lesson on top; the children who
     * leave it side by side in equal columns under it, never stacked, so two
     * or three therapies do not make the row taller. Text is cut to its column
     * and said whole on hover, as a browser does with its tabs. With the
     * therapies hidden („Само предмети") a thin strip stays at the bottom, one
     * segment per therapy in its therapist's colour: the lesson still shows
     * that somebody leaves it, and for whom.
     *
     * The colour is the therapist's place among every therapist the year's
     * crossing names, in alphabetical order: the same person has the same
     * colour on every sheet of the page, nothing is stored, and up to ten
     * therapists never share one. (A colour folded out of the name alone
     * gave two of three therapists the same green the first time it was
     * looked at.) The hover says who is who regardless.
     */
    const COLUMNS = 3;
    const TINTS = ['#c05621', '#2b6cb0', '#2f855a', '#6b46c1', '#b83280', '#0f766e', '#975a16', '#c53030', '#4c51bf', '#718096'];
    let tintsOf = null;
    let tintMap = new Map();
    function tints(data) {
        if (data && data !== tintsOf) {
            const names = new Set();
            (data.cells || []).forEach((c) => (c.away || []).forEach((a) => { if (a.therapist) names.add(a.therapist); }));
            tintMap = new Map(Array.from(names).sort((a, b) => a.localeCompare(b, 'mk'))
                .map((n, i) => [n, TINTS[i % TINTS.length]]));
            tintsOf = data;
        }
        return tintMap;
    }
    const tintOf = (name) => tintMap.get(name) || TINTS[0];
    const whole = (e) => String(e.text || '').replace(/^↳\s*/, '') + (e.sub ? ' — ' + e.sub : '');
    /** `data` (the crossing) gives the therapists their colours; without it the last one read is used. */
    function readCellHtml(list, data) {
        if (data) tints(data);
        const lessons = list.filter((e) => e.kind === 'lesson');
        const aways = list.filter((e) => e.kind === 'away');
        const card = (e) => `<div class="p-${e.kind}" title="${esc(whole(e))}"`
            + (e.kind === 'away' ? ` style="--who:${tintOf(e.who)}"` : '') + `><b>${esc(e.text)}</b><small>${esc(e.sub)}</small></div>`;
        const row = (items, cls) => {
            if (!items.length) return '';
            const more = items.length - COLUMNS;
            return `<div class="p-row ${cls}">` + items.slice(0, COLUMNS).map(card).join('')
                + (more > 0 ? `<div class="p-more" title="${esc(items.slice(COLUMNS).map(whole).join('\n'))}">+${more}</div>` : '')
                + '</div>';
        };
        const strip = aways.length
            ? `<div class="p-strip" title="${esc(aways.length + (aways.length === 1 ? ' излегува на третман: ' : ' излегуваат на третман:\n') + aways.map(whole).join('\n'))}">`
              + aways.map((e) => `<i style="background:${tintOf(e.who)}"></i>`).join('') + '</div>'
            : '';
        return '<div class="p-box">' + row(lessons, 'p-lessons') + row(aways, 'p-aways') + strip + '</div>';
    }

    // ── who picks what ──────────────────────────────────────────────────────
    const teacherOf = (data, name) => (data.teachers || []).find((x) => x.name === name);
    function ownSubjects(data, name) {
        const t = teacherOf(data, name);
        return t && t.subject ? String(t.subject).split(',').map(tidy).filter(Boolean) : [];
    }
    /** Only one subject of their own is a default; with two, it is the person's choice. */
    function autoSubject(data, name) {
        const own = ownSubjects(data, name);
        return own.length === 1 ? own[0] : '';
    }
    function fixedClass(data, name) {
        const t = teacherOf(data, name);
        return t && t.kind === 'odd' && t.homeroom ? t.homeroom : '';
    }

    let cardsOf = null;
    let cards = new Map();
    function classCards(data) {
        const nav = window.MTBAppNavigation;
        if (!nav || !nav.classes) return new Map();
        if (cardsOf !== data) { cards = nav.classes.index({ classes: data.classes, teachers: data.teachers }); cardsOf = data; }
        return cards;
    }
    function classOptions(data, selected, teacher) {
        const nav = window.MTBAppNavigation;
        // A teacher's own паралелки (ticked on Kolega, or given in Податоци), and
        // the one already in the cell; every class while none is recorded.
        const t = teacherOf(data, teacher);
        const mine = t && Array.isArray(t.classes) ? t.classes : [];
        if (nav && nav.classes) {
            if (!mine.length) return nav.classes.optionsHtml(classCards(data), selected, { empty: '— слободен —' });
            const all = Array.from(classCards(data));
            const own = new Map(all.filter(([label]) => mine.includes(label)));
            const rest = new Map(all.filter(([label]) => !mine.includes(label)));
            const inRest = rest.has(selected);
            return `<option value=""${selected ? '' : ' selected'}>— слободен —</option>`
                + `<optgroup label="${esc('Паралелки на ' + teacher)}">${nav.classes.optionsHtml(own, inRest ? '' : selected, { empty: false })}</optgroup>`
                + (rest.size ? `<optgroup label="Други паралелки">${nav.classes.optionsHtml(rest, inRest ? selected : '', { empty: false })}</optgroup>` : '');
        }
        return '<option value="">— слободен —</option>' + (data.classes || []).map((c) =>
            `<option value="${esc(c.label)}"${c.label === selected ? ' selected' : ''}>${esc(c.alias || c.label)}</option>`).join('');
    }

    // What the catalogue offers for a class, per year: read once when the
    // pickers first appear, so opening a cell never waits on the network.
    const offers = new Map();
    const offersRead = new Set();
    function loadOffers(data, base, done) {
        if (!data) return;
        const key = (base || '') + '|' + data.year;
        if (offersRead.has(key)) return;
        offersRead.add(key);
        const year = data.year;
        Promise.all((data.classes || []).map((c) => fetch((base || '') + '/api/teaching/subjects?year=' + encodeURIComponent(year)
            + '&class=' + encodeURIComponent(c.label), { cache: 'no-store' })
            .then((r) => (r.ok ? r.json() : { subjects: [] }))
            .then((b) => offers.set(year + '|' + c.label, (b.subjects || []).map((x) => x.subject)))
            .catch(() => {})))
            .then(() => { if (typeof done === 'function') done(); });
    }
    /** A picker being chosen in is never redrawn from under the person. */
    const choosing = () => Boolean(document.activeElement && document.activeElement.closest
        && document.activeElement.closest('.personal .p-edit'));

    function subjectOptions(data, teacher, label, chosen, held) {
        const fixed = fixedClass(data, teacher);
        const own = ownSubjects(data, teacher);
        const offered = (offers.get(data.year + '|' + label) || []).filter((x) => !own.includes(x));
        if (chosen && !own.includes(chosen) && !offered.includes(chosen)) offered.unshift(chosen);
        const opt = (s) => `<option value="${esc(s)}"${s === chosen ? ' selected' : ''}>${esc(s)}</option>`;
        return `<option value="">${held ? '— без предмет —' : '— избери предмет —'}</option>`
            + (own.length ? `<optgroup label="${esc((fixed ? 'Предмети во ' + label + ' — ' : 'Предмети на ') + teacher)}">${own.map(opt).join('')}</optgroup>` : '')
            + (offered.length ? `<optgroup label="${esc(own.length ? 'Други предмети' : fixed ? 'Предмети во ' + label : 'Предмети')}">${offered.map(opt).join('')}</optgroup>` : '')
            + '<option value="__other">✎ друг предмет…</option>'
            + (held ? '<option value="__clear">✕ слободен час (избриши)</option>' : '');
    }

    /** One period of one teacher, as the pickers. Two lessons at once is a clash no picker can mend. */
    function editCellHtml(data, name, day, p, list) {
        const one = list[0] || null;
        const cls = one ? one.class || '' : '';
        const subj = one ? tidy(one.subject) : '';
        const where = `${name} · ${day} · ${p.ordinal}. час`;
        const two = list.length > 1;
        const fixed = fixedClass(data, name);
        const warn = two ? '<span class="p-warn">⚠ Два часа во ист термин — исправи во „Уреди настава"</span>' : '';
        if (fixed) {
            // The class is theirs: one picker, the subject. A lesson already
            // standing in another class (an old entry) keeps its own class.
            const inClass = cls || fixed;
            return `<div class="p-edit">`
                + `<select class="p-subj${cls ? ' has' : ' none'}" aria-label="${esc('Предмет во ' + inClass + ' — ' + where)}"`
                + ` title="${esc(inClass)}"${two ? ' disabled' : ''}>${subjectOptions(data, name, inClass, subj, Boolean(cls))}</select>`
                + warn + '</div>';
        }
        return `<div class="p-edit">`
            + `<select class="p-class${cls ? ' has' : ''}" data-class-picker aria-label="${esc('Паралелка — ' + where)}"${two ? ' disabled' : ''}>${classOptions(data, cls, name)}</select>`
            // The subject only once there is a class to teach it in.
            + (cls ? `<select class="p-subj${subj ? '' : ' none'}" aria-label="${esc('Предмет — ' + where)}"${two ? ' disabled' : ''}>${subjectOptions(data, name, cls, subj, true)}</select>` : '')
            + warn + '</div>';
    }

    // ── the sheet ───────────────────────────────────────────────────────────
    /**
     * o.editing   pickers in the cells (default: the suite's switch)
     * o.allDays   all five days even when locked (a single person's sheet)
     * o.footer    the text bottom-left
     * o.png       a „🖼 Слика" button (data-png) for the page to handle
     * o.lock      🔒/🔓 in the corner (default: when mtb-forms.js is loaded)
     */
    // The viewer's choice of what the sheet shows: layout only, kept in this browser.
    const MODE_KEY = 'mtb_teacher_week_mode_v1';
    const MODES = [['all', 'Часови и кабинети'], ['subjects', 'Само предмети'], ['cabinets', 'Само кабинети']];
    function mode() {
        try { const m = localStorage.getItem(MODE_KEY); return MODES.some(([k]) => k === m) ? m : 'all'; } catch (_) { return 'all'; }
    }
    function setMode(next) {
        if (!MODES.some(([k]) => k === next)) return;
        try { if (next === 'all') localStorage.removeItem(MODE_KEY); else localStorage.setItem(MODE_KEY, next); } catch (_) { /* this visit only */ }
        // Every sheet on the page at once: „Сите наставници" prints one per person.
        document.querySelectorAll('.personal').forEach((sheet) => {
            MODES.forEach(([k]) => sheet.classList.toggle('show-' + k, k === next));
            sheet.querySelectorAll('[data-p-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.pMode === next)));
        });
    }
    // On the document, once: a page that only reads the sheet never calls attach().
    document.addEventListener('click', (event) => {
        const pick = event.target.closest && event.target.closest('.personal [data-p-mode]');
        if (pick) setMode(pick.dataset.pMode);
    });

    /** The switch of what a sheet shows; a class sheet (Настава) puts the same one on its own. */
    function modesHtml() {
        const shown = mode();
        return '<div class="p-modes mtb-ui" role="group" aria-label="Што се прикажува">'
            + MODES.map(([k, label]) => `<button type="button" data-p-mode="${k}" aria-pressed="${k === shown}">${label}</button>`).join('') + '</div>';
    }

    function sheetHtml(w, data, name, o) {
        o = o || {};
        const on = o.editing === undefined ? editing() : Boolean(o.editing);
        const days = on || o.allDays ? DAYS : w.days;
        const slots = w.rows.get(name) || new Map();
        const lessons = Array.from(slots.values()).reduce((n, list) => n + list.length, 0);
        const away = Array.from(slots.values()).reduce((n, list) => n + list.reduce((m, c) => m + (c.awayCount || 0), 0), 0);
        const kind = w.kindOf.get(name) === 'odd' ? 'одделенски наставник'
            : w.kindOf.get(name) === 'pred' ? 'предметен наставник' : '';
        const homeroom = fixedClass(data, name);
        const yearLabel = data.year + (data.isCurrentYear ? '' : ' · архивски приказ');
        const sub = [SCHOOL, 'учебна ' + yearLabel, kind + (homeroom ? ' · ' + homeroom : ''),
            lessons + (lessons === 1 ? ' час' : ' часа') + ' неделно',
            away ? away + (away === 1 ? ' излегување на третман' : ' излегувања на третман') : 'никој не излегува на третман',
            w.offStaff.has(name) ? 'не е на списокот оваа година' : ''].filter(Boolean).join(' · ');
        const lock = (o.lock === undefined ? Boolean(window.MTBForms) : o.lock)
            ? `<button type="button" class="p-lock mtb-ui" data-p-lock aria-pressed="${on}"`
              + ` aria-label="${on ? 'Отворено за внес — кликни за да се заклучи' : 'Заклучено за внес — кликни за да се отвори'}"`
              + ` title="${on ? '🔓 Отворено за внес: паралелката и предметот се бираат во ќелијата. Кликни за да се заклучи.'
                  : '🔒 Заклучено: само читање и печатење. Кликни за да се отвори за внес.'}"></button>`
            : '';
        const body = w.periods.map((p) => '<tr>'
            + `<th><b>${esc(String(p.ordinal))}. час</b><small>${esc(p.startsAt)}</small></th>`
            + days.map((d) => {
                const list = slots.get(d + '|' + p.ordinal) || [];
                const one = list[0] || null;
                if (!on) return '<td>' + readCellHtml(entries(list), data) + '</td>';
                // While typing a week in, the cell grows with its pickers: room
                // to choose matters more there than a level row.
                const read = entries(list).map((e) =>
                    `<div class="p-${e.kind}"><b>${esc(e.text)}</b><small>${esc(e.sub)}</small></div>`).join('');
                return `<td class="p-cell" data-teacher="${esc(name)}" data-day="${esc(d)}" data-ordinal="${p.ordinal}"`
                    + ` data-class="${esc(one ? one.class || '' : '')}" data-subject="${esc(one ? tidy(one.subject) : '')}">`
                    + editCellHtml(data, name, d, p, list) + read + '</td>';
            }).join('')
            + '</tr>').join('');
        const hint = !on ? ''
            : homeroom
                ? `<p class="p-edithint">🔓 Отворено за внес. Одделенски наставник: паралелката е <b>${esc(homeroom)}</b> — во ќелијата се бира само предметот. `
                  + 'Се запишува веднаш во базата; „✕ слободен час" го брише часот.</p>'
                : '<p class="p-edithint">🔓 Отворено за внес. Предметен наставник: изберете паралелка (своите прво), па предмет од своите. '
                  + 'Се запишува веднаш во базата; „— слободен —" го брише часот. Под часот останува кој ученик излегува на третман.</p>';
        const shown = mode();
        const modes = modesHtml();
        return `<section class="personal show-${shown}${on ? ' editing' : ''}" data-teacher="${esc(name)}">`
            + `<div class="p-head"><h3>Неделен распоред — ${esc(name)}</h3><div class="p-sub">${esc(sub)}</div></div>`
            + modes
            + `<table class="p-grid${lock ? ' lockable' : ''}"><thead><tr><th>${lock}Час</th>`
            + days.map((d) => `<th>${esc(cap(d))}</th>`).join('') + '</tr></thead>'
            + `<tbody>${body}</tbody></table>`
            + (lessons || on ? '' : '<p class="quiet">Сè уште нема ниту еден час во распоредот. Отклучете 🔒 за да се внесе.</p>')
            + hint
            + `<div class="p-foot"><span>${esc(o.footer || '')}</span>`
            + (o.png && window.MTBScheduleForm ? `<button type="button" class="btn soft p-png" data-png="${esc(name)}">🖼 Слика</button>` : '')
            + '</div></section>';
    }

    // ── writing ─────────────────────────────────────────────────────────────
    /** The server's refusal, in the sentence the staff room reads. */
    function sorry(res, body) {
        if (body && body.code === 'teacher-clash') return 'Овој наставник веќе има два часа во тој термин. Избриши го едниот во „Уреди настава".';
        if (body && body.code === 'class-taken') {
            const who = (body.here || []).map((h) => h.teacher).filter(Boolean).join(', ');
            return `${body.class || 'Паралелката'} веќе има час во тој термин${who ? ', кај ' + who : ''}.`;
        }
        if (body && body.code === 'stale') return 'Некој друг го смени овој час во меѓувреме — прикажано е што стои сега.';
        return (body && body.error) || ('HTTP ' + (res ? res.status : '?'));
    }

    const say = (state, text) => window.dispatchEvent(new CustomEvent('mtb:data-state', { detail: { state, text } }));
    const toast = (text, kind) => { const n = window.MTBAppNavigation; if (n && n.toast) n.toast(text, kind); };

    /** One period through the one route; a refusal is thrown as the sentence `sorry` makes of it. */
    async function putLesson(base, payload) {
        const res = await fetch(base + '/api/teaching/teacher-lesson', {
            method: 'PUT',
            cache: 'no-store',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        let body = null;
        try { body = await res.json(); } catch (_) { /* not JSON */ }
        if (!res.ok) throw Object.assign(new Error(sorry(res, body)), { body });
        return body;
    }

    async function save(ctx, td, changed, together, typed) {
        const data = ctx.data();
        const base = ctx.apiBase();
        const teacher = td.dataset.teacher;
        const day = td.dataset.day;
        const ordinal = Number(td.dataset.ordinal);
        const was = td.dataset.class || '';
        const wasSubject = td.dataset.subject || '';
        const fixed = fixedClass(data, teacher);
        const picked = typed !== undefined ? typed : changed.classList.contains('p-subj') ? changed.value : '';
        // „✕ слободен час" empties the period; an одделенски's period is in
        // their own class; a предметен picks the class, then the subject.
        const cls = picked === '__clear' ? ''
            : fixed ? (was || fixed)
            : td.querySelector('.p-class').value;
        // A new class keeps the subject the period had, or the teacher's only
        // one; a subject is chosen for the class already in the cell.
        const subject = picked === '__clear' ? ''
            : typed === undefined && changed.classList.contains('p-class') ? (cls ? wasSubject || autoSubject(data, teacher) : '')
            : picked;
        // An одделенски's empty period is written only once a subject is chosen.
        if (fixed && !was && !subject && picked !== '__clear') return;
        td.classList.add('saving');
        td.querySelectorAll('select').forEach((s) => { s.disabled = true; });
        const saying = `${teacher} · ${day} · ${ordinal}. час`;
        say('saving', 'Се запишува: ' + saying);
        try {
            const lesson = { year: data.year, day, ordinal, teacher };
            await putLesson(base, {
                ...lesson, class: cls || null, subject: subject || null,
                expected: { class: was || null },
                ...(together ? { together: true } : {})
            });
            await ctx.reload();
            const nav = window.MTBAppNavigation;
            // „Врати": the same route, the other way round, with what THIS
            // write left as `expected` — a period somebody changed since is
            // refused, not overwritten. A period that was co-taught before
            // is not forced back; the refusal says the class is taken.
            if (nav && nav.undo) {
                const turn = async (to, from) => {
                    await putLesson(base, {
                        ...lesson, class: to.cls || null, subject: to.subject || null,
                        expected: { class: from || null },
                        ...(to.together ? { together: true } : {})
                    });
                    await ctx.reload();
                };
                nav.undo.record({
                    label: saying,
                    undo: () => turn({ cls: was, subject: wasSubject }, cls),
                    redo: () => turn({ cls, subject, together }, was)
                });
            }
            const now = ctx.data() || data;
            const label = cls && nav && nav.classes && classCards(now).has(cls) ? nav.classes.short(classCards(now).get(cls)) : cls;
            const done = cls ? `${saying} — ${label}${subject ? ' · ' + subject : ''}` : `${saying} — слободен`;
            toast('Зачувано: ' + done, 'synced');
            say('synced', 'Зачувано во базата: ' + done);
        } catch (err) {
            // Two teachers in one class at one hour is allowed when it is
            // co-teaching (physical education in the lower classes) — the
            // person says so; the server still allows only one other teacher.
            if (!together && err.body && err.body.code === 'class-taken' && (err.body.here || []).length === 1
                && window.confirm(err.message + '\n\nДа се запише како заеднички час (двајца наставници во иста паралелка)?')) {
                return save(ctx, td, changed, true, typed);
            }
            say('error', err.message);
            toast(err.message, 'error');
            if (ctx.status) ctx.status(err.message, 'error');
            // Stale or refused: what is in the database now, never the guess.
            if (err.body && err.body.code === 'stale') await ctx.reload(); else ctx.redraw();
        }
    }

    /**
     * A subject the lists do not have yet: typed once in the cell, written
     * into the lesson, and added to that teacher's own subjects (Податоци's
     * field), so it is offered from then on — here, in Уреди настава and on Kolega.
     */
    async function addOwnSubject(ctx, name, subject) {
        const data = ctx.data();
        const t = teacherOf(data, name);
        const own = ownSubjects(data, name);
        if (!t || !t.id || own.some((x) => x.toLowerCase() === subject.toLowerCase())) return;
        try {
            const res = await fetch(ctx.apiBase() + '/api/teaching/teacher/' + t.id, {
                method: 'PUT', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ subject: own.concat(subject).join(', ') })
            });
            if (res.ok) t.subject = own.concat(subject).join(', ');
        } catch (_) { /* the lesson is still written; the list can be filled in Податоци */ }
    }

    function typeSubject(ctx, td, select) {
        const input = document.createElement('input');
        input.className = 'p-other';
        input.placeholder = 'нов предмет';
        input.setAttribute('aria-label', select.getAttribute('aria-label') || 'предмет');
        select.replaceWith(input);
        input.focus();
        let done = false;
        const finish = async (commit) => {
            if (done) return;
            done = true;
            const typed = tidy(input.value);
            if (!commit || !typed) { ctx.redraw(); return; }
            await addOwnSubject(ctx, td.dataset.teacher, typed);
            save(ctx, td, input, false, typed);
        };
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); finish(true); }
            if (e.key === 'Escape') { e.preventDefault(); finish(false); }
        });
        input.addEventListener('blur', () => finish(true));
    }

    /**
     * ctx.data()     the crossing the sheet was drawn from
     * ctx.reload()   read it again and redraw (after a write)
     * ctx.redraw()   draw again from what is held
     * ctx.apiBase()  the chosen server
     * ctx.status(t, kind)  optional: the page's own status line
     */
    function attach(root, ctx) {
        root.addEventListener('change', (event) => {
            const pick = event.target.closest('.p-edit select');
            if (!pick) return;
            const td = pick.closest('.p-cell');
            if (!td) return;
            if (pick.value === '__other') { typeSubject(ctx, td, pick); return; }
            save(ctx, td, pick);
        });
        root.addEventListener('click', (event) => {
            const lock = event.target.closest('[data-p-lock]');
            if (!lock || !window.MTBForms) return;
            event.stopPropagation();
            // The suite's one switch: the page redraws on `mtb:editing`.
            window.MTBForms.setEditing(!window.MTBForms.editing());
        });
    }

    // ── the same sheet as a picture or a Word file ──────────────────────────
    /**
     * What a cell says in the view chosen on the sheet („Часови и кабинети",
     * „Само предмети", „Само кабинети"). The screen hides the other kind with
     * CSS; a picture and a Word file have no CSS to hide with, so they ask
     * here — one answer, or the paper and the screen would disagree.
     */
    function shownEntries(list, chosen) {
        const m = chosen || mode();
        return (list || []).filter((e) => m === 'all' || (m === 'subjects' ? e.kind === 'lesson' : e.kind === 'away'));
    }
    const modeLabel = (chosen) => (MODES.find(([k]) => k === (chosen || mode())) || MODES[0])[1];

    /*
     * Word: HTML that Word opens as a document (.doc), as Кабинети and
     * Евидентен лист already do — no library from a CDN, and the file stays
     * editable. The widths are Кабинети's, measured in Word itself (7 Oct
     * 2026): a table in points marked fixed, NO percentage width, and a width
     * on every cell, or Word resizes the columns to their content. A landscape
     * A4 has 786pt inside its margins: a 62pt column for the period and the
     * days share the rest. Row height is „at least": two long names make a
     * row taller rather than being cut off.
     */
    const WORD_TIME_PT = 62, WORD_BODY_PT = 720;
    const wordPx = (pt) => Math.round(pt * 96 / 72);
    /*
     * One sheet, one page. Opened in Word itself (7 Oct 2026): a cell with a
     * lesson and several therapies made its row taller than the minimum, the
     * sheet grew past the page and its footer landed alone on the next one.
     * A sheet that fits is left exactly as it was — every row the same. One
     * that does not gives its busy rows what they need and lets the quiet
     * ones share what is left of WORD_FIT_PT; if that is still too much, it is
     * set in smaller letters. What a row needs is an estimate (Word wraps the
     * text, not this file), checked against Word's own measurements of
     * twelve real sheets; the page holds about 20pt more than WORD_FIT_PT.
     */
    const WORD_FIT_PT = 390, WORD_ROW_MIN = 28, WORD_TIGHT = 0.86;
    function wordRowNeeds(sheet, dayPt, scale) {
        const lines = (text, perLine) => Math.max(1, Math.ceil(String(text || '').length / perLine));
        // Calibri in Cyrillic: about half the letter size for each character.
        const inner = dayPt - 8, main = 10 * scale, sub = 8 * scale;
        const entry = (e) => lines(e.text, inner / (main * 0.52)) * main * 1.22
            + (e.sub ? lines(e.sub, inner / (sub * 0.47)) * sub * 1.22 : 0) + 3;
        return sheet.rows.map((r, i) => Math.max(0,
            ...sheet.days.map((d, j) => ((sheet.cells[i] || [])[j] || []).reduce((sum, e) => sum + entry(e), 0))));
    }
    const wordRowsTotal = (needs, rowPt) => needs.reduce((sum, need) => sum + Math.max(rowPt, need), 0);
    /** The height the quiet rows share once the busy ones have taken theirs. */
    function wordRowLevel(needs) {
        let left = WORD_FIT_PT, rows = needs.length;
        for (const need of [...needs].sort((a, b) => b - a)) {
            if (need * rows <= left) break;
            left -= need;
            rows--;
        }
        return Math.max(WORD_ROW_MIN, Math.floor(rows ? left / rows : 0));
    }
    function wordSheetHtml(sheet) {
        const dayPt = Math.floor(WORD_BODY_PT / Math.max(1, sheet.days.length));
        const total = WORD_TIME_PT + dayPt * sheet.days.length;
        const td = (pt, cls) => `<td width="${wordPx(pt)}" style="width:${pt}pt"${cls ? ` class="${cls}"` : ''}>`;
        const col = (pt) => `<col width="${wordPx(pt)}" style="width:${pt}pt">`;
        let rowPt = Math.max(40, Math.min(72, Math.floor(360 / Math.max(1, sheet.rows.length))));
        let needs = wordRowNeeds(sheet, dayPt, 1);
        const fits = wordRowsTotal(needs, rowPt) <= WORD_FIT_PT;
        const tight = !fits && wordRowsTotal(needs, WORD_ROW_MIN) > WORD_FIT_PT;
        if (tight) needs = wordRowNeeds(sheet, dayPt, WORD_TIGHT);
        if (!fits) rowPt = Math.min(rowPt, wordRowLevel(needs));
        // Inline, because Word does not follow a selector like `table.tight p`.
        const size = (pt) => (tight ? ` style="font-size:${(pt * WORD_TIGHT).toFixed(1)}pt"` : '');
        const cell = (list) => {
            if (!list.length) return td(dayPt, 'free') + '—</td>';
            return td(dayPt) + list.map((e) => `<p class="${e.kind === 'away' ? 'away' : 'lesson'}"${size(10)}><b>${esc(e.text)}</b>`
                + (e.sub ? `<br><span class="sub"${size(8)}>${esc(e.sub)}</span>` : '') + '</p>').join('') + '</td>';
        };
        return `<h1>${esc(sheet.title)}</h1><h3>${esc(sheet.subtitle || '')}</h3>`
            + `<table width="${wordPx(total)}" style="width:${total}pt;table-layout:fixed;mso-table-layout-alt:fixed">`
            + '<colgroup>' + col(WORD_TIME_PT) + sheet.days.map(() => col(dayPt)).join('') + '</colgroup>'
            + `<thead><tr><th style="width:${WORD_TIME_PT}pt">Час</th>`
            + sheet.days.map((d) => `<th style="width:${dayPt}pt">${esc(cap(d))}</th>`).join('') + '</tr></thead><tbody>'
            + sheet.rows.map((r, i) => `<tr style="height:${rowPt}pt;mso-height-rule:at-least">`
                + td(WORD_TIME_PT, 'slot') + `<b class="big">${esc(r.label)}</b><br><span class="sub">${esc(r.time || '')}</span></td>`
                + sheet.days.map((d, j) => cell((sheet.cells[i] || [])[j] || [])).join('') + '</tr>').join('')
            + '</tbody></table>'
            + (sheet.note ? `<p class="note">${esc(sheet.note)}</p>` : '');
    }

    /** sheets: [{ title, subtitle, note, days, rows: [{label, time}], cells: [[entries]] }], one page each. */
    function wordDoc(sheets, footer) {
        // Word reads page size and orientation only from a named @page that a
        // section div points at; a plain `@page{size:landscape}` is ignored.
        const css = '@page Sheet{size:841.9pt 595.3pt;mso-page-orientation:landscape;margin:28pt;}div.Sheet{page:Sheet;}'
            + 'body{font-family:Calibri,Arial,sans-serif;font-size:10pt;color:#222;}'
            + 'h1{font-size:16pt;text-align:center;margin:0 0 2pt;}'
            + 'h3{font-size:10pt;text-align:center;margin:0 0 8pt;color:#666;font-weight:normal;}'
            + 'table{border-collapse:collapse;}'
            + 'th,td{border:1px solid #bbb;padding:3pt 4pt;vertical-align:top;}'
            + 'th{background:#e8eaf6;text-align:center;font-size:10pt;}'
            + 'td.slot{background:#f3f4f6;text-align:center;vertical-align:middle;}'
            + '.big{font-size:12pt;}'
            + 'td.free{color:#bbb;text-align:center;vertical-align:middle;}'
            + 'p.lesson,p.away{margin:0 0 3pt;}'
            + 'p.away{color:#7b341e;}'
            + '.sub{color:#555;font-size:8pt;}'
            + '.note{font-size:9pt;color:#666;margin:6pt 0 0;}'
            + '.footer{text-align:center;font-size:8pt;color:#999;margin-top:8pt;}';
        const foot = footer ? `<p class="footer">${esc(footer)}</p>` : '';
        // Word breaks a page on this exact element; CSS break-before is ignored.
        const pageBreak = '<br clear="all" style="page-break-before:always">';
        return '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" '
            + 'xmlns="http://www.w3.org/TR/REC-html40" lang="mk"><head><meta charset="UTF-8"><title>Распоред</title>'
            + '<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View></w:WordDocument></xml><![endif]-->'
            + `<style>${css}</style></head><body><div class="Sheet">`
            + sheets.map((sheet) => wordSheetHtml(sheet) + foot).join(pageBreak)
            + '</div></body></html>';
    }

    function downloadWord(sheets, file, footer) {
        const blob = new Blob(['﻿' + wordDoc(sheets, footer)], { type: 'application/msword' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = String(file || 'Raspored').replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, '_') + '.doc';
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(link.href), 4000);
        return link.download;
    }

    window.MTBTeacherWeek = {
        DAYS, SCHOOL, NOBODY,
        week, teacherRows, entries, sheetHtml, attach, loadOffers, choosing, editing,
        readCellHtml, modesHtml, mode, tints,
        shownEntries, modeLabel, wordDoc, downloadWord
    };
})();

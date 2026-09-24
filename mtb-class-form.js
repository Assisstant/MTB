/**
 * A class's weekly timetable as a form its homeroom teacher fills in without
 * the app (docs/PLAN-formulari.md, step 3).
 *
 * The same shape as the cabinet form (`mtb-schedule-form.js`, which must be
 * loaded first — the look and the picture are shared from there):
 *
 *   buildForm(data)   → ONE standalone page for all the classes of a year. A
 *                       dropdown at the top — class · homeroom — shows that
 *                       class's week: a subject per period, the teacher
 *                       optional; the full subject list as a checklist that
 *                       only FILTERS what the cells offer (owner: nothing new
 *                       is stored); the pupils, read only, each with „this is
 *                       wrong" (owner: report only, the administrator moves
 *                       them in Податоци); „🖼 Слика".
 *   plan(reply, ctx)  → what that answer would change. Pure. The review
 *                       queue reads answers with this and nothing else.
 *
 * A cell is (day, period) of ONE class; the key is `day|ordinal`. The answer
 * carries each cell as the form showed it (`baseline`), so a cell somebody
 * changed in Уреди настава since the form was made is reported and left
 * alone — the `expected` of PUT /api/teaching/lesson, carried by e-mail.
 *
 * The class is named by its LABEL, not its id: ids differ between WORK, HOME
 * and the cloud, the label is global (`school_classes.label`).
 */
(function () {
    'use strict';

    const FORM = 'mtb-class-form';
    const REPLY = 'mtb-class-reply';
    const VERSION = 1;

    const cellKey = (day, ordinal) => day + '|' + ordinal;
    const tidy = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
    const low = (v) => tidy(v).toLocaleLowerCase('mk-MK');
    /** A cell is {subject, teacher}, either may be null; both null is an empty cell. */
    const norm = (cell) => {
        if (!cell) return null;
        const subject = tidy(cell.subject) || null;
        const teacher = tidy(cell.teacher) || null;
        return subject || teacher ? { subject, teacher } : null;
    };
    const sameCell = (a, b) => {
        const x = norm(a), y = norm(b);
        if (!x || !y) return !x && !y;
        return low(x.subject) === low(y.subject) && low(x.teacher) === low(y.teacher);
    };

    /* ── The page the homeroom teacher opens ──────────────────────────────── */

    function classMain() {
        const data = JSON.parse(document.getElementById('formData').textContent);
        const OTHER = '__other__';
        const draftKey = 'mtb-class-form:' + data.generatedAt;
        const keyOf = (day, ordinal) => day + '|' + ordinal;
        const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
        const tidy = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
        const el = (id) => document.getElementById(id);
        const surname = (name) => { const p = tidy(name).split(' '); return p.length > 1 ? p.slice(1).join(' ') : p[0] || ''; };

        let draft = { who: data.selected || '', classes: {} };
        try {
            const saved = JSON.parse(localStorage.getItem(draftKey) || 'null');
            if (saved && saved.classes) draft = saved;
        } catch (_) { /* a draft is a convenience; the form works without one */ }
        const keep = () => { try { localStorage.setItem(draftKey, JSON.stringify(draft)); } catch (_) { /* ignore */ } };

        const chosen = () => data.classes.find((c) => c.label === draft.who) || null;
        function mine() {
            const c = chosen();
            if (!c) return null;
            if (!draft.classes[c.label]) {
                const cells = {};
                Object.keys(c.lessons).forEach((k) => { cells[k] = Object.assign({}, c.lessons[k]); });
                const used = Object.values(c.lessons).map((l) => l.subject).filter(Boolean);
                const ticks = Array.from(new Set(c.offered.concat(used)));
                draft.classes[c.label] = { cells, ticks, reports: {}, note: '' };
            }
            return draft.classes[c.label];
        }
        const cellText = (cell) => cell ? (cell.subject || '(без предмет)') + (cell.teacher ? ' · ' + cell.teacher : '') : '';
        const differs = (a, b) => cellText(a) !== cellText(b);

        function changedCount() {
            const c = chosen(), s = mine();
            if (!c) return 0;
            const keys = new Set(Object.keys(c.lessons).concat(Object.keys(s.cells)));
            return Array.from(keys).filter((k) => differs(s.cells[k], c.lessons[k])).length
                + Object.values(s.reports).filter((r) => tidy(r)).length;
        }

        function subjectOptions(s, current) {
            const list = data.subjects.filter((x) => s.ticks.includes(x));
            if (current && !list.includes(current)) list.unshift(current);
            return '<option value="">— празно —</option>' + list.map((x) =>
                '<option' + (x === current ? ' selected' : '') + '>' + esc(x) + '</option>').join('')
                + '<option value="' + OTHER + '">✎ друг предмет…</option>';
        }
        function teacherOptions(current) {
            const list = data.teachers.slice();
            if (current && !list.includes(current)) list.unshift(current);
            return '<option value="">наставник: —</option>' + list.map((x) =>
                '<option' + (x === current ? ' selected' : '') + '>' + esc(x) + '</option>').join('');
        }

        function drawWho() {
            el('who').innerHTML = '<option value="">— избери го одделението —</option>' + data.classes.map((c) =>
                '<option value="' + esc(c.label) + '"' + (c.label === draft.who ? ' selected' : '') + '>'
                + esc(c.label + (c.homeroom ? ' · ' + surname(c.homeroom) : '')) + '</option>').join('');
        }

        function drawGrid(c, s) {
            const head = '<tr><th class="slot">Час</th>' + data.days.map((d) => '<th>' + esc(d.charAt(0).toUpperCase() + d.slice(1)) + '</th>').join('') + '</tr>';
            const rows = data.periods.map((p) => '<tr><td class="slot"><b>' + esc(p.label) + '</b><small>' + esc(String(p.time || '').replace('-', ' – ')) + '</small></td>' +
                data.days.map((day) => {
                    const k = keyOf(day, p.ordinal);
                    if ((c.doubled || []).includes(k)) return '<td><span class="locked">Два часа во ова поле — се средува во Уреди настава.</span></td>';
                    const cell = s.cells[k] || null;
                    const changed = differs(cell, c.lessons[k]);
                    let html = '<div class="cellpick"><select data-key="' + esc(k) + '" data-part="subject" title="Предмет">'
                        + subjectOptions(s, cell && cell.subject) + '</select></div>';
                    if (cell) html += '<div class="cellpick" style="margin-top:4px"><select data-key="' + esc(k) + '" data-part="teacher" title="Наставник (по избор)">'
                        + teacherOptions(cell.teacher) + '</select></div>';
                    return '<td' + (changed ? ' class="changed"' : '') + '>' + html + '</td>';
                }).join('') + '</tr>').join('');
            el('grid').innerHTML = '<table class="week"><thead>' + head + '</thead><tbody>' + rows + '</tbody></table>';
        }

        function drawTicks(s) {
            const find = tidy(el('findSubject').value).toLocaleLowerCase('mk-MK');
            const ticked = new Set(s.ticks);
            el('subjects').innerHTML = '<div class="group">' + data.subjects
                .filter((x) => !find || x.toLocaleLowerCase('mk-MK').includes(find))
                .map((x) => '<label class="' + (ticked.has(x) ? 'on' : '') + '"><input type="checkbox" data-subject="' + esc(x) + '"'
                    + (ticked.has(x) ? ' checked' : '') + '> <span>' + esc(x) + '</span></label>').join('') + '</div>';
            el('tickCount').textContent = s.ticks.length;
        }

        function drawPupils(c, s) {
            el('pupils').innerHTML = c.pupils.length
                ? '<table class="reports"><tbody>' + c.pupils.map((p) => {
                    const text = s.reports[p.name] || '';
                    return '<tr' + (tidy(text) ? ' class="flag"' : '') + '><td>' + esc(p.name) + '</td><td>' + esc(p.generation ? 'генерација ' + p.generation : '') + '</td>'
                        + '<td><input type="text" data-report="' + esc(p.name) + '" value="' + esc(text) + '" placeholder="Ако нешто не е точно: на пр. „е во III-а“, „се отпиша“"></td></tr>';
                }).join('') + '</tbody></table>'
                : '<p class="hint">Во базата нема ученици запишани во ова одделение.</p>';
        }

        function draw() {
            drawWho();
            const c = chosen();
            el('work').style.display = c ? '' : 'none';
            el('pickFirst').style.display = c ? 'none' : '';
            el('heading').textContent = '🏫 Неделен распоред' + (c ? ' — ' + c.label : ' на одделенијата');
            if (!c) return;
            const s = mine();
            el('facts').textContent = [c.homeroom ? 'одделенски раководител: ' + c.homeroom : 'без одделенски раководител',
                c.description || '', c.pupils.length + ' ученици'].filter(Boolean).join(' · ');
            drawGrid(c, s);
            drawTicks(s);
            drawPupils(c, s);
            el('count').textContent = changedCount();
            el('note').value = s.note || '';
        }

        el('who').addEventListener('change', () => { draft.who = el('who').value; keep(); draw(); });
        el('grid').addEventListener('change', (event) => {
            const select = event.target.closest('select[data-key]');
            if (!select) return;
            const s = mine();
            const k = select.dataset.key;
            const cell = Object.assign({ subject: null, teacher: null }, s.cells[k] || {});
            if (select.dataset.part === 'subject') {
                let value = select.value;
                if (value === OTHER) {
                    value = tidy(window.prompt('Кој предмет? (како што се вика во наставниот план)', '') || '');
                    if (!value) { draw(); return; }
                    if (!data.subjects.includes(value)) data.subjects.push(value);
                    if (!s.ticks.includes(value)) s.ticks.push(value);
                }
                if (!value) { delete s.cells[k]; keep(); draw(); return; }
                cell.subject = value;
            } else cell.teacher = select.value || null;
            s.cells[k] = cell;
            keep(); draw();
        });
        el('subjects').addEventListener('change', (event) => {
            const box = event.target.closest('input[data-subject]');
            if (!box) return;
            const s = mine();
            const x = box.dataset.subject;
            s.ticks = box.checked ? s.ticks.concat(x) : s.ticks.filter((y) => y !== x);
            keep(); drawTicks(s); drawGrid(chosen(), s);
        });
        el('findSubject').addEventListener('input', () => { const s = mine(); if (s) drawTicks(s); });
        el('pupils').addEventListener('input', (event) => {
            const box = event.target.closest('input[data-report]');
            if (!box) return;
            const s = mine();
            s.reports[box.dataset.report] = box.value;
            box.closest('tr').classList.toggle('flag', !!tidy(box.value));
            el('count').textContent = changedCount();
            keep();
        });
        el('note').addEventListener('input', (event) => { const s = mine(); if (s) { s.note = event.target.value; keep(); } });
        el('reset').addEventListener('click', () => {
            const c = chosen();
            if (!c || !window.confirm('Да се врати распоредот како што беше испратен? Твоите промени ќе се избришат.')) return;
            delete draft.classes[c.label];
            keep(); draw();
        });
        el('image').addEventListener('click', () => {
            const c = chosen(), s = mine();
            if (!c) return;
            paintGrid({
                title: 'Неделен распоред — ' + c.label,
                subtitle: (data.school || '') + ' · учебна ' + data.year + (c.homeroom ? ' · одделенски раководител: ' + c.homeroom : ''),
                days: data.days,
                rows: data.periods,
                cells: data.periods.map((p) => data.days.map((day) => {
                    const cell = s.cells[keyOf(day, p.ordinal)];
                    return cell ? [{ text: cell.subject || '(без предмет)', sub: cell.teacher || '' }] : [];
                })),
                footer: 'Од формулар · ' + new Date().toLocaleDateString('mk-MK') + (changedCount() ? ' · со промени што уште не се прифатени' : ''),
                file: 'Распоред — ' + c.label + '.png'
            });
        });
        el('save').addEventListener('click', () => {
            const c = chosen(), s = mine();
            if (!c) return;
            const reply = {
                kind: data.replyKind, version: data.version, year: data.year,
                class: { id: c.id, label: c.label }, homeroom: c.homeroom || null,
                formGeneratedAt: data.generatedAt, savedAt: new Date().toISOString(),
                baseline: c.lessons, cells: s.cells, subjects: s.ticks,
                reports: c.pupils.filter((p) => tidy(s.reports[p.name]))
                    .map((p) => ({ name: p.name, generation: p.generation || null, text: tidy(s.reports[p.name]) })),
                note: s.note || ''
            };
            const blob = new Blob([JSON.stringify(reply, null, 2)], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'Одделение-одговор — ' + c.label + ' — ' + new Date().toISOString().slice(0, 10) + '.json';
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(a.href), 2000);
            el('savedMsg').textContent = '✓ Зачувано. Испрати ја датотеката „' + a.download + '".';
        });
        draw();
    }

    /**
     * data: { school, year, generatedAt, days, periods: [{ordinal, label, time}],
     *         subjects: [name], teachers: [name],
     *         classes: [{id, label, description, homeroom, lessons: {key: {subject, teacher}},
     *                    doubled: [key], offered: [subject], pupils: [{name, generation}]}],
     *         selected: label or null }
     */
    function buildForm(data) {
        const kit = window.MTBScheduleForm;
        if (!kit || !kit.page) throw new Error('mtb-schedule-form.js must be loaded before mtb-class-form.js');
        const payload = Object.assign({}, data, { kind: FORM, replyKind: REPLY, version: VERSION });
        const body =
            '<div class="help"><b>Како се пополнува</b><ol>' +
            '<li>Горе избери го <b>своето одделение</b>. Ќе се појави неговиот неделен распоред каков што е во базата.</li>' +
            '<li>Во секој час избери го предметот; наставникот е по избор. „— празно —" значи дека тогаш нема час.</li>' +
            '<li>Во „Предмети" штиклирај ги предметите на одделението — само за полесно избирање; ништо не се запишува од штиклирањето.</li>' +
            '<li>Кај „Ученици", ако нешто не е точно, напиши што. Учениците не се менуваат од тука — администраторот ги поправа.</li>' +
            '<li>Кога ќе завршиш, „💾 Зачувај го одговорот" и испрати ја зачуваната <b>.json</b> датотека назад. „🖼 Слика" ја зачувува неделата како слика.</li>' +
            '</ol>Промените се чуваат во овој прелистувач додека не го зачуваш одговорот; оваа страница не праќа ништо никаде.</div>' +
            '<div class="who"><label for="who">Одделение:</label><select id="who"></select><span class="facts" id="facts"></span></div>' +
            '<p class="empty" id="pickFirst">Избери го одделението погоре.</p>' +
            '<div id="work">' +
            '<div class="bar"><button class="btn" id="save" type="button">💾 Зачувај го одговорот</button>' +
            '<button class="btn soft" id="image" type="button">🖼 Слика</button>' +
            '<button class="btn soft" id="reset" type="button">↺ Врати како што беше</button>' +
            '<span>Промени: <span class="count" id="count">0</span></span> <span class="saved" id="savedMsg"></span></div>' +
            '<div class="scroll" id="grid"></div>' +
            '<section class="part"><h2>Предмети (<span id="tickCount">0</span>)</h2>' +
            '<p class="hint">Штиклирано = се нуди во часовите. Целиот список од наставните планови.</p>' +
            '<div class="find"><input type="search" id="findSubject" placeholder="Барај предмет…"></div>' +
            '<div class="checks" id="subjects"></div></section>' +
            '<section class="part"><h2>Ученици</h2><p class="hint">Само за проверка. Ако некое дете не е во ова одделение или нешто друго не е точно, напиши во неговиот ред.</p>' +
            '<div id="pupils"></div></section>' +
            '<section class="part"><h2>Белешка (по избор)</h2><textarea id="note" placeholder="На пр. од кога важи, или што треба да се провери."></textarea></section>' +
            '</div>';
        const one = data.classes.length === 1 ? data.classes[0].label : '';
        return kit.page(
            'Неделен распоред' + (one ? ' — ' + one : ' — одделенија'),
            '🏫 Неделен распоред' + (one ? ' — ' + one : ' на одделенијата'),
            (data.school || '') + ' · учебна ' + data.year + ' · формулар од ' + String(data.generatedAt).slice(0, 10),
            body, payload, classMain);
    }

    /* ── What an answer would change ──────────────────────────────────────── */

    /**
     * ctx: { year, classes: [label], validKeys: [key], doubled: [key],
     *        current: {key: {subject, teacher}}   — this class, now
     *        teachers: [name]                     — this year's staff
     *        busy: {key: [{teacher, class}]} }    — every class, now
     * Nothing here writes.
     */
    function plan(reply, ctx) {
        const out = { errors: [], class: null, homeroom: null, note: '', unchanged: 0, changes: [], conflicts: [], skipped: [], reports: [] };
        if (!reply || reply.kind !== REPLY) { out.errors.push('Ова не е одговор од формулар за одделение.'); return out; }
        if (reply.version !== VERSION) { out.errors.push('Непозната верзија на формуларот (' + reply.version + ').'); return out; }
        if (reply.year !== ctx.year) { out.errors.push('Формуларот е за учебна ' + reply.year + ', а е отворена ' + ctx.year + '.'); return out; }
        const label = tidy(reply.class && reply.class.label);
        if (!(ctx.classes || []).includes(label)) { out.errors.push('Одделението „' + label + '" не е на списокот за ' + ctx.year + '.'); return out; }
        out.class = label;
        out.homeroom = reply.homeroom || null;
        out.note = String(reply.note || '');

        const staff = new Map((ctx.teachers || []).map((t) => [low(t), t]));
        const valid = new Set(ctx.validKeys || []);
        const doubled = new Set(ctx.doubled || []);
        const cells = reply.cells || {};
        const baseline = reply.baseline || {};
        const keys = Array.from(new Set(Object.keys(cells).concat(Object.keys(baseline))));
        keys.forEach((key) => {
            let want = norm(cells[key]);
            const base = norm(baseline[key]);
            if (sameCell(want, base)) { out.unchanged++; return; }
            const [day, ord] = key.split('|');
            const ordinal = Number(ord);
            if (!valid.has(key)) { out.skipped.push({ key, day, ordinal, reason: 'тој час не постои во распоредот' }); return; }
            if (doubled.has(key)) { out.skipped.push({ key, day, ordinal, reason: 'во базата има два часа во ова поле — се средува во Уреди настава' }); return; }
            if (want && want.teacher) {
                const known = staff.get(low(want.teacher));
                if (!known) { out.skipped.push({ key, day, ordinal, reason: 'наставникот „' + want.teacher + '" не е на списокот за годината' }); return; }
                want = { subject: want.subject, teacher: known };
            }
            const current = norm((ctx.current || {})[key]);
            const reasons = [];
            if (want && want.teacher) {
                ((ctx.busy || {})[key] || []).forEach((b) => {
                    if (b.class !== label && low(b.teacher) === low(want.teacher)) reasons.push(want.teacher + ' веќе има час во ' + b.class + ' во тоа време');
                });
            }
            const change = { key, day, ordinal, from: current, to: want, reasons };
            if (!sameCell(current, base)) {
                if (sameCell(current, want)) { out.unchanged++; return; }
                out.conflicts.push(Object.assign(change, { baseline: base }));
                return;
            }
            out.changes.push(change);
        });
        (reply.reports || []).forEach((r) => {
            const name = tidy(r && r.name), text = tidy(r && r.text);
            if (name && text) out.reports.push({ name, generation: r.generation || null, text });
        });
        return out;
    }

    window.MTBClassForm = Object.freeze({ FORM, REPLY, VERSION, cellKey, norm, sameCell, buildForm, plan });
})();

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
 *
 * The same file also holds the TEACHER form (`MTBTeacherForm`, below): each
 * teacher's own week, from which a class's week is read, not typed twice.
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

/**
 * A teacher's OWN week as a form (owner, 24 Sep 2026; docs/PLAN-formulari.md).
 *
 * Every teacher — одделенски, класен or subject-only — picks their name and
 * fills in, per period, WHICH CLASS and WHICH SUBJECT. The teacher is known,
 * so they never choose one. A class's week is not typed a second time: the
 * form shows it READ ONLY, put together from what everybody has entered, with
 * print and a picture, so anyone can see a class and see who has not filled in
 * their own week yet. (The class form above stays for the homeroom teacher who
 * prefers to fill the class in directly; both write the same `lessons` rows.)
 *
 * Two teachers in one class in one period is allowed when they teach the SAME
 * subject — physical education in the lower classes has two at once. A
 * different subject, or a third teacher, is a conflict for a person.
 */
(function () {
    'use strict';

    const FORM = 'mtb-teacher-form';
    const REPLY = 'mtb-teacher-reply';
    const VERSION = 1;

    const tidy = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
    const low = (v) => tidy(v).toLocaleLowerCase('mk-MK');
    /** A teacher's period: {class, subject}; no class means a free period. */
    const norm = (cell) => cell && tidy(cell.class) ? { class: tidy(cell.class), subject: tidy(cell.subject) || null } : null;
    const same = (a, b) => {
        const x = norm(a), y = norm(b);
        if (!x || !y) return !x && !y;
        return x.class === y.class && low(x.subject) === low(y.subject);
    };

    function teacherMain() {
        const data = JSON.parse(document.getElementById('formData').textContent);
        const OTHER = '__other__';
        const draftKey = 'mtb-teacher-form:' + data.generatedAt;
        const keyOf = (day, ordinal) => day + '|' + ordinal;
        const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
        const tidy = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
        const low = (v) => tidy(v).toLocaleLowerCase('mk-MK');
        const el = (id) => document.getElementById(id);
        const surname = (name) => { const p = tidy(name).split(' '); return p.length > 1 ? p.slice(1).join(' ') : p[0] || ''; };
        const cap = (d) => d.charAt(0).toUpperCase() + d.slice(1);

        let draft = { who: data.selected != null ? String(data.selected) : '', tab: 'mine', klass: '', people: {} };
        try {
            const saved = JSON.parse(localStorage.getItem(draftKey) || 'null');
            if (saved && saved.people) draft = Object.assign(draft, saved);
        } catch (_) { /* a draft is a convenience; the form works without one */ }
        const keep = () => { try { localStorage.setItem(draftKey, JSON.stringify(draft)); } catch (_) { /* ignore */ } };

        const teacher = () => data.teachers.find((t) => String(t.id) === String(draft.who)) || null;
        function mine() {
            const t = teacher();
            if (!t) return null;
            if (!draft.people[t.id]) {
                const cells = {};
                Object.keys(t.lessons).forEach((k) => { cells[k] = Object.assign({}, t.lessons[k]); });
                draft.people[t.id] = { cells, note: '' };
            }
            return draft.people[t.id];
        }
        const text = (c) => c ? c.class + ' · ' + (c.subject || '(без предмет)') : '';
        const changedCount = () => {
            const t = teacher(), s = mine();
            if (!t) return 0;
            const keys = new Set(Object.keys(t.lessons).concat(Object.keys(s.cells)));
            return Array.from(keys).filter((k) => text(s.cells[k]) !== text(t.lessons[k])).length;
        };
        const classLabel = (label) => { const c = data.classes.find((x) => x.label === label); return c && c.homeroom ? label + ' · ' + surname(c.homeroom) : label; };
        /** Everybody else in that class then — the hint under a cell. */
        const others = (key, label, me) => data.lessons.filter((l) => l.key === key && l.class === label && l.teacher !== me);

        /** Every lesson as it would stand with this teacher's draft in it. */
        function merged() {
            const t = teacher(), s = mine();
            if (!t) return data.lessons;
            return data.lessons.filter((l) => l.teacher !== t.name)
                .concat(Object.keys(s.cells).filter((k) => s.cells[k] && s.cells[k].class)
                    .map((k) => ({ key: k, class: s.cells[k].class, subject: s.cells[k].subject, teacher: t.name })));
        }

        function drawWho() {
            el('who').innerHTML = '<option value="">— избери го своето име —</option>' + data.teachers.map((t) =>
                '<option value="' + esc(t.id) + '"' + (String(t.id) === String(draft.who) ? ' selected' : '') + '>'
                + esc(t.name + (t.role ? ' · ' + t.role : '')) + '</option>').join('');
        }

        function subjectOptions(t, current) {
            const own = Array.from(new Set([t.subject].concat(Object.values(t.lessons).map((l) => l.subject)).filter(Boolean)));
            const rest = data.subjects.filter((x) => !own.includes(x));
            if (current && !own.includes(current) && !rest.includes(current)) own.unshift(current);
            const opt = (x) => '<option' + (x === current ? ' selected' : '') + '>' + esc(x) + '</option>';
            return '<option value="">— предмет —</option>'
                + (own.length ? '<optgroup label="Мои предмети">' + own.map(opt).join('') + '</optgroup>' : '')
                + '<optgroup label="Сите предмети">' + rest.map(opt).join('') + '</optgroup>'
                + '<option value="' + OTHER + '">✎ друг предмет…</option>';
        }

        function drawMine(t, s) {
            const head = '<tr><th class="slot">Час</th>' + data.days.map((d) => '<th>' + esc(cap(d)) + '</th>').join('') + '</tr>';
            const rows = data.periods.map((p) => '<tr><td class="slot"><b>' + esc(p.label) + '</b><small>' + esc(p.time || '') + '</small></td>' +
                data.days.map((day) => {
                    const k = keyOf(day, p.ordinal);
                    if ((t.doubled || []).includes(k)) return '<td><span class="locked">Во базата си во две одделенија во овој час — се средува во Уреди настава.</span></td>';
                    const cell = s.cells[k] || null;
                    const changed = text(cell) !== text(t.lessons[k]);
                    let html = '<div class="cellpick"><select data-key="' + esc(k) + '" data-part="class" title="Одделение">'
                        + '<option value="">— слободен час —</option>' + data.classes.map((c) =>
                            '<option value="' + esc(c.label) + '"' + (cell && cell.class === c.label ? ' selected' : '') + '>' + esc(classLabel(c.label)) + '</option>').join('')
                        + '</select></div>';
                    if (cell) {
                        html += '<div class="cellpick" style="margin-top:4px"><select data-key="' + esc(k) + '" data-part="subject" title="Предмет">'
                            + subjectOptions(t, cell.subject) + '</select></div>';
                        const with_ = others(k, cell.class, t.name);
                        if (with_.length) {
                            const together = with_.length === 1 && low(with_[0].subject) === low(cell.subject);
                            html += '<div class="' + (together ? 'with' : 'warn') + '">' + (together ? 'заедно со ' : '⚠ во тој час: ')
                                + esc(with_.map((w) => w.teacher + (together ? '' : ' — ' + (w.subject || 'без предмет'))).join(', ')) + '</div>';
                        }
                    }
                    return '<td' + (changed ? ' class="changed"' : '') + '>' + html + '</td>';
                }).join('') + '</tr>').join('');
            el('grid').innerHTML = '<table class="week"><thead>' + head + '</thead><tbody>' + rows + '</tbody></table>';
        }

        function drawKlass() {
            const pick = el('klassPick');
            const t = teacher();
            if (!draft.klass) draft.klass = (t && t.homeroomOf) || (data.classes[0] && data.classes[0].label) || '';
            pick.innerHTML = data.classes.map((c) => '<option value="' + esc(c.label) + '"' + (c.label === draft.klass ? ' selected' : '') + '>'
                + esc(classLabel(c.label)) + '</option>').join('');
            const all = merged().filter((l) => l.class === draft.klass);
            const head = '<tr><th class="slot">Час</th>' + data.days.map((d) => '<th>' + esc(cap(d)) + '</th>').join('') + '</tr>';
            const rows = data.periods.map((p) => '<tr><td class="slot"><b>' + esc(p.label) + '</b><small>' + esc(p.time || '') + '</small></td>' +
                data.days.map((day) => {
                    const here = all.filter((l) => l.key === keyOf(day, p.ordinal));
                    return '<td class="ro">' + here.map((l) => '<div class="lesson"><b>' + esc(l.subject || '(без предмет)') + '</b><small>' + esc(l.teacher || '') + '</small></div>').join('') + '</td>';
                }).join('') + '</tr>').join('');
            el('klassGrid').innerHTML = '<table class="week"><thead>' + head + '</thead><tbody>' + rows + '</tbody></table>';
            const who = Array.from(new Set(all.map((l) => l.teacher).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'mk'));
            el('klassWho').textContent = all.length
                ? all.length + ' часа неделно · наставници: ' + who.join(', ')
                : 'Никој уште не внел час во ова одделение.';
            el('klassTitle').textContent = classLabel(draft.klass);
        }

        function draw() {
            drawWho();
            const t = teacher();
            el('pickFirst').style.display = t ? 'none' : '';
            el('work').style.display = t ? '' : 'none';
            el('heading').textContent = '👩‍🏫 Мој распоред' + (t ? ' — ' + t.name : '');
            if (!t) return;
            const s = mine();
            document.querySelectorAll('[data-tab]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tab === draft.tab)));
            el('tabMine').style.display = draft.tab === 'mine' ? '' : 'none';
            el('tabKlass').style.display = draft.tab === 'klass' ? '' : 'none';
            el('facts').textContent = (t.role ? t.role + ' · ' : '') + Object.keys(t.lessons).length + ' часа во базата';
            drawMine(t, s);
            drawKlass();
            el('count').textContent = changedCount();
            el('note').value = s.note || '';
        }

        el('who').addEventListener('change', () => { draft.who = el('who').value; draft.klass = ''; keep(); draw(); });
        document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => { draft.tab = b.dataset.tab; keep(); draw(); }));
        el('klassPick').addEventListener('change', () => { draft.klass = el('klassPick').value; keep(); drawKlass(); });
        el('grid').addEventListener('change', (event) => {
            const select = event.target.closest('select[data-key]');
            if (!select) return;
            const t = teacher(), s = mine();
            const k = select.dataset.key;
            if (select.dataset.part === 'class') {
                if (!select.value) delete s.cells[k];
                else {
                    const was = s.cells[k] || {};
                    const guess = was.subject || t.subject || (Object.values(t.lessons).find((l) => l.class === select.value) || {}).subject || null;
                    s.cells[k] = { class: select.value, subject: guess };
                }
            } else {
                let value = select.value;
                if (value === OTHER) {
                    value = tidy(window.prompt('Кој предмет? (како што се вика во наставниот план)', '') || '');
                    if (!value) { draw(); return; }
                    if (!data.subjects.includes(value)) data.subjects.push(value);
                }
                s.cells[k] = { class: s.cells[k].class, subject: value || null };
            }
            keep(); draw();
        });
        el('note').addEventListener('input', (event) => { const s = mine(); if (s) { s.note = event.target.value; keep(); } });
        el('reset').addEventListener('click', () => {
            const t = teacher();
            if (!t || !window.confirm('Да се врати распоредот како што беше испратен? Твоите промени ќе се избришат.')) return;
            delete draft.people[t.id];
            keep(); draw();
        });
        el('image').addEventListener('click', () => {
            const t = teacher(), s = mine();
            if (!t) return;
            paintGrid({
                title: 'Мој распоред — ' + t.name,
                subtitle: (data.school || '') + ' · учебна ' + data.year,
                days: data.days, rows: data.periods,
                cells: data.periods.map((p) => data.days.map((day) => {
                    const c = s.cells[keyOf(day, p.ordinal)];
                    return c ? [{ text: c.class, sub: c.subject || '' }] : [];
                })),
                footer: 'Од формулар · ' + new Date().toLocaleDateString('mk-MK'),
                file: 'Распоред — ' + t.name + '.png'
            });
        });
        el('klassImage').addEventListener('click', () => {
            const all = merged().filter((l) => l.class === draft.klass);
            paintGrid({
                title: 'Распоред на паралелка — ' + draft.klass,
                subtitle: (data.school || '') + ' · учебна ' + data.year + ' · составен од личните распореди',
                days: data.days, rows: data.periods,
                cells: data.periods.map((p) => data.days.map((day) =>
                    all.filter((l) => l.key === keyOf(day, p.ordinal)).map((l) => ({ text: l.subject || '(без предмет)', sub: l.teacher || '' })))),
                footer: 'Од формулар · ' + new Date().toLocaleDateString('mk-MK'),
                file: 'Распоред — ' + draft.klass + '.png'
            });
        });
        el('klassPrint').addEventListener('click', () => { document.body.classList.add('print-klass'); window.print(); document.body.classList.remove('print-klass'); });
        el('save').addEventListener('click', () => {
            const t = teacher(), s = mine();
            if (!t) return;
            const reply = {
                kind: data.replyKind, version: data.version, year: data.year,
                teacher: { id: t.id, name: t.name },
                formGeneratedAt: data.generatedAt, savedAt: new Date().toISOString(),
                baseline: t.lessons, cells: s.cells, note: s.note || ''
            };
            const blob = new Blob([JSON.stringify(reply, null, 2)], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'Мој-распоред-одговор — ' + t.name + ' — ' + new Date().toISOString().slice(0, 10) + '.json';
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(a.href), 2000);
            el('savedMsg').textContent = '✓ Зачувано. Испрати ја датотеката „' + a.download + '".';
        });
        draw();
    }

    const TEACHER_CSS = `
        .tabs { display: flex; gap: 6px; margin: 4px 0 12px; }
        .tabs button { padding: 10px 20px; border: 1px solid #cbd5e0; border-radius: 10px; background: #f7fafc; color: #2d3748; font: inherit; font-size: 13px; font-weight: 700; letter-spacing: .8px; cursor: pointer; }
        .tabs button[aria-pressed="true"] { background: #4c51bf; color: #fff; border-color: #4c51bf; }
        .with { font-size: 12px; color: #276749; margin-top: 3px; }
        .warn { font-size: 12px; color: #9b2c2c; margin-top: 3px; font-weight: 600; }
        td.ro .lesson { background: #e6fffa; border-left: 4px solid #319795; border-radius: 6px; padding: 4px 8px; margin: 2px 0; }
        td.ro .lesson b { display: block; font-size: 13px; }
        td.ro .lesson small { font-size: 12px; color: #4a5568; }
        #klassTitle { display: none; }
        @media print {
            body.print-klass header, body.print-klass .help, body.print-klass .who, body.print-klass .tabs,
            body.print-klass .bar, body.print-klass #tabMine, body.print-klass .noprint { display: none !important; }
            body.print-klass #klassTitle { display: block; font-size: 20px; margin: 0 0 10px; }
            body.print-klass table.week { min-width: 0; }
        }
    `;

    /**
     * data: { school, year, generatedAt, days, periods: [{ordinal, label, time}],
     *         subjects: [name], classes: [{label, homeroom}],
     *         teachers: [{id, name, subject, role, homeroomOf, lessons: {key: {class, subject}}, doubled: [key]}],
     *         lessons: [{key, class, subject, teacher}]   — every lesson, for the class view
     *         selected: teacher id or null }
     */
    function buildForm(data) {
        const kit = window.MTBScheduleForm;
        if (!kit || !kit.page) throw new Error('mtb-schedule-form.js must be loaded before mtb-class-form.js');
        const payload = Object.assign({}, data, { kind: FORM, replyKind: REPLY, version: VERSION });
        const body = '<style>' + TEACHER_CSS + '</style>' +
            '<div class="help"><b>Како се пополнува</b><ol>' +
            '<li>Горе избери го <b>своето име</b>. Ќе се појави твојата недела каква што е во базата.</li>' +
            '<li>Во секој час избери <b>одделение</b> и <b>предмет</b>. „— слободен час —" значи дека тогаш немаш час.</li>' +
            '<li>Ако е точно како што стои, само зачувај — тоа е потврда. Ако со друг наставник држите ист час заедно (на пр. физичко), избери го истиот предмет.</li>' +
            '<li>„👁 Распоред на паралелка" покажува кој сè внел часови во некое одделение. Само за гледање, печатење и слика.</li>' +
            '<li>Кога ќе завршиш, „💾 Зачувај го одговорот" и испрати ја <b>.json</b> датотеката назад.</li>' +
            '</ol>Промените се чуваат во овој прелистувач додека не го зачуваш одговорот; оваа страница не праќа ништо никаде.</div>' +
            '<div class="who"><label for="who">Наставник:</label><select id="who"></select><span class="facts" id="facts"></span></div>' +
            '<p class="empty" id="pickFirst">Избери го своето име погоре.</p>' +
            '<div id="work">' +
            '<div class="tabs" role="group"><button type="button" data-tab="mine">✏️ Мој распоред</button><button type="button" data-tab="klass">👁 Распоред на паралелка</button></div>' +
            '<div id="tabMine">' +
            '<div class="bar"><button class="btn" id="save" type="button">💾 Зачувај го одговорот</button>' +
            '<button class="btn soft" id="image" type="button">🖼 Слика</button>' +
            '<button class="btn soft" id="reset" type="button">↺ Врати како што беше</button>' +
            '<span>Промени: <span class="count" id="count">0</span></span> <span class="saved" id="savedMsg"></span></div>' +
            '<div class="scroll" id="grid"></div>' +
            '<section class="part"><h2>Белешка (по избор)</h2><textarea id="note" placeholder="На пр. од кога важи, или што треба да се провери."></textarea></section>' +
            '</div>' +
            '<div id="tabKlass">' +
            '<div class="bar"><label class="noprint" for="klassPick"><b>Одделение:</b></label> <select id="klassPick" class="noprint" style="padding:9px 10px;border:2px solid #a3bffa;border-radius:8px;"></select>' +
            '<button class="btn soft" id="klassImage" type="button">🖼 Слика</button>' +
            '<button class="btn soft" id="klassPrint" type="button">⎙ Печати</button></div>' +
            '<h2 id="klassTitle"></h2>' +
            '<p class="hint" id="klassWho"></p>' +
            '<div class="scroll" id="klassGrid"></div>' +
            '<p class="hint noprint">Само за гледање: распоредот е составен од тоа што наставниците го внеле во своите лични распореди. Празно поле = никој уште не внел час.</p>' +
            '</div></div>';
        const one = data.teachers.length === 1 ? data.teachers[0].name : '';
        return kit.page(
            'Мој распоред' + (one ? ' — ' + one : ' — наставници'),
            '👩‍🏫 Мој распоред',
            (data.school || '') + ' · учебна ' + data.year + ' · формулар од ' + String(data.generatedAt).slice(0, 10),
            body, payload, teacherMain);
    }

    /**
     * ctx: { year, teachers: [name], classes: [label], validKeys: [key],
     *        current: {key: {class, subject}}   — this teacher, now
     *        doubled: [key]                     — this teacher in two classes at once
     *        occupied: {key: [{class, teacher, subject}]} }  — every lesson, now
     */
    function plan(reply, ctx) {
        const out = { errors: [], teacher: null, note: '', unchanged: 0, changes: [], conflicts: [], skipped: [] };
        if (!reply || reply.kind !== REPLY) { out.errors.push('Ова не е одговор од личен распоред на наставник.'); return out; }
        if (reply.version !== VERSION) { out.errors.push('Непозната верзија на формуларот (' + reply.version + ').'); return out; }
        if (reply.year !== ctx.year) { out.errors.push('Формуларот е за учебна ' + reply.year + ', а е отворена ' + ctx.year + '.'); return out; }
        const name = (ctx.teachers || []).find((t) => low(t) === low(reply.teacher && reply.teacher.name));
        if (!name) { out.errors.push('Наставникот „' + (reply.teacher && reply.teacher.name) + '" не е на списокот за ' + ctx.year + '.'); return out; }
        out.teacher = name;
        out.note = String(reply.note || '');
        const valid = new Set(ctx.validKeys || []);
        const doubled = new Set(ctx.doubled || []);
        const classes = new Set(ctx.classes || []);
        const cells = reply.cells || {};
        const baseline = reply.baseline || {};
        Array.from(new Set(Object.keys(cells).concat(Object.keys(baseline)))).forEach((key) => {
            const want = norm(cells[key]);
            const base = norm(baseline[key]);
            if (same(want, base)) { out.unchanged++; return; }
            const [day, ord] = key.split('|');
            const ordinal = Number(ord);
            if (!valid.has(key)) { out.skipped.push({ key, day, ordinal, reason: 'тој час не постои во распоредот' }); return; }
            if (doubled.has(key)) { out.skipped.push({ key, day, ordinal, reason: 'во базата наставникот е во две одделенија во тој час — се средува во Уреди настава' }); return; }
            if (want && !classes.has(want.class)) { out.skipped.push({ key, day, ordinal, reason: 'одделението „' + want.class + '" не е на списокот за годината' }); return; }
            const current = norm((ctx.current || {})[key]);
            const reasons = [];
            let together = null;
            if (want) {
                const there = ((ctx.occupied || {})[key] || []).filter((o) => o.class === want.class && low(o.teacher) !== low(name));
                if (there.length === 1 && low(there[0].subject) === low(want.subject)) together = there[0].teacher;
                else there.forEach((o) => reasons.push('во ' + want.class + ' во тој час е ' + o.teacher + ' (' + (o.subject || 'без предмет') + ')'));
                if (there.length >= 2) reasons.push('во ' + want.class + ' веќе има двајца наставници во тој час');
            }
            const change = { key, day, ordinal, from: current, to: want, reasons, together };
            if (!same(current, base)) {
                if (same(current, want)) { out.unchanged++; return; }
                out.conflicts.push(Object.assign(change, { baseline: base }));
                return;
            }
            out.changes.push(change);
        });
        return out;
    }

    window.MTBTeacherForm = Object.freeze({ FORM, REPLY, VERSION, norm, same, buildForm, plan });
})();

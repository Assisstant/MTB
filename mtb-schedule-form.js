/**
 * The weekly schedule as a form a colleague fills in without the app.
 *
 * Owner, 23 Sep 2026: send each colleague a file with their own week and their
 * own pupils already in it; they correct it and send it back; a name they add
 * becomes a pupil under observation; they never get access to the schedule.
 *
 * Three parts, and only the middle one writes anything:
 *
 *   buildForm(data)   → a standalone HTML page. Everything it needs is inside
 *                       it: no server, no sign-in, opens from an e-mail. It
 *                       saves the colleague's answer as a JSON file.
 *   plan(reply, ctx)  → what that answer would change, decided here and
 *                       nowhere else. Pure, so it is tested without a browser.
 *   (RasporediFusion) → shows the plan, and on „OK" writes it through the
 *                       endpoints that already own each fact.
 *
 * The answer carries the week AS THE FORM SHOWED IT (`baseline`). A block is
 * written only when the colleague changed it; and if the database changed
 * that block since the form was made, it is reported and left alone, never
 * overwritten. That is the row-level `expected` this project uses everywhere,
 * carried through an e-mail.
 *
 * A typed name is never trusted as an identity (rule 2). It is matched against
 * the year's list: one pupil with that name → that pupil, and the plan says so;
 * two → refused, a person decides; none → a new pupil under observation,
 * through the same endpoint the ＋ Нов ученик button uses.
 *
 * The form holds children's names. It is made at the moment it is sent and
 * never stored in this repository (rules 1 and 6).
 */
(function () {
    'use strict';

    const FORM = 'mtb-schedule-form';
    const REPLY = 'mtb-schedule-reply';
    const VERSION = 1;

    const blockKey = (day, time) => day + '|' + time;
    const pupilKey = (name) =>
        String(name || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('mk-MK');
    const same = (a, b) => (a || []).length === (b || []).length && (a || []).every((x, i) => x === b[i]);

    /* ── The page the colleague opens ─────────────────────────────────────── */

    const FORM_CSS = `
        * { box-sizing: border-box; }
        body { margin: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #2d3748; background: #fff; font-size: 15px; }
        header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #fff; padding: 15px 20px; }
        header h1 { margin: 0; font-size: 1.3em; }
        header p { margin: 4px 0 0; font-size: .9em; opacity: .95; }
        main { padding: 16px 20px 60px; }
        .help { max-width: 110ch; background: #f7fafc; border: 2px solid #e2e8f0; border-radius: 8px; padding: 12px 16px; margin-bottom: 14px; line-height: 1.5; }
        .help ol { margin: 6px 0 0; padding-left: 20px; }
        .bar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin: 12px 0; }
        .btn { display: inline-flex; align-items: center; gap: 6px; padding: 12px 25px; border: none; border-radius: 6px; background: #5a67d8; color: #fff; font: inherit; font-size: 14px; font-weight: 600; cursor: pointer; }
        .btn.soft { background: #edf2f7; color: #4a5568; border: 1px solid #cbd5e0; font-weight: 700; }
        .btn:hover { filter: brightness(.94); }
        .count { font-weight: 700; }
        .scroll { overflow-x: auto; }
        table { border-collapse: separate; border-spacing: 0; width: 100%; min-width: 900px; table-layout: fixed; }
        th { background: #667eea; color: #fff; padding: 9px 6px; font-size: 14px; }
        th.slot, td.slot { width: 92px; }
        td { border-bottom: 1px solid #e2e8f0; border-right: 1px solid #edf2f7; padding: 6px; vertical-align: top; }
        td.slot { background: #2d3748; color: #fff; text-align: center; vertical-align: middle; }
        td.slot b { display: block; font-size: 18px; }
        td.slot small { font-size: 11px; opacity: .85; }
        td.changed { background: #fffbea; box-shadow: inset 3px 0 0 #d69e2e; }
        .pick { display: flex; align-items: center; gap: 6px; margin: 3px 0; }
        .pick .tag { flex: 0 0 34px; font-size: 11px; font-weight: 700; text-align: center; border-radius: 4px; padding: 3px 0; background: #b2f5ea; color: #234e52; }
        .pick select { flex: 1; min-width: 0; padding: 7px 6px; border: 2px solid #e2e8f0; border-radius: 6px; font: inherit; font-size: 13px; background: #fff; color: #2d3748; }
        .pick select:focus { outline: none; border-color: #667eea; }
        .locked { font-size: 12px; color: #9b2c2c; }
        .pupils { margin-top: 18px; }
        .pupils h2 { font-size: 16px; margin: 0 0 8px; }
        .pupils ul { columns: 3 220px; margin: 0; padding-left: 20px; }
        .pupils li { margin-bottom: 3px; }
        .new { color: #744210; font-weight: 700; }
        textarea { width: 100%; max-width: 110ch; min-height: 70px; padding: 10px; border: 2px solid #e2e8f0; border-radius: 6px; font: inherit; }
        .saved { color: #2f855a; font-weight: 700; }
    `;

    /** Runs inside the form page. Everything it knows is in #formData. */
    function formMain() {
        const data = JSON.parse(document.getElementById('formData').textContent);
        const NEW = '__new__';
        const draftKey = 'mtb-schedule-form:' + data.therapist.id + ':' + data.generatedAt;
        const keyOf = (day, time) => day + '|' + time;
        const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
        const state = { blocks: {}, newPupils: [], note: '' };
        Object.keys(data.blocks).forEach((k) => { state.blocks[k] = data.blocks[k].slice(); });
        try {
            const draft = JSON.parse(localStorage.getItem(draftKey) || 'null');
            if (draft && draft.blocks) Object.assign(state, draft);
        } catch (_) { /* a draft is a convenience; the form works without one */ }
        const keep = () => { try { localStorage.setItem(draftKey, JSON.stringify(state)); } catch (_) { /* ignore */ } };

        const pupils = () => data.pupils.concat(state.newPupils.map((p) => ({ id: p.id, label: p.name + ' (ново · набљудување)', isNew: true })));
        const labelOf = (id) => { const p = pupils().find((x) => x.id === id); return p ? p.label : id; };
        const changedCount = () => Object.keys(Object.assign({}, data.blocks, state.blocks)).filter((k) =>
            JSON.stringify(state.blocks[k] || []) !== JSON.stringify(data.blocks[k] || [])).length;

        function options(selected, exclude, emptyLabel) {
            return '<option value="">' + emptyLabel + '</option>' + pupils()
                .filter((p) => p.id !== exclude)
                .map((p) => '<option value="' + esc(p.id) + '"' + (p.id === selected ? ' selected' : '') + '>' + esc(p.label) + '</option>')
                .join('') + '<option value="' + NEW + '">✏ Ново име…</option>';
        }

        function draw() {
            const head = '<tr><th class="slot">Час</th>' + data.days.map((d) => '<th>' + esc(d.charAt(0).toUpperCase() + d.slice(1)) + '</th>').join('') + '</tr>';
            const rows = data.bells.map((bell) => '<tr><td class="slot"><b>' + esc(bell.label) + '</b><small>' + esc(bell.time.replace('-', ' – ')) + '</small></td>' +
                data.days.map((day) => {
                    const k = keyOf(day, bell.time);
                    if ((data.locked || []).includes(k)) return '<td><span class="locked">Сложен термин — се средува во апликацијата.</span></td>';
                    const ids = state.blocks[k] || [];
                    const changed = JSON.stringify(ids) !== JSON.stringify(data.blocks[k] || []);
                    const two = ids.length === 2;
                    let html = '<div class="pick"><span class="tag">' + (two ? '1/2' : '40′') + '</span><select data-key="' + esc(k) + '" data-part="0">' +
                        options(ids[0] || '', ids[1], '— празно —') + '</select></div>';
                    if (ids[0]) html += '<div class="pick"><span class="tag">2/2</span><select data-key="' + esc(k) + '" data-part="1">' +
                        options(ids[1] || '', ids[0], two ? '— (без втор) —' : '+ втор ученик (20′ + 20′)') + '</select></div>';
                    return '<td' + (changed ? ' class="changed"' : '') + '>' + html + '</td>';
                }).join('') + '</tr>').join('');
            document.getElementById('grid').innerHTML = '<table><thead>' + head + '</thead><tbody>' + rows + '</tbody></table>';
            document.getElementById('count').textContent = changedCount();
            document.getElementById('list').innerHTML = pupils().map((p) =>
                '<li' + (p.isNew ? ' class="new"' : '') + '>' + esc(p.label) + '</li>').join('') || '<li>—</li>';
            document.getElementById('note').value = state.note || '';
        }

        function addNew() {
            const typed = window.prompt('Ново дете — име и презиме (доволно е и само име).\nЌе биде внесено како ученик под набљудување.', '');
            const name = String(typed || '').replace(/\s+/g, ' ').trim();
            if (!name) return '';
            const existing = pupils().find((p) => p.label.toLocaleLowerCase('mk-MK').includes(name.toLocaleLowerCase('mk-MK')));
            if (existing && !window.confirm('На списокот веќе има „' + existing.label + '".\nOK — сепак да се додаде ново име „' + name + '".\nОткажи — ќе го изберам од списокот.')) return '';
            const id = 'new:' + (state.newPupils.length + 1);
            state.newPupils.push({ id, name });
            return id;
        }

        document.getElementById('grid').addEventListener('change', (event) => {
            const select = event.target.closest('select[data-key]');
            if (!select) return;
            const k = select.dataset.key;
            const part = Number(select.dataset.part);
            let value = select.value;
            if (value === NEW) value = addNew();
            const ids = (state.blocks[k] || []).slice();
            if (part === 0) {
                if (value) ids[0] = value; else ids.splice(0, ids.length);
            } else if (value) ids[1] = value; else ids.splice(1);
            state.blocks[k] = ids.filter(Boolean);
            keep(); draw();
        });
        document.getElementById('addPupil').addEventListener('click', () => { if (addNew()) { keep(); draw(); } });
        document.getElementById('note').addEventListener('input', (event) => { state.note = event.target.value; keep(); });
        document.getElementById('reset').addEventListener('click', () => {
            if (!window.confirm('Да се врати распоредот како што беше испратен? Твоите промени ќе се избришат.')) return;
            state.blocks = {}; Object.keys(data.blocks).forEach((k) => { state.blocks[k] = data.blocks[k].slice(); });
            state.newPupils = []; state.note = '';
            try { localStorage.removeItem(draftKey); } catch (_) { /* ignore */ }
            draw();
        });
        document.getElementById('save').addEventListener('click', () => {
            // A new name that is not placed in any term is sent too: the
            // colleague said they work with that child.
            const reply = {
                kind: data.replyKind, version: data.version, year: data.year, therapist: data.therapist,
                formGeneratedAt: data.generatedAt, savedAt: new Date().toISOString(),
                baseline: data.blocks, blocks: state.blocks,
                newPupils: state.newPupils,
                note: state.note || ''
            };
            const blob = new Blob([JSON.stringify(reply, null, 2)], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'Распоред-одговор — ' + data.therapist.name + ' — ' + new Date().toISOString().slice(0, 10) + '.json';
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(a.href), 2000);
            document.getElementById('savedMsg').textContent = '✓ Зачувано. Испрати ја датотеката „' + a.download + '".';
        });
        draw();
    }

    function buildForm(data) {
        const payload = Object.assign({}, data, { kind: FORM, replyKind: REPLY, version: VERSION });
        const json = JSON.stringify(payload).replace(/</g, '\\u003c');
        const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
        return '<!DOCTYPE html><html lang="mk"><head><meta charset="UTF-8">' +
            '<meta name="viewport" content="width=device-width, initial-scale=1">' +
            '<title>Неделен распоред — ' + esc(data.therapist.name) + '</title><style>' + FORM_CSS + '</style></head><body>' +
            '<header><h1>🗓 Неделен распоред — ' + esc(data.therapist.name) + '</h1>' +
            '<p>' + esc(data.school || '') + ' · учебна ' + esc(data.year) + ' · формулар од ' + esc(String(data.generatedAt).slice(0, 10)) + '</p></header>' +
            '<main><div class="help"><b>Како се пополнува</b><ol>' +
            '<li>Во секој термин избери го детето. Едно дете = 40 минути; за двајца по 20 минути избери и „втор ученик".</li>' +
            '<li>Ако детето го нема на списокот, избери „✏ Ново име…" и напиши го — ќе биде внесено како ученик под набљудување.</li>' +
            '<li>Кога ќе завршиш, притисни „💾 Зачувај го одговорот" и испрати ја зачуваната <b>.json</b> датотека назад.</li>' +
            '</ol>Промените се чуваат во овој прелистувач додека не го зачуваш одговорот; оваа страница не праќа ништо никаде.</div>' +
            '<div class="bar"><button class="btn" id="save" type="button">💾 Зачувај го одговорот</button>' +
            '<button class="btn soft" id="addPupil" type="button">+ Ново дете</button>' +
            '<button class="btn soft" id="reset" type="button">↺ Врати како што беше</button>' +
            '<span>Изменети термини: <span class="count" id="count">0</span></span> <span class="saved" id="savedMsg"></span></div>' +
            '<div class="scroll" id="grid"></div>' +
            '<div class="pupils"><h2>Мои ученици</h2><ul id="list"></ul></div>' +
            '<div class="pupils"><h2>Белешка (по избор)</h2><textarea id="note" placeholder="На пр. од кога важи, или што треба да се провери."></textarea></div>' +
            '</main><script type="application/json" id="formData">' + json + '<\/script>' +
            '<script>(' + formMain.toString() + ')();<\/script></body></html>';
    }

    /* ── What an answer would change ──────────────────────────────────────── */

    /**
     * ctx: { year, therapists: [{id, name, students: [publicId]}],
     *        students: [{public_id, name}], current: {key: [publicId]},
     *        validKeys: [key], locked: [key] }
     * Nothing here writes; the caller applies what it returns.
     */
    function plan(reply, ctx) {
        const out = { errors: [], therapist: null, note: '', newPupils: [], changes: [], conflicts: [], skipped: [], unchanged: 0, caseloadAdds: [] };
        if (!reply || reply.kind !== REPLY) { out.errors.push('Ова не е одговор од формулар за распоред.'); return out; }
        if (reply.version !== VERSION) { out.errors.push('Непозната верзија на формуларот (' + reply.version + ').'); return out; }
        if (reply.year !== ctx.year) { out.errors.push('Формуларот е за учебна ' + reply.year + ', а е отворена ' + ctx.year + '.'); return out; }
        const therapist = (ctx.therapists || []).find((t) => String(t.id) === String(reply.therapist && reply.therapist.id));
        if (!therapist) { out.errors.push('Терапевтот „' + (reply.therapist && reply.therapist.name) + '" не е на списокот за ' + ctx.year + '.'); return out; }
        out.therapist = therapist;
        out.note = String(reply.note || '');

        // Typed names → an existing pupil, a refusal, or a new pupil.
        const byName = new Map();
        (ctx.students || []).forEach((s) => {
            const k = pupilKey(s.name);
            byName.set(k, (byName.get(k) || []).concat(s));
        });
        const resolved = new Map();
        const seenNew = new Map();
        (reply.newPupils || []).forEach((p) => {
            const name = String(p.name || '').replace(/\s+/g, ' ').trim();
            if (!name || !/^new:/.test(String(p.id))) return;
            const k = pupilKey(name);
            const matches = byName.get(k) || [];
            let entry;
            if (seenNew.has(k)) entry = Object.assign({}, seenNew.get(k), { id: p.id });
            else if (matches.length === 1) entry = { id: p.id, name, match: 'existing', publicId: matches[0].public_id, label: matches[0].name };
            else if (matches.length > 1) entry = { id: p.id, name, match: 'ambiguous' };
            else entry = { id: p.id, name, match: 'create' };
            seenNew.set(k, entry);
            resolved.set(String(p.id), entry);
            if (!out.newPupils.some((x) => pupilKey(x.name) === k)) out.newPupils.push(entry);
        });

        const valid = new Set(ctx.validKeys || []);
        const locked = new Set(ctx.locked || []);
        const known = new Set((ctx.students || []).map((s) => s.public_id));
        const blocks = reply.blocks || {};
        const baseline = reply.baseline || {};
        const keys = Array.from(new Set(Object.keys(blocks).concat(Object.keys(baseline))));
        const needCaseload = new Set();
        keys.forEach((key) => {
            const wantedRaw = (blocks[key] || []).map(String);
            const base = (baseline[key] || []).map(String);
            if (same(wantedRaw, base)) { out.unchanged++; return; }
            const [day, time] = key.split('|');
            if (!valid.has(key)) { out.skipped.push({ key, day, time, reason: 'терминот не постои во распоредот' }); return; }
            if (locked.has(key)) { out.skipped.push({ key, day, time, reason: 'сложен термин — се средува во апликацијата' }); return; }
            if (wantedRaw.length > 2 || new Set(wantedRaw).size !== wantedRaw.length) {
                out.skipped.push({ key, day, time, reason: 'повеќе од два ученика или исто дете двапати' }); return;
            }
            const wanted = [];
            for (const id of wantedRaw) {
                if (/^new:/.test(id)) {
                    const entry = resolved.get(id);
                    if (!entry) { out.skipped.push({ key, day, time, reason: 'ново име без податоци' }); return; }
                    if (entry.match === 'ambiguous') { out.skipped.push({ key, day, time, reason: 'името „' + entry.name + '" го носат повеќе деца' }); return; }
                    wanted.push(entry.match === 'existing' ? entry.publicId : { create: entry.name });
                } else if (!known.has(id)) {
                    out.skipped.push({ key, day, time, reason: 'ученикот повеќе не е на списокот' }); return;
                } else wanted.push(id);
            }
            const current = ((ctx.current || {})[key] || []).map(String);
            const change = { key, day, time, from: current, to: wanted };
            if (!same(current, base)) {
                if (wanted.every((w, i) => w === current[i]) && wanted.length === current.length) { out.unchanged++; return; }
                out.conflicts.push(Object.assign(change, { baseline: base }));
                return;
            }
            wanted.forEach((w) => { if (typeof w === 'string' && !(therapist.students || []).includes(w)) needCaseload.add(w); });
            out.changes.push(change);
        });
        // Every typed name joins the colleague's list, placed or not; an
        // existing pupil they named joins it too.
        out.newPupils.forEach((p) => {
            if (p.match === 'existing' && !(therapist.students || []).includes(p.publicId)) needCaseload.add(p.publicId);
        });
        out.caseloadAdds = Array.from(needCaseload);
        return out;
    }

    window.MTBScheduleForm = Object.freeze({ FORM, REPLY, VERSION, blockKey, pupilKey, buildForm, plan });
})();

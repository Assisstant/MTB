/**
 * The weekly schedule as a form a colleague fills in without the app.
 *
 * Owner, 23 Sep 2026: send each colleague a file with their own week and their
 * own pupils already in it; they correct it and send it back; a name they add
 * becomes a pupil under observation; they never get access to the schedule.
 *
 * Version 2 (24 Sep 2026, docs/PLAN-formulari.md step 2): ONE file for all the
 * therapists of a year. A dropdown at the top — „who are you" — shows that
 * person's week, and the whole year's pupils as a checklist, each labelled
 * with class and homeroom, from which they tick their own. „🖼 Слика" draws
 * the week to a PNG inside the form. A version 1 answer still reads.
 *
 * Three parts, and only the middle one writes anything:
 *
 *   buildForm(data)   → a standalone HTML page. Everything it needs is inside
 *                       it: no server, no sign-in, opens from an e-mail. It
 *                       saves the colleague's answer as a JSON file.
 *   plan(reply, ctx)  → what that answer would change, decided here and
 *                       nowhere else. Pure, so it is tested without a browser.
 *   (the queue)       → server/src/lib/form-replies.ts reads the answer with
 *                       THIS plan, and the administrator accepts it item by
 *                       item in Податоци → Формулари.
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
    const VERSION = 2;
    const READS = [1, 2];

    const blockKey = (day, time) => day + '|' + time;
    const pupilKey = (name) =>
        String(name || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('mk-MK');
    const same = (a, b) => (a || []).length === (b || []).length && (a || []).every((x, i) => x === b[i]);

    /* ── Shared by both forms: the page's look, and the week as a picture ── */

    const FORM_CSS = `
        * { box-sizing: border-box; }
        body { margin: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #2d3748; background: #fff; font-size: 15px; }
        header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #fff; padding: 15px 20px; }
        header h1 { margin: 0; font-size: 1.3em; }
        header p { margin: 4px 0 0; font-size: .9em; opacity: .95; }
        main { padding: 16px 20px 60px; }
        .help { max-width: 110ch; background: #f7fafc; border: 2px solid #e2e8f0; border-radius: 10px; padding: 12px 16px; margin-bottom: 14px; line-height: 1.5; }
        .help ol { margin: 6px 0 0; padding-left: 20px; }
        .who { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin: 0 0 14px; padding: 12px 16px; border: 2px solid #c3dafe; background: #ebf4ff; border-radius: 10px; max-width: 110ch; }
        .who label { font-weight: 700; }
        .who select { min-width: 280px; padding: 9px 10px; border: 2px solid #a3bffa; border-radius: 8px; font: inherit; background: #fff; color: #2d3748; }
        .who .facts { color: #4a5568; font-size: 14px; }
        .bar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin: 12px 0; }
        .btn { display: inline-flex; align-items: center; gap: 8px; padding: 10px 18px; min-height: 42px; border: none; border-radius: 10px; background: #5a67d8; color: #fff; font: inherit; font-size: 14px; font-weight: 600; cursor: pointer; }
        .btn.soft { background: #f7fafc; color: #2d3748; border: 1px solid #cbd5e0; }
        .btn:hover { filter: brightness(.95); }
        .count { font-weight: 700; }
        .scroll { overflow-x: auto; }
        table.week { border-collapse: separate; border-spacing: 0; width: 100%; min-width: 900px; table-layout: fixed; }
        table.week th { background: #5a67d8; color: #fff; padding: 9px 6px; font-size: 14px; }
        th.slot, td.slot { width: 92px; }
        table.week td { border-bottom: 1px solid #e2e8f0; border-right: 1px solid #edf2f7; padding: 6px; vertical-align: top; }
        td.slot { background: #2d3748; color: #fff; text-align: center; vertical-align: middle; }
        td.slot b { display: block; font-size: 18px; }
        td.slot small { font-size: 11px; opacity: .85; }
        td.changed { background: #fffbea; box-shadow: inset 3px 0 0 #b7791f; }
        .pick { display: flex; align-items: center; gap: 6px; margin: 3px 0; }
        .pick .tag { flex: 0 0 34px; font-size: 11px; font-weight: 700; text-align: center; border-radius: 4px; padding: 3px 0; background: #b2f5ea; color: #234e52; }
        select, input[type=text], input[type=search] { font: inherit; color: #2d3748; }
        .pick select, .cellpick select { flex: 1; min-width: 0; width: 100%; padding: 7px 6px; border: 2px solid #e2e8f0; border-radius: 6px; font-size: 13px; background: #fff; }
        .pick select:focus, .cellpick select:focus { outline: none; border-color: #667eea; }
        .locked { font-size: 12px; color: #9b2c2c; }
        section.part { margin-top: 20px; }
        section.part h2 { font-size: 16px; margin: 0 0 8px; }
        .hint { color: #4a5568; font-size: 13px; margin: 0 0 8px; }
        .find { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-bottom: 8px; }
        .find input[type=search] { min-width: 260px; padding: 8px 10px; border: 2px solid #e2e8f0; border-radius: 8px; }
        .checks { columns: 3 260px; column-gap: 24px; }
        .checks .group { break-inside: avoid; margin-bottom: 10px; }
        .checks .group h3 { font-size: 13px; margin: 0 0 4px; color: #434190; }
        .checks label { display: flex; gap: 6px; align-items: flex-start; padding: 2px 0; cursor: pointer; }
        .checks label.on { font-weight: 600; }
        .checks label.new { color: #744210; font-weight: 700; }
        table.reports { width: 100%; max-width: 110ch; border-collapse: collapse; }
        .reports td { padding: 5px 8px; border-bottom: 1px solid #edf2f7; vertical-align: middle; }
        .reports td:last-child { width: 60%; }
        .reports input[type=text] { width: 100%; min-width: 220px; padding: 6px 8px; border: 2px solid #e2e8f0; border-radius: 6px; }
        .reports tr.flag td { background: #fffbea; }
        textarea { width: 100%; max-width: 110ch; min-height: 70px; padding: 10px; border: 2px solid #e2e8f0; border-radius: 6px; font: inherit; }
        .saved { color: #276749; font-weight: 700; }
        .empty { padding: 30px 16px; color: #4a5568; }
    `;

    /**
     * The week as a PNG. Drawn by hand, as Кабинети draws its JPG: no library
     * to reach from an e-mail attachment, and a <select> does not screenshot
     * as its own text. Standalone — it is copied into the form page as text.
     *
     * o: { title, subtitle, days: [name], rows: [{label, time}],
     *      cells: rows × days of [{text, sub}], footer, file }
     */
    function paintGrid(o) {
        const M = 36, TIME_W = 150, COL_W = 300, HEAD_H = 104, COLHEAD_H = 50, FOOT_H = 50, GAP = 2;
        const rowH = o.rows.map((_, r) => Math.max(92, 16 + Math.max(1, ...o.days.map((_, d) => (o.cells[r][d] || []).length)) * 46));
        const width = M * 2 + TIME_W + o.days.length * COL_W;
        const height = M + HEAD_H + 16 + COLHEAD_H + rowH.reduce((a, b) => a + b, 0) + FOOT_H;
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d');
        const box = (x, y, w, h, r) => {
            ctx.beginPath(); ctx.moveTo(x + r, y);
            ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
            ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); ctx.fill();
        };
        const fit = (text, max) => {
            let v = String(text == null ? '' : text);
            if (ctx.measureText(v).width <= max) return v;
            while (v.length > 1 && ctx.measureText(v + '…').width > max) v = v.slice(0, -1);
            return v + '…';
        };
        ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, width, height);
        const g = ctx.createLinearGradient(M, M, width - M, M + HEAD_H);
        g.addColorStop(0, '#667eea'); g.addColorStop(1, '#764ba2');
        ctx.fillStyle = g; box(M, M, width - M * 2, HEAD_H, 12);
        ctx.textAlign = 'center'; ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 34px Arial'; ctx.fillText(fit(o.title, width - M * 4), width / 2, M + 46);
        ctx.font = '20px Arial'; ctx.fillText(fit(o.subtitle, width - M * 4), width / 2, M + 80);
        let y = M + HEAD_H + 16;
        ctx.fillStyle = '#4c51bf'; ctx.fillRect(M, y, TIME_W - GAP, COLHEAD_H);
        ctx.fillStyle = '#ffffff'; ctx.font = 'bold 20px Arial';
        ctx.fillText('Час', M + TIME_W / 2, y + 32);
        o.days.forEach((day, d) => {
            const x = M + TIME_W + d * COL_W;
            ctx.fillStyle = '#4c51bf'; ctx.fillRect(x, y, COL_W - GAP, COLHEAD_H);
            ctx.fillStyle = '#ffffff'; ctx.fillText(day.charAt(0).toUpperCase() + day.slice(1), x + COL_W / 2, y + 32);
        });
        y += COLHEAD_H + GAP;
        o.rows.forEach((row, r) => {
            const h = rowH[r] - GAP;
            ctx.fillStyle = '#2d3748'; ctx.fillRect(M, y, TIME_W - GAP, h);
            ctx.fillStyle = '#ffffff'; ctx.font = 'bold 26px Arial';
            ctx.fillText(String(row.label || ''), M + TIME_W / 2, y + h / 2 - 2);
            ctx.fillStyle = '#cbd5e0'; ctx.font = '15px Arial';
            ctx.fillText(String(row.time || '').replace('-', ' – '), M + TIME_W / 2, y + h / 2 + 22);
            o.days.forEach((_, d) => {
                const x = M + TIME_W + d * COL_W, w = COL_W - GAP;
                ctx.fillStyle = r % 2 ? '#ffffff' : '#f7fafc'; ctx.fillRect(x, y, w, h);
                (o.cells[r][d] || []).forEach((entry, i) => {
                    const ey = y + 8 + i * 46;
                    ctx.fillStyle = '#e6fffa'; box(x + 8, ey, w - 16, 40, 6);
                    ctx.fillStyle = '#319795'; ctx.fillRect(x + 8, ey + 2, 4, 36);
                    ctx.fillStyle = '#1a202c'; ctx.font = 'bold 17px Arial';
                    ctx.fillText(fit(entry.text, w - 36), x + w / 2 + 2, ey + (entry.sub ? 18 : 26));
                    if (entry.sub) {
                        ctx.fillStyle = '#4a5568'; ctx.font = '13px Arial';
                        ctx.fillText(fit(entry.sub, w - 36), x + w / 2 + 2, ey + 35);
                    }
                });
            });
            y += rowH[r];
        });
        ctx.textAlign = 'left'; ctx.fillStyle = '#4a5568'; ctx.font = '16px Arial';
        ctx.fillText(o.footer || '', M, height - 20);
        canvas.toBlob((blob) => {
            if (!blob) return;
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = o.file;
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(a.href), 30000);
        }, 'image/png');
    }

    /** One standalone page: the data, the painter, and the form's own code. */
    function page(title, heading, sub, bodyHtml, payload, main) {
        const json = JSON.stringify(payload).replace(/</g, '\\u003c');
        const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
        return '<!DOCTYPE html><html lang="mk"><head><meta charset="UTF-8">' +
            '<meta name="viewport" content="width=device-width, initial-scale=1">' +
            '<title>' + esc(title) + '</title><style>' + FORM_CSS + '</style></head><body>' +
            '<header><h1 id="heading">' + esc(heading) + '</h1><p>' + esc(sub) + '</p></header>' +
            '<main>' + bodyHtml + '</main><script type="application/json" id="formData">' + json + '<\/script>' +
            '<script>' + paintGrid.toString() + '\n(' + main.toString() + ')();<\/script></body></html>';
    }

    /* ── The page the colleague opens ─────────────────────────────────────── */

    /** Runs inside the form page. Everything it knows is in #formData. */
    function formMain() {
        const data = JSON.parse(document.getElementById('formData').textContent);
        const NEW = '__new__';
        const draftKey = 'mtb-schedule-form:' + data.generatedAt;
        const keyOf = (day, time) => day + '|' + time;
        const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
        const low = (s) => String(s || '').toLocaleLowerCase('mk-MK');
        const el = (id) => document.getElementById(id);

        // Each person's answer is kept apart, so picking the wrong name first
        // and then the right one loses nothing.
        let draft = { who: data.selected != null ? String(data.selected) : '', people: {} };
        try {
            const saved = JSON.parse(localStorage.getItem(draftKey) || 'null');
            if (saved && saved.people) draft = saved;
        } catch (_) { /* a draft is a convenience; the form works without one */ }
        const keep = () => { try { localStorage.setItem(draftKey, JSON.stringify(draft)); } catch (_) { /* ignore */ } };

        const therapist = () => data.therapists.find((t) => String(t.id) === String(draft.who)) || null;
        function mine() {
            const t = therapist();
            if (!t) return null;
            if (!draft.people[t.id]) {
                const blocks = {};
                Object.keys(t.blocks).forEach((k) => { blocks[k] = t.blocks[k].slice(); });
                draft.people[t.id] = { blocks, ticked: t.students.slice(), newPupils: [], note: '' };
            }
            return draft.people[t.id];
        }
        const byId = new Map(data.pupils.map((p) => [p.id, p]));
        const labelOf = (id) => {
            const s = mine();
            const n = s && s.newPupils.find((p) => p.id === id);
            if (n) return n.name + ' (ново)';
            return byId.has(id) ? byId.get(id).label : id;
        };
        const placedIn = (s, id) => Object.keys(s.blocks).filter((k) => (s.blocks[k] || []).includes(id));

        function changedCount() {
            const t = therapist(), s = mine();
            if (!t) return 0;
            const blocks = Object.keys(Object.assign({}, t.blocks, s.blocks)).filter((k) =>
                JSON.stringify(s.blocks[k] || []) !== JSON.stringify(t.blocks[k] || [])).length;
            const before = new Set(t.students), after = new Set(s.ticked);
            const ticks = s.ticked.filter((id) => !before.has(id)).length + t.students.filter((id) => !after.has(id)).length;
            return blocks + ticks + s.newPupils.length;
        }

        /** The grid offers the ticked pupils, the new names, and whoever is already placed. */
        function offered(s) {
            const ids = new Set(s.ticked);
            Object.values(s.blocks).forEach((list) => list.forEach((id) => ids.add(id)));
            const list = Array.from(ids).filter((id) => byId.has(id)).map((id) => ({ id, label: byId.get(id).label }))
                .sort((a, b) => a.label.localeCompare(b.label, 'mk'));
            return list.concat(s.newPupils.map((p) => ({ id: p.id, label: p.name + ' (ново · набљудување)' })));
        }

        function options(s, selected, exclude, emptyLabel) {
            return '<option value="">' + emptyLabel + '</option>' + offered(s)
                .filter((p) => p.id !== exclude)
                .map((p) => '<option value="' + esc(p.id) + '"' + (p.id === selected ? ' selected' : '') + '>' + esc(p.label) + '</option>')
                .join('') + '<option value="' + NEW + '">✏ Ново име…</option>';
        }

        function drawWho() {
            el('who').innerHTML = '<option value="">— избери го своето име —</option>' + data.therapists.map((t) =>
                '<option value="' + esc(t.id) + '"' + (String(t.id) === String(draft.who) ? ' selected' : '') + '>' + esc(t.name) + '</option>').join('');
        }

        function drawGrid(t, s) {
            const head = '<tr><th class="slot">Час</th>' + data.days.map((d) => '<th>' + esc(d.charAt(0).toUpperCase() + d.slice(1)) + '</th>').join('') + '</tr>';
            const rows = data.bells.map((bell) => '<tr><td class="slot"><b>' + esc(bell.label) + '</b><small>' + esc(bell.time.replace('-', ' – ')) + '</small></td>' +
                data.days.map((day) => {
                    const k = keyOf(day, bell.time);
                    if ((t.locked || []).includes(k)) return '<td><span class="locked">Сложен термин — се средува во апликацијата.</span></td>';
                    const ids = s.blocks[k] || [];
                    const changed = JSON.stringify(ids) !== JSON.stringify(t.blocks[k] || []);
                    const two = ids.length === 2;
                    let html = '<div class="pick"><span class="tag">' + (two ? '1/2' : '40′') + '</span><select data-key="' + esc(k) + '" data-part="0">' +
                        options(s, ids[0] || '', ids[1], '— празно —') + '</select></div>';
                    if (ids[0]) html += '<div class="pick"><span class="tag">2/2</span><select data-key="' + esc(k) + '" data-part="1">' +
                        options(s, ids[1] || '', ids[0], two ? '— (без втор) —' : '+ втор ученик (20′ + 20′)') + '</select></div>';
                    return '<td' + (changed ? ' class="changed"' : '') + '>' + html + '</td>';
                }).join('') + '</tr>').join('');
            el('grid').innerHTML = '<table class="week"><thead>' + head + '</thead><tbody>' + rows + '</tbody></table>';
        }

        function drawChecks(s) {
            const find = low(el('find').value.trim());
            const onlyMine = el('onlyMine').checked;
            const ticked = new Set(s.ticked);
            const groups = new Map();
            data.pupils.forEach((p) => {
                if (onlyMine && !ticked.has(p.id)) return;
                const head = p.klass ? p.klass + (p.homeroom ? ' · ' + p.homeroom : '') : 'без одделение';
                if (find && !low(p.label + ' ' + head).includes(find)) return;
                if (!groups.has(head)) groups.set(head, []);
                groups.get(head).push(p);
            });
            let html = Array.from(groups.entries()).map(([head, list]) => '<div class="group"><h3>' + esc(head) + '</h3>' +
                list.map((p) => '<label class="' + (ticked.has(p.id) ? 'on' : '') + '"><input type="checkbox" data-pupil="' + esc(p.id) + '"' +
                    (ticked.has(p.id) ? ' checked' : '') + '> <span>' + esc(p.name || p.label) + '</span></label>').join('') + '</div>').join('');
            if (s.newPupils.length) {
                html += '<div class="group"><h3>Нови имиња (под набљудување)</h3>' + s.newPupils.map((p) =>
                    '<label class="new"><input type="checkbox" checked disabled> <span>' + esc(p.name) + '</span></label>').join('') + '</div>';
            }
            el('checks').innerHTML = html || '<p class="hint">Нема ученик со тоа име.</p>';
            el('tickCount').textContent = s.ticked.length + s.newPupils.length;
        }

        function draw() {
            drawWho();
            const t = therapist();
            el('work').style.display = t ? '' : 'none';
            el('pickFirst').style.display = t ? 'none' : '';
            el('heading').textContent = '🗓 Неделен распоред' + (t ? ' — ' + t.name : ' на кабинетите');
            if (!t) return;
            const s = mine();
            el('facts').textContent = t.students.length + ' ученици на списокот · ' + Object.keys(t.blocks).length + ' пополнети термини';
            drawGrid(t, s);
            drawChecks(s);
            el('count').textContent = changedCount();
            el('note').value = s.note || '';
        }

        function addNew() {
            const s = mine();
            const typed = window.prompt('Ново дете — име и презиме (доволно е и само име).\nЌе биде внесено како ученик под набљудување.', '');
            const name = String(typed || '').replace(/\s+/g, ' ').trim();
            if (!name) return '';
            const existing = data.pupils.find((p) => low(p.label).includes(low(name)));
            if (existing && !window.confirm('На списокот веќе има „' + existing.label + '".\nOK — сепак да се додаде ново име „' + name + '".\nОткажи — ќе го штиклирам од списокот.')) return '';
            const id = 'new:' + (s.newPupils.length + 1);
            s.newPupils.push({ id, name });
            return id;
        }

        el('who').addEventListener('change', () => {
            draft.who = el('who').value;
            keep(); draw();
        });
        el('grid').addEventListener('change', (event) => {
            const select = event.target.closest('select[data-key]');
            if (!select) return;
            const s = mine();
            const k = select.dataset.key;
            const part = Number(select.dataset.part);
            let value = select.value;
            if (value === NEW) value = addNew();
            const ids = (s.blocks[k] || []).slice();
            if (part === 0) {
                if (value) ids[0] = value; else ids.splice(0, ids.length);
            } else if (value) ids[1] = value; else ids.splice(1);
            s.blocks[k] = ids.filter(Boolean);
            if (value && !/^new:/.test(value) && !s.ticked.includes(value)) s.ticked.push(value);
            keep(); draw();
        });
        el('checks').addEventListener('change', (event) => {
            const box = event.target.closest('input[data-pupil]');
            if (!box) return;
            const s = mine();
            const id = box.dataset.pupil;
            if (box.checked) { if (!s.ticked.includes(id)) s.ticked.push(id); }
            else {
                const where = placedIn(s, id);
                if (where.length && !window.confirm(labelOf(id) + ' е во ' + where.length + ' термин(и). Да се извади и од нив?')) {
                    box.checked = true; return;
                }
                where.forEach((k) => { s.blocks[k] = s.blocks[k].filter((x) => x !== id); });
                s.ticked = s.ticked.filter((x) => x !== id);
            }
            keep(); draw();
        });
        el('find').addEventListener('input', () => { const s = mine(); if (s) drawChecks(s); });
        el('onlyMine').addEventListener('change', () => { const s = mine(); if (s) drawChecks(s); });
        el('addPupil').addEventListener('click', () => { if (mine() && addNew()) { keep(); draw(); } });
        el('note').addEventListener('input', (event) => { const s = mine(); if (s) { s.note = event.target.value; keep(); } });
        el('reset').addEventListener('click', () => {
            const t = therapist();
            if (!t || !window.confirm('Да се врати распоредот како што беше испратен? Твоите промени ќе се избришат.')) return;
            delete draft.people[t.id];
            keep(); draw();
        });
        el('image').addEventListener('click', () => {
            const t = therapist(), s = mine();
            if (!t) return;
            const short = (id) => labelOf(id);
            paintGrid({
                title: 'Неделен распоред — ' + t.name,
                subtitle: (data.school || '') + ' · учебна ' + data.year + ' · 1 ученик = 40′, 2 ученици = 20′ + 20′',
                days: data.days,
                rows: data.bells,
                cells: data.bells.map((bell) => data.days.map((day) => {
                    const ids = s.blocks[keyOf(day, bell.time)] || [];
                    return ids.map((id, i) => ({ text: short(id), sub: ids.length === 2 ? (i ? 'втори 20′' : 'први 20′') : '' }));
                })),
                footer: 'Од формулар · ' + new Date().toLocaleDateString('mk-MK') + (changedCount() ? ' · со промени што уште не се прифатени' : ''),
                file: 'Распоред — ' + t.name + '.png'
            });
        });
        el('save').addEventListener('click', () => {
            const t = therapist(), s = mine();
            if (!t) return;
            // A new name that is not placed in any term is sent too: the
            // colleague said they work with that child.
            const reply = {
                kind: data.replyKind, version: data.version, year: data.year,
                therapist: { id: t.id, name: t.name },
                formGeneratedAt: data.generatedAt, savedAt: new Date().toISOString(),
                baseline: t.blocks, blocks: s.blocks,
                newPupils: s.newPupils,
                pupils: { baseline: t.students, ticked: s.ticked },
                note: s.note || ''
            };
            const blob = new Blob([JSON.stringify(reply, null, 2)], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'Распоред-одговор — ' + t.name + ' — ' + new Date().toISOString().slice(0, 10) + '.json';
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(a.href), 2000);
            el('savedMsg').textContent = '✓ Зачувано. Испрати ја датотеката „' + a.download + '".';
        });
        draw();
    }

    /**
     * data: { school, year, generatedAt, days, bells: [{label, time}],
     *         pupils: [{id, name, label, klass, homeroom}],
     *         therapists: [{id, name, students: [id], blocks: {key: [id]}, locked: [key]}],
     *         selected: therapist id or null }
     * The version 1 shape — one `therapist` with its `blocks` — is still taken.
     */
    function buildForm(data) {
        const payload = Object.assign({}, data, { kind: FORM, replyKind: REPLY, version: VERSION });
        if (!payload.therapists && data.therapist) {
            payload.therapists = [Object.assign({}, data.therapist, {
                students: (data.pupils || []).map((p) => p.id), blocks: data.blocks || {}, locked: data.locked || []
            })];
            payload.selected = data.therapist.id;
        }
        payload.pupils = (payload.pupils || []).map((p) => Object.assign({ name: p.label, klass: '', homeroom: '' }, p));
        const one = payload.therapists.length === 1 ? payload.therapists[0].name : '';
        const body =
            '<div class="help"><b>Како се пополнува</b><ol>' +
            '<li>Горе избери го <b>своето име</b>. Ќе се појави твојата недела и твоите ученици.</li>' +
            '<li>Во секој термин избери го детето. Едно дете = 40 минути; за двајца по 20 минути избери и „втор ученик".</li>' +
            '<li>Во „Мои ученици" штиклирај ги сите деца со кои работиш — списокот е на целото училиште, по одделенија. ' +
            'Ако детето го нема, „+ Ново дете" — ќе биде внесено како ученик под набљудување.</li>' +
            '<li>Кога ќе завршиш, „💾 Зачувај го одговорот" и испрати ја зачуваната <b>.json</b> датотека назад. „🖼 Слика" ја зачувува неделата како слика.</li>' +
            '</ol>Промените се чуваат во овој прелистувач додека не го зачуваш одговорот; оваа страница не праќа ништо никаде.</div>' +
            '<div class="who"><label for="who">Терапевт:</label><select id="who"></select><span class="facts" id="facts"></span></div>' +
            '<p class="empty" id="pickFirst">Избери го своето име погоре.</p>' +
            '<div id="work">' +
            '<div class="bar"><button class="btn" id="save" type="button">💾 Зачувај го одговорот</button>' +
            '<button class="btn soft" id="image" type="button">🖼 Слика</button>' +
            '<button class="btn soft" id="addPupil" type="button">+ Ново дете</button>' +
            '<button class="btn soft" id="reset" type="button">↺ Врати како што беше</button>' +
            '<span>Промени: <span class="count" id="count">0</span></span> <span class="saved" id="savedMsg"></span></div>' +
            '<div class="scroll" id="grid"></div>' +
            '<section class="part"><h2>Мои ученици (<span id="tickCount">0</span>)</h2>' +
            '<p class="hint">Штиклирано = на твојот список. Во терминот се нудат само штиклираните.</p>' +
            '<div class="find"><input type="search" id="find" placeholder="Барај ученик или одделение…">' +
            '<label><input type="checkbox" id="onlyMine"> само штиклираните</label></div>' +
            '<div class="checks" id="checks"></div></section>' +
            '<section class="part"><h2>Белешка (по избор)</h2><textarea id="note" placeholder="На пр. од кога важи, или што треба да се провери."></textarea></section>' +
            '</div>';
        return page(
            'Неделен распоред' + (one ? ' — ' + one : ' — кабинети'),
            '🗓 Неделен распоред' + (one ? ' — ' + one : ' на кабинетите'),
            (data.school || '') + ' · учебна ' + data.year + ' · формулар од ' + String(data.generatedAt).slice(0, 10),
            body, payload, formMain);
    }

    /* ── What an answer would change ──────────────────────────────────────── */

    /**
     * ctx: { year, therapists: [{id, name, students: [publicId]}],
     *        students: [{public_id, name}], current: {key: [publicId]},
     *        validKeys: [key], locked: [key] }
     * Nothing here writes; the caller applies what it returns.
     */
    function plan(reply, ctx) {
        const out = { errors: [], therapist: null, note: '', newPupils: [], changes: [], conflicts: [], skipped: [], unchanged: 0, caseloadAdds: [], caseloadRemovals: [] };
        if (!reply || reply.kind !== REPLY) { out.errors.push('Ова не е одговор од формулар за распоред.'); return out; }
        if (!READS.includes(reply.version)) { out.errors.push('Непозната верзија на формуларот (' + reply.version + ').'); return out; }
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
        // Version 2 carries the checklist. A tick added is a pupil joining the
        // list; a tick taken away is one leaving it — but only if the database
        // still has them there, and never while the answer itself still
        // places them in a term.
        if (reply.pupils && Array.isArray(reply.pupils.ticked)) {
            const before = new Set((reply.pupils.baseline || []).map(String));
            const after = new Set(reply.pupils.ticked.map(String));
            const onList = new Set((therapist.students || []).map(String));
            const placed = new Set();
            Object.values(blocks).forEach((list) => (list || []).forEach((id) => placed.add(String(id))));
            after.forEach((id) => { if (!before.has(id) && known.has(id) && !onList.has(id)) needCaseload.add(id); });
            before.forEach((id) => {
                if (!after.has(id) && onList.has(id) && !placed.has(id)) out.caseloadRemovals.push(id);
            });
        }
        out.caseloadAdds = Array.from(needCaseload);
        return out;
    }

    window.MTBScheduleForm = Object.freeze({ FORM, REPLY, VERSION, READS, FORM_CSS, blockKey, pupilKey, paintGrid, page, buildForm, plan });
})();

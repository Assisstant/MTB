/**
 * One form per kind of thing, opened wherever that thing is shown.
 *
 * The owner's rule, 24 Sep 2026 (docs/PLAN-eden-urednik.md): where I see
 * something I can change it, on the spot, in a popup, without losing the flow
 * of my work — behind one „✏️ Уреди" switch. Editing in many places was never
 * the problem. Many separately written editors were: a pupil was edited by
 * three different pieces of code with three different sets of fields, and one
 * more that saved nothing at all. So each kind of thing gets exactly ONE form,
 * here, and every screen opens that same form.
 *
 * A page opts in by loading this file and marking what it shows:
 *
 *     MTBForms.doorHtml('pupil', publicId, year, name)
 *     → <button class="mtb-door" data-mtb-door="pupil" data-id="…" data-year="…">✏️</button>
 *
 * Doors are invisible until editing is switched on, so a page looks and
 * behaves exactly as before for anyone who never touches the switch. After a
 * save, every page of this origin — other tabs, the Workspace's other windows —
 * hears `mtb:saved` and redraws from the database, never from the form.
 *
 * NOTHING HERE HOLDS DATA. The mode is one flag in this browser, written only
 * when somebody flips it, exactly like the theme. A draft lives in the
 * dialog's DOM and nowhere else. Every write goes through the endpoint that
 * already owns the fact, with that endpoint's stale check, so a form opened
 * from Кабинети and the same pupil edited in Податоци cannot overwrite each
 * other silently.
 */
(function () {
    'use strict';
    if (window.MTBForms) return;

    const MODE_KEY = 'mtb_editing_v1';
    const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX'];
    // The same words the Workspace's administration has always used, so a
    // pupil reads the same in both places.
    const PROGRAMMES = { unknown: 'Непотврдено', standard: 'Стандардна', modified: 'Модифицирана' };
    const PLACEMENTS = {
        unknown: 'Непотврдено', regular: 'Редовна настава', preparatory: 'Подготвителна група',
        observation: 'Опсервација', none: 'Само услуги · без локална настава'
    };

    const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const tidy = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

    // ── the mode ────────────────────────────────────────────────────────────
    // `pushed` is a mode sent by the Workspace shell to its windows. From
    // GitHub Pages the shell is another origin with other storage, so it is
    // applied and never stored — the same arrangement as the theme.
    let pushed = null;
    const switches = new Set();

    function editing() {
        if (pushed !== null) return pushed;
        try { return localStorage.getItem(MODE_KEY) === '1'; } catch (_) { return false; }
    }

    function applyMode() {
        const on = editing();
        document.documentElement.toggleAttribute('data-mtb-editing', on);
        switches.forEach((button) => {
            if (!button.isConnected) switches.delete(button);
            else paintSwitch(button);
        });
        window.dispatchEvent(new CustomEvent('mtb:editing', { detail: { on } }));
    }

    function setEditing(on) {
        pushed = null;
        try {
            if (on) localStorage.setItem(MODE_KEY, '1');
            else localStorage.removeItem(MODE_KEY);
        } catch (_) { pushed = Boolean(on); /* storage blocked: it still holds for this tab */ }
        applyMode();
    }

    function paintSwitch(button) {
        const on = editing();
        button.textContent = on ? '✏️ Уредување: вкл.' : '✏️ Уреди';
        button.title = on
            ? 'Уредувањето е вклучено: ✏️ до податокот отвора формулар. Кликни за да се исклучи.'
            : 'Вклучи уредување: до секој податок се појавува ✏️ што отвора формулар.';
        button.setAttribute('aria-pressed', String(on));
    }

    /** Turns a button into the switch. The bar calls this on every redraw. */
    function bindSwitch(button) {
        button.type = 'button';
        button.dataset.mtbEditingSwitch = '';
        button.addEventListener('click', () => setEditing(!editing()));
        switches.add(button);
        paintSwitch(button);
        return button;
    }

    window.addEventListener('storage', (event) => { if (event.key === MODE_KEY) applyMode(); });
    window.addEventListener('message', (event) => {
        if (event.source !== window.parent || window.parent === window) return;
        const msg = event.data;
        if (msg && msg.type === 'mtb:editing') { pushed = Boolean(msg.on); applyMode(); }
    });

    // ── talking to the server ───────────────────────────────────────────────
    function base() {
        const nav = window.MTBAppNavigation;
        const chosen = nav && typeof nav.apiBase === 'function' ? nav.apiBase() : '';
        return chosen || (/^https?:$/.test(window.location.protocol) ? window.location.origin : '');
    }

    async function request(method, path, body) {
        let res;
        try {
            res = await fetch(base() + path, {
                method,
                cache: 'no-store',
                headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
                body: body === undefined ? undefined : JSON.stringify(body)
            });
        } catch (_) {
            throw Object.assign(new Error('Серверот не одговара. Ништо не е зачувано.'), { status: 0 });
        }
        let payload = null;
        try { payload = await res.json(); } catch (_) { /* not JSON */ }
        if (!res.ok) {
            const said = payload && payload.error ? payload.error : `Серверот одговори ${res.status}.`;
            const message = res.status === 403
                ? 'Немате дозвола за оваа промена. ' + said
                : res.status === 401 ? 'Прво најавете се. ' + said : said;
            throw Object.assign(new Error(message), { status: res.status, payload });
        }
        return payload;
    }

    // ── after a save: every screen redraws from the database ────────────────
    // The page this form was opened on hears it here. Every OTHER window hears
    // it the way it hears any write — `app-navigation.js` announces each one
    // from its `fetch`, so this form no longer keeps a channel of its own.
    function announce(detail) {
        window.dispatchEvent(new CustomEvent('mtb:saved', { detail }));
        const nav = window.MTBAppNavigation;
        if (nav && typeof nav.toast === 'function' && detail.said) {
            try { nav.toast(detail.said, 'synced'); } catch (_) { /* the page redraws either way */ }
        }
    }

    // ── doors ───────────────────────────────────────────────────────────────
    function doorHtml(kind, id, year, name) {
        const label = 'Уреди' + (name ? ': ' + tidy(name) : '');
        return `<button type="button" class="mtb-door" data-mtb-door="${esc(kind)}" data-id="${esc(id)}"`
            + ` data-year="${esc(year || '')}" title="${esc(label)}" aria-label="${esc(label)}">✏️</button>`;
    }

    // Capture phase, so a click on a door inside a clickable row opens the
    // form and nothing else — the row's own handler is the old behaviour and
    // must not also fire.
    document.addEventListener('click', (event) => {
        const door = event.target && event.target.closest ? event.target.closest('[data-mtb-door]') : null;
        if (!door) return;
        event.preventDefault();
        event.stopPropagation();
        if (!editing()) return;
        open(door.dataset.mtbDoor, { id: door.dataset.id, year: door.dataset.year, door });
    }, true);

    // ── the dialog ──────────────────────────────────────────────────────────
    let current = null;
    let serial = 0;

    function dialog(title) {
        if (current) current.close(true);
        const id = 'mtbForm' + (++serial);
        const node = document.createElement('dialog');
        node.className = 'mtb-form';
        node.setAttribute('aria-labelledby', id + 'Title');
        node.innerHTML = `<form class="mtb-form__card" novalidate>
            <header><h2 class="mtb-form__title" id="${id}Title"></h2>
              <button type="button" class="mtb-form__x" data-act="close" aria-label="Затвори" title="Затвори">✕</button></header>
            <div class="mtb-form__sub"></div>
            <div class="mtb-form__body"><p class="mtb-form__hint">Вчитувам од базата…</p></div>
            <div class="mtb-form__ask" hidden></div>
            <div class="mtb-form__status" role="status" aria-live="polite"></div>
            <footer></footer>
          </form>`;
        document.body.appendChild(node);
        const form = node.querySelector('form');
        const shell = {
            node, form,
            body: node.querySelector('.mtb-form__body'),
            footer: node.querySelector('footer'),
            dirty: () => false,
            returnTo: null,
            title(text, sub) {
                node.querySelector('.mtb-form__title').textContent = text;
                node.querySelector('.mtb-form__sub').textContent = sub || '';
            },
            say(text, kind) {
                const status = node.querySelector('.mtb-form__status');
                status.textContent = text || '';
                status.dataset.kind = kind || '';
            },
            /**
             * A question asked inside the dialog, never with `confirm()`: a
             * native box blocks every window of the Workspace, and a test that
             * dismisses dialogs would answer it without anybody reading it.
             */
            ask(text, yes, no) {
                const box = node.querySelector('.mtb-form__ask');
                box.innerHTML = `<span>${esc(text)}</span>`
                    + `<button type="button" class="mtb-form__btn mtb-form__danger" data-answer="yes">${esc(yes)}</button>`
                    + `<button type="button" class="mtb-form__btn" data-answer="no">${esc(no)}</button>`;
                box.hidden = false;
                box.querySelector('[data-answer="no"]').focus();
                return new Promise((resolve) => {
                    box.onclick = (event) => {
                        const answer = event.target.closest('[data-answer]');
                        if (!answer) return;
                        box.hidden = true;
                        box.onclick = null;
                        resolve(answer.dataset.answer === 'yes');
                    };
                });
            },
            busy(on) {
                form.querySelectorAll('button, input, select').forEach((n) => {
                    if (on) { n.dataset.wasDisabled = n.disabled ? '1' : ''; n.disabled = true; }
                    else if (n.dataset.wasDisabled !== undefined) { n.disabled = n.dataset.wasDisabled === '1'; delete n.dataset.wasDisabled; }
                });
                node.setAttribute('aria-busy', String(on));
            },
            async tryClose() {
                if (shell.dirty() && !(await shell.ask('Има незачувани промени.', 'Отфрли ги', 'Продолжи со уредување'))) return;
                shell.close(true);
            },
            close() {
                if (!node.isConnected) return;
                if (node.open) node.close();
                node.remove();
                if (current === shell) current = null;
                if (shell.returnTo && shell.returnTo.isConnected) shell.returnTo.focus();
            },
            fail(err) {
                shell.body.innerHTML = `<p class="mtb-form__hint">${esc(err && err.message ? err.message : err)}</p>`;
                shell.footer.innerHTML = '<button type="button" class="mtb-form__btn" data-act="close">Затвори</button>';
            }
        };
        node.addEventListener('cancel', (event) => { event.preventDefault(); shell.tryClose(); });
        // A browser may close a modal on a second Esc whatever `cancel` says.
        // Then the draft is gone anyway; at least nothing is left behind.
        node.addEventListener('close', () => shell.close());
        node.addEventListener('click', (event) => {
            if (event.target.closest('[data-act="close"]')) shell.tryClose();
        });
        current = shell;
        node.showModal();
        return shell;
    }

    const option = (value, label, selected) =>
        `<option value="${esc(value)}"${String(value) === String(selected ?? '') ? ' selected' : ''}>${esc(label)}</option>`;
    const options = (map, selected) => Object.entries(map).map(([k, v]) => option(k, v, selected)).join('');
    const snapshot = (form) => JSON.stringify([...new FormData(form).entries()]);

    // ── the pupil ───────────────────────────────────────────────────────────
    /**
     * One pupil, for one school year.
     *
     * Read and written through `/api/workspace`, the pupil API that already
     * carries every field — class, generation, internal/external, boarding,
     * programme, placement, annual membership, therapists — in one
     * transaction, with a whole-row stale check. So this form adds no server
     * path of its own and cannot drift from the administration's rules: the
     * server says what is allowed and the form shows its sentence.
     */
    async function openPupil(ctx) {
        const shell = dialog();
        shell.returnTo = ctx.door || null;
        shell.title('Ученик', ctx.year);
        let data;
        try {
            if (!ctx.year) throw new Error('Не е кажано за која учебна година.');
            data = await request('GET', '/api/workspace?year=' + encodeURIComponent(ctx.year));
        } catch (err) { shell.fail(err); return shell; }
        const pupil = (data.pupils || []).find((p) => p.public_id === ctx.id);
        if (!pupil) { shell.fail(new Error('Ученикот не е најден во базата.')); return shell; }
        drawPupil(shell, data, pupil, ctx.year);
        return shell;
    }

    function drawPupil(shell, data, pupil, year) {
        const archived = pupil.globally_active === false;
        const onList = pupil.annual_active === true;
        shell.title(pupil.name, year + (onList ? '' : ' · не е на листата за оваа година'));

        const classes = { '': 'Без локална паралелка' };
        (data.classes || []).forEach((c) => { classes[c.label] = c.label; });
        if (pupil.grade && !classes[pupil.grade]) classes[pupil.grade] = pupil.grade + ' · неактивна';
        const mine = new Set((pupil.therapists || []).map((t) => t.id));
        const therapists = (data.employees || [])
            .filter((e) => e.therapist_id && (e.therapist_active || mine.has(e.therapist_id)))
            .sort((a, b) => a.name.localeCompare(b.name, 'mk'));

        shell.body.innerHTML = `<fieldset class="mtb-form__plain"${archived ? ' disabled' : ''}>
            <label>Име и презиме<input type="text" name="name" maxlength="120" value="${esc(pupil.name)}" required></label>
            <div class="mtb-form__grid">
              <label>Паралелка / група<select name="grade">${options(classes, pupil.grade || '')}</select></label>
              <label>Одделение (генерација)<select name="oddelenie">${option('', 'Непотврдено', pupil.oddelenie || '')}${ROMAN.map((r) => option(r, r, pupil.oddelenie || '')).join('')}</select></label>
              <label>Основен статус<select name="enrollmentType">${options({ internal: 'Внатрешен', external: 'Надворешен' }, pupil.enrollment_type || 'internal')}</select></label>
              <label>Програма<select name="programme">${options(PROGRAMMES, pupil.programme || 'unknown')}</select></label>
              <label>Локална настава / поставеност<select name="placement">${options(PLACEMENTS, pupil.placement || 'unknown')}</select></label>
            </div>
            <label class="mtb-form__check"><input type="checkbox" name="boarding"${pupil.boarding ? ' checked' : ''}> Користи интернат</label>
            <fieldset><legend>Терапевти во ${esc(year)}</legend>
              <div class="mtb-form__checks">${therapists.length ? therapists.map((t) =>
                    `<label class="mtb-form__check"><input type="checkbox" name="therapist" value="${t.therapist_id}"${mine.has(t.therapist_id) ? ' checked' : ''}> ${esc(t.name)}</label>`).join('')
                : '<span class="mtb-form__hint">Нема активни терапевти оваа година.</span>'}</div>
            </fieldset>
            <p class="mtb-form__hint">${archived
                ? 'Ученикот е архивиран. Архивата се води во S-Дневник, па овде може само да се гледа.'
                : 'Името важи за сите години; сè друго е само за ' + esc(year) + '.'}</p>
          </fieldset>
          <details class="mtb-form__zone"${archived ? ' hidden' : ''}><summary>Тргање и бришење</summary>
            <p class="mtb-form__hint">Тргањето од листата не брише ништо: историјата останува, и ученикот може да се врати.
               Бришењето е само за грешка при внес, и серверот го одбива ако ученикот има какви било записи.</p>
            <div class="mtb-form__row">
              ${onList
                ? `<button type="button" class="mtb-form__btn mtb-form__danger" data-act="leave">Тргни од листата за ${esc(year)}</button>`
                : `<button type="button" class="mtb-form__btn" data-act="rejoin">Врати на листата за ${esc(year)}</button>`}
              <button type="button" class="mtb-form__btn mtb-form__danger" data-act="purge">Избриши — грешка при внес</button>
            </div>
          </details>`;
        shell.footer.innerHTML = archived
            ? '<button type="button" class="mtb-form__btn" data-act="close">Затвори</button>'
            : '<button type="submit" class="mtb-form__btn mtb-form__primary">Зачувај во базата</button>'
              + '<button type="button" class="mtb-form__btn" data-act="close">Откажи</button>';

        const form = shell.form;
        const boarding = form.elements.boarding;
        const syncBoarding = () => {
            // Boarding is for internal pupils only; the database refuses the
            // other combination, so the form does not offer it.
            const external = form.elements.enrollmentType.value === 'external';
            if (external) boarding.checked = false;
            boarding.disabled = external || archived;
        };
        syncBoarding();
        form.elements.enrollmentType.addEventListener('change', syncBoarding);
        const before = snapshot(form);
        shell.dirty = () => !archived && snapshot(form) !== before;

        const fields = () => {
            const f = new FormData(form);
            return {
                name: tidy(f.get('name')),
                grade: f.get('grade') || null,
                oddelenie: f.get('oddelenie') || null,
                enrollmentType: f.get('enrollmentType'),
                boarding: form.elements.enrollmentType.value === 'internal' && boarding.checked,
                programme: f.get('programme'),
                placement: f.get('placement')
            };
        };
        // A pupil with no enrolment in this year has none of the annual
        // fields; these are what the form showed for them, so they are also
        // what "unchanged" means.
        const stored = {
            name: pupil.name, grade: pupil.grade || null, oddelenie: pupil.oddelenie || null,
            enrollmentType: pupil.enrollment_type || 'internal', boarding: Boolean(pupil.boarding),
            programme: pupil.programme || 'unknown', placement: pupil.placement || 'unknown'
        };
        let row = pupil;
        const put = (values, active) => request('PUT', '/api/workspace/pupils/' + encodeURIComponent(row.public_id),
            Object.assign({ year, active, expected: row.expected }, values));
        const done = (said, extra) => {
            announce(Object.assign({ kind: 'pupil', id: row.public_id, year, said }, extra || {}));
            shell.close(true);
        };

        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            const values = fields();
            if (!values.name) { shell.say('Името не смее да биде празно.', 'error'); form.elements.name.focus(); return; }
            const chosen = [...form.querySelectorAll('input[name="therapist"]:checked')].map((n) => Number(n.value)).sort((a, b) => a - b);
            const had = [...mine].sort((a, b) => a - b);
            const pupilChanged = JSON.stringify(values) !== JSON.stringify(stored);
            const therapistsChanged = JSON.stringify(chosen) !== JSON.stringify(had);
            if (!pupilChanged && !therapistsChanged) { shell.say('Нема промена.', ''); return; }
            shell.busy(true);
            shell.say('Зачувувам…', '');
            try {
                if (pupilChanged) row = (await put(values, Boolean(row.annual_active))).pupil;
                if (therapistsChanged) {
                    row = (await request('PUT', '/api/workspace/pupils/' + encodeURIComponent(row.public_id) + '/therapists',
                        { year, expected: row.expected, therapistIds: chosen })).pupil;
                }
                done('Зачувано во базата: ' + row.name);
            } catch (err) {
                shell.busy(false);
                syncBoarding();
                // The draft stays exactly as typed. A stale write says what the
                // server said; the person decides whether to keep their version.
                shell.say(err.message, 'error');
            }
        });

        shell.node.addEventListener('click', async (event) => {
            const act = event.target.closest('[data-act]');
            if (!act || !['leave', 'rejoin', 'purge'].includes(act.dataset.act)) return;
            if (shell.dirty()) { shell.say('Прво зачувајте или откажете ги промените горе.', 'error'); return; }
            if (act.dataset.act === 'purge') {
                const sure = await shell.ask(`Да се избрише ${row.name} засекогаш? Само ако е грешка при внес.`, 'Да, избриши', 'Не');
                if (!sure) return;
                shell.busy(true);
                try {
                    await request('DELETE', '/api/roster/student/' + encodeURIComponent(row.public_id)
                        + '?year=' + encodeURIComponent(year) + '&expected=' + encodeURIComponent(row.name));
                    done('Избришано: ' + row.name, { deleted: true });
                } catch (err) {
                    shell.busy(false);
                    shell.say(err.status === 409
                        ? 'Не може да се избрише: ' + row.name + ' има записи или е на листа во друга година, '
                          + 'па не е грешка при внес. За да не се гледа оваа година, користете „Тргни од листата“. '
                          + '(' + err.message + ')'
                        : err.message, 'error');
                }
                return;
            }
            const leaving = act.dataset.act === 'leave';
            if (leaving && !(await shell.ask(`${row.name} ќе се тргне од листата за ${year}. Историјата останува.`, 'Тргни', 'Не'))) return;
            shell.busy(true);
            try {
                row = (await put(stored, !leaving)).pupil;
                done(leaving ? `${row.name} е тргнат(а) од листата за ${year}` : `${row.name} е вратен(а) на листата за ${year}`);
            } catch (err) {
                shell.busy(false);
                syncBoarding();
                shell.say(err.message, 'error');
            }
        });
        form.elements.name.focus();
    }

    // ── the registry ────────────────────────────────────────────────────────
    const FORMS = { pupil: openPupil };

    function open(kind, ctx) {
        const form = FORMS[kind];
        if (!form) { console.warn('MTBForms: no form for', kind); return null; }
        return form(ctx || {});
    }

    // ── looks ───────────────────────────────────────────────────────────────
    // Every element that sets a background also sets its colour: a <button>
    // does not inherit `color`, and the dark theme is where that shows
    // (CLAUDE.md, „A <button> does not inherit color").
    const style = document.createElement('style');
    style.textContent = `
        .mtb-door { display: none; margin: 0 0 0 6px; padding: 0 4px; border: 1px solid transparent;
            border-radius: 5px; background: transparent; color: inherit; cursor: pointer;
            font-size: 13px; line-height: 1.5; vertical-align: baseline; }
        html[data-mtb-editing] .mtb-door { display: inline-block; }
        .mtb-door:hover, .mtb-door:focus-visible { border-color: #8f98c9; background: rgba(90, 103, 216, .14); outline: none; }
        @media print { .mtb-door { display: none !important; } }

        .mtb-form { --f-bg: #ffffff; --f-text: #1d1e33; --f-muted: #555872; --f-line: #d3d4e4; --f-input: #ffffff;
            --f-accent: #4c51bf; --f-on-accent: #ffffff; --f-ok: #1a6b4f; --f-err: #b0243a; --f-ask: #fff4d6;
            padding: 0; border: 1px solid var(--f-line); border-radius: 12px; background: var(--f-bg); color: var(--f-text);
            width: min(560px, calc(100vw - 32px)); max-height: calc(100vh - 32px);
            box-shadow: 0 18px 50px rgba(0, 0, 0, .35); font: 14px/1.45 system-ui, -apple-system, 'Segoe UI', sans-serif; }
        html[data-theme="dark"] .mtb-form { --f-bg: #1f2233; --f-text: #e8e9f5; --f-muted: #b6b9d2; --f-line: #41466a;
            --f-input: #2a2e46; --f-accent: #5b61d6; --f-on-accent: #ffffff; --f-ok: #73d6ab; --f-err: #ffa3b0; --f-ask: #3b3322; }
        .mtb-form::backdrop { background: rgba(10, 12, 24, .55); }
        .mtb-form__card { display: flex; flex-direction: column; max-height: calc(100vh - 34px); margin: 0; }
        .mtb-form header { display: flex; align-items: center; gap: 8px; padding: 14px 16px 2px; }
        .mtb-form h2 { margin: 0; flex: 1; font-size: 17px; color: var(--f-text); }
        .mtb-form__x { padding: 2px 8px; border: 0; border-radius: 6px; background: transparent; color: var(--f-muted);
            font-size: 18px; cursor: pointer; }
        .mtb-form__x:hover, .mtb-form__x:focus-visible { background: var(--f-input); color: var(--f-text); outline: none; }
        .mtb-form__sub { padding: 0 16px 8px; color: var(--f-muted); font-size: 12.5px; }
        .mtb-form__body { padding: 4px 16px 10px; overflow: auto; }
        .mtb-form fieldset.mtb-form__plain { margin: 0; padding: 0; border: 0; min-width: 0; }
        .mtb-form fieldset { margin: 12px 0 0; padding: 8px 12px 10px; border: 1px solid var(--f-line); border-radius: 9px; min-width: 0; }
        .mtb-form legend { padding: 0 4px; color: var(--f-muted); font-size: 12.5px; font-weight: 700; }
        .mtb-form label { display: flex; flex-direction: column; gap: 4px; margin-top: 8px; color: var(--f-muted);
            font-size: 12.5px; font-weight: 600; }
        .mtb-form label.mtb-form__check { flex-direction: row; align-items: center; gap: 8px; margin-top: 6px;
            color: var(--f-text); font-size: 13.5px; font-weight: 500; }
        .mtb-form input[type="text"], .mtb-form select { min-width: 0; padding: 7px 9px; border: 1px solid var(--f-line);
            border-radius: 7px; background: var(--f-input); color: var(--f-text); font: inherit; }
        .mtb-form input:focus-visible, .mtb-form select:focus-visible, .mtb-form button:focus-visible {
            outline: 2px solid var(--f-accent); outline-offset: 1px; }
        .mtb-form__grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 0 14px; }
        .mtb-form__checks { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 0 12px; }
        .mtb-form__hint { margin: 8px 0 0; color: var(--f-muted); font-size: 12px; }
        .mtb-form__zone { margin-top: 14px; }
        .mtb-form__zone summary { color: var(--f-muted); font-size: 12.5px; font-weight: 700; cursor: pointer; }
        .mtb-form__row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
        .mtb-form__status { min-height: 18px; padding: 0 16px; font-size: 13px; color: var(--f-text); }
        .mtb-form__status[data-kind="ok"] { color: var(--f-ok); }
        .mtb-form__status[data-kind="error"] { color: var(--f-err); }
        .mtb-form__ask { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 4px 16px 6px;
            padding: 8px 10px; border-radius: 8px; background: var(--f-ask); color: var(--f-text); }
        .mtb-form__ask[hidden] { display: none; }
        .mtb-form footer { display: flex; flex-wrap: wrap; gap: 8px; padding: 10px 16px 14px; border-top: 1px solid var(--f-line); }
        .mtb-form__btn { padding: 7px 14px; border: 1px solid var(--f-line); border-radius: 7px; background: var(--f-input);
            color: var(--f-text); font: inherit; font-weight: 600; cursor: pointer; }
        .mtb-form__btn:disabled { opacity: .6; cursor: default; }
        .mtb-form__primary { border-color: var(--f-accent); background: var(--f-accent); color: var(--f-on-accent); }
        .mtb-form__danger { border-color: currentColor; background: var(--f-bg); color: var(--f-err); }
    `;
    document.head.appendChild(style);

    window.MTBForms = { editing, setEditing, bindSwitch, doorHtml, open, request };
    applyMode();
})();

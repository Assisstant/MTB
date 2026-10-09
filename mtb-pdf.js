/*
 * MTBPdf — a PDF file made by the page, not by the print dialog, and the one
 * place where a printed sheet's look is chosen.
 *
 * The owner (4 Oct 2026): printing through a PDF printer such as PDF24 put
 * the browser's own header and footer on the sheet (date, title, address,
 * „1/4") and cut the poster to the printer's paper. A page cannot switch the
 * browser's header and footer off, and the paper size is the printer's
 * choice, not the page's. So for anything that must come out the same
 * whatever is installed, the page draws the PDF itself and hands over the
 * file: its pages are the size asked for, and nothing is added to them.
 *
 * And the look is chosen BEFORE the file is made („Изглед на PDF"): the
 * paper, the title, the footer, the size of the letters and what is on the
 * sheet, with a picture of the sheet that follows every change. The footer
 * and the size of the letters are the same for every print in the apps —
 * they are stored once (`mtb_print_v1`); what a document has on it, its
 * title and its paper are stored per document. Layout only, in this browser.
 *
 * How: the content is drawn to a canvas (html2canvas) at print resolution
 * (300 dpi) and placed on pages of exactly the chosen size (jsPDF). Both are
 * fetched from cdnjs the first time; without a connection `load()` fails and
 * the caller says so.
 *
 *   MTBPdf.dialog({ doc, heading, formats, parts, title, file, render })
 *       render(settings) → { node, area } — the content laid out at `area` mm, on screen
 *   MTBPdf.area(format)          the content area of a format, mm
 *   MTBPdf.make(node, format, { file, footer })
 */
(function () {
    'use strict';
    if (window.MTBPdf) return;

    const LIBS = [
        ['html2canvas', 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js'],
        ['jspdf', 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js']
    ];
    const MM = 96 / 25.4;
    const MARGIN = 10;
    const OVERLAP = 10;

    /** Paper. A tiled format is several sheets glued with 1 cm of overlap. */
    const FORMATS = {
        a2: { label: 'A2 — една страница', hint: '594 × 420 mm', page: [594, 420] },
        a3: { label: 'A3 — една страница', hint: '420 × 297 mm', page: [420, 297] },
        a4: { label: 'A4 — една страница', hint: '297 × 210 mm, ситно', page: [297, 210] },
        'a2-4': { label: 'A2 на 4 листа A4', hint: 'за лепење, 1 cm преклоп', sheet: [297, 210], cols: 2, rows: 2 },
        'a3-2': { label: 'A3 на 2 листа A4', hint: 'за лепење, 1 cm преклоп', sheet: [210, 297], cols: 2, rows: 1 },
        // A0 is 1189 × 841 mm (owner, 9 Oct 2026). Sixteen A4 sheets are that
        // paper, but a printer leaves a margin and the sheets overlap to be
        // glued, so the poster they make is 108 × 73 cm — it fits an A0 board
        // with a border. The whole of it is one canvas: at 300 dpi that is
        // 110 million points, more than a school computer should be asked for,
        // and the letters are twice A2's size, so 200 dpi is drawn finer than A2.
        'a0-16': { label: 'A0 на 16 листа A4', hint: 'за сечење и лепење; составено 108 × 73 cm', sheet: [297, 210], cols: 4, rows: 4, dpi: 200 }
    };

    function layout(key) {
        const f = FORMATS[key] || FORMATS.a2;
        if (f.page) return { page: f.page, area: [f.page[0] - 2 * MARGIN, f.page[1] - 2 * MARGIN], cols: 1, rows: 1 };
        const view = [f.sheet[0] - 2 * MARGIN, f.sheet[1] - 2 * MARGIN];
        const step = [view[0] - OVERLAP, view[1] - OVERLAP];
        return {
            sheet: f.sheet, view, step, cols: f.cols, rows: f.rows, dpi: f.dpi,
            area: [view[0] + (f.cols - 1) * step[0], view[1] + (f.rows - 1) * step[1]]
        };
    }
    const area = (key) => layout(key).area;

    // ── the libraries ──────────────────────────────────────────────────────
    function script(src) {
        return new Promise((done, fail) => {
            const s = document.createElement('script');
            s.src = src;
            s.onload = () => done();
            s.onerror = () => fail(new Error('не може да се вчита ' + src));
            document.head.appendChild(s);
        });
    }
    let ready = null;
    function load() {
        if (!ready) {
            ready = Promise.all(LIBS.map(([name, src]) => (window[name] ? null : script(src))))
                .catch((err) => { ready = null; throw err; });
        }
        return ready;
    }

    /** The node as a canvas: `size` mm, at `dpi`. */
    async function picture(node, size, dpi) {
        const w = Math.round(size[0] * MM);
        const h = Math.round(size[1] * MM);
        if (document.fonts && document.fonts.ready) await document.fonts.ready;
        return window.html2canvas(node, {
            scale: (dpi || 300) / 96, width: w, height: h, windowWidth: w, windowHeight: h,
            backgroundColor: '#ffffff', logging: false, useCORS: true
        });
    }
    const jpeg = (canvas) => canvas.toDataURL('image/jpeg', 0.95);

    // ── the footer every print shares ──────────────────────────────────────
    const today = () => new Date().toLocaleDateString('mk-MK');
    function footerParts(footer, n, total, note) {
        const f = footer || {};
        if (!f.on) return note ? [note, '', ''] : null;
        const right = [f.date ? 'Отпечатено ' + today() : '', f.pages ? `страница ${n} од ${total}` : ''].filter(Boolean).join(' · ');
        return [note || f.text || '', note ? (f.text || '') : '', right];
    }
    /**
     * A line of text as a picture: jsPDF's own fonts have no Cyrillic, and a
     * canvas writes any script. Left, centre and right, like a page footer.
     */
    function lineImage(parts, widthMm, px) {
        const c = document.createElement('canvas');
        c.width = Math.round(widthMm * px);
        c.height = Math.round(5 * px);
        const g = c.getContext('2d');
        g.fillStyle = '#ffffff';
        g.fillRect(0, 0, c.width, c.height);
        g.fillStyle = '#444444';
        g.font = `${Math.round(2.8 * px)}px "Segoe UI", Arial, sans-serif`;
        g.textBaseline = 'middle';
        const third = c.width / 3;
        if (parts[0]) { g.textAlign = 'left'; g.fillText(parts[0], 0, c.height / 2, parts[1] ? third * 1.6 : c.width * 0.7); }
        if (parts[1]) { g.textAlign = 'center'; g.fillText(parts[1], c.width * 0.62, c.height / 2, third); }
        if (parts[2]) { g.textAlign = 'right'; g.fillText(parts[2], c.width, c.height / 2, third); }
        return c;
    }

    function save(pdf, file) {
        pdf.save(String(file || 'MTB').replace(/[\\/:*?"<>|]+/g, '-') + '.pdf');
    }

    /**
     * The PDF itself. `node` is the content laid out at `area(format)` mm; a
     * one-page format puts it on the page `MARGIN` mm in, a tiled one cuts it
     * into sheets that repeat `OVERLAP` mm of their neighbour, inside a dashed
     * line to cut along, each saying which part it is and where it goes.
     */
    async function make(node, format, o) {
        const opt = o || {};
        await load();
        const L = layout(format);
        const canvas = await picture(node, L.area, opt.dpi || L.dpi || 300);
        const px = canvas.width / L.area[0];
        const { jsPDF } = window.jspdf;
        const orient = (s) => (s[0] > s[1] ? 'landscape' : 'portrait');
        if (L.page) {
            const pdf = new jsPDF({ orientation: orient(L.page), unit: 'mm', format: L.page, compress: true });
            pdf.addImage(jpeg(canvas), 'JPEG', MARGIN, MARGIN, L.area[0], L.area[1]);
            const parts = footerParts(opt.footer, 1, 1);
            if (parts) pdf.addImage(jpeg(lineImage(parts, L.area[0], px)), 'JPEG', MARGIN, L.page[1] - MARGIN + 2.5, L.area[0], 5);
            save(pdf, opt.file);
            return pdf;
        }
        const total = L.cols * L.rows;
        // Four or two sheets are said by their corner; more than that by row
        // and column, which is how sixteen are laid out on a table.
        const corner = total === 4 ? ['горе лево', 'горе десно', 'долу лево', 'долу десно'] : total === 2 ? ['лево', 'десно'] : null;
        const pdf = new jsPDF({ orientation: orient(L.sheet), unit: 'mm', format: L.sheet, compress: true });
        let n = 0;
        for (let row = 0; row < L.rows; row++) {
            for (let col = 0; col < L.cols; col++, n++) {
                if (n) pdf.addPage(L.sheet, orient(L.sheet));
                const piece = document.createElement('canvas');
                piece.width = Math.round(L.view[0] * px);
                piece.height = Math.round(L.view[1] * px);
                const g = piece.getContext('2d');
                g.fillStyle = '#ffffff';
                g.fillRect(0, 0, piece.width, piece.height);
                g.drawImage(canvas, Math.round(col * L.step[0] * px), Math.round(row * L.step[1] * px),
                    piece.width, piece.height, 0, 0, piece.width, piece.height);
                pdf.addImage(jpeg(piece), 'JPEG', MARGIN, MARGIN, L.view[0], L.view[1]);
                pdf.setLineDashPattern([1.5, 1.5], 0);
                pdf.setDrawColor(140);
                pdf.setLineWidth(0.2);
                pdf.rect(MARGIN, MARGIN, L.view[0], L.view[1]);
                const glue = [col < L.cols - 1 ? 'десниот раб под дел ' + (n + 2) : '',
                    row < L.rows - 1 ? 'долниот раб под дел ' + (n + 1 + L.cols) : ''].filter(Boolean).join(' · ');
                const place = corner ? corner[n] || '' : `ред ${row + 1}, колона ${col + 1}`;
                const note = `Дел ${n + 1} од ${total} · ${place}${glue ? ' — ' + glue : ''} · сечи по линијата`;
                const parts = footerParts(opt.footer, n + 1, total, note);
                pdf.addImage(jpeg(lineImage(parts, L.view[0], px)), 'JPEG', MARGIN, L.sheet[1] - MARGIN + 2.5, L.view[0], 5);
            }
        }
        save(pdf, opt.file);
        return pdf;
    }

    // ── what is remembered ─────────────────────────────────────────────────
    const SHARED_KEY = 'mtb_print_v1';
    const SHARED_DEFAULT = {
        footer: { on: true, text: 'ОУРЦ „Кочо Рацин“ – Битола', date: true, pages: true },
        letters: 1
    };
    function readStore(key) {
        try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (_) { return null; }
    }
    function writeStore(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* a private window keeps nothing */ }
    }
    function settingsFor(o) {
        const shared = Object.assign({}, SHARED_DEFAULT, readStore(SHARED_KEY) || {});
        shared.footer = Object.assign({}, SHARED_DEFAULT.footer, shared.footer || {});
        const own = readStore(SHARED_KEY + ':' + o.doc) || {};
        const parts = {};
        (o.parts || []).forEach((p) => { parts[p.key] = own.parts && p.key in own.parts ? Boolean(own.parts[p.key]) : p.on !== false; });
        return {
            format: (o.formats || []).includes(own.format) ? own.format : (o.formats || ['a2'])[0],
            title: Object.assign({ on: true, text: o.title || '' }, own.title || {}),
            parts,
            footer: shared.footer,
            letters: [0.85, 1, 1.15].includes(Number(shared.letters)) ? Number(shared.letters) : 1
        };
    }
    function remember(o, s) {
        writeStore(SHARED_KEY, { footer: s.footer, letters: s.letters });
        writeStore(SHARED_KEY + ':' + o.doc, { format: s.format, title: s.title, parts: s.parts });
    }

    // ── „Изглед на PDF" ────────────────────────────────────────────────────
    const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    function addStyle() {
        if (document.getElementById('mtbPdfStyle')) return;
        const st = document.createElement('style');
        st.id = 'mtbPdfStyle';
        st.textContent = `
        .mtb-pdf-back { position: fixed; inset: 0; z-index: 10001; background: rgba(15, 20, 35, .72);
            display: flex; align-items: center; justify-content: center; padding: 16px; }
        .mtb-pdf { box-sizing: border-box; width: min(1180px, 100%); max-height: calc(100vh - 32px); overflow: auto;
            display: grid; grid-template-columns: 330px 1fr; gap: 18px; padding: 18px 20px;
            background: var(--card, #fff); color: var(--text, #1b2433); border-radius: 14px;
            box-shadow: 0 24px 60px rgba(0, 0, 0, .4); font: 14px "Segoe UI", system-ui, sans-serif; }
        @media (max-width: 820px) { .mtb-pdf { grid-template-columns: 1fr; } }
        .mtb-pdf h2 { grid-column: 1 / -1; margin: 0; font-size: 18px; }
        .mtb-pdf fieldset { border: 1px solid var(--border, #d5dbe8); border-radius: 10px; margin: 0 0 10px; padding: 8px 12px 10px; }
        .mtb-pdf legend { padding: 0 4px; font-weight: 700; font-size: 13px; }
        .mtb-pdf label { display: flex; align-items: center; gap: 8px; margin: 5px 0; font-size: 13px; cursor: pointer; }
        .mtb-pdf label small { color: var(--muted, #6a7590); margin-left: auto; font-size: 11.5px; }
        .mtb-pdf input[type=text] { flex: 1; min-width: 0; padding: 5px 8px; border: 1px solid var(--border, #c9cfdc);
            border-radius: 7px; background: var(--card, #fff); color: var(--text, #1b2433); font: inherit; }
        .mtb-pdf .row { display: flex; gap: 6px; flex-wrap: wrap; }
        .mtb-pdf .row label { margin: 3px 8px 3px 0; }
        .mtb-pdf .view { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
        .mtb-pdf .paper { position: relative; background: #e9ecf3; border-radius: 10px; padding: 14px;
            display: flex; align-items: center; justify-content: center; min-height: 260px; }
        .mtb-pdf .paper canvas { max-width: 100%; max-height: 62vh; background: #fff; box-shadow: 0 6px 22px rgba(0, 0, 0, .25); }
        .mtb-pdf .paper .wait { position: absolute; top: 10px; right: 14px; font-size: 12px; color: #4a5568; }
        .mtb-pdf .what { font-size: 12px; color: var(--muted, #6a7590); }
        .mtb-pdf .acts { display: flex; gap: 8px; justify-content: flex-end; align-items: center; flex-wrap: wrap; }
        .mtb-pdf .acts .say { margin-right: auto; font-size: 12.5px; color: var(--muted, #6a7590); }
        .mtb-pdf button { font: 600 14px "Segoe UI", system-ui, sans-serif; border-radius: 999px; padding: 7px 16px; cursor: pointer;
            border: 1px solid var(--border, #c9cfdc); background: var(--card, #fff); color: var(--text, #1b2433); }
        .mtb-pdf button.go { background: #2563d9; border-color: #2563d9; color: #fff; }
        .mtb-pdf button:disabled { opacity: .6; cursor: progress; }`;
        document.head.appendChild(st);
    }

    /**
     * Opens „Изглед на PDF". `render(settings)` lays the content out on
     * screen and gives back { node, area, done } — `done()` takes it away
     * again. Resolves when the dialog closes.
     */
    function dialog(o) {
        addStyle();
        const s = settingsFor(o);
        const back = document.createElement('div');
        back.className = 'mtb-pdf-back';
        back.innerHTML = `<div class="mtb-pdf" role="dialog" aria-modal="true" aria-label="${esc(o.heading || 'Изглед на PDF')}">
            <h2>${esc(o.heading || 'Изглед на PDF')}</h2>
            <div class="opts">
              <fieldset><legend>Хартија</legend>
                ${(o.formats || ['a2']).map((k) => `<label><input type="radio" name="format" value="${k}"${k === s.format ? ' checked' : ''}>
                  ${esc(FORMATS[k].label)}<small>${esc(FORMATS[k].hint)}</small></label>`).join('')}
              </fieldset>
              <fieldset><legend>Наслов</legend>
                <label><input type="checkbox" data-k="title.on"${s.title.on ? ' checked' : ''}><input type="text" data-k="title.text" value="${esc(s.title.text)}"></label>
              </fieldset>
              ${(o.parts || []).length ? `<fieldset><legend>На листот</legend>
                ${o.parts.map((p) => `<label><input type="checkbox" data-part="${esc(p.key)}"${s.parts[p.key] ? ' checked' : ''}> ${esc(p.label)}</label>`).join('')}
              </fieldset>` : ''}
              <fieldset><legend>Подножје — исто за сите печатења</legend>
                <label><input type="checkbox" data-k="footer.on"${s.footer.on ? ' checked' : ''}><input type="text" data-k="footer.text" value="${esc(s.footer.text)}"></label>
                <div class="row">
                  <label><input type="checkbox" data-k="footer.date"${s.footer.date ? ' checked' : ''}> датум на печатење</label>
                  <label><input type="checkbox" data-k="footer.pages"${s.footer.pages ? ' checked' : ''}> страница N од M</label>
                </div>
              </fieldset>
              <fieldset><legend>Букви — исто за сите печатења</legend>
                <div class="row">${[[0.85, 'помали'], [1, 'нормални'], [1.15, 'поголеми']].map(([v, t]) =>
                    `<label><input type="radio" name="letters" value="${v}"${v === s.letters ? ' checked' : ''}> ${t}</label>`).join('')}</div>
              </fieldset>
            </div>
            <div class="view">
              <div class="paper"><canvas width="10" height="10"></canvas><span class="wait">прегледот се црта…</span></div>
              <div class="what"></div>
              <div class="acts"><span class="say" role="status"></span>
                <button type="button" data-close>Откажи</button>
                <button type="button" class="go" data-make>⬇ Преземи PDF</button></div>
            </div>
          </div>`;
        document.body.appendChild(back);
        const $ = (q) => back.querySelector(q);
        const say = (t) => { $('.say').textContent = t || ''; };

        function read() {
            s.format = (back.querySelector('input[name=format]:checked') || {}).value || s.format;
            s.letters = Number((back.querySelector('input[name=letters]:checked') || {}).value || 1);
            back.querySelectorAll('[data-k]').forEach((i) => {
                const [a, b] = i.dataset.k.split('.');
                s[a][b] = i.type === 'checkbox' ? i.checked : i.value;
            });
            back.querySelectorAll('[data-part]').forEach((i) => { s.parts[i.dataset.part] = i.checked; });
            return s;
        }

        // The picture: the same layout, drawn small, with the cut lines of a
        // tiled format, and what the file will be.
        // The preview and the file lay the content out in the same place on
        // the page, so they take turns: the file waits for a picture in flight.
        let ticket = 0;
        let timer = null;
        let running = Promise.resolve();
        function preview() {
            running = draw();
            return running;
        }
        async function draw() {
            const mine = ++ticket;
            $('.wait').hidden = false;
            try {
                await load();
                const L = layout(read().format);
                const made = await o.render(s);
                let canvas;
                try { canvas = await picture(made.node, L.area, 34); } finally { made.done && made.done(); }
                if (mine !== ticket) return;
                const out = $('.paper canvas');
                const pad = MARGIN * canvas.width / L.area[0];
                const full = L.page ? L.page : [L.area[0] + 2 * MARGIN, L.area[1] + 2 * MARGIN];
                out.width = Math.round(full[0] * canvas.width / L.area[0]);
                out.height = Math.round(full[1] * canvas.width / L.area[0]);
                const g = out.getContext('2d');
                g.fillStyle = '#fff'; g.fillRect(0, 0, out.width, out.height);
                g.drawImage(canvas, pad, pad);
                // The shared footer, where the file will have it.
                const k0 = canvas.width / L.area[0];
                const foot = L.page ? footerParts(s.footer, 1, 1) : null;
                if (foot) g.drawImage(lineImage(foot, L.area[0], k0), pad, Math.round((L.page[1] - MARGIN + 2.5) * k0));
                if (!L.page) {
                    g.strokeStyle = 'rgba(220, 38, 38, .8)'; g.setLineDash([6, 4]); g.lineWidth = 1.5;
                    const k = canvas.width / L.area[0];
                    for (let c = 1; c < L.cols; c++) {
                        [c * L.step[0], c * L.step[0] + OVERLAP].forEach((x) => { g.beginPath(); g.moveTo(pad + x * k, pad); g.lineTo(pad + x * k, pad + canvas.height); g.stroke(); });
                    }
                    for (let r = 1; r < L.rows; r++) {
                        [r * L.step[1], r * L.step[1] + OVERLAP].forEach((y) => { g.beginPath(); g.moveTo(pad, pad + y * k); g.lineTo(pad + canvas.width, pad + y * k); g.stroke(); });
                    }
                }
                const sheets = L.page ? '1 страница ' + FORMATS[s.format].hint : `${L.cols * L.rows} листа A4 (црвено: каде се преклопуваат)`;
                $('.what').textContent = `${sheets} · „${o.file(s)}.pdf“`;
                say('');
            } catch (err) {
                if (mine === ticket) say('Прегледот не може да се нацрта: ' + (err && err.message ? err.message : err));
            } finally {
                if (mine === ticket) $('.wait').hidden = true;
            }
        }
        const later = () => { clearTimeout(timer); timer = setTimeout(preview, 250); };
        back.addEventListener('input', later);
        back.addEventListener('change', later);

        return new Promise((resolve) => {
            const close = (result) => { clearTimeout(timer); ticket++; back.remove(); resolve(result); };
            $('[data-close]').addEventListener('click', () => close(null));
            back.addEventListener('click', (e) => { if (e.target === back) close(null); });
            back.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(null); });
            $('[data-make]').addEventListener('click', async () => {
                const go = $('[data-make]');
                go.disabled = true;
                say('се прави PDF…');
                clearTimeout(timer);
                ticket++;
                await running.catch(() => null);
                try {
                    read();
                    remember(o, s);
                    const made = await o.render(s);
                    try {
                        await make(made.node, s.format, { file: o.file(s), footer: s.footer });
                    } finally { made.done && made.done(); }
                    close({ settings: s, file: o.file(s) + '.pdf' });
                } catch (err) {
                    go.disabled = false;
                    say('PDF не може да се направи: ' + (err && err.message ? err.message : err));
                }
            });
            preview();
            $('[data-make]').focus();
        });
    }

    window.MTBPdf = { load, area, make, dialog, FORMATS, settings: settingsFor };
})();

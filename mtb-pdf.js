/*
 * MTBPdf — a PDF file made by the page, not by the print dialog.
 *
 * The owner (4 Oct 2026): printing through a PDF printer such as PDF24 put
 * the browser's own header and footer on the sheet (date, title, address,
 * „1/4") and cut the poster to the printer's paper. A page cannot switch the
 * browser's header and footer off, and the paper size is the printer's
 * choice, not the page's. So for anything that must come out the same
 * whatever is installed, the page draws the PDF itself and hands over the
 * file: its pages are the size asked for, and nothing is added to them.
 *
 * How: the element is drawn to a canvas (html2canvas) at print resolution
 * (300 dpi by default) and the canvas is placed on pages of exactly the
 * given size (jsPDF). Both libraries are fetched from cdnjs the first time a
 * PDF is asked for; without a connection `load()` fails and the caller falls
 * back to the print dialog.
 *
 *   MTBPdf.page(node, { size: [w, h], file })   one page of w × h mm, the node drawn edge to edge
 *   MTBPdf.tiles(node, { size, sheet, view, step, margin, notes, file })
 *                                               the node cut into sheets that overlap where they are glued
 */
(function () {
    'use strict';
    if (window.MTBPdf) return;

    const LIBS = [
        ['html2canvas', 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js'],
        ['jspdf', 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js']
    ];
    const MM = 96 / 25.4;

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

    /** The node as a canvas, `size` mm, at `dpi`. */
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

    function save(pdf, file) {
        pdf.save(String(file || 'MTB').replace(/[\\/:*?"<>|]+/g, '-') + '.pdf');
    }

    async function page(node, o) {
        await load();
        const canvas = await picture(node, o.size, o.dpi);
        const pdf = new window.jspdf.jsPDF({ orientation: o.size[0] > o.size[1] ? 'landscape' : 'portrait', unit: 'mm', format: o.size, compress: true });
        pdf.addImage(jpeg(canvas), 'JPEG', 0, 0, o.size[0], o.size[1]);
        save(pdf, o.file);
        return pdf;
    }

    /**
     * One big picture on several sheets. Sheet n shows `view` mm of it from
     * (col·step, row·step), `margin` mm in from the edge, inside a dashed line
     * to cut along; `notes[n]` is written under it.
     */
    async function tiles(node, o) {
        await load();
        const dpi = o.dpi || 300;
        const canvas = await picture(node, o.size, dpi);
        const px = canvas.width / o.size[0];
        const cols = Math.max(1, Math.ceil((o.size[0] - o.view[0]) / o.step[0]) + 1);
        const rows = Math.max(1, Math.ceil((o.size[1] - o.view[1]) / o.step[1]) + 1);
        const pdf = new window.jspdf.jsPDF({ orientation: o.sheet[0] > o.sheet[1] ? 'landscape' : 'portrait', unit: 'mm', format: o.sheet, compress: true });
        let n = 0;
        for (let row = 0; row < rows; row++) {
            for (let col = 0; col < cols; col++, n++) {
                if (n) pdf.addPage(o.sheet, o.sheet[0] > o.sheet[1] ? 'landscape' : 'portrait');
                const piece = document.createElement('canvas');
                piece.width = Math.round(o.view[0] * px);
                piece.height = Math.round(o.view[1] * px);
                const g = piece.getContext('2d');
                g.fillStyle = '#ffffff';
                g.fillRect(0, 0, piece.width, piece.height);
                g.drawImage(canvas, Math.round(col * o.step[0] * px), Math.round(row * o.step[1] * px),
                    piece.width, piece.height, 0, 0, piece.width, piece.height);
                pdf.addImage(jpeg(piece), 'JPEG', o.margin, o.margin, o.view[0], o.view[1]);
                pdf.setLineDashPattern([1.5, 1.5], 0);
                pdf.setDrawColor(140);
                pdf.setLineWidth(0.2);
                pdf.rect(o.margin, o.margin, o.view[0], o.view[1]);
                const note = (o.notes || [])[n];
                if (note) {
                    // jsPDF's own fonts have no Cyrillic: the line is drawn
                    // as a picture, which the canvas writes in any script.
                    const line = document.createElement('canvas');
                    const lw = Math.round(o.view[0] * px);
                    const lh = Math.round(5 * px);
                    line.width = lw; line.height = lh;
                    const t = line.getContext('2d');
                    t.fillStyle = '#ffffff'; t.fillRect(0, 0, lw, lh);
                    t.fillStyle = '#555555';
                    t.font = `${Math.round(2.8 * px)}px "Segoe UI", Arial, sans-serif`;
                    t.textBaseline = 'middle';
                    t.fillText(note, 0, lh / 2, lw);
                    pdf.addImage(jpeg(line), 'JPEG', o.margin, o.sheet[1] - o.margin + 2, o.view[0], 5);
                }
            }
        }
        save(pdf, o.file);
        return pdf;
    }

    window.MTBPdf = { load, page, tiles };
})();

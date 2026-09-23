/**
 * One typographic standard for every document the suite produces — the Word
 * files and the printed sheets of S-Dnevnik, Распоред and Евидентен лист.
 *
 * Stated by the owner on 23 September 2026: Times New Roman, 11 pt for
 * ordinary text, and headings a standard step above it. Before this each
 * generator chose its own — Arial 10 pt in one, Times 11 PX (8 pt on paper) in
 * another, 12 pt in a third — so two documents from the same centre looked
 * like they came from two places.
 *
 * Sizes are in POINTS, never pixels. A browser prints 11px as 8.25pt, and Word
 * reads px in an .doc as screen pixels; the documents were smaller than anyone
 * asked for exactly because of that unit.
 *
 * A generator starts its <style> with `MTBDocument.css` and then adds only
 * layout and colour. It must not restate the font or the sizes of body text
 * and headings — a later rule wins, and that is how the standard would drift
 * back apart. The two smaller sizes are for what is not text to read: a note
 * (`small`) and a footer or a time label (`tiny`).
 *
 * `tableCss` is the other half, stated the same evening: the documents look
 * like S-Dnevnik's. A header row on a light grey with S-Dnevnik's purple
 * line under it, dark grey text, and `.rule` for the purple divider under a
 * title. A generator adds it AFTER its own cell borders, so the purple line
 * wins over a boxed form's black one, and never restates a header colour.
 */
(function () {
    'use strict';

    const FONT = '"Times New Roman", Times, serif';
    const SIZE = { body: '11pt', h1: '16pt', h2: '14pt', h3: '12pt', h4: '11pt', small: '9pt', tiny: '8pt' };

    const css =
        'body{font-family:' + FONT + ';font-size:' + SIZE.body + ';line-height:1.3;color:#000;}' +
        'p,li,td,th{font-family:' + FONT + ';font-size:' + SIZE.body + ';}' +
        'h1,h2,h3,h4{font-family:' + FONT + ';font-weight:bold;line-height:1.2;}' +
        'h1{font-size:' + SIZE.h1 + ';}' +
        'h2{font-size:' + SIZE.h2 + ';}' +
        'h3{font-size:' + SIZE.h3 + ';}' +
        'h4{font-size:' + SIZE.h4 + ';}' +
        'p{margin:0 0 6pt;}';

    const ACCENT = '#667eea';
    const tableCss =
        'h1,h2{color:#222;}h3{color:#333;}' +
        'th{background:#f8f9fa;color:#444;font-weight:bold;text-align:center;border-bottom:2px solid ' + ACCENT + ';}' +
        '.rule{border:none;border-top:2px solid ' + ACCENT + ';margin:4pt 0 10pt;}';

    window.MTBDocument = Object.freeze({ FONT, SIZE: Object.freeze(SIZE), css, ACCENT, tableCss });
})();

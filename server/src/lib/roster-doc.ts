/**
 * Reading the school's own list of pupils — a Word table, and nothing else.
 *
 * Every September the resource centre writes the year's lists into its годишна
 * програма: which classes were formed, and who is in them. That document is
 * the source; the database has been guessing at it, because until now a
 * child's class only ever arrived embedded in their NAME („V-а - Име Презиме")
 * from an app that had nowhere else to put it. That is the single reason most
 * therapy sessions cannot be attached to a lesson.
 *
 * The file itself never enters this repository (rules 1 and 6). What lives
 * here is the reading of it, and the reading is split in two on purpose:
 *
 *   `docxTables`      turns a .docx into plain grids of strings. Fiddly, but
 *                     it has no opinions, so there is nothing in it to get
 *                     wrong about a school.
 *   everything else   works on a grid, so the tests use an invented list and
 *                     never need a real one.
 *
 * Exactly the split `lib/teaching.ts` uses for the timetable workbook, for
 * exactly the same reason.
 */

import { inflateRawSync } from 'node:zlib';
import { normalizeClassLabel } from './crossing.js';

// ─── the container ──────────────────────────────────────────────────────────

/**
 * One entry out of a zip, by name.
 *
 * A .docx is a zip and `word/document.xml` is the part that matters. Reading
 * it here rather than adding a dependency: this needs one entry, out of one
 * file, once a year — and the End of Central Directory is a fixed record that
 * has not changed since 1989.
 */
function unzipEntry(file: Buffer, wanted: string): Buffer | null {
    // The EOCD sits at the end, after a comment of up to 64K.
    let eocd = -1;
    for (let i = file.length - 22; i >= 0 && i > file.length - 22 - 65_536; i--) {
        if (file.readUInt32LE(i) === 0x0605_4b50) { eocd = i; break; }
    }
    if (eocd < 0) return null;

    const entries = file.readUInt16LE(eocd + 10);
    let at = file.readUInt32LE(eocd + 16);            // start of the central directory
    for (let n = 0; n < entries; n++) {
        if (file.readUInt32LE(at) !== 0x0201_4b50) return null;
        const method = file.readUInt16LE(at + 10);
        const compressed = file.readUInt32LE(at + 20);
        const nameLen = file.readUInt16LE(at + 28);
        const extraLen = file.readUInt16LE(at + 30);
        const commentLen = file.readUInt16LE(at + 32);
        const localAt = file.readUInt32LE(at + 42);
        const name = file.toString('utf8', at + 46, at + 46 + nameLen);

        if (name === wanted) {
            // The local header repeats the name and extra fields, and its
            // extra length is NOT always the central one — reading the wrong
            // field here shifts the data by a few bytes and inflate fails
            // with a message about an invalid block type.
            const localNameLen = file.readUInt16LE(localAt + 26);
            const localExtraLen = file.readUInt16LE(localAt + 28);
            const from = localAt + 30 + localNameLen + localExtraLen;
            const raw = file.subarray(from, from + compressed);
            return method === 0 ? Buffer.from(raw) : inflateRawSync(raw);
        }
        at += 46 + nameLen + extraLen + commentLen;
    }
    return null;
}

const unescapeXml = (s: string) => s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');

/**
 * Every table in a Word document, as a grid of cell text.
 *
 * Word splits one word across several `<w:t>` runs whenever the formatting
 * changes mid-word — a spell-check squiggle is enough — so the text of a cell
 * is the concatenation of its runs and never one of them. `<w:tab/>` and
 * `<w:br/>` become spaces; everything else between runs is markup.
 *
 * Nested tables are counted as part of the cell they sit in rather than
 * returned separately. A pupil list does not have them, and a wrong guess
 * about one would be silent.
 */
export function docxTables(file: Buffer): string[][][] {
    const xml = unzipEntry(file, 'word/document.xml')?.toString('utf8');
    if (!xml) throw new Error('this file has no word/document.xml — is it really a .docx?');
    return wordTables(xml);
}

/**
 * The same, from the XML itself — which is what the tests use, so that a rule
 * about tables can be checked without building a zip to hold three cells.
 *
 * A VERTICALLY MERGED cell is filled from the row above, and that is not a
 * convenience. Word writes `<w:vMerge w:val="restart"/>` on the first row of
 * a merged block and a bare `<w:vMerge/>` on every row after it, with the text
 * only in the first. The school's programme table merges the class and the
 * homeroom teacher down each class group — 65 pupils and 17 filled class
 * cells — so reading the cells literally leaves 48 children with no class at
 * all, and carrying the value forward is not a guess about this school but
 * what the document says.
 */
export function wordTables(xml: string): string[][][] {
    const tables: string[][][] = [];
    const tag = /<w:(tbl|tr|tc|t|tab|br)\b([^>]*)>|<\/w:(tbl|tr|tc|t)>/g;
    let table: string[][] | null = null;
    let row: Array<{ text: string; continued: boolean }> | null = null;
    let cell: string[] | null = null;
    let cellAt = 0;
    let depth = 0;                 // how many <w:tbl> we are inside
    let text: { at: number } | null = null;
    let m: RegExpExecArray | null;

    while ((m = tag.exec(xml))) {
        const open = m[1];
        const close = m[3];
        const selfClosing = (m[2] || '').trimEnd().endsWith('/');

        if (open === 'tbl' && !selfClosing) {
            depth++;
            if (depth === 1) { table = []; }
        } else if (close === 'tbl') {
            depth--;
            if (depth === 0 && table) { tables.push(table); table = null; }
        } else if (depth === 1 && open === 'tr' && !selfClosing) {
            row = [];
        } else if (depth === 1 && close === 'tr') {
            if (table && row) {
                const above = table[table.length - 1];
                table.push(row.map((c, i) =>
                    c.continued && !c.text && above ? (above[i] ?? '') : c.text));
            }
            row = null;
        } else if (depth === 1 && open === 'tc' && !selfClosing) {
            cell = [];
            cellAt = m.index;
        } else if (depth === 1 && close === 'tc') {
            if (row && cell) {
                const raw = xml.slice(cellAt, m.index);
                row.push({
                    text: cell.join('').replace(/\s+/g, ' ').trim(),
                    // `w:val="restart"` opens a merged block; a bare vMerge
                    // continues one. Only the continuation inherits.
                    continued: /<w:vMerge(?![^>]*val="restart")/.test(raw)
                });
            }
            cell = null;
        } else if (open === 't' && !selfClosing) {
            text = { at: m.index + m[0].length };
        } else if (close === 't') {
            if (text && cell) cell.push(unescapeXml(xml.slice(text.at, m.index)));
            text = null;
        } else if ((open === 'tab' || open === 'br') && cell) {
            cell.push(' ');
        }
    }
    return tables;
}

// ─── what a row of that table means ─────────────────────────────────────────

export interface RosterRow {
    /** The school's own numbering, kept only to point at a line in the file. */
    ordinal: number | null;
    classLabel: string;
    name: string;
}

export interface RosterDoc {
    rows: RosterRow[];
    /** Everything a person has to look at. Never a silent correction. */
    problems: string[];
}

/**
 * `\b` IS ASCII, and this document is not.
 *
 * The name heading was written `/^(име|ученик)\b/i` and matched nothing at
 * all: „е" is not an ASCII word character, so there is no word boundary
 * after „име" for `\b` to find, and every row was reported as a table with no
 * name column. The Unicode-aware form of the same intent is a lookahead for a
 * letter — and it has to carry the `u` flag to mean anything.
 */
const HEADINGS = {
    ordinal: /^(бр|б|no|#)\.?$/i,
    classLabel: /^(одд|одделение|клас|паралелка)\.?$/i,
    name: /^(име|ученик|презиме)(?!\p{L})/iu
};

/**
 * A grid of cells to a list of pupils.
 *
 * The columns are found by their HEADING rather than by position, because a
 * school that adds a column for the birth year in 2028 should not silently
 * shift every name one place to the left.
 */
export function parseRosterGrid(grid: string[][]): RosterDoc {
    const problems: string[] = [];
    if (!grid.length) return { rows: [], problems: ['the table is empty'] };

    const header = grid[0].map((c) => c.trim());
    const column = {
        ordinal: header.findIndex((c) => HEADINGS.ordinal.test(c)),
        classLabel: header.findIndex((c) => HEADINGS.classLabel.test(c)),
        name: header.findIndex((c) => HEADINGS.name.test(c))
    };
    if (column.classLabel < 0 || column.name < 0) {
        return {
            rows: [],
            problems: [`the header row does not name a class column and a name column — it reads: ${header.join(' | ')}`]
        };
    }

    const rows: RosterRow[] = [];
    for (let i = 1; i < grid.length; i++) {
        const line = grid[i];
        const name = (line[column.name] ?? '').trim();
        const classLabel = (line[column.classLabel] ?? '').trim();
        if (!name && !classLabel) continue;                       // a spacer row
        // A numbered line with a class and no name is not an empty row — the
        // school counted somebody there. Saying WHICH class turns it from a
        // curiosity into something a person can go and look up.
        if (!name) { problems.push(`row ${i + 1}: ${classLabel} — a line with a class and no name`); continue; }
        if (!classLabel) { problems.push(`row ${i + 1}: "${name}" has no class`); continue; }
        const ordinal = column.ordinal < 0 ? null : Number((line[column.ordinal] ?? '').replace(/\D/g, ''));
        rows.push({ ordinal: Number.isInteger(ordinal) && ordinal! > 0 ? ordinal! : null, classLabel, name });
    }
    return { rows, problems };
}

// ─── the school's own rule about class labels ───────────────────────────────

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX'];
/** The sections are named in this order, and a school uses no more than this. */
export const SECTIONS = ['а', 'б', 'в', 'г'];

/**
 * „VI-а" -> { grade: 'VI', section: 'а' }; „VI" -> { grade: 'VI', section: '' }.
 *
 * The spelling is folded by `normalizeClassLabel` and not by a second rule of
 * its own — that function is the one copy of "these two labels mean the same
 * room", and it already knows that a Cyrillic „Х" typed where a Latin „X"
 * belongs is invisible on screen and a different string to `=`. A separate
 * regex here would drift from it the first time somebody типed „vi / а".
 */
export function splitClassLabel(label: string): { grade: string; section: string } | null {
    const folded = normalizeClassLabel(String(label ?? ''));
    if (!folded) return null;
    const cut = folded.indexOf('-');
    const grade = cut < 0 ? folded : folded.slice(0, cut);
    if (!ROMAN.includes(grade)) return null;
    return { grade, section: cut < 0 ? '' : folded.slice(cut + 1) };
}

/**
 * The school names a class by how many of them it formed that year: one is
 * bare („II"), two are „II-а" and „II-б", three add „II-в".
 *
 * So a bare numeral standing BESIDE lettered sections of the same grade is a
 * contradiction — one of them is a slip of the pen, and which one is not for
 * this program to decide. It is reported and nothing else happens, because
 * folding „IV" into „IV-а" would move a child into a room they are not in,
 * and it would look entirely plausible on every screen afterwards.
 */
export function classShapeProblems(labels: Iterable<string>): string[] {
    const byGrade = new Map<string, Set<string>>();
    const problems: string[] = [];
    for (const label of labels) {
        const parts = splitClassLabel(label);
        if (!parts) { problems.push(`"${label}" does not look like a class`); continue; }
        if (!byGrade.has(parts.grade)) byGrade.set(parts.grade, new Set());
        byGrade.get(parts.grade)!.add(parts.section);
    }
    for (const [grade, sections] of byGrade) {
        if (sections.size > 1 && sections.has('')) {
            const lettered = [...sections].filter(Boolean).map((s) => `${grade}-${s}`).sort();
            problems.push(
                `${grade} appears both on its own and as ${lettered.join(' and ')} — ` +
                'a grade with more than one class has a letter on every one of them'
            );
        }
        const lettered = [...sections].filter(Boolean).sort();
        const expected = SECTIONS.slice(0, lettered.length);
        if (lettered.length && lettered.join(',') !== expected.join(',')) {
            const missing = expected.filter((s) => !lettered.includes(s));
            problems.push(
                `${grade} has ${lettered.map((s) => `${grade}-${s}`).join(' and ')} but no ` +
                `${missing.map((s) => `${grade}-${s}`).join(' or ')} — ` +
                (lettered.length === 1
                    ? `one class in a grade is named ${grade}, with no letter`
                    : `${lettered.length} classes are named ${expected.map((s) => `${grade}-${s}`).join(', ')}`)
            );
        }
    }
    return problems;
}

/**
 * Next year's class for one pupil, and how sure that is.
 *
 * The NUMERAL is arithmetic and certain. The SECTION is not: the school forms
 * its classes afresh every September, so this year's two fourth classes may be
 * one fifth class or three. Keeping the letter is the best guess and it is
 * offered as a guess — `certain: false` — so the person doing September sees
 * which half of the answer they are confirming.
 */
export function promote(label: string, lastGrade = 'IX'): {
    label: string | null;
    outcome: 'promoted' | 'graduated' | 'unknown';
    certain: boolean;
} {
    const parts = splitClassLabel(label);
    if (!parts) return { label: null, outcome: 'unknown', certain: false };
    const at = ROMAN.indexOf(parts.grade);
    if (at < 0 || at >= ROMAN.indexOf(lastGrade.toUpperCase())) {
        return { label: null, outcome: 'graduated', certain: true };
    }
    const grade = ROMAN[at + 1];
    return {
        label: parts.section ? `${grade}-${parts.section}` : grade,
        outcome: 'promoted',
        // Without a letter there is nothing to be unsure about; with one, the
        // letter survives only if the school forms the same number of classes.
        certain: !parts.section
    };
}

// ─── the other two documents the school keeps ───────────────────────────────

/**
 * Every paragraph of a Word document, in order.
 *
 * The staff list is not a table — it is a numbered list, and Word keeps the
 * numbers in `numbering.xml` rather than in the text, so what comes back is
 * one name per paragraph and nothing else.
 */
export function docxParagraphs(file: Buffer): string[] {
    const xml = unzipEntry(file, 'word/document.xml')?.toString('utf8');
    if (!xml) throw new Error('this file has no word/document.xml — is it really a .docx?');
    const out: string[] = [];
    for (const p of xml.split(/<w:p[\s>]/).slice(1)) {
        const runs = [...p.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => unescapeXml(m[1]));
        const text = runs.join('').replace(/\s+/g, ' ').trim();
        if (text) out.push(text);
    }
    return out;
}

export interface StaffList {
    names: string[];
    /** Lines that are not a person, kept so nothing disappears quietly. */
    skipped: string[];
}

/**
 * A list of employees, from a document that says only their names.
 *
 * There is no column for the post — no наставник / специјален едукатор /
 * помошен кадар — so this can say WHO the school employs and nothing about
 * what they do. That distinction is typed in `Podatoci.html`, where a person
 * can see the whole list while deciding.
 *
 * A line is a person when it is two or three words of letters. The heading
 * („ОУРЦ „…" – Битола") has quotes, a dash and a place in it, so it fails
 * that test — and it is REPORTED rather than dropped, because a rule that
 * quietly discards lines is a rule nobody notices going wrong.
 */
export function parseStaffList(paragraphs: string[]): StaffList {
    const names: string[] = [];
    const skipped: string[] = [];
    for (const line of paragraphs) {
        // A blank line carries no information, so it is neither a person nor
        // something that went missing.
        if (!line.trim()) continue;
        const words = line.split(/\s+/).filter(Boolean);
        const looksLikeAPerson = words.length >= 2 && words.length <= 3
            && words.every((w) => /^\p{L}[\p{L}'’.-]*$/u.test(w))
            && !/["„“”]/.test(line);
        if (looksLikeAPerson) names.push(line);
        else skipped.push(line);
    }
    return { names, skipped };
}

export interface ProgrammeRow {
    /** „Одделенска настава" or „Предметна настава" — the section it sat under. */
    section: string;
    name: string;
    disability: string;
    programme: string;
    /** What the class cell says once the teaching plan is taken off it. */
    classLabel: string;
    /** The teaching plan that was written into the same cell. */
    plan: string;
    homeroom: string;
}

/** The teaching plans, longest first so „НП со ППР" wins over „НП". */
const PLANS = ['НП со ППР', 'НП со ОС', 'МНП', 'ПОС', 'ПППР', 'НП'];

/**
 * „1-аНП со ОС" -> class „1-а", plan „НП со ОС".
 *
 * The school writes both into one cell with no separator, so the split is by
 * the KNOWN plan codes rather than by punctuation that is not there. Anything
 * that matches no code comes back as a class with no plan, which is what a
 * report should say rather than inventing a boundary.
 */
export function splitClassAndPlan(cell: string): { classLabel: string; plan: string } {
    const text = String(cell ?? '').replace(/\s+/g, ' ').trim();
    for (const plan of PLANS) {
        const at = text.indexOf(plan);
        if (at > 0) return { classLabel: text.slice(0, at).trim(), plan: text.slice(at).trim() };
    }
    return { classLabel: text, plan: '' };
}

/**
 * „1-а" -> „I-а". The pupil list writes its classes in Roman numerals and this
 * table writes the same classes in Arabic ones.
 *
 * Done HERE and not in `normalizeClassLabel`, deliberately. That function is
 * the one copy of "these two labels mean the same room" and every read path
 * depends on it; widening it to accept „1-а" would silently change what the
 * crossing folds together across the whole system, on the strength of one
 * report. This says the two documents disagree — deciding what the database
 * should hold is a separate change with its own tests.
 */
export function romanClassLabel(label: string): string | null {
    const m = /^\s*([1-9])\s*[-‐‑–—/]?\s*(.*)$/u.exec(String(label ?? '').trim());
    if (!m) return null;
    const roman = ROMAN[Number(m[1]) - 1];
    const rest = m[2].trim();
    if (!roman) return null;
    // Only a plain section letter can be carried across. „1-ва комб. 2 и 3" is
    // a combined class and saying it is „I-ва комб…" would be a translation
    // nobody asked for.
    if (rest && !/^[а-гa-g]$/iu.test(rest)) return null;
    return rest ? `${roman}-${rest.toLocaleLowerCase('mk-MK')}` : roman;
}

/**
 * The per-pupil table: who is in which class, on which plan, with whom.
 *
 * It is laid out as two sections („Одделенска настава" and „Предметна
 * настава"), each with its own heading row, and single-cell rows carry the
 * section titles and the legend. So the shape is read as it goes rather than
 * assumed once at the top.
 */
export function parseProgrammeGrid(grid: string[][]): { rows: ProgrammeRow[]; problems: string[] } {
    const rows: ProgrammeRow[] = [];
    const problems: string[] = [];
    let section = '';
    let column: Record<string, number> | null = null;

    for (let i = 0; i < grid.length; i++) {
        const line = grid[i];
        if (line.length === 1) {
            // A legend is a sentence; a section title is a couple of words.
            if (line[0].split(/\s+/).length <= 4) section = line[0].trim();
            continue;
        }
        const header = line.map((c) => c.trim());
        if (HEADINGS.name.test(header[1] ?? '')) {
            column = {
                name: 1,
                disability: header.findIndex((c) => /^попреченост/i.test(c)),
                programme: header.findIndex((c) => /^програма/i.test(c)),
                classLabel: header.findIndex((c) => /^одд\./i.test(c) && !/наставник/i.test(c)),
                homeroom: header.findIndex((c) => /наставник|класен/i.test(c))
            };
            continue;
        }
        if (!column) { problems.push(`row ${i + 1}: a line before any heading row`); continue; }
        const at = (key: string) => (column![key] >= 0 ? (line[column![key]] ?? '').trim() : '');
        const name = at('name');
        if (!name) continue;                       // the school leaves blank lines for spacing
        const split = splitClassAndPlan(at('classLabel'));
        rows.push({
            section,
            name,
            disability: at('disability'),
            programme: at('programme'),
            classLabel: split.classLabel,
            plan: split.plan,
            homeroom: at('homeroom')
        });
    }
    return { rows, problems };
}

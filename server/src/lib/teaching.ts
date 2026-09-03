/**
 * Reading the school's timetable workbook.
 *
 * The sheet is two tables stacked in one grid, and they are read in opposite
 * directions — which is the whole reason this is a named function rather than
 * a loop in a script:
 *
 *   одделенска (class teaching)   row = one teacher AND their class
 *                                 cell = the SUBJECT they teach that period
 *
 *   предметна (subject teaching)  row = one subject teacher
 *                                 cell = the CLASS they are with that period
 *
 * A second header row ("ИМЕ И ПРЕЗИМЕ | ОДД. | ПОНЕДЕЛНИК …") part-way down
 * the sheet is what separates them. Everything above it is class teaching,
 * everything below is subject teaching.
 *
 * The parser takes a plain 2-D array of cell values, not a workbook. That is
 * what lets it be tested against an invented timetable with invented names —
 * no real teacher, no real child, and no .xlsx in the repository (rules 1, 6).
 */

import { normalizeClassLabel } from './crossing.js';

export interface ParsedLesson {
    day: string;
    dayOrder: number;
    ordinal: number;
    classLabel: string;
    teacher: string;
    subject: string;
}

export interface ParsedTeacher {
    name: string;
    kind: 'odd' | 'pred';
    /** The class they lead, for a class teacher or a subject teacher who has one. */
    homeroom: string;
    /** The subject they carry, when the ОДД. column names one instead. */
    subject: string;
}

export interface ParsedTimetable {
    teachers: ParsedTeacher[];
    classes: string[];
    lessons: ParsedLesson[];
    problems: string[];
    notes: string[];
}

const DAY_ORDER: Record<string, number> = {
    'понеделник': 1, 'вторник': 2, 'среда': 3, 'четврток': 4, 'петок': 5
};

/** The five teaching days, in the order the timetable prints them. */
export const TEACHING_DAYS = Object.keys(DAY_ORDER);

/**
 * A day's position in the week, or 0 for anything that is not a school day.
 *
 * Exported because the editor has to compute it too, and a second copy of this
 * map would let a hand-entered lesson sort differently from an imported one.
 */
export function dayOrderOf(day: string): number {
    return DAY_ORDER[String(day ?? '').trim().toLowerCase()] ?? 0;
}

const EMPTY_CELL = new Set(['', '/', '-', '–', '—', '.', '..']);

const text = (v: unknown): string =>
    v === null || v === undefined ? '' : String(v).replace(/\s+/g, ' ').trim();

/** Is this the "ИМЕ И ПРЕЗИМЕ | ОДД. | <day> …" band? */
const isHeaderRow = (row: unknown[]): boolean =>
    text(row[0]).toUpperCase().startsWith('ИМЕ') && text(row[1]).toUpperCase().startsWith('ОДД');

/**
 * Column -> day, taken from the merged day banner in the header row.
 * The banner sits in the first column of its run and the rest are blank, so
 * the day carries forward until the next one appears.
 */
function dayByColumn(header: unknown[]): Map<number, string> {
    const map = new Map<number, string>();
    let current = '';
    for (let c = 2; c < header.length; c++) {
        const cell = text(header[c]).toLowerCase();
        if (cell && DAY_ORDER[cell]) current = cell;
        if (current) map.set(c, current);
    }
    return map;
}

/** Column -> period number, from the "1 2 3 4 5 6 7" row under the days. */
function ordinalByColumn(row: unknown[]): Map<number, number> {
    const map = new Map<number, number>();
    for (let c = 2; c < row.length; c++) {
        const n = Number(text(row[c]).replace(',', '.'));
        if (Number.isFinite(n) && n >= 1 && n <= 20) map.set(c, Math.round(n));
    }
    return map;
}

/** The ОДД. column holds either a class ("VII-а") or a subject ("АНГ."). */
function looksLikeClass(value: string): boolean {
    return /^[IVXivx]+(-[а-шa-z])?$/i.test(normalizeClassLabel(value));
}

export function parseTeachingGrid(grid: unknown[][]): ParsedTimetable {
    const out: ParsedTimetable = { teachers: [], classes: [], lessons: [], problems: [], notes: [] };
    const classSet = new Set<string>();
    const teacherByName = new Map<string, ParsedTeacher>();

    // Find the header bands. Each one starts a section; the section's kind is
    // decided by what its rows put in the ОДД. column, not by its position, so
    // a workbook that grows a third section still reads correctly.
    const headers: number[] = [];
    grid.forEach((row, i) => { if (isHeaderRow(row)) headers.push(i); });
    if (!headers.length) {
        out.problems.push('No "ИМЕ И ПРЕЗИМЕ / ОДД." header row found — is this the timetable sheet?');
        return out;
    }

    headers.forEach((headerRow, section) => {
        const header = grid[headerRow] || [];
        const days = dayByColumn(header);

        // The period numbers are on the next row, or the one after when the
        // sheet also prints clock times.
        let ordinals = new Map<number, number>();
        for (let probe = headerRow + 1; probe <= headerRow + 3 && probe < grid.length; probe++) {
            const found = ordinalByColumn(grid[probe] || []);
            if (found.size > ordinals.size) ordinals = found;
        }
        if (!ordinals.size) {
            out.problems.push(`Section starting at row ${headerRow + 1} has no period numbers under the days — skipped.`);
            return;
        }

        const lastRow = section + 1 < headers.length ? headers[section + 1] : grid.length;
        let firstDataRow = headerRow + 1;
        while (firstDataRow < lastRow && !text((grid[firstDataRow] || [])[0])) firstDataRow++;

        for (let r = firstDataRow; r < lastRow; r++) {
            const row = grid[r] || [];
            const name = text(row[0]);
            if (!name || isHeaderRow(row)) continue;

            const oddCell = text(row[1]);
            const homeroomIsClass = looksLikeClass(oddCell);
            // A row whose cells hold class labels is a subject teacher's row.
            const cellsLookLikeClasses = (() => {
                let classes = 0, filled = 0;
                ordinals.forEach((_, c) => {
                    const v = text(row[c]);
                    if (!v || EMPTY_CELL.has(v)) return;
                    filled++;
                    if (looksLikeClass(v)) classes++;
                });
                return filled > 0 && classes / filled > 0.6;
            })();

            const kind: 'odd' | 'pred' = cellsLookLikeClasses ? 'pred' : 'odd';
            const teacher: ParsedTeacher = {
                name,
                kind,
                homeroom: homeroomIsClass ? normalizeClassLabel(oddCell) : '',
                subject: homeroomIsClass ? '' : oddCell
            };
            const existing = teacherByName.get(name);
            if (existing && existing.kind !== kind) {
                out.problems.push(`"${name}" appears both as a class teacher and a subject teacher — kept as ${existing.kind}.`);
            } else if (!existing) {
                teacherByName.set(name, teacher);
            }
            const effective = teacherByName.get(name)!;
            if (effective.homeroom) classSet.add(effective.homeroom);

            ordinals.forEach((ordinal, col) => {
                const day = days.get(col);
                if (!day) return;
                const cell = text(row[col]);
                if (!cell || EMPTY_CELL.has(cell)) return;

                let classLabel: string;
                let subject: string;
                if (kind === 'pred') {
                    classLabel = normalizeClassLabel(cell);
                    // The subject comes from the teacher, not the cell — and
                    // for a subject teacher who also leads a class, the sheet
                    // never says which subject that is. Left blank on purpose:
                    // printing the homeroom label ("IX-а") in the subject
                    // column would look like an answer and be one.
                    subject = effective.subject;
                } else {
                    classLabel = effective.homeroom;
                    subject = cell;
                    if (!classLabel) {
                        out.problems.push(`Row ${r + 1} ("${name}") teaches "${cell}" but its ОДД. column is "${oddCell}", which is not a class.`);
                        return;
                    }
                }
                if (!classLabel) return;
                classSet.add(classLabel);
                out.lessons.push({
                    day,
                    dayOrder: DAY_ORDER[day] || 0,
                    ordinal,
                    classLabel,
                    teacher: name,
                    subject
                });
            });
        }
    });

    out.teachers = Array.from(teacherByName.values());
    out.classes = Array.from(classSet).sort(compareClassLabels);

    const oddCount = out.teachers.filter((t) => t.kind === 'odd').length;
    out.notes.push(`${out.teachers.length} teachers (${oddCount} одделенска, ${out.teachers.length - oddCount} предметна), ${out.classes.length} classes, ${out.lessons.length} lessons.`);

    // The workbook names a subject for every class-teaching cell, but for a
    // subject teacher who also leads a class it names only the class. Those
    // subjects have to be typed in once, by someone who knows them.
    const noSubject = out.teachers.filter((t) => t.kind === 'pred' && !t.subject);
    if (noSubject.length) {
        out.notes.push(`${noSubject.length} subject teacher(s) have no subject in the workbook and need one entered by hand: ${noSubject.map((t) => t.name).join(', ')}.`);
    }
    return out;
}

const ROMAN: Record<string, number> = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10 };

/**
 * How far along the school a label is: 0 for the preparatory year, 1..10 for
 * the Roman grades, 99 for anything unrecognised.
 *
 * WHY 0 AND NOT 99. The preparatory year comes BEFORE the first grade. Left to
 * `ROMAN` alone it fell through to 99 and sorted after the ninth, which is
 * exactly where it appeared in the pupil picker. The roster writes it several
 * ways -- "подготвителна" and "Подготвително" both appear in the same document
 * -- so match the stem, not the whole word.
 *
 * An empty label is 99 as well, which keeps a pupil with no grade at the end,
 * where `NULLS LAST` used to put them.
 */
function gradeNumber(head: string): number {
    const word = head.trim();
    if (/^подготвител/i.test(word)) return 0;
    return ROMAN[word.toUpperCase()] ?? 99;
}

/** II before X, подготвителна before both, and IV-а before IV-б. */
export function compareClassLabels(a: string, b: string): number {
    const split = (s: string) => {
        const cut = s.indexOf('-');
        return {
            n: gradeNumber(cut < 0 ? s : s.slice(0, cut)),
            section: cut < 0 ? '' : s.slice(cut + 1)
        };
    };
    const x = split(a);
    const y = split(b);
    return x.n - y.n || x.section.localeCompare(y.section, 'mk') || a.localeCompare(b, 'mk');
}

/** A stable key so ORDER BY in SQL sorts the same way this does. */
export function classSortKey(label: string): string {
    const cut = label.indexOf('-');
    const n = gradeNumber(cut < 0 ? label : label.slice(0, cut));
    return String(n).padStart(2, '0') + '-' + (cut < 0 ? '' : label.slice(cut + 1));
}

/**
 * Orders a list of pupils the way a person reads a roster: by grade, then by
 * name inside the grade.
 *
 * WHY NOT IN SQL. `ORDER BY grade` compares the TEXT, so "IX" lands between
 * "IV" and "V" and подготвителна lands after "VIII" -- both plainly visible in
 * the pupil picker. A rank column in the database would be a second owner of a
 * rule `compareClassLabels` already owns; sorting here keeps one owner and
 * every reader of these endpoints gets the same order.
 */
export function orderPupils<T extends { grade?: string | null; name?: string | null }>(rows: T[]): T[] {
    return rows.sort((a, b) =>
        compareClassLabels(a.grade ?? '', b.grade ?? '')
        || String(a.name ?? '').localeCompare(String(b.name ?? ''), 'mk'));
}

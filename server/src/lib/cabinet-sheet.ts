/**
 * Reading the CABINET timetable the centre keeps in its own workbook.
 *
 * The school's teaching workbook already has a reader (`teaching.ts`); this is
 * the other sheet, and it is shaped the other way round. Down the page: a day,
 * and inside it the periods I…VI. Across the page: one column per КАБИНЕТ.
 * A cell holds the pupil who is there — or TWO pupils separated by „/", which
 * is how the sheet writes a block split into its two twenty-minute halves.
 *
 * Pure on purpose, exactly like the teaching parser: a 2-D grid of strings in,
 * findings out, no database and no xlsx. The real workbook carries real pupil
 * names and never enters this repository (rules 1 and 6), so the tests are
 * written against a centre that does not exist.
 *
 * FOUR THINGS IT REFUSES TO GUESS, because each of them silently invents a
 * therapy session if guessed:
 *
 *  - WHICH CABINET IS WHOSE. The column says „Логопед"; `schedule_slots` wants
 *    a therapist. That pairing is not in the sheet and is not derivable from
 *    it. The parser reports the column headings it found and stops there.
 *  - COLOUR. Cells in the real sheet are filled in several colours and nobody
 *    has said what they mean. A grid of strings cannot see colour at all,
 *    which is the honest version of not knowing.
 *  - MORE THAN TWO NAMES IN ONE CELL. A 40-minute block splits into two halves
 *    and no further. Three names is either a group — which this schedule
 *    cannot express yet — or a typo, and both need a person.
 *  - A NAME IT CANNOT SPLIT. „Иво/" or „/Ана" loses one of the two halves, so
 *    the cell is reported rather than half-read.
 */

const clean = (value: unknown): string =>
    value === null || value === undefined ? '' : String(value).replace(/\s+/g, ' ').trim();

const DAYS: Record<string, string> = {
    'пон': 'понеделник', 'вто': 'вторник', 'сре': 'среда', 'чет': 'четврток', 'пет': 'петок'
};

/** „Понеделник", „ПОНЕДЕЛНИК", „пон." — all one day; anything else is not a day. */
export function cabinetDay(value: unknown): string {
    const head = clean(value).toLowerCase().replace(/[^а-шѓјљњќџѕ]/g, '').slice(0, 3);
    return DAYS[head] ?? '';
}

const ROMAN: Record<string, number> = {
    'I': 1, 'II': 2, 'III': 3, 'IV': 4, 'V': 5, 'VI': 6, 'VII': 7, 'VIII': 8
};

/**
 * „III." → 3. Latin and Cyrillic look-alikes are folded first: the sheet is
 * typed by people, and „ІІІ" with Cyrillic І is indistinguishable on screen
 * from „III" and is a different string to everything else.
 */
export function cabinetPeriod(value: unknown): number {
    const raw = clean(value)
        .replace(/[Іі]/g, 'I').replace(/[Ѵѵ]/g, 'V').replace(/[Хх]/g, 'X')
        .replace(/[^IVX]/gi, '').toUpperCase();
    return ROMAN[raw] ?? 0;
}

export type CabinetCell = {
    day: string;
    dayOrder: number;
    period: number;
    cabinet: string;
    column: number;
    /** One pupil for the whole block, or two for the two halves, in cell order. */
    pupils: string[];
    raw: string;
    row: number;
};

export type CabinetSheet = {
    cabinets: { column: number; label: string }[];
    cells: CabinetCell[];
    /** Rows and cells a person has to look at. Never silently dropped. */
    problems: string[];
};

/**
 * The header is the row above the data that names the MOST columns.
 *
 * Not simply the row just above, and not the first: the real sheet has TWO
 * header rows — a „КАБИНЕТ" banner merged across the whole width, then the
 * cabinet names under it. A merged banner occupies one cell, so it always
 * names fewer columns than the row it labels, and counting is what separates
 * them without knowing either word. Ties go to the LOWER row, the one nearer
 * the data.
 */
function findHeader(grid: unknown[][], firstDataRow: number): number {
    let best = -1;
    let most = 0;
    for (let r = firstDataRow - 1; r >= 0; r--) {
        const named = grid[r].slice(2).filter((cell) => clean(cell) !== '').length;
        if (named > most) { most = named; best = r; }
    }
    return most >= 1 ? best : -1;
}

export function parseCabinetGrid(grid: unknown[][]): CabinetSheet {
    const problems: string[] = [];
    const rows = (grid ?? []).map((row) => row ?? []);

    const firstDataRow = rows.findIndex((row) =>
        cabinetPeriod(row[1]) > 0 || (cabinetDay(row[0]) !== '' && cabinetPeriod(row[1]) > 0));
    if (firstDataRow < 0) {
        return { cabinets: [], cells: [], problems: ['Ниту еден ред не носи час (I, II, III…) во втората колона.'] };
    }

    const headerRow = findHeader(rows, firstDataRow);
    if (headerRow < 0) {
        return { cabinets: [], cells: [], problems: ['Не најдов ред со имиња на кабинети над првиот час.'] };
    }

    const cabinets: { column: number; label: string }[] = [];
    for (let c = 2; c < rows[headerRow].length; c++) {
        const label = clean(rows[headerRow][c]);
        if (label) cabinets.push({ column: c, label });
    }
    const seen = new Map<string, number>();
    for (const cab of cabinets) {
        const key = cab.label.toLowerCase();
        if (seen.has(key)) problems.push(`Кабинетот „${cab.label}" се јавува двапати (колони ${seen.get(key)! + 1} и ${cab.column + 1}).`);
        else seen.set(key, cab.column);
    }

    const cells: CabinetCell[] = [];
    // The day is a vertically merged banner, so it appears once per block and
    // the rest of its rows are blank — the same shape `docxTables` meets, and
    // reading the cells literally would leave four days in five with no day.
    let day = '';
    let dayOrder = 0;
    const ORDER: Record<string, number> = {
        'понеделник': 1, 'вторник': 2, 'среда': 3, 'четврток': 4, 'петок': 5
    };

    for (let r = firstDataRow; r < rows.length; r++) {
        const here = cabinetDay(rows[r][0]);
        if (here) { day = here; dayOrder = ORDER[here]; }
        const period = cabinetPeriod(rows[r][1]);
        if (!period) {
            const anything = rows[r].slice(2).some((cell) => clean(cell) !== '');
            if (anything) problems.push(`Ред ${r + 1} носи термини, но во втората колона нема час (I, II…) — испуштен.`);
            continue;
        }
        if (!day) {
            problems.push(`Ред ${r + 1}: час ${period} без ден над него — испуштен.`);
            continue;
        }
        for (const cab of cabinets) {
            const raw = clean(rows[r][cab.column]);
            if (!raw) continue;
            const parts = raw.split('/').map((p) => clean(p));
            if (parts.some((p) => p === '')) {
                problems.push(`${day}, ${period}. час, ${cab.label}: „${raw}" — не можам да ги разделам двете половини.`);
                continue;
            }
            if (parts.length > 2) {
                problems.push(`${day}, ${period}. час, ${cab.label}: „${raw}" — ${parts.length} имиња во една ќелија. Блок се дели на најмногу две половини.`);
                continue;
            }
            cells.push({ day, dayOrder, period, cabinet: cab.label, column: cab.column, pupils: parts, raw, row: r + 1 });
        }
    }

    return { cabinets, cells, problems };
}

/**
 * The same pupil booked in two cabinets in one period.
 *
 * Reported, never resolved: which of the two is right is not in the sheet, and
 * a child cannot be in two rooms at once — so one of the two entries is wrong
 * and only a person knows which.
 */
export function clashingPupils(cells: CabinetCell[]): string[] {
    const at = new Map<string, { cabinet: string; half: number }[]>();
    for (const cell of cells) {
        cell.pupils.forEach((pupil, index) => {
            // Two halves of one block are different times, so a pupil in half 1
            // of one cabinet and half 2 of another is not double-booked.
            const half = cell.pupils.length === 2 ? index + 1 : 0;
            const key = `${cell.day}|${cell.period}|${pupil.toLowerCase()}`;
            if (!at.has(key)) at.set(key, []);
            at.get(key)!.push({ cabinet: cell.cabinet, half });
        });
    }
    const out: string[] = [];
    for (const [key, list] of at) {
        if (list.length < 2) continue;
        const overlapping = list.some((a, i) =>
            list.some((b, j) => i !== j && (a.half === 0 || b.half === 0 || a.half === b.half)));
        if (!overlapping) continue;
        const [day, period] = key.split('|');
        out.push(`${day}, ${period}. час: истиот ученик е запишан во ${list.map((x) => x.cabinet).join(' и ')}.`);
    }
    return out;
}

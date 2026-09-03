/**
 * Where a therapy session lands in the teaching day.
 *
 * The first version of this crossing matched by ordinal — cabinet block I was
 * assumed to be lesson 1, block II lesson 2, and so on. The clock says
 * otherwise. Teaching rings at 07:30 and the cabinet at 08:00, so block I
 * (08:00–08:40) covers only the last ten minutes of lesson 1 and twenty-five
 * minutes of lesson 2. Every "who is missing from this lesson" answer built on
 * the ordinal was attributed to the wrong lesson.
 *
 * So this module does not know any ordinals. It is given two lists of real
 * start times and it intersects them in minutes. If the school and the cabinet
 * are ever brought onto the same bell, the same code returns a single exact
 * 40-minute overlap and the crossing becomes 1:1 with nothing to change.
 *
 * ONE OWNER, DELIBERATELY. Unlike `audiogramId`, this is NOT duplicated into
 * the browser. The arithmetic depends on the bell table, the bell table lives
 * in the database, and a second copy of the sums in Rasporedi.html could drift
 * from it by a minute and nobody would notice. So the crossing tab asks
 * `/api/teaching/crossing` and renders the answer. The cost is that the tab
 * needs the server; that is honest — without the server there is no timetable
 * to cross against either.
 */

export interface Bell {
    ordinal: number;
    label: string;
    /** 'HH:MM' */
    startsAt: string;
    minutes: number;
}

export interface Overlap {
    /** The teaching period's ordinal. */
    ordinal: number;
    label: string;
    /** How many minutes of that lesson the child is away for. */
    minutes: number;
    /** That, as a share of the lesson: 0.625 for 25 minutes of 40. */
    share: number;
}

/** 'HH:MM' -> minutes since midnight. NaN for anything else. */
export function minutesOf(value: string): number {
    const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(value || ''));
    if (!m) return NaN;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) return NaN;
    return h * 60 + min;
}

/** minutes since midnight -> 'HH:MM'. */
export function timeOf(total: number): string {
    const t = ((Math.round(total) % 1440) + 1440) % 1440;
    return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
}

/**
 * Every teaching period the given cabinet block touches, longest first.
 *
 * A block that touches nothing (an afternoon session against a morning
 * timetable, say) returns an empty list rather than a nearest guess. Silence
 * is the honest answer there; the caller shows the session as unplaced.
 */
export function overlapsFor(block: Bell, lessons: Bell[]): Overlap[] {
    const start = minutesOf(block.startsAt);
    if (!Number.isFinite(start) || !(block.minutes > 0)) return [];
    const end = start + block.minutes;

    const out: Overlap[] = [];
    for (const lesson of lessons) {
        const lStart = minutesOf(lesson.startsAt);
        if (!Number.isFinite(lStart) || !(lesson.minutes > 0)) continue;
        const lEnd = lStart + lesson.minutes;
        const shared = Math.min(end, lEnd) - Math.max(start, lStart);
        if (shared <= 0) continue;
        out.push({
            ordinal: lesson.ordinal,
            label: lesson.label,
            minutes: shared,
            share: shared / lesson.minutes
        });
    }
    // Longest first; ties by ordinal so the order never depends on input order.
    out.sort((a, b) => b.minutes - a.minutes || a.ordinal - b.ordinal);
    return out;
}

/**
 * The lessons a session actually disrupts.
 *
 * `minShare` is the judgement call, and it is deliberately one number in one
 * place: a child gone for ten minutes of a lesson was in the room for it; a
 * child gone for twenty-five was not. Half is the default. Callers that want
 * every touched lesson pass 0.
 */
export function disruptedBy(block: Bell, lessons: Bell[], minShare = 0.5): Overlap[] {
    const all = overlapsFor(block, lessons);
    const kept = all.filter((o) => o.share >= minShare);
    // A session that overlaps something, but nothing by half, still took the
    // child out of somewhere. Report its largest rather than nothing at all.
    return kept.length ? kept : all.slice(0, 1);
}

/**
 * A therapy slot, read from the label the schedule stores it under.
 *
 * The schedule does not store a period number — it stores a time range as
 * text, and that text is the truth about when the child was out of class:
 *
 *   "08:00-08:20"                     one twenty-minute half
 *   "09:40-10:20 + 10:25-11:05"       two terms worked as one long session
 *
 * Matching those labels against a table of cabinet period STARTS was the
 * first attempt and it quietly lost half the week: a forty-minute session is
 * stored as two rows, the second beginning at 08:20, which is nobody's period
 * start. Every second half was reported unplaceable, and a child booked only
 * in a second half did not appear at all.
 *
 * So the slot describes itself. First clock is the start, last is the end.
 */
export function slotBell(label: string): Bell | null {
    const clocks = String(label || '').match(/\d{1,2}:\d{2}/g);
    if (!clocks || clocks.length < 2) return null;
    const start = minutesOf(clocks[0]);
    const end = minutesOf(clocks[clocks.length - 1]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
    return { ordinal: 0, label: String(label), startsAt: clocks[0], minutes: end - start };
}

/**
 * Adjacent slots for the same child with the same therapist are ONE session.
 *
 * This is not tidying. A forty-minute session is stored as two twenty-minute
 * rows, and the two halves land on DIFFERENT lessons once the bells are thirty
 * minutes apart: 08:00–08:20 is mostly the first lesson, 08:20–08:40 is the
 * second. Measured separately, one child out of one session is reported as
 * missing from two lessons, from neither of which they are absent for long.
 * Measured as the span they really are — 08:00–08:40 — it is twenty-five
 * minutes of the second lesson and nothing else, which is the truth.
 *
 * Only touching spans are joined. A gap means the child went back to class,
 * and two sessions with a break between them are two sessions.
 */
export function mergeAdjacent(spans: Bell[]): Bell[] {
    const usable = spans
        .filter((b) => Number.isFinite(minutesOf(b.startsAt)) && b.minutes > 0)
        .sort((a, b) => minutesOf(a.startsAt) - minutesOf(b.startsAt));
    if (usable.length < 2) return usable.slice();

    const out: Bell[] = [];
    let start = minutesOf(usable[0].startsAt);
    let end = start + usable[0].minutes;
    let label = usable[0].label;

    const flush = () => out.push({ ordinal: 0, label, startsAt: timeOf(start), minutes: end - start });

    for (let i = 1; i < usable.length; i++) {
        const s = minutesOf(usable[i].startsAt);
        const e = s + usable[i].minutes;
        if (s <= end) {                       // touching or overlapping
            end = Math.max(end, e);
            label += ' + ' + usable[i].label;
        } else {
            flush();
            start = s; end = e; label = usable[i].label;
        }
    }
    flush();
    return out;
}

/**
 * Class labels differ in spacing and dash only: "VI а", "VI-а", "vi-А".
 *
 * This folds FORMATTING and nothing else. "VI" is not turned into "VI-а" and
 * "VI-а" is not turned into "VI" — those are different classes, and guessing
 * between them would put a child in a room they were never in (rule 2). A
 * label that does not match is reported and mapped by hand.
 */
export function normalizeClassLabel(value: string): string {
    let s = String(value == null ? '' : value).trim();
    if (!s) return '';
    // One separator, no spaces around it.
    s = s.replace(/\s*[-–—/\\]\s*/g, '-').replace(/\s+/g, '-');
    s = s.replace(/-+/g, '-').replace(/^-|-$/g, '');

    const cut = s.indexOf('-');
    const rawRoman = (cut < 0 ? s : s.slice(0, cut)).toUpperCase();
    const rawSection = cut < 0 ? '' : s.slice(cut + 1).toLowerCase();

    // The numeral is Latin I/V/X. A Cyrillic Х or І typed in its place looks
    // identical on screen and compares as a different string, which is exactly
    // the kind of mismatch a person cannot see and so cannot fix.
    const roman = rawRoman.replace(/[ХхІіСс]/g, (ch) =>
        ({ 'Х': 'X', 'х': 'X', 'І': 'I', 'і': 'I', 'С': 'C', 'с': 'C' } as Record<string, string>)[ch] || ch);

    // The section is Cyrillic а/б/в, and the Latin keys sit in the same places
    // on the keyboard.
    const section = rawSection.replace(/[abvg]/g, (ch) =>
        ({ a: 'а', b: 'б', v: 'в', g: 'г' } as Record<string, string>)[ch] || ch);

    return section ? roman + '-' + section : roman;
}

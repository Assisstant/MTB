/**
 * „Дали ова е истото дете?" — кога двете спелувања не се исти.
 *
 * The exact path already exists (`bareName` + a lower-cased compare) and it is
 * what DECIDES. This file is the other half: when nothing matched exactly, it
 * says which names are CLOSE, so a person can look at three candidates instead
 * of a list of eighty.
 *
 * IT NEVER DECIDES. Rule 2 is not "match carefully", it is "never guess an
 * identity match" — and a near match is a guess however good the arithmetic
 * is. Two children in this school share a name outright; a third pair differs
 * by one letter would be indistinguishable to any distance in the world. So
 * everything here returns CANDIDATES, and the only thing that turns a
 * candidate into an identity is a person writing it down once.
 *
 * WHY THE FOLDING IS SEPARATE FROM THE EXACT PATH, and this is the whole
 * reason the file exists rather than `bareName` being made cleverer. Folding
 * „ѓ" to „г" makes „Ѓоргиевска" and „Горгиевска" one string — useful for
 * OFFERING a candidate, and catastrophic as a rule for deciding, because those
 * really can be two people. The aggressive folding lives here, where nothing
 * it produces can write a row.
 */

/** Latin letters that are drawn identically to Cyrillic ones, and the real
 *  Macedonian letters that are typed for one another. Only for SUGGESTING. */
const FOLD: Record<string, string> = {
    // homoglyphs: a keyboard left in the wrong layout produces these
    'a': 'а', 'b': 'в', 'c': 'с', 'e': 'е', 'h': 'н', 'i': 'и', 'j': 'ј',
    'k': 'к', 'm': 'м', 'o': 'о', 'p': 'р', 't': 'т', 'x': 'х', 'y': 'у',
    // the letters this language's own spellings vary between
    'ѓ': 'г', 'ќ': 'к', 'љ': 'л', 'њ': 'н', 'ѕ': 'з'
};

/**
 * One spelling, stripped of everything that is not the name: the class prefix
 * („V-а - "), the owner's markers („(над.)", „(под.)"), case, spacing, and the
 * look-alike letters above.
 */
export function foldName(value: unknown): string {
    let n = String(value ?? '');
    const dash = n.indexOf(' - ');
    if (dash > -1 && dash <= 12) n = n.slice(dash + 3);          // „V-а - Име"
    n = n.replace(/\([^)]*\)/g, ' ');                             // „(над.)"
    n = n.toLocaleLowerCase('mk-MK').replace(/\s+/g, ' ').trim();
    return [...n].map((ch) => FOLD[ch] ?? ch).join('');
}

/** Tokens sorted, so „Спирковски Михаил" and „Михаил Спирковски" are one. */
export function nameKey(value: unknown): string {
    return foldName(value).split(' ').filter(Boolean).sort().join(' ');
}

/** Plain Levenshtein. Small strings; nothing clever is needed. */
export function editDistance(a: string, b: string): number {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const row = [i];
        for (let j = 1; j <= b.length; j++) {
            row[j] = Math.min(
                prev[j] + 1,
                row[j - 1] + 1,
                prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
            );
        }
        prev = row;
    }
    return prev[b.length];
}

/**
 * How far apart two spellings are.
 *
 * The smaller of two readings, and BOTH are needed — this was measured, not
 * assumed. Sorting the tokens is what makes „Бошевски Михаил" the same name;
 * it is also what breaks a dropped FIRST letter, because „ошевски" sorts after
 * „михаил" while „бошевски" sorts before it, and the sorted strings then differ by
 * far more than the one letter that actually changed. „Михаил ошевски" is a
 * real cell in the centre's own sheet, so the in-order reading has to stay.
 *
 * A different surname is far. A missing surname altogether is the length of
 * that surname, which is exactly why it does NOT come out close: half a name
 * is not evidence.
 */
export function nameDistance(a: unknown, b: unknown): number {
    return Math.min(
        editDistance(foldName(a), foldName(b)),   // same order, one letter out
        editDistance(nameKey(a), nameKey(b))      // tokens re-ordered
    );
}

export type NameCandidate<T> = { row: T; name: string; distance: number };

/**
 * The nearest spellings, closest first, and nothing that is merely not far.
 *
 * The tolerance grows with the name's length because one wrong letter in a
 * seven-letter name is a fifth of it, and in a twenty-letter name it is a
 * typing slip. Capped at 4: beyond that the "candidates" are noise, and a list
 * nobody can read is the same as no list.
 */
export function nearestNames<T>(
    query: unknown,
    rows: T[],
    nameOf: (row: T) => string,
    limit = 3
): NameCandidate<T>[] {
    const key = nameKey(query);
    if (!key) return [];
    const tolerance = Math.min(4, Math.max(2, Math.floor(key.length / 6)));
    // A candidate is dropped only when the EXACT path would already have taken
    // it — same letters, differing in case or spacing. A pair that folds to
    // distance 0 through „ѓ"→„г" is the opposite: the most useful suggestion
    // there is, and an earlier version silently threw exactly those away.
    const plain = (v: unknown) => String(v ?? '').toLocaleLowerCase('mk-MK').replace(/\s+/g, ' ').trim();
    const asked = plain(query);
    return rows
        .map((row) => ({ row, name: nameOf(row), distance: nameDistance(query, nameOf(row)) }))
        .filter((c) => plain(c.name) !== asked && c.distance <= tolerance)
        .sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name, 'mk'))
        .slice(0, limit);
}

/**
 * Is one candidate clearly ahead of the rest?
 *
 * Used ONLY to word the report — „ова е веројатно X" against „едно од овие".
 * It authorises nothing: both wordings end in a person deciding. A tie is the
 * case rule 2 was written for, and it must read differently on the page or the
 * reader will take the first line as an answer.
 */
export function clearlyNearest<T>(candidates: NameCandidate<T>[]): boolean {
    if (candidates.length === 0) return false;
    if (candidates.length === 1) return candidates[0].distance <= 2;
    return candidates[0].distance <= 2 && candidates[1].distance > candidates[0].distance + 1;
}

/**
 * The school calendar as the SERVER reads it: one place for „is this day a
 * public holiday?", so the duty rota and the attendance screens cannot answer
 * differently (owner, 7 Oct 2026).
 *
 * The list itself is S-Дневник's: Податоци → Учебна година, saved in the
 * diary's document. It is read here, never edited. S-Дневник keeps its own
 * copy of the rule in JavaScript because it works offline; its „Додај државни
 * празници" already writes a holiday that falls on a Sunday as the Monday
 * after. The rule below says the same for a holiday entered by hand:
 *
 *   a public holiday on a Sunday makes the Monday after it non-working.
 *
 * Only `praznik` is a public holiday. A `raspust` is a school break and an
 * `aktivnost` is a working day marked differently — neither closes anything
 * here by itself.
 */

type DB = { query: (sql: string, args?: any[]) => Promise<any> };

const DAY_MS = 86400000;
const isIso = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
    && !Number.isNaN(Date.parse(v + 'T00:00:00Z'));
const addDay = (iso: string, count: number) => new Date(Date.parse(iso + 'T00:00:00Z') + count * DAY_MS).toISOString().slice(0, 10);
const weekday = (iso: string) => new Date(iso + 'T00:00:00Z').getUTCDay();

/**
 * The calendar S-Дневник saved, if it is this year's. An older year's
 * calendar must not close dates in this one, and a missing calendar is
 * missing — nothing is invented in its place.
 */
export async function readSchoolCalendar(db: DB, year: { starts_on: string; ends_on: string }): Promise<any | null> {
    const stored = (await db.query("SELECT payload->'schoolCalendar' AS calendar FROM app_state WHERE app='sdnevnik'")).rows[0]?.calendar;
    return stored && isIso(stored.yearStart) && isIso(stored.yearEnd)
        && stored.yearStart >= year.starts_on && stored.yearEnd <= year.ends_on ? stored : null;
}

function publicHolidayCovering(calendar: any, date: string): string | null {
    const hit = (calendar?.holidays || []).find((h: any) => h && h.kind === 'praznik'
        && isIso(h.start) && isIso(h.end) && h.start <= date && date <= h.end);
    return hit ? String(hit.name || 'Празник') : null;
}

/**
 * The public holiday that makes `date` non-working, by name — or null.
 * A Monday answers for the Sunday before it.
 */
export function holidayOn(calendar: any, date: string): string | null {
    if (!calendar || !isIso(date)) return null;
    const own = publicHolidayCovering(calendar, date);
    if (own) return own;
    if (weekday(date) !== 1) return null;
    const sunday = publicHolidayCovering(calendar, addDay(date, -1));
    return sunday ? `${sunday} (празникот е во недела)` : null;
}

/** Every working day from `from` to `to` that a public holiday closes: date → the holiday's name. */
export function holidaysBetween(calendar: any, from: string, to: string): Map<string, string> {
    const out = new Map<string, string>();
    if (!calendar || !isIso(from) || !isIso(to)) return out;
    for (let date = from; date <= to; date = addDay(date, 1)) {
        const wd = weekday(date);
        if (wd === 0 || wd === 6) continue;
        const name = holidayOn(calendar, date);
        if (name) out.set(date, name);
    }
    return out;
}

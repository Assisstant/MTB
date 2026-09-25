/**
 * Дежурства во кабинетите: who is on duty on which working day (owner,
 * 25 Sep 2026; migration 043).
 *
 * ONE ROTATION PER SCHOOL YEAR, CONTINUOUS. It runs from its start date
 * through every working day, so October starts exactly where September ended.
 * The app this replaces restarted every month from a person chosen by hand,
 * and erased a month's marked days whenever somebody looked at another month.
 *
 * A QUEUE, and the owner's rules are what it does:
 *
 *   - each working day, the first person in the queue who is IN that day
 *     takes it, and goes to the back;
 *   - somebody away is skipped and KEEPS their place at the front, so they are
 *     on duty the next working day they are in. Everyone ends the year with the
 *     same number of duties. (The old app gave the away person's turn away.)
 *   - a closed day (a holiday, an excursion) has no duty, and moves nobody;
 *   - a day given to a named person by agreement: that person takes it and goes
 *     to the back; whoever was next is still next. (The old app made the
 *     displaced person lose their turn and let the stand-in keep theirs.)
 *   - somebody who joins during the year joins at the back, on that day; somebody
 *     who leaves is taken out. The months before are not rewritten.
 *
 * Pure: the same inputs always give the same rota, so a printed month stays
 * true. Nothing here reads the clock or the database; `loadDuty` below does the
 * reading, and the routes decide who may change what.
 */

export interface DutyMember {
    employeeId: number;
    position: number;
    joinedOn: string | null;
    leftOn: string | null;
}

export interface DutyMark {
    closed: boolean;
    note: string;
    assigned: number | null;
}

export interface DutyInput {
    /** The first day of the rotation (ISO). */
    startsOn: string;
    /** The last day to work out (ISO, inclusive). */
    until: string;
    members: DutyMember[];
    days: Map<string, DutyMark>;
    absences: Map<string, Set<number>>;
}

export type DutyHow = 'rotation' | 'cover' | 'assigned' | 'closed' | 'nobody';

export interface DutyDay {
    date: string;
    /** 1 = Monday … 5 = Friday. */
    weekday: number;
    closed: boolean;
    note: string;
    employeeId: number | null;
    how: DutyHow;
    /** Whose turn it was, when somebody covers for them. */
    covers: number[];
    /** Everybody marked away that day. */
    absent: number[];
}

const DAY_MS = 86400000;
const isoOf = (d: Date) => d.toISOString().slice(0, 10);
const dateOf = (iso: string) => new Date(iso + 'T00:00:00Z');

/** The working days (Monday–Friday) from `from` to `to`, inclusive. */
export function workingDays(from: string, to: string): string[] {
    const out: string[] = [];
    for (let t = dateOf(from).getTime(); t <= dateOf(to).getTime(); t += DAY_MS) {
        const d = new Date(t);
        const wd = d.getUTCDay();
        if (wd !== 0 && wd !== 6) out.push(isoOf(d));
    }
    return out;
}

const activeOn = (m: DutyMember, iso: string) =>
    (!m.joinedOn || m.joinedOn <= iso) && (!m.leftOn || m.leftOn > iso);

export function dutyRota(input: DutyInput): DutyDay[] {
    const members = [...input.members].sort((a, b) => a.position - b.position);
    const queue: number[] = [];
    const out: DutyDay[] = [];
    for (const date of workingDays(input.startsOn, input.until)) {
        // Who is in the rotation today. On the first day everybody present
        // enters in the list's order; a later joiner enters at the back.
        for (const m of members) {
            const at = queue.indexOf(m.employeeId);
            if (activeOn(m, date)) { if (at < 0) queue.push(m.employeeId); }
            else if (at >= 0) queue.splice(at, 1);
        }
        const mark = input.days.get(date);
        const away = input.absences.get(date) || new Set<number>();
        const absent = [...away].filter((id) => queue.includes(id));
        const day = { date, weekday: dateOf(date).getUTCDay(), note: mark?.note || '', absent };

        if (mark?.closed) {
            out.push({ ...day, closed: true, employeeId: null, how: 'closed', covers: [] });
            continue;
        }
        if (mark?.assigned != null && !away.has(mark.assigned)) {
            const who = mark.assigned;
            const at = queue.indexOf(who);
            if (at >= 0) { queue.splice(at, 1); queue.push(who); }
            out.push({ ...day, closed: false, employeeId: who, how: 'assigned', covers: [] });
            continue;
        }
        const at = queue.findIndex((id) => !away.has(id));
        if (at < 0) {
            out.push({ ...day, closed: false, employeeId: null, how: 'nobody', covers: [] });
            continue;
        }
        const who = queue[at];
        const covers = queue.slice(0, at);
        queue.splice(at, 1);
        queue.push(who);
        out.push({ ...day, closed: false, employeeId: who, how: at === 0 ? 'rotation' : 'cover', covers });
    }
    return out;
}

/** Today in Skopje, as the school counts days — not the server's clock zone. */
export function todayInSkopje(now = new Date()): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Skopje' }).format(now);
}

/** A month's first and last day, from „2026-09". */
export function monthBounds(month: string): { first: string; last: string } | null {
    const m = /^(\d{4})-(\d{2})$/.exec(month);
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    if (mo < 1 || mo > 12) return null;
    const last = new Date(Date.UTC(y, mo, 0));
    return { first: `${m[1]}-${m[2]}-01`, last: isoOf(last) };
}

export interface DutyState {
    startsOn: string;
    yearStartsOn: string;
    yearEndsOn: string;
    members: Array<DutyMember & { name: string }>;
    days: Map<string, DutyMark>;
    absences: Map<string, Set<number>>;
    names: Map<number, string>;
}

/**
 * Everything the rota is made of, for one school year.
 *
 * A person linked into another identity since (035's „поврзи") is read as the
 * identity they were linked into, so linking two records of one colleague
 * never leaves a rota naming the record that was retired.
 */
export async function loadDuty(db: any, yearId: number): Promise<DutyState> {
    const live = 'coalesce(e.superseded_by, e.id)';
    const [year, setting, members, days, absences] = await Promise.all([
        db.query('SELECT starts_on, ends_on FROM school_years WHERE id = $1', [yearId]),
        db.query('SELECT starts_on FROM duty_settings WHERE school_year_id = $1', [yearId]),
        db.query(`SELECT ${live} AS employee_id, m.position, m.joined_on, m.left_on,
                         (SELECT name FROM employees WHERE id = ${live}) AS name
                    FROM duty_members m JOIN employees e ON e.id = m.employee_id
                   WHERE m.school_year_id = $1 ORDER BY m.position`, [yearId]),
        db.query(`SELECT d.day, d.closed, d.note,
                         (SELECT ${live} FROM employees e WHERE e.id = d.assigned_employee_id) AS assigned
                    FROM duty_days d WHERE d.school_year_id = $1`, [yearId]),
        db.query(`SELECT a.day, ${live} AS employee_id
                    FROM duty_absences a JOIN employees e ON e.id = a.employee_id
                   WHERE a.school_year_id = $1`, [yearId])
    ]);
    const y = year.rows[0];
    const dayMap = new Map<string, DutyMark>();
    days.rows.forEach((r: any) => dayMap.set(String(r.day), {
        closed: r.closed, note: r.note || '', assigned: r.assigned == null ? null : Number(r.assigned)
    }));
    const awayMap = new Map<string, Set<number>>();
    absences.rows.forEach((r: any) => {
        const key = String(r.day);
        if (!awayMap.has(key)) awayMap.set(key, new Set());
        awayMap.get(key)!.add(Number(r.employee_id));
    });
    const list = members.rows.map((r: any) => ({
        employeeId: Number(r.employee_id), position: Number(r.position), name: r.name,
        joinedOn: r.joined_on ? String(r.joined_on) : null, leftOn: r.left_on ? String(r.left_on) : null
    }));
    const names = new Map<number, string>(list.map((m: any) => [m.employeeId, m.name]));
    const assignedIds = [...dayMap.values()].map((d) => d.assigned).filter((id): id is number => id != null && !names.has(id));
    if (assignedIds.length) {
        const { rows } = await db.query('SELECT id, name FROM employees WHERE id = ANY($1::int[])', [assignedIds]);
        rows.forEach((r: any) => names.set(Number(r.id), r.name));
    }
    return {
        startsOn: setting.rows[0] ? String(setting.rows[0].starts_on) : String(y.starts_on),
        yearStartsOn: String(y.starts_on),
        yearEndsOn: String(y.ends_on),
        members: list,
        days: dayMap,
        absences: awayMap,
        names
    };
}

/** One month of the rota, worked out from the start so it continues the one before. */
export function monthOfRota(state: DutyState, month: { first: string; last: string }): DutyDay[] {
    if (month.last < state.startsOn) {
        return workingDays(month.first, month.last).map((date) => ({
            date, weekday: dateOf(date).getUTCDay(), closed: false, note: '', employeeId: null,
            how: 'nobody' as DutyHow, covers: [], absent: []
        }));
    }
    const all = dutyRota({ startsOn: state.startsOn, until: month.last, members: state.members,
        days: state.days, absences: state.absences });
    const before = workingDays(month.first, month.last).filter((d) => d < state.startsOn);
    return [
        ...before.map((date) => ({ date, weekday: dateOf(date).getUTCDay(), closed: false, note: '',
            employeeId: null, how: 'nobody' as DutyHow, covers: [], absent: [] })),
        ...all.filter((d) => d.date >= month.first)
    ];
}

/**
 * A month as the page shows it: each working day with the number and the name
 * of the person on duty, whom they cover, and who is away. One shape for the
 * colleagues' page and the administrator's, so the two cannot show different
 * rotas.
 */
export function monthPayload(state: DutyState, month: string) {
    const bounds = monthBounds(month);
    if (!bounds) return null;
    const number = new Map(state.members.map((m) => [m.employeeId, m.position]));
    const named = (id: number) => ({ employeeId: id, name: state.names.get(id) || '—' });
    return {
        month,
        startsOn: state.startsOn,
        yearStartsOn: state.yearStartsOn,
        yearEndsOn: state.yearEndsOn,
        members: state.members.map((m) => ({ employeeId: m.employeeId, name: m.name, position: m.position,
            joinedOn: m.joinedOn, leftOn: m.leftOn })),
        days: monthOfRota(state, bounds).map((d) => ({
            date: d.date,
            weekday: d.weekday,
            closed: d.closed,
            note: d.note,
            how: d.how,
            employeeId: d.employeeId,
            name: d.employeeId == null ? null : (state.names.get(d.employeeId) || '—'),
            number: d.employeeId == null ? null : (number.get(d.employeeId) ?? null),
            covers: d.covers.map(named),
            absent: d.absent.map(named)
        }))
    };
}

/** The month to show when none is asked for: this one, kept inside the school year. */
export function defaultMonth(state: DutyState, today = todayInSkopje()): string {
    const clamp = today < state.yearStartsOn ? state.yearStartsOn : today > state.yearEndsOn ? state.yearEndsOn : today;
    return clamp.slice(0, 7);
}

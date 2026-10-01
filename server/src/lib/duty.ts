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
 *     takes it and consumes their turn; a completed cycle refills in list order;
 *   - somebody away when their turn comes is SKIPPED, with no day owed.
 *     The next available person takes AND USES their own turn, then the
 *     queue continues after them. List order stays fixed, not calendar dates.
 *     Owner confirmed 30 Sep 2026: A away in A/B/C/D => B/C/D, not B/B/C.
 *     Absence is checked again when A comes around in the next cycle.
 *   - an explicitly closed day has no duty and moves nobody: the list
 *     continues on the next working day. An excursion or other event can
 *     equally keep normal duty; only the closed flag pauses the rotation;
 *   - legacy named assignments consume the named person's turn too, after
 *     skipping any absent people at the head. They are not two-date swaps;
 *     new agreements use the explicit swap operation below.
 *   - somebody who joins during the year joins at the back, on that day; somebody
 *     who leaves is taken out. The months before are not rewritten.
 *   - a SWAP (044) is a deal between two colleagues, not a change of the list:
 *     the queue runs exactly as without it, and afterwards the two days trade
 *     names (`applySwaps`). A swap whose days no longer belong to the two who
 *     agreed it is not applied, and is reported.
 *     The two days MAY be in different cycles (owner, 1 Oct 2026, replacing the
 *     30 Sep rule): the one who moves then has two duties in the cycle they
 *     moved into and none in their own, and the other the reverse. Nothing is
 *     evened out by the code; it is recorded — which cycle each day belongs
 *     to, per cycle who has how many, and the list of such swaps.
 *   - WHO ACTUALLY SERVED (051; owner, 30 Sep 2026) is a correction of the name
 *     on one day, never of the queue: somebody marked sick came in after all
 *     and a colleague had already stepped in. The rota runs exactly as without
 *     it (`applyServed` comes last), so the next days do not move; what moves
 *     is the count per cycle — the one who stepped in has two duties in that
 *     cycle, the one replaced none (`cycleTally`). Evening it out is a second
 *     correction in a later cycle, which the administrator chooses.
 *
 * Pure: the same inputs always give the same rota. Correcting an absence can
 * change later derived dates; the rota is not a historical snapshot.
 * Nothing here reads the clock or the database; `loadDuty` below does the
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
    /** Who actually served, when not the rota person (051). The queue ignores it. */
    served?: number | null;
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

export type DutyHow = 'rotation' | 'cover' | 'assigned' | 'closed' | 'nobody' | 'swap';

/** Two colleagues trading days: on `firstDay` it was `firstEmployeeId`'s turn, on `secondDay` the other's. */
export interface DutySwap {
    id: number;
    firstDay: string;
    firstEmployeeId: number;
    secondDay: string;
    secondEmployeeId: number;
    note: string;
}

export interface DutyDay {
    date: string;
    /** A list traversal, independent of calendar months. Zero before the rota. */
    cycle: number;
    /** A legacy assignment cannot give somebody a second turn in this cycle. */
    assignmentStale?: boolean;
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
    /** The day was traded: whose turn it was, and the day they took instead. */
    swap?: { id: number; with: number; date: string; note: string; /** The cycle of the day given in exchange. */ cycle: number };
    /** Somebody else actually served (051): the rota person it was, or null if nobody was due. */
    insteadOf?: number | null;
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
    let cycle = 0;
    let previousActive = new Set<number>();
    for (const date of workingDays(input.startsOn, input.until)) {
        const active = members.filter((m) => activeOn(m, date)).map((m) => m.employeeId);
        const activeSet = new Set(active);
        // The queue contains unconsumed turns only. Never re-add somebody
        // merely because they already served; refill in the canonical order
        // only when that cycle is complete. A new member joins at the back.
        for (let i = queue.length - 1; i >= 0; i--) if (!activeSet.has(queue[i])) queue.splice(i, 1);
        if (queue.length) for (const id of active) if (!previousActive.has(id)) queue.push(id);
        previousActive = activeSet;
        const nextCycle = () => { queue.push(...active); cycle++; };
        const mark = input.days.get(date);
        const away = input.absences.get(date) || new Set<number>();
        const absent = [...away].filter((id) => activeSet.has(id));
        const day = { date, weekday: dateOf(date).getUTCDay(), note: mark?.note || '', absent };

        if (mark?.closed) {
            out.push({ ...day, cycle, closed: true, employeeId: null, how: 'closed', covers: [] });
            continue;
        }
        if (!queue.length && active.length) nextCycle();
        // Only the leading absentees lose a turn: somebody away whose turn
        // is later in the queue is not skipped early. Bound the scan to one
        // cycle so an all-absent day terminates without changing list order.
        const covers: number[] = [];
        if (!active.length || active.every((id) => away.has(id))) {
            covers.push(...queue);
            queue.length = 0;
            out.push({ ...day, cycle, closed: false, employeeId: null, how: 'nobody', covers,
                assignmentStale: mark?.assigned != null });
            continue;
        }
        while (away.has(queue[0])) {
            covers.push(queue.shift()!);
            if (!queue.length) nextCycle();
        }
        if (mark?.assigned != null && !away.has(mark.assigned) && queue.includes(mark.assigned)) {
            const who = mark.assigned;
            queue.splice(queue.indexOf(who), 1);
            out.push({ ...day, cycle, closed: false, employeeId: who, how: 'assigned', covers });
            continue;
        }
        // The person actually taking the day uses their turn exactly once.
        const due = queue.shift()!;
        out.push({ ...day, cycle, closed: false, employeeId: due, how: covers.length ? 'cover' : 'rotation', covers,
            assignmentStale: mark?.assigned != null });
    }
    return out;
}

/**
 * The swaps, applied to a rota already worked out. A swap holds only while
 * both of its days still belong to the two who agreed it, neither day is
 * closed, and neither person is away on the day they took. The days may be
 * in different cycles. Otherwise it is
 * returned as `stale` and changes nothing: a deal between A and B is never
 * carried over to whoever the rota puts there now.
 */
export function applySwaps(days: DutyDay[], swaps: DutySwap[]): { days: DutyDay[]; stale: DutySwap[] } {
    const byDate = new Map(days.map((d, i) => [d.date, i]));
    const out = days.slice();
    const stale: DutySwap[] = [];
    for (const sw of swaps) {
        const a = byDate.get(sw.firstDay);
        const b = byDate.get(sw.secondDay);
        if (a == null || b == null) continue; // outside what was worked out: neither applied nor judged
        const x = out[a];
        const y = out[b];
        const holds = !x.closed && !y.closed && !x.swap && !y.swap
            && x.employeeId === sw.firstEmployeeId && y.employeeId === sw.secondEmployeeId
            && !x.absent.includes(sw.secondEmployeeId) && !y.absent.includes(sw.firstEmployeeId);
        if (!holds) { stale.push(sw); continue; }
        out[a] = { ...x, employeeId: sw.secondEmployeeId, how: 'swap', swap: { id: sw.id, with: sw.firstEmployeeId, date: sw.secondDay, note: sw.note, cycle: y.cycle } };
        out[b] = { ...y, employeeId: sw.firstEmployeeId, how: 'swap', swap: { id: sw.id, with: sw.secondEmployeeId, date: sw.firstDay, note: sw.note, cycle: x.cycle } };
    }
    return { days: out, stale };
}

/**
 * Who actually served, laid over a rota already worked out, swaps included.
 * Last on purpose: the queue has already run, so a correction on one day can
 * never move another. A closed day takes no correction.
 */
export function applyServed(days: DutyDay[], marks: Map<string, DutyMark>): DutyDay[] {
    return days.map((d) => {
        const served = marks.get(d.date)?.served;
        if (served == null || d.closed || served === d.employeeId) return d;
        return { ...d, employeeId: served, insteadOf: d.employeeId };
    });
}

/**
 * Duties per person per cycle. With the rota alone everybody has one per
 * cycle (none when skipped for sick leave); a correction makes it two for the
 * one who stepped in and none for the one replaced, and that is what the
 * page shows so the next cycle can even it out (owner, 30 Sep 2026).
 */
export function cycleTally(days: DutyDay[]): Map<number, Map<number, number>> {
    const out = new Map<number, Map<number, number>>();
    for (const d of days) {
        if (!d.cycle || d.closed || d.employeeId == null) continue;
        if (!out.has(d.cycle)) out.set(d.cycle, new Map());
        const c = out.get(d.cycle)!;
        c.set(d.employeeId, (c.get(d.employeeId) || 0) + 1);
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
    swaps: DutySwap[];
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
    const [year, setting, members, days, absences, swaps] = await Promise.all([
        db.query('SELECT starts_on, ends_on FROM school_years WHERE id = $1', [yearId]),
        db.query('SELECT starts_on FROM duty_settings WHERE school_year_id = $1', [yearId]),
        db.query(`SELECT ${live} AS employee_id, m.position, m.joined_on, m.left_on,
                         (SELECT name FROM employees WHERE id = ${live}) AS name
                    FROM duty_members m JOIN employees e ON e.id = m.employee_id
                   WHERE m.school_year_id = $1 ORDER BY m.position`, [yearId]),
        db.query(`SELECT d.day, d.closed, d.note,
                         (SELECT ${live} FROM employees e WHERE e.id = d.assigned_employee_id) AS assigned,
                         (SELECT ${live} FROM employees e WHERE e.id = d.served_employee_id) AS served
                    FROM duty_days d WHERE d.school_year_id = $1`, [yearId]),
        db.query(`SELECT a.day, ${live} AS employee_id
                    FROM duty_absences a JOIN employees e ON e.id = a.employee_id
                   WHERE a.school_year_id = $1`, [yearId]),
        readSwaps(db, yearId)
    ]);
    const y = year.rows[0];
    const dayMap = new Map<string, DutyMark>();
    days.rows.forEach((r: any) => dayMap.set(String(r.day), {
        closed: r.closed, note: r.note || '', assigned: r.assigned == null ? null : Number(r.assigned),
        served: r.served == null ? null : Number(r.served)
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
    const assignedIds = [...new Set([...[...dayMap.values()].flatMap((d) => [d.assigned, d.served ?? null]),
        ...swaps.flatMap((sw) => [sw.firstEmployeeId, sw.secondEmployeeId])])]
        .filter((id): id is number => id != null && !names.has(id));
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
        names,
        swaps
    };
}

/** The year's swaps, read through linked identities like everything else here. */
export async function readSwaps(db: any, yearId: number): Promise<DutySwap[]> {
    const { rows } = await db.query(
        `SELECT s.id, s.first_day, s.second_day, s.note,
                (SELECT coalesce(e.superseded_by, e.id) FROM employees e WHERE e.id = s.first_employee_id) AS first_employee_id,
                (SELECT coalesce(e.superseded_by, e.id) FROM employees e WHERE e.id = s.second_employee_id) AS second_employee_id
           FROM duty_swaps s WHERE s.school_year_id = $1 ORDER BY s.first_day`, [yearId]);
    return rows.map((r: any) => ({ id: Number(r.id), firstDay: String(r.first_day), secondDay: String(r.second_day),
        firstEmployeeId: Number(r.first_employee_id), secondEmployeeId: Number(r.second_employee_id), note: r.note || '' }));
}

/**
 * The rota from the start to `until`, swaps applied. It is worked out as far
 * as the furthest swap reaching into the range, so a trade across the end of
 * a month still shows on both sides of it.
 */
export function rotaWithSwaps(state: DutyState, until: string, from = state.startsOn) {
    const touching = state.swaps.filter((sw) => sw.secondDay >= from && sw.firstDay <= until);
    const furthest = touching.reduce((max, sw) => (sw.secondDay > max ? sw.secondDay : max), until);
    const base = dutyRota({ startsOn: state.startsOn, until: furthest, members: state.members,
        days: state.days, absences: state.absences });
    const { days, stale } = applySwaps(base, state.swaps);
    return { days: days.filter((d) => d.date <= until), stale: stale.filter((sw) => touching.includes(sw)) };
}

/** The rota as it was actually served: swaps, then who stood in (051). */
export function servedRota(state: DutyState, until: string, from = state.startsOn) {
    const { days, stale } = rotaWithSwaps(state, until, from);
    return { days: applyServed(days, state.days), stale };
}

/** One month of the rota, worked out from the start so it continues the one before. */
export function monthOfRota(state: DutyState, month: { first: string; last: string }): DutyDay[] {
    if (month.last < state.startsOn) {
        return workingDays(month.first, month.last).map((date) => ({
            date, cycle: 0, weekday: dateOf(date).getUTCDay(), closed: false, note: '', employeeId: null,
            how: 'nobody' as DutyHow, covers: [], absent: []
        }));
    }
    const all = servedRota(state, month.last, month.first).days;
    const before = workingDays(month.first, month.last).filter((d) => d < state.startsOn);
    return [
        ...before.map((date) => ({ date, cycle: 0, weekday: dateOf(date).getUTCDay(), closed: false, note: '',
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
    return { month, ...rangePayload(state, bounds) };
}

/** The working day `count` working days from `iso` (negative: back). */
function stepWorkingDays(iso: string, count: number): string {
    let t = dateOf(iso).getTime();
    for (let left = Math.abs(count); left > 0;) {
        t += Math.sign(count) * DAY_MS;
        const wd = new Date(t).getUTCDay();
        if (wd !== 0 && wd !== 6) left--;
    }
    return isoOf(new Date(t));
}

/**
 * Around a day rather than inside a month (owner, 28 Sep 2026): one turn of
 * the list back and one forward, so the end of a month and the start of the
 * next read as the continuous rota they are. A turn is as many working days
 * as there are people on the list that day. ◀ ▶ move by one turn.
 */
export function windowPayload(state: DutyState, around: string) {
    const clamp = (iso: string) => (iso < state.yearStartsOn ? state.yearStartsOn : iso > state.yearEndsOn ? state.yearEndsOn : iso);
    const day = clamp(around);
    const cycle = Math.max(5, state.members.filter((m) => activeOn(m, day)).length);
    const first = clamp(stepWorkingDays(day, -cycle));
    const last = clamp(stepWorkingDays(day, cycle));
    return {
        month: day.slice(0, 7),
        around: day,
        from: first,
        to: last,
        cycle,
        prevAround: clamp(stepWorkingDays(day, -cycle)),
        nextAround: clamp(stepWorkingDays(day, cycle)),
        ...rangePayload(state, { first, last })
    };
}

export const isIsoDate = (v: unknown): v is string =>
    typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(dateOf(v).getTime()) && isoOf(dateOf(v)) === v;

function rangePayload(state: DutyState, bounds: { first: string; last: string }) {
    const number = new Map(state.members.map((m) => [m.employeeId, m.position]));
    const named = (id: number) => ({ employeeId: id, name: state.names.get(id) || '—' });
    const stale = state.startsOn <= bounds.last ? rotaWithSwaps(state, bounds.last, bounds.first).stale : [];
    const counts = countsFor(state, bounds);
    return {
        startsOn: state.startsOn,
        yearStartsOn: state.yearStartsOn,
        yearEndsOn: state.yearEndsOn,
        members: state.members.map((m) => ({ employeeId: m.employeeId, name: m.name, position: m.position,
            joinedOn: m.joinedOn, leftOn: m.leftOn })),
        days: monthOfRota(state, bounds).map((d) => ({
            date: d.date,
            cycle: d.cycle,
            weekday: d.weekday,
            closed: d.closed,
            note: d.note,
            how: d.how,
            // Preserve the stored legacy override when editing a note/absence,
            // including when a later two-date swap changes the displayed name.
            assignedEmployeeId: state.days.get(d.date)?.assigned ?? null,
            assignmentStale: Boolean(d.assignmentStale),
            employeeId: d.employeeId,
            name: d.employeeId == null ? null : (state.names.get(d.employeeId) || '—'),
            number: d.employeeId == null ? null : (number.get(d.employeeId) ?? null),
            covers: d.covers.map(named),
            absent: d.absent.map(named),
            swap: d.swap ? { id: d.swap.id, date: d.swap.date, note: d.swap.note, cycle: d.swap.cycle, ...named(d.swap.with) } : null,
            // Whose turn it was, when somebody else actually served (051).
            servedEmployeeId: state.days.get(d.date)?.served ?? null,
            insteadOf: d.insteadOf === undefined ? null : d.insteadOf == null ? { employeeId: null, name: null } : named(d.insteadOf),
            // This person's n-th duty in this cycle, counting this day: 2 means once more than the list gives.
            turnInCycle: d.employeeId == null || !d.cycle || d.closed ? null : (counts.nth.get(d.date) ?? null)
        })),
        // Per cycle shown here: who does not have simply one duty in it.
        // Somebody skipped for sick leave has none and owes none.
        cycleCounts: counts.cycles,
        // Across the year: who stood in for whom, net. Positive = served for others.
        standIns: counts.balance,
        // Swaps between two cycles that touch a cycle shown here: who, when, from which cycle.
        crossSwaps: counts.cross,
        // Swaps touching this month that no longer hold: the administrator decides.
        staleSwaps: stale.map((sw) => ({ id: sw.id, note: sw.note,
            first: { date: sw.firstDay, ...named(sw.firstEmployeeId) }, second: { date: sw.secondDay, ...named(sw.secondEmployeeId) } }))
    };
}

/**
 * The counts behind the page: worked out over the whole configured year, so a
 * cycle that crosses the edge of the range is still counted whole.
 */
function countsFor(state: DutyState, bounds: { first: string; last: string }) {
    const nth = new Map<string, number>();
    type Person = { employeeId: number; name: string; count: number; sick: boolean };
    type Side = { employeeId: number; name: string; date: string; cycle: number };
    const empty = { nth, cycles: [] as Array<{ cycle: number; from: string | null; to: string | null; people: Person[] }>,
        balance: [] as Array<{ employeeId: number; name: string; net: number }>,
        cross: [] as Array<{ id: number; note: string; first: Side; second: Side }> };
    if (state.startsOn > bounds.last) return empty;
    const days = servedRota(state, state.yearEndsOn).days;
    const seen = new Map<string, number>();
    for (const d of days) {
        if (!d.cycle || d.closed || d.employeeId == null) continue;
        const key = d.cycle + ':' + d.employeeId;
        seen.set(key, (seen.get(key) || 0) + 1);
        nth.set(d.date, seen.get(key)!);
    }
    const tally = cycleTally(days);
    const inRange = new Set(days.filter((d) => d.date >= bounds.first && d.date <= bounds.last && d.cycle).map((d) => d.cycle));
    const name = (id: number) => state.names.get(id) || '—';
    const cycles = [...inRange].sort((a, b) => a - b).map((cycle) => {
        const ofCycle = days.filter((d) => d.cycle === cycle);
        const counts = tally.get(cycle) || new Map<number, number>();
        const replaced = new Set(ofCycle.filter((d) => d.insteadOf != null).map((d) => d.insteadOf!));
        const skipped = new Set(ofCycle.flatMap((d) => d.covers));
        // Whose turn in this cycle went to another cycle by a swap.
        const movedOut = new Set(ofCycle.filter((d) => d.swap && d.swap.cycle !== cycle).map((d) => d.swap!.with));
        // Only what is not simply one each: two or more, or none because replaced or moved.
        const people = [...new Set([...counts.keys(), ...replaced, ...movedOut])]
            .map((id) => ({ employeeId: id, name: name(id), count: counts.get(id) || 0, sick: skipped.has(id) }))
            .filter((p) => p.count > 1 || (p.count === 0 && (replaced.has(p.employeeId) || movedOut.has(p.employeeId))));
        return { cycle, from: ofCycle[0]?.date || null, to: ofCycle[ofCycle.length - 1]?.date || null, people };
    }).filter((c) => c.people.length);
    const net = new Map<number, number>();
    for (const d of days) {
        if (d.insteadOf === undefined || d.employeeId == null) continue;
        net.set(d.employeeId, (net.get(d.employeeId) || 0) + 1);
        if (d.insteadOf != null) net.set(d.insteadOf, (net.get(d.insteadOf) || 0) - 1);
    }
    const balance = [...net].filter(([, n]) => n !== 0).map(([id, n]) => ({ employeeId: id, name: name(id), net: n }))
        .sort((a, b) => b.net - a.net || a.name.localeCompare(b.name, 'mk'));
    // Each swap between two cycles once, read from its earlier day: who now
    // serves when, and which cycle each of the two days belongs to.
    const byDate = new Map(days.map((d) => [d.date, d]));
    const cross = days.filter((d) => d.swap && d.swap.cycle !== d.cycle && d.date < d.swap.date
            && (inRange.has(d.cycle) || inRange.has(d.swap.cycle)))
        .map((d) => {
            const other = byDate.get(d.swap!.date)!;
            const holder = (day: DutyDay) => day.insteadOf != null ? day.insteadOf : day.employeeId!;
            return { id: d.swap!.id, note: d.swap!.note,
                first: { employeeId: holder(d), name: name(holder(d)), date: d.date, cycle: d.cycle },
                second: { employeeId: holder(other), name: name(holder(other)), date: other.date, cycle: other.cycle } };
        });
    return { nth, cycles, balance, cross };
}

/** The month to show when none is asked for: this one, kept inside the school year. */
export function defaultMonth(state: DutyState, today = todayInSkopje()): string {
    const clamp = today < state.yearStartsOn ? state.yearStartsOn : today > state.yearEndsOn ? state.yearEndsOn : today;
    return clamp.slice(0, 7);
}

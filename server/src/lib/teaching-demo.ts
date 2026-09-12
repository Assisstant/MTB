/**
 * A DEMO timetable, generated from the rules the owner stated out loud.
 *
 * Its purpose is to have something to look at. The crossing, the weekly grid,
 * the per-class notice sheet and the cabinet hover card are all empty until a
 * timetable exists, and typing 400 cells to find out whether a screen reads
 * well is nobody's idea of an afternoon. So: generate, look, throw away.
 *
 * IT IS NOT A PROPOSAL ABOUT THE REAL SCHOOL and nothing downstream may treat
 * it as one. Which teacher takes which class is a decision made by people with
 * a document in front of them (годишна програма, §8.2), and this file guesses
 * it. That is why every guess is REPORTED rather than quietly written, why the
 * script that calls this is dry-run by default, and why it refuses a year that
 * already has lessons unless told twice.
 *
 * The rules, in the owner's words (12 Sep 2026):
 *
 *   - Subjects run in order of importance: Македонски, Математика, then the
 *     rest, filled from the first period to the last.
 *   - A teacher's load is about 21–23 lessons a week; the demo uses 21.
 *     Some subjects cannot reach a full load on their own — English, Ликовно,
 *     Физичко — which is why a subject teacher works across classes.
 *   - In ОДДЕЛЕНСКА the class teacher holds ALL the lessons, with one
 *     exception: Физичко goes to an accompanying subject teacher.
 *   - In ПРЕДМЕТНА a subject teacher MAY teach in every class — not must.
 *     They fill their load, and what is left over needs another teacher, who
 *     is engaged by a person, not by a program.
 *
 * That last sentence is the one this file must not "improve". When nobody is
 * left under the load cap the lesson is written with NO teacher, and the count
 * is reported. A generated name would be a person this school does not employ.
 */

/** Lowercase, exactly as `dayOrderOf` and every read path expect. */
export const DEMO_DAYS = ['понеделник', 'вторник', 'среда', 'четврток', 'петок'];

/**
 * The order lessons are laid out in, most important first.
 *
 * A DEMO convention, not a rule from the Правилник — matched by prefix so the
 * catalogue's long official names ("Физичко и здравствено образование") are
 * caught by the short word people use. Anything unlisted sorts after these,
 * alphabetically, so the result is the same on every machine.
 */
const IMPORTANCE = [
    'Македонски', 'Математика', 'Англиски',
    'Природни науки', 'Општество', 'Историја', 'Географија',
    'Биологија', 'Физика', 'Хемија',
    'Техничко', 'Информатика', 'Иновации',
    'Ликовно', 'Музичко',
    'Физичко',
    'Граѓанско', 'Час на одделенска заедница'
];

/**
 * Catalogue entries that are not an ordinary timetabled lesson: optional
 * blocks, choirs, and the language columns that only apply to a community this
 * centre does not teach. Left in they would fill the grid with rows nobody
 * recognises, which makes the demo harder to read rather than fuller.
 */
const NOT_TIMETABLED = [
    'Дополнителна', 'Слободни изборни', 'Училиштен хор', 'Училиштен оркестар',
    'Јазик и култура', 'Јазик на заедницата', 'Втор странски', 'Албански јазик',
    'Македонски јазик за учениците'
];

const startsWithAny = (subject: string, list: string[]) =>
    list.some((p) => subject.toLowerCase().startsWith(p.toLowerCase()));

export const isPhysical = (subject: string) => startsWithAny(subject, ['Физичко']);

export function importanceOf(subject: string): number {
    const at = IMPORTANCE.findIndex((p) => subject.toLowerCase().startsWith(p.toLowerCase()));
    return at < 0 ? IMPORTANCE.length : at;
}

export function timetabled(subject: string): boolean {
    return !startsWithAny(subject, NOT_TIMETABLED);
}

export interface DemoTeacher {
    id: number;
    name: string;
    /** 'odd' = одделенски, 'pred' = предметен. Read from the database. */
    kind: string;
    subject: string | null;
}

export interface DemoClass {
    id: number;
    label: string;
    /** The Roman grades this class covers, for reading the subject catalogue. */
    grades: string[];
    /** Одделенски раководител for the year, or null when nobody is recorded. */
    homeroomTeacherId: number | null;
}

export interface SubjectHours { subject: string; hours: number }

export interface PlannedLesson {
    day: string;
    ordinal: number;
    classId: number;
    subject: string;
    teacherId: number | null;
}

export interface DemoPlan {
    lessons: PlannedLesson[];
    /** teacherId -> how many lessons the plan gives them. */
    load: Map<number, number>;
    /** Lessons nobody was free (or under the cap) to take. */
    unstaffed: number;
    notes: string[];
    problems: string[];
}

export interface DemoOptions {
    /** Teaching periods available each day, in order. */
    periods: number[];
    days?: string[];
    /** Target weekly load per subject teacher. The owner's demo figure is 21. */
    load?: number;
}

/**
 * One class's week: which subject, on which day, in which period.
 *
 * Spread first, then order. Each weekly hour of a subject is put on the day
 * that is emptiest so far, so a three-hour subject lands on three different
 * days rather than three times on Monday; only when every day already has it
 * does a second one on one day happen. Within the day the subjects are then
 * sorted by importance, which is what puts Македонски and Математика in the
 * first periods — the owner's rule, applied per day rather than per week.
 */
export function layOutClass(subjects: SubjectHours[], opts: DemoOptions): Array<{ day: string; ordinal: number; subject: string }> {
    const days = opts.days ?? DEMO_DAYS;
    const perDay = opts.periods.length;
    const byDay = new Map<string, string[]>(days.map((d) => [d, []]));

    const wanted = subjects
        .filter((s) => timetabled(s.subject) && s.hours > 0)
        .sort((a, b) => importanceOf(a.subject) - importanceOf(b.subject)
            || a.subject.localeCompare(b.subject, 'mk'));

    for (const { subject, hours } of wanted) {
        for (let h = 0; h < hours; h++) {
            // The emptiest day that does not already hold this subject; if they
            // all do, the emptiest day regardless. Ties go to the earlier day,
            // so the same input always produces the same week.
            const room = days.filter((d) => byDay.get(d)!.length < perDay);
            if (!room.length) break;
            const fresh = room.filter((d) => !byDay.get(d)!.includes(subject));
            const pool = fresh.length ? fresh : room;
            const pick = pool.reduce((best, d) =>
                byDay.get(d)!.length < byDay.get(best)!.length ? d : best, pool[0]);
            byDay.get(pick)!.push(subject);
        }
    }

    const out: Array<{ day: string; ordinal: number; subject: string }> = [];
    for (const day of days) {
        const list = byDay.get(day)!
            .sort((a, b) => importanceOf(a) - importanceOf(b) || a.localeCompare(b, 'mk'));
        list.forEach((subject, i) => out.push({ day, ordinal: opts.periods[i], subject }));
    }
    return out;
}

/**
 * The whole school's demo week.
 *
 * Homerooms are settled first because they are not a choice: an одделенски
 * teacher holds their own class and nothing else. Everything left is offered
 * to the subject teachers, slot by slot, and a slot is skipped for anyone
 * already teaching in it — a demo that books one teacher into two rooms at
 * once would be reported by the crossing as a clash and read as a bug.
 */
export function planDemoTimetable(
    classes: DemoClass[],
    teachers: DemoTeacher[],
    subjectsFor: (grades: string[]) => SubjectHours[],
    opts: DemoOptions
): DemoPlan {
    const days = opts.days ?? DEMO_DAYS;
    const cap = opts.load ?? 21;
    const plan: DemoPlan = { lessons: [], load: new Map(), unstaffed: 0, notes: [], problems: [] };

    const byId = new Map(teachers.map((t) => [t.id, t]));
    const subjectTeachers = teachers.filter((t) => t.kind !== 'odd');
    if (!subjectTeachers.length) {
        plan.problems.push('No subject teachers on this year\'s staff list — nobody can take a предметна lesson.');
    }

    const busy = new Set<string>();                 // teacherId|day|ordinal
    const bump = (id: number) => plan.load.set(id, (plan.load.get(id) ?? 0) + 1);
    const take = (id: number, day: string, ordinal: number) => {
        busy.add(`${id}|${day}|${ordinal}`);
        bump(id);
    };
    const free = (id: number, day: string, ordinal: number) => !busy.has(`${id}|${day}|${ordinal}`);

    // Who has taught this subject so far. A subject with one teacher across the
    // school is what a real timetable looks like, and it is also what makes the
    // load add up: English cannot fill 21 hours in one class.
    const owner = new Map<string, number[]>();

    const classOrder = [...classes].sort((a, b) => a.label.localeCompare(b.label, 'mk'));
    let homeroomLed = 0;

    for (const cls of classOrder) {
        const home = cls.homeroomTeacherId != null ? byId.get(cls.homeroomTeacherId) : undefined;
        // ОДДЕЛЕНСКА is decided by the teacher's OWN kind, read from the
        // database, not guessed from the class label — a комбинирана паралелка
        // carries no Roman numeral to guess from, and `teachers.kind` already
        // means exactly this.
        const primary = !!home && home.kind === 'odd';
        if (primary) homeroomLed++;

        const subjects = subjectsFor(cls.grades);
        if (!subjects.length) {
            plan.problems.push(`${cls.label}: no subjects in the catalogue for grades ${cls.grades.join(', ') || '—'}.`);
            continue;
        }

        for (const slot of layOutClass(subjects, opts)) {
            let teacherId: number | null = null;

            if (primary && !isPhysical(slot.subject) && free(home!.id, slot.day, slot.ordinal)) {
                teacherId = home!.id;
            } else {
                // Prefer whoever already carries this subject, then whoever the
                // staff list says teaches it, then the lightest timetable. Each
                // must be free in this period and still under the load cap.
                const named = subjectTeachers.filter((t) =>
                    t.subject && slot.subject.toLowerCase().startsWith(String(t.subject).toLowerCase().slice(0, 6)));
                const ranked = [
                    ...(owner.get(slot.subject) ?? []).map((id) => byId.get(id)).filter(Boolean) as DemoTeacher[],
                    ...named,
                    ...[...subjectTeachers].sort((a, b) => (plan.load.get(a.id) ?? 0) - (plan.load.get(b.id) ?? 0))
                ];
                const pick = ranked.find((t) =>
                    free(t.id, slot.day, slot.ordinal) && (plan.load.get(t.id) ?? 0) < cap);
                teacherId = pick ? pick.id : null;
            }

            if (teacherId == null) {
                plan.unstaffed++;
            } else {
                take(teacherId, slot.day, slot.ordinal);
                if (!primary || isPhysical(slot.subject)) {
                    const seen = owner.get(slot.subject) ?? [];
                    if (!seen.includes(teacherId)) owner.set(slot.subject, [...seen, teacherId]);
                }
            }
            plan.lessons.push({ ...slot, classId: cls.id, teacherId });
        }
    }

    // What the importance rule costs, said out loud. Laying every class out by
    // the same order of importance puts Македонски in the first period of every
    // class at once, so a school needs as many Македонски teachers as it has
    // parallel classes in that moment. That is a true consequence of the rule
    // rather than a fault in it, and a real timetable staggers the days to
    // soften it — but a generator that quietly staggered would stop answering
    // the question that was asked.
    const crowd = new Map<string, number>();
    for (const l of plan.lessons) {
        const at = `${l.day}|${l.ordinal}|${l.subject}`;
        crowd.set(at, (crowd.get(at) ?? 0) + 1);
    }
    let worst = ['', 0] as [string, number];
    for (const [at, n] of crowd) if (n > worst[1]) worst = [at, n];
    if (worst[1] > 1) {
        const [day, ordinal, subject] = worst[0].split('|');
        plan.notes.push(
            `Most crowded period: ${subject} in ${worst[1]} classes at once (${day}, ${ordinal}. час). `
            + 'Strict importance order does that — every class opens the day with the same subject.'
        );
    }

    plan.notes.push(`${plan.lessons.length} lessons · ${classOrder.length} classes · ${days.length} days × ${opts.periods.length} periods`);
    plan.notes.push(`${homeroomLed} classes are одделенска (their class teacher holds everything but Физичко); ${classOrder.length - homeroomLed} are предметна`);
    if (plan.unstaffed) {
        plan.problems.push(
            `${plan.unstaffed} lessons have NO teacher: nobody was free and under ${cap} lessons. `
            + 'That is the real answer — another teacher has to be engaged, which is a decision for a person. '
            + 'They are written with an empty teacher and show as „— без наставник —".'
        );
    }
    return plan;
}

/**
 * The demo timetable generator, against a school that does not exist.
 *
 * Every name here is invented (rule 1). The point of testing a DEMO is not
 * that the week is beautiful — it is that the four rules the owner stated are
 * actually the ones the code follows, because a generated timetable is exactly
 * the kind of output that looks plausible while being wrong.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    planDemoTimetable, layOutClass, importanceOf, isPhysical, timetabled,
    teacherHandles, DEMO_DAYS, type DemoClass, type DemoTeacher, type SubjectHours
} from '../src/lib/teaching-demo.js';

const PERIODS = [1, 2, 3, 4, 5, 6, 7];

const SUBJECTS: SubjectHours[] = [
    { subject: 'Македонски јазик', hours: 5 },
    { subject: 'Математика', hours: 4 },
    { subject: 'Англиски јазик', hours: 2 },
    { subject: 'Природни науки', hours: 2 },
    { subject: 'Ликовно образование', hours: 1 },
    { subject: 'Музичко образование', hours: 1 },
    { subject: 'Физичко и здравствено образование', hours: 3 },
    { subject: 'Слободни изборни предмети', hours: 2 }
];

const teacher = (id: number, kind: string, subject: string | null = null): DemoTeacher =>
    ({ id, name: `Пробен ${id}`, kind, subject });

test('the catalogue rows that are not an ordinary lesson are left out', () => {
    assert.equal(timetabled('Македонски јазик'), true);
    assert.equal(timetabled('Слободни изборни предмети'), false);
    assert.equal(timetabled('Училиштен хор'), false);
});

test('Македонски and Математика come first, in that order', () => {
    assert.ok(importanceOf('Македонски јазик') < importanceOf('Математика'));
    assert.ok(importanceOf('Математика') < importanceOf('Англиски јазик'));
    assert.ok(importanceOf('Математика') < importanceOf('Физичко и здравствено образование'));
    // Anything the list does not name sorts after everything it does.
    assert.ok(importanceOf('Нешто Измислено') > importanceOf('Час на одделенска заедница'));
});

test('a day opens with one of its two most important lessons, and descends from there', () => {
    // Not strict order: which of the two heaviest subjects leads alternates by
    // day, exactly as the school's workbook has мак. on Monday and мат. on
    // Tuesday in the same class. Everything after the second period is in
    // order, which is what „од прв до последен час по важност" means in
    // practice.
    for (const offset of [0, 1, 2]) {
        const week = layOutClass(SUBJECTS, { periods: PERIODS }, offset);
        for (const day of DEMO_DAYS) {
            const inDay = week.filter((l) => l.day === day).sort((a, b) => a.ordinal - b.ordinal);
            if (inDay.length < 2) continue;
            const ranks = inDay.map((l) => importanceOf(l.subject));
            const sorted = [...ranks].sort((a, b) => a - b);
            assert.ok(ranks[0] === sorted[0] || ranks[0] === sorted[1],
                `${day} opens with ${inDay[0].subject}`);
            assert.deepEqual(ranks.slice(2), sorted.slice(2),
                `${day}: ${inDay.map((l) => l.subject).join(' / ')}`);
        }
    }
});

test('a five-hour subject is spread over the days, not stacked on one', () => {
    const week = layOutClass(SUBJECTS, { periods: PERIODS }, 2);
    const mk = week.filter((l) => l.subject === 'Македонски јазик');
    assert.equal(mk.length, 5);
    assert.equal(new Set(mk.map((l) => l.day)).size, 5);
});

test('the optional block never reaches the grid', () => {
    const week = layOutClass(SUBJECTS, { periods: PERIODS });
    assert.equal(week.filter((l) => l.subject === 'Слободни изборни предмети').length, 0);
});

test('a day never holds more lessons than there are periods', () => {
    const heavy = SUBJECTS.map((s) => ({ ...s, hours: s.hours * 3 }));
    const week = layOutClass(heavy, { periods: [1, 2, 3] });
    for (const day of DEMO_DAYS) {
        assert.ok(week.filter((l) => l.day === day).length <= 3);
    }
});

test('in одделенска the class teacher holds every lesson, as the workbook shows', () => {
    const classes: DemoClass[] = [{ id: 1, label: 'II-а', grades: ['II'], homeroomTeacherId: 10 }];
    const teachers = [teacher(10, 'odd'), teacher(20, 'pred')];
    const plan = planDemoTimetable(classes, teachers, () => SUBJECTS, { periods: PERIODS });

    const mine = plan.lessons.filter((l) => l.classId === 1);
    assert.ok(mine.length > 0);
    for (const l of mine) assert.equal(l.teacherId, 10, `${l.subject} belongs to the class teacher`);
});

test('…unless the accompanying arrangement is asked for in as many words', () => {
    const classes: DemoClass[] = [{ id: 1, label: 'II-а', grades: ['II'], homeroomTeacherId: 10 }];
    const teachers = [teacher(10, 'odd'), teacher(20, 'pred')];
    const plan = planDemoTimetable(classes, teachers, () => SUBJECTS,
        { periods: PERIODS, physicalToSubjectTeacher: true });

    for (const l of plan.lessons) {
        if (isPhysical(l.subject)) assert.equal(l.teacherId, 20);
        else assert.equal(l.teacherId, 10);
    }
});

test('a teacher recorded with the school\'s abbreviation gets that subject', () => {
    // ФЗО. against „Физичко и здравствено образование" — matched as plain text
    // the two never meet, and the one teacher who really does teach only that
    // was passed over for every one of its lessons.
    assert.equal(teacherHandles('ФЗО.', 'Физичко и здравствено образование'), true);
    assert.equal(teacherHandles('АНГ.', 'Англиски јазик'), true);
    assert.equal(teacherHandles('ЛИК.', 'Ликовно образование'), true);
    assert.equal(teacherHandles('ИНФ.', 'Техничко образование и информатика'), true);
    assert.equal(teacherHandles('ФЗО.', 'Математика'), false);
    assert.equal(teacherHandles('', 'Математика'), false);
    // A full name still works, and so does a short form nobody listed.
    assert.equal(teacherHandles('Математика', 'Математика'), true);

    const classes: DemoClass[] = [{ id: 1, label: 'VII', grades: ['VII'], homeroomTeacherId: null }];
    const teachers = [teacher(30, 'pred', 'ФЗО.'), teacher(31, 'pred'), teacher(32, 'pred')];
    const plan = planDemoTimetable(classes, teachers, () => SUBJECTS, { periods: PERIODS });
    const pe = plan.lessons.filter((l) => isPhysical(l.subject));
    assert.ok(pe.length > 0);
    for (const l of pe) assert.equal(l.teacherId, 30, 'the ФЗО. teacher takes Физичко');
});

test('classes do not all open the week with the same subject', () => {
    // Strict importance order from Monday put Македонски in the first period of
    // every class at once, which needs one Македонски teacher per parallel
    // class. The school's own workbook does not look like that.
    const first = [0, 1, 2, 3].map((offset) => {
        const week = layOutClass(SUBJECTS, { periods: PERIODS }, offset);
        return week.filter((l) => l.day === DEMO_DAYS[0]).sort((a, b) => a.ordinal - b.ordinal)[0]?.subject;
    });
    assert.ok(new Set(first).size > 1, JSON.stringify(first));
});

test('a class whose homeroom is a SUBJECT teacher is предметна, not одделенска', () => {
    // The kind is read from the database and decides; the label is not guessed
    // at, because a комбинирана паралелка carries no numeral to guess from.
    const classes: DemoClass[] = [{ id: 1, label: 'VIII', grades: ['VIII'], homeroomTeacherId: 30 }];
    const teachers = [teacher(30, 'pred'), teacher(31, 'pred'), teacher(32, 'pred')];
    const plan = planDemoTimetable(classes, teachers, () => SUBJECTS, { periods: PERIODS, load: 8 });
    const used = new Set(plan.lessons.map((l) => l.teacherId));
    assert.ok(used.size > 1, 'a предметна class is shared between subject teachers');
});

test('nobody is booked into two classes in the same period', () => {
    const classes: DemoClass[] = [
        { id: 1, label: 'VI-а', grades: ['VI'], homeroomTeacherId: null },
        { id: 2, label: 'VI-б', grades: ['VI'], homeroomTeacherId: null },
        { id: 3, label: 'VII', grades: ['VII'], homeroomTeacherId: null }
    ];
    const teachers = [teacher(40, 'pred'), teacher(41, 'pred'), teacher(42, 'pred'), teacher(43, 'pred')];
    const plan = planDemoTimetable(classes, teachers, () => SUBJECTS, { periods: PERIODS, load: 30 });

    const seen = new Set<string>();
    for (const l of plan.lessons) {
        if (l.teacherId == null) continue;
        const at = `${l.teacherId}|${l.day}|${l.ordinal}`;
        assert.ok(!seen.has(at), `teacher ${l.teacherId} is in two places at ${l.day} ${l.ordinal}`);
        seen.add(at);
    }
});

test('the load cap holds, and what it cannot cover is reported rather than invented', () => {
    const classes: DemoClass[] = [
        { id: 1, label: 'VI-а', grades: ['VI'], homeroomTeacherId: null },
        { id: 2, label: 'VI-б', grades: ['VI'], homeroomTeacherId: null }
    ];
    const teachers = [teacher(50, 'pred')];
    const plan = planDemoTimetable(classes, teachers, () => SUBJECTS, { periods: PERIODS, load: 5 });

    assert.ok((plan.load.get(50) ?? 0) <= 5, 'the cap is a cap');
    assert.ok(plan.unstaffed > 0, 'the rest has to be reported');
    // The rule that must never be "improved": a name is not generated for a
    // teacher this school does not employ. The lesson exists, empty.
    const empty = plan.lessons.filter((l) => l.teacherId === null);
    assert.equal(empty.length, plan.unstaffed);
    assert.ok(plan.problems.some((p) => /NO teacher/.test(p)));
});

test('a recorded specialist is not put on somebody else\'s subject', () => {
    // „Силвана е само англиски, Драган е само физичко." Handing the Физичко
    // teacher a Математика lesson because they were lightest at that moment
    // produces a timetable that looks fine and misstates who does what.
    const classes: DemoClass[] = [{ id: 1, label: 'VII', grades: ['VII'], homeroomTeacherId: null }];
    const teachers = [teacher(90, 'pred', 'ФЗО.'), teacher(91, 'pred'), teacher(92, 'pred')];
    const plan = planDemoTimetable(classes, teachers, () => SUBJECTS, { periods: PERIODS });
    for (const l of plan.lessons) {
        if (l.teacherId === 90) assert.ok(isPhysical(l.subject), `ФЗО. teacher given ${l.subject}`);
    }
    assert.ok(plan.lessons.some((l) => l.teacherId === 90), 'and they do get their own');
});

test('it creates nobody: every teacher in the plan came from the staff list', () => {
    const classes: DemoClass[] = [{ id: 1, label: 'III', grades: ['III'], homeroomTeacherId: 60 }];
    const teachers = [teacher(60, 'odd'), teacher(61, 'pred')];
    const plan = planDemoTimetable(classes, teachers, () => SUBJECTS, { periods: PERIODS });
    const known = new Set(teachers.map((t) => t.id));
    for (const l of plan.lessons) {
        if (l.teacherId != null) assert.ok(known.has(l.teacherId));
    }
});

test('a class with no readable grade is reported, not given an invented curriculum', () => {
    const classes: DemoClass[] = [{ id: 1, label: 'комбинирана', grades: [], homeroomTeacherId: null }];
    const plan = planDemoTimetable(classes, [teacher(70, 'pred')], () => [], { periods: PERIODS });
    assert.equal(plan.lessons.length, 0);
    assert.ok(plan.problems.some((p) => p.includes('комбинирана')));
});

test('the same input always produces the same week', () => {
    const classes: DemoClass[] = [
        { id: 1, label: 'V-а', grades: ['V'], homeroomTeacherId: 80 },
        { id: 2, label: 'V-б', grades: ['V'], homeroomTeacherId: 81 }
    ];
    const teachers = [teacher(80, 'odd'), teacher(81, 'odd'), teacher(82, 'pred')];
    const once = planDemoTimetable(classes, teachers, () => SUBJECTS, { periods: PERIODS });
    const twice = planDemoTimetable(classes, teachers, () => SUBJECTS, { periods: PERIODS });
    assert.deepEqual(once.lessons, twice.lessons);
});

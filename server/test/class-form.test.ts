/**
 * What a homeroom teacher's answer to the class form would change (`plan` in
 * mtb-class-form.js). Pure: no server, no browser, invented classes and people.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

type Cell = { subject: string | null; teacher: string | null } | null;
type Plan = {
    errors: string[]; class: string | null; note: string; unchanged: number;
    changes: Array<{ key: string; from: Cell; to: Cell; reasons: string[] }>;
    conflicts: Array<{ key: string; baseline: Cell }>;
    skipped: Array<{ key: string; reason: string }>;
    reports: Array<{ name: string; text: string }>;
};
type Form = { plan: (reply: unknown, ctx: unknown) => Plan; buildForm: (data: unknown) => string; REPLY: string; VERSION: number };

async function load(): Promise<Form> {
    const sandbox: { window: Record<string, any> } = { window: {} };
    const context = vm.createContext(sandbox);
    for (const file of ['mtb-schedule-form.js', 'mtb-class-form.js']) {
        vm.runInContext(await readFile(new URL('../../' + file, import.meta.url), 'utf8'), context);
    }
    const form = sandbox.window.MTBClassForm as Form;
    return { ...form, plan: (r: unknown, c: unknown) => JSON.parse(JSON.stringify(form.plan(r, c))) as Plan };
}

const MON1 = 'понеделник|1';
const MON2 = 'понеделник|2';
const TUE1 = 'вторник|1';
const ctx = (over: Record<string, unknown> = {}) => ({
    year: '2026/2027',
    classes: ['II-б', 'III-а'],
    validKeys: [MON1, MON2, TUE1],
    doubled: [],
    current: { [MON1]: { subject: 'Македонски јазик', teacher: 'Наставник Прв' }, [MON2]: { subject: 'Математика', teacher: null } },
    teachers: ['Наставник Прв', 'Наставник Втор'],
    busy: { [TUE1]: [{ teacher: 'Наставник Втор', class: 'III-а' }] },
    ...over
});
const reply = (form: Form, cells: Record<string, Cell>, over: Record<string, unknown> = {}) => ({
    kind: form.REPLY, version: form.VERSION, year: '2026/2027',
    class: { id: 3, label: 'II-б' }, homeroom: 'Наставник Прв',
    baseline: { [MON1]: { subject: 'Македонски јазик', teacher: 'Наставник Прв' }, [MON2]: { subject: 'Математика', teacher: null } },
    cells, subjects: [], reports: [], note: '', ...over
});
const same = { [MON1]: { subject: 'Македонски јазик', teacher: 'Наставник Прв' }, [MON2]: { subject: 'Математика', teacher: null } };

test('an untouched answer changes nothing', async () => {
    const form = await load();
    const p = form.plan(reply(form, same), ctx());
    assert.deepEqual(p.errors, []);
    assert.equal(p.changes.length, 0);
    assert.equal(p.unchanged, 2);
});

test('spacing and letter case do not make a change', async () => {
    const form = await load();
    const p = form.plan(reply(form, { ...same, [MON1]: { subject: ' македонски   јазик', teacher: 'Наставник Прв ' } }), ctx());
    assert.equal(p.changes.length, 0);
});

test('a new subject, a cleared period and a new lesson, each against the database now', async () => {
    const form = await load();
    const p = form.plan(reply(form, {
        [MON1]: { subject: 'Ликовно образование', teacher: 'Наставник Прв' },
        [TUE1]: { subject: 'Математика', teacher: null }
    }), ctx());
    assert.deepEqual(p.changes.map((c) => [c.key, c.from && c.from.subject, c.to && c.to.subject]).sort(), [
        [MON1, 'Македонски јазик', 'Ликовно образование'],
        [MON2, 'Математика', null],
        [TUE1, null, 'Математика']
    ].sort());
});

test('a teacher already in another class at that time is a conflict, with the reason', async () => {
    const form = await load();
    const p = form.plan(reply(form, { ...same, [TUE1]: { subject: 'Музичко образование', teacher: 'наставник втор' } }), ctx());
    const change = p.changes.find((c) => c.key === TUE1)!;
    assert.match(change.reasons[0], /Наставник Втор веќе има час во III-а/);
    assert.equal(change.to!.teacher, 'Наставник Втор', 'the name is the staff list\'s spelling');
});

test('a cell changed in Уреди настава since the form was made is not overwritten', async () => {
    const form = await load();
    const p = form.plan(reply(form, { ...same, [MON2]: { subject: 'Физичко образование', teacher: null } }),
        ctx({ current: { ...ctx().current, [MON2]: { subject: 'Англиски јазик', teacher: null } } }));
    assert.equal(p.changes.length, 0);
    assert.deepEqual(p.conflicts.map((c) => [c.key, c.baseline && c.baseline.subject]), [[MON2, 'Математика']]);
});

test('an answer the database already agrees with is not written twice', async () => {
    const form = await load();
    const p = form.plan(reply(form, { ...same, [MON2]: { subject: 'Англиски јазик', teacher: null } }),
        ctx({ current: { ...ctx().current, [MON2]: { subject: 'Англиски јазик', teacher: null } } }));
    assert.equal(p.changes.length + p.conflicts.length, 0);
});

test('what the form cannot promise is skipped with a reason', async () => {
    const form = await load();
    const p = form.plan(reply(form, {
        ...same,
        'сабота|1': { subject: 'Математика', teacher: null },
        [TUE1]: { subject: 'Математика', teacher: 'Непознат Наставник' }
    }), ctx());
    assert.deepEqual(p.skipped.map((s) => s.reason).sort(), [
        'наставникот „Непознат Наставник" не е на списокот за годината', 'тој час не постои во распоредот'
    ].sort());
    const doubled = form.plan(reply(form, { ...same, [MON1]: { subject: 'Математика', teacher: null } }), ctx({ doubled: [MON1] }));
    assert.match(doubled.skipped[0].reason, /два часа/);
});

test('a pupil report is carried, never a move; an empty one is dropped', async () => {
    const form = await load();
    const p = form.plan(reply(form, same, { reports: [
        { name: 'Ана Пробна', generation: 'II', text: ' е во III-а ' }, { name: 'Бојан Пробен', text: '  ' }
    ] }), ctx());
    assert.deepEqual(p.reports.map((r) => [r.name, r.text]), [['Ана Пробна', 'е во III-а']]);
    assert.equal(p.changes.length, 0);
});

test('the wrong file, year or class stops before anything is planned', async () => {
    const form = await load();
    assert.match(form.plan({ kind: 'mtb-schedule-reply' }, ctx()).errors[0], /одделение/);
    assert.match(form.plan(reply(form, same, { year: '2025/2026' }), ctx()).errors[0], /2025\/2026/);
    assert.match(form.plan(reply(form, same, { class: { id: 1, label: 'IX-з' } }), ctx()).errors[0], /IX-з/);
});

test('the form: every class in a dropdown, the subject checklist, the picture, nothing from outside', async () => {
    const form = await load();
    const html = form.buildForm({
        year: '2026/2027', generatedAt: '2026-09-24T00:00:00Z', days: ['понеделник'],
        periods: [{ ordinal: 1, label: '1. час', time: '08:00' }],
        subjects: ['Математика'], teachers: ['Наставник Прв'],
        classes: [{ id: 3, label: 'II-б', description: '', homeroom: 'Наставник Прв', lessons: {}, doubled: [], offered: [],
                    pupils: [{ name: '</script><b>x', generation: 'II' }] }],
        selected: null
    });
    assert.ok(!html.includes('</script><b>x'), 'a name is escaped inside the embedded JSON');
    assert.match(html, /id="who"/);
    assert.match(html, /id="subjects"/);
    assert.match(html, /id="image"/);
    assert.equal((html.match(/<script/g) || []).length, 2);
    assert.doesNotMatch(html, /src=|href="http/);
});

// ── a teacher's own week ────────────────────────────────────────────────────

type Slot = { class: string; subject: string | null } | null;
type TPlan = {
    errors: string[]; teacher: string | null; unchanged: number;
    changes: Array<{ key: string; from: Slot; to: Slot; reasons: string[]; together: string | null }>;
    conflicts: Array<{ key: string; baseline: Slot }>;
    skipped: Array<{ key: string; reason: string }>;
};
async function loadTeacher() {
    const sandbox: { window: Record<string, any> } = { window: {} };
    const context = vm.createContext(sandbox);
    for (const file of ['mtb-schedule-form.js', 'mtb-class-form.js']) {
        vm.runInContext(await readFile(new URL('../../' + file, import.meta.url), 'utf8'), context);
    }
    const form = sandbox.window.MTBTeacherForm;
    return { ...form, plan: (r: unknown, c: unknown) => JSON.parse(JSON.stringify(form.plan(r, c))) as TPlan };
}
const tctx = (over: Record<string, unknown> = {}) => ({
    year: '2026/2027', teachers: ['Наставник Прв', 'Наставник Втор'], classes: ['II-б', 'VII'],
    validKeys: [MON1, MON2, TUE1], doubled: [],
    current: { [MON1]: { class: 'VII', subject: 'Англиски јазик' } },
    occupied: {
        [MON1]: [{ class: 'VII', teacher: 'Наставник Прв', subject: 'Англиски јазик' }],
        [MON2]: [{ class: 'II-б', teacher: 'Наставник Втор', subject: 'Физичко образование' }],
        [TUE1]: [{ class: 'VII', teacher: 'Наставник Втор', subject: 'Математика' }]
    },
    ...over
});
const treply = (form: any, cells: Record<string, Slot>, over: Record<string, unknown> = {}) => ({
    kind: form.REPLY, version: form.VERSION, year: '2026/2027', teacher: { id: 1, name: 'наставник прв' },
    baseline: { [MON1]: { class: 'VII', subject: 'Англиски јазик' } }, cells, note: '', ...over
});

test('teacher: an untouched week is a confirmation, nothing to write', async () => {
    const form = await loadTeacher();
    const p = form.plan(treply(form, { [MON1]: { class: 'VII', subject: 'Англиски јазик' } }), tctx());
    assert.deepEqual([p.errors, p.teacher, p.changes.length, p.unchanged], [[], 'Наставник Прв', 0, 1]);
});

test('teacher: the same subject with one other teacher is co-teaching, a different one a conflict', async () => {
    const form = await loadTeacher();
    const p = form.plan(treply(form, {
        [MON1]: { class: 'VII', subject: 'Англиски јазик' },
        [MON2]: { class: 'II-б', subject: 'физичко образование' },
        [TUE1]: { class: 'VII', subject: 'Англиски јазик' }
    }), tctx());
    const mon2 = p.changes.find((c) => c.key === MON2)!;
    assert.deepEqual([mon2.together, mon2.reasons], ['Наставник Втор', []]);
    const tue1 = p.changes.find((c) => c.key === TUE1)!;
    assert.match(tue1.reasons[0], /во VII во тој час е Наставник Втор \(Математика\)/);
});

test('teacher: a free period clears it; a moved lesson is written against the database now', async () => {
    const form = await loadTeacher();
    const p = form.plan(treply(form, { [MON2]: { class: 'VII', subject: 'Англиски јазик' } }), tctx());
    assert.deepEqual(p.changes.map((c) => [c.key, c.from && c.from.class, c.to && c.to.class]).sort(),
        [[MON1, 'VII', null], [MON2, null, 'VII']].sort());
    const moved = form.plan(treply(form, {}), tctx({ current: { [MON1]: { class: 'II-б', subject: 'Англиски јазик' } } }));
    assert.deepEqual(moved.conflicts.map((c) => c.key), [MON1], 'changed meanwhile is not overwritten');
});

test('teacher: what cannot be written is skipped with a reason; a stranger stops everything', async () => {
    const form = await loadTeacher();
    const p = form.plan(treply(form, { [MON1]: { class: 'VII', subject: 'Англиски јазик' }, [TUE1]: { class: 'X-з', subject: 'Математика' }, 'сабота|1': { class: 'VII', subject: 'x' } }), tctx());
    assert.deepEqual(p.skipped.map((s) => s.reason).sort(), ['одделението „X-з" не е на списокот за годината', 'тој час не постои во распоредот'].sort());
    assert.match(form.plan(treply(form, {}, { teacher: { id: 9, name: 'Никој' } }), tctx()).errors[0], /Никој/);
});

test('teacher form: every teacher, both tabs, a picture and print, no children in it', async () => {
    const form = await loadTeacher();
    const html = form.buildForm({
        year: '2026/2027', generatedAt: '2026-09-24T00:00:00Z', days: ['понеделник'],
        periods: [{ ordinal: 1, label: '1. час', time: '08:00' }], subjects: ['Математика'],
        classes: [{ label: 'VII', homeroom: 'Наставник Прв' }],
        teachers: [{ id: 1, name: 'Наставник Прв', subject: null, role: 'класен раководител на VII', homeroomOf: 'VII', lessons: {}, doubled: [] }],
        lessons: [], selected: null
    });
    for (const id of ['who', 'grid', 'klassGrid', 'image', 'klassImage', 'klassPrint']) assert.match(html, new RegExp(`id="${id}"`), id);
    assert.equal((html.match(/<script/g) || []).length, 2);
    assert.doesNotMatch(html, /src=|href="http/);
});

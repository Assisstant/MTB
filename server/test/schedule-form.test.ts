/**
 * What a colleague's answer to the schedule form would change (`plan` in
 * mtb-schedule-form.js). Pure: no server, no browser, invented people.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

type Plan = {
    errors: string[]; therapist: { id: number; name: string } | null; note: string;
    newPupils: Array<{ id: string; name: string; match: string; publicId?: string }>;
    changes: Array<{ key: string; from: string[]; to: Array<string | { create: string }> }>;
    conflicts: Array<{ key: string }>; skipped: Array<{ key: string; reason: string }>;
    unchanged: number; caseloadAdds: string[];
};
type Form = { plan: (reply: unknown, ctx: unknown) => Plan; buildForm: (data: unknown) => string; REPLY: string; VERSION: number };

async function load(): Promise<Form> {
    const source = await readFile(new URL('../../mtb-schedule-form.js', import.meta.url), 'utf8');
    const sandbox: { window: { MTBScheduleForm?: Form } } = { window: {} };
    vm.runInNewContext(source, sandbox);
    const form = sandbox.window.MTBScheduleForm as Form;
    // Results are made in another realm; compare them as plain data.
    return { ...form, plan: (r: unknown, c: unknown) => JSON.parse(JSON.stringify(form.plan(r, c))) as Plan };
}

const MON1 = 'понеделник|08:00-08:40';
const MON2 = 'понеделник|08:45-09:25';
const TUE1 = 'вторник|08:00-08:40';
const ctx = (over: Record<string, unknown> = {}) => ({
    year: '2026/2027',
    therapists: [{ id: 7, name: 'Терапевт Пример', students: ['p-a', 'p-b'] }],
    students: [
        { public_id: 'p-a', name: 'Ана Пробна' }, { public_id: 'p-b', name: 'Бојан Пробен' },
        { public_id: 'p-c', name: 'Цвета Измислена' },
        { public_id: 'p-d1', name: 'Иста Имиња' }, { public_id: 'p-d2', name: 'Иста Имиња' }
    ],
    current: { [MON1]: ['p-a'], [MON2]: ['p-b'] },
    validKeys: [MON1, MON2, TUE1],
    locked: [],
    ...over
});
const reply = (form: Form, blocks: Record<string, string[]>, over: Record<string, unknown> = {}) => ({
    kind: form.REPLY, version: form.VERSION, year: '2026/2027',
    therapist: { id: 7, name: 'Терапевт Пример' },
    baseline: { [MON1]: ['p-a'], [MON2]: ['p-b'] },
    blocks, newPupils: [], note: '', ...over
});

test('an untouched answer changes nothing', async () => {
    const form = await load();
    const p = form.plan(reply(form, { [MON1]: ['p-a'], [MON2]: ['p-b'] }), ctx());
    assert.deepEqual(p.errors, []);
    assert.equal(p.changes.length, 0);
    assert.equal(p.unchanged, 2);
});

test('a block missing from the answer was cleared by the colleague', async () => {
    const form = await load();
    const p = form.plan(reply(form, { [MON1]: ['p-a'] }), ctx());
    assert.deepEqual(p.changes.map((c) => [c.key, c.to]), [[MON2, []]]);
});

test('a changed block is written against what the database holds now', async () => {
    const form = await load();
    const p = form.plan(reply(form, { [MON1]: ['p-a', 'p-b'], [MON2]: [], [TUE1]: ['p-a'] }), ctx());
    assert.deepEqual(p.changes.map((c) => [c.key, c.from, c.to]), [
        [MON1, ['p-a'], ['p-a', 'p-b']], [MON2, ['p-b'], []], [TUE1, [], ['p-a']]
    ]);
    assert.deepEqual(p.caseloadAdds, [], 'both pupils were already on the list');
});

test('a block changed in the database since the form was made is refused, never overwritten', async () => {
    const form = await load();
    const p = form.plan(reply(form, { [MON1]: ['p-b'], [MON2]: ['p-b'] }), ctx({ current: { [MON1]: ['p-c'], [MON2]: ['p-b'] } }));
    assert.equal(p.changes.length, 0);
    assert.deepEqual(p.conflicts.map((c) => c.key), [MON1]);
});

test('a block the database already shows as answered is not written twice', async () => {
    const form = await load();
    const p = form.plan(reply(form, { [MON1]: ['p-b'], [MON2]: ['p-b'] }), ctx({ current: { [MON1]: ['p-b'], [MON2]: ['p-b'] } }));
    assert.equal(p.changes.length, 0);
    assert.equal(p.conflicts.length, 0);
});

test('a typed name becomes a new pupil under observation and joins the list', async () => {
    const form = await load();
    const p = form.plan(reply(form, { [MON1]: ['p-a'], [MON2]: ['p-b'], [TUE1]: ['new:1'] }, { newPupils: [{ id: 'new:1', name: '  Ново   Дете ' }] }), ctx());
    assert.deepEqual(p.newPupils.map((n) => [n.name, n.match]), [['Ново Дете', 'create']]);
    assert.deepEqual(p.changes[0].to, [{ create: 'Ново Дете' }]);
});

test('a typed name that IS a pupil links to that pupil instead of creating a second', async () => {
    const form = await load();
    const p = form.plan(reply(form, { [MON1]: ['p-a'], [MON2]: ['p-b'], [TUE1]: ['new:1'] }, { newPupils: [{ id: 'new:1', name: 'цвета измислена' }] }), ctx());
    assert.equal(p.newPupils[0].match, 'existing');
    assert.deepEqual(p.changes[0].to, ['p-c']);
    assert.deepEqual(p.caseloadAdds, ['p-c'], 'the pupil is added to the colleague\'s list');
});

test('a typed name two children share is refused (rule 2)', async () => {
    const form = await load();
    const p = form.plan(reply(form, { [MON1]: ['p-a'], [MON2]: ['p-b'], [TUE1]: ['new:1'] }, { newPupils: [{ id: 'new:1', name: 'Иста Имиња' }] }), ctx());
    assert.equal(p.newPupils[0].match, 'ambiguous');
    assert.equal(p.changes.length, 0);
    assert.match(p.skipped[0].reason, /повеќе деца/);
});

test('a new name nobody was placed in still joins the list', async () => {
    const form = await load();
    const p = form.plan(reply(form, { [MON1]: ['p-a'], [MON2]: ['p-b'] }, { newPupils: [{ id: 'new:1', name: 'Цвета Измислена' }] }), ctx());
    assert.equal(p.changes.length, 0);
    assert.deepEqual(p.caseloadAdds, ['p-c']);
});

test('what the form cannot promise is skipped with a reason', async () => {
    const form = await load();
    const p = form.plan(reply(form, {
        'сабота|08:00-08:40': ['p-a'],
        [TUE1]: ['p-a', 'p-b', 'p-c'],
        [MON1]: ['p-a'],
        [MON2]: ['p-gone']
    }), ctx());
    assert.equal(p.changes.length, 0);
    assert.deepEqual(p.skipped.map((s) => s.reason).sort(), [
        'повеќе од два ученика или исто дете двапати', 'терминот не постои во распоредот', 'ученикот повеќе не е на списокот'
    ].sort());
    const locked = form.plan(reply(form, { [MON1]: ['p-b'], [MON2]: ['p-b'] }), ctx({ locked: [MON1] }));
    assert.match(locked.skipped[0].reason, /сложен термин/);
});

test('the wrong file, year or therapist stops before anything is planned', async () => {
    const form = await load();
    assert.match(form.plan({ kind: 'x' }, ctx()).errors[0], /не е одговор/);
    assert.match(form.plan(reply(form, {}, { year: '2025/2026' }), ctx()).errors[0], /2025\/2026/);
    assert.match(form.plan(reply(form, {}, { therapist: { id: 99, name: 'Никој' } }), ctx()).errors[0], /Никој/);
});

test('the form carries its data inside, so a name cannot close the script', async () => {
    const form = await load();
    const html = form.buildForm({
        year: '2026/2027', therapist: { id: 7, name: 'Т' }, generatedAt: '2026-09-23T00:00:00Z',
        days: ['понеделник'], bells: [{ label: 'I', time: '08:00-08:40' }],
        pupils: [{ id: 'p-a', label: '</script><b>x' }], blocks: {}, locked: []
    });
    assert.ok(!html.includes('</script><b>x'), 'a name is escaped inside the embedded JSON');
    assert.equal((html.match(/<script/g) || []).length, 2, 'the data and the form script, nothing loaded from outside');
    assert.doesNotMatch(html, /src=|href="http/, 'the form needs nothing from a server');
});

test('version 2: a tick added joins the list, a tick removed leaves it', async () => {
    const form = await load();
    const p = form.plan(reply(form, { [MON1]: ['p-a'], [MON2]: ['p-b'] }, {
        pupils: { baseline: ['p-a', 'p-b'], ticked: ['p-a', 'p-b', 'p-c'] }
    }), ctx());
    assert.deepEqual(p.caseloadAdds, ['p-c']);
    assert.deepEqual((p as any).caseloadRemovals, []);
    const off = form.plan(reply(form, { [MON1]: ['p-a'] }, {
        pupils: { baseline: ['p-a', 'p-b'], ticked: ['p-a'] }
    }), ctx());
    assert.deepEqual((off as any).caseloadRemovals, ['p-b'], 'unticked and no longer placed');
});

test('version 2: a pupil still placed in a term never leaves the list', async () => {
    const form = await load();
    const p = form.plan(reply(form, { [MON1]: ['p-a'], [MON2]: ['p-b'] }, {
        pupils: { baseline: ['p-a', 'p-b'], ticked: ['p-a'] }
    }), ctx());
    assert.deepEqual((p as any).caseloadRemovals, []);
});

test('version 2: a removal the database already made is not proposed again', async () => {
    const form = await load();
    const p = form.plan(reply(form, { [MON1]: ['p-a'] }, {
        pupils: { baseline: ['p-a', 'p-b'], ticked: ['p-a'] }
    }), ctx({ therapists: [{ id: 7, name: 'Терапевт Пример', students: ['p-a'] }] }));
    assert.deepEqual((p as any).caseloadRemovals, []);
});

test('a version 1 answer, already sent before version 2, still reads', async () => {
    const form = await load();
    assert.equal(form.VERSION, 2);
    const p = form.plan(reply(form, { [MON1]: ['p-a'], [MON2]: [] }, { version: 1 }), ctx());
    assert.deepEqual(p.errors, []);
    assert.deepEqual(p.changes.map((c) => c.key), [MON2]);
    assert.match(form.plan(reply(form, {}, { version: 3 }), ctx()).errors[0], /верзија/);
});

test('version 2 form: every therapist, a dropdown, the checklist and a picture', async () => {
    const form = await load();
    const html = form.buildForm({
        year: '2026/2027', generatedAt: '2026-09-24T00:00:00Z',
        days: ['понеделник'], bells: [{ label: 'I', time: '08:00-08:40' }],
        pupils: [{ id: 'p-a', name: 'Ана Пробна', label: 'II-б - Ана Пробна', klass: 'II-б', homeroom: 'Измислена' }],
        therapists: [
            { id: 7, name: 'Терапевт Пример', students: ['p-a'], blocks: {}, locked: [] },
            { id: 8, name: 'Друг Терапевт', students: [], blocks: {}, locked: [] }
        ],
        selected: null
    });
    assert.match(html, /id="who"/);
    assert.match(html, /Друг Терапевт/);
    assert.match(html, /id="checks"/);
    assert.match(html, /id="image"/);
    assert.match(html, /function paintGrid/);
    assert.equal((html.match(/<script/g) || []).length, 2);
});

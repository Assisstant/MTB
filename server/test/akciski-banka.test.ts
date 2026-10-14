// The bank of suggestions for the action plan (phase 1, content): the owner's
// proposal is read whole, every line keeps an id, and what is said about a line
// in predlozi.json points at a line that exists.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load, problems, parseSource, proposal, measurable, approved, domainDocument, SOURCE, type Overlay } from '../scripts/akciski-banka.js';
import { buildPlanBank } from '../src/lib/pupil-plan-bank.js';

const ROOT = resolve(import.meta.dirname, '../..');

test('the runtime bank includes only approved selectable text, with checks and no pupil information', () => {
    const source = load();
    source.overlay = structuredClone(source.overlay);
    // The real decisions are set aside: this test makes its own, so it says the same in every edition.
    Object.values(source.overlay.stavki).forEach((note) => { delete note.status; });
    source.overlay.izdanie = 1;
    source.overlay.stavki['I-C01'].status = 'odobreno';
    source.overlay.stavki['I-C01'].proverka = 'Проверка: [како се набљудува]';
    source.overlay.stavki['I-P01'] = { status: 'dorabotka' };
    const adaptation = source.items.find((item) => item.section === 6 && item.kind === 'P')!;
    source.overlay.stavki[adaptation.id] = { status: 'odobreno', odobreno: 'Одобрено прилагодување' };
    source.overlay.dodadeni.push({ id: 'IV-C90', domain: 'IV', kind: 'C', text: 'Нова тест цел' });
    source.overlay.stavki['IV-C90'] = { status: 'odobreno', odobreno: 'Конечна тест цел' };
    source.overlay.dodadeni.push({ id: 'IV-C91', domain: 'IV', kind: 'C', text: 'Неодобрен додаток' });
    const bank = buildPlanBank(source);
    assert.equal(bank.edition, 1);
    assert.deepEqual(bank.items.map((item) => item.id), ['I-C01', 'IV-C90', adaptation.id]);
    assert.match(bank.items[0].text, /\nПроверка: \[како се набљудува\]$/);
    assert.equal(bank.items[2].use, 'adaptation');
    assert.equal(bank.items[2].text, 'Одобрено прилагодување');
    assert.ok(!JSON.stringify(bank).includes('stavki'));
    const unreviewed = load();
    unreviewed.overlay.izdanie = 0;
    Object.values(unreviewed.overlay.stavki).forEach((note) => { note.status = 'pregled'; });
    assert.equal(buildPlanBank(unreviewed).items.length, 0, 'edition zero does not publish review drafts');
});

test('new items need unique stable IDs and edition validation also guards publication', () => {
    const source = load();
    source.overlay.dodadeni = [
        { id: 'IV-C90', domain: 'IV', kind: 'C', text: 'Прва' },
        { id: 'IV-C90', domain: 'IV', kind: 'C', text: 'Втора' }
    ];
    assert.throws(() => buildPlanBank(source), /IV-C90/);
    source.overlay.dodadeni = [];
    source.overlay.izdanie = -1;
    assert.throws(() => buildPlanBank(source), /Изданието/);
    source.overlay.izdanie = 0;
    source.overlay.stavki['I-C01'].status = 'odobreno';
    assert.throws(() => buildPlanBank(source), /издание 1/);
});

test('the bank reads every list line of the source, each with its own id', () => {
    const { items, domains } = load();
    const source = readFileSync(resolve(ROOT, SOURCE), 'utf8').replace(/\r\n/g, '\n');
    const from = source.indexOf('\n# 4. '), to = source.indexOf('\n# 6. ');
    const lines = source.slice(from, to).split('\n').filter((line) => /^\s*(?:-|\d+\.)\s+\S/.test(line)).length;
    assert.equal(items.filter((i) => i.domain && i.kind !== 'N').length, lines);
    assert.deepEqual(domains.map((d) => d.code), ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV']);
    assert.equal(new Set(items.map((i) => i.id)).size, items.length);
    assert.equal(items.find((i) => i.id === 'I-C01')!.original, 'Подобрување на постуралната контрола при седење, стоење и движење.');
});

test('what predlozi.json says belongs to a line that exists, and to an item of the sheet that exists', () => {
    const { items, overlay, sheet } = load();
    assert.deepEqual(problems(items, overlay, sheet), []);
    assert.equal(sheet.length, 5 + 4 + 9 + 9 + 7 + 12 + 19 + 11 + 12 + 9 + 15);
    // Every proposed goal has a measurable form to review.
    assert.deepEqual(items.filter((i) => i.kind === 'C' && !measurable(i, overlay)).map((i) => i.id), []);
});

test('a drifted overlay is refused, and nothing reaches Колега unapproved', () => {
    const { items, sheet } = load();
    const overlay: Overlay = { izdanie: 0, termini: [['нема таков збор', 'x']], dodadeni: [],
        stavki: { 'I-C99': {}, 'I-C01': { list: ['s1_77'], status: 'odobreno' }, 'I-P01': { odnesuvanje: 'ќе' } } };
    const errors = problems(items, overlay, sheet).join('\n');
    for (const expected of ['„I-C99" не постои', '„s1_77" не е ставка', 'бара издание 1', 'само за цели', 'го нема во изворот']) assert.match(errors, new RegExp(expected));

    const { items: [goal, activity] } = parseSource('# 4. Содржини\n## VI. Однесување\n### Предлог цели\n- Чекање ред.\n### Активности\n- role-play;\n');
    const draft: Overlay = { izdanie: 1, termini: [['role-play', 'играње улоги']], dodadeni: [], stavki: { 'VI-C01': { odnesuvanje: 'ќе го почека својот ред' } } };
    assert.deepEqual(proposal(activity, draft), { text: 'играње улоги', by: 'превод на термин' });
    assert.equal(approved(goal, draft), null);
    draft.stavki['VI-C01'].status = 'odobreno';
    assert.match(approved(goal, draft)!, /^Ученикот ќе го почека својот ред \[во каква ситуација\]/);
    draft.stavki['VI-C01'].odobreno = 'Како што го поправи колегата.';
    assert.equal(approved(goal, draft), 'Како што го поправи колегата.');
});

test('the review document shows the source beside every proposal and names the sheet items left unlinked', () => {
    const { items, domains, overlay, sheet } = load();
    const html = domainDocument(domains.find((d) => d.code === 'IX')!, items, overlay, sheet, '14.10.2026');
    assert.match(html, /IX-C04<\/td><td>Плаќање едноставна сума\.<\/td>/);
    assert.match(html, /Ученикот ќе плати едноставна сума \[во каква ситуација\]/);
    assert.match(html, /не се поврзани[^<]*<\/b> ЛИЧНИ — Одговорност во заштита на животната средина\./);
    assert.match(html, /разложување на задачата на чекори <span class="by">\(превод на термин\)/);
});

/**
 * Reading the school's list of pupils.
 *
 * Every name here is invented (rule 1). The real list is a Word file that
 * stays on the school's machine and never comes near this repository — which
 * is exactly why the parsing is split: `docxTables` turns a file into a grid
 * and has no opinions, and everything below works on a grid, so the rules can
 * be tested against a school that does not exist.
 *
 * Run: npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    parseRosterGrid, classShapeProblems, splitClassLabel, promote,
    wordTables, parseStaffList, splitClassAndPlan, romanClassLabel, parseProgrammeGrid
} from '../src/lib/roster-doc.js';

const HEADER = ['Бр.', 'Одд.', 'Име и Презиме'];

test('the columns are found by their heading, not by their position', () => {
    const doc = parseRosterGrid([
        HEADER,
        ['1', 'I-а', 'Ана Тестова'],
        ['2', 'I-б', 'Бојан Пробен']
    ]);
    assert.deepEqual(doc.problems, []);
    assert.deepEqual(doc.rows.map((r) => [r.ordinal, r.classLabel, r.name]), [
        [1, 'I-а', 'Ана Тестова'],
        [2, 'I-б', 'Бојан Пробен']
    ]);

    // A column added in front must not shift every name one place left.
    const moved = parseRosterGrid([
        ['Одд.', 'Име и Презиме'],
        ['II', 'Ана Тестова']
    ]);
    assert.deepEqual(moved.rows.map((r) => [r.classLabel, r.name]), [['II', 'Ана Тестова']]);
    assert.equal(moved.rows[0].ordinal, null, 'no numbering column is not an error');
});

/**
 * The heading is Cyrillic and `\b` is ASCII.
 *
 * The first version of the name heading was `/^(име|ученик)\b/i` and matched
 * NOTHING: „е" is not an ASCII word character, so there is no boundary after
 * „име" to find. Every row was then reported as a table with no name column —
 * on a file that was perfectly fine.
 */
test('a Cyrillic heading is recognised, which an ASCII word boundary cannot do', () => {
    for (const heading of ['Име и Презиме', 'Име', 'ИМЕ И ПРЕЗИМЕ', 'Ученик', 'Презиме и име']) {
        const doc = parseRosterGrid([['Бр.', 'Одд.', heading], ['1', 'I', 'Ана Тестова']]);
        assert.deepEqual(doc.rows.map((r) => r.name), ['Ана Тестова'], `heading: ${heading}`);
    }
    // But a column that merely begins with the same letters is not a name.
    const other = parseRosterGrid([['Бр.', 'Одд.', 'Именик'], ['1', 'I', 'Ана Тестова']]);
    assert.equal(other.rows.length, 0);
    assert.match(other.problems[0], /does not name a class column/);
});

test('a line with a class and no name is reported, and the class is named in it', () => {
    const doc = parseRosterGrid([
        HEADER,
        ['1', 'IX-б', ''],
        ['', '', ''],                       // a spacer row is not a problem
        ['2', 'IX-б', 'Ана Тестова']
    ]);
    assert.equal(doc.rows.length, 1);
    assert.equal(doc.problems.length, 1);
    assert.match(doc.problems[0], /row 2: IX-б/);
});

test('a name with no class is reported rather than filed under nothing', () => {
    const doc = parseRosterGrid([HEADER, ['1', '', 'Ана Тестова']]);
    assert.equal(doc.rows.length, 0);
    assert.match(doc.problems[0], /Ана Тестова.*no class/);
});

// ─── the school's own rule ──────────────────────────────────────────────────

test('splitClassLabel separates the grade from the section, and only for real classes', () => {
    assert.deepEqual(splitClassLabel('VI-а'), { grade: 'VI', section: 'а' });
    assert.deepEqual(splitClassLabel('VI'), { grade: 'VI', section: '' });
    assert.deepEqual(splitClassLabel(' vi / А '), { grade: 'VI', section: 'а' });
    assert.equal(splitClassLabel('шесто'), null);
    assert.equal(splitClassLabel(''), null);
});

/**
 * One class in a grade is a bare numeral; two are „-а" and „-б"; three add
 * „-в". So a bare numeral standing BESIDE lettered sections of the same grade
 * is a contradiction — and it is one that must be handed to a person, because
 * folding „IV" into „IV-а" would move a child into a room they are not in and
 * every screen afterwards would look entirely plausible.
 */
test('a bare numeral beside lettered sections of the same grade is a contradiction', () => {
    assert.deepEqual(classShapeProblems(['I-а', 'I-б', 'II', 'III']), []);
    const problems = classShapeProblems(['IV', 'IV-а', 'IV-б']);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /IV appears both on its own and as IV-а and IV-б/);
});

test('sections are named from the beginning of the alphabet', () => {
    assert.deepEqual(classShapeProblems(['V-а', 'V-б', 'V-в']), []);
    const gap = classShapeProblems(['V-а', 'V-в']);
    assert.equal(gap.length, 1);
    assert.match(gap[0], /2 classes are named V-а, V-б/);
});

test('anything that is not a class at all is said out loud', () => {
    assert.match(classShapeProblems(['предучилишна'])[0], /does not look like a class/);
});

// ─── September ──────────────────────────────────────────────────────────────

/**
 * The numeral is arithmetic. The letter is a guess, and it says so.
 *
 * The school forms its classes afresh every September: this year's two fourth
 * classes may be one fifth class or three, and no rule in this file can know
 * which. Carrying the letter over is the best starting point and it must
 * arrive marked as a starting point, or somebody will read a suggestion as a
 * decision the system had already made.
 */
test('promotion is certain about the grade and honest about the section', () => {
    assert.deepEqual(promote('IV'), { label: 'V', outcome: 'promoted', certain: true });
    assert.deepEqual(promote('IV-б'), { label: 'V-б', outcome: 'promoted', certain: false });
    assert.deepEqual(promote('IX-а'), { label: null, outcome: 'graduated', certain: true });
    assert.deepEqual(promote('шесто'), { label: null, outcome: 'unknown', certain: false });
});

test('the last grade is a parameter, because it has not always been the ninth', () => {
    assert.equal(promote('VIII-а', 'VIII').outcome, 'graduated');
    assert.equal(promote('VII-а', 'VIII').label, 'VIII-а');
});

// ─── the other two documents ────────────────────────────────────────────────

const tbl = (rows: string[][], merged: Array<[number, number]> = []) =>
    '<w:tbl>' + rows.map((cells, r) => '<w:tr>' + cells.map((c, i) => {
        const mark = merged.find(([row, col]) => row === r && col === i);
        const vMerge = mark ? '<w:vMerge/>' : (merged.some(([row, col]) => row === r + 1 && col === i)
            ? '<w:vMerge w:val="restart"/>' : '');
        return `<w:tc><w:tcPr>${vMerge}</w:tcPr><w:p><w:r><w:t>${c}</w:t></w:r></w:p></w:tc>`;
    }).join('') + '</w:tr>').join('') + '</w:tbl>';

/**
 * A vertically merged cell is written once and left blank on every row below
 * it. Reading the cells literally leaves most of a class with no class — 65
 * pupils and 17 filled class cells in the school's own table — so this is not
 * a nicety, it is the difference between a table that parses and one that
 * looks half empty.
 */
test('a vertically merged cell is filled from the row above', () => {
    const [grid] = wordTables(tbl([
        ['Одд.', 'Име'],
        ['I-а', 'Ана Тестова'],
        ['', 'Бојан Пробен'],
        ['', 'Влатко Измислен'],
        ['I-б', 'Гордана Никаква']
    ], [[2, 0], [3, 0]]));
    assert.deepEqual(grid.map((r) => r[0]), ['Одд.', 'I-а', 'I-а', 'I-а', 'I-б']);
});

test('a cell that is merely empty is not filled from anywhere', () => {
    const [grid] = wordTables(tbl([['Одд.', 'Име'], ['I-а', 'Ана Тестова'], ['', 'Бојан Пробен']]));
    assert.equal(grid[2][0], '', 'no vMerge means the blank is a blank');
});

test('Word splits one word across runs, and a cell is all of them', () => {
    const [grid] = wordTables(
        '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Ана </w:t></w:r><w:r><w:t>Тест</w:t></w:r>' +
        '<w:r><w:t>ова</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
    );
    assert.equal(grid[0][0], 'Ана Тестова');
});

/**
 * The staff list says who is employed and nothing about what they do — there
 * is no column for наставник / специјален едукатор / помошен кадар. The
 * heading line is reported rather than dropped, because a rule that quietly
 * discards lines is one nobody notices going wrong.
 */
test('the staff list is names, and whatever is not a name is said out loud', () => {
    const list = parseStaffList([
        'ОУРЦ „Тест Училиште" – Место',
        'Ана Тестова',
        'Бојан Пробен Втор',
        '',
        'Влатко Измислен'
    ]);
    assert.deepEqual(list.names, ['Ана Тестова', 'Бојан Пробен Втор', 'Влатко Измислен']);
    assert.deepEqual(list.skipped, ['ОУРЦ „Тест Училиште" – Место']);
});

test('the class and the teaching plan are written into one cell with no separator', () => {
    assert.deepEqual(splitClassAndPlan('1-аНП со ОС'), { classLabel: '1-а', plan: 'НП со ОС' });
    // Longest first, or „НП со ППР" would be read as „НП" plus rubbish.
    assert.deepEqual(splitClassAndPlan('1-бНП со ППР'), { classLabel: '1-б', plan: 'НП со ППР' });
    assert.deepEqual(splitClassAndPlan('1-ва комб. 2 и 3НП со ППР'),
        { classLabel: '1-ва комб. 2 и 3', plan: 'НП со ППР' });
    // No code in it at all is a class with no plan, not a guessed boundary.
    assert.deepEqual(splitClassAndPlan('ПодготвителноОдд.'), { classLabel: 'ПодготвителноОдд.', plan: '' });
});

/**
 * This table writes „4-а" where the pupil list writes „IV-а". The pairing is
 * done here for the report and `normalizeClassLabel` is left alone — it is the
 * one copy every read path depends on, and widening it would change what the
 * whole crossing folds together on the strength of one document.
 */
test('an Arabic class label is paired with the Roman one, and only when it is the same room', () => {
    assert.equal(romanClassLabel('4-а'), 'IV-а');
    assert.equal(romanClassLabel('7'), 'VII');
    assert.equal(romanClassLabel('9-б'), 'IX-б');
    // A combined class is not a class label with a letter, and translating it
    // would invent a room. It comes back null and is reported as itself.
    assert.equal(romanClassLabel('1-ва комб. 2 и 3'), null);
    assert.equal(romanClassLabel('ПодготвителноОдд.'), null);
});

test('the programme table is read section by section, carrying the merged class down', () => {
    const [grid] = wordTables(tbl([
        ['Одделенска настава'],
        ['Р. Бр', 'Име и презиме', 'Попреченост', 'Програма', 'Одд.и НП', 'Одд.наставник/класен'],
        ['1', 'Ана Тестова', 'Тест состојба', 'МНП', '1-аНП со ОС', 'Мери Наставничка'],
        ['2', 'Бојан Пробен', 'Тест состојба', 'МНП', '', ''],
        ['Предметна настава'],
        ['Р. Бр', 'Име и презиме', 'Попреченост', 'Програма', 'Одд.', 'Одд.наставник/класен'],
        ['3', 'Влатко Измислен', 'Тест состојба', 'ПОС', '8-б', 'Иван Наставник']
    ], [[3, 4], [3, 5]]));
    const { rows, problems } = parseProgrammeGrid(grid);
    assert.deepEqual(problems, []);
    assert.deepEqual(rows.map((r) => [r.section, r.name, r.classLabel, r.plan, r.homeroom]), [
        ['Одделенска настава', 'Ана Тестова', '1-а', 'НП со ОС', 'Мери Наставничка'],
        ['Одделенска настава', 'Бојан Пробен', '1-а', 'НП со ОС', 'Мери Наставничка'],
        ['Предметна настава', 'Влатко Измислен', '8-б', '', 'Иван Наставник']
    ]);
});

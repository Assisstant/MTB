/**
 * Tests for the identity logic — the part of this project with the highest
 * cost of being wrong, because it decides whether two records describe the
 * same child.
 *
 * Run: npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    stableStudentIdForName, bareName, norm, isoDate, attendanceStatus,
    reconcile, toSdnRecords, newReport, looksLikeRasporedi, looksLikeDiary, personName
} from '../src/lib/import-core.js';

test('stableStudentIdForName reproduces the ids Rasporedi generates', () => {
    // Fictional names throughout: this repository is public. The values were
    // computed with the same algorithm the app uses. If this breaks,
    // the importer and the app would invent different ids for the same child.
    assert.equal(stableStudentIdForName('IV-б - Ана Анѓеловска'), 'RS-z9msjf-17x5ykh');
    assert.equal(stableStudentIdForName('VII-б - Ана Анѓеловска'), 'RS-6vhfss-dvtdm0');
    // Same name, different grade, must not collide.
    assert.notEqual(
        stableStudentIdForName('IV-б - Ана Анѓеловска'),
        stableStudentIdForName('VII-б - Ана Анѓеловска')
    );
    // Stable across calls and insensitive to surrounding whitespace/case.
    assert.equal(stableStudentIdForName('  IV-б - Ана Анѓеловска  '), 'RS-z9msjf-17x5ykh');
});

test('bareName strips the grade prefix and the category suffix', () => {
    assert.equal(bareName('IV-а - Бојана Бошкоска'), norm('Бојана Бошкоска'));
    assert.equal(bareName('VIII-б - Кирил Кировски'), norm('Кирил Кировски'));
    assert.equal(bareName('Дарко Данилов (над.)'), norm('Дарко Данилов'));
    assert.equal(bareName('Емил Ефтимов (под/над.)'), norm('Емил Ефтимов'));
    // A hyphen inside the grade must not be mistaken for the separator.
    assert.equal(bareName('IV-б - Ана Анѓеловска'), norm('Ана Анѓеловска'));
});

test('isoDate accepts only calendar dates', () => {
    assert.equal(isoDate('2026-05-28'), '2026-05-28');
    assert.equal(isoDate(''), null);
    assert.equal(isoDate('28.05.2026'), null);
    assert.equal(isoDate(null), null);
});

test('attendanceStatus reads both export shapes', () => {
    assert.equal(attendanceStatus('present'), 'present');          // v3 exports
    assert.equal(attendanceStatus({ status: 'absent' }), 'absent'); // older shape
    assert.equal(attendanceStatus(''), null);                       // blank mark
    assert.equal(attendanceStatus({ status: '' }), null);
    assert.equal(attendanceStatus(undefined), null);
});

test('payload shapes are told apart', () => {
    assert.equal(looksLikeRasporedi({ students: ['Избери Ученик', 'I-а - Тест'] }), true);
    assert.equal(looksLikeRasporedi({ students: [{ id: 1, name: 'Тест' }] }), false);
    assert.equal(looksLikeDiary({ attendance: {}, plans: [] }), true);
    assert.equal(looksLikeDiary({ students: ['a'] }), false);
});

// ── reconciliation ───────────────────────────────────────────────────────────

const baseWith = (students: string[], meta: Record<string, any> = {}) => ({
    students: ['Избери Ученик', 'Select Student', ...students],
    studentMeta: meta,
    therapists: [],
    therapistStudents: {}
});

test('the bridge id wins over anything name-based', () => {
    const report = newReport();
    const base = baseWith(['IV-а - Бојана Бошкоска'], {
        'IV-а - Бојана Бошкоска': { studentId: 'RS-known', grade: 'IV-а' }
    });
    const sdn = toSdnRecords([
        { id: 101, name: 'Некој Друг', grade: 'IV-а', rasporediStudentId: 'RS-known' }
    ], report);

    const out = reconcile(base, sdn, report);
    assert.equal(out.length, 1);
    assert.equal(out[0].matchedBy, 'bridge-id');
    assert.equal(out[0].sdnevnikId, 101);
    assert.equal(out[0].idWasGenerated, false);
});

test('placeholders are never treated as students', () => {
    const report = newReport();
    const out = reconcile(baseWith([]), [], report);
    assert.equal(out.length, 0);
});

test('a legacy file without ids gets app-identical generated ids', () => {
    const report = newReport();
    const base = baseWith(['IV-б - Ана Анѓеловска'], { 'IV-б - Ана Анѓеловска': { grade: 'IV-б' } });
    const out = reconcile(base, [], report);
    assert.equal(out[0].idWasGenerated, true);
    assert.equal(out[0].publicId, 'RS-z9msjf-17x5ykh');
});

test('a unique bare name links, and the grade is kept from Rasporedi', () => {
    const report = newReport();
    const base = baseWith(['V-а - Лена Лазарова'], { 'V-а - Лена Лазарова': { studentId: 'RS-x', grade: 'V-а' } });
    const sdn = toSdnRecords([{ id: 55, name: 'Лена Лазарова', grade: 'V-а', rasporediStudentId: '' }], report);

    const out = reconcile(base, sdn, report);
    assert.equal(out[0].matchedBy, 'bare-name');
    assert.equal(out[0].sdnevnikId, 55);
    assert.equal(out[0].grade, 'V-а');
    assert.ok(report.notes.some((n) => n.includes('bare-name')), 'the weaker match is reported for review');
});

test('two students sharing a bare name are disambiguated by grade', () => {
    const report = newReport();
    const base = baseWith(['IV-б - Ана Анѓеловска', 'VII-б - Ана Анѓеловска'], {
        'IV-б - Ана Анѓеловска': { studentId: 'RS-a', grade: 'IV-б' },
        'VII-б - Ана Анѓеловска': { studentId: 'RS-b', grade: 'VII-б' }
    });
    const sdn = toSdnRecords([{ id: 77, name: 'Ана Анѓеловска', grade: 'VII-б', rasporediStudentId: '' }], report);

    const out = reconcile(base, sdn, report);
    const linked = out.filter((s) => s.sdnevnikId != null);
    assert.equal(linked.length, 1, 'exactly one of the two may take the record');
    assert.equal(linked[0].name, 'VII-б - Ана Анѓеловска');
    assert.equal(linked[0].matchedBy, 'name+grade');
});

test('an ambiguous name links to nobody rather than guessing', () => {
    const report = newReport();
    const base = baseWith(['IV-б - Ана Анѓеловска', 'VII-б - Ана Анѓеловска'], {
        'IV-б - Ана Анѓеловска': { studentId: 'RS-a', grade: 'IV-б' },
        'VII-б - Ана Анѓеловска': { studentId: 'RS-b', grade: 'VII-б' }
    });
    // No grade on the diary record: nothing can decide which child this is.
    const sdn = toSdnRecords([{ id: 77, name: 'Ана Анѓеловска', grade: '', rasporediStudentId: '' }], report);

    const out = reconcile(base, sdn, report);
    const namesakesLinked = out.filter((s) => s.matchedBy !== 'sdnevnik-only' && s.sdnevnikId != null);
    assert.equal(namesakesLinked.length, 0, 'neither namesake may claim the record');
    assert.ok(report.problems.some((p) => p.includes('ambiguous')), 'the ambiguity is reported');
    // It is not dropped either — it becomes its own identity, to be merged by a human.
    assert.ok(out.some((s) => s.matchedBy === 'sdnevnik-only'));
});

test('a diary student with no roster counterpart keeps a separate identity', () => {
    const report = newReport();
    const base = baseWith(['VIII-а - Марко Марковски'], {
        'VIII-а - Марко Марковски': { studentId: 'RS-markovski', grade: 'VIII-а' }
    });
    // A different child with a similar first name must NOT be merged.
    const sdn = toSdnRecords([{ id: 900, name: 'Марко Митровски', grade: '', rasporediStudentId: '' }], report);

    const out = reconcile(base, sdn, report);
    assert.equal(out.length, 2);
    const only = out.find((s) => s.matchedBy === 'sdnevnik-only');
    assert.ok(only, 'the unmatched diary student is imported on its own');
    assert.equal(only!.publicId, 'sdn-900');
    assert.equal(out.find((s) => s.name.includes('Марковски'))!.sdnevnikId, null);
});

test('one diary record cannot be claimed by two students', () => {
    const report = newReport();
    const base = baseWith(['I-а - Тест Ученик', 'I-б - Тест Ученик'], {
        'I-а - Тест Ученик': { studentId: 'RS-1', grade: 'I-а' },
        'I-б - Тест Ученик': { studentId: 'RS-2', grade: 'I-а' }   // same grade on purpose
    });
    const sdn = toSdnRecords([{ id: 42, name: 'Тест Ученик', grade: 'I-а', rasporediStudentId: '' }], report);

    const out = reconcile(base, sdn, report);
    assert.ok(out.filter((s) => s.sdnevnikId === 42).length <= 1);
});

/**
 * One spelling per person.
 *
 * The workbook types the staff in capitals and `Podatoci.html` title-cases on
 * save, so without a single rule the same teacher is stored one way or the
 * other depending on which screen last touched them — and, because the unique
 * key on `teachers.name` is the exact string, eventually stored TWICE.
 *
 * The browser has its own copy of this function (a single-file app cannot
 * import from the server, rule 4). These cases are what the two must agree on.
 */
test('personName lifts a shouted name and leaves every other one alone', () => {
    assert.equal(personName('АНА ТЕСТОВА'), 'Ана Тестова');
    assert.equal(personName('ГОРДАНА ЃУРКОВА'), 'Гордана Ѓуркова');
    // An initial keeps its full stop, and the letter after it stays a capital.
    assert.equal(personName('БИЛЈАНА П. ТЕСТОВСКА'), 'Билјана П. Тестовска');
    // A hyphen starts a new word; a double-barrelled surname is not one word.
    assert.equal(personName('АНА ПЕТРОВА-ЈОВАНОВА'), 'Ана Петрова-Јованова');

    // Anything a person has already written wins, whatever it looks like.
    assert.equal(personName('Ана Тестова'), 'Ана Тестова');
    assert.equal(personName('Ѓорѓи МОЈСОВ'), 'Ѓорѓи МОЈСОВ');
    assert.equal(personName('van der Berg'), 'van der Berg');

    // Whitespace is tidied, because two spaces are never meant.
    assert.equal(personName('  АНА   ТЕСТОВА '), 'Ана Тестова');
    // And nothing is invented out of nothing.
    assert.equal(personName(''), '');
    assert.equal(personName(null), '');
    assert.equal(personName('   '), '');
});

test('personName is idempotent — running it twice cannot drift', () => {
    for (const name of ['АНА ТЕСТОВА', 'Ана Тестова', 'БИЛЈАНА П. ТЕСТОВСКА', 'Ѓорѓи МОЈСОВ']) {
        assert.equal(personName(personName(name)), personName(name));
    }
});

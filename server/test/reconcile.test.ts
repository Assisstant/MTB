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
    reconcile, toSdnRecords, newReport, looksLikeRasporedi, looksLikeDiary
} from '../src/lib/import-core.js';

test('stableStudentIdForName reproduces the ids Rasporedi generates', () => {
    // Verified against the app's own function in the browser. If this breaks,
    // the importer and the app would invent different ids for the same child.
    assert.equal(stableStudentIdForName('IV-б - Јана Петровска'), 'RS-gglb1n-1tndav5');
    assert.equal(stableStudentIdForName('VII-б - Јана Петровска'), 'RS-1s3agk-1cpbyp4');
    // Same name, different grade, must not collide.
    assert.notEqual(
        stableStudentIdForName('IV-б - Јана Петровска'),
        stableStudentIdForName('VII-б - Јана Петровска')
    );
    // Stable across calls and insensitive to surrounding whitespace/case.
    assert.equal(stableStudentIdForName('  IV-б - Јана Петровска  '), 'RS-gglb1n-1tndav5');
});

test('bareName strips the grade prefix and the category suffix', () => {
    assert.equal(bareName('IV-а - Мирем Османова'), norm('Мирем Османова'));
    assert.equal(bareName('VIII-б - Кристијан Тодороски'), norm('Кристијан Тодороски'));
    assert.equal(bareName('Сарди Муареми (над.)'), norm('Сарди Муареми'));
    assert.equal(bareName('Енес Алиу (под/над.)'), norm('Енес Алиу'));
    // A hyphen inside the grade must not be mistaken for the separator.
    assert.equal(bareName('IV-б - Јана Петровска'), norm('Јана Петровска'));
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
    const base = baseWith(['IV-а - Мирем Османова'], {
        'IV-а - Мирем Османова': { studentId: 'RS-known', grade: 'IV-а' }
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
    const base = baseWith(['IV-б - Јана Петровска'], { 'IV-б - Јана Петровска': { grade: 'IV-б' } });
    const out = reconcile(base, [], report);
    assert.equal(out[0].idWasGenerated, true);
    assert.equal(out[0].publicId, 'RS-gglb1n-1tndav5');
});

test('a unique bare name links, and the grade is kept from Rasporedi', () => {
    const report = newReport();
    const base = baseWith(['V-а - Леарта Зулами'], { 'V-а - Леарта Зулами': { studentId: 'RS-x', grade: 'V-а' } });
    const sdn = toSdnRecords([{ id: 55, name: 'Леарта Зулами', grade: 'V-а', rasporediStudentId: '' }], report);

    const out = reconcile(base, sdn, report);
    assert.equal(out[0].matchedBy, 'bare-name');
    assert.equal(out[0].sdnevnikId, 55);
    assert.equal(out[0].grade, 'V-а');
    assert.ok(report.notes.some((n) => n.includes('bare-name')), 'the weaker match is reported for review');
});

test('two students sharing a bare name are disambiguated by grade', () => {
    const report = newReport();
    const base = baseWith(['IV-б - Јана Петровска', 'VII-б - Јана Петровска'], {
        'IV-б - Јана Петровска': { studentId: 'RS-a', grade: 'IV-б' },
        'VII-б - Јана Петровска': { studentId: 'RS-b', grade: 'VII-б' }
    });
    const sdn = toSdnRecords([{ id: 77, name: 'Јана Петровска', grade: 'VII-б', rasporediStudentId: '' }], report);

    const out = reconcile(base, sdn, report);
    const linked = out.filter((s) => s.sdnevnikId != null);
    assert.equal(linked.length, 1, 'exactly one of the two may take the record');
    assert.equal(linked[0].name, 'VII-б - Јана Петровска');
    assert.equal(linked[0].matchedBy, 'name+grade');
});

test('an ambiguous name links to nobody rather than guessing', () => {
    const report = newReport();
    const base = baseWith(['IV-б - Јана Петровска', 'VII-б - Јана Петровска'], {
        'IV-б - Јана Петровска': { studentId: 'RS-a', grade: 'IV-б' },
        'VII-б - Јана Петровска': { studentId: 'RS-b', grade: 'VII-б' }
    });
    // No grade on the diary record: nothing can decide which child this is.
    const sdn = toSdnRecords([{ id: 77, name: 'Јана Петровска', grade: '', rasporediStudentId: '' }], report);

    const out = reconcile(base, sdn, report);
    const namesakesLinked = out.filter((s) => s.matchedBy !== 'sdnevnik-only' && s.sdnevnikId != null);
    assert.equal(namesakesLinked.length, 0, 'neither namesake may claim the record');
    assert.ok(report.problems.some((p) => p.includes('ambiguous')), 'the ambiguity is reported');
    // It is not dropped either — it becomes its own identity, to be merged by a human.
    assert.ok(out.some((s) => s.matchedBy === 'sdnevnik-only'));
});

test('a diary student with no roster counterpart keeps a separate identity', () => {
    const report = newReport();
    const base = baseWith(['VIII-а - Сејхан Неџипов'], {
        'VIII-а - Сејхан Неџипов': { studentId: 'RS-nedzipov', grade: 'VIII-а' }
    });
    // A different child with a similar first name must NOT be merged.
    const sdn = toSdnRecords([{ id: 900, name: 'Сејхан Демиров', grade: '', rasporediStudentId: '' }], report);

    const out = reconcile(base, sdn, report);
    assert.equal(out.length, 2);
    const only = out.find((s) => s.matchedBy === 'sdnevnik-only');
    assert.ok(only, 'the unmatched diary student is imported on its own');
    assert.equal(only!.publicId, 'sdn-900');
    assert.equal(out.find((s) => s.name.includes('Неџипов'))!.sdnevnikId, null);
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

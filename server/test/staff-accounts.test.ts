/**
 * The username is the person's own name, typed in either script
 * (docs/PLAN-kolegi-online.md). Pure, no database: every name is invented.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    cyrillicKey, isInitialPassword, latinKey, looseKey, resolveUsername, usernamesOf, type Staff
} from '../src/lib/staff-accounts.js';

const staff: Staff[] = [
    { employeeId: 1, name: 'Ана Измислена', teacherId: 1, therapistId: null },
    { employeeId: 2, name: 'Јован Чешмеџиски', teacherId: 2, therapistId: null },
    { employeeId: 3, name: 'Ѓорѓи Љубенков', teacherId: null, therapistId: 3 },
    { employeeId: 4, name: 'Марија Измислена', teacherId: 4, therapistId: null },
    { employeeId: 5, name: 'Марија Измислена', teacherId: null, therapistId: 5 },
    // Written in capitals, as a workbook import leaves a name.
    { employeeId: 6, name: 'ПЕТАР ПРОБЕН', teacherId: 6, therapistId: null }
];
const who = (username: string) => {
    const r = resolveUsername(staff, username);
    return r.ok ? r.staff.employeeId : r.reason;
};

test('the name, joined, in either script', () => {
    assert.equal(cyrillicKey('Ана Измислена'), 'анаизмислена');
    assert.equal(latinKey('Ана Измислена'), 'anaizmislena');
    assert.equal(who('AnaIzmislena'), 1);
    assert.equal(who('АнаИзмислена'), 1);
    assert.equal(who('anaizmislena'), 1);
    assert.equal(who('ana izmislena'), 1, 'a space typed in the middle does not matter');
    assert.equal(who('IzmislenaAna'), 1, 'nor the surname first');
    assert.equal(who('PetarProben'), 6, 'a name stored in capitals');
});

test('the letters Latin has no single letter for', () => {
    assert.equal(latinKey('Јован Чешмеџиски'), 'jovancheshmedzhiski');
    assert.equal(who('JovanCheshmedzhiski'), 2);
    assert.equal(who('JovanČešmedžiski'), 2, 'with the marks a phone keyboard offers');
    assert.equal(who('JovanCesmedziski'), 2, 'and without the digraphs, when only one person fits');
    assert.equal(who('GjorgjiLjubenkov'), 3);
    assert.equal(who('ЃорѓиЉубенков'), 3);
    assert.equal(who('GorgiLubenkov'), 3);
    assert.equal(looseKey('Ѓорѓи'), looseKey('Gorgi'));
});

test('never a guess between two people (rule 2), and nobody for a stranger', () => {
    assert.equal(who('MarijaIzmislena'), 'ambiguous');
    assert.equal(who('МаријаИзмислена'), 'ambiguous');
    assert.equal(who('Nepoznat Covek'), 'unknown');
    assert.equal(who(''), 'unknown');
    assert.equal(who('Ana'), 'unknown', 'a first name alone is not a username');
});

test('the initial password, in either script and any case', () => {
    for (const ok of ['ResursenCentar', 'resursencentar', 'RESURSENCENTAR', 'РесурсенЦентар', 'ресурсен центар']) {
        assert.equal(isInitialPassword(ok), true, ok);
    }
    for (const no of ['Resursen', 'ResursenCentar1', '', 'Центар']) assert.equal(isInitialPassword(no), false, no);
});

test('the username to hand out', () => {
    assert.deepEqual(usernamesOf('Ана Измислена'), { latin: 'AnaIzmislena', cyrillic: 'АнаИзмислена' });
    assert.deepEqual(usernamesOf('ПЕТАР ПРОБЕН'), { latin: 'PetarProben', cyrillic: 'ПетарПробен' });
    assert.deepEqual(usernamesOf('Јован Чешмеџиски'), { latin: 'JovanCheshmedzhiski', cyrillic: 'ЈованЧешмеџиски' });
});

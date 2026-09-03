import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveServerIdentity } from '../src/lib/server-identity.js';

test('a duplicated ZenPC hostname does not choose work or home', () => {
    assert.deepEqual(resolveServerIdentity({}, 'ZENPC'), {
        id: 'zenpc',
        role: 'other',
        place: 'СЕРВЕР',
        machine: 'ZENPC',
        label: 'СЕРВЕР · ZenPC',
        warning: 'server role is not configured; set SYNC_NAME=work or SYNC_NAME=home'
    });
});

test('the local setting identifies home even when its hostname is also ZenPC', () => {
    const identity = resolveServerIdentity({ SYNC_NAME: 'home' }, 'ZenPC');
    assert.equal(identity.id, 'home');
    assert.equal(identity.role, 'home');
    assert.equal(identity.label, 'ДОМА · ZenPC');
    assert.equal(identity.warning, undefined);
});

test('an explicit manual-sync identity survives an unfamiliar hostname', () => {
    const identity = resolveServerIdentity({ MANUAL_SYNC_NAME: 'home' }, 'THERAPY-LAPTOP');
    assert.equal(identity.id, 'home');
    assert.equal(identity.role, 'home');
    assert.equal(identity.machine, 'THERAPY-LAPTOP');
    assert.equal(identity.label, 'ДОМА · THERAPY-LAPTOP');
});

test('work and home stay distinct even when both machines have the same hostname', () => {
    const work = resolveServerIdentity({ SYNC_NAME: 'work' }, 'ZenPC');
    const home = resolveServerIdentity({ SYNC_NAME: 'home' }, 'ZenPC');
    assert.equal(work.label, 'РАБОТА · ZenPC');
    assert.equal(home.label, 'ДОМА · ZenPC');
    assert.notEqual(work.id, home.id);
});

test('a custom server id cannot override the configured work/home role', () => {
    const identity = resolveServerIdentity({
        MTB_SERVER_ID: 'zenpc',
        SYNC_NAME: 'home'
    }, 'ZenPC');
    assert.equal(identity.id, 'zenpc');
    assert.equal(identity.role, 'home');
    assert.equal(identity.label, 'ДОМА · ZenPC');
});

test('an unknown installation remains distinct and can have a custom label', () => {
    assert.deepEqual(resolveServerIdentity({
        MTB_SERVER_ID: 'test-room',
        MTB_SERVER_LABEL: 'ТЕСТ · Кабинет'
    }, 'CI-HOST'), {
        id: 'test-room',
        role: 'other',
        place: 'СЕРВЕР',
        machine: 'CI-HOST',
        label: 'ТЕСТ · Кабинет'
    });
});

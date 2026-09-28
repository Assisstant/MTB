import test from 'node:test';
import assert from 'node:assert/strict';
import {
    acceptDutyAdminLink, createDutyAdminLink,
    dutyAdminLinks, revokeDutyAdminLinks
} from '../src/lib/duty-delegation.js';

test('a duty capability is random, listed without its token, and revocable', () => {
    revokeDutyAdminLinks();
    const made = createDutyAdminLink(2);

    assert.match(made.token, /^[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(acceptDutyAdminLink(made.token), {
        id: made.id, createdAt: made.createdAt, expiresAt: made.expiresAt
    });
    assert.equal(JSON.stringify(dutyAdminLinks()).includes(made.token), false);
    assert.equal(acceptDutyAdminLink('not-a-token'), null);
    assert.equal(revokeDutyAdminLinks(), 1);
    assert.equal(acceptDutyAdminLink(made.token), null);
    revokeDutyAdminLinks();
});

test('a capability expires at its deadline and disappears from the owner list', (t) => {
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    const made = createDutyAdminLink(2);
    now += 2 * 60 * 60 * 1000 - 1;
    assert.ok(acceptDutyAdminLink(made.token));
    now += 1;
    assert.equal(acceptDutyAdminLink(made.token), null);
    assert.deepEqual(dutyAdminLinks(), []);
});

/** Which migrations wait (lib/update-status.ts) — the popup's first question. Pure. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pendingOf } from '../src/lib/update-status.js';

test('a migration file the ledger does not have is pending; nothing else is', () => {
    const files = ['046_credit_look.sql', '047_bookmarks.sql', 'README.md', '045_class_alias.sql', 'notes.txt'];
    assert.deepEqual(pendingOf(files, new Set(['045_class_alias.sql', '046_credit_look.sql'])), ['047_bookmarks.sql']);
    assert.deepEqual(pendingOf(files, new Set(['045_class_alias.sql', '046_credit_look.sql', '047_bookmarks.sql'])), []);
});

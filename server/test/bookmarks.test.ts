/**
 * The administrator's bookmarks (047): the shape a browser may store — the
 * same as BookmarksPlus exports, so its export is also an import. Pure.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBookmarks } from '../src/lib/bookmarks.js';

const card = (over: Record<string, unknown> = {}) => ({
    id: 'c1', boardId: 'b1', columnId: 'k1', url: 'https://example.org/', title: 'Пример', tags: ['x'],
    notes: '', pinned: false, order: 1, createdAt: 1, updatedAt: 1, ...over
});
const doc = (cards: unknown[] = [card()]) => ({
    boards: [{ id: 'b1', name: 'Табла', order: 1 }],
    columnsByBoard: { b1: [{ id: 'k1', name: 'Колона', order: 1 }] },
    cards
});

test('a BookmarksPlus export is a valid document, and extra keys are dropped', () => {
    const exported = { ...doc([card({ kind: 'link', fileId: null })]), ui: { activeBoardId: 'b1' } };
    const kept = normalizeBookmarks(exported)!;
    assert.ok(kept, 'accepted');
    assert.equal('ui' in kept, false, 'the browser\'s own view state is not stored');
    assert.equal('fileId' in kept.cards[0], false);
});

test('a document that disagrees with itself is refused', () => {
    assert.equal(normalizeBookmarks(doc([card({ columnId: 'nowhere' })])), null, 'a card in no column');
    assert.equal(normalizeBookmarks({ ...doc(), columnsByBoard: { ghost: [] } }), null, 'columns of no board');
});

test('only http(s) links, bounded text, short ids', () => {
    assert.equal(normalizeBookmarks(doc([card({ url: 'javascript:alert(1)' })])), null);
    assert.equal(normalizeBookmarks(doc([card({ url: '' })]))!.cards.length, 1, 'a card may have no link');
    assert.equal(normalizeBookmarks(doc([card({ title: 'x'.repeat(301) })])), null);
    assert.equal(normalizeBookmarks(doc([card({ id: 'a b' })])), null);
    assert.equal(normalizeBookmarks(null), null);
});

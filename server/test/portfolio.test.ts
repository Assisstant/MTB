/**
 * The owner's evidence for the title of mentor (059): the shape a browser may
 * store. Evidence exists once; a link ties it to an indicator. Pure.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePortfolio } from '../src/lib/portfolio.js';

const file = (over: Record<string, unknown> = {}) => ({ id: 'p1', kind: 'file', path: 'slika.png', url: '', label: 'Слика', note: '', ...over });
const item = (over: Record<string, unknown> = {}) => ({
    id: 'e1', no: 1, title: 'Измислен доказ', summary: '', parts: [file()], order: 1, createdAt: 1, updatedAt: 1, ...over
});
const link = (over: Record<string, unknown> = {}) => ({ id: 'l1', itemId: 'e1', indicator: '1.1.1', why: 'Затоа.', parts: [], ...over });
const doc = (over: Record<string, unknown> = {}) => ({ title: 'Табела со докази', subtitle: '', items: [item()], links: [link()], ...over });

test('a well-formed document is kept, and keys it does not know are dropped', () => {
    const kept = normalizePortfolio({ ...doc(), look: { view: 'list' } })!;
    assert.ok(kept, 'accepted');
    assert.equal('look' in kept, false, 'the browser\'s own view state is not stored');
    assert.equal(kept.links[0].indicator, '1.1.1');
});

test('one piece of evidence may stand under many indicators, but once under each', () => {
    assert.ok(normalizePortfolio(doc({ links: [link(), link({ id: 'l2', indicator: '7.2.7' })] })), 'two indicators');
    assert.equal(normalizePortfolio(doc({ links: [link(), link({ id: 'l2' })] })), null, 'the same indicator twice');
    assert.equal(normalizePortfolio(doc({ links: [link(), link({ indicator: '2.1.1' })] })), null, 'two links under one id');
});

test('a document that disagrees with itself is refused', () => {
    assert.equal(normalizePortfolio(doc({ links: [link({ itemId: 'nowhere' })] })), null, 'a link to no evidence');
    assert.equal(normalizePortfolio(doc({ links: [link({ parts: ['ghost'] })] })), null, 'a part the evidence does not have');
    assert.ok(normalizePortfolio(doc({ links: [link({ parts: ['p1'] })] })), 'a part it does have');
    assert.equal(normalizePortfolio(doc({ items: [item(), item()] })), null, 'two items under one id');
    assert.equal(normalizePortfolio(doc({ items: [item({ parts: [file(), file()] })] })), null, 'two parts under one id');
});

test('an indicator is area.section.row, and nothing else', () => {
    for (const bad of ['1.1', '1.1.1.1', '0.1.1', 'a.b.c', '1.1.1 ', '']) {
        assert.equal(normalizePortfolio(doc({ links: [link({ indicator: bad })] })), null, JSON.stringify(bad));
    }
});

test('a file is a path inside the folder; a link is http(s)', () => {
    const withPart = (part: unknown) => normalizePortfolio(doc({ items: [item({ parts: [part] })] }));
    assert.ok(withPart(file({ path: 'podpapka/Извештај (1).pdf' })), 'a file one folder down, with a Cyrillic name');
    for (const bad of ['../tajno.txt', 'a/../b', '/etc/passwd', 'C:/Users/x.png', 'a\\b.png', 'a//b', '']) {
        assert.equal(withPart(file({ path: bad })), null, JSON.stringify(bad));
    }
    assert.ok(withPart(file({ kind: 'link', path: '', url: 'https://example.org/' })), 'a link');
    assert.equal(withPart(file({ kind: 'link', path: '', url: 'javascript:alert(1)' })), null);
    assert.equal(withPart(file({ kind: 'link', path: '', url: '' })), null, 'a link with no address');
    assert.equal(withPart(file({ url: 'https://example.org/' })), null, 'a file that is also a link');
});

test('bounded text, short ids, a number from 1', () => {
    assert.equal(normalizePortfolio(doc({ items: [item({ title: 'x'.repeat(501) })] })), null);
    assert.equal(normalizePortfolio(doc({ items: [item({ id: 'a b' })] })), null);
    assert.equal(normalizePortfolio(doc({ items: [item({ no: 0 })] })), null);
    assert.equal(normalizePortfolio(doc({ items: [item({ no: 1.5 })] })), null);
    assert.ok(normalizePortfolio(doc({ items: [], links: [] })), 'no evidence yet is still a document');
    assert.equal(normalizePortfolio(null), null);
});

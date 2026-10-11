import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { checkAgentDocs } from '../scripts/check-agent-docs.mjs';

const root = resolve(import.meta.dirname, '../..');
function check(overrides: Record<string, string> = {}) {
    return checkAgentDocs((file: string) => {
        const key = relative(root, resolve(root, file)).replaceAll('\\', '/');
        return overrides[key] ?? readFileSync(resolve(root, file), 'utf8').replaceAll('\r\n', '\n');
    }, existsSync);
}
const read = (file: string) => readFileSync(resolve(root, file), 'utf8').replaceAll('\r\n', '\n');

test('the shared instruction routes and size budgets are valid from any working directory', () => {
    assert.deepEqual(check(), []);
});
test('a missing Claude import or an added inline archive import is refused', () => {
    assert.ok(check({ 'CLAUDE.md': '# Duplicate instructions\n' }).some(e => e.includes('must import')));
    assert.ok(check({ 'CLAUDE.md': read('CLAUDE.md') + '\nAlso load @docs/SOSTOJBA-archive.md\n' }).some(e => e.includes('must import')));
});
test('entry point growth is refused by UTF-8 bytes rather than character count', () => {
    assert.ok(check({ 'AGENTS.md': read('AGENTS.md') + 'Ж'.repeat(13000) }).some(e => e.includes('budget')));
});
test('losing a trap route or its target anchor is refused', () => {
    assert.ok(check({ 'AGENTS.md': read('AGENTS.md').replace(/^.*docs\/TRAPS\.md#trap-01.*\n/m, '') }).some(e => e.includes('trap route')));
    assert.ok(check({ 'docs/TRAPS.md': read('docs/TRAPS.md').replace('<a id="trap-01"></a>', '') }).some(e => e.includes('anchor')));
});
test('a broken documentation route cannot pass the guard', () => {
    assert.ok(check({ 'AGENTS.md': read('AGENTS.md') + '\n[Missing](docs/not-a-real-reference.md)\n' }).some(e => e.includes('missing linked file')));
});

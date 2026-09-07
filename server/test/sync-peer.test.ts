import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const server = fileURLToPath(new URL('../', import.meta.url));
const wrapper = fileURLToPath(new URL('../../scripts/sync-peer.ps1', import.meta.url));
const require = createRequire(import.meta.url);
const payload = (marker: string) => ({ marker, content: 'invented fixture '.repeat(30) });
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 12);
const state = (marker: string, updated_at = '2026-09-07T10:00:00Z') => ({
    app: 'unified', version: 1, payload: payload(marker), updated_at, updated_by: null
});

type Scenario = {
    states?: Record<string, ReturnType<typeof state> | number | 'network-error'>;
    watermarks?: Record<string, string>;
    queryFailure?: boolean;
    putStatus?: number;
    projectionOk?: boolean;
};

// Execute the real CLI and its exit path. The child cannot reach any API or
// database: fetch is replaced, Pool.connect throws, and only the two expected
// watermark queries have fake answers. The local .env is never loaded.
const preload = `
import pg from ${JSON.stringify(pathToFileURL(require.resolve('pg')).href)};
const scenario = JSON.parse(process.env.MTB_SYNC_TEST_SCENARIO);
const trace = { puts: [], watermarkWrites: [] };
pg.Pool.prototype.connect = function () { throw new Error('A real DB connection is forbidden in this test'); };
pg.Pool.prototype.query = async function (sql, values) {
    if (scenario.queryFailure) throw new Error('test watermark database unavailable');
    if (sql.startsWith('SELECT payload_hash FROM sync_watermark')) {
        const value = scenario.watermarks?.[values[0]];
        return { rows: value ? [{ payload_hash: value }] : [] };
    }
    if (sql.includes('INSERT INTO sync_watermark')) {
        trace.watermarkWrites.push(values);
        return { rows: [] };
    }
    throw new Error('Unexpected SQL in sync test');
};
pg.Pool.prototype.end = async function () {};
globalThis.fetch = async function (input, init) {
    const url = new URL(String(input));
    if (url.pathname === '/api/health') return Response.json({ instance: url.hostname });
    if (!url.pathname.startsWith('/api/state/')) throw new Error('Unexpected test request');
    const app = url.pathname.slice('/api/state/'.length);
    if (init?.method === 'PUT') {
        trace.puts.push({ host: url.hostname, app });
        return Response.json({ version: 2, projection: { ok: scenario.projectionOk !== false } },
            { status: scenario.putStatus ?? 200 });
    }
    const value = scenario.states?.[url.hostname + '/' + app];
    if (value === 'network-error') throw new TypeError('fetch failed');
    if (typeof value === 'number') return Response.json({}, { status: value });
    return value ? Response.json(value) : Response.json({}, { status: 404 });
};
process.on('exit', () => console.log('SYNC_TEST_TRACE ' + JSON.stringify(trace)));
`;

function run(scenario: Scenario, options: { mailbox?: Record<string, string>; apply?: boolean; apps?: string; force?: boolean } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'mtb-sync-test-'));
    try {
        const args = ['--local', 'http://local.invalid', '--apps', options.apps ?? 'unified'];
        if (options.mailbox) {
            const mailbox = join(dir, 'mailbox');
            mkdirSync(join(mailbox, 'peer'), { recursive: true });
            for (const [app, content] of Object.entries(options.mailbox)) {
                writeFileSync(join(mailbox, 'peer', `${app}.json`), content);
            }
            args.push('--dir', mailbox, '--me', 'local', '--peer-name', 'peer');
        } else args.push('--peer', 'http://peer.invalid');
        if (options.apply) args.push('--apply');
        if (options.force) args.push('--force');
        const env: NodeJS.ProcessEnv = { ...process.env, DOTENV_CONFIG_PATH: join(dir, 'no-env'), MTB_SYNC_TEST_SCENARIO: JSON.stringify(scenario) };
        for (const key of ['DATABASE_URL', 'MTB_SERVICE_KEY', 'SYNC_DIR', 'SYNC_NAME', 'SYNC_PEER_NAME', 'PEER_URL']) delete env[key];
        const result = spawnSync(process.execPath, [
            '--import', 'tsx', '--import', `data:text/javascript,${encodeURIComponent(preload)}`,
            'scripts/sync-peer.ts', ...args
        ], { cwd: server, env, encoding: 'utf8', timeout: 15_000 });
        assert.ifError(result.error);
        const output = result.stdout + result.stderr;
        const traceMatch = output.match(/^SYNC_TEST_TRACE (.+)$/m);
        assert.ok(traceMatch, output);
        return { code: result.status, output, trace: JSON.parse(traceMatch[1]) as { puts: unknown[]; watermarkWrites: unknown[] } };
    } finally {
        // dir is the exact directory returned by mkdtemp, never a user path.
        rmSync(dir, { recursive: true, force: true });
    }
}

function assertFailure(result: ReturnType<typeof run>) {
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /FAILED:/);
    assert.doesNotMatch(result.output, /REFUSED:|--force|Nothing would change|Rerun with --apply/);
}

test('a failed fetch is operational failure in direct and mailbox modes, even with force', () => {
    for (const mailbox of [undefined, {}]) {
        const result = run({ states: { 'local.invalid/unified': 'network-error' } }, { mailbox, force: true, apply: true });
        assertFailure(result);
        assert.match(result.output, /0 refused, 1 failed/);
        assert.deepEqual(result.trace, { puts: [], watermarkWrites: [] });
    }
});

test('an unreachable peer and an HTTP server error do not become divergence', () => {
    for (const peer of ['network-error', 503] as const) {
        const result = run({ states: { 'local.invalid/unified': state('local'), 'peer.invalid/unified': peer } });
        assertFailure(result);
        assert.deepEqual(result.trace, { puts: [], watermarkWrites: [] });
    }
});

test('a failed watermark read is operational failure, not a comparison result', () => {
    const result = run({ states: { 'local.invalid/unified': state('same'), 'peer.invalid/unified': state('same') }, queryFailure: true });
    assertFailure(result);
    assert.match(result.output, /watermark database unavailable/);
});

test('unreadable or incomplete mailbox files fail without writes or a false no-state plan', () => {
    for (const content of ['{', '{}', JSON.stringify({ ...state('peer'), hash: 'wrong' })]) {
        const result = run({ states: { 'local.invalid/unified': state('local') } }, { mailbox: { unified: content }, apply: true });
        assertFailure(result);
        assert.doesNotMatch(result.output, /has no state yet|left in the mailbox/);
        assert.deepEqual(result.trace, { puts: [], watermarkWrites: [] });
    }
});

test('a missing mailbox file after an agreement fails, while first publication can be planned', () => {
    const states = { 'local.invalid/unified': state('local') };
    const missing = run({ states, watermarks: { unified: hash(payload('old')) } }, { mailbox: {} });
    assertFailure(missing);
    assert.match(missing.output, /missing after a previous sync/);
    const initial = run({ states }, { mailbox: {} });
    assert.equal(initial.code, 0, initial.output);
    assert.match(initial.output, /1 would sync, 0 already in sync, 0 refused, 0 failed/);
    assert.deepEqual(initial.trace, { puts: [], watermarkWrites: [] });
});

test('real divergence remains a safety refusal and does not write', () => {
    const result = run({
        states: { 'local.invalid/unified': state('local'), 'peer.invalid/unified': state('peer') },
        watermarks: { unified: hash(payload('agreed')) }
    }, { apply: true });
    assert.equal(result.code, 2, result.output);
    assert.match(result.output, /BOTH machines changed/);
    assert.match(result.output, /1 refused, 0 failed/);
    assert.deepEqual(result.trace, { puts: [], watermarkWrites: [] });
});

test('mixed divergence and a failed fetch exit as failure with separate counts', () => {
    const result = run({
        states: { 'local.invalid/unified': state('local'), 'peer.invalid/unified': state('peer'), 'local.invalid/sdnevnik': 'network-error' },
        watermarks: { unified: hash(payload('agreed')) }
    }, { apps: 'unified,sdnevnik' });
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /1 refused, 1 failed/);
    assert.deepEqual(result.trace, { puts: [], watermarkWrites: [] });
});

test('a write conflict or unconfirmed projection fails without recording agreement', () => {
    for (const failure of [{ putStatus: 409 }, { projectionOk: false }]) {
        const result = run({
            states: { 'local.invalid/unified': state('local'), 'peer.invalid/unified': state('peer', '2026-09-06T10:00:00Z') },
            watermarks: { unified: hash(payload('peer')) }, ...failure
        }, { apply: true });
        assertFailure(result);
        assert.equal(result.trace.puts.length, 1);
        assert.equal(result.trace.watermarkWrites.length, 0);
    }
});

test('a successful app followed by failure reports the partial success accurately', () => {
    const result = run({
        states: { 'local.invalid/unified': state('local'), 'peer.invalid/unified': state('peer'), 'local.invalid/sdnevnik': 'network-error' },
        watermarks: { unified: hash(payload('peer')) }
    }, { apply: true, apps: 'unified,sdnevnik' });
    assertFailure(result);
    assert.match(result.output, /1 synced, 0 already in sync, 0 refused, 1 failed/);
    assert.equal(result.trace.puts.length, 1);
    assert.equal(result.trace.watermarkWrites.length, 1);
});

test('Windows PowerShell wrapper parses with its BOM and never adds generic Force advice', { skip: process.platform !== 'win32' }, () => {
    assert.deepEqual([...readFileSync(wrapper).subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    const quoted = "'" + wrapper.replaceAll("'", "''") + "'";
    const parsed = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `$tokens = $null; $errors = $null; [System.Management.Automation.Language.Parser]::ParseFile(${quoted}, [ref]$tokens, [ref]$errors) | Out-Null; if ($errors.Count) { $errors | Out-String | Write-Output; exit 1 }`
    ], { encoding: 'utf8', timeout: 15_000 });
    assert.ifError(parsed.error);
    assert.equal(parsed.status, 0, parsed.stdout + parsed.stderr);
    for (const code of [1, 2]) {
        // Function resolution intercepts npm before the real command can run.
        const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
            `function npm { $global:LASTEXITCODE = ${code}; Write-Output 'synthetic per-app report' }; & ${quoted} -Quiet; exit $LASTEXITCODE`
        ], { cwd: server, encoding: 'utf8', timeout: 15_000 });
        assert.ifError(result.error);
        assert.equal(result.status, code, result.stdout + result.stderr);
        assert.doesNotMatch(result.stdout, /have diverged|nothing was changed|rerun with -Force/i);
        assert.match(result.stdout, code === 1 ? /Sync could not complete/ : /refused by a safety check/);
    }
});

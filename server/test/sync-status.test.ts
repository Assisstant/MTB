import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
    latestBackup, migrationGap, readCurrentManifest, syncNames, transportDirs, transportStatus
} from '../src/lib/sync-status.js';

async function scratch(): Promise<string> {
    return mkdtemp(path.join(tmpdir(), 'mtb-sync-status-'));
}

async function writeManifest(dir: string, machine: string, value: unknown, bom = false) {
    const folder = path.join(dir, 'manual-db-sync', machine);
    await mkdir(folder, { recursive: true });
    const text = (bom ? '\uFEFF' : '') + (typeof value === 'string' ? value : JSON.stringify(value));
    await writeFile(path.join(folder, 'current.json'), text, 'utf8');
}

const manifest = (machine: string, extra: Record<string, unknown> = {}) => ({
    format: 'mtb-manual-db-sync-v1',
    snapshotId: `${machine}-2026-09-22-18-00-00-abcdef12`,
    machine,
    createdAt: '2026-09-22T16:00:00.000Z',
    database: 'therapy_dev',
    dumpBytes: 12345,
    tables: [{ table: 'students' }, { table: 'attendance' }],
    schemaMigrations: ['002_b.sql', '001_a.sql'],
    gitCommit: '0de2730dcbf95ac945bb2d239f597755cccbae3c\n',
    ...extra
});

test('the machine names are read in the same order as the sync scripts read them', () => {
    assert.deepEqual(syncNames({ SYNC_NAME: 'work' }), { me: 'work', peer: 'home' });
    assert.deepEqual(syncNames({ SYNC_NAME: 'home' }), { me: 'home', peer: 'work' });
    assert.deepEqual(syncNames({ MANUAL_SYNC_NAME: 'home', SYNC_NAME: 'work' }), { me: 'home', peer: 'work' });
    assert.deepEqual(syncNames({ SYNC_NAME: 'lab', MANUAL_SYNC_PEER: 'work' }), { me: 'lab', peer: 'work' });
    // An installation that is neither side has no partner to guess.
    assert.deepEqual(syncNames({ SYNC_NAME: 'lab' }), { me: 'lab', peer: null });
    // The cloud and a laptop have no role at all: nothing is invented.
    assert.deepEqual(syncNames({}), { me: null, peer: null });
    assert.deepEqual(syncNames({ SYNC_NAME: '../work' }), { me: null, peer: null });
    assert.deepEqual(syncNames({ SYNC_NAME: 'work', MANUAL_SYNC_PEER: 'work' }), { me: 'work', peer: null });
});

test('the git transport defaults to MTB-data beside the repository, pCloud only when configured', () => {
    const repo = path.join('C:', 'GitHub', 'MTB');
    assert.deepEqual(transportDirs({}, repo), { git: path.join('C:', 'GitHub', 'MTB-data'), pcloud: null });
    assert.deepEqual(transportDirs({ GIT_SYNC_DIR: 'D:\\data', SYNC_DIR: 'P:\\MTB-sync' }, repo),
        { git: 'D:\\data', pcloud: 'P:\\MTB-sync' });
    assert.equal(transportDirs({ MANUAL_SYNC_DIR: 'X:\\a', SYNC_DIR: 'P:\\b' }, repo).pcloud, 'X:\\a');
});

test('a valid manifest is summarised without its table contents', async () => {
    const dir = await scratch();
    try {
        await writeManifest(dir, 'work', manifest('work'), true);
        const { snapshot, problem } = await readCurrentManifest(dir, 'work');
        assert.equal(problem, undefined);
        assert.deepEqual(snapshot, {
            snapshotId: 'work-2026-09-22-18-00-00-abcdef12',
            machine: 'work',
            createdAt: '2026-09-22T16:00:00.000Z',
            database: 'therapy_dev',
            migrations: 2,
            latestMigration: '002_b.sql',
            tables: 2,
            dumpBytes: 12345,
            gitCommit: '0de2730'
        });
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a manifest the sync script would refuse is reported, never shown as a snapshot', async () => {
    const dir = await scratch();
    try {
        assert.deepEqual(await readCurrentManifest(dir, 'home'), { snapshot: null },
            'no export yet is a normal state, not a problem');

        await writeManifest(dir, 'home', manifest('work'));
        assert.match((await readCurrentManifest(dir, 'home')).problem || '', /друга машина/);

        await writeManifest(dir, 'home', manifest('home', { format: 'something-else' }));
        assert.match((await readCurrentManifest(dir, 'home')).problem || '', /формат/);

        await writeManifest(dir, 'home', manifest('home', { snapshotId: '../../etc' }));
        assert.match((await readCurrentManifest(dir, 'home')).problem || '', /небезбедно/);

        await writeManifest(dir, 'home', '{ not json');
        const broken = await readCurrentManifest(dir, 'home');
        assert.equal(broken.snapshot, null);
        assert.match(broken.problem || '', /JSON/);
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a transport reports both sides, and a missing folder as unavailable rather than empty', async () => {
    const dir = await scratch();
    try {
        await writeManifest(dir, 'work', manifest('work'));
        const both = await transportStatus('git', dir, 'work', 'home');
        assert.equal(both.available, true);
        assert.equal(both.me?.snapshotId, 'work-2026-09-22-18-00-00-abcdef12');
        assert.equal(both.peer, null);
        assert.deepEqual(both.problems, []);

        const gone = await transportStatus('pcloud', path.join(dir, 'missing'), 'work', 'home');
        assert.equal(gone.configured, true);
        assert.equal(gone.available, false);

        const unset = await transportStatus('pcloud', null, 'work', 'home');
        assert.equal(unset.configured, false);
        assert.equal(unset.available, false);
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a migration gap is described, not judged', () => {
    const gap = migrationGap(['001_a.sql', '002_b.sql', '099_local.sql'], ['001_a.sql', '002_b.sql', '003_c.sql']);
    assert.deepEqual(gap, {
        applied: 3, inCode: 3, latestApplied: '099_local.sql',
        notApplied: ['003_c.sql'], unknownToCode: ['099_local.sql']
    });
    assert.equal(migrationGap([], []).latestApplied, null);
});

test('the newest backup is found by the dump name backup-db.ps1 writes', async () => {
    const repo = await scratch();
    try {
        assert.equal(await latestBackup(repo), null);
        const dir = path.join(repo, 'backups', 'db');
        await mkdir(dir, { recursive: true });
        const older = path.join(dir, 'therapy_dev-2026-09-01-10-00-00.dump');
        const newer = path.join(dir, 'therapy_dev-2026-09-20-10-00-00.dump');
        const stray = path.join(dir, 'notes.dump');
        for (const file of [older, newer, stray]) await writeFile(file, 'x');
        await utimes(older, new Date('2026-09-01T10:00:00Z'), new Date('2026-09-01T10:00:00Z'));
        await utimes(newer, new Date('2026-09-20T10:00:00Z'), new Date('2026-09-20T10:00:00Z'));
        await utimes(stray, new Date('2026-09-30T10:00:00Z'), new Date('2026-09-30T10:00:00Z'));
        const found = await latestBackup(repo);
        assert.equal(found?.file, 'therapy_dev-2026-09-20-10-00-00.dump');
        assert.equal(found?.at, '2026-09-20T10:00:00.000Z');
    } finally { await rm(repo, { recursive: true, force: true }); }
});

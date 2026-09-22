import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * What the WORK↔HOME handover looks like from this machine — READ ONLY.
 *
 * `manual-db-sync.ps1` is the only thing that exports, compares or accepts a
 * database, and it stays that way: it verifies checksums, fingerprints and the
 * exact migration list before anything is replaced. This file only reads the
 * manifests that script has already written, so a web page can say "your last
 * export was Tuesday" without becoming a second decider of anything.
 *
 * It deliberately does NOT compare the live database with a snapshot. That
 * fingerprint is computed in PowerShell; a second implementation here would be
 * a second answer to "has this machine changed since its export?", and the day
 * the two disagree nobody would know which one to believe.
 */

export const MANIFEST_FORMAT = 'mtb-manual-db-sync-v1';

export type SnapshotSummary = {
    snapshotId: string;
    machine: string;
    createdAt: string | null;
    database: string | null;
    migrations: number;
    latestMigration: string | null;
    tables: number;
    dumpBytes: number | null;
    gitCommit: string | null;
};

export type TransportKind = 'git' | 'pcloud';

export type TransportStatus = {
    kind: TransportKind;
    configured: boolean;
    dir: string | null;
    available: boolean;
    me: SnapshotSummary | null;
    peer: SnapshotSummary | null;
    problems: string[];
};

type Env = Record<string, string | undefined>;

const MACHINE = /^[A-Za-z0-9_-]+$/;

function clean(value: string | undefined): string {
    return String(value || '').trim();
}

/** The same order `manual-db-sync.ps1` and `git-sync.ps1` read it in. */
export function syncNames(env: Env): { me: string | null; peer: string | null } {
    const me = clean(env.MANUAL_SYNC_NAME) || clean(env.HANDOFF_NAME) || clean(env.SYNC_NAME);
    if (!me || !MACHINE.test(me)) return { me: null, peer: null };
    const declared = clean(env.MANUAL_SYNC_PEER) || clean(env.HANDOFF_PEER_NAME);
    const peer = declared || (me === 'work' ? 'home' : me === 'home' ? 'work' : '');
    return { me, peer: peer && MACHINE.test(peer) && peer !== me ? peer : null };
}

/**
 * Where each transport keeps its snapshots. `null` means "not set up on this
 * machine", which is a normal answer for the cloud and for a laptop.
 */
export function transportDirs(env: Env, repoRoot: string): Record<TransportKind, string | null> {
    const git = clean(env.GIT_SYNC_DIR) || path.join(path.dirname(repoRoot), 'MTB-data');
    const pcloud = clean(env.MANUAL_SYNC_DIR) || clean(env.HANDOFF_DIR) || clean(env.SYNC_DIR);
    return { git, pcloud: pcloud || null };
}

async function isDirectory(dir: string): Promise<boolean> {
    try { return (await stat(dir)).isDirectory(); } catch { return false; }
}

function summarize(raw: Record<string, unknown>): SnapshotSummary {
    const migrations = Array.isArray(raw.schemaMigrations) ? raw.schemaMigrations.map(String) : [];
    const sorted = [...migrations].sort();
    const commit = typeof raw.gitCommit === 'string' ? raw.gitCommit.trim() : '';
    return {
        snapshotId: String(raw.snapshotId),
        machine: String(raw.machine),
        createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null,
        database: typeof raw.database === 'string' ? raw.database : null,
        migrations: migrations.length,
        latestMigration: sorted.length ? sorted[sorted.length - 1] : null,
        tables: Array.isArray(raw.tables) ? raw.tables.length : 0,
        dumpBytes: typeof raw.dumpBytes === 'number' ? raw.dumpBytes : null,
        gitCommit: commit ? commit.slice(0, 7) : null
    };
}

/**
 * `<dir>/manual-db-sync/<machine>/current.json`, validated the way the script
 * validates it before trusting it. A manifest that names another machine or an
 * unknown format is reported, never shown as if it were a good snapshot.
 */
export async function readCurrentManifest(dir: string, machine: string): Promise<{
    snapshot: SnapshotSummary | null; problem?: string;
}> {
    const file = path.join(dir, 'manual-db-sync', machine, 'current.json');
    let text: string;
    try {
        text = await readFile(file, 'utf8');
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { snapshot: null };
        return { snapshot: null, problem: `${machine}: манифестот не може да се прочита` };
    }
    let raw: unknown;
    try {
        raw = JSON.parse(text.replace(/^﻿/, ''));
    } catch {
        return { snapshot: null, problem: `${machine}: манифестот не е валиден JSON` };
    }
    if (!raw || typeof raw !== 'object') {
        return { snapshot: null, problem: `${machine}: манифестот е празен` };
    }
    const manifest = raw as Record<string, unknown>;
    if (manifest.format !== MANIFEST_FORMAT) {
        return { snapshot: null, problem: `${machine}: непознат формат на снимка` };
    }
    if (manifest.machine !== machine) {
        return { snapshot: null, problem: `${machine}: манифестот именува друга машина` };
    }
    if (typeof manifest.snapshotId !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(manifest.snapshotId)) {
        return { snapshot: null, problem: `${machine}: небезбедно име на снимка` };
    }
    return { snapshot: summarize(manifest) };
}

export async function transportStatus(
    kind: TransportKind, dir: string | null, me: string | null, peer: string | null
): Promise<TransportStatus> {
    const base: TransportStatus = {
        kind, configured: Boolean(dir), dir, available: false, me: null, peer: null, problems: []
    };
    if (!dir) return base;
    base.available = await isDirectory(dir);
    if (!base.available) return base;
    for (const [slot, machine] of [['me', me], ['peer', peer]] as const) {
        if (!machine) continue;
        const read = await readCurrentManifest(dir, machine);
        base[slot] = read.snapshot;
        if (read.problem) base.problems.push(read.problem);
    }
    return base;
}

/** The migration files this checkout carries, in the order they are applied. */
export async function codeMigrations(repoRoot: string): Promise<string[]> {
    try {
        const files = await readdir(path.join(repoRoot, 'database', 'migrations'));
        return files.filter((f) => f.endsWith('.sql')).sort();
    } catch {
        return [];
    }
}

/**
 * Applied vs. present in the code. A difference is REPORTED, never acted on:
 * HOME deliberately stays behind the code for weeks at a time, and a page that
 * treated that as an error to fix would be the wrong owner of the decision.
 */
export function migrationGap(applied: string[], inCode: string[]) {
    const have = new Set(applied);
    const known = new Set(inCode);
    return {
        applied: applied.length,
        inCode: inCode.length,
        latestApplied: applied.length ? [...applied].sort()[applied.length - 1] : null,
        notApplied: inCode.filter((f) => !have.has(f)),
        unknownToCode: applied.filter((f) => !known.has(f)).sort()
    };
}

/** The newest weekly dump in `backups/db`, by the name `backup-db.ps1` gives it. */
export async function latestBackup(repoRoot: string): Promise<{ file: string; at: string; bytes: number } | null> {
    const dir = path.join(repoRoot, 'backups', 'db');
    let names: string[];
    try { names = await readdir(dir); } catch { return null; }
    let best: { file: string; at: string; bytes: number; ms: number } | null = null;
    for (const name of names) {
        if (!/-\d{4}(?:-\d{2}){5}\.dump$/.test(name)) continue;
        try {
            const info = await stat(path.join(dir, name));
            if (!info.isFile()) continue;
            if (!best || info.mtimeMs > best.ms) {
                best = { file: name, at: info.mtime.toISOString(), bytes: info.size, ms: info.mtimeMs };
            }
        } catch { /* a file removed while listing is simply not the newest */ }
    }
    return best ? { file: best.file, at: best.at, bytes: best.bytes } : null;
}

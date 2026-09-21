/**
 * Supabase/cloud -> separate local read-only mirror.
 *
 * Dry-run is the default. Apply requires the exact snapshot id AND plan hash
 * printed by that dry-run; a newer download or a changed local target refuses.
 */

import 'dotenv/config';
import pg from 'pg';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { applyMirrorSnapshot, planMirror, recordMirrorFailure, validateMirrorSnapshot } from '../src/lib/mirror.js';
import { mirrorMode } from '../src/lib/mirror-config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SNAPSHOT_DIR = path.resolve(__dirname, '..', '..', 'backups', 'mirror');
const MAXIMUM_SNAPSHOT_BYTES = 100 * 1024 * 1024;
const args = process.argv.slice(2);
const has = (name: string) => args.includes(`--${name}`);
function opt(name: string): string {
    const prefix = `--${name}=`;
    const inline = args.find((value) => value.startsWith(prefix));
    if (inline) return inline.slice(prefix.length);
    const index = args.indexOf(`--${name}`);
    return index >= 0 ? String(args[index + 1] || '') : '';
}

function required(value: string, message: string): string {
    const clean = String(value || '').trim();
    if (!clean) throw new Error(message);
    return clean;
}

function sourceOrigin(): string {
    const raw = required(opt('source') || process.env.MTB_MIRROR_SOURCE_URL || '',
        'Set MTB_MIRROR_SOURCE_URL or pass --source https://...');
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.origin !== raw.replace(/\/+$/, '')) {
        throw new Error('Mirror source must be one exact HTTPS origin, without a path');
    }
    return url.origin;
}

function targetSettings() {
    const raw = required(process.env.MTB_MIRROR_TARGET_DATABASE_URL || '',
        'Set MTB_MIRROR_TARGET_DATABASE_URL explicitly for a separate local mirror database');
    const url = new URL(raw);
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Mirror target must be a PostgreSQL URL');
    if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
        throw new Error('Mirror target must be local; cloud/non-local database targets are refused');
    }
    const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
    const confirmed = required(process.env.MTB_MIRROR_TARGET_DATABASE || '',
        'Set MTB_MIRROR_TARGET_DATABASE to the exact local mirror database name');
    if (database !== confirmed) throw new Error('MTB_MIRROR_TARGET_DATABASE does not match the target URL database');
    if (!/_mirror$/i.test(database)) throw new Error('Use a separate database whose name ends in _mirror');

    const active = process.env.DATABASE_URL;
    if (active) {
        try {
            const app = new URL(active);
            if (app.hostname === url.hostname && (app.port || '5432') === (url.port || '5432') &&
                decodeURIComponent(app.pathname) === decodeURIComponent(url.pathname) && mirrorMode() !== 'readonly') {
                throw new Error('Mirror target is the active local application database; use a separate *_mirror database');
            }
        } catch (err) {
            if (err instanceof Error && err.message.startsWith('Mirror target is')) throw err;
        }
    }
    return { url: raw, database };
}

async function downloadSnapshot(origin: string, key: string) {
    const timeoutSeconds = Number(process.env.MTB_MIRROR_TIMEOUT_SECONDS || 60);
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 5 || timeoutSeconds > 300) {
        throw new Error('MTB_MIRROR_TIMEOUT_SECONDS must be an integer from 5 to 300');
    }
    let last: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const response = await fetch(`${origin}/api/mirror/snapshot`, {
                headers: { authorization: `Bearer ${key}` },
                signal: AbortSignal.timeout(timeoutSeconds * 1000)
            });
            if (!response.ok) throw new Error(`cloud snapshot returned HTTP ${response.status}`);
            const announced = Number(response.headers.get('content-length') || 0);
            if (announced > MAXIMUM_SNAPSHOT_BYTES) throw new Error('cloud snapshot exceeds the 100 MiB safety limit');
            const bytes = new Uint8Array(await response.arrayBuffer());
            if (bytes.byteLength > MAXIMUM_SNAPSHOT_BYTES) throw new Error('cloud snapshot exceeds the 100 MiB safety limit');
            let parsed: unknown;
            try { parsed = JSON.parse(new TextDecoder().decode(bytes)); }
            catch { throw new Error('cloud snapshot is incomplete or not valid JSON'); }
            return validateMirrorSnapshot(parsed);
        } catch (err) {
            last = err;
            if (attempt < 3) await delay(attempt === 1 ? 500 : 1500);
        }
    }
    throw last;
}

async function saveSnapshotArtifact(snapshot: ReturnType<typeof validateMirrorSnapshot>): Promise<string> {
    await mkdir(DEFAULT_SNAPSHOT_DIR, { recursive: true });
    const filename = path.join(DEFAULT_SNAPSHOT_DIR, `${snapshot.snapshotId}.json`);
    const content = JSON.stringify(snapshot);
    try {
        await writeFile(filename, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    } catch (err) {
        if (!(err && typeof err === 'object' && 'code' in err && err.code === 'EEXIST')) throw err;
        const existing = validateMirrorSnapshot(JSON.parse(await readFile(filename, 'utf8')));
        if (existing.payloadHash !== snapshot.payloadHash) {
            throw new Error(`Existing snapshot artifact has different content: ${filename}`);
        }
    }
    return filename;
}

async function readSnapshotArtifact(filename: string) {
    const absolute = path.resolve(required(filename, '--snapshot-file requires a file path'));
    const size = (await stat(absolute)).size;
    if (size > MAXIMUM_SNAPSHOT_BYTES) throw new Error('snapshot file exceeds the 100 MiB safety limit');
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(absolute, 'utf8')); }
    catch { throw new Error('snapshot file is incomplete or not valid JSON'); }
    return { snapshot: validateMirrorSnapshot(parsed), filename: absolute };
}

function printPlan(database: string, plan: Awaited<ReturnType<typeof planMirror>>) {
    console.log('\n=== SUPABASE → LOCAL MIRROR (DRY RUN) ===');
    console.log(`target database: ${database}`);
    console.log(`snapshot:        ${plan.snapshotId}`);
    console.log(`source version:  ${plan.sourceVersion}`);
    console.log(`data time:       ${plan.snapshotAt}`);
    console.log(`plan hash:       ${plan.planHash}`);
    console.log(`rows:            source ${plan.totals.sourceRows}, local ${plan.totals.localRows}`);
    console.log(`changes:         +${plan.totals.added}  ~${plan.totals.changed}  -${plan.totals.deleted}`);
    for (const table of plan.tables.filter((item) => item.added || item.changed || item.deleted)) {
        console.log(`  ${table.table.padEnd(28)} +${table.added} ~${table.changed} -${table.deleted}`);
    }
    if (plan.localAuthRowsToClear.evidenceLogins || plan.localAuthRowsToClear.evidenceSessions) {
        console.log(`local auth rows cleared on apply: ${plan.localAuthRowsToClear.evidenceLogins} login(s), ` +
            `${plan.localAuthRowsToClear.evidenceSessions} session(s)`);
    }
    if (plan.olderThanApplied) console.log('REFUSED: this snapshot is older than the last applied source version.');
    else if (plan.alreadyApplied && !plan.totals.added && !plan.totals.changed && !plan.totals.deleted) {
        console.log('Already applied; repeating it is a no-op.');
    }
}

async function main() {
    const apply = has('apply');
    const suppliedFile = opt('snapshot-file');
    if (apply && !suppliedFile) {
        throw new Error('--apply requires --snapshot-file from the reviewed dry-run');
    }
    const expectedSourceId = required(process.env.MTB_MIRROR_SOURCE_ID || '',
        'Set MTB_MIRROR_SOURCE_ID to the expected cloud server id');
    const target = targetSettings();
    const pool = new pg.Pool({ connectionString: target.url, max: 1 });
    try {
        let artifact;
        if (suppliedFile) {
            artifact = await readSnapshotArtifact(suppliedFile);
        } else {
            const origin = sourceOrigin();
            const key = required(process.env.MTB_MIRROR_PULL_KEY || '',
                'Set MTB_MIRROR_PULL_KEY (never put it in Git)');
            if (key.length < 32 || /[\x00-\x20\x7f]/.test(key)) throw new Error('MTB_MIRROR_PULL_KEY is invalid');
            const snapshot = await downloadSnapshot(origin, key);
            artifact = { snapshot, filename: await saveSnapshotArtifact(snapshot) };
        }
        const { snapshot, filename: snapshotFilename } = artifact;
        if (snapshot.source.id !== expectedSourceId) {
            throw new Error(`Mirror source identity mismatch: expected ${expectedSourceId}, received ${snapshot.source.id}`);
        }
        const plan = await planMirror(pool, snapshot);
        printPlan(target.database, plan);
        console.log(`snapshot file:   ${snapshotFilename}`);
        if (!apply) {
            console.log('\nThe database was not changed. To apply this exact saved snapshot:');
            console.log(`npm run mirror:pull -- --apply --snapshot-file "${snapshotFilename}" ` +
                `--snapshot-id ${plan.snapshotId} --plan-hash ${plan.planHash}`);
            if (plan.totals.deleted > 10 && plan.totals.deleted > Math.floor(plan.totals.localRows * 0.20)) {
                console.log(`Also add --allow-delete-count ${plan.totals.deleted} after reviewing the deletions.`);
            }
            return;
        }
        if (mirrorMode() !== 'readonly') throw new Error('Apply requires MTB_MIRROR_MODE=readonly');
        const expectedSnapshotId = required(opt('snapshot-id'), '--apply requires --snapshot-id from the dry-run');
        const expectedPlanHash = required(opt('plan-hash'), '--apply requires --plan-hash from the dry-run');
        const deleteText = opt('allow-delete-count');
        const allowedLargeDeleteCount = deleteText ? Number(deleteText) : undefined;
        if (deleteText && (!Number.isInteger(allowedLargeDeleteCount) || allowedLargeDeleteCount! < 0)) {
            throw new Error('--allow-delete-count must be a non-negative integer');
        }
        const result = await applyMirrorSnapshot(pool, snapshot, {
            expectedSnapshotId,
            expectedPlanHash,
            allowedLargeDeleteCount
        });
        console.log(result.applied
            ? `\nApplied ${snapshot.snapshotId} atomically. Local mirror is now at ${snapshot.source.snapshotAt}.`
            : `\n${snapshot.snapshotId} was already applied; no rows changed.`);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = /cloud snapshot|fetch|network|timeout|JSON/i.test(message) ? 'download_failed'
            : /refused|mismatch|changed|confirm|older|scope|schema|migration/i.test(message) ? 'safety_refusal'
                : 'apply_failed';
        await recordMirrorFailure(pool, expectedSourceId, code).catch(() => {});
        throw err;
    } finally {
        await pool.end();
    }
}

main().catch((err) => {
    console.error('Mirror pull failed:', err instanceof Error ? err.message : err);
    process.exit(1);
});

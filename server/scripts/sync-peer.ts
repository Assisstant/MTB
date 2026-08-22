/**
 * sync-peer — carry state between two machines that each run their own database.
 *
 * The apps are used in one place at a time (work, then home, then work), never
 * in two at once. That makes the direction of a sync decidable: whichever side
 * was updated later holds the work the other has not seen, and copying it over
 * loses nothing. This is NOT a merge and must never pretend to be one — if both
 * sides changed since they last agreed, the script refuses and says so.
 *
 *   npm run sync -- --peer https://zenpc-1.tailXXXX.ts.net           dry run
 *   npm run sync -- --peer https://zenpc-1.tailXXXX.ts.net --apply   writes
 *
 * Dry run by default, like every other script here.
 */

import { createHash } from 'node:crypto';
import 'dotenv/config';
import { pool } from '../src/db.js';

type State = {
    app: string;
    version: number;
    payload: Record<string, unknown>;
    updated_at: string;
    updated_by: string | null;
};

type Side = { label: string; url: string; state: State | null };

const args = process.argv.slice(2);

function flag(name: string): boolean {
    return args.includes('--' + name);
}

function opt(name: string, fallback?: string): string | undefined {
    const i = args.indexOf('--' + name);
    if (i >= 0 && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1];
    return fallback;
}

// The peer address rarely changes, so it may live in server/.env as
// PEER_URL=https://... — that file is gitignored and already holds DATABASE_URL.
const PEER = opt('peer', process.env.PEER_URL);
const LOCAL = (opt('local', 'http://127.0.0.1:3000') as string).replace(/\/+$/, '');
const APPS = (opt('apps', 'unified,sdnevnik') as string).split(',').map((s) => s.trim()).filter(Boolean);
const APPLY = flag('apply');
const FORCE = flag('force');

/**
 * Two servers stamp updated_at from their own clocks. Tailscale machines are
 * normally NTP-synced, but a few seconds of drift is ordinary and must not be
 * allowed to decide which side is newer — the gap between real work sessions is
 * hours, so anything this close means something unexpected happened.
 */
const SKEW_SECONDS = 30;

/** A payload that shrank this much is more likely a wrong-direction sync than an edit. */
const SHRINK_REFUSE_RATIO = 0.5;

if (!PEER) {
    console.error(`
Usage:
  npm run sync -- --peer <url> [--apply]

  --peer <url>    the other machine, e.g. https://zenpc-1.tailXXXX.ts.net   (required)
  --local <url>   this machine's API                    (default http://127.0.0.1:3000)
  --apps a,b      which app states to sync              (default unified,sdnevnik)
  --apply         actually write; without it nothing changes
  --force         override the clock-skew and shrink guards (read the report first)
`);
    process.exit(1);
}

const PEER_URL = PEER.replace(/\/+$/, '');

function hash(payload: unknown): string {
    return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 12);
}

function size(payload: unknown): number {
    return JSON.stringify(payload).length;
}

function when(iso: string): string {
    return new Date(iso).toLocaleString('sv-SE').replace('T', ' ');
}

async function getState(base: string, app: string): Promise<State | null> {
    const res = await fetch(`${base}/api/state/${app}`, { cache: 'no-store' } as RequestInit);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${base} answered ${res.status} for ${app}`);
    return (await res.json()) as State;
}

async function putState(base: string, app: string, payload: unknown, baseVersion: number, by: string) {
    const res = await fetch(`${base}/api/state/${app}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseVersion, payload, updated_by: by })
    });
    const body = await res.json().catch(() => null);
    if (res.status === 409) {
        throw new Error('the target changed while this script was running - rerun it');
    }
    if (!res.ok) throw new Error(`target answered ${res.status}: ${JSON.stringify(body)}`);
    return body as { version: number; projection?: Record<string, unknown> };
}

/** Whether a payload carries anything at all. An empty one must never replace a full one. */
function isEmpty(payload: Record<string, unknown> | undefined): boolean {
    if (!payload || typeof payload !== 'object') return true;
    if (Object.keys(payload).length === 0) return true;
    return size(payload) < 200;
}

type Plan =
    | { action: 'none'; reason: string }
    | { action: 'copy'; from: Side; to: Side; reason: string }
    | { action: 'refuse'; reason: string };

/** What both machines held the last time this script found them in agreement. */
async function readWatermark(app: string, peer: string): Promise<string | null> {
    const { rows } = await pool.query(
        'SELECT payload_hash FROM sync_watermark WHERE app = $1 AND peer = $2',
        [app, peer]
    );
    return rows.length ? (rows[0].payload_hash as string) : null;
}

async function writeWatermark(app: string, peer: string, h: string, lv: number, pv: number) {
    await pool.query(
        `INSERT INTO sync_watermark (app, peer, payload_hash, local_version, peer_version, synced_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (app, peer) DO UPDATE
         SET payload_hash = $3, local_version = $4, peer_version = $5, synced_at = now()`,
        [app, peer, h, lv, pv]
    );
}

/**
 * Direction is decided by what changed since the last agreement, not by clocks.
 * The timestamp rule is only a fallback for the very first sync, when there is
 * no agreement on record yet.
 */
function decide(local: Side, peer: Side, watermark: string | null): Plan {
    const l = local.state;
    const p = peer.state;

    if (!l && !p) return { action: 'none', reason: 'neither machine has any state yet' };
    if (l && !p) return { action: 'copy', from: local, to: peer, reason: `${peer.label} has no state yet` };
    if (!l && p) return { action: 'copy', from: peer, to: local, reason: `${local.label} has no state yet` };

    const L = l as State;
    const P = p as State;
    const lh = hash(L.payload);
    const ph = hash(P.payload);

    if (lh === ph) {
        return { action: 'none', reason: 'both machines already hold the same state' };
    }

    let from: Side;
    let to: Side;
    let reason: string;

    if (watermark) {
        const localChanged = lh !== watermark;
        const peerChanged = ph !== watermark;

        if (localChanged && peerChanged && !FORCE) {
            return {
                action: 'refuse',
                reason:
                    'BOTH machines changed since they were last in sync - this cannot be merged.\n' +
                    `      ${local.label}: v${L.version}, ${when(L.updated_at)}, ${L.updated_by ?? 'unknown'}\n` +
                    `      ${peer.label}: v${P.version}, ${when(P.updated_at)}, ${P.updated_by ?? 'unknown'}\n` +
                    '      Export JSON from the side you want to keep, import it into the other,\n' +
                    '      or rerun with --force to let the newer timestamp win and LOSE the other side.'
            };
        }

        if (localChanged && !peerChanged) {
            from = local; to = peer;
            reason = `only ${local.label} changed since the last sync`;
        } else if (peerChanged && !localChanged) {
            from = peer; to = local;
            reason = `only ${peer.label} changed since the last sync`;
        } else {
            // --force with both changed: fall through to the clock.
            const newerIsLocal = new Date(L.updated_at).getTime() > new Date(P.updated_at).getTime();
            from = newerIsLocal ? local : peer;
            to = newerIsLocal ? peer : local;
            reason = `FORCED: both changed; keeping ${from.label} because it was saved later`;
        }
    } else {
        // First ever sync between these two: nothing on record, so the clock is
        // all there is. Refuse when the two stamps are too close to separate.
        const lt = new Date(L.updated_at).getTime();
        const pt = new Date(P.updated_at).getTime();
        const gapSeconds = Math.abs(lt - pt) / 1000;

        if (gapSeconds < SKEW_SECONDS && !FORCE) {
            return {
                action: 'refuse',
                reason:
                    `no previous sync on record, and the two states differ but were saved ${gapSeconds.toFixed(0)}s apart -\n` +
                    '      too close to tell which is newer.\n' +
                    `      ${local.label}: ${when(L.updated_at)} (v${L.version}, ${L.updated_by ?? 'unknown'})\n` +
                    `      ${peer.label}: ${when(P.updated_at)} (v${P.version}, ${P.updated_by ?? 'unknown'})\n` +
                    '      Decide by hand, then rerun with --force.'
            };
        }

        const newerIsLocal = lt > pt;
        from = newerIsLocal ? local : peer;
        to = newerIsLocal ? peer : local;
        reason = `first sync: ${from.label} was saved later (${when((from.state as State).updated_at)})`;
    }

    const fromState = from.state as State;
    const toState = to.state as State;

    if (isEmpty(fromState.payload)) {
        return { action: 'refuse', reason: `${from.label} would be the source but its state is empty - refusing to erase ${to.label}` };
    }

    const ratio = size(fromState.payload) / Math.max(1, size(toState.payload));
    if (ratio < SHRINK_REFUSE_RATIO && !FORCE) {
        return {
            action: 'refuse',
            reason:
                `${from.label} would be the source but is ${Math.round((1 - ratio) * 100)}% smaller than ${to.label} ` +
                `(${size(fromState.payload)} vs ${size(toState.payload)} bytes).\n` +
                '      That looks more like a wrong-direction sync than an edit. Check both, then --force.'
        };
    }

    return { action: 'copy', from, to, reason };
}

async function syncApp(app: string): Promise<'changed' | 'planned' | 'unchanged' | 'refused'> {
    console.log(`\n--- ${app} ${'-'.repeat(Math.max(3, 44 - app.length))}`);

    const [localState, peerState] = await Promise.all([
        getState(LOCAL, app),
        getState(PEER_URL, app)
    ]);

    const local: Side = { label: 'this machine', url: LOCAL, state: localState };
    const peer: Side = { label: 'peer', url: PEER_URL, state: peerState };
    const watermark = await readWatermark(app, PEER_URL);

    for (const side of [local, peer]) {
        if (side.state) {
            console.log(
                `   ${side.label.padEnd(12)} v${String(side.state.version).padEnd(4)} ` +
                `${when(side.state.updated_at)}  ${hash(side.state.payload)}  ` +
                `${size(side.state.payload)} bytes  ${side.state.updated_by ?? ''}`
            );
        } else {
            console.log(`   ${side.label.padEnd(12)} (no state)`);
        }
    }

    console.log(`   last agreed  ${watermark ?? '(never synced with this peer)'}`);

    const plan = decide(local, peer, watermark);

    if (plan.action === 'none') {
        console.log(`   = nothing to do: ${plan.reason}`);
        // Record the agreement, so a later one-sided change is recognised as such.
        if (APPLY && localState && peerState) {
            await writeWatermark(app, PEER_URL, hash(localState.payload), localState.version, peerState.version);
        }
        return 'unchanged';
    }
    if (plan.action === 'refuse') {
        console.log(`   ! REFUSED: ${plan.reason}`);
        return 'refused';
    }

    const direction = plan.from === local ? 'this machine -> peer' : 'peer -> this machine';
    console.log(`   > ${direction}`);
    console.log(`     ${plan.reason}`);

    if (!APPLY) {
        console.log('     (dry run - add --apply to write)');
        return 'planned';
    }

    const source = plan.from.state as State;
    const targetVersion = plan.to.state ? plan.to.state.version : 0;
    const by = `sync from ${plan.from === local ? 'this machine' : 'peer'}`;

    const result = await putState(plan.to.url, app, source.payload, targetVersion, by);
    console.log(`     written: ${plan.to.label} is now v${result.version}`);

    // Both machines now hold the source payload — that is the new agreement.
    const localVersion = plan.to === local ? result.version : (local.state as State).version;
    const peerVersion = plan.to === peer ? result.version : (peer.state as State).version;
    await writeWatermark(app, PEER_URL, hash(source.payload), localVersion, peerVersion);

    const proj = (result.projection ?? {}) as Record<string, unknown>;
    if (proj.ok === false) {
        console.log(`     WARNING: the blob was saved but the relational tables were NOT updated: ${proj.error ?? 'unknown'}`);
    } else if (Array.isArray(proj.problems) && proj.problems.length) {
        console.log(`     WARNING: projection problems: ${proj.problems.slice(0, 3).join('; ')}`);
    }

    return 'changed';
}

/**
 * Both PCs here have the same Windows hostname, so pointing this at the machine
 * it runs on is an easy mistake — and one that otherwise ends in a cheerful
 * "already in sync" that means nothing. Every running server reports an id
 * unique to it; equal ids mean one machine, not two.
 */
async function assertDifferentMachines() {
    const read = async (base: string) => {
        try {
            const res = await fetch(`${base}/api/health`, { cache: 'no-store' } as RequestInit);
            if (!res.ok) return null;
            const body = (await res.json()) as { instance?: string };
            return body.instance ?? null;
        } catch {
            return null;   // unreachable is reported later, with a better message
        }
    };

    const [a, b] = await Promise.all([read(LOCAL), read(PEER_URL)]);
    if (a && b && a === b) {
        console.error(`
Both addresses are the same machine.

  this machine : ${LOCAL}
  peer         : ${PEER_URL}

Those point at one server, so there is nothing to carry. Run this ON one PC with
--peer set to the OTHER one. Nothing was changed.
`);
        await pool.end();
        process.exit(1);
    }
}

async function main() {
    console.log(`this machine : ${LOCAL}`);
    console.log(`peer         : ${PEER_URL}`);
    console.log(APPLY ? 'mode         : APPLY (writes)' : 'mode         : dry run');

    await assertDifferentMachines();

    const results: string[] = [];
    for (const app of APPS) {
        try {
            results.push(await syncApp(app));
        } catch (err) {
            console.log(`   ! ${app}: ${err instanceof Error ? err.message : String(err)}`);
            results.push('refused');
        }
    }

    const refused = results.filter((r) => r === 'refused').length;
    const changed = results.filter((r) => r === 'changed').length;
    const planned = results.filter((r) => r === 'planned').length;
    const inSync = results.filter((r) => r === 'unchanged').length;

    console.log('\n' + '-'.repeat(49));
    if (APPLY) {
        console.log(`${changed} synced, ${inSync} already in sync, ${refused} needing you`);
    } else {
        console.log(`${planned} would sync, ${inSync} already in sync, ${refused} needing you`);
        if (planned > 0) console.log('Rerun with --apply to write.');
        else if (refused === 0) console.log('Nothing would change.');
    }
    await pool.end();
    process.exit(refused > 0 ? 2 : 0);
}

main().catch(async (err) => {
    console.error('\nsync-peer failed:', err instanceof Error ? err.message : err);
    await pool.end().catch(() => { /* already closing */ });
    process.exit(1);
});

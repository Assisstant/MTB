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
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
const EXPLICIT_PEER = opt('peer');
const PEER = EXPLICIT_PEER ?? process.env.PEER_URL;
const LOCAL = (opt('local', 'http://127.0.0.1:3000') as string).replace(/\/+$/, '');
const APPS = (opt('apps', 'unified,sdnevnik') as string).split(',').map((s) => s.trim()).filter(Boolean);
const APPLY = flag('apply');
const FORCE = flag('force');
// A long deployment key lets scheduled maintenance write while interactive
// staff sessions still expire after inactivity.  It lives only in `.env` and
// is never accepted on the command line, where process listings could expose it.
const SERVICE_KEY = String(process.env.MTB_SERVICE_KEY || '').trim();

/**
 * MAILBOX MODE.
 *
 * A direct call needs both machines awake at the same moment. That is often
 * not true here: the work PC is on during the day, the home PC in the evening,
 * and some weeks they never coincide. A folder that both machines already
 * synchronise (pCloud) removes the requirement — each leaves what it holds,
 * and reads what the other left. The cloud is the thing that is always up.
 *
 * Nothing about the DECISION changes: the same watermark rule runs, and both
 * sides changing is still refused. What changes is only how the peer's state
 * is obtained, and that a push cannot be confirmed on the spot.
 */
// An explicit --peer must not be silently turned into mailbox mode by a stale
// SYNC_DIR in .env. The old behaviour made TherapySyncPeer read P: and never
// contact the peer named in its own command line.
const DIR = opt('dir', EXPLICIT_PEER ? undefined : process.env.SYNC_DIR);
const ME = opt('me', process.env.SYNC_NAME);
const PEER_NAME_OPT = opt('peer-name', process.env.SYNC_PEER_NAME);
const MODE: 'http' | 'folder' = DIR ? 'folder' : 'http';

/**
 * Two servers stamp updated_at from their own clocks. Tailscale machines are
 * normally NTP-synced, but a few seconds of drift is ordinary and must not be
 * allowed to decide which side is newer — the gap between real work sessions is
 * hours, so anything this close means something unexpected happened.
 */
const SKEW_SECONDS = 30;

/** A payload that shrank this much is more likely a wrong-direction sync than an edit. */
const SHRINK_REFUSE_RATIO = 0.5;

const USAGE = `
Usage — pick ONE of the two transports:

  DIRECT (both machines on at the same time)
    npm run sync -- --peer <url> [--apply]

  MAILBOX (a folder both machines sync, e.g. pCloud; they never need to coincide)
    npm run sync -- --dir <path> --me <name> [--apply]

  --peer <url>     the other machine, e.g. https://zenpc-1.tailXXXX.ts.net
  --dir <path>     shared folder, e.g. D:\\pCloudDrive\\MTB-sync
  --me <name>      THIS machine's name in that folder, e.g. work   (required with --dir)
  --peer-name <n>  the other machine's name; only needed if the folder holds more than two
  --local <url>    this machine's API                  (default http://127.0.0.1:3000)
  --apps a,b       which app states to sync            (default unified,sdnevnik)
  --apply          actually write; without it nothing changes
  --force          override the clock-skew and shrink guards (read the report first)
`;

if (MODE === 'http' && !PEER) {
    console.error(USAGE);
    process.exit(1);
}

if (MODE === 'folder' && !ME) {
    console.error(`
--dir was given but --me was not.

Each machine needs a name so it can tell its own file from the other's. Windows
reports the SAME hostname on both of these PCs, so it cannot be guessed.

  npm run sync -- --dir "${DIR}" --me work
  npm run sync -- --dir "${DIR}" --me home

Set it once in server\\.env as SYNC_NAME=work and you never pass it again.
`);
    process.exit(1);
}

const PEER_URL = (PEER ?? '').replace(/\/+$/, '');

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
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (SERVICE_KEY) headers['X-MTB-Service-Key'] = SERVICE_KEY;
    const res = await fetch(`${base}/api/state/${app}`, {
        method: 'PUT',
        headers,
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

/* ── the mailbox ──────────────────────────────────────────────────────────
 *
 * <dir>/<machine name>/<app>.json — one file per machine per app, holding that
 * machine's whole state. A machine writes only its OWN folder and reads only
 * the other's, so two machines can never write the same file and there is
 * nothing to merge at the file level either.
 */

type Envelope = {
    name: string;
    app: string;
    version: number;
    updated_at: string;
    updated_by: string | null;
    hash: string;
    writtenAt: string;
    payload: Record<string, unknown>;
};

/** Which folder belongs to the other machine. */
function mailboxPeerName(): string | null {
    if (PEER_NAME_OPT) return PEER_NAME_OPT;
    if (!existsSync(DIR as string)) return null;
    const others = readdirSync(DIR as string)
        .filter((n) => n !== ME)
        .filter((n) => {
            try { return statSync(join(DIR as string, n)).isDirectory(); } catch { return false; }
        });
    if (others.length === 0) return null;
    if (others.length > 1) {
        throw new Error(
            `the folder holds more than one other machine (${others.join(', ')}) - ` +
            'say which with --peer-name'
        );
    }
    return others[0];
}

/**
 * Read what the other machine left.
 *
 * The file may be mid-download: a cloud client writes it in pieces, and half a
 * JSON file is worse than none. The stored hash is checked against the payload,
 * so a torn file is reported and skipped rather than applied.
 */
function mailboxRead(app: string, peerName: string | null): State | null {
    if (!peerName) return null;
    const file = join(DIR as string, peerName, `${app}.json`);
    if (!existsSync(file)) return null;

    let env: Envelope;
    try {
        env = JSON.parse(readFileSync(file, 'utf8')) as Envelope;
    } catch {
        console.log(`   ! ${peerName}/${app}.json is not readable yet (still syncing?) - skipped`);
        return null;
    }
    if (!env || typeof env !== 'object' || !env.payload) {
        console.log(`   ! ${peerName}/${app}.json has no payload - skipped`);
        return null;
    }
    if (env.hash && env.hash !== hash(env.payload)) {
        console.log(`   ! ${peerName}/${app}.json is incomplete (hash does not match) - skipped`);
        return null;
    }
    return {
        app,
        version: Number(env.version || 0),
        payload: env.payload,
        updated_at: env.updated_at,
        updated_by: env.updated_by ?? null
    };
}

/** Leave this machine's state where the other one will find it. */
function mailboxPublish(app: string, state: State) {
    const dir = join(DIR as string, ME as string);
    mkdirSync(dir, { recursive: true });
    const env: Envelope = {
        name: ME as string,
        app,
        version: state.version,
        updated_at: state.updated_at,
        updated_by: state.updated_by,
        hash: hash(state.payload),
        writtenAt: new Date().toISOString(),
        payload: state.payload
    };
    // Written under a temporary name and renamed, so a cloud client never
    // uploads a file that is only half written.
    const tmp = join(dir, `${app}.json.part`);
    writeFileSync(tmp, JSON.stringify(env), 'utf8');
    renameSync(tmp, join(dir, `${app}.json`));
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

async function syncApp(app: string, peerName: string | null): Promise<'changed' | 'planned' | 'unchanged' | 'refused'> {
    console.log(`\n--- ${app} ${'-'.repeat(Math.max(3, 44 - app.length))}`);

    // The watermark is per peer, and a mailbox peer is a different counterpart
    // from the same machine reached directly - keep the keys apart.
    const peerKey = MODE === 'folder' ? `folder:${peerName ?? 'pending'}` : PEER_URL;
    const peerLabel = MODE === 'folder' ? (peerName ?? 'the other machine') : 'peer';

    const localState = await getState(LOCAL, app);
    const peerState = MODE === 'folder'
        ? mailboxRead(app, peerName)
        : await getState(PEER_URL, app);

    const local: Side = { label: 'this machine', url: LOCAL, state: localState };
    const peer: Side = { label: peerLabel, url: PEER_URL, state: peerState };
    const watermark = await readWatermark(app, peerKey);

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
            await writeWatermark(app, peerKey, hash(localState.payload), localState.version, peerState.version);
        }
        if (APPLY && MODE === 'folder' && localState && !isEmpty(localState.payload)) {
            mailboxPublish(app, localState);
        }
        return 'unchanged';
    }
    if (plan.action === 'refuse') {
        console.log(`   ! REFUSED: ${plan.reason}`);
        // The mailbox says what this machine holds; that stays true during a
        // conflict. Only APPLYING is withheld, never the honest advertisement.
        if (APPLY && MODE === 'folder' && localState && !isEmpty(localState.payload)) {
            mailboxPublish(app, localState);
        }
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

    // Pushing through a mailbox is not the same act as pushing over the wire.
    // The other machine has not received anything yet - it will, the next time
    // it runs. Writing a watermark here would claim an agreement that does not
    // exist, and the next run would then read the peer's STALE file, conclude
    // it had changed, and pull it back over this very work.
    if (MODE === 'folder' && plan.to === peer) {
        mailboxPublish(app, source);
        console.log(`     left in the mailbox as ${ME}/${app}.json`);
        console.log(`     ${peerLabel} takes it the next time it runs - no agreement recorded yet`);
        return 'changed';
    }

    const targetVersion = plan.to.state ? plan.to.state.version : 0;
    const by = `sync from ${plan.from === local ? 'this machine' : peerLabel}`;

    const result = await putState(plan.to.url, app, source.payload, targetVersion, by);
    const proj = (result.projection ?? {}) as Record<string, unknown>;
    if (proj.ok !== true) {
        throw new Error(
            `${plan.to.label} did not confirm its relational projection; ` +
            `agreement was NOT recorded: ${String(proj.error ?? 'missing projection result')}`
        );
    }
    console.log(`     written: ${plan.to.label} is now v${result.version}`);

    if (Array.isArray(proj.problems) && proj.problems.length) {
        console.log(`     WARNING: projection problems: ${proj.problems.slice(0, 3).join('; ')}`);
    }

    // Both machines now hold the source payload — that is the new agreement.
    const localVersion = plan.to === local ? result.version : (local.state as State).version;
    const peerVersion = plan.to === peer ? result.version : (peer.state as State).version;
    await writeWatermark(app, peerKey, hash(source.payload), localVersion, peerVersion);

    // After taking the peer's state, say so in the mailbox: that is what turns
    // a one-sided pull into a recorded agreement on the other machine too.
    if (MODE === 'folder' && plan.to === local) {
        mailboxPublish(app, { ...source, version: result.version });
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

    let peerName: string | null = null;
    if (MODE === 'folder') {
        peerName = mailboxPeerName();
        if (peerName === ME) {
            console.error(`\n--me is "${ME}", but that is also the folder being read as the peer.\nGive the two machines different names.\n`);
            await pool.end();
            process.exit(1);
        }
        console.log(`mailbox      : ${DIR}`);
        console.log(`this machine : writes ${ME}/`);
        console.log(`other machine: ${peerName ? `reads ${peerName}/` : '(has not published anything yet)'}`);
    } else {
        console.log(`peer         : ${PEER_URL}`);
        await assertDifferentMachines();
    }
    console.log(APPLY ? 'mode         : APPLY (writes)' : 'mode         : dry run');

    const results: string[] = [];
    for (const app of APPS) {
        try {
            results.push(await syncApp(app, peerName));
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

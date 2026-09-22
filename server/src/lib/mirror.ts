import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

export const MIRROR_FORMAT = 'mtb-cloud-mirror-v1';
export const MIRROR_FORMAT_VERSION = 1;

/**
 * Complete application data scope, deliberately explicit.
 *
 * A new base table makes snapshot creation fail until somebody decides whether
 * it is business data or installation-local state. Silent omission would make
 * a green sync report mean less every time the schema grows.
 */
export const MIRROR_TABLES = [
    'app_state',
    'assessments',
    'attendance',
    'audiograms',
    'bell_period_overrides',
    'bell_periods',
    'class_years',
    'diary_schedule',
    'diary_schedule_history',
    'employees',
    'employee_roles',
    'employee_identity_links',
    'employee_year_details',
    'evidence_contacts',
    'evidence_examiner_roles',
    'evidence_examiners',
    'evidence_groups',
    'evidence_items',
    'evidence_panels',
    'evidence_periods',
    'evidence_scores',
    'evidence_sections',
    'evidence_sheet_sections',
    'evidence_sheets',
    'lessons',
    'plan_activities',
    'plans',
    'resource_links',
    'scale_templates',
    'schedule_slots',
    'school_classes',
    'school_years',
    'specialist_categories',
    'student_enrollments',
    'student_plan_progress',
    'student_records',
    'students',
    'teacher_classes',
    'teacher_years',
    'teachers',
    'teaching_subjects',
    'therapist_students',
    'therapist_years',
    'therapists',
    'triage_tests'
] as const;

/** Never leave the cloud database: credentials, sessions, ledgers and local sync state. */
export const MIRROR_EXCLUDED_TABLES = [
    'evidence_logins',
    'evidence_sessions',
    'mirror_sync_attempt',
    'mirror_sync_state',
    'schema_migrations',
    'sync_watermark'
] as const;

export type MirrorColumn = {
    name: string;
    type: string;
    udt: string;
    nullable: boolean;
};

export type MirrorTable = {
    name: string;
    columns: MirrorColumn[];
    primaryKey: string[];
    rowCount: number;
    sha256: string;
    rows: Record<string, unknown>[];
};

export type MirrorSnapshot = {
    format: typeof MIRROR_FORMAT;
    formatVersion: typeof MIRROR_FORMAT_VERSION;
    snapshotId: string;
    contentHash: string;
    payloadHash: string;
    source: {
        id: string;
        database: string;
        schema: string;
        version: string;
        snapshotAt: string;
    };
    scope: {
        tables: string[];
        excludedTables: string[];
    };
    schemaMigrations: string[];
    tables: MirrorTable[];
};

export type MirrorTableDiff = {
    table: string;
    sourceRows: number;
    localRows: number;
    added: number;
    changed: number;
    deleted: number;
    sourceHash: string;
    localHash: string;
};

export type MirrorPlan = {
    snapshotId: string;
    sourceId: string;
    sourceVersion: string;
    snapshotAt: string;
    planHash: string;
    alreadyApplied: boolean;
    olderThanApplied: boolean;
    tables: MirrorTableDiff[];
    totals: { sourceRows: number; localRows: number; added: number; changed: number; deleted: number };
    localAuthRowsToClear: { evidenceLogins: number; evidenceSessions: number };
};

type Connectable = Pick<Pool, 'connect'>;

const TABLE_NAME = /^[a-z][a-z0-9_]*$/;
const SOURCE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const DIGITS = /^\d+$/;

function quoteIdent(value: string): string {
    if (!TABLE_NAME.test(value)) throw new Error(`Unsafe PostgreSQL identifier: ${value}`);
    return `"${value}"`;
}

function qualified(schema: string, table: string): string {
    return `${quoteIdent(schema)}.${quoteIdent(table)}`;
}

export function stableStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) =>
        `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(',')}}`;
}

export function sha256(value: unknown): string {
    return createHash('sha256').update(stableStringify(value), 'utf8').digest('hex');
}

function tablePayload(table: Pick<MirrorTable, 'name' | 'columns' | 'primaryKey' | 'rows'>) {
    return { name: table.name, columns: table.columns, primaryKey: table.primaryKey, rows: table.rows };
}

function snapshotPayload(snapshot: Omit<MirrorSnapshot, 'snapshotId' | 'payloadHash'> | MirrorSnapshot) {
    return {
        format: snapshot.format,
        formatVersion: snapshot.formatVersion,
        source: snapshot.source,
        scope: snapshot.scope,
        schemaMigrations: snapshot.schemaMigrations,
        tables: snapshot.tables
    };
}

/** Stable when only the observation time/version changes, unlike payloadHash. */
function snapshotContent(snapshot: Pick<MirrorSnapshot, 'format' | 'formatVersion' | 'scope' | 'schemaMigrations' | 'tables'>) {
    return {
        format: snapshot.format,
        formatVersion: snapshot.formatVersion,
        scope: snapshot.scope,
        schemaMigrations: snapshot.schemaMigrations,
        tables: snapshot.tables
    };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

function expectedBaseTables(): string[] {
    return [...MIRROR_TABLES, ...MIRROR_EXCLUDED_TABLES].sort();
}

type SchemaInfo = {
    schema: string;
    actualTables: string[];
    columns: Map<string, MirrorColumn[]>;
    primaryKeys: Map<string, string[]>;
};

async function readSchemaInfo(client: PoolClient): Promise<SchemaInfo> {
    const schema = String((await client.query('SELECT current_schema() AS name')).rows[0]?.name || '');
    if (!TABLE_NAME.test(schema)) throw new Error(`Unsupported PostgreSQL schema: ${schema || '(none)'}`);
    const actualTables = (await client.query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name`, [schema]
    )).rows.map((row) => String(row.table_name));
    const expected = expectedBaseTables();
    if (!sameStrings(actualTables, expected)) {
        const missing = expected.filter((name) => !actualTables.includes(name));
        const unknown = actualTables.filter((name) => !expected.includes(name));
        throw new Error(`Mirror schema scope mismatch; missing=[${missing.join(', ')}], unknown=[${unknown.join(', ')}]`);
    }

    const columns = new Map<string, MirrorColumn[]>();
    const columnRows = (await client.query(
        `SELECT table_name, column_name, data_type, udt_name, is_nullable
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = ANY($2::text[])
         ORDER BY table_name, ordinal_position`, [schema, [...MIRROR_TABLES]]
    )).rows;
    for (const row of columnRows) {
        const name = String(row.table_name);
        const list = columns.get(name) || [];
        list.push({
            name: String(row.column_name),
            type: String(row.data_type),
            udt: String(row.udt_name),
            nullable: row.is_nullable === 'YES'
        });
        columns.set(name, list);
    }

    const primaryKeys = new Map<string, string[]>();
    const pkRows = (await client.query(
        `SELECT table_name, array_agg(column_name::text ORDER BY ordinal_position)::text[] AS columns
         FROM information_schema.key_column_usage k
         JOIN information_schema.table_constraints c
           USING (constraint_catalog, constraint_schema, constraint_name, table_catalog, table_schema, table_name)
         WHERE k.table_schema = $1 AND c.constraint_type = 'PRIMARY KEY'
           AND k.table_name = ANY($2::text[])
         GROUP BY table_name ORDER BY table_name`, [schema, [...MIRROR_TABLES]]
    )).rows;
    for (const row of pkRows) primaryKeys.set(String(row.table_name), (row.columns as unknown[]).map(String));
    for (const table of MIRROR_TABLES) {
        if (!columns.get(table)?.length) throw new Error(`Mirror table has no readable columns: ${table}`);
        if (!primaryKeys.get(table)?.length) throw new Error(`Mirror table has no primary key: ${table}`);
    }
    return { schema, actualTables, columns, primaryKeys };
}

async function readRows(
    client: PoolClient,
    schema: string,
    table: string,
    primaryKey: string[]
): Promise<Record<string, unknown>[]> {
    const order = primaryKey.map(quoteIdent).join(', ');
    const result = await client.query(
        `SELECT row_to_json(t)::jsonb AS row FROM ${qualified(schema, table)} AS t ORDER BY ${order}`
    );
    return result.rows.map((entry) => entry.row as Record<string, unknown>);
}

function normalizeSourceId(value: string): string {
    const id = String(value || '').trim().toLowerCase();
    if (!SOURCE_ID.test(id)) throw new Error('Mirror source id must contain only lowercase letters, digits, _ or -');
    return id;
}

export async function createMirrorSnapshot(pool: Connectable, sourceId: string): Promise<MirrorSnapshot> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const source = (await client.query(
            `SELECT current_database() AS database,
                    clock_timestamp() AS snapshot_at,
                    txid_snapshot_xmax(txid_current_snapshot())::text AS version`
        )).rows[0];
        const schema = await readSchemaInfo(client);
        const schemaMigrations = (await client.query(
            `SELECT filename FROM ${qualified(schema.schema, 'schema_migrations')} ORDER BY filename`
        )).rows.map((row) => String(row.filename));
        const tables: MirrorTable[] = [];
        for (const name of MIRROR_TABLES) {
            const columns = schema.columns.get(name)!;
            const primaryKey = schema.primaryKeys.get(name)!;
            const rows = await readRows(client, schema.schema, name, primaryKey);
            const base = { name, columns, primaryKey, rows };
            tables.push({ ...base, rowCount: rows.length, sha256: sha256(tablePayload(base)) });
        }
        const contentHash = sha256(snapshotContent({
            format: MIRROR_FORMAT,
            formatVersion: MIRROR_FORMAT_VERSION,
            scope: { tables: [...MIRROR_TABLES], excludedTables: [...MIRROR_EXCLUDED_TABLES] },
            schemaMigrations,
            tables
        }));
        const core: Omit<MirrorSnapshot, 'snapshotId' | 'payloadHash'> = {
            format: MIRROR_FORMAT,
            formatVersion: MIRROR_FORMAT_VERSION,
            contentHash,
            source: {
                id: normalizeSourceId(sourceId),
                database: String(source.database),
                schema: schema.schema,
                version: String(source.version),
                snapshotAt: new Date(source.snapshot_at).toISOString()
            },
            scope: {
                tables: [...MIRROR_TABLES],
                excludedTables: [...MIRROR_EXCLUDED_TABLES]
            },
            schemaMigrations,
            tables
        };
        const payloadHash = sha256(snapshotPayload(core));
        const stamp = core.source.snapshotAt.replace(/[-:.TZ]/g, '').slice(0, 14);
        const snapshot: MirrorSnapshot = {
            ...core,
            snapshotId: `${core.source.id}-${stamp}-${payloadHash.slice(0, 16)}`,
            payloadHash
        };
        await client.query('COMMIT');
        return snapshot;
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

export function validateMirrorSnapshot(value: unknown): MirrorSnapshot {
    if (!value || typeof value !== 'object') throw new Error('Mirror snapshot is not an object');
    const snapshot = value as MirrorSnapshot;
    if (snapshot.format !== MIRROR_FORMAT || snapshot.formatVersion !== MIRROR_FORMAT_VERSION) {
        throw new Error('Unsupported mirror snapshot format');
    }
    if (!snapshot.source || !SOURCE_ID.test(snapshot.source.id) || !DIGITS.test(snapshot.source.version)) {
        throw new Error('Mirror snapshot source identity/version is invalid');
    }
    if (!Number.isFinite(Date.parse(snapshot.source.snapshotAt))) throw new Error('Mirror snapshot time is invalid');
    if (!snapshot.scope || !sameStrings(snapshot.scope.tables || [], [...MIRROR_TABLES]) ||
        !sameStrings(snapshot.scope.excludedTables || [], [...MIRROR_EXCLUDED_TABLES])) {
        throw new Error('Mirror snapshot scope does not match this application');
    }
    if (!Array.isArray(snapshot.schemaMigrations) || snapshot.schemaMigrations.some((name) =>
        typeof name !== 'string' || !/^\d{3}_[A-Za-z0-9_.-]+\.sql$/.test(name))) {
        throw new Error('Mirror snapshot migration ledger is invalid');
    }
    if (!Array.isArray(snapshot.tables) || snapshot.tables.length !== MIRROR_TABLES.length) {
        throw new Error('Mirror snapshot table collection is incomplete');
    }
    snapshot.tables.forEach((table, index) => {
        const expected = MIRROR_TABLES[index];
        if (!table || table.name !== expected || !Array.isArray(table.columns) || !Array.isArray(table.primaryKey) ||
            !Array.isArray(table.rows) || table.primaryKey.length === 0) {
            throw new Error(`Mirror snapshot table ${expected} is invalid`);
        }
        const columnNames = table.columns.map((column) => column.name);
        if (columnNames.some((name) => !TABLE_NAME.test(name)) ||
            table.primaryKey.some((name) => !columnNames.includes(name))) {
            throw new Error(`Mirror snapshot table ${expected} has invalid columns`);
        }
        if (table.rowCount !== table.rows.length || table.sha256 !== sha256(tablePayload(table))) {
            throw new Error(`Mirror snapshot table ${expected} failed its integrity check`);
        }
    });
    if (!SHA256.test(snapshot.payloadHash) || snapshot.payloadHash !== sha256(snapshotPayload(snapshot))) {
        throw new Error('Mirror snapshot payload integrity check failed');
    }
    if (!SHA256.test(snapshot.contentHash) || snapshot.contentHash !== sha256(snapshotContent(snapshot))) {
        throw new Error('Mirror snapshot content integrity check failed');
    }
    const stamp = snapshot.source.snapshotAt.replace(/[-:.TZ]/g, '').slice(0, 14);
    if (snapshot.snapshotId !== `${snapshot.source.id}-${stamp}-${snapshot.payloadHash.slice(0, 16)}`) {
        throw new Error('Mirror snapshot id does not match its content');
    }
    return snapshot;
}

function rowKey(row: Record<string, unknown>, primaryKey: string[]): string {
    return stableStringify(primaryKey.map((column) => row[column]));
}

function diffRows(localRows: Record<string, unknown>[], source: MirrorTable) {
    const local = new Map(localRows.map((row) => [rowKey(row, source.primaryKey), stableStringify(row)]));
    const remote = new Map(source.rows.map((row) => [rowKey(row, source.primaryKey), stableStringify(row)]));
    let added = 0, changed = 0, deleted = 0;
    for (const [key, value] of remote) {
        if (!local.has(key)) added++;
        else if (local.get(key) !== value) changed++;
    }
    for (const key of local.keys()) if (!remote.has(key)) deleted++;
    return { added, changed, deleted };
}

function assertCompatibleSchema(snapshot: MirrorSnapshot, schema: SchemaInfo): void {
    snapshot.tables.forEach((table) => {
        if (!sameStrings(table.primaryKey, schema.primaryKeys.get(table.name) || []) ||
            stableStringify(table.columns) !== stableStringify(schema.columns.get(table.name) || [])) {
            throw new Error(`Target schema is incompatible for table ${table.name}`);
        }
    });
}

async function buildPlan(client: PoolClient, snapshot: MirrorSnapshot): Promise<MirrorPlan> {
    const schema = await readSchemaInfo(client);
    assertCompatibleSchema(snapshot, schema);
    const migrations = (await client.query(
        `SELECT filename FROM ${qualified(schema.schema, 'schema_migrations')} ORDER BY filename`
    )).rows.map((row) => String(row.filename));
    if (!sameStrings(snapshot.schemaMigrations, migrations)) {
        throw new Error('Target migration ledger differs from the snapshot source');
    }

    const state = (await client.query(
        `SELECT snapshot_id, source_version::text, source_snapshot_at, content_hash, payload_hash
         FROM ${qualified(schema.schema, 'mirror_sync_state')} WHERE source_id = $1`, [snapshot.source.id]
    )).rows[0];
    const olderThanApplied = Boolean(state && (
        BigInt(snapshot.source.version) < BigInt(state.source_version) ||
        (BigInt(snapshot.source.version) === BigInt(state.source_version) &&
            Date.parse(snapshot.source.snapshotAt) < new Date(state.source_snapshot_at).getTime())
    ));
    // xmax is a transaction watermark, not a commit counter: an already-open
    // transaction can commit between two observations with the same xmax.
    if (state && BigInt(snapshot.source.version) === BigInt(state.source_version) &&
        Date.parse(snapshot.source.snapshotAt) === new Date(state.source_snapshot_at).getTime() &&
        state.content_hash !== snapshot.contentHash) {
        throw new Error('Source version was reused with different snapshot content');
    }
    const alreadyApplied = Boolean(state && state.content_hash === snapshot.contentHash);
    const tables: MirrorTableDiff[] = [];
    for (const sourceTable of snapshot.tables) {
        const localRows = await readRows(client, schema.schema, sourceTable.name, sourceTable.primaryKey);
        const diff = diffRows(localRows, sourceTable);
        const localBase = {
            name: sourceTable.name,
            columns: sourceTable.columns,
            primaryKey: sourceTable.primaryKey,
            rows: localRows
        };
        tables.push({
            table: sourceTable.name,
            sourceRows: sourceTable.rows.length,
            localRows: localRows.length,
            ...diff,
            sourceHash: sourceTable.sha256,
            localHash: sha256(tablePayload(localBase))
        });
    }
    const auth = (await client.query(
        `SELECT
           (SELECT count(*)::int FROM ${qualified(schema.schema, 'evidence_logins')}) AS logins,
           (SELECT count(*)::int FROM ${qualified(schema.schema, 'evidence_sessions')}) AS sessions`
    )).rows[0];
    const totals = tables.reduce((sum, table) => ({
        sourceRows: sum.sourceRows + table.sourceRows,
        localRows: sum.localRows + table.localRows,
        added: sum.added + table.added,
        changed: sum.changed + table.changed,
        deleted: sum.deleted + table.deleted
    }), { sourceRows: 0, localRows: 0, added: 0, changed: 0, deleted: 0 });
    const localAuthRowsToClear = { evidenceLogins: Number(auth.logins), evidenceSessions: Number(auth.sessions) };
    const planCore = {
        snapshotId: snapshot.snapshotId,
        sourceId: snapshot.source.id,
        sourceVersion: snapshot.source.version,
        tables,
        totals,
        localAuthRowsToClear
    };
    return {
        snapshotId: snapshot.snapshotId,
        sourceId: snapshot.source.id,
        sourceVersion: snapshot.source.version,
        snapshotAt: snapshot.source.snapshotAt,
        planHash: sha256(planCore),
        alreadyApplied,
        olderThanApplied,
        tables,
        totals,
        localAuthRowsToClear
    };
}

export async function planMirror(pool: Connectable, input: unknown): Promise<MirrorPlan> {
    const snapshot = validateMirrorSnapshot(input);
    const client = await pool.connect();
    try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const plan = await buildPlan(client, snapshot);
        await client.query('COMMIT');
        return plan;
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

async function insertionOrder(client: PoolClient, schema: string): Promise<string[]> {
    const dependencies = new Map<string, Set<string>>(
        MIRROR_TABLES.map((table) => [table, new Set<string>()])
    );
    const rows = (await client.query(
        `SELECT child.relname AS child, parent.relname AS parent
         FROM pg_constraint fk
         JOIN pg_class child ON child.oid = fk.conrelid
         JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
         JOIN pg_class parent ON parent.oid = fk.confrelid
         JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
         WHERE fk.contype = 'f' AND child_ns.nspname = $1 AND parent_ns.nspname = $1`, [schema]
    )).rows;
    for (const row of rows) {
        const child = String(row.child), parent = String(row.parent);
        if (dependencies.has(child) && dependencies.has(parent) && child !== parent) dependencies.get(child)!.add(parent);
    }
    const order: string[] = [];
    const remaining = new Map([...dependencies].map(([table, parents]) => [table, new Set(parents)]));
    while (remaining.size) {
        const ready = [...remaining].filter(([, parents]) => parents.size === 0).map(([table]) => table).sort();
        if (!ready.length) throw new Error(`Mirror table foreign keys contain a cycle: ${[...remaining.keys()].join(', ')}`);
        for (const table of ready) {
            order.push(table);
            remaining.delete(table);
            for (const parents of remaining.values()) parents.delete(table);
        }
    }
    return order;
}

export type ApplyMirrorOptions = {
    expectedSnapshotId: string;
    expectedPlanHash: string;
    allowedLargeDeleteCount?: number;
};

async function recordMirrorSuccess(client: PoolClient, schema: string, snapshot: MirrorSnapshot): Promise<void> {
    const counts = Object.fromEntries(snapshot.tables.map((table) => [table.name, table.rowCount]));
    await client.query(
        `INSERT INTO ${qualified(schema, 'mirror_sync_state')}
            (source_id, snapshot_id, source_version, source_snapshot_at, content_hash, payload_hash,
             format_version, table_counts, applied_at)
         VALUES ($1, $2, $3::bigint, $4::timestamptz, $5, $6, $7, $8::jsonb, now())
         ON CONFLICT (source_id) DO UPDATE SET
            snapshot_id = EXCLUDED.snapshot_id,
            source_version = EXCLUDED.source_version,
            source_snapshot_at = EXCLUDED.source_snapshot_at,
            content_hash = EXCLUDED.content_hash,
            payload_hash = EXCLUDED.payload_hash,
            format_version = EXCLUDED.format_version,
            table_counts = EXCLUDED.table_counts,
            applied_at = now()`,
        [snapshot.source.id, snapshot.snapshotId, snapshot.source.version, snapshot.source.snapshotAt,
            snapshot.contentHash, snapshot.payloadHash, snapshot.formatVersion, JSON.stringify(counts)]
    );
    await client.query(
        `INSERT INTO ${qualified(schema, 'mirror_sync_attempt')}
            (source_id, attempted_at, succeeded, error_code)
         VALUES ($1, now(), true, NULL)
         ON CONFLICT (source_id) DO UPDATE SET
            attempted_at = now(), succeeded = true, error_code = NULL`,
        [snapshot.source.id]
    );
}

export async function applyMirrorSnapshot(
    pool: Connectable,
    input: unknown,
    options: ApplyMirrorOptions
): Promise<{ applied: boolean; plan: MirrorPlan }> {
    const snapshot = validateMirrorSnapshot(input);
    if (options.expectedSnapshotId !== snapshot.snapshotId) throw new Error('Exact snapshot id confirmation does not match');
    const client = await pool.connect();
    try {
        await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        await client.query("SET LOCAL mtb.mirror_apply = 'on'");
        await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [MIRROR_FORMAT]);
        await client.query(`SET LOCAL lock_timeout = '10s'`);
        await client.query(`SET LOCAL statement_timeout = '120s'`);
        const plan = await buildPlan(client, snapshot);
        if (plan.olderThanApplied) throw new Error('Older mirror snapshot refused');
        if (plan.planHash !== options.expectedPlanHash) {
            throw new Error(`Mirror target changed since dry-run; expected plan ${options.expectedPlanHash}, now ${plan.planHash}`);
        }
        const largeDelete = plan.totals.deleted > 10 &&
            plan.totals.deleted > Math.floor(plan.totals.localRows * 0.20);
        if (largeDelete && options.allowedLargeDeleteCount !== plan.totals.deleted) {
            throw new Error(`Large deletion refused; confirm exactly ${plan.totals.deleted} deletions`);
        }
        if (plan.alreadyApplied && plan.totals.added === 0 && plan.totals.changed === 0 && plan.totals.deleted === 0) {
            const schema = await readSchemaInfo(client);
            await recordMirrorSuccess(client, schema.schema, snapshot);
            await client.query('COMMIT');
            return { applied: false, plan };
        }

        const schema = await readSchemaInfo(client);
        const order = await insertionOrder(client, schema.schema);
        // Local PIN hashes and live sessions are installation credentials, not
        // cloud business data. A mirror is read-only and starts without them.
        await client.query(`DELETE FROM ${qualified(schema.schema, 'evidence_sessions')}`);
        await client.query(`DELETE FROM ${qualified(schema.schema, 'evidence_logins')}`);
        for (const table of [...order].reverse()) {
            await client.query(`DELETE FROM ${qualified(schema.schema, table)}`);
        }
        const byName = new Map(snapshot.tables.map((table) => [table.name, table]));
        for (const tableName of order) {
            const table = byName.get(tableName)!;
            const columnNames = table.columns.map((column) => column.name);
            const sql = `INSERT INTO ${qualified(schema.schema, tableName)} (${columnNames.map(quoteIdent).join(', ')}) ` +
                `VALUES (${columnNames.map((_, index) => `$${index + 1}`).join(', ')})`;
            for (const row of table.rows) await client.query(sql, columnNames.map((column) => row[column]));
        }

        // Verify every table before the data and success marker become visible.
        for (const table of snapshot.tables) {
            const rows = await readRows(client, schema.schema, table.name, table.primaryKey);
            const actual = sha256(tablePayload({
                name: table.name,
                columns: table.columns,
                primaryKey: table.primaryKey,
                rows
            }));
            if (actual !== table.sha256) throw new Error(`Applied mirror verification failed for ${table.name}`);
        }
        await recordMirrorSuccess(client, schema.schema, snapshot);
        await client.query('COMMIT');
        return { applied: true, plan };
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

export async function mirrorStatus(pool: Pick<Pool, 'query'>, sourceLabel: string) {
    const rows = await pool.query(
        `SELECT source_id, snapshot_id, source_version::text, source_snapshot_at,
                content_hash, payload_hash, format_version, table_counts, applied_at
         FROM mirror_sync_state ORDER BY applied_at DESC LIMIT 1`
    );
    const state = rows.rows[0];
    const attempt = (await pool.query(
        `SELECT source_id, attempted_at, succeeded, error_code
         FROM mirror_sync_attempt ORDER BY attempted_at DESC LIMIT 1`
    )).rows[0];
    return {
        mode: 'readonly',
        source: sourceLabel,
        ...(attempt ? {
            lastAttemptAt: new Date(attempt.attempted_at).toISOString(),
            ...(attempt.succeeded ? {} : { lastError: String(attempt.error_code || 'sync_failed') })
        } : {}),
        ...(state ? {
            sourceId: state.source_id,
            snapshotId: state.snapshot_id,
            sourceVersion: state.source_version,
            dataAt: new Date(state.source_snapshot_at).toISOString(),
            lastAppliedAt: new Date(state.applied_at).toISOString(),
            contentHash: state.content_hash,
            payloadHash: state.payload_hash,
            formatVersion: state.format_version,
            tableCounts: state.table_counts
        } : { pending: true })
    };
}

/** Record only a coarse local status code; never persist provider/row errors. */
export async function recordMirrorFailure(
    pool: Pick<Pool, 'query'>,
    sourceId: string,
    errorCode: 'download_failed' | 'safety_refusal' | 'apply_failed'
): Promise<void> {
    await pool.query(
        `INSERT INTO mirror_sync_attempt(source_id, attempted_at, succeeded, error_code)
         VALUES($1, now(), false, $2)
         ON CONFLICT (source_id) DO UPDATE SET
            attempted_at = now(), succeeded = false, error_code = EXCLUDED.error_code`,
        [normalizeSourceId(sourceId), errorCode]
    );
}

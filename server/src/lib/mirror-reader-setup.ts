import { MIRROR_TABLES } from './mirror.js';

const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
// These views only read mirrored business tables. They need their own SELECT
// grants; pg_tables does not include them, and table grants do not cover views.
export const MIRROR_READER_VIEWS = ['schedule_conflicts', 'teaching_clashes'] as const;
export function mirrorReaderSettings(env: NodeJS.ProcessEnv) {
    const reader = new URL(env.MTB_MIRROR_READER_DATABASE_URL || '');
    const writer = new URL(env.MTB_MIRROR_TARGET_DATABASE_URL || '');
    const active = new URL(env.DATABASE_URL || '');
    for (const u of [reader, writer, active]) {
        if (!['postgres:', 'postgresql:'].includes(u.protocol) || !localHosts.has(u.hostname)) {
            throw new Error('Only an explicit local PostgreSQL installation is allowed');
        }
        if ((u.port || '5432') !== (reader.port || '5432')) throw new Error('Local database ports differ');
    }
    const database = decodeURIComponent(reader.pathname.slice(1));
    const role = decodeURIComponent(reader.username);
    if (!/^[a-z][a-z0-9_]*_mirror$/.test(database) || database !== env.MTB_MIRROR_TARGET_DATABASE ||
        decodeURIComponent(writer.pathname.slice(1)) !== database ||
        decodeURIComponent(active.pathname.slice(1)) === database) throw new Error('Separate *_mirror target required');
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(role) || ['postgres', 'public'].includes(role) ||
        role === decodeURIComponent(writer.username) || role === decodeURIComponent(active.username)) {
        throw new Error('Reader must be a distinct, ordinary role');
    }
    const password = decodeURIComponent(reader.password);
    if (password.length < 32 || /[\x00-\x20\x7f]/.test(password) || /REPLACE|PASSWORD/i.test(password)) {
        throw new Error('Configured reader password must be a private strong secret');
    }
    return { database, role, password, reader, writer };
}

export function readerStatements(settings: ReturnType<typeof mirrorReaderSettings>, tables: string[], views: string[] = []) {
    const allowed = new Set<string>([...MIRROR_TABLES, 'schema_migrations', 'mirror_sync_state', 'mirror_sync_attempt']);
    const names = tables.filter(t => allowed.has(t));
    if (!names.includes('schema_migrations') || !names.includes('app_state')) throw new Error('Mirror schema missing');
    const { role, password, database } = settings;
    const literal = password.replace(/'/g, "''");
    return [
        `CREATE ROLE ${role} LOGIN PASSWORD '${literal}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
        `ALTER ROLE ${role} SET default_transaction_read_only = on`,
        `GRANT CONNECT ON DATABASE ${database} TO ${role}`,
        `GRANT USAGE ON SCHEMA public TO ${role}`,
        ...names.flatMap(name => [
            `GRANT SELECT ON TABLE public."${name}" TO ${role}`,
            // A SELECT grant alone returns zero rows on the RLS-enabled staff tables.
            `CREATE POLICY mtb_mirror_reader_select ON public."${name}" FOR SELECT TO ${role} USING (true)`
        ]),
        ...readerViewStatements(role, views)
    ];
}

/** The view grants alone: what a reader made before the views were listed still lacks. */
export function readerViewStatements(role: string, views: string[]) {
    return views.filter(name => (MIRROR_READER_VIEWS as readonly string[]).includes(name))
        .map(name => `GRANT SELECT ON TABLE public."${name}" TO ${role}`);
}

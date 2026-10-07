/** Explicit, one-time local reader provisioning. No migrations, copies or data writes. */
import 'dotenv/config';
import pg from 'pg';
import { MIRROR_READER_VIEWS, mirrorReaderSettings, readerStatements, readerViewStatements } from '../src/lib/mirror-reader-setup.js';

const apply = process.argv.includes('--apply');
// --views: an EXISTING reader gets SELECT on the business views it cannot read
// yet. Nothing else about the account changes: no password, no table grant.
const viewsOnly = process.argv.includes('--views');
// Exit 3 tells the PowerShell wrapper "ask for the postgres password and try again".
const NEEDS_SUPERUSER = 3;
let client: pg.Client | undefined;
let committed = false;
let needsSuperuser = false;
try {
    const settings = mirrorReaderSettings(process.env);
    const admin = process.env.MTB_MIRROR_ADMIN_DATABASE_URL;
    if (apply && !admin && !viewsOnly) throw new Error('Use scripts/setup-mirror-reader.ps1 -Apply to enter the local postgres password privately');
    const url = new URL(admin || settings.writer.href);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
        !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
        (url.port || '5432') !== (settings.reader.port || '5432') ||
        decodeURIComponent(url.pathname.slice(1)) !== settings.database) throw new Error('Admin target is not the same local mirror');
    client = new pg.Client({ connectionString: url.href, connectionTimeoutMillis: 5000, query_timeout: 10000 });
    await client.connect();
    await client.query(apply ? 'BEGIN' : 'BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '10s'");
    const identity = (await client.query('SELECT current_database() AS db, rolsuper FROM pg_roles WHERE rolname=current_user')).rows[0];
    if (identity.db !== settings.database) throw new Error('Connected database differs from reviewed mirror');
    const exists = (await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [settings.role])).rowCount;
    const tables = (await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(r=>r.tablename as string);
    const views = (await client.query("SELECT viewname FROM pg_views WHERE schemaname='public' ORDER BY viewname")).rows.map(r=>r.viewname as string);
    const ledger = (await client.query('SELECT count(*)::int AS count,max(filename) AS latest FROM public.schema_migrations')).rows[0];
    const statements = readerStatements(settings, tables, views);
    const selected = statements.filter(s=>s.startsWith('GRANT SELECT')).map(s=>s.match(/public\."([a-z_]+)"/)![1]);
    // A reader made before the views were listed reads every table and still fails the screens that ask a view.
    const missingViews: { relname: string; mine: boolean }[] = exists ? (await client.query(
        `SELECT c.relname, pg_get_userbyid(c.relowner) = current_user AS mine
           FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND c.relkind='v' AND c.relname = ANY($1)
            AND NOT has_table_privilege($2, c.oid, 'SELECT') ORDER BY c.relname`,
        [[...MIRROR_READER_VIEWS], settings.role])).rows : [];
    console.log(JSON.stringify({ mode: (apply ? 'apply' : 'dry-run') + (viewsOnly ? ' (views only)' : ''), database: settings.database,
        reader: settings.role, roleExists: !!exists, migrations: ledger,
        selectedTables: selected.filter(name=>tables.includes(name)).length,
        selectedViews: selected.filter(name=>views.includes(name)).length,
        missingViews: missingViews.map(r=>r.relname) }));
    if (!apply) {
        await client.query('ROLLBACK');
        console.log(missingViews.length
            ? 'No changes. The existing reader cannot read the view(s) above: run scripts/setup-mirror-reader.ps1 -Views -Apply.'
            : exists ? 'No changes. The reader exists and reads every business view.'
            : 'No changes. Apply needs a local superuser, prompted by the PowerShell wrapper.');
    } else if (viewsOnly) {
        if (!exists) throw new Error('Reader does not exist yet: run without -Views to create it');
        if (!missingViews.length) {
            await client.query('ROLLBACK');
            console.log('The reader already reads every business view. No changes.');
        } else {
            if (!identity.rolsuper && missingViews.some(r=>!r.mine)) {
                needsSuperuser = true;
                throw new Error('The views belong to another role; the local postgres superuser has to grant them');
            }
            for (const sql of readerViewStatements(settings.role, missingViews.map(r=>r.relname))) await client.query(sql);
            // By name, not SET ROLE: the views' owner is not a member of the reader. A GRANT
            // the caller may not give is only a WARNING, so the outcome is what gets checked.
            const after: { relname: string; reads: boolean; writes: boolean }[] = (await client.query(
                `SELECT c.relname, has_table_privilege($1, c.oid, 'SELECT') AS reads,
                        has_table_privilege($1, c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS writes
                   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                  WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f')`, [settings.role])).rows;
            if (missingViews.some(v=>!after.find(r=>r.relname === v.relname)?.reads)) throw new Error('The grant did not take effect; rolling back');
            if (after.some(r=>r.writes)) throw new Error('Reader holds write privileges; rolling back');
            if (after.some(r=>r.reads && !selected.includes(r.relname))) throw new Error('Unexpected readable objects outside mirror scope; rolling back');
            await client.query('COMMIT');
            committed = true;
            console.log('Reader may now read: ' + missingViews.map(r=>r.relname).join(', ') + '. The account, its password and every table grant are unchanged.');
            const reader = new pg.Client({ connectionString: settings.reader.href, connectionTimeoutMillis: 5000, query_timeout: 10000 });
            try {
                await reader.connect();
                for (const view of missingViews) await reader.query(`SELECT count(*) FROM public."${view.relname}"`);
                console.log('Configured reader login verified: it reads the view(s).');
            } finally { await reader.end(); }
        }
    } else {
        if (!identity.rolsuper) throw new Error('A local PostgreSQL superuser is required; no privileges will be escalated');
        if (exists) throw new Error('Reader already exists: refusing to reset its password or change an existing account');
        const counts = new Map<string, string>();
        for (const table of selected) counts.set(table, (await client.query(`SELECT count(*) AS n FROM public."${table}"`)).rows[0].n);
        await client.query("SET LOCAL standard_conforming_strings = on");
        for (const sql of statements) await client.query(sql);
        await client.query(`SET LOCAL ROLE ${settings.role}`);
        const writable = (await client.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f')
              AND has_table_privilege(c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')`)).rows;
        if (writable.length) throw new Error('Reader inherited write privileges; rolling back all setup');
        if ((await client.query("SELECT has_schema_privilege('public','CREATE') AS allowed")).rows[0].allowed) {
            throw new Error('Reader inherits schema creation rights; rolling back all setup');
        }
        for (const table of selected) {
            const n = (await client.query(`SELECT count(*) AS n FROM public."${table}"`)).rows[0].n;
            if (n !== counts.get(table)) throw new Error('Reader cannot see the complete mirrored records; rolling back all setup');
        }
        const unexpected = (await client.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f') AND has_table_privilege(c.oid,'SELECT')`)).rows
            .filter(r=>!selected.includes(r.relname));
        if (unexpected.length) throw new Error('Unexpected readable objects outside mirror scope; rolling back all setup');
        await client.query('RESET ROLE');
        await client.query('COMMIT');
        committed = true;
        console.log('Reader created and SELECT access verified. No business records, migrations, configuration files or other databases changed.');
        const reader = new pg.Client({ connectionString: settings.reader.href, connectionTimeoutMillis: 5000, query_timeout: 10000 });
        try {
            await reader.connect();
            const r = await reader.query('SHOW default_transaction_read_only');
            if (r.rows[0].default_transaction_read_only !== 'on') throw new Error('Reader default is not read-only');
            console.log('Configured reader login verified; default transactions are read-only.');
        } finally { await reader.end(); }
    }
} catch (error) {
    await client?.query('ROLLBACK').catch(()=>{});
    // SQL and connection strings can contain passwords: never print the raw error.
    const code = (error as { code?: string }).code;
    if (committed) console.error(viewsOnly
        ? 'The view grants were committed, but the fresh-login check failed.'
        : 'Account and read grants were committed, but the fresh-login check failed. No server was started.');
    console.error(code ? `Reader setup refused (${code}); inspect local PostgreSQL access.` : (error as Error).message);
    process.exitCode = needsSuperuser ? NEEDS_SUPERUSER : 1;
} finally { await client?.end(); }

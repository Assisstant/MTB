/**
 * npm run check:organization
 *
 * READ-ONLY PREFLIGHT for the organisation model, across EVERY school year:
 *
 *   • паралелка со повеќе од еден раководител;
 *   • наставник со раководство во повеќе паралелки во иста година;
 *   • повторена категорија по профил и по потврдено лице — ИНФОРМАТИВНО.
 *
 * There is no `--apply`, and there must never be one. Nothing here issues DDL,
 * a backfill, a correction or an identity link: every line it prints is either
 * a decision for a person or a change of code, which is the same reason
 * `check:consistency` has no write mode either.
 *
 * ONE SNAPSHOT. All reads run inside a single
 * `REPEATABLE READ, READ ONLY` transaction, so the counts in the report belong
 * to one moment. A report assembled from several moments can contradict itself
 * while every individual query was right.
 *
 * SCHEMA SCOPE. It reads only what the current `search_path` resolves, and it
 * never migrates or inspects another schema. On a database at migration 032
 * `employees` does not exist, so linking a teaching profile to a therapy
 * profile is UNAVAILABLE — reported as such, never as zero, and never guessed
 * from equal names (rule 2).
 *
 * PRIVACY. Installation, database name, schema version, year labels, counts
 * and technical ids only. No person names, no credentials, no DATABASE_URL.
 *
 * EXIT CODES, deliberately three:
 *   0  the read succeeded and no homeroom finding stands
 *   1  a homeroom finding — one of the two contradictions above
 *   2  an operational failure: no connection, missing tables, no school year.
 *      A failure to LOOK must never be printed as "нема неправилности"; that
 *      mistake has already been paid for once in `sync-peer`.
 */

import { pool } from '../src/db.js';
import { resolveServerIdentity } from '../src/lib/server-identity.js';
import {
    analyzeOrganization,
    exitCodeFor,
    formatOrganizationReport,
    readOrganization,
    EXIT,
    OrganizationReadError
} from '../src/lib/organization-check.js';

const argv = process.argv.slice(2);
if (argv.includes('--apply')) {
    console.error('\nОваа проверка само чита. `--apply` не постои и не смее да постои.\n');
    process.exit(EXIT.operational);
}

let code = EXIT.operational;
try {
    const client = await pool.connect();
    try {
        await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const input = await readOrganization((sql, params) => client.query(sql, params as any[]));
        const report = analyzeOrganization(input);
        const identity = resolveServerIdentity();
        for (const line of formatOrganizationReport(input, report, identity)) console.log(line);
        code = exitCodeFor(report);
    } finally {
        // ROLLBACK rather than COMMIT: the transaction wrote nothing, and
        // saying so in the code is cheaper than proving it later.
        await client.query('ROLLBACK').catch(() => {});
        client.release();
    }
} catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('\n✗ ОПЕРАТИВНА ГРЕШКА — проверката НЕ се изврши.');
    console.error(`  ${message}`);
    if (!(error instanceof OrganizationReadError)) {
        console.error('  Провери дали локалната база работи и дали `server/.env` е поставен.');
    }
    console.error('  Ова НЕ значи дека нема неправилности — значи дека не беа прочитани.\n');
    code = EXIT.operational;
} finally {
    await pool.end().catch(() => {});
}

process.exit(code);

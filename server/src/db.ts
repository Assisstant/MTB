import pg from 'pg';
import 'dotenv/config';
import { mirrorMode } from './lib/mirror-config.js';

// Return DATE columns as plain 'YYYY-MM-DD' strings instead of JS Date
// objects. A Date is built at LOCAL midnight, so any later toISOString()
// shifts it into the previous day in any timezone east of UTC — which
// silently moved every attendance and assessment date by one day.
// Calendar dates here have no time or zone; keeping them as text says so.
pg.types.setTypeParser(1082, (value) => value);

export function databasePoolOptions(env: NodeJS.ProcessEnv = process.env): pg.PoolConfig {
    const connectionString = env.DATABASE_URL;
    if (mirrorMode(env) !== 'readonly') return { connectionString };

    // This is below the HTTP controls: every ordinary application connection
    // is transaction-read-only, so an import script or a forgotten endpoint
    // cannot write merely because its button was not hidden. The mirror puller
    // uses a separate, explicit writer connection and never imports this pool.
    let inherited = '';
    try {
        inherited = connectionString ? new URL(connectionString).searchParams.get('options') || '' : '';
    } catch { /* pg will report a malformed DATABASE_URL in the usual way */ }
    const options = `${inherited} -c default_transaction_read_only=on`.trim();
    // node-postgres gives URL options precedence over config.options.
    const url = connectionString ? new URL(connectionString) : null;
    if (url) url.searchParams.set('options', options);
    return { connectionString: url?.href, options };
}

export const pool = new pg.Pool(databasePoolOptions());

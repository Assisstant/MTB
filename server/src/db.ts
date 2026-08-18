import pg from 'pg';
import 'dotenv/config';

// Return DATE columns as plain 'YYYY-MM-DD' strings instead of JS Date
// objects. A Date is built at LOCAL midnight, so any later toISOString()
// shifts it into the previous day in any timezone east of UTC — which
// silently moved every attendance and assessment date by one day.
// Calendar dates here have no time or zone; keeping them as text says so.
pg.types.setTypeParser(1082, (value) => value);

export const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL
});

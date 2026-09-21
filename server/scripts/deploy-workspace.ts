import pg from 'pg';
import {fileURLToPath} from 'node:url';
import {workspaceRelease} from '../src/lib/workspace-release.js';
// Explicit deployed environment only: no dotenv and no local database fallback.
if(!process.env.DATABASE_URL)throw Error('DATABASE_URL is required');
const client=new pg.Client({connectionString:process.env.DATABASE_URL});
try{await client.connect();await workspaceRelease(client,fileURLToPath(new URL('../../database/migrations/',import.meta.url)));}
catch(error){console.error(error instanceof Error?error.message:'Workspace upgrade failed');process.exitCode=1;}
finally{await client.end();}

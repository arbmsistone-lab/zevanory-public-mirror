import {readFile} from 'node:fs/promises';
import {Pool} from '@neondatabase/serverless';
if(process.env.ZEVANORY_APPLY_MIGRATION_025!=='YES')throw new Error('migration_025_not_authorized');
if(!process.env.DATABASE_URL)throw new Error('database_url_required');
const sql=await readFile(new URL('../db/migrations/025_commercial_engine_v2.sql',import.meta.url),'utf8');
const pool=new Pool({connectionString:process.env.DATABASE_URL});const client=await pool.connect();
try{await client.query(sql);const m=await client.query("select migration_id from schema_migrations where migration_id='025_commercial_engine_v2'");if(m.rowCount!==1)throw new Error('migration_025_verification_failed');console.log(JSON.stringify({ok:true,migration:'025_commercial_engine_v2'}));}finally{client.release();await pool.end();}

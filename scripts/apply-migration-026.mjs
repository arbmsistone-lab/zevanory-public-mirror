import {readFile} from 'node:fs/promises';
import {Pool} from '@neondatabase/serverless';
if(process.env.ZEVANORY_APPLY_MIGRATION_026!=='YES')throw new Error('migration_026_not_authorized');
if(!process.env.DATABASE_URL)throw new Error('database_url_required');
const sql=await readFile(new URL('../db/migrations/026_media_investment_telemetry.sql',import.meta.url),'utf8');
const pool=new Pool({connectionString:process.env.DATABASE_URL});const client=await pool.connect();
try{await client.query(sql);const m=await client.query("select migration_id from schema_migrations where migration_id='026_media_investment_telemetry'");if(m.rowCount!==1)throw new Error('migration_026_verification_failed');console.log(JSON.stringify({ok:true,migration:'026_media_investment_telemetry'}));}finally{client.release();await pool.end();}

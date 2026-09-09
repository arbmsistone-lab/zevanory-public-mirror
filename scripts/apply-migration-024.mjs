import {readFile} from 'node:fs/promises';
import {Pool} from '@neondatabase/serverless';
if(process.env.ZEVANORY_APPLY_MIGRATION_024!=='YES')throw new Error('migration_024_not_authorized');
if(!process.env.DATABASE_URL)throw new Error('database_url_required');
const sql=await readFile(new URL('../db/migrations/024_market_product_intelligence.sql',import.meta.url),'utf8');
const pool=new Pool({connectionString:process.env.DATABASE_URL});const client=await pool.connect();
try{await client.query(sql);const t=await client.query("select to_regclass('public.intelligence_snapshots') as table_name");const m=await client.query("select migration_id from schema_migrations where migration_id='024_market_product_intelligence'");if(!t.rows[0]?.table_name||m.rowCount!==1)throw new Error('migration_024_verification_failed');console.log(JSON.stringify({ok:true,migration:'024_market_product_intelligence',table:'intelligence_snapshots'}));}finally{client.release();await pool.end();}

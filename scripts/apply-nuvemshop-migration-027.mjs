import {readFile} from 'node:fs/promises';
import {Pool} from '@neondatabase/serverless';
if(process.env.ZEVANORY_APPLY_NUVEMSHOP_MIGRATION_027!=='YES')throw new Error('migration_027_not_authorized');
if(!process.env.DATABASE_URL)throw new Error('database_url_required');
const sql=await readFile(new URL('../db/migrations/027_nuvemshop_integration_security.sql',import.meta.url),'utf8');
const pool=new Pool({connectionString:process.env.DATABASE_URL});const client=await pool.connect();
try{await client.query(sql);const m=await client.query("select migration_id from schema_migrations where migration_id='027_nuvemshop_integration_security'");if(m.rowCount!==1)throw new Error('migration_027_verification_failed');const tables=await client.query("select count(*)::int as count from information_schema.tables where table_schema='public' and table_name in ('nuvemshop_oauth_sessions','nuvemshop_pending_credentials','nuvemshop_connections','nuvemshop_webhook_receipts')");if(tables.rows[0]?.count!==4)throw new Error('migration_027_tables_missing');console.log(JSON.stringify({ok:true,migration:'027_nuvemshop_integration_security',tables:4}));}catch{await client.query('rollback').catch(()=>{});throw new Error('migration_027_failed');}finally{client.release();await pool.end();}

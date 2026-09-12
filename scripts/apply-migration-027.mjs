import { readFile } from 'node:fs/promises';
import { Pool } from '@neondatabase/serverless';
if(process.env.ZEVANORY_APPLY_MIGRATION_027!=='YES')throw new Error('migration_027_not_authorized');
if(!process.env.DATABASE_URL)throw new Error('database_url_required');
const sql=await readFile(new URL('../db/migrations/027_meta_oauth.sql',import.meta.url),'utf8');
const pool=new Pool({connectionString:process.env.DATABASE_URL});const client=await pool.connect();
try{await client.query(sql);const c=await client.query("select pg_get_constraintdef(oid) def from pg_constraint where conname='provider_oauth_credentials_provider_check' limit 1");const m=await client.query("select migration_id from schema_migrations where migration_id='027_meta_oauth'");const def=String(c.rows[0]?.def||'');if(!def.includes('meta')||m.rowCount!==1)throw new Error('migration_027_verification_failed');console.log(JSON.stringify({ok:true,migration:'027_meta_oauth',provider_allowed:true}));}finally{client.release();await pool.end();}

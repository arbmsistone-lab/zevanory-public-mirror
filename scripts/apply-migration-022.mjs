import { Pool } from '@neondatabase/serverless';
import { readFile } from 'node:fs/promises';
if(process.env.MIGRATION_APPLY_ALLOWED!=='true')throw new Error('migration_apply_not_authorized');
if(!process.env.DATABASE_URL)throw new Error('database_url_required');
const text=await readFile(new URL('../db/migrations/022_nuvemshop_nonexpiring_token.sql',import.meta.url),'utf8');
const pool=new Pool({connectionString:process.env.DATABASE_URL});const client=await pool.connect();
try{await client.query(text);const c=await client.query("select is_nullable from information_schema.columns where table_schema='public' and table_name='provider_oauth_credentials' and column_name='expires_at'");const k=await client.query("select pg_get_constraintdef(oid) def from pg_constraint where conname='provider_oauth_expiry_required' limit 1");if(c.rows[0]?.is_nullable!=='YES'||!String(k.rows[0]?.def||'').includes("provider = 'nuvemshop'"))throw new Error('nuvemshop_expiry_schema_not_updated');console.log(JSON.stringify({ok:true,migration:'022_nuvemshop_nonexpiring_token'}));}finally{client.release();await pool.end();}
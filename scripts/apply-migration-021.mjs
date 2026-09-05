import { Pool } from '@neondatabase/serverless';
import { readFile } from 'node:fs/promises';
if(process.env.MIGRATION_APPLY_ALLOWED!=='true')throw new Error('migration_apply_not_authorized');
if(!process.env.DATABASE_URL)throw new Error('database_url_required');
const sql=await readFile(new URL('../db/migrations/021_linkedin_nuvemshop_oauth.sql',import.meta.url),'utf8');
const pool=new Pool({connectionString:process.env.DATABASE_URL});const client=await pool.connect();
try{await client.query(sql);const r=await client.query("select pg_get_constraintdef(oid) def from pg_constraint where conname='provider_oauth_credentials_provider_check' limit 1");const def=String(r.rows[0]?.def||'');if(!def.includes('linkedin')||!def.includes('nuvemshop'))throw new Error('oauth_provider_constraint_not_updated');console.log(JSON.stringify({ok:true,migration:'021_linkedin_nuvemshop_oauth'}));}finally{client.release();await pool.end();}

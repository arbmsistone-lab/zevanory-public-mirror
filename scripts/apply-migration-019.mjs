import { Pool } from '@neondatabase/serverless';
import { readFile } from 'node:fs/promises';

if(process.env.MIGRATION_APPLY_ALLOWED!=='true') throw new Error('migration_apply_not_authorized');
if(!process.env.DATABASE_URL) throw new Error('database_url_required');
const raw=await readFile(new URL('../db/migrations/019_tiktok_sandbox_provider.sql',import.meta.url),'utf8');
const body=raw.replace(/^\s*BEGIN;\s*/i,'').replace(/\s*COMMIT;\s*$/i,'');
const pool=new Pool({connectionString:process.env.DATABASE_URL});
const client=await pool.connect();
try{
  await client.query('BEGIN');
  await client.query(body);
  const check=await client.query(`select pg_get_constraintdef(oid) definition from pg_constraint where conname='provider_oauth_credentials_provider_check' limit 1`);
  if(!String(check.rows[0]?.definition||'').includes('tiktok_sandbox')) throw new Error('tiktok_sandbox_provider_not_allowed');
  await client.query('COMMIT');
}catch(error){try{await client.query('ROLLBACK')}catch{} throw error}
finally{client.release();await pool.end()}
console.log(JSON.stringify({ok:true,migration:'019_tiktok_sandbox_provider',constraint_verified:true}));

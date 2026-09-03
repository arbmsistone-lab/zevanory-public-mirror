import { Pool } from '@neondatabase/serverless';
import { readFile } from 'node:fs/promises';
import { assessSchemaIntegrity } from '../src/schemaHealth.mjs';

if(process.env.MIGRATION_APPLY_ALLOWED!=='true') throw new Error('migration_apply_not_authorized');
if(!process.env.DATABASE_URL) throw new Error('database_url_required');
const raw=await readFile(new URL('../db/migrations/016_certification_pilot.sql',import.meta.url),'utf8');
const body=raw.replace(/^\s*BEGIN;\s*/i,'').replace(/\s*COMMIT;\s*$/i,'');
const pool=new Pool({connectionString:process.env.DATABASE_URL});
const client=await pool.connect(); let result;
try{
  await client.query('BEGIN');
  await client.query(body);
  const tables=await client.query("select table_name from information_schema.tables where table_schema='public'");
  const migrations=await client.query('select migration_id from schema_migrations order by migration_id');
  result=assessSchemaIntegrity({tableNames:tables.rows.map(x=>x.table_name),migrationIds:migrations.rows.map(x=>x.migration_id)});
  if(!result.ready) throw new Error(`schema_not_ready:${JSON.stringify(result)}`);
  await client.query('COMMIT');
}catch(error){try{await client.query('ROLLBACK')}catch{} throw error}
finally{client.release();await pool.end()}
console.log(JSON.stringify({ok:true,migration:'016_certification_pilot',schema:result}));
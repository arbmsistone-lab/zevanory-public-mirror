import { Pool } from '@neondatabase/serverless';
import { readFile } from 'node:fs/promises';

if (process.env.MIGRATION_APPLY_ALLOWED !== 'true') throw new Error('migration_apply_not_authorized');
if (!process.env.DATABASE_URL) throw new Error('database_url_required');
const raw=await readFile(new URL('../db/migrations/008_autonomous_revenue_engine.sql',import.meta.url),'utf8');
const sqlBody=raw.replace(/^\s*BEGIN;\s*/i,'').replace(/\s*COMMIT;\s*$/i,'');
const pool=new Pool({connectionString:process.env.DATABASE_URL}); const client=await pool.connect(); let result;
try{
  await client.query('BEGIN'); await client.query(sqlBody);
  const required=['agent_jobs','agent_runs','knowledge_documents','agent_memory','agent_tool_audit'];
  const tables=await client.query("select table_name from information_schema.tables where table_schema='public' and table_name=any($1::text[])",[required]);
  const ledger=await client.query("select 1 from schema_migrations where migration_id='008_autonomous_revenue_engine'");
  const found=new Set(tables.rows.map(x=>x.table_name)); const missing=required.filter(x=>!found.has(x));
  result={ready:missing.length===0&&ledger.rowCount===1,missing_tables:missing,migration_ledgered:ledger.rowCount===1};
  if(!result.ready) throw new Error(`migration_008_not_ready:${JSON.stringify(result)}`);
  await client.query('COMMIT');
}catch(error){try{await client.query('ROLLBACK')}catch{} throw error}
finally{client.release();await pool.end()}
console.log(JSON.stringify({ok:true,migration:'008_autonomous_revenue_engine',schema:result}));

import { readFile } from 'node:fs/promises';
import { Pool } from '@neondatabase/serverless';
if(process.env.ZEVANORY_APPLY_MIGRATION_028!=='YES')throw new Error('migration_028_not_authorized');
if(!process.env.DATABASE_URL)throw new Error('database_url_required');
const text=await readFile(new URL('../db/migrations/028_elite_product_support.sql',import.meta.url),'utf8');
const pool=new Pool({connectionString:process.env.DATABASE_URL});
const client=await pool.connect();
try{
  await client.query(text);
  const m=await client.query("select migration_id from schema_migrations where migration_id='028_elite_product_support'");
  const t=await client.query("select to_regclass('public.product_support_cases') name");
  if(m.rowCount!==1||!t.rows[0]?.name)throw new Error('migration_028_verification_failed');
  console.log(JSON.stringify({ok:true,migration:'028_elite_product_support',table:t.rows[0].name}));
}finally{client.release();await pool.end();}

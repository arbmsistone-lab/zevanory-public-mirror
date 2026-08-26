import { Pool } from '@neondatabase/serverless';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { REQUIRED_TABLES, REQUIRED_MIGRATIONS, assessSchemaIntegrity } from '../src/schemaHealth.mjs';

if (process.env.DR_REHEARSAL_ALLOWED !== 'true') {
  throw new Error('dr_rehearsal_not_authorized');
}
if (!process.env.DATABASE_URL) throw new Error('database_url_required');

const root = new URL('../', import.meta.url);
const files = ['001_telemetry_events.sql','002_financial_events.sql','003_orders_checkout.sql','004_partial_refund_snapshots.sql','005_order_financial_states.sql'];
const stripTxn = (sql) => sql.replace(/^\s*BEGIN;\s*/i, '').replace(/\s*COMMIT;\s*$/i, '');
const schema = `dr_rehearsal_${randomUUID().replaceAll('-', '').slice(0,16)}`;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();
let result;
try {
  await client.query('BEGIN');
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET LOCAL search_path TO "${schema}"`);
  for (const file of files) {
    const raw = await readFile(new URL(`db/migrations/${file}`, root), 'utf8');
    await client.query(stripTxn(raw));
  }
  const tables = await client.query("select table_name from information_schema.tables where table_schema=$1", [schema]);
  const migrations = await client.query(`select migration_id from "${schema}".schema_migrations order by migration_id`);
  result = assessSchemaIntegrity({
    tableNames: tables.rows.map((row) => row.table_name),
    migrationIds: migrations.rows.map((row) => row.migration_id),
  });
  if (!result.ready) throw new Error(`dr_schema_incomplete:${JSON.stringify(result)}`);
  if (result.required_tables !== REQUIRED_TABLES.length || result.required_migrations !== REQUIRED_MIGRATIONS.length) {
    throw new Error('dr_requirement_mismatch');
  }
} finally {
  try { await client.query('ROLLBACK'); } catch {}
  client.release();
  await pool.end();
}

console.log(JSON.stringify({
  ok: true,
  mode: 'transactional-rollback',
  schema_rebuild: result,
  persistent_changes: false,
}));

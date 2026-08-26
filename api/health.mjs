import { neon } from '@neondatabase/serverless';
import { buildSystemHealth } from '../src/systemHealth.mjs';
import { assessSchemaIntegrity } from '../src/schemaHealth.mjs';
import { attachRequestContext, operationalLog } from '../src/observability.mjs';

export default async function handler(req, res) {
  const context = attachRequestContext(req, res, '/api/health');
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  if (req.method !== 'GET') {
    res.statusCode = 405;
    operationalLog(context, 405, 'method_not_allowed');
    return res.end(JSON.stringify({ error: 'method_not_allowed', request_id: context.requestId }));
  }

  let databaseReachable = false;
  let schema = assessSchemaIntegrity();
  if (process.env.DATABASE_URL) {
    try {
      const sql = neon(process.env.DATABASE_URL);
      const ping = await sql.query('select 1::int as ok');
      databaseReachable = ping[0]?.ok === 1;
      if (databaseReachable) {
        const [tables, migrations] = await Promise.all([
          sql.query("select table_name from information_schema.tables where table_schema='public' and table_name = any(array['schema_migrations','telemetry_events','financial_events','orders'])"),
          sql.query("select migration_id from schema_migrations where migration_id = any(array['001_telemetry_events','002_financial_events','003_orders_checkout','004_partial_refund_snapshots','005_order_financial_states'])"),
        ]);
        schema = assessSchemaIntegrity({ tableNames: tables.map((row) => row.table_name), migrationIds: migrations.map((row) => row.migration_id) });
      }
    } catch {
      databaseReachable = false;
      schema = assessSchemaIntegrity();
    }
  }

  const health = buildSystemHealth({ databaseReachable, schemaReady: schema.ready });
  res.statusCode = health.ready ? 200 : 503;
  operationalLog(context, res.statusCode, health.ready ? 'readiness_ok' : 'readiness_degraded', {
    database_reachable: databaseReachable,
    schema_ready: schema.ready,
  });
  return res.end(JSON.stringify({ ...health, schema, request_id: context.requestId }));
}

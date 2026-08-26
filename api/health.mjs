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
  let schemaCheckError = false;
  if (process.env.DATABASE_URL) {
    const sql = neon(process.env.DATABASE_URL);
    try {
      const ping = await sql.query('select 1::int as ok');
      databaseReachable = ping[0]?.ok === 1;
    } catch {
      databaseReachable = false;
    }
    if (databaseReachable) {
      try {
        const [tables, migrations] = await Promise.all([
          sql.query("select table_name from information_schema.tables where table_schema='public'"),
          sql.query('select migration_id from schema_migrations order by migration_id'),
        ]);
        schema = assessSchemaIntegrity({
          tableNames: tables.map((row) => row.table_name),
          migrationIds: migrations.map((row) => row.migration_id),
        });
      } catch {
        schemaCheckError = true;
        schema = assessSchemaIntegrity();
      }
    }
  }

  const health = buildSystemHealth({ databaseReachable, schemaReady: schema.ready });
  res.statusCode = health.ready ? 200 : 503;
  operationalLog(context, res.statusCode, health.ready ? 'readiness_ok' : 'readiness_degraded', {
    database_reachable: databaseReachable,
    schema_ready: schema.ready,
    schema_check_error: schemaCheckError,
  });
  return res.end(JSON.stringify({ ...health, schema, schema_check_error: schemaCheckError, request_id: context.requestId }));
}

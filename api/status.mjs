import { neon } from '@neondatabase/serverless';
import { buildOperationalStatus } from '../src/operationalStatus.mjs';

export default async function handler(req, res) {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  if (req.method !== 'GET') {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: 'method_not_allowed' }));
  }
  if (!process.env.DATABASE_URL) {
    res.statusCode = 503;
    return res.end(JSON.stringify({ error: 'operational_storage_unavailable' }));
  }
  try {
    const sql = neon(process.env.DATABASE_URL);
    const [telemetry, orders, financial, last] = await Promise.all([
      sql.query('select event_name, count(*)::int as count from telemetry_events group by event_name'),
      sql.query('select status, count(*)::int as count from orders group by status'),
      sql.query('select normalized_event, count(*)::int as count from financial_events group by normalized_event'),
      sql.query('select max(occurred_at) as last_event_at from telemetry_events'),
    ]);
    res.statusCode = 200;
    return res.end(JSON.stringify(buildOperationalStatus({ telemetry, orders, financial, lastEventAt: last[0]?.last_event_at || null })));
  } catch {
    res.statusCode = 503;
    return res.end(JSON.stringify({ error: 'operational_status_unavailable' }));
  }
}

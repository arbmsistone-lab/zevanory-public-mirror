import { neon } from '@neondatabase/serverless';
import { buildOperationalStatus } from '../src/operationalStatus.mjs';
import { attachRequestContext, operationalLog } from '../src/observability.mjs';

export default async function handler(req, res) {
  const context = attachRequestContext(req, res, '/api/status');
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  if (req.method !== 'GET') {
    res.statusCode = 405;
    operationalLog(context, 405, 'method_not_allowed');
    return res.end(JSON.stringify({ error: 'method_not_allowed', request_id: context.requestId }));
  }
  if (!process.env.DATABASE_URL) {
    res.statusCode = 503;
    operationalLog(context, 503, 'operational_storage_unavailable');
    return res.end(JSON.stringify({ error: 'operational_storage_unavailable', request_id: context.requestId }));
  }
  try {
    const sql = neon(process.env.DATABASE_URL);
    const [telemetry, orders, financial, leads, actions, economics, last] = await Promise.all([
      sql.query('select event_name, count(*)::int as count from telemetry_events group by event_name'),
      sql.query('select status, count(*)::int as count from orders group by status'),
      sql.query('select normalized_event, count(*)::int as count from financial_events group by normalized_event'),
      sql.query('select stage, count(*)::int as count from sales_leads group by stage'),
      sql.query('select status, count(*)::int as count from sales_actions group by status'),
      sql.query('select gross_revenue_brl, refunds_brl, paid_orders from unit_economics_snapshots order by period_end desc limit 1'),
      sql.query('select max(occurred_at) as last_event_at from telemetry_events'),
    ]);
    const body = { ...buildOperationalStatus({ telemetry, orders, financial, leads, actions, economics, lastEventAt: last[0]?.last_event_at || null }), request_id: context.requestId };
    res.statusCode = 200;
    operationalLog(context, 200, 'operational_status_ok');
    return res.end(JSON.stringify(body));
  } catch {
    res.statusCode = 503;
    operationalLog(context, 503, 'operational_status_unavailable');
    return res.end(JSON.stringify({ error: 'operational_status_unavailable', request_id: context.requestId }));
  }
}

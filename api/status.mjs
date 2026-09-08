import { neon } from '@neondatabase/serverless';
import { buildOperationalStatus } from '../src/operationalStatus.mjs';
import { attachRequestContext, operationalLog } from '../src/observability.mjs';
import { healthProbe, liveProbe } from '../src/statusProbes.mjs';
import { isPublicDeploymentRequest } from '../src/security.mjs';
import { executeVerifiedRead } from '../src/databaseReadFabric.mjs';

export default async function handler(req, res) {
  const probe=String(req.query?.probe||new URL(req.url||'/api/status','https://zevanory.api.br').searchParams.get('probe')||'').toLowerCase();
  if(probe==='live') return liveProbe(req,res);
  if(probe==='health') return healthProbe(req,res);
  const context = attachRequestContext(req, res, '/api/status');
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  if (req.method !== 'GET') {
    res.statusCode = 405;
    operationalLog(context, 405, 'method_not_allowed');
    return res.end(JSON.stringify({ error: 'method_not_allowed', request_id: context.requestId }));
  }
  const readOutcome=await executeVerifiedRead({env:process.env,connect:neon,read:async(sql)=>{
    const [telemetry,orders,financial,leads,actions,dueBuckets,riskBuckets,economics,last]=await Promise.all([
      sql.query('select event_name, count(*)::int as count from telemetry_events group by event_name'),
      sql.query('select status, count(*)::int as count from orders group by status'),
      sql.query('select normalized_event, count(*)::int as count from financial_events group by normalized_event'),
      sql.query('select stage, count(*)::int as count from sales_leads group by stage'),
      sql.query('select status, count(*)::int as count from sales_actions group by status'),
      sql.query("select case when due_at < now() and status='scheduled' then 'overdue' when due_at >= now() and due_at < now() + interval '24 hours' and status='scheduled' then 'due_24h' else 'later' end as bucket, count(*)::int as count from sales_actions where status='scheduled' group by 1"),
      sql.query("select bucket, count(*)::int as count from (select case when next_action_at is null then 'missing_next_action' when updated_at < now() - interval '72 hours' then 'stale' else 'healthy' end as bucket from sales_leads where stage not in ('paid','delivered','refunded','unqualified','lost')) x group by bucket"),
      sql.query('select gross_revenue_brl, refunds_brl, paid_orders from unit_economics_snapshots order by period_end desc limit 1'),
      sql.query('select max(occurred_at) as last_event_at from telemetry_events'),
    ]);
    return buildOperationalStatus({telemetry,orders,financial,leads,actions,dueBuckets,riskBuckets,economics,lastEventAt:last[0]?.last_event_at||null});
  }});
  if(!readOutcome.ok){res.statusCode=503;operationalLog(context,503,'operational_status_unavailable',{read_attempts:readOutcome.attempts.length});return res.end(JSON.stringify({error:'operational_status_unavailable',request_id:context.requestId}));}
  const full=readOutcome.result;
  const body=isPublicDeploymentRequest(req)?{project:full.project,gate:full.gate,experiment:full.experiment,engine:full.engine,sales_machine:full.sales_machine,runtime:full.runtime,metrics:full.metrics,request_id:context.requestId}:{...full,request_id:context.requestId};
  res.statusCode=200;operationalLog(context,200,'operational_status_ok',{read_route:readOutcome.route,canonical_read:readOutcome.canonical});
  return res.end(JSON.stringify(body));
}

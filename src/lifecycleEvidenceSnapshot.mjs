import { certifyLifecycleEvidence } from './lifecycleCertificationEngine.mjs';
const rowsToMap=(rows,key)=>Object.fromEntries(rows.map(row=>[String(row[key]),Number(row.count)||0]));
const scalar=(rows,key)=>Number(rows?.[0]?.[key])||0;

export async function buildLifecycleEvidenceSnapshot(sql){
  const [telemetry,leads,actions,orders,financial,lifecycle,touchpoints,economics,evidence]=await Promise.all([
    sql.query("select event_name,count(*)::int count from telemetry_events group by event_name"),
    sql.query("select stage,count(*)::int count from sales_leads group by stage"),
    sql.query("select action_type,status,count(*)::int count from sales_actions group by action_type,status"),
    sql.query("select status,count(*)::int count from orders group by status"),
    sql.query("select normalized_event,count(*)::int count from financial_events group by normalized_event"),
    sql.query("select event_type,count(*)::int count from customer_lifecycle_events group by event_type"),
    sql.query("select count(*)::int count from attribution_touchpoints"),
    sql.query("select count(*)::int count,count(distinct date_trunc('month',period_end))::int months,coalesce(sum(paid_orders),0)::int paid_orders from unit_economics_snapshots"),
    sql.query("select dimension,count(*)::int count from lifecycle_evidence_events where proof_kind='observed_production' and verification_status='verified' and source_class in ('canonical_database','provider_webhook','operator_validation') group by dimension"),
  ]);
  const leadMap=rowsToMap(leads,'stage');
  const orderMap=rowsToMap(orders,'status');
  const actionCompleted=Object.fromEntries(actions.filter(x=>x.status==='completed').map(x=>[String(x.action_type),Number(x.count)||0]));
  const lifecycleMap=rowsToMap(lifecycle,'event_type');
  const financialMap=rowsToMap(financial,'normalized_event');
  const directEvidence=rowsToMap(evidence,'dimension');
  const paidOrders=Math.max(orderMap.paid||0,scalar(economics,'paid_orders'));
  const observed={
    page_views:telemetry.filter(x=>x.event_name==='page_view').reduce((a,x)=>a+Number(x.count||0),0),
    leads:Object.values(leadMap).reduce((a,b)=>a+Number(b||0),0),
    identified_leads:leadMap.identified||0,enriched_leads:directEvidence.enrichment||0,scored_leads:directEvidence.scoring||0,prioritized_leads:directEvidence.prioritization||0,
    contacted_leads:leadMap.contacted||0,qualified_leads:leadMap.qualified||0,
    discovery_completed:directEvidence.discovery||0,nurture_actions:actionCompleted.follow_up||0,
    objections_handled:directEvidence.objection||0,offer_sent:leadMap.offer_sent||0,
    negotiations:directEvidence.negotiation||0,checkout_started:leadMap.checkout_started||0,
    abandonment_recoveries:directEvidence.abandonment_recovery||0,paid_orders:paidOrders,
    reconciled_payments:Object.values(financialMap).reduce((a,b)=>a+Number(b||0),0),
    delivered_orders:orderMap.delivered||0,lifecycle_events:lifecycleMap,customers:0,
    attribution_touchpoints:scalar(touchpoints,'count'),economics_snapshots:scalar(economics,'count'),
    monthly_revenue_periods:scalar(economics,'months'),experiment_outcomes:directEvidence.experiment||0,
    learning_cycles:directEvidence.learning||0,next_best_actions_executed:directEvidence.next_best_action||0,
    profitable_paid_orders:0,verified_evidence:directEvidence,
  };
  const certification=certifyLifecycleEvidence(observed);
  return Object.freeze({commercial_unlock:false,certification,evidence_summary:Object.freeze({
    paid_orders:paidOrders,total_leads:observed.leads,page_views:observed.page_views,
    lifecycle_events:Object.values(lifecycleMap).reduce((a,b)=>a+Number(b||0),0),
    attribution_touchpoints:observed.attribution_touchpoints,economics_snapshots:observed.economics_snapshots,
  })});
}
